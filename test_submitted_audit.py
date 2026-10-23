"""Offline user-answer audit contracts. Real CLI creation is forbidden in every test."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import debate as d
import research_protocol as p
import context_plan as cp
import submitted_audit as a
import result_digest as rd
import report_plan as rp
import ui_server as u


def fixture():
    agents = d.default_agents(2); agents[1]['is_moderator'] = True
    return dict(version=3, protocol_version=3, quote_check_version=2, course_guidance_version=3, review_policy_version=1,
                domain='accounting_pbl', mode='research', created=d.now(), topic='OFFLINE CASE AUDIT', status='created',
                materials='\n## 자료: fixture.md\nL1: OFFLINE SOURCE ONLY\n', agents=agents, turns=[], timeout=30,
                web_research=False, offline_fixture=True, submitted_audit_version=1,
                submitted_cases=a.validate([{'question': f'QUESTION{i}', 'answer': f'ORIGINAL{i}', 'source': 'User supplied', 'suspicion': f'PRIVATE_SUSPICION{i}'} for i in range(1, 4)]))


def check(case=1, verdict='unverified'):
    return dict(case_id=f'USERCASE{case}', verdict=verdict, reason=f'REASON{case}', evidence='fixture.md:L1', limitations='OFFLINE LIMIT',
                corrected_answer='CORRECTION CANDIDATE' if verdict in ('error', 'partial') else '', revised_question='', change_reason='INITIAL OR MAINTAIN')


def turn(tid, stage, **fields):
    data=dict(analysis='OFFLINE ONLY', **fields)
    t=dict(id=tid, stage=stage, stage_title=stage, name='Fixture '+tid.split('A')[-1], provider='codex', prompt='FIXTURE',
           answer=json.dumps(data), parsed=d.normalize_answer(data), time=d.now())
    p.assign_ids(t)
    return t


class SubmittedAuditTests(unittest.TestCase):
    def setUp(self):
        self.guard=patch.object(d.subprocess, 'Popen', side_effect=AssertionError('REAL CLI FORBIDDEN'))
        self.guard.start(); self.addCleanup(self.guard.stop)

    def test_validate_empty_limit_partial_and_redaction(self):
        self.assertEqual(a.validate([{}, {}, {}]), [])
        for value in ({}, [{}]*4, [{'question':'missing answer'}], [{'answer':'x'*4001}], [{'answer':[]}]):
            with self.assertRaises(ValueError): a.validate(value)
        cleaned=a.validate([{}, {'answer':'user@example.com Bearer fake-secret'}], d.redact)
        self.assertEqual(cleaned[0]['id'], 'USERCASE1')
        self.assertNotIn('user@example.com', str(cleaned)); self.assertNotIn('fake-secret', str(cleaned))

    def test_blind_stage_and_cross_disclosure(self):
        s=fixture(); s['turns']=[turn('S1A1','independent',submitted_checks=[check()])]
        for i in range(2):
            prompt=d.build_prompt(s,0,i)
            for n in range(1,4): self.assertIn(f'ORIGINAL{n}',prompt); self.assertNotIn(f'PRIVATE_SUSPICION{n}',prompt)
            self.assertNotIn('REASON1',prompt)
        prompt=d.build_prompt(s,1,1)
        self.assertIn('PRIVATE_SUSPICION1',prompt); self.assertIn('S1A1.SC1',prompt); self.assertIn('REASON1',prompt)
        self.assertIn('challenges',prompt); self.assertIn('사용자 원답변의 판정은 submitted_checks',prompt)

    def test_snapshot_freezes_cases_and_preserves_legacy(self):
        s=fixture(); d.build_prompt(s,0,0); digest=rp.source_digest(s)
        s['submitted_cases'][0]['answer']='CHANGED'
        self.assertNotEqual(digest,rp.source_digest(s))
        with self.assertRaisesRegex(ValueError,'공유 입력'): d.build_prompt(s,0,1)
        legacy=fixture(); legacy.pop('submitted_audit_version'); legacy.pop('submitted_cases')
        prompt=d.build_prompt(legacy,0,0)
        self.assertNotIn('submitted_checks:',prompt)
        self.assertNotIn('submitted_cases_sha256',legacy['phase_inputs']['independent'])
        self.assertIsNone(a.overview(legacy))

    def test_cross_targets_and_replies_are_sent_whole(self):
        s=fixture(); original=turn('S1A1','independent',submitted_checks=[check()])
        review=turn('S2A2','cross',challenges=[dict(target_turn='S1A1',target_claim='S1A1.SC1',quote='REASON1',disposition='challenge',reason='REVIEW FULL',severity='major')])
        reply=turn('S3A1','rebuttal',submitted_checks=[check(verdict='not_error')],responses=[dict(challenge_id='S2A2.CH1',disposition='수용',resolution='addressed',reason='REPLY FULL',revised_claim='REVISED')])
        s['turns']=[original,review,reply]
        self.assertIsNone(p.challenge_problem(review['parsed']['challenges'][0],review,p.record_objects(s['turns']),2))
        for stage, final in [('rebuttal',False),('alternatives',False),('professor',False),('revision',True)]:
            context, manifest=cp.compose(s['turns'],stage,'A2',final,room=0)
            for snippet in ('REVIEW FULL','REPLY FULL','REVISED','S3A1.SC1'): self.assertIn(snippet,context)
            self.assertNotIn('S3A1.SC1',manifest['abridged'])
        with self.assertRaises(cp.Overflow): cp.compose(s['turns'],'revision','A2',True,cap=10)
        result=p.review(s,d.run_plan(s))
        self.assertEqual(result['expected_reviews'],1); self.assertEqual(result['recorded_reviews'],1)
        self.assertEqual(result['missing_peer_reviews'],[])

    def test_moderator_is_not_majority_or_truth_and_invalid_never_final(self):
        s=fixture(); s['turns']=[turn('S7A1','revision',submitted_checks=[check(verdict='error')]),turn('S7A2','revision',submitted_checks=[check(verdict='not_error')])]
        view=a.overview(s); self.assertEqual(view['cases'][0]['label'],'오류 아님')
        self.assertEqual(view['cases'][0]['moderator']['owner'],'A2')
        self.assertEqual(len(view['cases'][0]['latest']),2)
        self.assertTrue(view['issues'])  # cases 2/3 missing; not disguised as a complete audit
        self.assertEqual(rd.audit_findings(s),[])
        s['agents'][1]['is_moderator']=False
        self.assertIn('총괄 미지정',a.overview(s)['cases'][0]['label'])
        self.assertIsNone(a.overview(s)['cases'][0]['moderator'])
        s['agents'][1]['is_moderator']=True
        s['turns'][-1]['parsed']['submitted_checks'][0]['evidence']=''
        self.assertIsNone(a.overview(s)['cases'][0]['moderator'])
        s['turns'][-1]['parsed']['submitted_checks']=[check(),check()]
        self.assertIsNone(a.overview(s)['cases'][0]['moderator'])

    def test_missing_and_malformed_checks_stay_visible_without_crashing(self):
        s=fixture(); t=turn('S1A1','independent',submitted_checks=[dict(case_id=[], verdict={}), dict(case_id='UNKNOWN')]); s['turns']=[t]
        v=a.overview(s); self.assertEqual(len(v['cases']),3); self.assertEqual(len(v['issues']),4)
        self.assertTrue(all(c['moderator'] is None for c in v['cases']))

    def test_section2_and_synthesis_preserve_user_origin_and_check_history(self):
        s=fixture(); s['turns']=[turn('S1A1','independent',submitted_checks=[check()]),turn('S7A2','revision',submitted_checks=[check(verdict='partial')])]
        index=rp.record_index(s)
        self.assertEqual(index['USERCASE1']['sections'],[2]); self.assertEqual(index['S7A2.SC1']['sections'],[2])
        prompt=rd.synthesis_prompt(s)
        self.assertIn('ORIGINAL1',prompt); self.assertIn('CORRECTION CANDIDATE',prompt); self.assertIn('S1A1.SC1',prompt)
        self.assertIn('중복 집계하지 마라',prompt)
        v=rd.overview(s)
        refs={r['id'] for r in v['report_plan']['sections'][1]['evidence']}
        self.assertIn('USERCASE1',refs); self.assertIn('S7A2.SC1',refs)

    def test_config_start_and_snapshot_roundtrip_without_launch(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(d,'model_call',side_effect=AssertionError('NO INFERENCE')):
            app=u.ControlApp(tmp,tmp); self.addCleanup(app.close)
            cfg=app.defaults(); self.assertEqual(cfg['submitted_cases'],[])
            cfg['submitted_cases']=fixture()['submitted_cases']; cfg['approve_transfer']=True
            with patch.object(app,'_launch') as launch: rid=app.start(cfg)['run']
            launch.assert_called_once()
            state=json.loads((app.runs/rid/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual(state['submitted_audit_version'],a.VERSION); self.assertEqual(len(state['submitted_cases']),3)
            self.assertEqual(app.snapshot(rid)['submitted_cases'],state['submitted_cases'])
            self.assertEqual(app.snapshot(rid)['result_overview']['submitted_audit']['count'],3)
            self.assertTrue(app.bootstrap()['submitted_audit_supported'])
            cfg['mode']='smoke'
            with self.assertRaisesRegex(u.UIError,'연구 또는 합의'): app.validate_config(cfg)

    def test_full_pipeline_pause_resume_and_reports_with_mocked_inference(self):
        s=fixture(); calls=[]
        def mock_call(provider,prompt,*args,**kwargs):
            schedule=d.run_plan(s); stage=schedule[len(calls)//2][0]; actor=len(calls)%2+1
            calls.append(prompt); output={'analysis':'OFFLINE AUDIT PIPELINE'}
            if stage in a.CHECK_STAGES: output['submitted_checks']=[check(i,['not_error','partial','unverified'][i-1]) for i in range(1,4)]
            if stage=='independent': output['claims']=[dict(claim='OFFLINE SOURCE ONLY',kind='task_fact',source='fixture.md:L1')]
            if stage=='cross':
                other=3-actor
                output['challenges']=[dict(target_turn=f'S1A{other}',target_claim=f'S1A{other}.SC{i}',quote=f'REASON{i}',disposition='supports',reason='OFFLINE REVIEW') for i in range(1,4)]
            return json.dumps(output),{'offline_fixture':True},''
        with tempfile.TemporaryDirectory() as tmp, patch.object(d,'model_call',side_effect=mock_call):
            path=Path(tmp); d.execute(s,path,max_turns=3)
            self.assertEqual(s['status'],'paused'); saved=json.loads((path/'debate.json').read_text(encoding='utf-8'))
            d.execute(saved,path)
            self.assertEqual(len(calls),14); self.assertEqual(saved['status'],'completed')
            self.assertFalse(a.overview(saved)['issues'])
            self.assertNotIn('PRIVATE_SUSPICION1',calls[0]); self.assertNotIn('REASON1',calls[1]); self.assertIn('REASON1',calls[2])
            self.assertIn('S3A1.SC1',calls[-1]); self.assertIn('ORIGINAL1',calls[-1])
            for name in ('ai_audit.md','ai_usage_appendix.md','debate_log.md'):
                self.assertIn('ORIGINAL1',(path/name).read_text(encoding='utf-8'))
            self.assertEqual(len(a.rows(saved)),18)


if __name__=='__main__': unittest.main()
