"""Handover regressions: temporary files only, all CLI processes forbidden."""
import contextlib
import io
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import debate as d
import ui_server as u


class HandoverTests(unittest.TestCase):
    def setUp(self):
        blocker = patch.object(d.subprocess, 'Popen', side_effect=AssertionError('NO REAL CLI'))
        blocker.start(); self.addCleanup(blocker.stop)
        self.temp = tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)

    def test_atomic_retry_preserves_valid_destination(self):
        target = self.root/'state.json'; d.dump(target, {'old': True})
        original = Path.replace; attempts = []
        def replace(source, destination):
            attempts.append(source)
            self.assertEqual(json.loads(target.read_text()), {'old': True})
            if len(attempts) < 4: raise PermissionError('simulated Windows reader')
            return original(source, destination)
        with patch.object(Path, 'replace', replace), patch.object(d.time, 'sleep'):
            d.dump(target, {'new': True})
        self.assertEqual(len(attempts), 4)
        self.assertEqual(json.loads(target.read_text()), {'new': True})
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def test_persistent_write_failure_does_not_truncate_original(self):
        target = self.root/'state.json'; target.write_bytes(b'{"original":1}')
        with patch.object(Path, 'replace', side_effect=PermissionError('locked')), patch.object(d.time, 'sleep'):
            with self.assertRaises(PermissionError): d.dump(target, {'new': 2})
        self.assertEqual(target.read_bytes(), b'{"original":1}')
        self.assertEqual(list(self.root.glob('*.tmp')), [])

    def google_paths(self):
        folder = self.root/'.gemini/antigravity-cli'; folder.mkdir(parents=True)
        return folder, folder/'settings.json'

    def test_google_stale_lock_restores_crash_backup(self):
        folder, config = self.google_paths()
        original = b'{"keep":"original"}\r\n'
        config.write_bytes(b'{"restricted":true}')
        (folder/'ai-debate-settings.backup').write_bytes(original)
        (folder/'ai-debate-settings.lock').write_text('2147483647')
        with patch.object(d.Path, 'home', return_value=self.root), patch.object(d, 'pid_is_alive', return_value=False):
            with d.google_settings_guard():
                self.assertEqual(json.loads(config.read_bytes())['keep'], 'original')
                self.assertEqual((folder/'ai-debate-settings.lock').read_text(), str(os.getpid()))
        self.assertEqual(config.read_bytes(), original)
        self.assertFalse((folder/'ai-debate-settings.backup').exists())
        self.assertFalse((folder/'ai-debate-settings.lock').exists())

    def test_google_live_legacy_lock_is_not_overwritten(self):
        folder, config = self.google_paths(); config.write_bytes(b'{"keep":1}')
        lock = folder/'ai-debate-settings.lock'; lock.write_text(str(os.getpid()))
        with patch.object(d.Path, 'home', return_value=self.root):
            with self.assertRaises(RuntimeError):
                with d.google_settings_guard(): self.fail('entered live lock')
        self.assertEqual(lock.read_text(), str(os.getpid()))
        self.assertEqual(config.read_bytes(), b'{"keep":1}')

    def test_google_absent_original_recovered_and_nested_owner_blocked(self):
        folder, config = self.google_paths(); config.write_bytes(b'{"restricted":true}')
        (folder/'ai-debate-settings.absent').touch()
        with patch.object(d.Path, 'home', return_value=self.root):
            with d.google_settings_guard():
                self.assertTrue(config.exists())
                with self.assertRaises(RuntimeError):
                    with d.google_settings_guard(): self.fail('second owner entered')
        self.assertFalse(config.exists())

    def test_google_exception_restores_exact_bytes(self):
        folder, config = self.google_paths(); original = b'\xef\xbb\xbf{"keep":1}\r\n'; config.write_bytes(original)
        with patch.object(d.Path, 'home', return_value=self.root):
            with self.assertRaisesRegex(ValueError, 'fixture'):
                with d.google_settings_guard(): raise ValueError('fixture')
        self.assertEqual(config.read_bytes(), original)

    def test_json_chatter_braces_and_multiple_objects(self):
        value = {'analysis':'문자열 {내부}와 "인용"', 'claims':[{'id':'c1'}], 'conclusion':'결론'}
        raw = json.dumps(value, ensure_ascii=False)
        for content in (raw, '안내\n```json\n'+raw+'\n```\n끝', 'prefix {}\n'+raw+'\n{} tail'):
            parsed = d.parse_answer(content)
            self.assertEqual(parsed['claims'], value['claims'])
            self.assertEqual(parsed['conclusion'], '결론')

    def test_malformed_fields_keep_raw_and_allow_next_turn(self):
        state = {'created':d.now(),'mode':'smoke','topic':'OFFLINE','agents':d.default_agents(3),
                 'materials':'fixture','timeout':30,'turns':[],'status':'created'}
        answer = '{"analysis":"fixture","claims":null,"audit":17,"proposals":[false],"_schema_warnings":5}'
        with patch.object(d, 'model_call', return_value=(answer, {}, '')), contextlib.redirect_stdout(io.StringIO()):
            d.execute(state, self.root, max_turns=1)
            d.execute(state, self.root, max_turns=1)
        self.assertEqual(len(state['turns']), 2)
        self.assertEqual(state['turns'][0]['answer'], answer)
        self.assertTrue(state['turns'][0]['parsed']['_schema_warnings'])
        self.assertFalse((self.root/'runner.lock').exists())

    def test_report_failure_always_releases_runner_lock(self):
        state = {'created':d.now(),'mode':'smoke','topic':'OFFLINE','agents':d.default_agents(3),
                 'materials':'fixture','timeout':30,'turns':[],'status':'created'}
        with patch.object(d, 'render', side_effect=OSError('fixture disk error')), contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            self.assertFalse(d.execute(state, self.root))
        self.assertFalse((self.root/'runner.lock').exists())
        self.assertEqual(json.loads((self.root/'debate.json').read_text(encoding='utf-8'))['status'], 'failed')

    def test_json_lines_ignore_noise_but_require_completion(self):
        noise = 'Warning: update available\nnull\n[]\n{"invalid"}\n'
        codex = noise + json.dumps({'type':'item.completed','item':{'type':'agent_message','text':'OK'}})+'\n'+json.dumps({'type':'turn.completed'})
        google = noise + json.dumps({'event':'result','result':{'status':'SUCCESS','response':'OK'}})
        claude = noise + json.dumps({'type':'result','is_error':False,'result':'OK'})
        for provider, output in (('codex',codex),('google',google),('claude',claude)):
            self.assertEqual(d.extract(provider, output)[0], 'OK')
            with self.assertRaises(RuntimeError):d.extract(provider, noise)

    def test_quotes_match_full_decoded_text_not_prefix(self):
        source = json.dumps({'analysis':'매출 인식의 판단에는 계약 내용을 검토해야 한다.\n반드시 독립 검증이 필요하다.'}, ensure_ascii=False)
        self.assertTrue(d.quote_matches_answer('“매출 인식의 판단에는 계약 내용을 검토해야 한다. 반드시 독립 검증이 필요하다.”', source))
        self.assertFalse(d.quote_matches_answer('매출 인식의 판단에는 계약 내용을 검토하지 않아도 된다.', source))
        self.assertFalse(d.quote_matches_answer('***', source))
        self.assertFalse(d.quote_matches_answer('23', '{"analysis":"2*3"}'))

    def test_large_materials_and_peer_context_fit_budget_with_provenance(self):
        materials = '\n'.join(f'## 자료: {file}.md\n'+'\n'.join(f'L{i}: 인지부조화 매출 검토 자료 {i} '+('가나다 '*30) for i in range(700)) for file in range(12))
        state = {'mode':'research','agents':d.default_agents(5),'topic':'OFFLINE','materials':materials,'turns':[]}
        first = d.build_prompt(state,0,0)
        for file in range(12): self.assertIn(f'## 자료: {file}.md', first)
        self.assertIn('자료 발췌', first); self.assertIn('생략 부분은 미확인', first)
        for i in range(25):
            state['turns'].append({'id':f'S{i//5+1}A{i%5+1}','name':'fixture','stage':'cross','answer':'X'*100000,
                'parsed':{'conclusion':'CONCLUSION_SENTINEL','claims':[{'claim':'CLAIM_SENTINEL'}],'audit':[{'error':'AUDIT_SENTINEL'}]}})
        final = d.build_prompt(state,5,0)
        self.assertLessEqual(len(final.encode('utf-8')), d.MAX_PROMPT_BYTES)
        self.assertIn('CLAIM_SENTINEL', final); self.assertIn('AUDIT_SENTINEL', final)
        self.assertNotIn('CONCLUSION_SENTINEL', d.build_prompt(state,0,1))
        self.assertEqual(state['materials'], materials)

    def test_new_consensus_and_saved_legacy_slots(self):
        state = {'mode':'consensus','agents':d.default_agents(4)}
        self.assertEqual(len(d.run_plan(state)), 6)
        state['version']=2
        self.assertEqual([s[0] for s in d.run_plan(state)], ['independent','cross','rebuttal','consensus'])
        state['protocol_version']=2
        self.assertEqual([s[0] for s in d.run_plan(state)][3:], ['alternatives','professor','consensus'])

    def test_case_and_rubric_preserved_before_lecture_excerpts(self):
        case='L1: CASE_BEGIN\n'+('L2: 사례 세부 조건\n'*900)+'L902: CASE_LAST_REQUIREMENT'
        bundle='\n## 자료: (PBL)사례.md\n'+case+'\n## 자료: 2주차.md\n'+('L1: 강의자료\n'*12000)
        selected=d.material_context(bundle)
        self.assertIn(case, selected)
        self.assertIn('## 자료: 2주차.md', selected)
        self.assertLessEqual(len(selected.encode('utf-8')),d.MATERIAL_CONTEXT_BYTES)

    def test_student_mask_and_reserved_upload_names(self):
        for value in ('202012345홍길동','202012345_홍길동','202012345 홍길동'):
            self.assertEqual(d.redact(value), '[STUDENT_ID_NAME]')
        project = self.root/'project'; project.mkdir()
        app = u.ControlApp(project, self.root)
        for name in ('CON.md','con.backup.txt','LPT1.txt','COM¹.txt','NUL.md','a:b.md'):
            with self.subTest(name=name), self.assertRaises(u.UIError):app.upload({'name':name,'content':'fixture'})
        self.assertEqual(list(app.uploads.glob('*')), [])

    def test_activity_survives_view_selection_without_calling_models(self):
        from unittest.mock import Mock
        project = self.root/'project'; project.mkdir()
        app = u.ControlApp(project, self.root)
        worker = Mock(); worker.is_alive.return_value = True
        app.active = {'id':'fixture-running','thread':worker}
        self.assertEqual(app.activity(), {'active_run':'fixture-running'})
        self.assertEqual(app.bootstrap()['active_run'], 'fixture-running')
        worker.is_alive.return_value = False
        self.assertEqual(app.activity(), {'active_run':None})


if __name__ == '__main__':unittest.main()
