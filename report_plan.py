"""A report writing plan backed by saved debate records. No model calls or writes.

STEP describes the analysis; SECTION describes the submission order. The preview
is an index of available records, never a new recommendation or a finished essay.
"""
from __future__ import annotations
import copy
import hashlib
import json
import re
import submitted_audit

VERSION = 1
SECTIONS = (
    (1, 'Executive Strategy Memo', [4], '권고 C안부터 제시하고 S 전제 → C 문제 → Q 핵심 질문 → 해답으로 설명', ('R8', 'R9', 'R12')),
    (2, 'AI 환각 감사 & 합리화 진단', [1], '실제 오류의 원질문·원답변·교정 과정과 4대 합리화·인지부조화를 연결', ('R1', 'R2')),
    (3, '장기적 사회 효용 평가', [2], 'A/B 이해관계자별 단기·장기 손익, 산식·단위·가정·민감도와 소수 부담을 비교', ('R3', 'R4', 'R5', 'R13')),
    (4, '회계 부정 분석 & 대안 C 실행계획', [3, 4], '네 회계 쟁점·사기 삼각대·독립성 통제와 선정 C의 책임자·일정·실행 관문을 연결', ('R6', 'R7', 'R8', 'R9')),
    (5, 'Pre-Mortem & Kill Conditions', [5], '1년 지연·경쟁사 선점 상황에서 선택 이유를 검토하고 중단·전환 기준을 제시', ('R10', 'R11')),
)
FIELD_LABELS = {'stakeholder_matrix': '이해관계자 손익표', 'utility_model': '효용 산식·가정·민감도',
                'failure_review': '실패 시나리오', 'kill_conditions': '중단·전환 기준', 'ethics_assessment': '윤리관 비교',
                'review_assessment': '최종 검토', 'counterexample_checks': '반례 검토', 'fact_checks': '사실 대조',
                'student_feedback': '학생 첫 생각에 대한 검토', 'decision': 'AI의 최종 판단', 'responses': '반박에 대한 응답'}
FIELD_SECTIONS = {'stakeholder_matrix': [3], 'utility_model': [3], 'failure_review': [5], 'kill_conditions': [5],
                  'ethics_assessment': [3, 4], 'review_assessment': [5], 'counterexample_checks': [5], 'fact_checks': [2, 4],
                  'student_feedback': [2], 'decision': [1, 4], 'responses': [2, 4, 5]}
STAGE_SECTIONS = {'independent': [2, 4], 'cross': [2], 'alternatives': [1, 4], 'perspectives': [3, 5],
                  'professor': [4, 5], 'revision': [1, 4], 'consensus': [1, 4]}
APPENDICES = (
    ('APP1', 'AI 대화 원문·입장 변화·반박 응답', [1, 2, 4, 5]),
    ('APP2', '실제 오류·원질문·수정 질문·개선 답변', [2]),
    ('APP3', 'K-IFRS·법령·강의 근거와 확인 범위', [2, 4]),
    ('APP4', '이해관계자 손익·상세 산식·민감도', [3]),
    ('APP5', '실행 관문·실패 시나리오·저지선', [4, 5]),
)


def _str(value):
    return value if isinstance(value, str) else ''


def _strings(value):
    return [x for x in value if isinstance(x, str) and x.strip()] if isinstance(value, list) else []


def _objects(value):
    return [x for x in value if isinstance(x, dict)] if isinstance(value, list) else []


def _text(value):
    return value if isinstance(value, str) else json.dumps(value, ensure_ascii=False, indent=2)


def _excerpt(value, limit=420):
    text = ' '.join(_text(value).split())
    return text if len(text) <= limit else text[:limit] + '… [원문 계속]'


def _parsed(turn):
    return turn.get('parsed') if isinstance(turn.get('parsed'), dict) else {}


def source_digest(state):
    written = [{k: t.get(k) for k in ('id', 'answer', 'parsed')} for t in state.get('turns', []) if isinstance(t, dict)]
    data = {'turns': written, 'audit_verdicts': state.get('audit_verdicts', {}), 'corrections': state.get('corrections', []),
            'student_draft': state.get('student_draft', '')}
    if submitted_audit.cases(state): data['submitted_cases'] = submitted_audit.cases(state)
    return hashlib.sha256(json.dumps(data, ensure_ascii=False, sort_keys=True).encode('utf-8')).hexdigest()


def record_index(state, findings=()):
    """Actual saved text, indexed by original IDs or an explicit turn.field path.

    Early report_plan prose is deliberately excluded: it can recommend B before C
    has even been designed. Original claims remain evidence *records*, not facts.
    """
    turns = _objects(state.get('turns')); result = {}
    challenges = {c.get('id'): c for t in turns for c in _objects(_parsed(t).get('challenges')) if c.get('id')}
    corrected = set()
    for t in turns:
        actor = str(t.get('id', '')).split('A')[-1]
        for reply in _objects(_parsed(t).get('responses')):
            ch = challenges.get(reply.get('challenge_id'), {}); target = ch.get('target_claim') or ch.get('target_candidate')
            target_actor = str(target or '').split('.')[0].split('A')[-1]
            if target and actor == target_actor and reply.get('disposition') in ('수용', '부분 수용') and ch.get('disposition') != 'supports': corrected.add(target)
    priority = {'revision': 0, 'consensus': 0, 'perspectives': 1, 'alternatives': 2, 'professor': 3, 'cross': 4, 'rebuttal': 5, 'independent': 6}
    for turn in sorted(turns, key=lambda t: priority.get(t.get('stage'), 9)):
        p = _parsed(turn); tid = _str(turn.get('id')); stage = turn.get('stage', '')
        assigned = {}
        for note in _objects(p.get('requirement_notes')):
            sections = [n for n, _, _, _, reqs in SECTIONS if note.get('requirement_id') in reqs]
            for rid in _strings(note.get('claim_ids')): assigned.setdefault(rid, set()).update(sections)
        label = f"{turn.get('name') or tid} · {turn.get('stage_title') or stage}"
        def add(rid, text, sections, kind='unverified', source='', status='', raw=None):
            if not rid or not text: return
            result[rid] = {'id': rid, 'turn': tid, 'label': label, 'text': _text(text), 'kind': kind,
                           'source': _text(source) if source else '', 'status': status or 'AI가 기록한 분석 · 별도 사실 확인과 구별',
                           'sections': sorted(sections), 'stage': stage, 'raw': copy.deepcopy(raw if raw is not None else text)}
        for claim in _objects(p.get('claims')):
            rid = _str(claim.get('id')); kind = claim.get('kind') if claim.get('kind') in ('task_fact', 'verified_external', 'assumption', 'unverified') else 'unverified'
            status = _str(claim.get('status'))
            sections = assigned.get(rid) or STAGE_SECTIONS.get(stage, [2])
            if rid in corrected:
                status = '수정 전/감사 이력 · 본인이 반박을 수용한 원주장; 개선 응답 대조 필요'; sections = [2]
            elif stage in ('independent', 'cross', 'rebuttal'):
                status = '초기 주장 · 이후 반박·교정 확인 필요' + (' · ' + status if status else '')
            add(rid, claim.get('claim'), sections, kind, claim.get('source'), status, claim)
        for candidate in _objects(p.get('candidates')):
            add(_str(candidate.get('id')), candidate, [1, 4], 'proposal', status='검토된 후보 · 실행 효과의 입증과 구별', raw=candidate)
        for item in _objects(p.get('legality_checks')):
            rid = _str(item.get('id'))
            add(rid, item, [2] if rid in corrected else [2, 4], 'legality',
                status='수정 전/감사 이력 · 본인이 반박을 수용한 최초 합법성 답변' if rid in corrected else '최초 합법성 답변 · 교정 전 원문일 수 있음', raw=item)
        for key, section_numbers in FIELD_SECTIONS.items():
            value = p.get(key)
            if not value or key == 'decision' and stage not in ('revision', 'consensus'): continue
            add(f'{tid}.{key}', value, section_numbers, 'analysis', status=FIELD_LABELS[key] + ' · 기록된 가정·한계 유지', raw=value)
        if submitted_audit.cases(state):
            for item in _objects(p.get('submitted_checks')):
                add(_str(item.get('id')), item, [2], 'submitted_check', status='사용자 원답변에 대한 AI 판정 · 사실 확정 아님', raw=item)
        for ch in _objects(p.get('challenges')):
            add(_str(ch.get('id')), ch, [2, 4, 5], 'review', status='AI의 검토 주장 · 사실 확정 아님', raw=ch)
    for finding in findings:
        rid = _str(finding.get('key')); tid = _str(finding.get('target_turn'))
        if not rid: continue
        result[rid] = {'id': rid, 'turn': tid, 'label': f"{finding.get('target_name') or tid} · {finding.get('label') or '오류 후보'}",
                       'text': _text({'quote': finding.get('quote'), 'reports': finding.get('reports'), 'verdict': finding.get('verdict')}),
                       'kind': 'audit', 'source': '', 'status': finding.get('label') or '오류 후보 · 최종 확인 필요', 'sections': [2],
                       'stage': 'audit', 'raw': copy.deepcopy(finding)}
    if _str(state.get('student_draft')).strip():
        result['STUDENT_DRAFT'] = {'id': 'STUDENT_DRAFT', 'turn': '', 'label': '학생이 입력한 첫 생각', 'text': state['student_draft'],
                                   'kind': 'student', 'source': '', 'status': '실제 학생 입력 · AI 생성 아님', 'sections': [2], 'stage': 'student', 'raw': state['student_draft']}
    for case in submitted_audit.cases(state):
        result[case['id']] = {'id': case['id'], 'turn': '', 'label': '사용자 제출 의심 답변 ' + case['id'].removeprefix('USERCASE'),
                              'text': _text(case), 'kind': 'submitted_answer', 'source': case.get('source', ''),
                              'status': '사용자 제공 원문 · 출처의 진위·오류 여부 별도 확인', 'sections': [2], 'stage': 'submitted', 'raw': copy.deepcopy(case)}
    return result


def normalize(value):
    """Keep only the writing-plan contract. Validation against the run happens in build()."""
    if not isinstance(value, dict): return None
    d = value.get('decision') if isinstance(value.get('decision'), dict) else {}
    decision = {k: _str(d.get(k)) for k in ('candidate_id', 'recommendation', 'why', 'if_conditions_fail')}
    decision.update({k: _strings(d.get(k)) for k in ('now', 'evidence_ids', 'minority_views')})
    decision['conditions'] = [{k: _str(x.get(k)) for k in ('condition', 'check', 'if_fail')} for x in _objects(d.get('conditions'))]
    decision['alternatives'] = [{k: _str(x.get(k)) for k in ('candidate_id', 'why_not')} for x in _objects(d.get('alternatives'))]
    sections = []
    for x in _objects(value.get('sections')):
        number = x.get('number')
        if type(number) is not int or number not in range(1, 6): continue
        sections.append({'number': number, **{k: _strings(x.get(k)) for k in ('points', 'evidence_ids', 'assumptions', 'unknowns', 'appendix_ids')}})
    return {'version': VERSION, 'decision': decision, 'sections': sections}


def build(state, synthesis=None, candidates=(), findings=()):
    """Readable projection of new generated plans or existing records, without choosing a winner."""
    index = record_index(state, findings); catalog = {c['id']: c for c in candidates if isinstance(c, dict) and c.get('id')}
    meta = synthesis if isinstance(synthesis, dict) else {}; parsed = meta.get('parsed') if isinstance(meta.get('parsed'), dict) and not meta.get('failed') else {}
    generated = normalize(parsed.get('report_plan')); issues = []; mode = 'generated' if generated else 'records'
    d = copy.deepcopy(generated['decision']) if generated else {'candidate_id': '', 'recommendation': '', 'why': '', 'now': [], 'conditions': [], 'alternatives': [], 'evidence_ids': [], 'minority_views': []}
    legacy = parsed.get('conclusion') if isinstance(parsed.get('conclusion'), dict) else {}
    ids = _strings(legacy.get('candidate_ids'))
    if not generated:
        if len(ids) == 1 and ids[0] in catalog:
            d.update(candidate_id=ids[0], recommendation=_str(legacy.get('recommendation')), why=_str(legacy.get('why')),
                     conditions=[{'condition': _str(x.get('condition')), 'check': _str(x.get('how_to_check')), 'if_fail': ''} for x in _objects(legacy.get('conditions'))],
                     if_conditions_fail=_str(legacy.get('if_conditions_fail')),
                     minority_views=_strings(legacy.get('minority_views')))
        issues.append('저장 기록의 SECTION별 자료표입니다. 새 총괄 권고·작성안은 아직 생성하지 않았습니다.')
        if len(ids) > 1: issues.append('기존 총괄 정리에 후보가 여러 개 기록되어 하나를 임의 선택하지 않았습니다.')
    if generated and (not d['candidate_id'] or d['candidate_id'] not in catalog):
        issues.append('총괄이 고른 단일 후보 ID를 저장된 후보에서 찾지 못했습니다.')
    if generated and ids != [d['candidate_id']]: issues.append('결과 결론과 보고서 작성안의 선정 후보가 일치하지 않습니다.')
    if generated and not all(d.get(k) for k in ('recommendation', 'why', 'now', 'evidence_ids')):
        issues.append('최종 권고의 행동·선택 이유·지금 할 일·근거 중 빠진 항목이 있습니다.')
    if generated and len({x['number'] for x in generated['sections']}) != 5: issues.append('SECTION 1~5 작성안 중 누락된 절이 있습니다.')
    if generated and len(generated['sections']) != len({x['number'] for x in generated['sections']}): issues.append('같은 SECTION이 중복되어 먼저 나온 작성안을 표시합니다.')
    for reason in _strings(meta.get('stale_reasons')): issues.append(reason)
    def evidence(ids, label):
        unknown = [rid for rid in ids if rid not in index]
        if unknown: issues.append(f"{label}: 저장 기록에서 찾을 수 없는 근거 {', '.join(unknown)}")
        return [{k: copy.deepcopy(v) for k, v in index[rid].items() if k != 'raw'} for rid in dict.fromkeys(ids) if rid in index]
    d['name'] = catalog.get(d['candidate_id'], {}).get('name', '')
    d['selection_valid'] = bool(d['candidate_id'] and d['candidate_id'] in catalog)
    d['evidence'] = evidence(d['evidence_ids'], '최종 권고')
    for alt in d['alternatives']:
        cid = alt['candidate_id']; alt['name'] = catalog.get(cid, {}).get('name', cid if cid in ('A', 'B') else '')
        if cid not in catalog and cid not in ('A', 'B'): issues.append(f'비선정 대안 ID를 찾을 수 없습니다: {cid}')
    sections = []
    for n, title, steps, purpose, _ in SECTIONS:
        supplied = next((s for s in generated['sections'] if s['number'] == n), {}) if generated else {}
        available_ids = [rid for rid, r in index.items() if n in r['sections']]
        chosen_ids = supplied.get('evidence_ids', []) if generated else available_ids
        rows = evidence(chosen_ids, f'SECTION {n}')
        if generated and n != 2 and any(r['status'].startswith('수정 전/감사 이력') for r in rows):
            issues.append(f'SECTION {n}이 반박을 수용한 수정 전 주장을 참조합니다. 최종 근거로 쓰기 전 교정 응답을 확인하세요.')
        points = supplied.get('points', [])
        assumptions = supplied.get('assumptions', [])
        unknowns = supplied.get('unknowns', [])
        if not generated:
            preferred = [r for r in rows if r['kind'] in ('task_fact', 'verified_external', 'assumption', 'unverified') and r['stage'] in ('revision', 'consensus', 'perspectives')]
            preferred += [r for r in rows if r['id'].endswith(('.utility_model', '.kill_conditions', '.failure_review', '.stakeholder_matrix'))]
            preferred += [r for r in rows if r not in preferred and r['kind'] not in ('review', 'audit', 'legality') and not r['status'].startswith('수정 전')]
            points = [f"저장 기록 발췌 · {r['label']}: {_excerpt(r['text'])}" for r in preferred[:4]]
            if n == 1 and d.get('recommendation'):
                points = ['기존 총괄 권고: ' + d['recommendation'], '기존 선택 이유: ' + d.get('why', '')] + points[:2]
            assumptions = [f"{r['label']}: {_excerpt(r['text'])}" for r in rows if r['kind'] == 'assumption'][:3]
            unknowns = [f"{r['label']}: {_excerpt(r['text'])}" for r in rows if r['kind'] == 'unverified'][:3]
            if not assumptions: assumptions = ['이 절에 연결된 별도 가정 분류 기록 없음 · 원문에서 확인 필요']
            if not unknowns: unknowns = ['이 절의 미확인 사항을 별도로 정리한 기록 없음 · 확인 완료를 뜻하지 않음']
        if generated and (not points or not chosen_ids): issues.append(f'SECTION {n}에 작성 요점 또는 근거 연결이 없습니다.')
        if generated and n == 2 and submitted_audit.cases(state):
            linked_cases = {r['raw'].get('case_id') or r['id'] for rid in chosen_ids if (r := index.get(rid)) and isinstance(r.get('raw'), dict)}
            if any(c['id'] not in linked_cases for c in submitted_audit.cases(state)):
                issues.append('SECTION 2에 사용자 제출 의심 답변의 근거 연결이 일부 빠졌습니다. 검증 결과 탭에서 보완하세요.')
        sections.append({'number': n, 'title': title, 'steps': steps, 'purpose': purpose, 'points': points, 'evidence': rows,
                         'available_count': len(available_ids), 'assumptions': assumptions, 'unknowns': unknowns,
                         'appendix_ids': supplied.get('appendix_ids', []) if generated else [aid for aid, _, nums in APPENDICES if n in nums]})
    appendices = [{'id': aid, 'title': title, 'record_ids': list(dict.fromkeys(r['id'] for s in sections if s['number'] in nums for r in s['evidence']))} for aid, title, nums in APPENDICES]
    allowed_appendix = {a['id'] for a in appendices}
    for s in sections:
        invalid = [aid for aid in s['appendix_ids'] if aid not in allowed_appendix]
        if invalid: issues.append(f"SECTION {s['number']}: 알 수 없는 부록 참조 {', '.join(invalid)}")
    status = ('stale' if meta.get('stale') else 'needs_review' if issues else 'ready') if generated else ('stale' if meta.get('stale') else 'not_generated')
    return {'version': VERSION, 'mode': mode, 'status': status, 'decision': d, 'sections': sections, 'appendices': appendices,
            'issues': list(dict.fromkeys(issues)), 'source_sha256': source_digest(state),
            'source_label': '총괄의 새 작성안 · 사실 검증 및 제출본 확정은 별도' if generated else '저장 기록 자료표 · 기존 총괄 판단은 그대로 표시',
            'page_guidance': '본문은 A4 4페이지 이내로 직접 작성하고 상세 원문·계산·검증 기록은 부록에 둡니다.'}


def prompt_context(state, findings=(), budget=16000):
    """Budgeted evidence with whole financial records. No sliced formula or number.

    The page keeps all records. Model input admits complete records by priority,
    then lists omissions explicitly; omitted content must not be inferred.
    """
    index = record_index(state, findings)
    priority_fields = ('stakeholder_matrix', 'utility_model', 'failure_review', 'kill_conditions')
    mandatory = [r for r in index.values() if any(r['id'].endswith('.' + k) for k in priority_fields)]
    selected = []; taken = set()
    def row(r):
        return {k: r[k] for k in ('id', 'turn', 'label', 'text', 'kind', 'source', 'status', 'sections')}
    for r in mandatory: selected.append(row(r)); taken.add(r['id'])
    # Round robin gives every SECTION relevant evidence before spending the rest.
    stage_priority = {'revision': 0, 'consensus': 0, 'perspectives': 1, 'alternatives': 2, 'cross': 3, 'professor': 4, 'independent': 5}
    def priority(r):
        # Keep one participant's many claims from using the entire prompt budget.
        match = re.search(r'\.CLM(\d+)$', r['id'])
        return stage_priority.get(r['stage'], 9), int(match[1]) if match else 999, r['turn']
    pools = [sorted([r for r in index.values() if n in r['sections'] and r['id'] not in taken and r['kind'] not in ('review', 'audit', 'proposal')
                     and not r['status'].startswith('수정 전') and not r['id'].endswith(('.responses', '.decision', '.review_assessment'))], key=priority) for n, *_ in SECTIONS]
    max_items = max((len(p) for p in pools), default=0)
    for i in range(max_items):
        for pool in pools:
            if i >= len(pool): continue
            r = pool[i]
            if r['id'] in taken: continue
            item = row(r)
            if len(json.dumps(selected + [item], ensure_ascii=False, separators=(',', ':')).encode('utf-8')) > budget: continue
            selected.append(item); taken.add(r['id'])
    return {'sections': [{'number': n, 'title': title, 'steps': steps, 'purpose': purpose} for n, title, steps, purpose, _ in SECTIONS],
            'records': selected, 'included_records': len(selected), 'available_records': len(index),
            'omitted_by_stage': {stage: sum(1 for r in index.values() if r['stage'] == stage and r['id'] not in taken) for stage in sorted({r['stage'] for r in index.values()})},
            'appendices': [{'id': aid, 'title': title} for aid, title, _ in APPENDICES],
            'instruction': '생략된 원문은 추정하지 말고 필요한 근거 부족을 unknowns에 표시. 초기 주장은 이후 반박·응답·교정을 대조하기 전 확정 근거로 쓰지 않는다.'}


SCHEMA = {
    'version': VERSION,
    'decision': {'candidate_id': '저장 후보 중 정확히 하나', 'recommendation': '보고서에서 채택할 행동', 'why': '같은 기준으로 비교한 선택 이유',
                 'now': ['지금 할 행동'], 'conditions': [{'condition': '실행 조건', 'check': '확인 자료·담당', 'if_fail': '조건 실패 시 행동'}],
                 'alternatives': [{'candidate_id': 'A 또는 B 또는 저장 후보 ID', 'why_not': '선택하지 않은 이유'}],
                 'evidence_ids': ['실제 저장 기록 ID'], 'minority_views': ['누가 제기한 어떤 반론이 남는지'], 'if_conditions_fail': '전체 실행이 불가능할 때 전환 경로'},
    'sections': [{'number': 1, 'points': ['완성 문장 대필 대신 쓸 논점과 전개 순서'], 'evidence_ids': ['자료 report_context.records의 ID'],
                  'assumptions': ['교육용 수치·별도 가정'], 'unknowns': ['아직 확인하지 못한 사실과 결론에 미치는 영향'], 'appendix_ids': ['APP1']}],
}


GUIDANCE = (
    '8. report_plan을 함께 만든다. 보고서에서 택할 C안 하나를 decision.candidate_id에 지정하고 conclusion.candidate_ids도 그 한 개와 일치시켜라. '
    '다수결이나 총괄 자신의 후보 우선으로 고르지 말고, 과제 적합성·A/B 단점 감소·실행 가능성·핵심 반박 대응을 같은 기준으로 비교하라. '
    '합의 여부, 보고서 권고, 실제 실행 준비 상태는 분리하라. 확인이 덜 된 세부 실행 조건만으로 보고서의 방향까지 보류하지 마라. '
    '다만 후보를 지지할 기록이 실제로 없으면 후보를 꾸며내지 말고 candidate_id를 비우고 부족한 핵심 근거를 명시하라. '
    'now에는 지금 할 행동, conditions에는 무엇을 누가 확인하고 실패하면 무엇을 하는지, alternatives에는 A/B 및 실제 경쟁 후보를 버린 이유를 쓴다.\n'
    '9. report_plan.sections는 정확히 SECTION 1~5: STEP4→SECTION1+4, STEP1→SECTION2, STEP2→SECTION3, STEP3→SECTION4, STEP5→SECTION5. '
    'SECTION1은 최종 C 권고→S 전제→C 문제→Q 핵심 질문→해답의 작성 요점, SECTION2는 실제 오류 감사/합리화, SECTION3는 A/B 장단기 손익·산식·단위·민감도·소수 부담, '
    'SECTION4는 4대 쟁점/부정의 3요소/독립성과 C 실행계획, SECTION5는 1년 지연·경쟁사 선점 Pre-Mortem과 정량 저지선이다. '
    '본문 A4 4페이지 이내에 담을 요점과 APP1~APP5 근거 연결을 제공하되 학생 제출 문장을 대필하지 마라.\n'
    '10. report_context의 evidence ID와 실제 원문을 연결한다. 초기 S3 report_plan은 C 설계 전 잠정 계획이며 최종 권고로 복사하지 마라. '
    '최신 revision과 반박 응답·교정이 원주장보다 우선한다. 수용·정정된 초기 기준서 해석이나 오류를 최종 사실 근거로 되살리지 마라. '
    'SECTION2에는 원질문·실제 인용·수정 질문·개선 답변을 별도로 보존하고 오류 후보와 학생 확인 오류를 구분한다. '
    '사실(task_fact/verified_external)은 각 기록의 확인 범위 안에서, 교육용 가정·수치는 assumptions, 미확인사항은 unknowns로 구분한다. '
    'utility_model의 가상 계산은 실증 우위가 아니다. 새 수치·산식·법률 판단은 만들지 마라. 생략된 자료는 읽었다고 주장하지 마라.\n'
)


def markdown(plan):
    """Standalone export of the same visible plan, with source records in appendices."""
    d = plan['decision']; lines = ['# SECTION 1~5 보고서 작성안', '', plan['source_label'], '', plan['page_guidance'], '',
                                  '## 총괄 권고', '', d.get('name') or '새 단일 권고 생성 전', '', d.get('recommendation') or '', '', d.get('why') or '']
    if plan['issues']: lines += ['', '확인할 사항:'] + ['- ' + x for x in plan['issues']]
    lines += ['', '지금 할 일:'] + ['- ' + x for x in d.get('now', [])]
    for c in d.get('conditions', []): lines += [f"- 조건: {c['condition']} / 확인: {c['check']} / 실패 시: {c['if_fail']}"]
    if d.get('if_conditions_fail'): lines += ['', '조건이 맞지 않을 때: ' + d['if_conditions_fail']]
    used = {}
    for s in plan['sections']:
        lines += ['', f"## SECTION {s['number']}. {s['title']}", '', '분석 STEP: ' + ', '.join(map(str, s['steps'])), '', s['purpose'], '']
        lines += ['- ' + x for x in s['points']]
        for label, key in [('가정', 'assumptions'), ('미확인', 'unknowns')]:
            if s[key]: lines += ['', label + ':'] + ['- ' + x for x in s[key]]
        for e in s['evidence']:
            used[e['id']] = e; lines += [f"- 근거 {e['id']}: {e['label']} · {e['status']}"]
    lines += ['', '## 부록 · 연결된 원문', '']
    for e in used.values(): lines += [f"### {e['id']} · {e['label']}", '', f"분류: {e['kind']} · {e['status']}", '', e['source'], '', e['text'], '']
    return '\n'.join(lines)
