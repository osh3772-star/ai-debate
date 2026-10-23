"""Stage source packs for course-guided accounting PBL runs. Pure text functions; no I/O or model calls.

Required units (the case file, whole K-IFRS paragraphs, verbatim lecture line ranges) are placed first and
never split. A unit that does not fit is recorded as omitted instead of being cut, and its lines stay out of the
auxiliary excerpts that callers add from the other selected lines with any remaining budget.
"""
from __future__ import annotations
import hashlib
import re

VERSION = 1
KIFRS_FILES = {
    'KCF': '00_재무보고를_위한_개념체계.md', 'K1001': '01_제1001호_재무제표_표시.md', 'K1002': '02_제1002호_재고자산.md',
    'K1008': '03_제1008호_회계정책_회계추정치_변경과_오류.md', 'K1036': '04_제1036호_자산손상.md',
    'K1037': '05_제1037호_충당부채_우발부채_우발자산.md', 'K1038': '06_제1038호_무형자산.md', 'K1109': '07_제1109호_금융상품.md',
    'K1113': '08_제1113호_공정가치_측정.md', 'K1115': '09_제1115호_고객과의_계약에서_생기는_수익.md'}
# Paragraphs a reviewer needs whole to judge each accounting issue of the case, including scope conditions.
ISSUE_UNITS = (
    ('쟁점1 교차매출', ('K1115:5', 'K1115:9', 'K1115:17', 'K1115:66', 'K1115:67', 'K1115:70', 'K1115:71', 'K1115:72', 'K1115:B56', 'K1115:B58', 'K1115:B61')),
    ('쟁점1 Repo', ('K1109:3.2.3', 'K1109:3.2.6', 'K1109:3.2.7', 'K1109:3.2.15', 'K1109:B3.2.16')),
    ('쟁점2 R&D 자본화', ('K1038:54', 'K1038:57', 'K1038:68', 'K1038:71', 'K1036:59')),
    ('쟁점2 빅배스', ('K1002:29', 'K1002:33', 'K1002:34', 'K1008:41', 'K1008:42')),
    ('쟁점4 급행료', ('KCF:2.12', 'KCF:2.15', 'K1037:14', 'K1037:19')))
ALL_ISSUE_UNITS = tuple(unit for _, units in ISSUE_UNITS for unit in units)
# Verbatim lecture ranges: from the line starting with the first marker up to (not including) the second.
LECTURES = {
    'W2-인지부조화': ('2주차_PRE.md', '1.3.1 인지부조화의 개념과 메커니즘', '1.3.4 샐리 클라크'),
    'W2-에토스': ('2주차_PRE.md', '1.5 설득의 세 기둥', '1.6 전문성과 윤리성의 관계'),
    'W3-합리화 4유형': ('3주차_PRE (1).md', '3.3.2 주요 합리화 유형 분석', '3.4 합리화에 맞서는 방법'),
    'W4-월드콤·시스템1·2': ('4주차_PRE.md', '4.2.2 4단계 윤리의 함정', '4.3 윤리적 행동의 나침반'),
    'W4-아서앤더슨·두 나침반': ('4주차_PRE.md', '4.3.1 \'정직\'을 배신한 대가', '4.4 결론'),
    'W5-독립성 위협': ('5주차_PRE.md', '5.2 독립성을 위협하는 7가지 유혹', '5.3 전문가의 방패'),
    'W5-안전장치·의구심': ('5주차_PRE.md', '5.3 전문가의 방패', '5.4 결론'),
    'W6-부정의 3요소': ('6주차_PRE.md', '6.2 부정의 3요소 심층 분석', '6.3 사기꾼의 레시피'),
    'W6-사기 레시피': ('6주차_PRE.md', '6.3 사기꾼의 레시피', '6.4 회색지대의 악마들'),
    'W6-회색지대·공정한 표시': ('6주차_PRE.md', '6.4 회색지대의 악마들', '학습 정리 및 점검'),
    'W7-공리주의·칸트': ('7주차_PRE.md', '7.2 공리주의: 최대 다수의 최대 행복', '7.4 필립모리스 사례'),
    'W7-이중 질문': ('7주차_PRE.md', '7.5.3 윤리적 의사결정의 이중 질문', '7.5.4 감시자로서의 칸트적 관점'),
    'W7-공동체주의': ('7주차_PRE.md', '9.3 공동체주의: 서사적 존재로서의 개인', '9.4 기업의 사회적 책임'),
    'W7-통합 판단': ('7주차_PRE.md', '9.6.3 윤리적 딜레마에서의 판단 기준', '9.7 실무에서의 적용 사례들')}
TERMS = ('[과제·강의 용어 대응 · 출처를 나란히 보존하고 같은 개념으로 자동 치환하지 말 것]\n'
         '- 독립성 위협: 과제는 \'5대 위협\'((PBL)7주차_중간PBL과제.md:L66), 5주차 강의는 7가지(이기적·부당한 압력·역이해관계·자기검토·변호·경영참여·유착, 5주차_PRE.md:L19~L21). '
         'IESBA 윤리강령의 5개 위협 범주는 제공 자료에 원문이 없으므로 인용하려면 확인 필요로 표시하라.\n'
         '- 합리화 유형: 과제는 책임 분산·법률주의·결과 왜곡·권위 의존((PBL)7주차_중간PBL과제.md:L93~L96), 3주차 강의는 책임 분산·법률주의·결과 왜곡·책임 전가(3주차_PRE (1).md:L139~L193)이며 '
         '"회계법인이 감사하고 승인해 준 사안"을 책임 전가로 분류한다(3주차_PRE (1).md:L213~L216). 두 이름을 함께 쓰고 해당 발언에 적용한 이유를 밝혀라.')
UNSECURED = ('[원문 미제공 근거 · 인용하면 미확인 또는 웹 확인 기록으로만 처리]\n'
             '공인회계사법 제21조(비감사업무 제한), 주식회사 등의 외부감사에 관한 법률, 국제상거래에 있어서 외국공무원에 대한 뇌물방지법, '
             '미국 해외부패방지법(FCPA), 사베인스-옥슬리법 제201조, IESBA 윤리강령 독립성 규정')
# Stage responsibilities follow the agreed assignment: issues and premises → standards and terms → revision
# reasons and plan → mechanisms → ethics and stakeholders → counterexamples and facts → final judgment.
STAGES = {
    'independent': {'units': ALL_ISSUE_UNITS, 'lectures': ('W6-부정의 3요소', 'W6-사기 레시피'), 'extra': (UNSECURED,)},
    'cross': {'units': ALL_ISSUE_UNITS, 'lectures': ('W3-합리화 4유형', 'W2-인지부조화'), 'extra': (TERMS, UNSECURED)},
    'rebuttal': {'cited': True},
    'alternatives': {'lectures': ('W5-독립성 위협', 'W5-안전장치·의구심', 'W2-에토스', 'W6-회색지대·공정한 표시'), 'extra': (TERMS,)},
    'perspectives': {'lectures': ('W7-공리주의·칸트', 'W7-공동체주의', 'W7-통합 판단', 'W7-이중 질문', 'W4-아서앤더슨·두 나침반', 'W4-월드콤·시스템1·2')},
    'professor': {'units': ALL_ISSUE_UNITS, 'cited': True, 'lectures': ('W4-아서앤더슨·두 나침반',), 'extra': (UNSECURED,)},
    'revision': {'cited': True},
    'consensus': {'cited': True}}


def size(text):
    return len(text.encode('utf-8'))


def sections(materials):
    """Bundle produced by debate.bundle_files → {file name: [(line number, text)]}."""
    out = {}
    for piece in re.split(r'(?m)^## 자료: ', materials or '')[1:]:
        name, _, body = piece.partition('\n')
        rows = []
        for line in body.split('\n'):
            m = re.match(r'^L(\d+): ?(.*)$', line)
            if m: rows.append((int(m.group(1)), m.group(2)))
        out[name.strip()] = rows
    return out


def kifrs_units(secs):
    units = {}
    for prefix, name in KIFRS_FILES.items():
        rows, current = secs.get(name, []), None
        for n, text in rows:
            m = re.match(r'^### 문단 (\S+) \((.*)\)\s*$', text)
            if m:
                current = {'id': f'{prefix}:{m.group(1)}', 'file': name, 'title': f'{name[3:].removesuffix(".md").replace("_", " ")} 문단 {m.group(1)} ({m.group(2)})', 'rows': [(n, text)]}
                units[current['id']] = current
            elif text.startswith('#'): current = None
            elif current is not None: current['rows'].append((n, text))
    for unit in units.values():
        unit['rows'] = [r for r in unit['rows'] if r[1].strip()]
    return units


def lecture_unit(secs, uid):
    name, start, end = LECTURES[uid]
    rows = secs.get(name)
    if not rows: return None
    first = next((i for i, (_, text) in enumerate(rows) if text.strip().startswith(start)), None)
    if first is None: return None
    last = next((i for i in range(first + 1, len(rows)) if rows[i][1].strip().startswith(end)), len(rows))
    return {'id': uid, 'file': name, 'title': f'{name} {rows[first][0]}~{rows[last - 1][0]}행', 'rows': [r for r in rows[first:last] if r[1].strip()]}


def list_units(materials):
    """Units a student may attach to a correction request."""
    secs = sections(materials)
    return [{'id': u['id'], 'title': u['title']} for u in kifrs_units(secs).values()]


def resolve_units(materials, ids):
    units = kifrs_units(sections(materials))
    return [units[i] for i in ids if i in units]


def abridged(unit):
    """The local K-IFRS files keep some paragraphs as excerpts with marker lines such as '(⑵~⑷ 생략)'."""
    return any(re.fullmatch(r'\s*\*?\s*\([^()]*생략\)\s*', text) for _, text in unit['rows'])


def render(unit):
    note = ' · 발췌(생략 표시된 하위 항목은 원문 미제공)' if abridged(unit) else ''
    return f"### [{unit['id']}] {unit['title']} · {unit['file']}{note}\n" + '\n'.join(f'L{n}: {text}' for n, text in unit['rows'])


def compact_case(rows):
    """Table pipes and repeated spaces only; wording and line numbers stay as in the case file."""
    out = []
    for n, text in rows:
        if re.fullmatch(r'\s*\|?(\s*:?-{3,}:?\s*\|?)+\s*', text): continue
        line = re.sub(r'\s{2,}', ' ', re.sub(r'\s*\|\s*', ' ', text)).strip()
        if line: out.append(f'L{n}: {line}')
    return '\n'.join(out)


PARA = r'[A-Z]{0,2}\d+(?:\.\d+)*'


def _paragraph_refs(text, standard):
    """'제1109호 문단 3.2.6~3.2.7, B3.2.16' → [('3.2.6', '3.2.7'), ('B3.2.16', '')]."""
    refs = []
    for m in re.finditer(rf'{standard}호[^\n]{{0,12}}?문단\s*({PARA}(?:\s*(?:[~∼–\-,·]|및|과|와)\s*{PARA})*)', text):
        refs += re.findall(rf'({PARA})(?:\s*[~∼–\-]\s*({PARA}))?', m.group(1))
    return refs


def cited_units(text, units):
    """Paragraph units referenced by file:line, by unit ID or by '제XXXX호 문단 N'. A range 'N~M' covers the units between."""
    found = [uid for uid, unit in units.items()
             if any(f"{unit['file']}:L{n}" in text for n, _ in unit['rows']) or f'[{uid}]' in text or f'"{uid}"' in text]
    for prefix in KIFRS_FILES:
        ids = [uid for uid in units if uid.startswith(prefix + ':')]
        if not prefix[1:].isdigit() or not ids: continue
        for start, end in _paragraph_refs(text, prefix[1:]):
            first, last = f'{prefix}:{start}', f'{prefix}:{end}' if end else ''
            if first in ids and last in ids and ids.index(first) <= ids.index(last): found += ids[ids.index(first):ids.index(last) + 1]
            else: found += [uid for uid in (first, last) if uid in ids]
    return list(dict.fromkeys(uid for uid in units if uid in found))


def pack(materials, stage, budget, shared=''):
    """Return (text, manifest, used) for the stage. used = {(file, line)} that auxiliary excerpts must skip:
    lines given whole, and lines of required units held back for size, so they never come back in part."""
    plan = STAGES.get(stage, {'cited': True}); secs = sections(materials); units = kifrs_units(secs)
    blocks, used = [], set(); manifest = {'source_plan': VERSION, 'stage': stage, 'case_file': None, 'units': [], 'abridged': [], 'lectures': [], 'omitted': [], 'extra': 0}
    header = ('[필수 근거 묶음 · 과제 원문·기준서 문단·강의 범위는 선택 자료에 있는 그대로 전체를 넣으며 자르지 않음. '
              '제목에 발췌 표시가 있는 문단은 원 기준서의 일부 하위 항목만 담고 있다. 인용은 파일:L행으로 하라. '
              '아래 보조 발췌에 없는 내용은 미확인으로 남겨라. 누락 목록에 있는 근거가 필요한 판단은 보류하라.]\n')
    room = budget - size(header) - 400
    case = next((name for name in secs if 'PBL' in name), None)
    if case:
        text = f'## 자료: {case} · 과제 원문(표 구분 기호와 연속 공백만 정리, 문구·행 번호는 원문 그대로)\n' + compact_case(secs[case])
        if size(text) <= room:
            blocks.append(text); room -= size(text) + 1; manifest['case_file'] = case
            used.update((case, n) for n, _ in secs[case])
        else: manifest['omitted'].append({'id': case, 'reason': '입력 한도'})
    else: manifest['omitted'].append({'id': '(PBL) 과제 원문', 'reason': '선택 자료에 없음'})
    wanted = list(plan.get('units', ()))
    if plan.get('cited'):
        wanted = list(dict.fromkeys(cited_units(shared, units) + wanted))  # cited paragraphs first
    for kind, ids, lookup in (('units', wanted, units.get), ('lectures', plan.get('lectures', ()), lambda uid: lecture_unit(secs, uid))):
        for uid in ids:
            unit = lookup(uid)
            if unit is None: manifest['omitted'].append({'id': uid, 'reason': '선택 자료에 없음'}); continue
            used.update((unit['file'], n) for n, _ in unit['rows'])  # whole or held back; never excerpted in part
            text = render(unit)
            if size(text) > room: manifest['omitted'].append({'id': uid, 'reason': '입력 한도'}); continue
            blocks.append(text); room -= size(text) + 1; manifest[kind].append(uid)
            if kind == 'units' and abridged(unit): manifest['abridged'].append(uid)
    for text in plan.get('extra', ()):
        if size(text) <= room: blocks.append(text); room -= size(text) + 1; manifest['extra'] += 1
    omitted = [o['id'] for o in manifest['omitted'] if o['reason'] == '입력 한도']
    if omitted: header += '[필수 근거 누락 · 입력 한도] ' + ', '.join(omitted) + '\n'
    return header + '\n'.join(blocks), manifest, used


def remainder(materials, used):
    """Bundle of selected lines outside the required units, for auxiliary excerpts."""
    parts = []
    for name, rows in sections(materials).items():
        if 'PBL' in name: continue
        kept = [f'L{n}: {text}' for n, text in rows if (name, n) not in used]
        if any(line.split(': ', 1)[-1].strip() for line in kept): parts.append(f'\n## 자료: {name}\n' + '\n'.join(kept))
    return ''.join(parts)


def digest(text):
    return hashlib.sha256(text.encode('utf-8')).hexdigest()
