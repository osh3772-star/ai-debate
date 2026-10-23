"""Offline engine/UI integration regressions. Never invokes installed AI CLIs."""
import importlib.util
import io
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import debate as d


def jsonl(*events):
    return ''.join(json.dumps(e, ensure_ascii=False) + '\n' for e in events)


def completed_output(provider, answer='OFFLINE FIXTURE'):
    if provider == 'codebuddy':
        return json.dumps({'type':'result','is_error':False,'result':answer,'modelUsage':{d.CODEBUDDY_MODEL:{'inputTokens':1,'outputTokens':1}}})
    if provider == 'codex':
        return jsonl({'type': 'item.completed', 'item': {'type': 'agent_message', 'text': answer}},
                     {'type': 'turn.completed', 'usage': {}})
    if provider == 'claude':
        return jsonl({'type': 'system', 'subtype': 'init'},
                     {'type': 'stream_event', 'event': {'type': 'content_block_delta',
                      'delta': {'type': 'text_delta', 'text': answer}}},
                     {'type': 'result', 'is_error': False, 'result': answer})
    return jsonl({'event': 'step_update', 'step_update': {'text': answer}},
                 {'event': 'result', 'result': {'status': 'SUCCESS', 'response': answer}})


class FakeProcess:
    """Pipe-compatible fixture only; it has no underlying subprocess."""
    def __init__(self, stdout=b'', stderr=b'', running=False):
        self.stdin = io.BytesIO()
        self.stdout = io.BytesIO(stdout)
        self.stderr = io.BytesIO(stderr)
        self.pid = 987654321
        self.returncode = None if running else 0

    def poll(self):
        return self.returncode

    def wait(self, timeout=None):
        if self.returncode is None:
            self.returncode = 0
        return self.returncode


class EngineUiTests(unittest.TestCase):
    def state(self):
        return {
            'created': d.now(), 'mode': 'smoke', 'topic': 'OFFLINE TOPIC',
            'status': 'created', 'materials': 'OFFLINE MATERIALS', 'timeout': 10,
            'instructions': 'COMMON_PRIVATE_INSTRUCTION',
            'agents': [
                {'provider': 'codex', 'name': 'GPT', 'model': 'model-one',
                 'effort': 'high', 'instructions': 'GPT_PRIVATE_INSTRUCTION'},
                {'provider': 'claude', 'name': 'Claude', 'model': 'model-two',
                 'effort': 'medium', 'instructions': 'CLAUDE_PRIVATE_INSTRUCTION'},
                {'provider': 'google', 'name': 'Google', 'model': 'model-three',
                 'effort': 'low', 'instructions': 'GOOGLE_PRIVATE_INSTRUCTION'},
            ], 'turns': []}

    def test_import_never_executes_cli(self):
        spec = importlib.util.spec_from_file_location('offline_debate_import', d.__file__)
        module = importlib.util.module_from_spec(spec)
        with patch.object(subprocess, 'Popen', side_effect=AssertionError('CLI started')) as popen:
            spec.loader.exec_module(module)
        popen.assert_not_called()

    def test_model_arguments_and_official_auth_guards(self):
        with patch.object(d, 'binary', return_value='OFFLINE-CLI'):
            codex = d.cli_command('codex', Path('.'), {'model': 'gpt-model', 'effort': 'high'}, True)
            claude = d.cli_command('claude', Path('.'), {'model': 'opus', 'effort': 'medium'}, True)
            google = d.cli_command('google', Path('.'), {'model': 'gemini-model', 'effort': 'low'}, True)
        self.assertEqual(codex[codex.index('--model') + 1], 'gpt-model')
        self.assertIn('model_reasoning_effort="high"', codex)
        self.assertIn('forced_login_method="chatgpt"', codex)
        self.assertEqual(codex[codex.index('--sandbox') + 1], 'read-only')
        self.assertEqual(claude[claude.index('--model') + 1], 'opus')
        self.assertEqual(claude[claude.index('--effort') + 1], 'medium')
        self.assertEqual(claude[claude.index('--tools') + 1], '')
        self.assertEqual(claude[claude.index('--setting-sources') + 1], '')
        self.assertIn('--include-partial-messages', claude)
        self.assertEqual(google[google.index('--model') + 1], 'gemini-model')
        self.assertEqual(google[google.index('--effort') + 1], 'low')

    def test_model_validation_rejects_option_injection(self):
        with patch.object(d, 'binary', return_value='OFFLINE-CLI'):
            for model in ('--api-key secret', 'model\n--dangerous', 'model;command', 'x' * 161):
                with self.subTest(model=model), self.assertRaises(ValueError):
                    d.cli_command('codex', Path('.'), {'model': model})

    def test_custom_instructions_are_independent(self):
        state = self.state()
        state['turns'] = [{'id': 'S1A1', 'name': 'GPT', 'stage': 'round1',
                           'answer': 'PREVIOUS_AGENT_CLAIM'}]
        for i, agent in enumerate(state['agents']):
            prompt = d.build_prompt(state, 0, i)
            self.assertIn('COMMON_PRIVATE_INSTRUCTION', prompt)
            self.assertIn(agent['instructions'], prompt)
            self.assertNotIn('PREVIOUS_AGENT_CLAIM', prompt)
            for other in state['agents']:
                if other is not agent:
                    self.assertNotIn(other['instructions'], prompt)
        self.assertIn('PREVIOUS_AGENT_CLAIM', d.build_prompt(state, 1, 1))

    def test_streaming_extractors_require_successful_completion(self):
        for provider in d.PROVIDERS:
            with self.subTest(provider=provider):
                answer, raw = d.extract(provider, completed_output(provider))
                self.assertEqual(answer, 'OFFLINE FIXTURE')
                self.assertTrue(raw)
        for provider, output in (
            ('codex', jsonl({'type': 'turn.failed', 'error': {'message': 'fixture failure'}})),
            ('claude', jsonl({'type': 'system'}, {'type': 'result', 'is_error': True, 'result': 'fixture failure'})),
            ('google', jsonl({'event': 'result', 'result': {'status': 'FAILED', 'error': 'fixture failure'}})),
        ):
            with self.subTest(provider=provider), self.assertRaises(RuntimeError):
                d.extract(provider, output)

    def test_capture_stream_redacts_before_callback_and_logs(self):
        secret = 'sk-ant-abcdefghijklmnopqrstuvwxyz'
        fixture = FakeProcess(jsonl({'type': 'fixture', 'text': secret}).encode(),
                              ('access_token=' + secret + '\n').encode())
        events = []
        with patch.object(d, 'safe_env', return_value={'OFFLINE_TEST': '1'}), \
             patch.object(d.subprocess, 'Popen', return_value=fixture) as popen:
            rc, out, err = d.capture_stream(['OFFLINE-CLI'], 'fixture prompt', '.', 5,
                                            events.append, threading.Event())
        self.assertEqual(rc, 0)
        self.assertEqual(popen.call_count, 1)
        self.assertEqual(len(events), 1)
        self.assertNotIn(secret, json.dumps(events) + out + err)
        self.assertIn('[REDACTED]', out + err)

    def test_stopping_active_mock_stream_kills_only_owned_process(self):
        stop = threading.Event()
        fixture = FakeProcess(jsonl({'type': 'fixture'}).encode(), running=True)
        with patch.object(d, 'safe_env', return_value={'OFFLINE_TEST': '1'}), \
             patch.object(d.subprocess, 'Popen', return_value=fixture), \
             patch.object(d, 'kill_tree', side_effect=lambda process: setattr(process, 'returncode', -15)) as kill:
            with self.assertRaises(d.RunStopped):
                d.capture_stream(['OFFLINE-CLI'], 'fixture prompt', '.', 5, lambda event: stop.set(), stop)
        kill.assert_called_once_with(fixture)

    def test_cancelled_before_model_call_never_authenticates_or_spawns(self):
        stop = threading.Event()
        stop.set()
        with patch.object(d, 'auth_status') as auth, patch.object(d.subprocess, 'Popen') as popen:
            with self.assertRaises(d.RunStopped):
                d.model_call('codex', 'OFFLINE', stop_event=stop)
        auth.assert_not_called()
        popen.assert_not_called()

    def test_cancellation_during_auth_does_not_start_inference(self):
        stop = threading.Event()
        def authenticate(provider):
            stop.set()
            return {'ready': True}
        with patch.object(d, 'auth_status', side_effect=authenticate), \
             patch.object(d, 'binary', return_value='OFFLINE-CLI'), \
             patch.object(d, 'safe_env', return_value={'OFFLINE_TEST': '1'}), \
             patch.object(d.subprocess, 'Popen', return_value=FakeProcess()) as popen:
            with self.assertRaises(d.RunStopped):
                d.model_call('codex', 'OFFLINE', stop_event=stop)
        self.assertEqual(popen.call_count, 0, 'A cancelled request must not spawn inference')

    def test_alternate_paid_gateway_keys_are_not_inherited(self):
        with patch.dict(d.os.environ, {'OMNIROUTE_API_KEY': 'OFFLINE_FIXTURE_SECRET',
                                      'OPENROUTER_API_KEY': 'OFFLINE_FIXTURE_SECRET'}, clear=True):
            env = d.safe_env()
        self.assertNotIn('OMNIROUTE_API_KEY', env)
        self.assertNotIn('OPENROUTER_API_KEY', env)

    def test_legacy_resume_preserves_saved_per_agent_model_settings(self):
        state = self.state()
        answer = json.dumps({'analysis': 'OFFLINE FIXTURE', 'claims': [], 'audit': []})
        with tempfile.TemporaryDirectory() as temp, \
             patch.object(d, 'model_call', return_value=(answer, {'fixture': True}, '')) as model:
            d.execute(state, Path(temp), max_turns=1)
        args, kwargs = model.call_args
        settings = kwargs.get('settings', args[3] if len(args) > 3 else None)
        self.assertEqual(settings, {**state['agents'][0], 'web_research': False})
        self.assertNotIn('web_research', state['agents'][0])

    def test_google_settings_guard_restores_original_bytes_on_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            home = Path(temp) / 'home'
            root = Path(temp) / 'project'
            config = home / '.gemini' / 'antigravity-cli' / 'settings.json'
            config.parent.mkdir(parents=True)
            original = b'{"modelProvider":"fixture-provider", "keep": 1}\r\n'
            config.write_bytes(original)
            root.mkdir()
            (root / 'google.safe.json').write_text('{"useG1Credits":false}', encoding='utf-8')
            with patch.object(d.Path, 'home', return_value=home), patch.object(d, 'ROOT', root):
                with self.assertRaisesRegex(RuntimeError, 'fixture exception'):
                    with d.google_settings_guard():
                        current = json.loads(config.read_text())
                        self.assertNotIn('modelProvider', current)
                        self.assertFalse(current['useG1Credits'])
                        raise RuntimeError('fixture exception')
            self.assertEqual(config.read_bytes(), original)
            self.assertFalse((config.parent / 'ai-debate-settings.lock').exists())


if __name__ == '__main__':
    unittest.main()
