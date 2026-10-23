"""Offline course-guidance checks. Synthetic records are not actual AI findings; no model is called."""
import json
from pathlib import Path
import re
import tempfile
import unittest
from unittest.mock import patch

import context_plan as cp
import debate as d
import research_protocol as p
import result_digest as rd
import source_plan as sp
import ui_server as u

DRAFT = '나는 B를 고르겠다. 직원 일자리는 크게 걱정하지 않는다.'
ROOT = Path(__file__).resolve().parent
LEGALITY = [dict(item=name, question=f'{name} 처리는 원문상 허용되는가?', judgment='undetermined', basis='fixture.md:L1', uncertainty='관할·시점 미확인')
            for name in p.LEGALITY_ITEM_NAMES]


def notes(*ids):
    return [dict(requirement_id=rid, status='addressed', claim_ids=['S1A1.CLM1'], reason='OFFLINE NOTE') for rid in ids]


def synthetic_materials(big_b66=False):
    """A small bundle in the real file-name format; enough to exercise source packs without the course files."""
    files = {
        p.CASE: '# 넥서스AI\n가공매출 300억 원. 상장까지 6개월.\n| 쟁점 | 내용 |\n| --- | --- |\n| Repo | 분기 말 매각 후 분기 초 재매입 |\n',
        sp.KIFRS_FILES['K1115']: '# 제1115호\n### 문단 5 (적용범위)\n금융상품은 이 기준서의 적용범위에서 제외한다.\n\n### 문단 B66 (선도나 콜옵션)\n' +
                                  '기업이 자산을 다시 사야 하는 의무가 있다면 고객은 자산을 통제하지 못한다.\n' * (60 if big_b66 else 1) + '### 문단 B67 (화폐의 시간가치)\n다음 문단.\n* (⑵~⑷ 생략)\n',
        '6주차_PRE.md': '# 6주차\n6.2 부정의 3요소 심층 분석\n압박·기회·합리화.\n6.3 사기꾼의 레시피\n레시피 본문.\n6.4 회색지대의 악마들\n회색지대.\n학습 정리 및 점검\n끝.\n'}
    with tempfile.TemporaryDirectory() as tmp:
        folder = Path(tmp)
        for name, body in files.items(): (folder/name).write_text(body, encoding='utf-8')
        return d.bundle_files([folder/name for name in files])[0]


ORDER = ('independent', 'cross', 'rebuttal', 'alternatives', 'perspectives', 'professor', 'revision')


def synthetic_run(n, disposition, scale=0.5):
    """Whole-run records for n participants in which every review uses one disposition. Synthetic, not model answers."""
    s = lambda c: '가' * max(1, int(c * scale)); agents = [f'A{i}' for i in range(1, n + 1)]; turns = []
    def add(stage_no, a, stage, **parsed): turns.append(dict(id=f'S{stage_no}{a}', name=a, stage=stage, parsed=parsed))
    for a in agents:
        add(1, a, 'independent', claims=[dict(id=f'S1{a}.CLM{i}', claim=s(110), kind='task_fact', source='fixture.md:L1', status='확인', check=s(60)) for i in range(1, 9)],
            legality_checks=[dict(id=f'S1{a}.LQ{i}', item=x, question=s(60), judgment='undetermined', basis=s(80), uncertainty=s(50)) for i, x in enumerate(p.LEGALITY_ITEM_NAMES, 1)],
            candidate_seeds=[dict(id=f'S1{a}.SEED1', idea=s(80))], provisional_position=dict(position=s(100), change_conditions=s(100)), unresolved=[s(50)])
    for a in agents:
        targets = [f'S1{o}.{k}' for o in agents if o != a for k in [f'CLM{i}' for i in range(1, 9)] + [f'LQ{i}' for i in range(1, 5)]]
        add(2, a, 'cross', challenges=[dict(id=f'S2{a}.CH{j}', target_claim=t, target_turn=t.split('.')[0], quote=s(40), disposition=disposition, severity='normal',
                                            reason=s(100), evidence=s(60)) for j, t in enumerate(targets, 1)])
    for a in agents:
        mine = [c for t in turns if t['stage'] == 'cross' for c in t['parsed']['challenges'] if c['target_turn'] == f'S1{a}' and c['disposition'] != 'supports']
        add(3, a, 'rebuttal', responses=[dict(challenge_id=c['id'], disposition='부분 수용', reason=s(80), resolution='addressed', revised_claim=s(80)) for c in mine])
    for a in agents:
        add(4, a, 'alternatives', candidates=[dict(id=f'S4{a}.C{i}', proposal=s(150), issue_ids=[f'S1{a}.CLM{i}'], mechanism=s(80), residual_risk=s(50)) for i in (1, 2, 3)])
    for a in agents:
        add(5, a, 'perspectives', ethics_assessment=[dict(candidate_id=f'S4{a}.C1', utilitarian=s(80), deontological=s(80), communitarian=s(80), minority_burden=s(60))])
    for a in agents:
        others = [o for o in agents if o != a]
        add(6, a, 'professor', challenges=[dict(id=f'S6{a}.CH{j}', target_candidate=f'S4{o}.C1', target_turn=f'S4{o}', quote=s(40), disposition=disposition, reason=s(100),
                                                evidence=s(60)) for j, o in enumerate(others, 1)],
            review_assessment=dict(status='findings_present', checked_ids=[f'S4{o}.C1' for o in others], summary=s(120)))
    return agents, turns


def prior_turns(turns, k):
    """What the k-th stage sees, as phase_turns hands it over: earlier stages only, seeds hidden from cross and rebuttal."""
    prior = [json.loads(json.dumps(t, ensure_ascii=False)) for t in turns if t['stage'] in ORDER[:k]]
    if ORDER[k] in ('cross', 'rebuttal'):
        for t in prior:
            if t['stage'] == 'independent': t['parsed'].pop('candidate_seeds', None)
    return prior


class CourseGuidanceTests(unittest.TestCase):
    def setUp(self):
        guard = patch.object(d.subprocess, 'Popen', side_effect=AssertionError('REAL CLI FORBIDDEN'))
        guard.start(); self.addCleanup(guard.stop)

    def state(self, guided=True, version=None, **overrides):
        s = dict(version=3, protocol_version=3, review_policy_version=1, domain='accounting_pbl', mode='research',
                 topic='OFFLINE GUIDANCE FIXTURE', created=d.now(), status='created', timeout=30, offline_fixture=True,
                 agents=d.default_agents(2), turns=[], student_draft=DRAFT,
                 materials='\n## 자료: fixture.md\nL1: 가공매출 300억 원. 상장까지 6개월.\n')
        if guided: s['course_guidance_version'] = version or p.COURSE_GUIDANCE_VERSION
        s.update(overrides); return s

    def turn(self, tid, stage, **fields):
        t = dict(id=tid, stage=stage, stage_title=stage, name='OFFLINE '+tid[-2:], provider='codex', time=d.now(),
                 prompt='OFFLINE QUESTION', answer=json.dumps(fields, ensure_ascii=False),
                 parsed=d.normalize_answer(dict(analysis='OFFLINE ANALYSIS', **fields)))
        p.assign_ids(t); return t

    def full_state(self, candidate_fields=True, counter=True, version=1):
        """Version 1 is the saved-run contract; version 2 adds legality queries, requirement notes and stricter review records."""
        s = self.state(version=version); v2 = version >= 2
        extra = dict(a_downside='상장 실패 공포', b_downside='즉시 정정의 유동성 충격', mechanism='정정 공시와 브리지 자금',
                     residual_risk='일정 지연') if candidate_fields else {}
        for ai in (1, 2):
            s['turns'].append(self.turn(f'S1A{ai}', 'independent', claims=[dict(claim=f'가공매출 300억 원 {ai}', kind='task_fact', source='fixture.md:L1')],
                                        **(dict(legality_checks=[dict(x) for x in LEGALITY] + ([dict(LEGALITY[0], item=p.LEGALITY_OPTIONAL[0])] if ai == 1 else []),
                                                requirement_notes=notes('R6')) if v2 else {})))
        for ai in (1, 2):
            other = 3-ai
            checks = [dict(target_claim=f'S1A{other}.CLM1', target_turn=f'S1A{other}', quote=f'가공매출 300억 원 {other}', disposition='supports', reason='자료와 일치')]
            if v2:  # every required initial judgment of the other participant is checked against its exact wording
                checks += [dict(target_claim=f'S1A{other}.LQ{i}', target_turn=f'S1A{other}', quote=x['question'], disposition='supports', reason='판단 보류가 원문 범위와 맞음')
                           for i, x in enumerate(LEGALITY, 1)]
            s['turns'].append(self.turn(f'S2A{ai}', 'cross', challenges=checks,
                                        student_feedback=[dict(quote='직원 일자리는 크게 걱정하지 않는다', blind_spot='소수의 부담 누락', question='누가 비용을 지는가?')],
                                        **(dict(requirement_notes=notes('R2')) if v2 else {})))
        for ai in (1, 2):
            s['turns'].append(self.turn(f'S3A{ai}', 'rebuttal', report_plan=dict(sections=[dict(section='Section 1', claim_ids=['S1A1.CLM1'])])))
        for ai in (1, 2):
            s['turns'].append(self.turn(f'S4A{ai}', 'alternatives', candidates=[dict(proposal=f'후보 {ai}.{i}', issue_ids=['S1A1.CLM1'], **extra) for i in (1, 2, 3)],
                                        **(dict(requirement_notes=notes('R7', 'R8')) if v2 else {})))
        for ai in (1, 2):
            s['turns'].append(self.turn(f'S5A{ai}', 'perspectives', ethics_assessment=[dict(candidate_id='S4A1.C1', utilitarian='장기 손익', deontological='정직 의무',
                                                                                        communitarian='시장 신뢰', minority_burden='개인투자자')],
                                        **(dict(requirement_notes=notes('R3', 'R4', 'R5', 'R11')) if v2 else {})))
        for ai in (1, 2):
            other = 3-ai
            assessment = dict(status='no_material_defect', checked_ids=[f'S1A{other}.CLM1', f'S4A{other}.C1'], criteria=['Section 5 Kill Conditions'],
                              retained_reasons=['반례가 원안 가정에서 성립하지 않음'], scope_limitations=['제공 자료 범위'], summary='중대한 결함 없음')
            if counter:
                assessment['counterexample_checks'] = [dict(target_id=f'S4A{other}.C1', counterexample='경쟁사 선상장', sources='fixture.md:L1',
                                                            checked='확인', holds='no', outcome='no_material_defect', **(dict(scope='상장 일정 가정') if v2 else {}))]
            if v2: assessment['fact_checks'] = [dict(item='가공매출 300억 원', result='일치', source='fixture.md:L1')]
            s['turns'].append(self.turn(f'S6A{ai}', 'professor', review_assessment=assessment))
        for ai in (1, 2):
            s['turns'].append(self.turn(f'S7A{ai}', 'revision', decision=dict(status='conditional_recommendation', candidate_id='S4A1.C1',
                                        basis_claim_ids=['S1A1.CLM1'], conditions=['제공된 수치 가정'])))
        return s

    def test_prompts_follow_guidance_only_for_new_runs(self):
        s = self.state(); s['turns'] = self.full_state()['turns']
        independent, cross = d.build_prompt(s, 0, 0), d.build_prompt(s, 1, 0)
        for key in ('original_question', 'revised_question', 'lesson', 'error_type'): self.assertIn(key, independent)
        self.assertNotIn(DRAFT, independent, 'the student draft stays out of independent research')
        self.assertIn(DRAFT, cross); self.assertIn('student_feedback', cross)
        self.assertIn('report_plan', d.build_prompt(s, 2, 0))
        self.assertIn('a_downside', d.build_prompt(s, 3, 0))
        perspectives = d.build_prompt(s, 4, 0)
        for key in ('ethics_assessment', '공동체주의', '소수'): self.assertIn(key, perspectives)
        professor = d.build_prompt(s, 5, 0)
        for key in ('칭찬 금지', 'counterexample_checks', 'fact_checks', '최종 적대적 검토'): self.assertIn(key, professor)
        legacy = self.state(guided=False); legacy['turns'] = s['turns']
        self.assertIn('"audit":[]', d.get_base_prompt(legacy))
        self.assertNotIn(DRAFT, d.build_prompt(legacy, 1, 0))
        self.assertNotIn('counterexample_checks', d.build_prompt(legacy, 5, 0))
        self.assertEqual(d.run_plan(legacy)[5][1], '평가 기준 기반 최종 검토')

    def test_general_domain_keeps_balanced_review_without_accounting_fields(self):
        s = self.state(domain='general')
        names = [x[1] for x in d.run_plan(s)]
        self.assertIn('평가 기준 기반 최종 검토', names)
        self.assertNotIn('a_downside', ''.join(x[2] for x in d.run_plan(s)))
        self.assertFalse(p.planned(s))

    def test_complete_guided_record_can_reach_conditional_recommendation(self):
        s = self.full_state(); result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'conditional', result['blockers'])
        checks = result['guidance_checks']
        self.assertEqual(checks['report_plan_missing'], [])
        self.assertEqual(checks['candidate_field_gaps'], [])
        self.assertEqual(checks['ethics_gaps'], [])
        self.assertEqual(checks['student_feedback_unmatched'], [])
        self.assertNotIn('requirements', result, 'saved version 1 runs keep their recorded contract')

    def test_pass_verdict_without_counterexample_search_is_withheld(self):
        s = self.full_state(counter=False); result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'needs_review')
        self.assertTrue(any('반례 탐색 기록' in issue for issue in result['final_review_issues']))

    def test_counterexample_outcome_must_match_the_verdict(self):
        s = self.full_state()
        s['turns'][10]['parsed']['review_assessment']['counterexample_checks'][0]['outcome'] = 'defect_found'
        result = p.review(s, d.run_plan(s))
        self.assertTrue(any('반례 결과와 판정 불일치' in issue for issue in result['final_review_issues']))

    def test_selected_candidate_needs_both_downsides_addressed(self):
        s = self.full_state(candidate_fields=False); p.review(s, d.run_plan(s))
        self.assertIn('선정 후보의 A·B 단점 해소 기록 필요', s['turns'][-1]['protocol_checks']['reasons'])
        self.assertTrue(s['review_state']['guidance_checks']['candidate_field_gaps'])

    def test_fabricated_student_quote_is_flagged(self):
        s = self.full_state()
        s['turns'][2]['parsed']['student_feedback'][0]['quote'] = '학생이 쓰지 않은 문장'
        self.assertEqual(p.review(s, d.run_plan(s))['guidance_checks']['student_feedback_unmatched'], ['S2A1.SF1'])

    def test_outline_is_conclusion_first_with_note_candidates_and_appendix(self):
        s = self.full_state()
        s['turns'][2]['parsed']['audit'] = [dict(target_turn='S1A2', original_answer='가공매출 300억 원 2', error='OFFLINE ERROR',
                                                 error_type='기준서 왜곡', revised_question='고친 질문', lesson='문단 번호를 요구했다')]
        s['turns'][2]['answer'] = json.dumps(s['turns'][2]['parsed'], ensure_ascii=False)
        s['turns'][1]['answer'] = json.dumps(s['turns'][1]['parsed'], ensure_ascii=False)
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp); d.render(s, path)
            outline = (path/'report_outline.md').read_text(encoding='utf-8')
            self.assertLess(outline.index('0. 결론'), outline.index('1. S(전제)'))
            self.assertLess(outline.index('1. S(전제)'), outline.index('3. Q(핵심 질문)'))
            self.assertIn('[주석 1]', outline); self.assertIn('S1A1.CLM1', outline)
            self.assertIn('Section 2', outline); self.assertIn('부록 C', outline)
            self.assertNotIn('과제 요건 기록 대장', outline, 'version 1 outline is unchanged')
            appendix = (path/'ai_usage_appendix.md').read_text(encoding='utf-8')
            for text in ('> '+DRAFT, '소수의 부담 누락', '고친 질문', '문단 번호를 요구했다', '학생 학습 기록 (직접 작성)', 'AI 활용 내역'):
                self.assertIn(text, appendix)
            self.assertIn('S1A2', (path/'ai_audit.md').read_text(encoding='utf-8'))

    def test_legacy_outline_and_appendix_are_unchanged(self):
        s = self.full_state(); s.pop('course_guidance_version')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp); d.render(s, path)
            self.assertIn('S 상황', (path/'report_outline.md').read_text(encoding='utf-8'))
            self.assertNotIn('학생 학습 기록', (path/'ai_usage_appendix.md').read_text(encoding='utf-8'))

    def test_ui_saves_draft_and_marks_new_runs(self):
        with tempfile.TemporaryDirectory() as tmp:
            app = u.ControlApp(tmp, tmp); cfg = app.defaults(); cfg.update(approve_transfer=True, student_draft=DRAFT)
            with patch.object(app, '_launch'):
                rid = app.start(cfg)['run']
            stored = json.loads((app.runs/rid/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual(stored['course_guidance_version'], p.COURSE_GUIDANCE_VERSION)
            self.assertEqual(stored['quote_check_version'], p.QUOTE_CHECK_VERSION, 'new runs record the quote rule they are checked with')
            self.assertEqual(stored['student_draft'], DRAFT)
            snapshot = app.snapshot(rid)
            self.assertEqual(snapshot['course_guidance_version'], p.COURSE_GUIDANCE_VERSION)
            self.assertEqual(app.bootstrap()['course_guidance_version_supported'], p.COURSE_GUIDANCE_VERSION)
            self.assertTrue(app.bootstrap()['correction_edit_supported'])
            cfg['student_draft'] = 'X'*3001
            with self.assertRaises(u.UIError): app.validate_config(cfg)

    def test_ui_correction_requires_consent_matching_quote_and_runs_once(self):
        s = self.full_state()
        s['turns'][2]['parsed']['audit'] = [dict(target_turn='S1A2', original_answer='가공매출 300억 원 2', error='OFFLINE ERROR', revised_question='고친 질문')]
        with tempfile.TemporaryDirectory() as tmp:
            app = u.ControlApp(tmp, tmp); rid = '20261021-000000-research-offline'
            (app.runs/rid).mkdir(); d.dump(app.runs/rid/'debate.json', s)
            request = dict(run=rid, review_turn='S2A1', audit_index=0)
            with self.assertRaises(u.UIError): app.correct(request)
            with patch.object(d, 'model_call', return_value=('OFFLINE CORRECTED ANSWER', {'offline_fixture': True}, '')) as call:
                app.correct(dict(request, approve_transfer=True)); app.active['thread'].join(timeout=10)
                self.assertEqual(call.call_count, 1)
                saved = json.loads((app.runs/rid/'debate.json').read_text(encoding='utf-8'))
                self.assertEqual(saved['corrections'][0]['actual_answer'], 'OFFLINE CORRECTED ANSWER')
                self.assertEqual(saved['corrections'][0]['question_source'], 'ai_proposed')
                self.assertEqual(saved['turns'][1]['answer'], s['turns'][1]['answer'], 'the original turn is never edited')
                with self.assertRaises(u.UIError): app.correct(dict(request, approve_transfer=True))
                self.assertEqual(call.call_count, 1)
            self.assertIn('실제 수정 질문 재호출', (app.runs/rid/'debate_log.md').read_text(encoding='utf-8'))
            saved['turns'][2]['parsed']['audit'][0]['original_answer'] = '로그에 없는 인용'
            d.dump(app.runs/rid/'debate.json', saved)
            with self.assertRaises(u.UIError): app.correct(dict(request, approve_transfer=True))

    def test_v3_student_verdict_on_an_error_candidate_is_saved_without_a_model_call(self):
        s = self.full_state(version=3)
        s['turns'][2]['parsed']['audit'] = [dict(target_turn='S1A2', original_answer='가공매출 300억 원 2', error='OFFLINE ERROR', error_type='기준서 왜곡')]
        with tempfile.TemporaryDirectory() as tmp, patch.object(d, 'model_call', side_effect=AssertionError('no model call')) as call:
            app = u.ControlApp(tmp, tmp); rid = '20261023-000000-research-verdict'
            (app.runs/rid).mkdir(); d.dump(app.runs/rid/'debate.json', s)
            self.assertTrue(app.bootstrap()['audit_verdict_supported'])
            finding = app.snapshot(rid)['result_overview']['findings'][0]
            self.assertEqual((finding['key'], finding['tier']), ('S2A1#1', 'suspected'), 'no reply and no second AI: not red')
            for bad in (dict(key='S2A1#9', verdict='error'), dict(key='../x', verdict='error'), dict(key='S2A1#1', verdict='maybe')):
                with self.assertRaises(u.UIError): app.audit_verdict(dict(bad, run=rid))
            app.audit_verdict(dict(run=rid, key='S2A1#1', verdict='error', note='기준서 원문 확인'))
            saved = json.loads((app.runs/rid/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['audit_verdicts']['S2A1#1']['verdict'], 'error')
            self.assertEqual([(t['answer'], t['parsed']) for t in saved['turns']], [(t['answer'], t['parsed']) for t in s['turns']], 'AI records stay as saved')
            self.assertEqual(app.snapshot(rid)['result_overview']['findings'][0]['tier'], 'student_error')
            self.assertIn('학생 확인 · 오류', (app.runs/rid/'00_결과_요약.md').read_text(encoding='utf-8'))
            app.audit_verdict(dict(run=rid, key='S2A1#1', scope='in'))
            finding = app.snapshot(rid)['result_overview']['findings'][0]
            self.assertEqual((finding['step1'], finding['step1_source'], finding['verdict']['note']), (True, 'student', '기준서 원문 확인'), 'only the sent field changes')
            for bad in (dict(scope='maybe'), dict()):
                with self.assertRaises(u.UIError): app.audit_verdict(dict(bad, run=rid, key='S2A1#1'))
            app.audit_verdict(dict(run=rid, key='S2A1#1', verdict=None, scope=None, note=''))
            self.assertNotIn('S2A1#1', json.loads((app.runs/rid/'debate.json').read_text(encoding='utf-8'))['audit_verdicts'])
            self.assertEqual(call.call_count, 0)

    def test_v3_moderator_result_summary_is_an_explicit_call_over_saved_records_only(self):
        s = self.full_state(version=3); s['agents'][1]['is_moderator'] = True
        answer = json.dumps({'analysis': '근거', 'conclusion': {'headline': '후보 1을 조건부로 택한다', 'recommendation': '정정 후 상장', 'candidate_ids': ['S4A1.C1'], 'why': '반박 결과',
                             'conditions': [{'condition': '자금 확인', 'meaning': '돈이 있어야 함', 'how_to_check': '현금 계획'}]},
                             'candidates': [{'id': 'S4A1.C1', 'plain_name': '정정 먼저', 'what': '정정 후 상장'}]}, ensure_ascii=False)
        prompt = rd.synthesis_prompt(s, d.run_plan(s))
        self.assertLess(len(prompt.encode('utf-8')), rd.SYNTHESIS_BYTES)
        for part in ('"final_decisions"', '"candidates"', '"stages"', '결론을 반드시 하나로', '새 사실·수치'): self.assertIn(part, prompt)
        self.assertNotIn('"disposition":"supports"', prompt, 'agreements are counted, not sent one by one')
        with tempfile.TemporaryDirectory() as tmp:
            app = u.ControlApp(tmp, tmp); rid = '20261023-000000-research-synthesis'
            (app.runs/rid).mkdir(); d.dump(app.runs/rid/'debate.json', s)
            self.assertTrue(app.bootstrap()['synthesis_supported'])
            with patch.object(d, 'model_call', side_effect=AssertionError('no call without consent')):
                with self.assertRaises(u.UIError): app.synthesize(dict(run=rid))
            with patch.object(d, 'model_call', return_value=(answer, {'offline_fixture': True}, '')) as call:
                app.synthesize(dict(run=rid, approve_transfer=True)); app.active['thread'].join(timeout=10)
            self.assertEqual(call.call_count, 1)
            settings = call.call_args.kwargs['settings']
            self.assertEqual((call.call_args.args[0], settings['name'], settings['web_research']), (s['agents'][1]['provider'], s['agents'][1]['name'], False), 'the moderator, saved records only')
            saved = json.loads((app.runs/rid/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['syntheses'][-1]['parsed']['conclusion']['headline'], '후보 1을 조건부로 택한다')
            self.assertEqual([(t['answer'], t['parsed']) for t in saved['turns']], [(t['answer'], t['parsed']) for t in s['turns']], 'the debate turns are never edited')
            view = app.snapshot(rid)['result_overview']['synthesis']
            self.assertEqual((view['agent'], view['failed'], view['stale'], view['parsed']['conclusion']['conditions'][0]['how_to_check']),
                             (s['agents'][1]['name'], False, False, '현금 계획'), 'the program re-checking the turns does not make the summary stale')
            self.assertIn('후보 1을 조건부로 택한다', (app.runs/rid/'00_결과_요약.md').read_text(encoding='utf-8'))
        self.assertEqual(rd.parse_synthesis('설명\n```json\n' + answer + '\n```')['conclusion']['why'], '반박 결과')
        self.assertTrue(rd.parse_synthesis('JSON이 아닌 글')['_failed'])

    def test_quote_check_version_2_reads_the_reviewed_records_meaningful_fields_and_saved_runs_keep_version_1(self):
        s = self.full_state(version=3); lq = s['turns'][1]['parsed']['legality_checks'][0]; lq['uncertainty'] = 'UNCERTAINTY_ONLY_TEXT'
        ch = next(c for c in s['turns'][2]['parsed']['challenges'] if c['target_claim'] == 'S1A2.LQ1'); ch.update(quote='UNCERTAINTY_ONLY_TEXT', disposition='challenge')
        objects = p.record_objects(s['turns'])
        self.assertEqual((p.challenge_problem(ch, s['turns'][2], objects, 1), p.challenge_problem(ch, s['turns'][2], objects, 2)), ('quote_mismatch', None))
        self.assertEqual(p.quote_field('UNCERTAINTY_ONLY_TEXT', lq), 'uncertainty')
        ch['quote'] = s['turns'][2]['id']  # an ID or another record's words never count
        self.assertEqual(p.challenge_problem(ch, s['turns'][2], objects, 2), 'quote_mismatch')
        ch['quote'] = 'UNCERTAINTY_ONLY_TEXT'
        self.assertNotIn('quote_check_version', s)
        self.assertIn(ch['id'], p.review(s, d.run_plan(s))['invalid_references'], 'a saved run is judged with the rule it was checked with')
        before = json.dumps(s, ensure_ascii=False, sort_keys=True)
        recheck = rd.overview(s, s['review_state'], d.run_plan(s))['recheck']
        self.assertEqual((recheck['from_version'], recheck['to_version'], recheck['newly_valid'], recheck['by_field'][0]['field']), (1, 2, 1, 'uncertainty'))
        self.assertEqual(recheck['after']['invalid_references'], recheck['before']['invalid_references'] - 1)
        self.assertEqual(json.dumps(s, ensure_ascii=False, sort_keys=True), before, 'the re-check runs on a copy')
        s['quote_check_version'] = p.QUOTE_CHECK_VERSION
        self.assertNotIn(ch['id'], p.review(s, d.run_plan(s))['invalid_references'])
        self.assertIsNone(rd.overview(s, s['review_state'], d.run_plan(s))['recheck'], 'a run checked with the current rule needs no re-check')

    # Version 2: stage source packs, the requirement register, the initial legality query and stricter review records.

    def test_v2_prompts_carry_legality_query_requirement_owners_and_steelman(self):
        s = self.state(version=2); s['turns'] = self.full_state(version=2)['turns']
        independent = d.build_prompt(s, 0, 0)
        for key in ('legality_checks', '"judgment":"permitted|not_permitted|undetermined"', '급행료 처리', 'R6(', 'requirement_notes', '[필수 근거 묶음'):
            self.assertIn(key, independent)
        cross = d.build_prompt(s, 1, 0)
        for key in ('LQ ID', 'R2(', '용어 대응표'): self.assertIn(key, cross)
        professor = d.build_prompt(s, 5, 0)
        for key in ('Steelman Pre-Mortem', 'sources·checked·scope·holds', 'fact_check_note'): self.assertIn(key, professor)
        self.assertIn('Steelman 반론에 대한 방어', d.build_prompt(s, 6, 0))
        v1 = self.state(version=1); v1['turns'] = s['turns']
        for key in ('legality_checks', 'requirement_notes', 'Steelman', '[필수 근거 묶음'): self.assertNotIn(key, d.build_prompt(v1, 0, 0) + d.build_prompt(v1, 5, 0))
        self.assertNotIn('deliveries', v1)

    def test_v2_prompt_delivers_whole_issue_units_and_records_what_was_sent(self):
        s = self.state(version=2, materials=synthetic_materials())
        prompt = d.build_prompt(s, 0, 0); delivery = s['deliveries']['S1A1']
        self.assertEqual(delivery['case_file'], p.CASE)
        self.assertIn('K1115:5', delivery['units']); self.assertNotIn('K1115:B66', delivery['units'], 'only issue units go to independent research')
        self.assertIn({'id': 'K1109:3.2.6', 'reason': '선택 자료에 없음'}, delivery['omitted'])
        self.assertEqual(delivery['lectures'], ['W6-부정의 3요소', 'W6-사기 레시피'])
        self.assertIn('L2: 가공매출 300억 원. 상장까지 6개월.', prompt, 'case lines keep their original numbers')
        self.assertIn('L5: Repo 분기 말 매각 후 분기 초 재매입', prompt)
        self.assertIn('L3: 금융상품은 이 기준서의 적용범위에서 제외한다.', prompt)
        self.assertEqual(delivery['sha256'], sp.digest(prompt.split('\n자료:\n', 1)[1].split('\n검증자료', 1)[0]))

    def test_v2_cited_paragraph_is_whole_and_an_unfit_unit_is_listed_not_cut(self):
        materials = synthetic_materials(big_b66=True)
        unit = sp.kifrs_units(sp.sections(materials))['K1115:B66']
        shared = 'S1A1 주장: 제1115호 문단 B66에 따라 재매입 약정은 통제 이전이 아니다.'
        text, manifest, _ = sp.pack(materials, 'rebuttal', 100000, shared)
        self.assertEqual(manifest['units'], ['K1115:B66']); self.assertIn(sp.render(unit), text)
        text, manifest, _ = sp.pack(materials, 'rebuttal', 2500, shared)
        self.assertEqual(manifest['case_file'], p.CASE)
        self.assertIn({'id': 'K1115:B66', 'reason': '입력 한도'}, manifest['omitted'])
        self.assertIn('[필수 근거 누락 · 입력 한도] K1115:B66', text)
        self.assertNotIn(unit['rows'][1][1], text, 'a unit that does not fit is never cut into a partial excerpt')

    def test_v2_execute_saves_delivery_on_the_turn_and_in_the_log(self):
        s = self.state(version=2, materials=synthetic_materials())
        with tempfile.TemporaryDirectory() as tmp, patch.object(d, 'model_call', return_value=(json.dumps({'analysis': 'OFFLINE'}), {'offline_fixture': True}, '')) as call:
            run = Path(tmp); d.execute(s, run, max_turns=1)
            log = (run/'debate_log.md').read_text(encoding='utf-8'); outline = (run/'report_outline.md').read_text(encoding='utf-8')
        self.assertEqual(call.call_count, 1)
        delivery = s['turns'][0]['delivery']
        self.assertEqual((delivery['stage'], delivery['case_file']), ('independent', p.CASE))
        self.assertIn('이번 발언에 실제 전달된 근거', log); self.assertIn('K1115:5', log)
        self.assertIn('K1109:3.2.6', s['review_state']['unselected_sources'], 'a required paragraph the student did not select is reported for the run')
        self.assertIn('선택 자료에 없어 전달하지 못한 필수 근거', outline)

    def test_v2_complete_record_reaches_conditional_and_fills_register(self):
        s = self.full_state(version=2); result = p.review(s, d.run_plan(s))
        self.assertEqual(result['status'], 'conditional', result['blockers'])
        self.assertEqual(result['final_review_issues'], [])
        rows = {r['id']: r for r in result['requirements']}
        self.assertEqual(sorted(rows, key=lambda x: int(x[1:])), [f'R{i}' for i in range(1, 14)])
        self.assertEqual({r['status'] for r in rows.values()}, {'recorded'}, [(r['id'], r['status'], r['note']) for r in rows.values()])
        self.assertEqual(len(p.LEGALITY_ITEM_NAMES), 4, "STEP 1 asks about the '4대 회계처리' (case L87, rubric L178~L180)")
        self.assertEqual([x['status'] for x in rows['R1']['parts']], ['recorded', 'recorded', 'info'])
        self.assertIn('4대 회계처리의 완성 기록 8건', rows['R1']['note']); self.assertIn('8/8건', rows['R1']['note'])
        self.assertIn('S1A1.LQ5', rows['R1']['links'], 'the optional fifth item is linked but not required')
        self.assertEqual(result['assignment_record']['counts'], {'recorded': 13})
        self.assertIn('점수를 보증하지 않음', result['assignment_record']['scope'])
        self.assertEqual((result['delivery_omissions'], result['unselected_sources']), ([], []))
        self.assertEqual(result['invalid_references'], [], 'a legality judgment can be reviewed by ID and exact quote')

    def test_v2_register_reports_partial_legality_unknown_links_and_due_stages(self):
        s = self.full_state(version=2)
        s['turns'][1]['parsed']['legality_checks'] = s['turns'][1]['parsed']['legality_checks'][:3]
        s['turns'][2]['parsed']['requirement_notes'][0]['claim_ids'] = ['S9A9.CLM9']
        rows = {r['id']: r for r in p.review(s, d.run_plan(s))['requirements']}
        self.assertEqual(rows['R1']['status'], 'partial'); self.assertIn('S1A2 미완성: 빅배스', rows['R1']['note'])
        self.assertNotIn('급행료', rows['R1']['note'], 'the optional item is never reported as missing')
        self.assertEqual(rows['R2']['status'], 'needs_check'); self.assertIn('S9A9.CLM9', rows['R2']['note'])
        early = self.full_state(version=2); early['turns'] = early['turns'][:2]
        rows = {r['id']: r for r in p.review(early, d.run_plan(early))['requirements']}
        self.assertEqual((rows['R1']['status'], rows['R2']['status'], rows['R10']['status']), ('partial', 'not_due', 'not_due'))
        self.assertEqual([x['status'] for x in rows['R1']['parts']], ['recorded', 'not_due', 'info'], 'the cross-check part waits for its stage')

    def test_v2_r1_separates_initial_record_cross_check_and_error_candidates(self):
        s = self.full_state(version=2)
        for t in s['turns']:
            if t['stage'] == 'cross': t['parsed']['challenges'] = [c for c in t['parsed']['challenges'] if '.LQ' not in c['target_claim']]
        r1 = p.review(s, d.run_plan(s))['requirements'][0]
        self.assertEqual((r1['status'], [x['status'] for x in r1['parts']]), ('partial', ['recorded', 'missing', 'info']), 'no cross-check is not a complete R1')
        for t in s['turns']:
            for c in t['parsed'].get('legality_checks', []):
                for key in ('question', 'basis', 'uncertainty'): c.pop(key)
        r1 = p.review(s, d.run_plan(s))['requirements'][0]
        self.assertEqual((r1['status'], r1['parts'][0]['status']), ('partial', 'partial'), 'a judgment without its question and basis is incomplete')
        s = self.full_state(version=2)
        for ch in s['turns'][2]['parsed']['challenges']:
            if '.LQ' in ch['target_claim']: ch['quote'] = '원문에 없는 인용'
        s['turns'][2]['parsed']['audit'] = [dict(target_turn='S1A2', original_answer='가공매출 300억 원 2', error='OFFLINE ERROR', revised_question='고친 질문')]
        result = p.review(s, d.run_plan(s)); r1 = result['requirements'][0]
        self.assertIn('4/8건', r1['note'], 'a review whose quote does not match the judgment is not counted')
        self.assertTrue(result['invalid_references'])
        self.assertIn('인용이 맞는 오류 후보 1건 · 실제 재호출 0건', r1['note'])

    def test_v2_initial_legality_judgments_reach_the_auditing_stage(self):
        s = self.full_state(version=2)
        s['turns'][1]['parsed']['legality_checks'][0].update(question='UNIQUE_LQ_QUESTION', basis='UNIQUE_LQ_BASIS')
        cross = d.build_prompt(s, 1, 0)
        for text in ('S1A2.LQ1', 'UNIQUE_LQ_QUESTION', 'UNIQUE_LQ_BASIS'): self.assertIn(text, cross)
        for stage in (2, 3): self.assertNotIn('UNIQUE_LQ_QUESTION', d.build_prompt(s, stage, 1), 'later shared records stay small')

    def test_v2_a_held_back_unit_never_returns_in_part_through_auxiliary_excerpts(self):
        materials = synthetic_materials(big_b66=True); unit = sp.kifrs_units(sp.sections(materials))['K1115:B66']
        shared = 'S1A1 주장: 제1115호 문단 B66에 따라 재매입 약정을 검토한다.'
        for budget in (4000, 6000):
            text, delivery = d.planned_materials({'materials': materials}, 'rebuttal', budget, shared)
            self.assertIn({'id': 'K1115:B66', 'reason': '입력 한도'}, delivery['omitted'])
            self.assertNotIn(unit['rows'][1][1], text, f'budget {budget}: an omitted unit is not excerpted in part')
        text, delivery = d.planned_materials({'materials': materials}, 'rebuttal', 8000, shared)
        self.assertEqual(delivery['units'], ['K1115:B66']); self.assertIn(sp.render(unit), text)

    def test_v2_cited_ranges_and_lists_resolve_and_excerpted_paragraphs_are_marked(self):
        units = sp.kifrs_units(sp.sections(synthetic_materials()))
        self.assertEqual(sp.cited_units('제1115호 문단 B66~B67을 근거로', units), ['K1115:B66', 'K1115:B67'])
        self.assertEqual(sp.cited_units('제1115호 문단 5, B67', units), ['K1115:5', 'K1115:B67'])
        self.assertEqual(sp.cited_units('제1115호 문단 50', units), [], 'a longer number never matches a shorter paragraph')
        self.assertTrue(sp.abridged(units['K1115:B67'])); self.assertFalse(sp.abridged(units['K1115:5']))
        self.assertIn('발췌(생략 표시된 하위 항목은 원문 미제공)', sp.render(units['K1115:B67']))
        text, manifest, _ = sp.pack(synthetic_materials(), 'rebuttal', 100000, '제1115호 문단 B67')
        self.assertEqual((manifest['units'], manifest['abridged']), (['K1115:B67'], ['K1115:B67']))
        self.assertNotIn('원문 전체이며', text, 'the pack never calls an excerpt the whole paragraph')

    def test_v2_modes_without_an_owner_stage_say_so_and_quick_tests_keep_the_old_path(self):
        s = self.full_state(version=2); s['mode'] = 'consensus'; s['turns'] = s['turns'][:2]
        rows = {r['id']: r for r in p.review(s, d.run_plan(s))['requirements']}
        for rid in ('R3', 'R4', 'R5', 'R11', 'R13'):
            self.assertEqual(rows[rid]['status'], 'missing'); self.assertIn('담당 단계가 없음', rows[rid]['note'])
        smoke = self.state(version=2, mode='smoke', materials=synthetic_materials())
        self.assertFalse(p.planned(smoke)); d.build_prompt(smoke, 0, 0)
        self.assertNotIn('deliveries', smoke)

    def test_v2_counterexample_and_fact_check_records_are_strict(self):
        cases = [(lambda c, a: c.pop('scope'), '반례의 근거·확인 여부·범위·성립 여부 기록 필요'),
                 (lambda c, a: c.update(holds='assumption_changed'), '바뀐 가정 기록 필요'),
                 (lambda c, a: c.update(checked='미확인'), '확인하지 못한 반례를 확정 결과로 판정함'),
                 (lambda c, a: a.pop('fact_checks'), '사실 확인 기록 또는 확인할 사실이 없는 이유 필요'),
                 (lambda c, a: a.update(fact_checks=[dict(item='수치')]), '사실 확인 기록 형식 확인 필요')]
        for change, issue in cases:
            s = self.full_state(version=2); a = s['turns'][10]['parsed']['review_assessment']; change(a['counterexample_checks'][0], a)
            result = p.review(s, d.run_plan(s))
            self.assertEqual(result['status'], 'needs_review', issue)
            self.assertTrue(any(issue in x for x in result['final_review_issues']), (issue, result['final_review_issues']))
        s = self.full_state(version=2); a = s['turns'][10]['parsed']['review_assessment']
        a['counterexample_checks'][0].update(checked='미확인', sources='원문 미제공: 경쟁사 상장 일정', outcome='premise_unverified')
        a.pop('fact_checks'); a['fact_check_note'] = '이번 검토에서 확인할 수치 없음'
        self.assertEqual(p.review(s, d.run_plan(s))['final_review_issues'], [], 'an honestly unverified counterexample is recorded, not penalised')

    def test_v2_outline_has_register_terms_and_log_lists_delivery(self):
        s = self.full_state(version=2)
        s['turns'][0]['delivery'] = dict(source_plan=1, stage='independent', case_file=p.CASE, units=['K1115:5'], lectures=[],
                                        omitted=[{'id': 'K1037:19', 'reason': '입력 한도'}], auxiliary_lines={}, bytes=1, sha256='OFFLINE')
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp); d.render(s, path)
            outline = (path/'report_outline.md').read_text(encoding='utf-8'); log = (path/'debate_log.md').read_text(encoding='utf-8')
        for text in ('과제 요건 기록 대장', '|R1|', '|R13|', '기록 있음', '과제·강의 용어 대응', '책임 전가', '- S1A1: K1037:19'): self.assertIn(text, outline)
        self.assertIn('이번 발언에 실제 전달된 근거', log); self.assertIn('K1037:19(입력 한도)', log)

    def test_v2_student_edited_correction_keeps_proposal_reason_and_units_apart(self):
        s = self.full_state(version=2); s['materials'] += synthetic_materials()
        s['turns'][2]['parsed']['audit'] = [dict(target_turn='S1A2', original_answer='가공매출 300억 원 2', error='OFFLINE ERROR', revised_question='AI 질문')]
        with tempfile.TemporaryDirectory() as tmp, patch.object(d, 'model_call', return_value=('OFFLINE ANSWER', {'offline_fixture': True}, '')) as call:
            run = Path(tmp)
            with self.assertRaisesRegex(ValueError, '이유'): d.run_correction(s, run, 'S2A1', 0, question='학생 질문')
            with self.assertRaisesRegex(ValueError, '찾을 수 없습니다'): d.run_correction(s, run, 'S2A1', 0, question='학생 질문', reason='이유', extra_units=['K1115:B99'])
            with self.assertRaisesRegex(ValueError, '6개'): d.run_correction(s, run, 'S2A1', 0, extra_units=[f'K1115:{i}' for i in range(7)])
            self.assertEqual(call.call_count, 0)
            record = d.run_correction(s, run, 'S2A1', 0, question='학생 질문', reason='문단 번호부터 확인하게 바꿈', extra_units=['K1115:B66'])
            prompt = call.call_args[0][1]
            appendix = (run/'ai_usage_appendix.md').read_text(encoding='utf-8')
        for text in ('학생 질문', '문단 번호부터 확인하게 바꿈', '### [K1115:B66]', '기업이 자산을 다시 사야 하는 의무가'): self.assertIn(text, prompt)
        self.assertEqual((record['question_source'], record['ai_revised_question'], record['student_reason'], record['extra_units']),
                         ('student_edited', 'AI 질문', '문단 번호부터 확인하게 바꿈', ['K1115:B66']))
        self.assertEqual(record['revised_question'], '학생 질문')
        self.assertIn('학생 질문 (이유: 문단 번호부터 확인하게 바꿈)', appendix); self.assertIn(record['id'], appendix)

    def test_v2_ui_correction_validates_student_edit_and_lists_units(self):
        s = self.full_state(version=2); s['materials'] += synthetic_materials()
        s['turns'][2]['parsed']['audit'] = [dict(target_turn='S1A2', original_answer='가공매출 300억 원 2', error='OFFLINE ERROR', revised_question='AI 질문')]
        with tempfile.TemporaryDirectory() as tmp:
            app = u.ControlApp(tmp, tmp); rid = '20261021-000000-research-offline'
            (app.runs/rid).mkdir(); d.dump(app.runs/rid/'debate.json', s)
            units = app.source_units(rid)
            self.assertEqual([x['id'] for x in units['units']], ['K1115:5', 'K1115:B66', 'K1115:B67']); self.assertEqual(units['max'], 6)
            base = dict(run=rid, review_turn='S2A1', audit_index=0, approve_transfer=True)
            with patch.object(d, 'model_call', return_value=('OFFLINE ANSWER', {'offline_fixture': True}, '')) as call:
                for bad in (dict(question='학생 질문'), dict(question='학생 질문', reason='이유', extra_units=['K1115:B99']),
                            dict(extra_units=['K1115:B66; rm']), dict(extra_units='K1115:B66'), dict(question='', reason='이유')):
                    with self.assertRaises(u.UIError, msg=str(bad)): app.correct(dict(base, **bad))
                edited = dict(base, question='학생 질문', reason='이유', extra_units=['K1115:B66'])
                app.correct(edited); app.active['thread'].join(timeout=10)
                with self.assertRaises(u.UIError) as repeat: app.correct(edited)
                self.assertEqual(repeat.exception.status, 409)
                app.correct(base); app.active['thread'].join(timeout=10)
                self.assertEqual(call.call_count, 2)
            saved = json.loads((app.runs/rid/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual([c['question_source'] for c in saved['corrections']], ['student_edited', 'ai_proposed'])
            self.assertEqual(saved['events'][-1]['question_source'], 'ai_proposed')

    # Version 3: role-based shared records and the retrieval of unverified premises.

    def test_v3_responder_gets_the_whole_target_judgment_even_from_a_partial_quote(self):
        s = self.full_state(version=3)
        lq = s['turns'][1]['parsed']['legality_checks'][0]; lq.update(basis='UNIQUE_LQ_BASIS', uncertainty='UNIQUE_LQ_UNCERTAINTY')
        ch = next(c for c in s['turns'][2]['parsed']['challenges'] if c['target_claim'] == 'S1A2.LQ1')
        ch.update(disposition='challenge', quote=lq['question'][:6], reason='UNIQUE_CHALLENGE_REASON')
        owner = d.build_prompt(s, 2, 1)
        for text in ('UNIQUE_LQ_BASIS', 'UNIQUE_LQ_UNCERTAINTY', 'UNIQUE_CHALLENGE_REASON', '역할별 공유 기록'): self.assertIn(text, owner)
        self.assertNotIn('UNIQUE_LQ_BASIS', d.build_prompt(s, 2, 0), 'another participant does not need that judgment to answer its own reviews')
        shared = s['deliveries']['S3A2']['shared_record']
        self.assertEqual((shared['policy'], shared['stage'], shared['participant']), (cp.POLICY, 'rebuttal', 'A2'))
        self.assertTrue({'S1A2.LQ1', ch['id']} <= set(shared['full']))
        self.assertEqual(p.review(s, d.run_plan(s))['invalid_references'], [], 'the partial quote is a valid review')

    def test_v3_four_and_five_participants_keep_what_must_be_answered_in_full(self):
        for n in (4, 5):
            for disposition in ('supports', 'challenge', 'unverified'):
                agents, turns = synthetic_run(n, disposition)
                for k, stage in enumerate(ORDER[1:], 1):
                    prior = prior_turns(turns, k)
                    for a in agents:
                        text, manifest = cp.compose(prior, stage, a, final=stage == 'revision')
                        self.assertLessEqual(manifest['bytes'], cp.CAP)
                        if stage == 'cross':
                            must = {f'S1{o}.{x}' for o in agents if o != a for x in [f'CLM{i}' for i in range(1, 9)] + [f'LQ{i}' for i in range(1, 5)]}
                        elif stage in ('rebuttal', 'revision') and disposition != 'supports':
                            source = 'cross' if stage == 'rebuttal' else 'professor'
                            must = {c['id'] for t in prior if t['stage'] == source for c in t['parsed']['challenges'] if c['target_turn'].endswith(a)}
                        else: must = set()
                        self.assertTrue(must <= set(manifest['full']), (n, disposition, stage, a, sorted(must - set(manifest['full']))[:3]))
                        if stage == 'rebuttal' and a == 'A1':
                            self.assertEqual(cp.compose(prior, stage, a), (text, manifest), 'the same records give the same input on resume')

    def test_v3_review_status_does_not_depend_on_what_each_call_received(self):
        s = self.full_state(version=3)
        def summary():
            r = p.review(s, d.run_plan(s))
            return (r['status'], r['recorded_reviews'], r['pending_challenges'], r['final_withheld'], [x['status'] for x in r['requirements']])
        before = summary()
        for stage in range(1, 7):
            for agent in (0, 1): d.build_prompt(s, stage, agent)
        self.assertEqual(summary(), before)

    def test_v3_required_records_over_the_hard_cap_pause_before_the_call(self):
        s = self.full_state(version=3); s['turns'] = s['turns'][:2]
        s['turns'][1]['parsed']['claims'][0]['claim'] = '가' * 22000
        with self.assertRaisesRegex(d.InputPause, '64,000'): d.build_prompt(s, 1, 0)
        with tempfile.TemporaryDirectory() as tmp, patch.object(d, 'model_call', side_effect=AssertionError('no call after a pause')) as call:
            d.execute(s, Path(tmp))
        self.assertEqual((s['status'], len(s['turns']), call.call_count), ('paused', 2, 0))
        self.assertEqual(s['errors'][-1]['category'], 'context_pause'); self.assertIn('잘라 보내지 않았고', s['errors'][-1]['error'])

    def test_v3_only_a_call_that_cannot_fit_gets_a_larger_budget(self):
        ordinary = self.full_state(version=3); d.build_prompt(ordinary, 4, 0); delivery = ordinary['deliveries']['S5A1']
        self.assertEqual((delivery['prompt_budget'], delivery['stretched'], delivery['shared_record']['cap']), (d.MAX_PROMPT_BYTES, False, cp.CAP))
        over_soft = self.full_state(version=3); over_soft['turns'] = over_soft['turns'][:2]
        over_soft['turns'][1]['parsed']['claims'][0]['claim'] = 'LONG_CLAIM ' + '가' * 16500
        prompt = d.build_prompt(over_soft, 1, 0); delivery = over_soft['deliveries']['S2A1']
        self.assertIn('LONG_CLAIM', prompt, 'required records over 48KB are sent whole instead of pausing')
        self.assertEqual((delivery['shared_record']['cap'], delivery['prompt_budget'], delivery['stretched']), (cp.HARD_CAP, d.MAX_PROMPT_BYTES, False), 'no growth while everything fits 105KB')
        lecture = '\n'.join(f'L{n}: ' + '나' * 1000 for n in range(2, 14))  # a 36KB required lecture range for the cross stage
        heavy = self.full_state(version=3); heavy['turns'] = heavy['turns'][:2]
        heavy['turns'][1]['parsed']['claims'][0]['claim'] = 'LONG_CLAIM ' + '가' * 16500
        heavy['materials'] += f'\n## 자료: 3주차_PRE (1).md\nL1: 3.3.2 주요 합리화 유형 분석\n{lecture}\nL14: 3.4 합리화에 맞서는 방법\n'
        prompt = d.build_prompt(heavy, 1, 0); delivery = heavy['deliveries']['S2A1']
        self.assertTrue(delivery['stretched']); self.assertGreater(delivery['prompt_budget'], d.MAX_PROMPT_BYTES)
        self.assertLessEqual(len(prompt.encode('utf-8')), delivery['prompt_budget']); self.assertLessEqual(delivery['prompt_budget'], d.STRETCH_PROMPT_BYTES)
        self.assertIn('W3-합리화 4유형', delivery['lectures'], 'the required lecture range still goes whole')
        self.assertNotIn('입력 한도', json.dumps(delivery['omitted'], ensure_ascii=False))
        required = cp.compose(p.phase_turns(heavy, 'cross', d.run_plan(heavy)), 'cross', 'A1', False, room=0, cap=cp.HARD_CAP)[1]
        self.assertEqual(delivery['shared_record']['sha256'], required['sha256'], 'the added room is spent on required records and sources only')
        self.assertIn('질문 한도', d.delivery_text(delivery))

    def test_v3_each_unverified_premise_on_the_choice_is_linked_to_how_it_was_handled(self):
        def flagged(s):
            p.review(s, d.run_plan(s)); return [r for r in s['turns'][12]['protocol_checks']['reasons'] if r.startswith(p.PREMISE_LINK)]
        def case(version, **handling):
            s = self.full_state(version=version)
            s['turns'][11]['parsed']['review_assessment']['counterexample_checks'][0].update(checked='미확인', sources='원문 미제공: 경쟁사 상장 일정', outcome='premise_unverified')
            for t in s['turns'][12:]:
                decision = t['parsed']['decision']; decision['conditions'] = ['보고서 파일 이름을 다시 확인한다', '경쟁사 상장 일정이 확인될 때까지 조건부로 유지한다']
                if handling: decision['premise_handling'] = [dict(premise_id='S6A2.CX1', **handling)]
            return s
        self.assertEqual(self.full_state(version=3)['turns'][11]['parsed']['review_assessment']['counterexample_checks'][0]['id'], 'S6A2.CX1')
        self.assertEqual(flagged(case(3)), [p.PREMISE_LINK + ' (S6A2.CX1)'], 'an unrelated condition alone does not carry the premise')
        self.assertEqual(flagged(case(3, handling='condition', text='경쟁사 상장 일정이 확인될 때까지 조건부로 유지한다')), [])
        self.assertTrue(flagged(case(3, handling='condition', text='목록에 없는 조건')), 'the linked condition must be one of the listed conditions')
        self.assertEqual(flagged(case(3, handling='not_core', reason='상장 일정은 C의 실행 장치와 무관하다')), [])
        self.assertTrue(flagged(case(3, handling='not_core')), 'setting a premise aside needs a reason')
        withheld = case(3, handling='withheld', text='경쟁사 일정 미확인')
        for t in withheld['turns'][12:]: t['parsed']['decision']['blockers'] = ['경쟁사 일정 미확인']
        self.assertEqual(flagged(withheld), []); self.assertEqual(withheld['turns'][12]['protocol_checks']['decision_status'], 'withheld')
        self.assertEqual(flagged(case(2)), [], 'saved version 2 runs keep their rules')
        self.assertIn('premise_handling', d.run_plan(self.state(version=3))[-1][2])
        self.assertIn('premise_handling', d.build_prompt(self.full_state(version=3), 6, 0))
        self.assertNotIn('premise_handling', d.run_plan(self.state(version=2))[-1][2])

    def test_v3_critical_objection_between_others_and_claim_revisions_reach_every_stage_judging_the_candidate(self):
        agents, turns = synthetic_run(4, 'challenge')
        critical = next(c for t in turns if t['id'] == 'S2A4' for c in t['parsed']['challenges'] if c['target_claim'] == 'S1A3.CLM1')
        critical.update(severity='critical', reason='CRITICAL_OBJECTION_SENTINEL')
        rebuttal = next(t for t in turns if t['id'] == 'S3A3')
        rebuttal['parsed']['responses'] = [r for r in rebuttal['parsed']['responses'] if r['challenge_id'] != critical['id']]
        revision = next(r for r in rebuttal['parsed']['responses'] if r['challenge_id'].startswith('S2A2.') and r['challenge_id'] in
                        {c['id'] for t in turns if t['id'] == 'S2A2' for c in t['parsed']['challenges'] if c['target_claim'] == 'S1A3.CLM1'})
        revision['revised_claim'] = 'REVISED_CLAIM_SENTINEL'
        for k, stage in enumerate(ORDER[1:], 1):
            if stage not in ('alternatives', 'perspectives', 'professor', 'revision'): continue
            text, manifest = cp.compose(prior_turns(turns, k), stage, 'A1', final=stage == 'revision')
            self.assertIn(critical['id'], manifest['full'], stage); self.assertIn('CRITICAL_OBJECTION_SENTINEL', text, stage)
            if stage != 'alternatives': self.assertIn('REVISED_CLAIM_SENTINEL', text, f'{stage}: the claim as revised, not only that it was handled')
        self.assertEqual(sum('CRITICAL_OBJECTION_SENTINEL' in cp.compose(prior_turns(turns, 2), 'rebuttal', a)[0] for a in agents), 1, 'only its addressee answers it in rebuttal')

    def test_v3_a_review_is_sent_with_its_reason_or_left_out_and_listed(self):
        agents, turns = synthetic_run(2, 'supports', scale=0.2)
        support = turns[2]['parsed']['challenges'][0]; support['reason'] = '자금확약서가 실제 체결된 경우에만 이 주장에 동의한다.'
        text, manifest = cp.compose(prior_turns(turns, 3), 'alternatives', 'A1')
        self.assertIn('자금확약서가 실제 체결된 경우에만', text, 'a small record keeps the condition of an agreement')
        support['reason'] = '자금확약서가 체결된 경우에만 동의한다. ' + '가' * 2000
        required = cp.compose(prior_turns(turns, 3), 'alternatives', 'A1', room=0)[1]['required_bytes']
        text, manifest = cp.compose(prior_turns(turns, 3), 'alternatives', 'A1', room=required + 400)
        self.assertNotIn('자금확약서', text, 'a review that does not fit is left out whole, never shown without its condition')
        self.assertIn(support['id'], [i for ids in manifest['omitted_ids'].values() for i in ids]); self.assertIn(support['id'], text, 'its ID is listed as left out')
        self.assertIn('판단 근거로 쓰지 말고', text)
        for stage_k, stage in enumerate(ORDER[1:], 1):
            for a in agents:
                rendered = json.loads(cp.compose(prior_turns(turns, stage_k), stage, a)[0].split('\n')[1])
                self.assertFalse(any(x.get('_abridged') for rec in rendered for key in ('challenges', 'responses') for x in rec.get(key, [])), stage)

    def test_v3_final_stage_requires_the_candidates_and_the_claims_they_address_not_every_claim(self):
        agents, turns = synthetic_run(4, 'challenge'); prior = prior_turns(turns, 6)
        text, manifest = cp.compose(prior, 'revision', 'A1', final=True, room=0)
        sent = set(manifest['full']) | set(manifest['abridged'])
        self.assertTrue({f'S4{a}.C{i}' for a in agents for i in (1, 2, 3)} <= sent, 'every candidate under judgment')
        self.assertTrue({f'S1{a}.CLM{i}' for a in agents for i in (1, 2, 3)} <= sent, 'the claims the candidates address')
        self.assertNotIn('S1A2.CLM5', sent); self.assertIn('S1A2.CLM5', manifest['omitted_ids']['그 밖의 주장 목록'])
        self.assertIn('S1A2.CLM5', cp.compose(prior, 'revision', 'A1', final=True)[1]['abridged'], 'other claims still come as a list when there is room')
        records = text.split('\n')[1]
        self.assertEqual(records, json.dumps(json.loads(records), ensure_ascii=False, separators=(',', ':')), 'records are written without JSON spaces')
        self.assertEqual(manifest['bytes'], len(records.encode('utf-8')))

    @unittest.skipUnless((ROOT.parent/p.CASE).exists() and (ROOT.parent/'K_IFRS_기준서').is_dir(), 'course files are not in this checkout')
    def test_course_files_resolve_every_required_unit_within_the_material_budget(self):
        files = sorted(f for f in ROOT.parent.glob('*.md') if 'PBL' in f.name or re.match(r'^[2-7]주차', f.name)) + sorted((ROOT.parent/'K_IFRS_기준서').glob('*.md'))
        materials = d.bundle_files(files)[0]; secs = sp.sections(materials); units = sp.kifrs_units(secs)
        self.assertEqual([x for x in sp.ALL_ISSUE_UNITS if x not in units], [])
        self.assertEqual([x for x in sp.LECTURES if sp.lecture_unit(secs, x) is None], [])
        for stage in ('independent', 'cross', 'rebuttal', 'alternatives', 'perspectives', 'professor', 'revision'):
            _, manifest, _ = sp.pack(materials, stage, d.MATERIAL_CONTEXT_BYTES)
            self.assertEqual(manifest['omitted'], [], stage)
        _, manifest, _ = sp.pack(materials, 'independent', d.MATERIAL_CONTEXT_BYTES)
        self.assertIn('K1109:3.2.3', manifest['units'], 'the derecognition starting point is part of the Repo issue')
        self.assertEqual(manifest['abridged'], ['K1109:B3.2.16'], 'the local B3.2.16 keeps only some sub-items')
        self.assertEqual(sp.cited_units('제1109호 문단 3.2.6~3.2.7', units), ['K1109:3.2.6', 'K1109:3.2.7'])


if __name__ == '__main__': unittest.main()
