"""Read-only local audit. No CLI, model, server or existing-run invocation.

Writes only peer_audit_measurements.json next to this script.
35 KB is a configured-context scenario, not a measured debate run.
"""
from pathlib import Path
import copy
import json
import re
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import debate as d


def forbid_model(*args, **kwargs):
    raise AssertionError('Model calls are forbidden in this audit')


d.model_call = forbid_model
cfg = json.loads((ROOT / 'ui_config.json').read_text(encoding='utf-8'))
folders = {'local': ROOT.parent, 'kifrs': ROOT.parent / 'K_IFRS_기준서', 'upload': ROOT / 'ui_uploads'}
files = [folders[kind] / name for kind, name in (mid.split(':', 1) for mid in cfg['materials'])]
materials, manifest = d.bundle_files(files)
state = dict(protocol_version=d.protocol.VERSION, review_policy_version=d.protocol.REVIEW_POLICY_VERSION,
             domain=cfg.get('domain') or 'accounting_pbl', mode=cfg['mode'], topic=cfg['topic'],
             instructions=cfg.get('instructions', ''), agents=cfg['agents'], materials=materials,
             evidence='', turns=[], web_research=cfg.get('web_research', True))
schedule = d.run_plan(state)


def sections(text):
    return {name.strip(): body for name, _, body in
            (s.partition('\n') for s in re.split(r'(?m)^## 자료: ', text)[1:])}


def numbered(text):
    return {int(n): line for n, line in re.findall(r'(?m)^L(\d+): (.*)$', text)}


originals = sections(materials)
scenarios = []
for label, budget in [('independent', 55000), ('shared_context_48000_bytes_scenario', 35000)]:
    rendered = d.material_context(materials, budget=budget)
    selected = sections(rendered)
    rows = []
    for name, body in originals.items():
        full = numbered(body)
        got = numbered(selected.get(name, ''))
        complete = sum(full.get(i) == text for i, text in got.items())
        rows.append(dict(file=name, original_lines=len(full), represented_lines=len(got),
                         complete_lines=complete, represented_line_pct=round(100 * len(got) / len(full), 3),
                         source_bytes=len(body.encode('utf-8')), excerpt_bytes=len(selected.get(name, '').encode('utf-8'))))
    scenarios.append(dict(label=label, budget_bytes=budget, actual_bytes=len(rendered.encode('utf-8')), files=rows))

terms = ['페스팅어', '4대 합리화', '사기 삼각대', '시스템 1', '독립성 위협', '에토스',
         'Steelman', '합법성', 'SCQA', 'original_question', 'revised_question']
stage_checks = []
for i, (sid, title, instruction) in enumerate(schedule):
    explicit = d.get_base_prompt(state) + instruction + d.protocol.contract(state, sid, f'S{i+1}A1', schedule)
    stage_checks.append(dict(stage=sid, terms_in_explicit_instructions={term: term in explicit for term in terms}))
first_prompt = d.build_prompt(copy.deepcopy(state), 0, 0)
result = dict(scope='offline inspection; no model call or debate', source_file_count=len(files),
              raw_file_bytes=sum(p.stat().st_size for p in files), bundled_bytes=len(materials.encode('utf-8')),
              first_prompt_bytes=len(first_prompt.encode('utf-8')), phases=[s[0] for s in schedule],
              stage_checks=stage_checks, terms_in_full_first_prompt={t: t in first_prompt for t in terms},
              scenarios=scenarios,
              note='Line coverage counts represented L-numbered lines; it is not semantic coverage. Partial lines may count. The 35 KB case is a scenario, not an observed later round.')
out = Path(__file__).with_name('peer_audit_measurements.json')
out.write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
print(json.dumps({k: result[k] for k in ['scope', 'source_file_count', 'raw_file_bytes', 'bundled_bytes', 'first_prompt_bytes', 'terms_in_full_first_prompt']}, ensure_ascii=False))
for s in scenarios:
    print(s['label'], s['actual_bytes'])
    for row in s['files']:
        print(row['file'], f"{row['represented_lines']}/{row['original_lines']}", row['represented_line_pct'])
