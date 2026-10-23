"""Read-only review probes. Synthetic records are NOT model responses. No CLI/network calls."""
import copy
import hashlib
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import debate as d
import research_protocol as p
import source_plan as sp
from test_course_guidance import CourseGuidanceTests, synthetic_materials


def review_info(state):
    result = p.review(state, d.run_plan(state))
    return {k: result.get(k) for k in ('status', 'blockers', 'expected_reviews', 'missing_peer_reviews',
                                       'final_review_issues', 'requirements', 'assignment_record')}


def main():
    case = CourseGuidanceTests()
    out = {'scope': 'Offline prompts, source packs and synthetic record checks; no model or CLI call',
           'source_hashes': {name: hashlib.sha256((ROOT/name).read_bytes()).hexdigest()
                             for name in ('debate.py', 'research_protocol.py', 'source_plan.py', 'ui_server.py', 'ui_config.json')}}
    with patch.object(d, 'model_call', side_effect=AssertionError('MODEL FORBIDDEN')), \
         patch.object(d.subprocess, 'Popen', side_effect=AssertionError('CLI FORBIDDEN')):
        state = case.full_state(version=2)
        initial = [t for t in state['turns'] if t['stage'] == 'independent']
        initial[1]['parsed']['legality_checks'][0]['question'] = 'ASTRA_LQ_UNIQUE_QUESTION'
        initial[1]['parsed']['legality_checks'][0]['basis'] = 'ASTRA_LQ_UNIQUE_BASIS'
        shared = d.protocol_context(initial)
        prompt = d.build_prompt(state, 1, 0)
        out['cross_input'] = {
            'legality_checks_in_saved_records': sum(len(t['parsed']['legality_checks']) for t in initial),
            'original_LQ_id_in_shared_context': 'S1A2.LQ1' in shared,
            'original_question_in_cross_prompt': 'ASTRA_LQ_UNIQUE_QUESTION' in prompt,
            'original_basis_in_cross_prompt': 'ASTRA_LQ_UNIQUE_BASIS' in prompt,
            'cross_prompt_instructs_review_LQ_ID': 'LQ ID' in prompt,
        }
        state = case.full_state(version=2)
        for t in state['turns']:
            if t['stage'] == 'cross':
                t['parsed']['challenges'] = [c for c in t['parsed']['challenges'] if '.LQ' not in str(c.get('target_claim'))]
        out['no_legality_cross_review'] = review_info(state)
        for t in state['turns']:
            for c in t['parsed'].get('legality_checks', []):
                for key in ('question', 'basis', 'uncertainty'):
                    c.pop(key, None)
        out['missing_legality_record_fields'] = review_info(state)

        state = case.full_state(version=2)
        for t in state['turns']:
            if t['stage'] == 'professor':
                a = t['parsed']['review_assessment']
                a.pop('fact_checks', None)
                for c in a.get('counterexample_checks', []):
                    for key in ('sources', 'checked', 'scope', 'holds', 'assumption_change'):
                        c.pop(key, None)
        result = review_info(state)
        out['previous_missing_evidence_probe'] = {k: result[k] for k in ('status', 'blockers', 'final_review_issues')}

        materials = synthetic_materials(big_b66=True)
        unit = sp.kifrs_units(sp.sections(materials))['K1115:B66']
        shared = 'S1A1 주장: 제1115호 문단 B66에 따라 재매입 약정을 검토한다.'
        out['oversize_unit_auxiliary_reentry'] = []
        for budget in (4000, 6000, 8000):
            text, delivery = d.planned_materials({'materials': materials}, 'rebuttal', budget, shared)
            out['oversize_unit_auxiliary_reentry'].append({
                'budget': budget, 'material_bytes': len(text.encode('utf-8')), 'delivery': delivery,
                'full_unit_present': sp.render(unit) in text,
                'body_text_present': unit['rows'][1][1] in text,
            })

        cfg = json.loads((ROOT/'ui_config.json').read_text(encoding='utf-8-sig'))
        paths = []
        for mid in cfg['materials']:
            kind, name = mid.split(':', 1)
            if kind == 'local': paths.append(ROOT.parent/name)
            elif kind == 'kifrs': paths.append(ROOT.parent/'K_IFRS_기준서'/name)
            else: raise ValueError('Unexpected material kind: ' + kind)
        materials = d.bundle_files(paths)[0]
        units = sp.kifrs_units(sp.sections(materials))
        out['actual_materials'] = {'selected': len(paths), 'bundled_bytes': sp.size(materials), 'scenarios': []}
        for budget in (55000, 35000):
            for sid in ('independent', 'cross', 'rebuttal', 'alternatives', 'perspectives', 'professor', 'revision'):
                text, delivery = d.planned_materials({'materials': materials}, sid, budget, '')
                out['actual_materials']['scenarios'].append({
                    'stage': sid, 'budget': budget, 'bytes': sp.size(text), 'units': len(delivery['units']),
                    'lectures': len(delivery['lectures']), 'omitted': delivery['omitted'],
                    'all_reported_units_whole': all(sp.render(units[uid]) in text for uid in delivery['units']),
                })
        out['cited_units'] = {
            expression: sp.cited_units(expression, units) for expression in
            ('제1109호 문단 3.2.6', '제1109호 문단 3.2.6~3.2.7',
             '제1109호 문단 B3.2.16', '[K1109:B3.2.16]')}
    path = ROOT/'docs/astra_round4_checks.json'
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({'output': str(path), 'cross_input': out['cross_input'],
                      'prior_gap_now': out['previous_missing_evidence_probe']['status'],
                      'R1_without_cross_review': out['no_legality_cross_review']['requirements'][0],
                      'R1_missing_record_fields': out['missing_legality_record_fields']['requirements'][0],
                      'partial_reentry': [{k: v for k, v in r.items() if k != 'delivery'} |
                                          {'omitted': r['delivery']['omitted']} for r in out['oversize_unit_auxiliary_reentry']],
                      'cited_units': out['cited_units']}, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
