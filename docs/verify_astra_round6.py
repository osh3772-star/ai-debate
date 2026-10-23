"""Offline round 6 review. No AI/CLI calls, no application or saved-run mutations."""
import copy
import hashlib
import json
from pathlib import Path
import sys
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import context_plan as cp
import debate as d
import research_protocol as p
from test_course_guidance import CourseGuidanceTests, synthetic_run, ORDER


def main():
    helper = CourseGuidanceTests()
    cfg = json.loads((ROOT/'ui_config.json').read_text(encoding='utf-8-sig'))
    paths = [ROOT.parent/name if kind == 'local' else ROOT.parent/'K_IFRS_기준서'/name
             for kind, name in (mid.split(':', 1) for mid in cfg['materials'])]
    materials = d.bundle_files(paths)[0]
    out = {'scope': 'Offline synthetic records and actual selected material packing; no real AI responses',
           'source_hashes': {n: hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in
                             ('debate.py', 'context_plan.py', 'research_protocol.py', 'source_plan.py', 'ui_server.py', 'ui_config.json')},
           'selected_materials': len(paths), 'configured_agents': len(cfg['agents'])}
    with patch.object(d, 'model_call', side_effect=AssertionError('MODEL FORBIDDEN')), \
         patch.object(d.subprocess, 'Popen', side_effect=AssertionError('CLI FORBIDDEN')):
        state = helper.full_state(version=3)
        lq = state['turns'][1]['parsed']['legality_checks'][0]
        lq.update(basis='ROUND6_ORIGINAL_BASIS', uncertainty='ROUND6_ORIGINAL_UNCERTAINTY')
        ch = next(c for c in state['turns'][2]['parsed']['challenges'] if c['target_claim'] == lq['id'])
        ch.update(disposition='challenge', quote=lq['question'][:6], reason='ROUND6_CHALLENGE')
        prompt = d.build_prompt(state, 2, 1)
        out['restored_target'] = {'basis_present': lq['basis'] in prompt, 'uncertainty_present': lq['uncertainty'] in prompt,
                                  'invalid_references': p.review(state, d.run_plan(state))['invalid_references']}

        state = helper.full_state(version=3)
        support = state['turns'][3]['parsed']['challenges'][0]
        support['reason'] = 'ROUND6_CONDITION: 자금확약서가 실제 체결된 경우에만 이 주장에 동의한다.'
        prompt = d.build_prompt(state, 3, 0)
        manifest = state['deliveries']['S4A1']['shared_record']
        out['conditional_support'] = {'stage': 'alternatives', 'support_id': support['id'], 'reason_present': support['reason'] in prompt,
                                      'id_in_abridged': support['id'] in manifest['abridged'], 'shared_bytes': manifest['bytes']}

        agents, turns = synthetic_run(4, 'challenge', scale=1)
        # One unresolved critical objection about another participant's initial claim.
        critical = next(c for t in turns if t['id'] == 'S2A4' for c in t['parsed']['challenges'] if c['target_claim'] == 'S1A3.CLM1')
        critical.update(severity='critical', reason='ROUND6_CRITICAL: 이 전제가 틀리면 C안의 유동성 확보 장치가 성립하지 않는다.')
        for t in turns:
            if t['stage'] == 'rebuttal':
                t['parsed']['responses'] = [r for r in t['parsed']['responses'] if r['challenge_id'] != critical['id']]
        out['critical_objection'] = []
        for index in (3, 4, 5):
            state = helper.state(version=3, agents=d.default_agents(4), turns=copy.deepcopy(turns), materials=materials)
            reviewed = p.review(state, d.run_plan(state))
            try:
                prompt = d.build_prompt(state, index, 0)
                manifest = state['deliveries'][f'S{index+1}A1']['shared_record']
                out['critical_objection'].append({'stage': ORDER[index], 'critical_id': critical['id'], 'target_id': critical['target_claim'],
                    'linked_candidate_id': 'S4A3.C1', 'valid_critical_pending': any(c['challenge_id'] == critical['id'] and c['critical'] for c in reviewed['pending_challenges']),
                    'critical_reason_present': critical['reason'] in prompt, 'critical_full': critical['id'] in manifest['full'],
                    'critical_abridged': critical['id'] in manifest['abridged'], 'shared_bytes': manifest['bytes'],
                    'shared_omitted': manifest['omitted'], 'prompt_bytes': len(prompt.encode('utf-8')), 'call_would_pause': False})
            except d.InputPause:
                out['critical_objection'].append({'stage': ORDER[index], 'call_would_pause': True})

        state = helper.full_state(version=3)
        counter = state['turns'][11]['parsed']['review_assessment']['counterexample_checks'][0]
        counter.update(checked='미확인', sources='원문 미제공: 경쟁사 상장 일정', outcome='premise_unverified')
        for t in state['turns'][12:]:
            t['parsed']['decision']['conditions'] = ['ROUND6_UNRELATED: 보고서 파일 이름을 다시 확인한다.']
        result = p.review(state, d.run_plan(state))
        out['unrelated_condition'] = {'premise_target': counter['target_id'], 'status': result['status'],
                                      'final_decision_reasons': state['turns'][12]['protocol_checks']['reasons'],
                                      'blockers': result['blockers']}

        # Measure the same 18 configurations described by Opus, through build_prompt, for participant 1.
        out['capacity_scenarios'] = []
        for count in (3, 4, 5):
            for disposition in ('supports', 'challenge', 'unverified'):
                for scale in (0.5, 1):
                    _, turns = synthetic_run(count, disposition, scale)
                    state = helper.state(version=3, agents=d.default_agents(count), turns=turns, materials=materials, student_draft='가'*1500)
                    scenario = {'agents': count, 'disposition': disposition, 'scale': scale, 'stages': []}
                    for index, stage in enumerate(ORDER):
                        try:
                            prompt = d.build_prompt(state, index, 0)
                            delivery = state['deliveries'][f'S{index+1}A1']
                            scenario['stages'].append({'stage': stage, 'prompt_bytes': len(prompt.encode('utf-8')),
                                'shared_bytes': delivery['shared_record']['bytes'], 'required_bytes': delivery['shared_record']['required_bytes'],
                                'source_omissions': delivery['omitted']})
                        except d.ProviderError as e:
                            scenario['stages'].append({'stage': stage, 'error_category': e.category})
                    out['capacity_scenarios'].append(scenario)
    (ROOT/'docs/astra_round6_checks.json').write_text(json.dumps(out, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: out[k] for k in ('restored_target', 'conditional_support', 'critical_objection', 'unrelated_condition')}, ensure_ascii=False, indent=2))
    stages = [t for c in out['capacity_scenarios'] for t in c['stages']]
    print(json.dumps({'scenario_count': len(out['capacity_scenarios']), 'stage_builds': len(stages),
                      'errors': [t for t in stages if 'error_category' in t],
                      'prompt_bytes_min': min(t.get('prompt_bytes', 10**9) for t in stages),
                      'prompt_bytes_max': max(t.get('prompt_bytes', 0) for t in stages),
                      'source_omission_scenarios': [(s['agents'], s['disposition'], s['scale'], t['stage'], t['source_omissions'])
                                                    for s in out['capacity_scenarios'] for t in s['stages'] if t.get('source_omissions')]}, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
