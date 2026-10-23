"""Offline review-policy checks. Synthetic records are not actual AI findings."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import debate as d
import research_protocol as p


class FinalReviewTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(d.subprocess, 'Popen', side_effect=AssertionError('REAL CLI FORBIDDEN'))
        guard.start(); self.addCleanup(guard.stop)
        guard = patch.object(d, 'model_call', side_effect=AssertionError('REAL INFERENCE FORBIDDEN'))
        guard.start(); self.addCleanup(guard.stop)

    def state(self):
        s = dict(version=3, protocol_version=3, review_policy_version=1, domain='general',
                 mode='research', topic='OFFLINE REVIEW FIXTURE', status='created', created=d.now(),
                 timeout=30, offline_fixture=True, agents=d.default_agents(2),
                 materials='\n## 자료: fixture.md\nL1: 가용 12, 비용 8, 최소 잔여 3.\n', turns=[])
        for si, (stage, title, _) in enumerate(d.run_plan(s), 1):
            for ai in (1, 2):
                other = 3-ai
                fields = dict(analysis='OFFLINE ONLY', claims=[], challenges=[], conclusion='원안 유지')
                if stage == 'independent':
                    fields['claims'] = [dict(claim='가용 12, 비용 8, 최소 잔여 3', kind='task_fact', source='fixture.md:L1')]
                if stage == 'cross':
                    fields['challenges'] = [dict(target_claim=f'S1A{other}.CLM1', target_turn=f'S1A{other}',
                                                quote='가용 12, 비용 8, 최소 잔여 3', disposition='supports', reason='제공 자료와 일치')]
                if stage == 'alternatives':
                    fields['candidates'] = [dict(proposal='12 - 8 = 4 ≥ 3인 원안')]
                if stage == 'professor':
                    fields['review_assessment'] = dict(status='no_material_defect',
                        checked_ids=[f'S1A{other}.CLM1', f'S4A{other}.C1'], criteria=['자료의 최소 잔여 조건'],
                        retained_reasons=['산식 12 - 8 = 4 ≥ 3을 유지'], scope_limitations=['제공 자료 범위'], summary='중대한 결함 없음')
                if stage == 'revision':
                    fields['decision'] = dict(status='conditional_recommendation', candidate_id='S4A1.C1',
                                              basis_claim_ids=['S1A1.CLM1'], conditions=['제공된 수치 가정'])
                t = dict(id=f'S{si}A{ai}', stage=stage, stage_title=title, name=f'OFFLINE A{ai}',
                         provider='codex', time=d.now(), prompt='OFFLINE QUESTION',
                         answer=json.dumps(fields, ensure_ascii=False), parsed=d.normalize_answer(fields))
                p.assign_ids(t); s['turns'].append(t)
        return s

    def critique(self, s, kind='confirmed_defect', disposition='challenge', severity='critical'):
        t = next(t for t in s['turns'] if t['id'] == 'S6A2')
        t['parsed']['challenges'] = [dict(id='S6A2.CH1', target_candidate='S4A1.C1', target_turn='S4A1',
             quote='12 - 8 = 4 ≥ 3인 원안', disposition=disposition, severity=severity, finding_type=kind,
             criterion='최소 잔여 조건', evidence='OFFLINE 검토 근거', impact='OFFLINE 영향', reason='OFFLINE 지적')]
        t['parsed']['review_assessment']['status'] = 'verification_needed' if kind == 'unverified_premise' else 'findings_present'
        return t

    def reply(self, s, disposition, reason, resolution='addressed'):
        t = next(t for t in s['turns'] if t['id'] == 'S7A1')
        t['parsed']['responses'] = [dict(challenge_id='S6A2.CH1', disposition=disposition,
             reason=reason, resolution=resolution, revised_claim='원안 유지' if disposition == '기각' else '수정 내용')]

    def test_no_defects_passes_without_inventing_any_critique(self):
        s = self.state(); raw = copy.deepcopy(s['turns'])
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'conditional')
        self.assertEqual(result['final_review_issues'], [])
        self.assertEqual(len(result['final_reviews']), 2)
        self.assertTrue(all(r['record_complete'] for r in result['final_reviews']))
        self.assertTrue(all(not t['parsed']['challenges'] for t in s['turns'] if t['stage'] == 'professor'))
        self.assertEqual([t['answer'] for t in s['turns']], [t['answer'] for t in raw])

    def test_bad_critique_can_be_rejected_with_original_preserved(self):
        s = self.state(); self.critique(s)
        self.reply(s, '기각', '12 - 8 = 4이며 4 ≥ 3이므로 부족하다는 지적을 기각한다')
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['critical_pending_count'], 0)
        self.assertEqual(result['status'], 'conditional')
        self.assertEqual(s['turns'][-2]['parsed']['responses'][0]['revised_claim'], '원안 유지')
        self.assertIn('독립', result['final_review_scope'])

    def test_substantive_unanswered_critique_blocks_then_acceptance_is_recorded(self):
        s = self.state(); self.critique(s)
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['critical_pending_count'], 1)
        self.assertEqual(result['status'], 'needs_review')
        self.reply(s, '수용', 'OFFLINE 근거에 따라 오류 수정')
        self.assertEqual(p.review(s, d.run_plan(s))['status'], 'conditional')

    def test_unverified_core_premise_is_not_a_confirmed_error(self):
        s = self.state(); self.critique(s, 'unverified_premise', 'unverified')
        self.reply(s, '부분 수용', '외부 원문 확인 대기', 'open')
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'needs_review')
        self.assertEqual(result['critical_pending_count'], 1)
        self.assertTrue(all(not t['parsed']['audit'] for t in s['turns']))

    def test_optional_suggestion_does_not_block_even_if_model_marks_it_critical(self):
        s = self.state(); t = self.critique(s, 'optional_suggestion')
        t['parsed']['review_assessment']['status'] = 'no_material_defect'
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['critical_pending_count'], 0)
        self.assertEqual(len(result['pending_challenges']), 1)
        self.assertEqual(result['status'], 'conditional')
        self.assertEqual(t['parsed']['challenges'][0]['severity'], 'critical', 'raw model labels stay preserved')

    def test_empty_critique_without_review_scope_is_not_a_pass(self):
        s = self.state(); s['turns'][10]['parsed'].pop('review_assessment')
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'needs_review')
        self.assertTrue(result['final_review_issues'])

    def test_unreviewed_selected_candidate_blocks_recommendation(self):
        s = self.state(); s['turns'][11]['parsed']['review_assessment']['checked_ids'] = ['S1A1.CLM1']
        p.review(s, d.run_plan(s))
        self.assertIn('선정 후보에 대한 다른 참가자의 최종 검토 기록 필요', s['turns'][-1]['protocol_checks']['reasons'])

    def test_missing_reviewing_participant_blocks_final(self):
        s = self.state(); s['turns'] = [t for t in s['turns'] if t['id'] != 'S6A2']
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['missing_final_reviews'], ['A2'])
        self.assertEqual(result['status'], 'needs_review')

    def test_no_defect_verdict_cannot_hide_core_critique_or_missing_evidence(self):
        s = self.state(); t = self.critique(s)
        t['parsed']['review_assessment']['status'] = 'no_material_defect'
        t['parsed']['challenges'][0]['evidence'] = ''
        self.reply(s, '기각', 'OFFLINE 답변')
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'needs_review')
        self.assertTrue(any('불일치' in e for e in result['final_review_issues']))
        self.assertTrue(any('근거' in e for e in result['final_review_issues']))

    def test_malformed_review_fields_do_not_crash_or_pass(self):
        s = self.state(); s['turns'][10]['parsed']['review_assessment'] = dict(status=[], checked_ids=[{}], criteria=17)
        self.assertEqual(p.review(s, d.run_plan(s))['status'], 'needs_review')
        self.assertEqual(d.normalize_answer({'review_assessment': []})['review_assessment'], {})

    def test_legacy_saved_run_keeps_original_policy_and_has_no_new_gate(self):
        s = self.state(); s.pop('review_policy_version')
        self.assertIn('칭찬 금지', d.run_plan(s)[5][2])
        for t in s['turns']: t['parsed'].pop('review_assessment', None)
        result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'conditional')
        self.assertNotIn('final_reviews', result)

    def test_new_prompt_records_pass_option_and_reasoned_rejection(self):
        s = self.state(); s['turns'] = s['turns'][:10]
        prompt = d.build_prompt(s, 5, 0)
        self.assertNotIn('칭찬 금지', prompt)
        self.assertIn('지적의 최소 개수는 없다', prompt)
        self.assertIn('no_material_defect', prompt)
        self.assertIn('optional_suggestion', prompt)
        s['turns'] = self.state()['turns'][:12]
        self.assertIn('근거 없는 비판은 기각', d.build_prompt(s, 6, 0))

    def test_offline_stop_resume_and_reports_preserve_pass_assessments(self):
        template = self.state(); s = copy.deepcopy(template); s['turns'] = []; calls = []
        def fake_call(provider, prompt, timeout, settings=None, **kwargs):
            t = template['turns'][len(calls)]; calls.append(prompt)
            return json.dumps(t['parsed'], ensure_ascii=False), {'offline_fixture': True}, ''
        with tempfile.TemporaryDirectory() as tmp, patch.object(d, 'model_call', side_effect=fake_call):
            path = Path(tmp); d.execute(s, path, max_turns=11)
            self.assertEqual(s['status'], 'paused')
            d.execute(s, path)
            self.assertEqual(len(calls), 14)
            self.assertEqual(s['review_state']['status'], 'conditional')
            saved = json.loads((path/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['review_policy_version'], 1)
            report = (path/'professor_review.md').read_text(encoding='utf-8')
            self.assertIn('review_assessment', report)
            self.assertIn('no_material_defect', report)
            self.assertIn('오프라인 모의 검증', report)
            self.assertTrue(any('retained_reasons' in prompt for prompt in calls[-2:]))


if __name__ == '__main__': unittest.main()
