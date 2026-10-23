"""Offline execution identity/progress checks. All model calls are replaced."""
import copy
import json
from pathlib import Path
import subprocess
import tempfile
import threading
import unittest
from unittest.mock import patch

import debate as d
import ui_server as u


class ExecutionStateTests(unittest.TestCase):
    def state(self):
        return {'created':d.now(),'mode':'smoke','topic':'OFFLINE ONLY','status':'created',
                'materials':'','timeout':1,'agents':d.default_agents(3),'turns':[]}

    def test_retry_keeps_failed_attempt_and_links_only_successful_response(self):
        state=self.state(); events=[]
        response=(json.dumps({'analysis':'OFFLINE FIXTURE'}),{'fixture':True},'')
        with tempfile.TemporaryDirectory() as temp, patch.object(d,'model_call',side_effect=[subprocess.TimeoutExpired('OFFLINE',1),response]) as model:
            run=Path(temp)
            self.assertFalse(d.execute(state,run,on_update=events.append))
            failed=copy.deepcopy(state['attempts'][0])
            d.execute(state,run,max_turns=1,on_update=events.append)
            self.assertEqual(model.call_count,2)
            first,second=state['attempts']
            self.assertEqual(first,failed)
            self.assertEqual(first['turn_id'],second['turn_id'])
            self.assertNotEqual(first['attempt_id'],second['attempt_id'])
            self.assertEqual(second['retry_of'],first['attempt_id'])
            self.assertEqual(second['number'],2)
            self.assertEqual(state['turns'][0]['attempt_id'],second['attempt_id'])
            self.assertEqual(state['turns'][0]['run_id'],run.name)
            with patch.object(d,'model_call',return_value=response) as resumed:
                d.execute(state,run)
            self.assertEqual(resumed.call_count,5,'completed response must not be repeated')
            self.assertEqual(len({a['attempt_id'] for a in state['attempts']}),7)
            self.assertEqual(len({t['id'] for t in state['turns']}),6)
            saved=json.loads((run/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['attempts'][0],failed)
            completed=next(e for e in events if e['event']=='turn_completed')
            self.assertEqual(completed['attempt_id'],second['attempt_id'])

    def test_late_response_after_stop_is_not_counted_as_completed(self):
        state=self.state(); stop=threading.Event()
        def late_response(*args,**kwargs):
            stop.set()
            return ('OFFLINE LATE RESPONSE',{},'')
        with tempfile.TemporaryDirectory() as temp, patch.object(d,'model_call',side_effect=late_response):
            d.execute(state,Path(temp),stop_event=stop)
        self.assertEqual(state['status'],'stopped_by_user')
        self.assertEqual(state['turns'],[])
        self.assertEqual(state['attempts'][0]['status'],'cancelled')
        self.assertIn('ended_at',state['attempts'][0])

    def test_keyboard_interrupt_and_explicit_resume_settle_attempts(self):
        state=self.state()
        state['attempts']=[{'id':'S1A1','status':'started','prompt':'LEGACY ORIGINAL'}]
        with tempfile.TemporaryDirectory() as temp, patch.object(d,'model_call',side_effect=KeyboardInterrupt):
            d.execute(state,Path(temp))
        legacy,current=state['attempts']
        self.assertEqual(legacy['status'],'interrupted')
        self.assertEqual(legacy['prompt'],'LEGACY ORIGINAL')
        self.assertNotIn('attempt_id',legacy,'do not invent IDs for historical calls')
        self.assertEqual(current['status'],'interrupted')
        self.assertEqual(current['number'],2)

    def test_progress_and_snapshot_are_read_only_and_count_scheduled_slots(self):
        state=self.state(); state['status']='paused'
        state['turns']=[{'id':'S1A1'},{'id':'S1A1'},{'id':'S99A1'}]
        state['attempts']=[{'id':'S1A2','status':'started','prompt':'PRIVATE FIXTURE'}]
        original=copy.deepcopy(state)
        progress=d.execution_progress(state)
        self.assertEqual(progress['completed_turns'],1)
        self.assertEqual(progress['completed_stages'],0)
        self.assertEqual(progress['stages'][0]['status'],'partial')
        self.assertEqual(progress['next_turn']['id'],'S1A2')
        self.assertFalse(progress['complete'])
        with tempfile.TemporaryDirectory() as temp, patch.object(d,'model_call',side_effect=AssertionError('NO MODEL')):
            app=u.ControlApp(Path(temp)); run=app.runs/'legacy'; run.mkdir()
            d.dump(run/'debate.json',state); before=(run/'debate.json').read_bytes()
            snapshot=app.snapshot('legacy')
            self.assertEqual(snapshot['progress'],progress)
            self.assertNotIn('prompt',snapshot['attempts'][0])
            self.assertEqual((run/'debate.json').read_bytes(),before)
        self.assertEqual(state,original)
        state['turns']=[{'id':f'S{s}A{a}'} for s in (1,2) for a in (1,2,3)]
        progress=d.execution_progress(state)
        self.assertEqual(progress['completed_stages'],2)
        self.assertIsNone(progress['next_turn'])
        self.assertTrue(progress['complete'])

    def test_stale_stream_or_completion_cannot_replace_new_attempt(self):
        with tempfile.TemporaryDirectory() as temp:
            app=u.ControlApp(Path(temp))
            app.on_update('run',{'event':'turn_started','id':'S1A1','attempt_id':'NEW',
                                'agent':{'name':'GPT','provider':'codex'},'stage_title':'독립 조사'})
            def event(attempt,text):
                return {'event':'model_event','attempt_id':attempt,'provider':'codex',
                        'data':{'type':'item.completed','item':{'type':'agent_message','text':text}}}
            app.on_update('run',event('OLD','STALE'))
            app.on_update('run',event(None,'UNTAGGED'))
            self.assertEqual(app.latest['run']['text'],'')
            app.on_update('run',event('NEW','CURRENT'))
            app.on_update('run',{'event':'turn_completed','attempt_id':'OLD'})
            self.assertEqual(app.latest['run']['text'],'CURRENT')
            app.on_update('run',{'event':'turn_completed','attempt_id':'NEW'})
            self.assertIsNone(app.latest['run'])


if __name__=='__main__':unittest.main()
