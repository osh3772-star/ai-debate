"""Offline review only: no model/CLI calls; preserve previous review measurements."""
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


def benchmark_turns(count, disputed=False):
    """Synthetic, bounded prose; every peer checks 8 claims and 4 initial judgments."""
    helper = CourseGuidanceTests()
    turns = []
    for author in range(1, count + 1):
        claims = [dict(claim=f'모의 쟁점 {i}: 계약의 실질과 위험 보유 조건을 원문으로 대조해야 한다. 가격 조건은 추가 확인이 필요하다.',
                       kind='assumption', source='07_제1109호_금융상품.md:L8~L14', status='모의 검토', check='계약 원문 미제공') for i in range(1, 9)]
        legality = [dict(item=item, question=f'{item}의 허용 조건은 무엇인가?', judgment='undetermined',
                         basis='제공된 사실에 계약 조건이 부족하므로 원문과 추가 대조해야 한다.', uncertainty='계약 가격과 의무의 구체적 내용 미확인') for item in p.LEGALITY_ITEM_NAMES]
        turns.append(helper.turn(f'S1A{author}', 'independent', claims=claims, legality_checks=legality))
    for reviewer in range(1, count + 1):
        checks = []
        for t in turns[:count]:
            if t['id'] == f'S1A{reviewer}':
                continue
            for field in ('claims', 'legality_checks'):
                for item in t['parsed'][field]:
                    checks.append(dict(target_claim=item['id'], target_turn=t['id'], quote=item.get('claim') or item['question'],
                                       disposition='challenge' if disputed else 'supports', severity='critical' if disputed else 'normal',
                                       reason='모의 검토: 적용 조건과 예외를 함께 대조했다. 계약 조건이 확인되면 이 판단을 다시 검토한다.',
                                       evidence='07_제1109호_금융상품.md:L8~L14'))
        turns.append(helper.turn(f'S2A{reviewer}', 'cross', challenges=checks))
    return turns


def measure_context(turns, extra=()):
    keys = ('claims', 'challenges', 'responses', 'candidates', 'candidate_seeds', 'review_assessment', 'ethics_assessment',
            'provisional_position', 'position_change', 'unresolved', *extra)
    records = []
    for t in turns:
        parsed = d.normalize_answer(t['parsed'])
        records.append(dict(turn=t['id'], name=t['name'], stage=t['stage'], **{k: parsed[k] for k in keys if parsed.get(k)}))
    size = len(json.dumps(records, ensure_ascii=False).encode('utf-8'))
    try:
        d.protocol_context(turns, extra)
        result = 'fits'
    except d.ProviderError as e:
        result = e.category
    return {'essential_bytes': size, 'actual_protocol_context_result': result}


def main():
    out = {'scope': 'Offline prompts and synthetic capacity scenarios, not actual AI responses',
           'source_hashes': {n: hashlib.sha256((ROOT/n).read_bytes()).hexdigest() for n in
                             ('debate.py', 'research_protocol.py', 'source_plan.py', 'ui_server.py', 'ui_config.json')}}
    helper = CourseGuidanceTests()
    with patch.object(d, 'model_call', side_effect=AssertionError('MODEL FORBIDDEN')), \
         patch.object(d.subprocess, 'Popen', side_effect=AssertionError('CLI FORBIDDEN')):
        s = helper.full_state(version=2)
        target = s['turns'][1]['parsed']['legality_checks'][0]
        target.update(question='ROUND5_UNIQUE_QUESTION', basis='ROUND5_UNIQUE_BASIS', uncertainty='ROUND5_UNIQUE_UNCERTAINTY')
        for t in s['turns']:
            if t['stage'] == 'cross':
                for c in t['parsed']['challenges']:
                    if c.get('target_claim') == target['id']:
                        c.update(quote=target['question'], disposition='challenge', reason='원질문의 전제를 재검토하라.')
        cross = d.build_prompt(s, 1, 0)
        rebuttal = d.build_prompt(s, 2, 1)
        out['legality_delivery'] = {
            'cross_has_id_question_basis_uncertainty': all(x in cross for x in (target['id'], target['question'], target['basis'], target['uncertainty'])),
            'rebuttal_has_target_id': target['id'] in rebuttal,
            'rebuttal_has_question_quote': target['question'] in rebuttal,
            'rebuttal_has_target_basis': target['basis'] in rebuttal,
            'rebuttal_has_target_uncertainty': target['uncertainty'] in rebuttal,
        }
        result = p.review(s, d.run_plan(s))
        out['legality_delivery']['valid_challenge_reference'] = not result['invalid_references']
        no_checks = helper.full_state(version=2)
        for t in no_checks['turns']:
            if t['stage'] == 'cross':
                t['parsed']['challenges'] = [c for c in t['parsed']['challenges'] if '.LQ' not in str(c.get('target_claim'))]
        result = p.review(no_checks, d.run_plan(no_checks))
        out['no_legality_cross_review'] = result['requirements'][0]
        for t in no_checks['turns']:
            for c in t['parsed'].get('legality_checks', []):
                for key in ('question', 'basis', 'uncertainty'): c.pop(key, None)
        out['missing_legality_fields'] = p.review(no_checks, d.run_plan(no_checks))['requirements'][0]
        materials = synthetic_materials(big_b66=True)
        unit = sp.kifrs_units(sp.sections(materials))['K1115:B66']
        out['omitted_unit_reentry'] = []
        for budget in (4000, 6000, 8000):
            text, delivery = d.planned_materials({'materials': materials}, 'rebuttal', budget, '제1115호 문단 B66')
            out['omitted_unit_reentry'].append({'budget': budget, 'whole_present': sp.render(unit) in text,
                                               'body_present': unit['rows'][1][1] in text, 'omitted': delivery['omitted']})
        out['capacity_scenarios'] = []
        out['design_simulation_not_implemented'] = []
        for count in (2, 3, 4, 5):
            for disputed in (False, True):
                turns = benchmark_turns(count, disputed)
                out['capacity_scenarios'].append({'agents': count, 'claims_per_agent': 8, 'legality_per_agent': 4,
                                                  'cross_checks_total': count*(count-1)*12, 'all_cross_checks': 'challenge' if disputed else 'supports',
                                                  **measure_context(turns)})
                if disputed:
                    projected = copy.deepcopy(turns)
                    for t in projected:
                        if t['stage'] == 'independent' and t['id'] != 'S1A1':
                            t['parsed'].pop('legality_checks', None)
                        if t['stage'] == 'cross':
                            t['parsed']['challenges'] = [c for c in t['parsed']['challenges'] if c.get('target_turn') == 'S1A1']
                    out['design_simulation_not_implemented'].append({
                        'agents': count, 'policy': 'All initial claims; agent 1 own LQ originals; all incoming challenges to agent 1',
                        'incoming_challenges': sum(len(t['parsed'].get('challenges', [])) for t in projected),
                        **measure_context(projected, ('legality_checks',))})
        cfg = json.loads((ROOT/'ui_config.json').read_text(encoding='utf-8-sig'))
        out['current_config_agents'] = len(cfg['agents'])
        files = [ROOT.parent/name if kind == 'local' else ROOT.parent/'K_IFRS_기준서'/name
                 for kind, name in (mid.split(':', 1) for mid in cfg['materials'])]
        materials = d.bundle_files(files)[0]
        out['full_budget_sources'] = []
        for sid in ('independent', 'cross', 'professor'):
            text, delivery = d.planned_materials({'materials': materials}, sid, 55000, '')
            out['full_budget_sources'].append({'stage': sid, 'units': len(delivery['units']), 'omitted': delivery['omitted'],
                                               'abridged': delivery['abridged'], 'has_3_2_3': 'K1109:3.2.3' in delivery['units']})
    path = ROOT/'docs/astra_round5_checks.json'
    path.write_text(json.dumps(out, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
    print(json.dumps({k: out[k] for k in ('legality_delivery', 'omitted_unit_reentry', 'capacity_scenarios', 'design_simulation_not_implemented', 'full_budget_sources', 'current_config_agents')}, ensure_ascii=False, indent=2))


if __name__ == '__main__': main()
