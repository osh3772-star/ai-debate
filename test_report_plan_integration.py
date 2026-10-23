"""Offline integration: saved records -> one consented moderator call, never a new debate."""
import copy
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import debate as d
import result_digest as rd
import ui_server as u
import test_course_guidance as fixtures


class ReportPlanIntegrationTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(d.subprocess, 'Popen', side_effect=AssertionError('REAL CLI FORBIDDEN'))
        guard.start(); self.addCleanup(guard.stop)
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.app = u.ControlApp(self.tmp.name, self.tmp.name); self.addCleanup(self.app.close)
        self.rid = '20261023-000000-research-reportplan'
        self.path = self.app.runs/self.rid; self.path.mkdir()
        self.state = fixtures.CourseGuidanceTests().full_state(version=3)
        self.state['agents'][1]['is_moderator'] = True
        d.dump(self.path/'debate.json', self.state)

    def response(self):
        preview = rd.overview(self.state)['report_plan']
        sections = []
        for s in preview['sections']:
            refs = [r['id'] for r in s['evidence'] if not r.get('status', '').startswith('수정 전')][:1]
            sections.append(dict(number=s['number'], points=['OFFLINE WRITING POINT'], evidence_ids=refs,
                                 assumptions=['OFFLINE ASSUMPTION'], unknowns=['OFFLINE INPUT NEEDED'], appendix_ids=[]))
        return json.dumps({'conclusion': {'headline': 'OFFLINE RECOMMENDATION', 'candidate_ids': ['S4A1.C1']},
            'report_plan': {'decision': {'candidate_id': 'S4A1.C1', 'recommendation': 'OFFLINE ACTION', 'why': 'OFFLINE REASON',
                'now': ['OFFLINE FIRST ACTION'], 'evidence_ids': ['S4A1.C1'],
                'conditions': [{'condition': 'OFFLINE CONDITION', 'check': 'OFFLINE CHECK', 'if_fail': 'OFFLINE FALLBACK'}]},
                'sections': sections}}, ensure_ascii=False)

    def test_reading_preview_and_document_never_writes_or_calls_a_model(self):
        original = (self.path/'debate.json').read_bytes()
        with patch.object(d, 'model_call', side_effect=AssertionError('read must not call models')):
            self.assertTrue(self.app.bootstrap()['report_plan_supported'])
            self.assertNotIn('report_writing_plan.md', u.REPORTS)
            self.assertIn('report_writing_plan.md', self.app.snapshot(self.rid)['available_reports'])
            view = self.app.snapshot(self.rid)['result_overview']['report_plan']
            document = self.app.report(self.rid, 'report_writing_plan.md')
        self.assertEqual([s['number'] for s in view['sections']], [1, 2, 3, 4, 5])
        self.assertIn('SECTION 5', document)
        self.assertEqual((self.path/'debate.json').read_bytes(), original)
        self.assertFalse((self.path/'report_writing_plan.md').exists(), 'read-only export is derived, not saved over originals')

    def test_one_consented_call_preserves_turns_models_and_saved_report(self):
        original = copy.deepcopy(self.state)
        with patch.object(d, 'model_call', side_effect=AssertionError('consent required')):
            with self.assertRaises(u.UIError): self.app.synthesize({'run': self.rid, 'report_plan': True})
        with patch.object(d, 'model_call', return_value=(self.response(), {'offline_fixture': True}, '')) as call:
            self.app.synthesize({'run': self.rid, 'approve_transfer': True, 'report_plan': True})
            self.app.active['thread'].join(timeout=15)
        self.assertEqual(call.call_count, 1)
        self.assertFalse(call.call_args.kwargs['settings']['web_research'])
        self.assertEqual(call.call_args.kwargs['settings']['name'], original['agents'][1]['name'])
        saved = json.loads((self.path/'debate.json').read_text(encoding='utf-8'))
        self.assertEqual([(t['id'], t['answer'], t['parsed']) for t in saved['turns']],
                         [(t['id'], t['answer'], t['parsed']) for t in original['turns']])
        self.assertEqual(saved['agents'], original['agents'])
        self.assertEqual(saved['syntheses'][-1]['prompt_version'], rd.SYNTHESIS_VERSION)
        self.assertEqual(saved['syntheses'][-1]['report_source_sha256'], rd.report_plan.source_digest(saved))
        plan = self.app.snapshot(self.rid)['result_overview']['report_plan']
        self.assertEqual(plan['mode'], 'generated')
        self.assertEqual(plan['decision']['candidate_id'], 'S4A1.C1')
        self.assertNotEqual(plan['status'], 'stale')
        self.assertIn('OFFLINE WRITING POINT', self.app.report(self.rid, 'report_writing_plan.md'))

    def test_quota_failure_does_not_retry_or_erase_the_debate(self):
        with patch.object(d, 'model_call', side_effect=d.ProviderError('OFFLINE QUOTA', 'rate_limit')) as call:
            self.app.synthesize({'run': self.rid, 'approve_transfer': True, 'report_plan': True})
            self.app.active['thread'].join(timeout=15)
        saved = json.loads((self.path/'debate.json').read_text(encoding='utf-8'))
        self.assertEqual(call.call_count, 1)
        self.assertFalse(saved.get('syntheses'))
        self.assertEqual(len(saved['turns']), len(self.state['turns']))
        self.assertEqual(saved['errors'][-1]['category'], 'rate_limit')
        self.assertTrue(self.app.snapshot(self.rid)['result_overview']['report_plan']['sections'])

    def test_essential_overflow_stops_before_a_call_without_dropping_final_conditions(self):
        final=next(t for t in self.state['turns'] if t['stage']=='revision')
        final['parsed']['decision']['conditions']=['필수실행조건'*30000]
        original=copy.deepcopy(self.state)
        with patch.object(d,'model_call',side_effect=AssertionError('overflow must not call')) as call:
            with self.assertRaises(d.ProviderError) as caught:d.run_synthesis(self.state,self.path)
        self.assertEqual(caught.exception.category,'context_limit')
        call.assert_not_called();self.assertEqual(self.state,original)

    def test_general_topic_cannot_be_sent_as_the_pbl_report(self):
        self.state['domain'] = 'general'; d.dump(self.path/'debate.json', self.state)
        with patch.object(d, 'model_call', side_effect=AssertionError('general topic must not call')):
            self.assertNotIn('report_writing_plan.md', self.app.snapshot(self.rid)['available_reports'])
            with self.assertRaises(u.UIError): self.app.report(self.rid, 'report_writing_plan.md')
            with self.assertRaises(u.UIError): self.app.synthesize({'run': self.rid, 'approve_transfer': True, 'report_plan': True})


if __name__ == '__main__': unittest.main()
