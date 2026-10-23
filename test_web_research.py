"""Offline web policy regressions. No real model or provider process."""
import contextlib
import io
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch
import debate as d
import ui_server as u


class WebResearchTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        blocker = patch.object(d.subprocess, 'Popen', side_effect=AssertionError('No real CLI'))
        blocker.start(); self.addCleanup(blocker.stop)

    def state(self, enabled=True, mode='research'):
        return dict(version=3, protocol_version=2, created=d.now(), mode=mode,
                    topic='회계윤리 PBL', instructions='', status='created',
                    agents=d.default_agents(2), materials='과제 자료', evidence='',
                    manifest=[], timeout=30, turns=[], web_research=enabled, offline_fixture=True)

    def test_provider_web_tools_preserve_other_restrictions(self):
        with patch.object(d, 'binary', return_value='OFFLINE-CLI'):
            for provider in ('codex', 'claude', 'codebuddy'):
                cmd = d.cli_command(provider, self.root, {'web_research': True})
                if provider == 'codex':
                    self.assertIn('web_search="live"', cmd)
                    self.assertIn('features.shell_tool=false', cmd)
                    self.assertEqual(cmd[cmd.index('--sandbox')+1], 'read-only')
                    self.assertIn('forced_login_method="chatgpt"', cmd)
                else:
                    self.assertEqual(cmd[cmd.index('--tools')+1], 'WebSearch,WebFetch')
                    self.assertEqual(cmd[cmd.index('--allowedTools')+1], 'WebSearch,WebFetch')
                    self.assertIn('--strict-mcp-config', cmd)
                    self.assertEqual(cmd[cmd.index('--max-turns')+1], '10')
                    self.assertNotIn('--dangerously-skip-permissions', cmd)
                if provider == 'claude':
                    policy = json.loads(cmd[cmd.index('--settings')+1])
                    self.assertEqual(policy['forceLoginMethod'], 'claudeai')
                    self.assertTrue(policy['disableAllHooks'])
                    for name in ('Bash','PowerShell','Read','Write','Edit','mcp__*'):
                        self.assertIn(name, policy['permissions']['deny'])
                    self.assertNotIn('WebSearch', policy['permissions']['deny'])
                if provider == 'codebuddy':
                    self.assertEqual(cmd[cmd.index('--model')+1], d.CODEBUDDY_MODEL)

    def test_probes_keep_web_disabled(self):
        with patch.object(d, 'binary', return_value='OFFLINE-CLI'):
            for provider in ('codex','claude','codebuddy'):
                cmd = d.cli_command(provider, self.root)
                if provider == 'codex': self.assertIn('web_search="disabled"', cmd)
                else: self.assertEqual(cmd[cmd.index('--tools')+1], '')

    def test_google_web_permission_restores_exact_original(self):
        folder = self.root/'.gemini/antigravity-cli'; folder.mkdir(parents=True)
        config = folder/'settings.json'
        original = b'{"keep":"unchanged","permissions":{"allow":["command(*)"]}}\r\n'
        config.write_bytes(original)
        with patch.object(d.Path, 'home', return_value=self.root):
            with d.google_settings_guard(True):
                policy = json.loads(config.read_text())
                self.assertFalse(policy['useG1Credits'])
                self.assertEqual(policy['permissions']['allow'], ['read_url(*)'])
                self.assertNotIn('read_url(*)', policy['permissions']['deny'])
                for rule in ('execute_url(*)','write_file(*)','read_file(*)','command(*)','unsandboxed(*)','mcp(*)'):
                    self.assertIn(rule, policy['permissions']['deny'])
            self.assertEqual(config.read_bytes(), original)
            with d.google_settings_guard():
                self.assertIn('read_url(*)', json.loads(config.read_text())['permissions']['deny'])
            self.assertEqual(config.read_bytes(), original)

    def test_context_prioritizes_sources_and_preserves_legacy(self):
        state = self.state()
        prompt = d.build_prompt(state, 0, 0)
        for text in ('선택적 공개 웹 검증','과제 원문/자료 전체','모델의 자기 보고','web_checks'):
            self.assertIn(text, prompt)
        self.assertNotIn('파일/터미널/MCP/브라우저 도구를 사용하지 마라', prompt)
        state.pop('web_research')
        self.assertFalse(d.web_enabled(state))
        self.assertNotIn('선택적 공개 웹 검증', d.get_base_prompt(state))
        self.assertTrue(d.web_enabled(self.state(True, 'smoke')))
        self.assertFalse(d.web_enabled(self.state(False, 'smoke')))

    def test_engine_passes_policy_and_preserves_web_records(self):
        for mode, expected in [('research',True),('smoke',True)]:
            run = self.root/mode; run.mkdir()
            state = self.state(True, mode)
            check = dict(claim_id='c1', reason='OFFLINE_REASON', query='OFFLINE_QUERY',
                         url='https://example.org/source', title='OFFLINE_TITLE',
                         checked_at='OFFLINE_TIME', passage='OFFLINE_PASSAGE',
                         result='inconclusive', limitation='OFFLINE_LIMIT')
            answer = json.dumps(dict(analysis='OFFLINE_FIXTURE', web_checks=[check]))
            raw = [{'type':'OFFLINE_TOOL_EVENT'}]
            with patch.object(d, 'model_call', return_value=(answer, raw, '')) as call, contextlib.redirect_stdout(io.StringIO()):
                d.execute(state, run, max_turns=1)
            self.assertEqual(call.call_args.kwargs['settings']['web_research'], expected)
            saved = json.loads((run/'debate.json').read_text(encoding='utf-8'))
            self.assertEqual(saved['turns'][0]['parsed']['web_checks'], [check])
            self.assertEqual(saved['turns'][0]['raw'], raw)
            report = (run/'evidence_register.md').read_text(encoding='utf-8')
            for text in ('OFFLINE_QUERY','OFFLINE_PASSAGE','OFFLINE_TIME','OFFLINE_LIMIT','모델 자기 보고'):
                self.assertIn(text, report)

    def test_malformed_web_fields(self):
        for value in (None, 'wrong', 3):
            self.assertEqual(d.normalize_answer({'web_checks':value})['web_checks'], [])
        self.assertEqual(d.normalize_answer({'web_checks':[None,'wrong',{}]})['web_checks'], [{}])

    def test_ui_default_and_explicit_disable(self):
        app = u.ControlApp(self.root, self.root); config = app.defaults()
        self.assertTrue(app.validate_config(config)['web_research'])
        config['web_research'] = False
        self.assertFalse(app.validate_config(config)['web_research'])
        config['web_research'] = 'false'
        with self.assertRaises(u.UIError): app.validate_config(config)


if __name__ == '__main__':
    unittest.main()
