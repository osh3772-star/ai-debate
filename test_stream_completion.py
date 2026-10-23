"""Offline checks for CLIs that report completion but keep running (seen with agy/Gemini on 2026-10-21).
A small local Python script stands in for the CLI; no model or real CLI is started."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

import debate as d
import test_course_guidance as course

FAKE_CLI = '''import json, sys, time
sys.stdin.read()
for event in json.load(open(sys.argv[1], encoding="utf-8")):
    print(json.dumps(event), flush=True)
time.sleep(float(sys.argv[2]))
'''
ANSWER = {'analysis': 'OFFLINE ANALYSIS', 'conclusion': 'OFFLINE CONCLUSION'}


def step(index, state, delta, kind='agent_response'):
    return {'event': 'step_update', 'step_update': {'step_index': index, 'state': state, 'step_type': kind, 'text_delta': delta}}


class StreamCompletionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(); self.addCleanup(self.temp.cleanup)
        self.folder = Path(self.temp.name); (self.folder/'fake_cli.py').write_text(FAKE_CLI, encoding='utf-8')

    def call(self, events, hang, timeout=20, grace=0.5, idle=1):
        (self.folder/'events.json').write_text(json.dumps(events), encoding='utf-8')
        cmd = [sys.executable, '-I', str(self.folder/'fake_cli.py'), str(self.folder/'events.json'), str(hang)]
        started = time.monotonic()
        result = d.capture_stream(cmd, '{"event":"user"}\n', str(self.folder), timeout, None, None,
                                  done=d.google_done, settled=d.google_settled(), grace=grace, idle=idle)
        return result, time.monotonic() - started

    def answer_steps(self):
        text = json.dumps(ANSWER, ensure_ascii=False)
        return [{'event': 'init'}, step(1, 'ACTIVE', text[:20]), step(1, 'DONE', text[20:])]

    def test_result_then_a_cli_that_keeps_running_ends_after_the_grace_period(self):
        events = self.answer_steps() + [{'event': 'result', 'result': {'status': 'SUCCESS', 'response': json.dumps(ANSWER)}}]
        (rc, out, err), seconds = self.call(events, hang=60)
        self.assertLess(seconds, 15, 'the finished answer is not held until the 600-second timeout')
        self.assertEqual(rc, 0)
        text, raw = d.extract('google', out)
        self.assertEqual(json.loads(text), ANSWER)
        self.assertIn('완료 결과 이벤트', raw[-1]['reason'], 'the record shows the program closed the call')

    def test_a_done_answer_without_a_result_is_kept_only_after_silence(self):
        (rc, out, err), seconds = self.call(self.answer_steps(), hang=60)
        self.assertLess(seconds, 15)
        text, raw = d.extract('google', out)
        self.assertEqual(json.loads(text), ANSWER); self.assertIn('응답 단계 완료', raw[-1]['reason'])

    def test_a_finished_preamble_is_waited_on_not_taken_as_the_answer(self):
        with self.assertRaises(subprocess.TimeoutExpired) as caught:
            self.call([{'event': 'init'}, step(1, 'DONE', '원문을 더 찾아보겠습니다.')], hang=60, timeout=4)
        self.assertIn('step_update', caught.exception.output, 'the partial stream survives the timeout')
        marker = json.dumps({'event': 'ai_debate_ended', 'reason': 'OFFLINE'})
        with self.assertRaisesRegex(RuntimeError, '인정하지 않음'):
            d.extract('google', json.dumps(step(1, 'DONE', '원문을 더 찾아보겠습니다.')) + '\n' + marker + '\n')

    def test_a_new_answer_after_a_done_one_is_waited_for(self):
        with self.assertRaises(subprocess.TimeoutExpired): self.call(self.answer_steps() + [step(2, 'ACTIVE', '{"analysis": "다시')], hang=60, timeout=4)

    def test_a_stuck_tool_step_after_a_complete_answer_does_not_hold_it(self):
        (rc, out, err), seconds = self.call(self.answer_steps() + [step(2, 'ACTIVE', '', kind='tool_call')], hang=60)
        self.assertLess(seconds, 15); self.assertEqual(json.loads(d.extract('google', out)[0]), ANSWER)

    def test_a_cli_that_exits_normally_is_unchanged(self):
        events = self.answer_steps() + [{'event': 'result', 'result': {'status': 'SUCCESS', 'response': json.dumps(ANSWER)}}]
        (rc, out, err), _ = self.call(events, hang=0)
        self.assertEqual(rc, 0); self.assertNotIn('ai_debate_ended', out)
        self.assertEqual(json.loads(d.extract('google', out)[0]), ANSWER)

    def test_a_timeout_keeps_the_streamed_tail_on_the_attempt(self):
        state = course.CourseGuidanceTests().state()
        error = subprocess.TimeoutExpired(['agy'], 600, output='{"event": "init"}\n{"event": "step_update"}\n')
        with tempfile.TemporaryDirectory() as tmp, patch.object(d, 'model_call', side_effect=error):
            d.execute(state, Path(tmp))
        self.assertEqual(state['status'], 'failed')
        self.assertIn('step_update', state['attempts'][-1]['partial_output_tail'])


class WorkFolderTests(unittest.TestCase):
    """WinError 32 on 2026-10-22: a CLI child process still held the call's working folder when it was removed."""

    def test_a_folder_held_for_a_moment_is_removed_without_failing_the_call(self):
        with d.work_folder() as folder:
            handle = open(Path(folder)/'held.txt', 'w', encoding='utf-8')
            threading.Timer(0.5, handle.close).start()
        self.assertFalse(Path(folder).exists())

    def test_a_folder_that_stays_held_is_left_behind_instead_of_failing(self):
        with patch.object(d.time, 'sleep'):
            with d.work_folder() as folder:
                handle = open(Path(folder)/'held.txt', 'w', encoding='utf-8')
        try:
            if os.name == 'nt': self.assertTrue(Path(folder).exists(), 'left behind, and the call result is kept')
        finally:
            handle.close(); shutil.rmtree(folder, ignore_errors=True)

    def test_a_failed_call_keeps_the_cli_output_for_the_attempt(self):
        with patch.object(d, 'google_settings_guard', lambda web: d.no_guard()), patch.object(d, 'cli_command', return_value=['OFFLINE-CLI']), \
             patch.object(d, 'capture_stream', return_value=(1, '{"event": "init"}\n', 'OFFLINE ERROR')):
            with self.assertRaises(RuntimeError) as caught: d.model_call('google', 'OFFLINE')
        self.assertIn('init', caught.exception.output)
        state = course.CourseGuidanceTests().state(); error = RuntimeError('google: OFFLINE ERROR'); error.output = '{"event": "init"}\n'
        with tempfile.TemporaryDirectory() as tmp, patch.object(d, 'model_call', side_effect=error):
            d.execute(state, Path(tmp))
        self.assertIn('init', state['attempts'][-1]['partial_output_tail'])


if __name__ == '__main__': unittest.main()
