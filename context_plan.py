"""Role-based shared records for course-guided runs (course guidance version 3). Pure functions; no I/O or model calls.

Each call gets, in full, the records its participant must act on in this stage, including the unresolved critical
objections and claim revisions that decide whether a candidate under review holds, whoever wrote them. Related claim,
seed and candidate records may be reduced to ID-level fields; reviews and responses are sent whole or not at all, so a
conditional agreement is never shown without its condition. What is left out is listed by reason with its IDs. Saved
records are never changed and review status is always computed from them. If the required records do not fit, the
caller pauses before the call instead of cutting them.
"""
from __future__ import annotations
import hashlib
import json
import re

POLICY = 4  # 1 (never used for a saved run) could leave out critical objections; 3 adds HARD_CAP for heavy calls;
# 4 requires only the claims the candidates address in the final stage and writes the records without JSON spaces
CAP = 48000  # UTF-8 bytes, the same cap the full shared record had
HARD_CAP = 64000  # required records of a heavy call may reach this when the caller stretches the prompt budget for it
OPEN = ('challenge', 'unverified')
SETTLED = ('수용', '부분 수용', '기각')
REVISED = ('수용', '부분 수용')
KEY_FINDINGS = ('confirmed_defect', 'unverified_premise')
KINDS = ('claims', 'legality_checks', 'submitted_checks', 'candidate_seeds', 'candidates', 'challenges', 'responses')
# Only record types whose remaining fields keep their meaning have a short form; reviews and responses do not.
COMPACT = {
    'claims': ('id', 'claim', 'kind'),
    'legality_checks': ('id', 'item', 'judgment'),
    'candidate_seeds': ('id', 'idea'),
    'candidates': ('id', 'proposal', 'issue_ids')}
NOT_NEEDED = '이번 단계에서 판단할 필요가 없는 기록(다른 참가자 사이의 검토 등)'
LISTED_IDS = 15


class Overflow(Exception):
    """The records a participant must act on exceed the cap; the caller pauses before the model call."""
    def __init__(self, needed, cap, manifest):
        super().__init__(f'{needed} > {cap}')
        self.needed, self.cap, self.manifest = needed, cap, manifest


def owner(turn_id):
    return re.sub(r'^S\d+', '', str(turn_id))


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'))  # the same records in fewer bytes


def size(value):
    return len((value if isinstance(value, str) else dumps(value)).encode('utf-8'))


def entries(turns):
    """Every shareable record of the prior turns with its owner, kind and stable key."""
    out = []
    for t in turns:
        p = t.get('parsed') or {}
        base = {'turn': t['id'], 'name': t.get('name', ''), 'owner': owner(t['id']), 'stage': t.get('stage')}
        for kind in KINDS:
            for i, item in enumerate(p.get(kind) or []):
                if not isinstance(item, dict): continue
                full = {**item, **({'reviewer': t['id']} if kind == 'challenges' else {'responder': t['id']} if kind == 'responses' else {})}
                out.append({**base, 'kind': kind, 'key': str(item.get('id') or f"{t['id']}.{kind}[{i}]"), 'full': full})
        position = {k: p[k] for k in ('provisional_position', 'position_change', 'unresolved') if p.get(k)}
        if position: out.append({**base, 'kind': 'positions', 'key': f"{t['id']}.positions", 'full': position})
        if isinstance(p.get('review_assessment'), dict) and p['review_assessment']:
            out.append({**base, 'kind': 'review_assessment', 'key': f"{t['id']}.review_assessment", 'full': p['review_assessment']})
        for i, item in enumerate(p.get('ethics_assessment') or []):
            if isinstance(item, dict): out.append({**base, 'kind': 'ethics_assessment', 'key': f"{t['id']}.ethics_assessment[{i}]", 'full': item})
    return out


def annotate(es, me):
    """Mark ownership, targets, which objections are still unresolved for every participant (the target owner's
    latest reply decides, as in review()), which are critical, and what links to the candidates under review."""
    index = {e['key']: e for e in es if e['kind'] in ('claims', 'legality_checks', 'candidates', 'submitted_checks')}
    challenges = {e['key']: e for e in es if e['kind'] == 'challenges'}
    for e in challenges.values():
        target = index.get(e['full'].get('target_claim') or e['full'].get('target_candidate') or '')
        e['target'], e['target_owner'] = (target['key'], target['owner']) if target else (None, None)
    latest = {}
    for e in es:
        ch = challenges.get(e['full'].get('challenge_id')) if e['kind'] == 'responses' else None
        if ch and e['owner'] == ch['target_owner']: latest[ch['key']] = e['full']
    linked = {e['key'] for e in es if e['kind'] == 'candidates'}
    linked |= {cid for e in es if e['kind'] == 'candidates' for cid in (e['full'].get('issue_ids') or []) if isinstance(cid, str)}
    for e in es:
        e['mine'] = e['owner'] == me
        if e['kind'] == 'challenges':
            reply = latest.get(e['key']) or {}
            settled = reply.get('disposition') in SETTLED and reply.get('resolution') == 'addressed' and str(reply.get('reason', '')).strip()
            e['open'] = e['full'].get('disposition') in OPEN and not settled
            e['critical'] = e['full'].get('severity') == 'critical' or e['full'].get('finding_type') in KEY_FINDINGS
            e['to_me'] = e['target_owner'] == me
            e['pending'] = e['to_me'] and e['open']
            e['on_linked'] = e['target'] in linked
        elif e['kind'] == 'responses':
            ch = challenges.get(e['full'].get('challenge_id'))
            e['target'] = ch['target'] if ch else None
            e['revision'] = e['full'].get('disposition') in REVISED
            e['answers_critical'] = bool(ch) and ch['critical']
            e['on_linked'] = e['target'] in linked
    targeted = {e['target'] for e in es if e.get('pending')}
    for e in es: e['targeted'], e['linked'] = e['key'] in targeted, e['key'] in linked
    # Only the latest check per participant/case is mandatory later; originals remain available for targeted replies.
    latest_checks = {}
    for e in es:
        if e['kind'] == 'submitted_checks': latest_checks[(e['owner'], str(e['full'].get('case_id')))] = e['key']
    for e in es: e['latest_check'] = e['key'] in latest_checks.values()
    return es


def compact(e):
    fields = COMPACT.get(e['kind'])
    if not fields: return None
    return {**{k: e['full'][k] for k in fields if e['full'].get(k) not in (None, '', [])}, '_abridged': True}


def rules(stage, final):
    """(required, forms in preference order, predicate, label). A required record must fit in its last form."""
    kind = lambda *names: (lambda e: e['kind'] in names)
    critical_open = lambda e: e['kind'] == 'challenges' and e['open'] and e['critical']
    linked_critical = (True, ('full',), lambda e: critical_open(e) and e['on_linked'], '검토할 후보·쟁점에 걸린 미해결 핵심 반박·미확인 전제')
    linked_revision = (True, ('full',), lambda e: e['kind'] == 'responses' and e['revision'] and e['on_linked'], '후보·쟁점 주장의 수정 내용과 이유')
    later = [(False, ('full',), lambda e: critical_open(e), '그 밖의 미해결 핵심 반박'),
             (False, ('full',), lambda e: e['kind'] == 'responses' and e['revision'], '그 밖의 주장 수정 내용'),
             (False, ('full',), lambda e: e['kind'] == 'challenges' and e['open'], '그 밖의 미해결 반박·확인 요구'),
             (False, ('full',), kind('positions'), '참가자별 잠정 입장·미해결 쟁점'),
             (False, ('full',), kind('challenges', 'responses'), '처리된 검토·지지 판정(조건이 있을 수 있음)'),
             (False, ('compact',), kind('candidate_seeds', 'candidates', 'legality_checks', 'claims'), '씨앗·후보·최초 판단·주장 목록')]
    if stage == 'cross':
        return [(True, ('full',), lambda e: e['kind'] in ('claims', 'legality_checks') and e['stage'] == 'independent' and not e['mine'], '검토할 다른 참가자의 주장·최초 판단'),
                (True, ('full', 'compact'), lambda e: e['kind'] in ('claims', 'legality_checks') and e['mine'], '내 독립 조사 기록'),
                (False, ('full',), kind('positions'), '참가자별 잠정 입장·미해결 쟁점')]
    if stage == 'rebuttal':
        return [(True, ('full',), lambda e: e.get('pending', False), '내 기록에 온 응답 대상 반박·확인 요구'),
                (True, ('full',), lambda e: e['targeted'], '응답 대상 지적이 가리키는 원문'),
                (True, ('full', 'compact'), lambda e: e['kind'] in ('claims', 'legality_checks') and e['mine'], '내 주장·최초 판단'),
                (False, ('full',), kind('positions'), '공통 쟁점: 참가자별 잠정 입장·미해결 쟁점'),
                (False, ('full',), lambda e: e['kind'] == 'challenges' and e['to_me'], '내 기록에 대한 다른 검토(조건이 있을 수 있음)'),
                (False, ('compact',), kind('claims', 'legality_checks'), '다른 참가자의 주장·최초 판단 목록')]
    if final:
        return [(True, ('full',), lambda e: e.get('pending', False), '내 기록에 온 응답 대상 반박·확인 요구'),
                (True, ('full',), lambda e: e['targeted'], '응답 대상 지적이 가리키는 원문'),
                linked_critical, linked_revision,
                (True, ('full',), kind('review_assessment'), '최종 검토 기록(미확인 전제 ID 포함)'),
                (True, ('full', 'compact'), kind('candidates'), '판단할 후보'),
                (True, ('full', 'compact'), lambda e: e['kind'] == 'claims' and e['linked'], '후보가 해결하려는 쟁점 주장'),
                (False, ('compact',), kind('claims'), '그 밖의 주장 목록'),
                (False, ('full',), kind('ethics_assessment'), '윤리 3관점 검토'), *later]
    if stage == 'alternatives':
        return [(True, ('full',), kind('candidate_seeds'), '검토할 독립 후보 씨앗'),
                (True, ('full',), critical_open, '설계가 다뤄야 할 미해결 핵심 반박·미확인 전제'),
                (True, ('full',), lambda e: e['kind'] == 'responses' and e['revision'] and e['answers_critical'], '핵심 반박에 따른 주장 수정 내용'),
                (True, ('full', 'compact'), kind('claims'), '후보에 연결할 쟁점 주장'), *later]
    return [(True, ('full',), kind('candidates'), '검토할 C 후보'), linked_critical, linked_revision,
            (True, ('full', 'compact'), lambda e: e['kind'] == 'claims' and e['linked'], '후보가 해결하려는 쟁점 주장'),
            *([(False, ('full',), kind('ethics_assessment'), '윤리 3관점 검토')] if stage == 'professor' else []),
            (False, ('full', 'compact'), kind('claims'), '그 밖의 주장'), *later]


def _render(es, form):
    records = {}
    for i in sorted(form):
        e = es[i]; rec = records.setdefault(e['turn'], {'turn': e['turn'], 'name': e['name'], 'stage': e['stage']})
        value = e['full'] if form[i] == 'full' else compact(e)
        if e['kind'] == 'positions': rec.update(value)
        elif e['kind'] == 'review_assessment': rec['review_assessment'] = value
        else: rec.setdefault(e['kind'], []).append(value)
    return dumps(list(records.values()))


def compose(turns, stage, me, final=False, cap=CAP, room=None):
    """Return (text, manifest). Raises Overflow when the required records alone exceed the cap.
    room limits the optional records only, so the caller can keep the required source pack first."""
    limit = cap if room is None else max(0, min(cap, room))
    manifest = {'policy': POLICY, 'stage': stage, 'participant': me, 'cap': cap, 'full': [], 'abridged': [], 'omitted': {}, 'omitted_ids': {}}
    if not turns:
        return '(독립 조사: 의견 비공개)', {**manifest, 'bytes': 0, 'required_bytes': 0}
    es = annotate(entries(turns), me); plan = rules(stage, final); assigned = {}
    # User answer checks and all reviews/replies about them remain whole; a cap overflow pauses before inference.
    check_ids = {e['key'] for e in es if e['kind'] == 'submitted_checks'}
    plan = [(True, ('full',), lambda e: e['kind'] == 'submitted_checks' and (e['latest_check'] or e['targeted']), '의심 답변의 참가자별 최신 판정·응답 대상 원문'),
            (True, ('full',), lambda e: e['kind'] in ('challenges', 'responses') and e.get('target') in check_ids, '의심 답변 판정에 대한 검토·응답 원문'), *plan]
    for i, e in enumerate(es):
        assigned[i] = next((r for r, rule in enumerate(plan) if rule[2](e)), None)
    cost = lambda i, f: size(es[i]['full'] if f == 'full' else compact(es[i])) + 1
    form = {i: plan[r][1][-1] if compact(es[i]) is not None else 'full' for i, r in assigned.items() if r is not None and plan[r][0]}
    required = size(_render(es, form))
    if required > cap:
        raise Overflow(required, cap, {**manifest, 'required_bytes': required, 'required': [es[i]['key'] for i in sorted(form)]})
    used, placed = required + 100 * len({e['turn'] for e in es} - {es[i]['turn'] for i in form}), []  # reserve for new turn groups
    for r, rule in enumerate(plan):
        for i in (k for k, v in assigned.items() if v == r):
            for f in rule[1]:
                if form.get(i) == f: break
                if f == 'compact' and compact(es[i]) is None: continue
                extra = cost(i, f) - (cost(i, form[i]) if i in form else 0)
                if used + extra <= limit: used += extra; placed.append((i, form.get(i))); form[i] = f; break
    text = _render(es, form)
    while size(text) > limit and placed:  # undo the latest additions if the estimate was short; required forms stay
        i, previous = placed.pop()
        if previous is None: form.pop(i)
        else: form[i] = previous
        text = _render(es, form)
    omitted = {}
    for i, r in assigned.items():
        if i not in form: omitted.setdefault(plan[r][3] if r is not None else NOT_NEEDED, []).append(es[i]['key'])
    manifest.update(required_bytes=required, room=limit, bytes=size(text), sha256=hashlib.sha256(text.encode('utf-8')).hexdigest(),
                    full=[es[i]['key'] for i in sorted(form) if form[i] == 'full'],
                    abridged=[es[i]['key'] for i in sorted(form) if form[i] == 'compact'],
                    omitted={label: len(ids) for label, ids in omitted.items()}, omitted_ids=omitted)
    header = (f'[역할별 공유 기록 · 정책 {POLICY} · 참가자 {me} · 단계 {stage}. 이번 단계에서 답하거나 판단해야 할 기록과 검토할 후보의 성립을 좌우하는 '
              '미해결 핵심 반박·수정 내용은 원문 그대로다. "_abridged" 표시 기록은 ID와 핵심 필드만 담았고, 생략 목록의 기록은 이번 입력에 없다. '
              '생략된 검토·지지 판정은 조건이 붙어 있을 수 있으므로 판단 근거로 쓰지 말고, 없는 내용을 추정하지 마라. '
              '모든 원문은 실행 기록에 보존되며 검토 상태는 원문 기준으로 계산한다.]\n')
    note = ''.join(f"\n[생략] {label} {len(ids)}건: {', '.join(ids[:LISTED_IDS])}{' 외' if len(ids) > LISTED_IDS else ''}" for label, ids in omitted.items())
    return header + text + note, manifest
