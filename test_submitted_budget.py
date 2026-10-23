"""v2 input/mapping regression tests. No provider process or inference is permitted."""
import copy
import tempfile
import unittest
from unittest.mock import patch

import debate as d
import research_protocol as p
import submitted_audit as a
import ui_server as u
from test_submitted_audit import fixture, check, turn


def optimized():
    s = fixture(); s['submitted_audit_version'] = a.VERSION
    return s


class SubmittedBudgetTests(unittest.TestCase):
    def setUp(self):
        for obj, name in ((d.subprocess, 'Popen'), (d, 'model_call')):
            guard = patch.object(obj, name, side_effect=AssertionError('REAL INFERENCE FORBIDDEN'))
            guard.start(); self.addCleanup(guard.stop)

    def test_total_byte_limit_including_korean_and_emoji(self):
        cases = [{'answer': '가' * 2000} for _ in range(3)]
        self.assertEqual(a.input_bytes(a.validate(cases)), 18000)
        cases[-1]['source'] = 'a'
        with self.assertRaisesRegex(ValueError, '18,001 / 18,000'): a.validate(cases)
        with self.assertRaisesRegex(ValueError, '바이트'): a.validate([{'answer': '😀' * 1600}] * 3)
        # All individual fields are valid, but their original combined maximum is not.
        with self.assertRaisesRegex(ValueError, '바이트'): a.validate([{k: '가' * n for k, n in a.LIMITS.items()}] * 3)

    def test_only_explicit_mapping_with_original_question_replaces_queries(self):
        s = optimized()
        s['submitted_cases'][0]['items'] = ['교차매출', 'Repo']
        s['submitted_cases'][1].update(items=['빅배스'], question='')
        self.assertEqual(a.remaining_items(s), ['R&D 자본화', '빅배스'])
        instruction = d.run_plan(s)[0][2]
        self.assertIn('R&D 자본화·빅배스만 legality_checks', instruction)
        self.assertIn('4대 쟁점의 사례 분석 자체를 생략하지 마라', instruction)
        self.assertNotIn('4대 회계처리의 합법성을', instruction)
        s['submitted_cases'][0]['items'] = list(a.ITEMS)
        self.assertIn('legality_checks는 []', d.run_plan(s)[0][2])
        self.assertIn('필수 최초 질의는 없으므로 []', p.contract(s, 'independent', 'S1A1', d.run_plan(s)))
        s['submitted_audit_version'] = 1
        self.assertEqual(a.remaining_items(s), list(a.ITEMS))
        self.assertNotIn('대신하지 않는', d.run_plan(s)[0][2])
        for items in (['unknown'], ['Repo', 'Repo'], 'Repo', [{}]):
            with self.assertRaises(ValueError): a.validate([{'answer': 'x', 'items': items}])

    def test_full_original_in_judgment_stages_compact_in_design_only(self):
        s = optimized()
        for stage in ('independent', 'cross', 'rebuttal', 'professor', 'revision', 'consensus'):
            body = a.prompt(s, stage)
            self.assertIn('ORIGINAL1', body)
            self.assertEqual('PRIVATE_SUSPICION1' in body, stage != 'independent')
        for stage in a.COMPACT_STAGES:
            body = a.prompt(s, stage)
            self.assertNotIn('ORIGINAL1', body); self.assertNotIn('PRIVATE_SUSPICION1', body)
            self.assertIn('original_sha256', body); self.assertIn('USERCASE1', body)
        s['submitted_audit_version'] = 1
        self.assertIn('ORIGINAL1', a.prompt(s, 'alternatives'))

    def test_mapped_coverage_requires_all_participants_and_real_scope_checks(self):
        s = optimized(); s['submitted_cases'] = s['submitted_cases'][:1]
        s['submitted_cases'][0]['items'] = ['교차매출']
        c = check(); c['item_coverage'] = [{'item': '교차매출', 'status': 'covered', 'reason': 'Original question concerns this transaction'}]
        lq = [dict(item=item, question='Actual question', judgment='undetermined', basis='', uncertainty='Missing premise') for item in a.ITEMS[1:]]
        s['turns'] = [turn(f'S1A{i}', 'independent', submitted_checks=[copy.deepcopy(c)], legality_checks=copy.deepcopy(lq)) for i in (1, 2)]
        ids = {r['id'] for t in s['turns'] for k in ('submitted_checks', 'legality_checks') for r in t['parsed'][k]}
        result = lambda: p._mapped_legality_parts(s, s['turns'], ids, {'independent', 'cross'})
        self.assertEqual(result()[0], 'recorded')
        self.assertEqual(len(result()[3][0]['coverage']), 8)
        self.assertEqual(len(result()[1]), 8)
        self.assertEqual(a.overview(s)['cases'][0]['label'], '총괄 최종 판단 대기')
        s['turns'][0]['parsed']['submitted_checks'][0]['item_coverage'][0]['status'] = 'partial'
        self.assertEqual(result()[0], 'partial')
        s['turns'][0]['parsed']['submitted_checks'][0]['item_coverage'][0]['status'] = 'covered'
        s['turns'][1]['parsed']['legality_checks'][0]['judgment'] = 'permitted'
        self.assertEqual(result()[0], 'partial', 'A positive judgment needs its basis, not only uncertainty')
        s['turns'].pop()
        self.assertEqual(result()[0], 'partial', 'An absent participant cannot be marked covered')

    def test_preflight_does_not_mutate_input_or_call_models(self):
        s = optimized(); s['submitted_cases'] = a.validate([{'answer': '가' * 2000}] * 3)
        before = copy.deepcopy(s)
        checks = d.preflight_submitted_input(s)
        self.assertEqual(s, before)
        self.assertEqual(len(checks['checks']), 14)
        self.assertTrue(all(c['bytes'] <= c['budget'] <= d.STRETCH_PROMPT_BYTES for c in checks['checks']))
        self.assertIn('이후 AI 발언 크기는 미포함', checks['scope'])

    def test_oversized_required_source_pauses_before_call_not_silent_omission(self):
        s = optimized()
        s['materials'] = '\n## 자료: (PBL)fixture.md\nL1: ' + 'SOURCE' * 25000
        with self.assertRaisesRegex(d.InputPause, '필수 원문'): d.build_prompt(s, 0, 0)
        with self.assertRaises(d.InputPause): d.preflight_submitted_input(s)

    def test_required_pack_larger_than_old_material_budget_is_delivered_whole(self):
        s = optimized()
        s['materials'] = '\n## 자료: (PBL)fixture.md\nL1: ' + 'SOURCE' * 10500 + 'END_SENTINEL'
        prompt = d.build_prompt(s, 0, 0)
        self.assertIn('END_SENTINEL', prompt)
        self.assertFalse([o for o in s['deliveries']['S1A1']['omitted'] if o['reason'] == '입력 한도'])
        self.assertLessEqual(len(prompt.encode()), s['deliveries']['S1A1']['prompt_budget'])
        s['instructions'] = 'COMMAND' * 20000
        with self.assertRaises(d.InputPause): d.preflight_submitted_input(s)

    def test_future_required_check_growth_stops_before_call(self):
        s = optimized(); c = check(); c['reason'] = 'FUTURE_CHECK' * 10000
        s['turns'] = [turn('S1A1', 'independent', submitted_checks=[c])]
        before = copy.deepcopy(s['turns'])
        with self.assertRaises(d.InputPause): d.build_prompt(s, 1, 1)
        self.assertEqual(s['turns'], before)

    def test_start_rejects_overflow_before_creating_run_or_launch(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = u.ControlApp(tmp, tmp); self.addCleanup(app.close)
            cfg = app.defaults(); cfg.update(approve_transfer=True, submitted_cases=[{'answer': '가' * 3000}] * 3)
            before = list(app.runs.iterdir())
            with patch.object(app, '_launch') as launch:
                with self.assertRaisesRegex(u.UIError, '바이트'): app.start(cfg)
                launch.assert_not_called()
            cfg['submitted_cases'] = [{'answer': 'valid'}]
            with patch.object(d, 'bundle_files', return_value=('\n## 자료: (PBL)fixture.md\nL1: ' + '가' * 50000, [])), patch.object(app, '_launch') as launch:
                with self.assertRaisesRegex(u.UIError, '연구 시작 전 입력 검사'): app.start(cfg)
                launch.assert_not_called()
            self.assertEqual(list(app.runs.iterdir()), before)


if __name__ == '__main__': unittest.main()
