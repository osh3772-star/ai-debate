"""Offline regression checks. These NEVER count as real model validation."""
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import debate as d

class ProtocolTests(unittest.TestCase):
    def state(self):
        return {'created':d.now(),'mode':'research','topic':'가상 주제','status':'created','materials':'제공 자료','timeout':10,'agents':[{'provider':p,'name':n} for p,n in zip(d.CORE_PROVIDERS,d.ROLES)],'turns':[]}

    def test_independence_and_cross_reference(self):
        s=self.state();s['turns']=[{'id':'S1A1','name':'GPT','stage':'independent','answer':'UNIQUE_PREVIOUS_CLAIM'}]
        self.assertNotIn('UNIQUE_PREVIOUS_CLAIM',d.build_prompt(s,0,1))
        self.assertIn('UNIQUE_PREVIOUS_CLAIM',d.build_prompt(s,1,0))
        self.assertIn('S1A1',d.build_prompt(s,1,0))

    def test_redaction(self):
        x='Bearer secret123 access_token=private123 sk-ant-abcdefghijklmnopqrstuvwxyz abc@example.com 010-1234-5678 900101-1234567'
        cleaned=d.redact(x)
        for secret in ('secret123','private123','sk-ant-abc','abc@example.com','010-1234','900101-'):self.assertNotIn(secret,cleaned)

    def test_paid_environment_removed(self):
        with patch.dict('os.environ',{'ANTHROPIC_API_KEY':'secret','OPENAI_BASE_URL':'https://gateway','GOOGLE_APPLICATION_CREDENTIALS':'private.json'}):
            env=d.safe_env()
        for k in ('ANTHROPIC_API_KEY','OPENAI_BASE_URL','GOOGLE_APPLICATION_CREDENTIALS'):self.assertNotIn(k,env)

    def test_pause_resume_and_no_false_verification(self):
        s=self.state();s['mode']='smoke'
        answer=json.dumps({'analysis':'OFFLINE FIXTURE','claims':[{'id':'c1','claim':'test','kind':'verified_external','status':'검증 완료'}],'audit':[],'unresolved':[]})
        with tempfile.TemporaryDirectory() as temp, patch.object(d,'model_call',return_value=(answer,{'test_fixture':True},'')) as call:
            path=Path(temp)
            d.execute(s,path,max_turns=1)
            self.assertEqual(s['status'],'paused');self.assertEqual(len(s['turns']),1)
            self.assertNotIn('OFFLINE FIXTURE',call.call_args.args[1])
            d.execute(s,path)
            self.assertEqual(len(s['turns']),6);self.assertEqual(s['status'],'completed')
            self.assertEqual(len({t['id'] for t in s['turns']}),6)
            self.assertIn('원문 대조 대기',(path/'evidence_register.md').read_text(encoding='utf-8'))
            self.assertTrue(all((path/name).is_file() for name in ['research_dossier.md','alternatives_c.md','evidence_register.md','ai_audit.md','debate_log.md','report_outline.md','professor_review.md','debate.json','events.jsonl']))

    def test_real_output_completion_required(self):
        with self.assertRaises(RuntimeError):d.extract('codex','{"type":"turn.started"}')
        with self.assertRaises(RuntimeError):d.extract('google','{"event":"result","result":{"status":"FAILED","error":"no login"}}')

if __name__=='__main__':unittest.main()
