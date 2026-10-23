"""Offline protocol regressions. Every inference/subprocess path is mocked or forbidden."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import debate as d
import research_protocol as p
import ui_server as u


class ProtocolV3Tests(unittest.TestCase):
    def setUp(self):
        blocker=patch.object(d.subprocess,'Popen',side_effect=AssertionError('REAL PROCESS FORBIDDEN'))
        blocker.start();self.addCleanup(blocker.stop)

    def state(self, **overrides):
        return dict(version=3,protocol_version=3,domain='accounting_pbl',mode='research',
                    topic='OFFLINE RESEARCH',created=d.now(),status='created',materials='\n## 자료: fixture.md\nL1: OFFLINE CLAIM 1. OFFLINE CLAIM 2.\n',
                    timeout=30,offline_fixture=True,agents=d.default_agents(2),turns=[],**overrides)

    def turn(self, tid, stage, **fields):
        t=dict(id=tid,stage=stage,stage_title=stage,name='OFFLINE '+tid[-2:],provider='codex',
               prompt='OFFLINE QUESTION',answer=json.dumps(fields,ensure_ascii=False),time=d.now(),
               parsed=d.normalize_answer(dict(analysis='OFFLINE ANALYSIS',**fields)))
        p.assign_ids(t);return t

    def independent(self, index):
        return self.turn(f'S1A{index}','independent',
                         claims=[dict(id='local',claim=f'OFFLINE CLAIM {index}',kind='task_fact',source='fixture.md:L1')],
                         candidate_seeds=[dict(idea='PRIVATE_SEED_SENTINEL',status='unassessed')])

    def test_versioned_schedule_keeps_legacy_stage_ids(self):
        s=self.state()
        self.assertEqual([x[0] for x in d.run_plan(s)],['independent','cross','rebuttal','alternatives','perspectives','professor','revision'])
        s['protocol_version']=2
        self.assertEqual([x[0] for x in d.run_plan(s)],['independent','cross','alternatives','perspectives','professor','revision'])
        s.update(mode='consensus',protocol_version=1)
        self.assertEqual([x[0] for x in d.run_plan(s)],['independent','cross','rebuttal','consensus'])

    def test_general_domain_does_not_leak_accounting_material_keywords(self):
        s=self.state();s.update(domain='general',materials='회계 K-IFRS PBL')
        self.assertFalse(d.is_accounting_debate(s))
        self.assertNotIn('절충 대안',d.get_base_prompt(s))
        self.assertNotIn('K-IFRS',d.get_base_prompt(s))
        self.assertNotIn('C안',d.build_prompt(s,0,0))

    def test_independence_and_same_phase_snapshot_with_seed_privacy(self):
        s=self.state();s['turns']=[self.independent(1)]
        s['turns'][0]['parsed']['claims'][0]['claim']='PRIVATE_PEER_CLAIM_SENTINEL'
        self.assertNotIn('PRIVATE_PEER_CLAIM_SENTINEL',d.build_prompt(s,0,1))
        s['turns'].append(self.independent(2))
        first=d.build_prompt(s,1,0)
        self.assertIn('PRIVATE_PEER_CLAIM_SENTINEL',first)
        self.assertNotIn('PRIVATE_SEED_SENTINEL',first)
        s['turns'].append(self.turn('S2A1','cross',conclusion='SAME_PHASE_SENTINEL'))
        second=d.build_prompt(s,1,1)
        self.assertNotIn('SAME_PHASE_SENTINEL',second)
        self.assertEqual(s['phase_inputs']['cross']['turn_ids'],['S1A1','S1A2'])
        self.assertIn('PRIVATE_SEED_SENTINEL',d.build_prompt(s,3,0))

    def test_resume_rejects_changed_shared_input(self):
        s=self.state();s['turns']=[self.independent(1),self.independent(2)]
        d.build_prompt(s,1,0)
        restored=json.loads(json.dumps(s))
        self.assertEqual(d.build_prompt(restored,1,0),d.build_prompt(s,1,0))
        restored['turns'][0]['answer']='CHANGED'
        with self.assertRaisesRegex(ValueError,'공유 입력'):d.build_prompt(restored,1,1)

    def test_essential_context_overflow_fails_before_any_model_call(self):
        s=self.state();t=self.independent(1);t['parsed']['claims'][0]['claim']='X'*50000;s['turns']=[t]
        with self.assertRaises(d.ProviderError) as caught:d.build_prompt(s,1,0)
        self.assertEqual(caught.exception.category,'context_limit')

    def test_early_final_report_is_preserved_but_not_counted_as_recommendation(self):
        s=self.state();t=self.independent(1);t['parsed']['decision']={'status':'conditional_recommendation'};s['turns']=[t]
        original=t['answer'];p.review(s,d.run_plan(s))
        self.assertEqual(t['protocol_checks']['decision_status'],'not_due')
        self.assertTrue(t['protocol_checks']['warnings'])
        self.assertEqual(t['parsed']['decision']['status'],'conditional_recommendation')
        self.assertEqual(t['answer'],original)

    def test_claim_ids_and_web_checks_are_linked_without_rewriting_raw(self):
        t=self.turn('S1A2','independent',claims=[dict(id='C1',claim='test')],web_checks=[dict(claim_id='C1')])
        self.assertEqual(t['parsed']['claims'][0]['id'],'S1A2.CLM1')
        self.assertEqual(t['parsed']['web_checks'][0]['claim_id'],'S1A2.CLM1')
        self.assertIn('C1',t['answer'])

    def test_missing_cross_review_and_false_quote_block_final(self):
        s=self.state();s['turns']=[self.independent(1),self.independent(2)]
        s['turns'].append(self.turn('S2A1','cross',challenges=[dict(target_claim='S1A2.CLM1',target_turn='S1A2',quote='invented',disposition='challenge',reason='test')]))
        for i in (1,2):s['turns'].append(self.turn(f'S7A{i}','revision',decision=dict(status='conditional_recommendation',basis_claim_ids=['S1A1.CLM1'])))
        r=p.review(s,d.run_plan(s))
        self.assertEqual(len(r['missing_peer_reviews']),2)
        self.assertTrue(r['invalid_references'])
        self.assertEqual(r['status'],'needs_review')
        self.assertTrue(all(t['protocol_checks']['decision_status']=='withheld' for t in s['turns'][-2:]))

    def test_short_free_debate_cannot_claim_final_research(self):
        s=self.state();s.update(mode='smoke',domain='general',smoke_rounds=2)
        self.assertFalse(p.final_stage(s,'round2',d.run_plan(s)))
        self.assertIn('최종 연구·합의를 선언하지 마라',d.run_plan(s)[1][2])
        s['smoke_rounds']=1
        self.assertEqual(len(d.run_plan(s)),1)

    def test_config_domain_is_explicit_and_old_configs_migrate_without_saving(self):
        with tempfile.TemporaryDirectory() as tmp:
            app=u.ControlApp(tmp,tmp);cfg=app.defaults()
            cfg.update(mode='smoke');cfg.pop('domain')
            self.assertEqual(app.validate_config(cfg)['domain'],'general')
            cfg['domain']='invalid'
            with self.assertRaises(u.UIError):app.validate_config(cfg)
            self.assertFalse(app.config_path.exists())

    def test_full_offline_pipeline_preserves_traceability_and_reports(self):
        s=self.state();schedule=d.run_plan(s);calls=[]
        def call(provider,prompt,timeout,settings=None,**kwargs):
            index=len(calls);si=index//2;ai=index%2;stage=schedule[si][0];calls.append(prompt)
            result=dict(analysis='OFFLINE FIXTURE ONLY',claims=[],proposals=[],unresolved=[],conclusion='OFFLINE OPINION')
            if stage=='independent':
                result['claims']=[dict(id='local',claim=f'OFFLINE CLAIM {ai+1}',kind='task_fact',source='fixture.md:L1')]
                result['candidate_seeds']=[dict(idea='OFFLINE SEED',status='unassessed')]
            if stage=='cross':
                other=2-ai;result['challenges']=[dict(target_claim=f'S1A{other}.CLM1',target_turn=f'S1A{other}',quote=f'OFFLINE CLAIM {other}',disposition='challenge',severity='critical',reason='OFFLINE CHECK')]
            if stage in ('rebuttal','revision'):
                result['responses']=[dict(challenge_id=ch['id'],disposition='수용',reason='OFFLINE REPLY',resolution='addressed')
                                     for t in s['turns'] for ch in t['parsed'].get('challenges',[])
                                     if (ch.get('target_turn','').endswith(f'A{ai+1}') and (t['stage']=='cross' if stage=='rebuttal' else t['stage']=='professor'))]
            if stage=='alternatives':
                result['candidates']=[dict(proposal=f'OFFLINE CANDIDATE {ai+1}.{i}',issue_ids=['S1A1.CLM1']) for i in (1,2,3)]
            if stage=='professor':
                other=2-ai;result['challenges']=[dict(target_candidate=f'S4A{other}.C1',target_turn=f'S4A{other}',quote=f'OFFLINE CANDIDATE {other}.1',disposition='challenge',severity='critical',reason='OFFLINE CRITIQUE')]
            if stage=='revision':result['decision']=dict(status='conditional_recommendation',candidate_id='S4A1.C1',basis_claim_ids=['S1A1.CLM1'],conditions=['OFFLINE ONLY'])
            return json.dumps(result,ensure_ascii=False),{'offline_fixture':True},''
        with tempfile.TemporaryDirectory() as tmp,patch.object(d,'model_call',side_effect=call):
            path=Path(tmp);d.execute(s,path,max_turns=5)
            self.assertEqual(s['status'],'paused')
            snapshots=copy.deepcopy(s['phase_inputs']);d.execute(s,path)
            self.assertEqual(len(calls),14)
            self.assertEqual(s['status'],'completed')
            self.assertEqual(s['review_state']['status'],'conditional')
            self.assertEqual(s['review_state']['critical_pending_count'],0)
            self.assertTrue(all(s['phase_inputs'][k]==v for k,v in snapshots.items()))
            self.assertTrue(all(t['protocol_checks']['decision_status']=='conditional_recommendation' for t in s['turns'][-2:]))
            for name in u.REPORTS:
                self.assertTrue((path/name).is_file(),name)
            self.assertIn('OFFLINE SEED',(path/'alternatives_c.md').read_text(encoding='utf-8'))
            self.assertIn('challenge_id',(path/'evidence_register.md').read_text(encoding='utf-8'))
            self.assertIn('오프라인 모의 검증 자료',(path/'summary.md').read_text(encoding='utf-8'))
            self.assertIn('phase_inputs',json.loads((path/'debate.json').read_text(encoding='utf-8')))

    def test_provider_output_and_event_logs_mask_secrets_before_saving(self):
        s=self.state();s.update(mode='smoke',domain='general')
        payload=json.dumps({'analysis':'user@example.com Bearer synthetic-secret','claims':[]})
        raw={'accessToken':'synthetic-private','content':'user@example.com'}
        with tempfile.TemporaryDirectory() as tmp,patch.object(d,'model_call',return_value=(payload,raw,'Bearer diagnostic-secret')):
            path=Path(tmp);d.execute(s,path,max_turns=1)
            for name in ('debate.json','events.jsonl','debate_log.md'):
                body=(path/name).read_text(encoding='utf-8')
                for secret in ('user@example.com','synthetic-secret','synthetic-private','diagnostic-secret'):self.assertNotIn(secret,body)
            self.assertIn('[REDACTED]',s['turns'][0]['answer'])

    def test_local_source_checks_reject_fabricated_file_and_line_ranges(self):
        s=self.state()
        self.assertTrue(p.local_source_recorded(s,'fixture.md:L1'))
        self.assertFalse(p.local_source_recorded(s,'fixture.md:L9'))
        self.assertFalse(p.local_source_recorded(s,'fixture.md:L1-L9'))
        self.assertFalse(p.local_source_recorded(s,'invented.md:L1'))

    def test_new_ui_run_is_v3_and_snapshot_preserves_review_state(self):
        with tempfile.TemporaryDirectory() as tmp:
            app=u.ControlApp(tmp,tmp);cfg=app.defaults();cfg.update(approve_transfer=True)
            with patch.object(app,'_launch') as launch:
                result=app.start(cfg)
            launch.assert_called_once()
            stored=json.loads((app.runs/result['run']/'debate.json').read_text(encoding='utf-8'))
            snapshot=app.snapshot(result['run'])
            self.assertEqual(stored['protocol_version'],3)
            self.assertEqual(stored['review_policy_version'],1)
            self.assertEqual(snapshot['review_policy_version'],1)
            self.assertEqual(snapshot['total_turns'],21)
            self.assertEqual(snapshot['domain'],'accounting_pbl')
            self.assertEqual(snapshot['review_state']['status'],'gathering')
            self.assertEqual(app.bootstrap()['protocol_version_supported'],3)
            self.assertEqual(app.bootstrap()['review_policy_version_supported'],1)

    def test_malformed_nested_references_fail_closed_without_renderer_crash(self):
        s=self.state()
        t=self.turn('S7A1','revision',decision={'status':'conditional_recommendation','candidate_id':['bad'],'basis_claim_ids':[{}]},
                    web_checks=[{'claim_id':[]}],responses=[{'challenge_id':{}}])
        s['turns']=[t]
        result=p.review(s,d.run_plan(s))
        self.assertTrue(result['invalid_references'])
        self.assertEqual(t['protocol_checks']['decision_status'],'withheld')

    def test_accounting_cannot_recommend_without_comparing_and_selecting_c(self):
        s=self.state();s['turns']=[self.independent(1),self.independent(2),
                                 self.turn('S4A1','alternatives',candidates=[{'proposal':'ONLY ONE'}]),
                                 self.turn('S7A1','revision',decision={'status':'conditional_recommendation','basis_claim_ids':['S1A1.CLM1']})]
        result=p.review(s,d.run_plan(s))
        self.assertTrue(result['candidate_issues'])
        self.assertIn('검토한 C 후보 ID 미기록',s['turns'][-1]['protocol_checks']['reasons'])
        self.assertEqual(s['turns'][-1]['protocol_checks']['decision_status'],'withheld')


if __name__=='__main__':unittest.main()
