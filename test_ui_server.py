"""Offline control-panel tests. No real CLI or model is ever executed."""
import http.client
import json
from pathlib import Path
import tempfile
import threading
import time
import unittest
import subprocess
import sys
from unittest.mock import patch
from urllib.parse import quote
import ui_server as u
import debate as d

class ControlTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.base=Path(self.temp.name)
        self.root=self.base/'ai-debate';self.root.mkdir();(self.root/'web').mkdir()
        for name in ('index.html','app.js','style.css'):(self.root/'web'/name).write_text('LOCAL TEST',encoding='utf-8')
        (self.base/'2주차_PRE.md').write_text('연구 자료',encoding='utf-8')
        (self.base/'7주차_PRE.md').write_text('선택하지 않은 자료',encoding='utf-8')
        self.app=u.ControlApp(self.root,self.base)
        self.server,_=u.create_server(0,self.app)
        self.thread=threading.Thread(target=self.server.serve_forever,daemon=True);self.thread.start()
        self.port=self.server.server_port
        self.no_model=patch.object(d,'model_call',side_effect=AssertionError('실제 모델 호출 금지'))
        self.mock_model=self.no_model.start()
    def tearDown(self):
        self.app.close();self.server.shutdown();self.server.server_close();self.thread.join();self.no_model.stop();self.temp.cleanup()
    def request(self,path,method='GET',value=None,headers=None):
        conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=5)
        heads={'Host':f'127.0.0.1:{self.port}'}
        if method=='POST':heads.update({'Content-Type':'application/json','X-CSRF-Token':self.app.csrf})
        heads.update(headers or {})
        conn.request(method,path,json.dumps(value).encode('utf-8') if value is not None else None,heads)
        res=conn.getresponse();raw=res.read();status=res.status;ctype=res.getheader('Content-Type');conn.close()
        return status,json.loads(raw) if ctype.startswith('application/json') else raw
    def join_worker(self):
        self.app.active['thread'].join(timeout=5)
        self.assertFalse(self.app.active['thread'].is_alive())

    def test_load_config_preview_do_not_infer(self):
        for path in ('/','/api/bootstrap','/api/activity','/api/runs','/api/config','/api/material?id=local%3A2%EC%A3%BC%EC%B0%A8_PRE.md'):
            self.assertEqual(self.request(path)[0],200)
        code,body=self.request('/api/bootstrap')
        self.assertTrue(body['no_inference_on_load'])
        self.assertEqual(body['defaults']['materials'],['local:2주차_PRE.md'])
        code,_=self.request('/api/config','POST',{'config':body['defaults']});self.assertEqual(code,200)
        self.assertEqual(self.mock_model.call_count,0)
        self.assertEqual(self.app.list_runs(),[])

    def test_server_lease_blocks_another_port_and_releases_on_close(self):
        with self.assertRaises(u.ServerAlreadyRunning):u.create_server(0,u.ControlApp(self.root,self.base))
        self.server.shutdown();self.server.server_close();self.thread.join()
        replacement,_=u.create_server(0,u.ControlApp(self.root,self.base))
        replacement.server_close()

    def test_server_lease_blocks_a_second_process_for_the_same_project(self):
        script=('import sys,ui_server as u\n'
                'try: s,a=u.create_server(0,u.ControlApp(sys.argv[1],sys.argv[1]))\n'
                'except u.ServerAlreadyRunning: sys.exit(7)\n'
                's.server_close();sys.exit(9)\n')
        result=subprocess.run([sys.executable,'-B','-c',script,str(self.root)],cwd=Path(u.__file__).parent,
                              capture_output=True,timeout=15)
        self.assertEqual(result.returncode,7,result.stderr.decode(errors='replace'))
        self.assertEqual(self.request('/api/activity'),(200,{'active_run':None}))

    def test_start_requires_consent_and_valid_csrf_origin(self):
        cfg=self.app.defaults()
        self.assertEqual(self.request('/api/start','POST',cfg)[0],403)
        cfg['approve_transfer']=True
        self.assertEqual(self.request('/api/start','POST',cfg,{'X-CSRF-Token':'wrong'})[0],403)
        self.assertEqual(self.request('/api/start','POST',cfg,{'Origin':'https://foreign.example'})[0],403)
        self.assertEqual(self.request('/api/start','POST',cfg,{'Host':'foreign.example'})[0],403)
        self.assertEqual(self.request('/api/start','POST',cfg,{'Content-Type':'text/plain'})[0],415)
        self.assertEqual(self.request('/api/resume','POST',{'run':'missing'})[0],403)
        self.assertEqual(self.mock_model.call_count,0)
        self.assertEqual(self.app.list_runs(),[])

    def test_rejected_post_with_unread_body_is_answered_not_reset(self):
        # An early 403 used to close the socket with the body unread, which Windows can turn into a connection reset.
        body=json.dumps({'run':'offline','pad':'x'*(2*1024*1024)}).encode('utf-8')
        for _ in range(8):
            conn=http.client.HTTPConnection('127.0.0.1',self.port,timeout=10)
            conn.request('POST','/api/start',body,{'Host':f'127.0.0.1:{self.port}','Content-Type':'application/json','X-CSRF-Token':'wrong'})
            res=conn.getresponse();status=res.status;data=json.loads(res.read());conn.close()
            self.assertEqual(status,403);self.assertIn('error',data)
        self.assertEqual(self.mock_model.call_count,0)

    def test_model_catalog_has_claude_versions_and_argon_without_inference(self):
        code,body=self.request('/api/bootstrap');self.assertEqual(code,200)
        catalog=body['providers']
        claude={m['id']:m['label'] for m in catalog['claude']['models']}
        for family in ('opus','sonnet','haiku'):
            self.assertIn('claude-'+family+'-5-5',claude)
            self.assertIn('5.5',claude['claude-'+family+'-5-5'])
            self.assertIn(family,claude)
        google={m['id']:m['label'] for m in catalog['google']['models']}
        self.assertIn('gemini-4-argon',google)
        self.assertIn('Argon',google['gemini-4-argon'])
        self.assertIn('gemini-3.8-flash',google)
        cfg=body['defaults'];cfg['agents'][1]['model']='sonnet';cfg['agents'][2]['model']='gemini-4-argon'
        checked=self.app.validate_config(cfg)
        self.assertEqual(checked['agents'][1]['model'],'sonnet')
        self.assertEqual(checked['agents'][2]['model'],'gemini-4-argon')
        cfg['agents'][1]['model']='claude-custom-version'
        self.assertEqual(self.app.validate_config(cfg)['agents'][1]['model'],'claude-custom-version')
        self.assertEqual(self.mock_model.call_count,0)

    def test_paths_upload_validation_and_no_inference(self):
        self.assertEqual(self.request('/api/material?id=local:../secret.md')[0],404)
        for name in ('../private.md','private.exe','C:\\private.md'):
            self.assertEqual(self.request('/api/upload','POST',{'name':name,'content':'test'})[0],400)
        code,uploaded=self.request('/api/upload','POST',{'name':'사용자 자료.md','content':'추가 연구 자료'})
        self.assertEqual(code,200)
        self.assertTrue(uploaded['material']['id'].startswith('upload:'))
        self.assertEqual(self.mock_model.call_count,0)
        cfg=self.app.defaults();cfg['agents'][2]['model']='claude-opus'
        with self.assertRaises(u.UIError):self.app.validate_config(cfg)

    def test_deepseek_catalog_and_consensus_config_do_not_infer(self):
        code,body=self.request('/api/bootstrap');self.assertEqual(code,200)
        codebuddy=body['providers']['codebuddy']
        self.assertEqual(codebuddy['default_model'],'deepseek-v4.1-flash')
        self.assertEqual(codebuddy['models'],[{'id':'deepseek-v4.1-flash','label':'DeepSeek V4.1 Flash'}])
        self.assertIn('high',codebuddy['efforts'])
        self.assertIn('minimal',codebuddy['efforts'])
        # Existing three-provider defaults stay intact; adding a fourth is deliberate.
        cfg=body['defaults']
        self.assertEqual([a['provider'] for a in cfg['agents']],['codex','claude','google'])
        cfg.update(mode='consensus')
        cfg['agents'].append({'provider':'codebuddy','name':'DeepSeek 검토자','model':'deepseek-v4.1-flash','effort':'','instructions':'가정과 반례 검토'})
        code,saved=self.request('/api/config','POST',{'config':cfg});self.assertEqual(code,200)
        self.assertEqual(saved['config']['mode'],'consensus')
        self.assertEqual(saved['config']['agents'][3]['model'],'deepseek-v4.1-flash')
        code,loaded=self.request('/api/config');self.assertEqual(code,200)
        self.assertEqual(loaded['config'],saved['config'])
        for model in ('','auto','gpt-test','deepseek-other'):
            cfg['agents'][3]['model']=model
            self.assertEqual(self.request('/api/config','POST',{'config':cfg})[0],400)
        cfg['agents'][3].update(model='deepseek-v4.1-flash',effort='unsupported_xyz')
        with self.assertRaises(u.UIError):self.app.validate_config(cfg)
        cfg['agents'][3].update(model='deepseek-v4.1-flash',effort='high')
        self.assertEqual(self.app.validate_config(cfg)['agents'][3]['effort'],'high')
        self.assertEqual(self.mock_model.call_count,0)
        self.assertEqual(self.app.list_runs(),[])

    def test_codebuddy_live_final_event_is_displayed_without_other_provider_changes(self):
        self.app.latest['offline']={'text':''}
        self.app.on_update('offline',{'event':'model_event','id':'S1A4','provider':'codebuddy','data':{'type':'result','result':'DeepSeek OFFLINE RESPONSE'}})
        self.assertEqual(self.app.latest['offline']['text'],'DeepSeek OFFLINE RESPONSE')
        self.assertEqual(self.mock_model.call_count,0)

    def test_stale_lock_recovery_keeps_live_processes(self):
        folder=self.app.runs/'offline-record';folder.mkdir();lock=folder/'runner.lock'
        lock.write_text('12345',encoding='utf-8')
        with patch.object(u,'pid_is_alive',return_value=True):
            with self.assertRaises(u.UIError):self.app._ensure_idle()
        self.assertTrue(lock.exists())
        with patch.object(u,'pid_is_alive',return_value=False):self.app._ensure_idle()
        self.assertFalse(lock.exists())
        self.assertEqual(self.mock_model.call_count,0)

    def test_explicit_start_selection_config_and_resume(self):
        self.no_model.stop()
        fixture=json.dumps({'analysis':'OFFLINE FIXTURE','claims':[],'audit':[],'conclusion':'검사용'},ensure_ascii=False)
        calls=[]
        def fake(provider,prompt,timeout,settings=None,on_event=None,stop_event=None):
            calls.append((provider,prompt,settings))
            if on_event:on_event({'type':'item.completed','item':{'type':'agent_message','text':fixture}})
            return fixture,{'offline_fixture':True},''
        with patch.object(d,'model_call',side_effect=fake):
            cfg=self.app.defaults();cfg.update(mode='smoke',max_turns=1,approve_transfer=True,topic='검사',instructions='공통 지시')
            cfg['agents'][0].update(model='gpt-test',effort='high',instructions='개별 지시')
            code,body=self.request('/api/start','POST',cfg);self.assertEqual(code,200)
            self.join_worker();rid=body['run']
            s=self.app.snapshot(rid);self.assertEqual(s['status'],'paused');self.assertEqual(len(s['turns']),1)
            self.assertIn('연구 자료',calls[0][1]);self.assertNotIn('선택하지 않은 자료',calls[0][1])
            self.assertEqual(calls[0][2]['model'],'gpt-test');self.assertIn('개별 지시',calls[0][1])
            (self.base/'2주차_PRE.md').write_text('나중에 바뀐 원본',encoding='utf-8')
            code,_=self.request('/api/resume','POST',{'run':rid,'approve_transfer':True});self.assertEqual(code,200)
            self.join_worker();self.assertEqual(len(self.app.snapshot(rid)['turns']),2)
            self.assertIn('연구 자료',calls[1][1]);self.assertNotIn('나중에 바뀐 원본',calls[1][1])
            for name in u.REPORTS:  # the browser sends encodeURIComponent(name); 00_결과_요약.md is not ASCII
                self.assertEqual(self.request('/api/report?run='+rid+'&name='+quote(name))[0],200,name)
            self.assertEqual(self.request('/api/report?run='+rid+'&name=../../private')[0],404)
        self.no_model.start()

    def test_pause_live_and_stop_are_owned(self):
        self.no_model.stop();entered=threading.Event();release=threading.Event()
        fixture=json.dumps({'analysis':'OFFLINE FIXTURE','claims':[],'audit':[]})
        def waiting(provider,prompt,timeout,settings=None,on_event=None,stop_event=None):
            if provider=='claude':on_event({'type':'assistant','message':{'content':[{'type':'text','text':'부분 응답'}]}})
            else:on_event({'type':'item.completed','item':{'type':'agent_message','text':'부분 응답'}})
            entered.set()
            while not release.wait(.01):
                if stop_event.is_set():raise d.RunStopped('offline stop')
            return fixture,{},''
        with patch.object(d,'model_call',side_effect=waiting) as mocked:
            cfg=self.app.defaults();cfg.update(approve_transfer=True,mode='smoke')
            rid=self.app.start(cfg)['run'];self.assertTrue(entered.wait(3))
            view=self.app.snapshot(rid);self.assertEqual(view['live']['text'],'부분 응답')
            with self.assertRaises(u.UIError):self.app.start(cfg)
            self.app.pause(rid);release.set();self.join_worker();self.assertEqual(self.app.snapshot(rid)['status'],'paused')
            entered.clear();release.clear();self.app.resume({'run':rid,'approve_transfer':True});self.assertTrue(entered.wait(3))
            self.app.stop(rid);self.join_worker()
            self.assertEqual(self.app.snapshot(rid)['status'],'stopped_by_user')
            self.assertEqual(len(self.app.snapshot(rid)['turns']),1)
            self.assertEqual(self.app.snapshot(rid)['live'],None)
            saved=u.load_json(self.app.runs/rid/'debate.json')
            self.assertEqual(saved['interrupted_drafts'][0]['text'],'부분 응답')
            self.assertFalse((self.app.runs/rid/'runner.lock').exists())
            self.assertEqual(mocked.call_count,2)
        self.no_model.start()

    def test_delete_run_removes_folder_and_blocks_active(self):
        # 1. 존재하지 않는 실행 삭제 요청은 404
        with self.assertRaises(u.UIError) as ctx:
            self.app.delete_run('nonexistent-run')
        self.assertEqual(ctx.exception.status, 404)

        # 2. 유효한 실행 폴더 생성 후 삭제
        test_rid = '20261020-000000-smoke-delete01'
        run_dir = self.app.runs / test_rid
        run_dir.mkdir(parents=True, exist_ok=True)
        (run_dir / 'debate.json').write_text(json.dumps({'topic': '삭제 테스트', 'status': 'stopped', 'turns': []}), encoding='utf-8')
        (run_dir / 'debate_log.md').write_text('테스트 로그', encoding='utf-8')
        self.assertTrue(run_dir.is_dir())

        result = self.app.delete_run(test_rid)
        self.assertEqual(result['deleted'], test_rid)
        self.assertFalse(run_dir.exists())

        # 3. HTTP API 엔드포인트 POST /api/delete_run 검증
        test_rid2 = '20261020-000000-smoke-delete02'
        run_dir2 = self.app.runs / test_rid2
        run_dir2.mkdir(parents=True, exist_ok=True)
        (run_dir2 / 'debate.json').write_text(json.dumps({'topic': '삭제 테스트 2', 'status': 'completed', 'turns': []}), encoding='utf-8')
        
        status, payload = self.request('/api/delete_run', 'POST', {'run': test_rid2})
        self.assertEqual(status, 200)
        self.assertEqual(payload.get('deleted'), test_rid2)
        self.assertFalse(run_dir2.exists())

    def test_two_agents_validation(self):
        # 1. 2인 에이전트 설정 검증 성공
        cfg = self.app.defaults()
        cfg['agents'] = [
            {'provider': 'codex', 'name': 'GPT', 'model': '', 'effort': 'medium', 'instructions': ''},
            {'provider': 'claude', 'name': 'Claude', 'model': '', 'effort': '', 'instructions': ''}
        ]
        checked = self.app.validate_config(cfg)
        self.assertEqual(len(checked['agents']), 2)
        self.assertEqual(checked['agents'][0]['provider'], 'codex')
        self.assertEqual(checked['agents'][1]['provider'], 'claude')

        # 2. 1인 에이전트는 2명 미만이므로 거부 (UIError 400)
        cfg_one = dict(cfg, agents=[cfg['agents'][0]])
        with self.assertRaises(u.UIError) as ctx:
            self.app.validate_config(cfg_one)
        self.assertIn('2~5명', str(ctx.exception))

if __name__=='__main__':unittest.main()
