"""Loopback-only control panel. Import, GET, save, preview never invoke a model."""
from __future__ import annotations
import argparse
import copy
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import re
import secrets
import shutil
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse, quote
import uuid
import webbrowser
import ctypes
import errno
import urllib.request
import debate as d
import result_digest
import submitted_audit

REPORTS=['00_결과_요약.md','research_dossier.md','alternatives_c.md','evidence_register.md','ai_audit.md','debate_log.md','report_outline.md','professor_review.md','summary.md','ai_usage_appendix.md','debate.json','events.jsonl']
DERIVED_REPORTS=['report_writing_plan.md']  # Read-only projections; not files produced by debate.execute().
MAX_FILE=2*1024*1024
MAX_DRAFT=3000
MAX_CORRECTION_QUESTION=2000
MAX_CORRECTION_REASON=1000
MAX_VERDICT_NOTE=2000
AUDIT_KEY=re.compile(r'S\d{1,3}A\d{1,2}#\d{1,3}')
UNIT_ID=re.compile(r'K(?:CF|\d{4}):[0-9A-Za-z.\-]{1,20}')
MAX_BODY=4*1024*1024

class UIError(Exception):
    def __init__(self,message,status=400):super().__init__(message);self.status=status

def load_json(path,default=None):
    for attempt in range(5):
        try:return json.loads(Path(path).read_text(encoding='utf-8-sig'))
        except FileNotFoundError:return copy.deepcopy(default)
        except (OSError,ValueError):
            if attempt<4:time.sleep(.01*(attempt+1))
    return copy.deepcopy(default)

def text(value,name,limit,required=False):
    if not isinstance(value,str) or len(value)>limit:raise UIError(f'{name}: 최대 {limit}자 문자열을 입력하세요')
    if required and not value.strip():raise UIError(name+'을 입력하세요')
    return d.redact(value.strip())

def integer(value,name,minimum,maximum):
    if isinstance(value,bool) or not isinstance(value,int) or not minimum<=value<=maximum:raise UIError(f'{name}: {minimum}~{maximum} 범위의 정수 필요')
    return value

def provider_catalog():
    cached=load_json(Path.home()/'.codex/models_cache.json',{}) or {}
    models=[]
    for model in cached.get('models',[]):
        mid=model.get('slug') or model.get('id')
        if isinstance(mid,str) and mid.startswith('gpt-') and 'review' not in mid:
            models.append({'id':mid,'label':model.get('display_name') or mid})
    return {
      'codex':{'label':'GPT · Codex','models':models,'efforts':['','low','medium','high','xhigh','max','ultra']},
      'claude':{'label':'Claude · Claude Code','models':[
          {'id':'claude-sonnet-5-5','label':'Sonnet 5.5'},
          {'id':'claude-opus-5-5','label':'Opus 5.5'},
          {'id':'claude-fable-5-1','label':'Fable 5.1'},
          {'id':'claude-haiku-5-5','label':'Haiku 5.5'},
          {'id':'sonnet','label':'Sonnet'},
          {'id':'opus','label':'Opus'},
          {'id':'haiku','label':'Haiku'}],
          'default_model':'claude-sonnet-5-5',
          'source':'Claude Code /model (2026-10-20)','efforts':['','low','medium','high','xhigh','max','ultra']},
      'google':{'label':'Gemini · Antigravity','models':[
          {'id':'gemini-4-argon','label':'Gemini 4 Argon'},
          {'id':'gemini-3.8-flash','label':'Gemini 3.8 Flash'}
      ],
          'default_model':'gemini-4-argon','source':'Antigravity CLI 1.4.2: agy models (2026-10-19)','efforts':['','high','medium','low']},
      'codebuddy':{'label':'DeepSeek · CodeBuddy','models':[{'id':'deepseek-v4.1-flash','label':'DeepSeek V4.1 Flash'}],
          'default_model':'deepseek-v4.1-flash','source':'공식 CodeBuddy CLI 2.170.0 --help (2026-10-20)','efforts':['','minimal','low','medium','high','xhigh','max']}}

def pid_is_alive(pid):
    if pid<=0:return False
    if os.name=='nt':
        kernel=ctypes.WinDLL('kernel32',use_last_error=True)
        kernel.OpenProcess.restype=ctypes.c_void_p
        handle=kernel.OpenProcess(0x1000,False,pid)
        if not handle:return ctypes.get_last_error()!=87  # access denied means do not touch it
        try:
            code=ctypes.c_ulong()
            if not kernel.GetExitCodeProcess(ctypes.c_void_p(handle),ctypes.byref(code)):return True
            return code.value==259
        finally:kernel.CloseHandle(ctypes.c_void_p(handle))
    try:os.kill(pid,0);return True
    except OSError as e:return e.errno!=errno.ESRCH

class ControlApp:
    def __init__(self,root=None,material_root=None):
        self.root=Path(root or d.ROOT).resolve()
        self.runs=self.root/'runs';self.runs.mkdir(exist_ok=True)
        self.material_root=Path(material_root or self.root.parent).resolve()
        self.uploads=self.root/'ui_uploads'
        self.csrf=secrets.token_urlsafe(32)
        self.lock=threading.RLock()
        self.active=None
        self.latest={}
        self.overviews={}  # run → (debate.json size and mtime, result overview); the page polls every 1.5 s
        self.catalog=provider_catalog()
        self.config_path=self.root/'ui_config.json'

    KIFRS_DIR_NAME = 'K_IFRS_기준서'
    PROTECTED_MATERIALS = {
        '(PBL)7주차_중간PBL과제.md', '2주차_IN (1).md', '2주차_PRE.md',
        '3주차_IN.md', '3주차_PRE (1).md', '4주차_IN.md', '4주차_PRE.md',
        '5주차_IN.md', '5주차_PRE.md', '6주차_IN.md', '6주차_PRE.md', '7주차_PRE.md',
        '00_재무보고를_위한_개념체계.md', '01_제1001호_재무제표_표시.md', '02_제1002호_재고자산.md',
        '03_제1008호_회계정책_회계추정치_변경과_오류.md', '04_제1036호_자산손상.md',
        '05_제1037호_충당부채_우발부채_우발자산.md', '06_제1038호_무형자산.md',
        '07_제1109호_금융상품.md', '08_제1113호_공정가치_측정.md',
        '09_제1115호_고객과의_계약에서_생기는_수익.md'
    }

    def materials(self):
        items=[]
        kifrs_folder = self.material_root / self.KIFRS_DIR_NAME
        groups=[('local',self.material_root),('kifrs',kifrs_folder),('upload',self.uploads)]
        for kind,folder in groups:
            if not folder.exists():continue
            for p in sorted(folder.iterdir(),key=lambda p:p.name):
                if not p.is_file() or p.suffix.lower() not in ('.md','.txt') or p.is_symlink():continue
                if not p.resolve().is_relative_to(folder.resolve()) or p.stat().st_size>MAX_FILE:continue
                selected=(kind=='local' and ('PBL' in p.name or bool(re.match(r'^[2-6]주차',p.name)))) or kind=='kifrs'
                protected=p.name in self.PROTECTED_MATERIALS
                mid=kind+':'+p.name
                display_name=f"[기준서] {p.name}" if kind=='kifrs' else p.name
                items.append({'id':mid,'name':display_name,'raw_name':p.name,'bytes':p.stat().st_size,'selected':selected,'protected':protected})
        return items

    def material_path(self,mid):
        if not isinstance(mid,str) or mid not in {m['id'] for m in self.materials()}:raise UIError('선택할 수 없는 자료입니다',404)
        kind,name=mid.split(':',1)
        if kind=='local': return self.material_root/name
        if kind=='kifrs': return (self.material_root/self.KIFRS_DIR_NAME)/name
        return self.uploads/name

    def delete_material(self,mid):
        p=self.material_path(mid)
        if p.name in self.PROTECTED_MATERIALS:
            raise UIError('기본 강의 및 과제 필수 자료는 보호되어 있어 삭제할 수 없습니다',400)
        try:
            p.unlink()
        except Exception as e:
            raise UIError(f'자료 파일 삭제 실패: {e}',500)
        return {'deleted':mid,'materials':self.materials()}

    def cleanup_junk_materials(self):
        junk_patterns = [
            re.compile(r'^s\d+a\d+_.*\.txt$', re.IGNORECASE),
            re.compile(r'^.*_prompt\.txt$', re.IGNORECASE),
            re.compile(r'^verification_.*\.txt$', re.IGNORECASE),
        ]
        deleted = []
        for p in self.material_root.iterdir():
            if not p.is_file() or p.name in self.PROTECTED_MATERIALS:
                continue
            if any(pat.match(p.name) for pat in junk_patterns):
                try:
                    p.unlink()
                    deleted.append(p.name)
                except Exception:
                    pass
        return {'deleted_count':len(deleted),'deleted':deleted,'materials':self.materials()}

    def defaults(self):
        return {'topic':'넥서스AI 회계윤리 PBL: A/B 비교와 실행 가능한 C안','instructions':'','mode':'research','smoke_rounds':2,'agents':[
          {'provider':'codex','name':d.ROLES[0],'model':'','effort':'medium','instructions':''},
          {'provider':'claude','name':d.ROLES[1],'model':'claude-sonnet-5-5','effort':'','instructions':''},
          {'provider':'google','name':d.ROLES[2],'model':'gemini-4-argon','effort':'high','instructions':''}],
          'domain':'accounting_pbl','timeout':600,'max_turns':None,'web_research':True,'student_draft':'','submitted_cases':[],'materials':[m['id'] for m in self.materials() if m['selected']]}

    def validate_config(self,value):
        if not isinstance(value,dict):raise UIError('설정 형식 오류')
        mode=value.get('mode','research')
        if mode not in ('research','smoke','consensus'):raise UIError('토론 모드 오류')
        domain=value.get('domain') or ('accounting_pbl' if mode=='research' else 'general')
        if domain not in ('accounting_pbl','general'):raise UIError('연구 분야 오류')
        agents=value.get('agents')
        if not isinstance(agents,list) or not 2<=len(agents)<=5:raise UIError('참가자는 2~5명이어야 합니다')
        checked=[]
        for i,a in enumerate(agents):
            if not isinstance(a,dict) or a.get('provider') not in d.PROVIDERS:raise UIError('공급자 오류')
            p=a['provider'];model=text(a.get('model',''),'모델',160)
            if model and not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9_.() \-]*',model):raise UIError('모델 ID에 사용할 수 없는 문자')
            if p=='google' and model and not model.lower().startswith('gemini'):raise UIError('Gemini 참가자는 Gemini 모델을 선택하세요')
            if p=='codebuddy' and model!='deepseek-v4.1-flash':raise UIError('DeepSeek 참가자는 확인된 모델 ID deepseek-v4.1-flash를 선택하세요')
            effort=a.get('effort','')
            if effort not in self.catalog[p]['efforts']:raise UIError(p+'의 추론 강도 오류')
            checked.append({'provider':p,'name':text(a.get('name',''),'참가자 이름',80,True),'model':model,'effort':effort,'instructions':text(a.get('instructions',''),'AI별 지시',16000),'is_moderator':bool(a.get('is_moderator',False))})
        mids=value.get('materials',[])
        if not isinstance(mids,list) or len(mids)>40 or len(set(mids))!=len(mids):raise UIError('자료 선택 오류')
        for mid in mids:self.material_path(mid)
        maximum=value.get('max_turns')
        if maximum in ('',0):maximum=None
        if maximum is not None:maximum=integer(maximum,'최대 발언 수',1,200)
        web_research=value.get('web_research',True)
        if not isinstance(web_research,bool):raise UIError('웹 검증 설정은 켜기/끄기 값이어야 합니다')
        smoke_rounds=value.get('smoke_rounds',2)
        if smoke_rounds in ('',None):smoke_rounds=2
        smoke_rounds=integer(smoke_rounds,'토론 라운드 수',1,20)
        try: submitted = submitted_audit.validate(value.get('submitted_cases', []), d.redact)
        except ValueError as e: raise UIError(str(e)) from None
        if submitted and mode == 'smoke': raise UIError('의심 답변 검증은 연구 또는 합의 모드에서 사용하세요.')
        return {'topic':text(value.get('topic',''),'주제',12000,True),'instructions':text(value.get('instructions',''),'공통 지시',20000),'mode':mode,'domain':domain,'smoke_rounds':smoke_rounds,'agents':checked,
                'materials':mids,'timeout':integer(value.get('timeout',600),'발언 제한 시간',30,3600),'max_turns':maximum,'web_research':web_research,
                'student_draft':text(value.get('student_draft',''),'내 첫 생각',MAX_DRAFT),'submitted_cases':submitted}

    def connection_status(self):
        # Cached local metadata only. No CLI invocation, keychain read or model call.
        meta=load_json(self.root/'environment_status.json',{'providers':{}}) or {'providers':{}}
        tests=self.runs/'individual-tests'
        for p in d.PROVIDERS:
            status=meta.setdefault('providers',{}).setdefault(p,{})
            probes=[]
            for file in tests.glob('*.json') if tests.exists() else []:
                item=load_json(file,{}) or {}
                passed=item.get('passed') is True or (p=='codex' and item.get('answer')=='CODEX_SUBSCRIPTION_OK')
                if item.get('provider')==p and passed:probes.append(item)
            if probes:
                latest=max(probes,key=lambda v:v.get('time',''))
                status['probe']={'passed':True,'time':latest.get('time'),'source':'저장된 실제 연결 확인 기록','model':latest.get('model')}
        meta['cached']=True
        return meta

    def run_path(self,rid):
        if not isinstance(rid,str) or not re.fullmatch(r'[A-Za-z0-9_\-]{1,120}',rid):raise UIError('실행 ID 오류',404)
        p=self.runs/rid
        if not p.is_dir() or p.is_symlink() or not (p/'debate.json').is_file():raise UIError('실행 기록 없음',404)
        return p

    def delete_run(self,rid):
        p=self.run_path(rid)
        with self.lock:
            if self.active and self.active['id']==rid and self.active['thread'].is_alive():
                raise UIError('현재 진행 중인 연구는 먼저 중단하세요',400)
            try:
                shutil.rmtree(p)
            except Exception as e:
                raise UIError(f'실행 기록 삭제 실패: {e}',500)
        return {'deleted':rid,'runs':self.list_runs()}

    def list_runs(self):
        result=[]
        for folder in self.runs.iterdir():
            if not folder.is_dir() or folder.is_symlink():continue
            s=load_json(folder/'debate.json')
            if not isinstance(s,dict):continue
            count=len(s.get('turns',[]));agents=s.get('agents',[])
            total=len(d.run_plan(s))*len(agents)
            result.append({'id':folder.name,'topic':s.get('topic',''),'status':s.get('status','unknown'),'created':s.get('created',''),'turns':count,'total_turns':total})
        return sorted(result,key=lambda v:v['created'],reverse=True)

    def snapshot(self,rid):
        p=self.run_path(rid);s=load_json(p/'debate.json')
        if not isinstance(s,dict):raise UIError('상태를 읽는 중입니다. 잠시 후 새로고침하세요',409)
        with self.lock:
            active=bool(self.active and self.active['id']==rid and self.active['thread'].is_alive())
            live=copy.deepcopy(self.latest.get(rid)) if active else None
        state_status=s['status']
        if not active and state_status in ('running','starting'):state_status='interrupted'
        turns=[{key:t.get(key) for key in ('id','run_id','attempt_id','name','provider','model','effort','stage','stage_title','answer','parsed','time','execution_metadata','protocol_checks','delivery')} for t in s.get('turns',[])]
        attempts=[{key:a.get(key) for key in ('id','turn_id','run_id','attempt_id','number','retry_of','provider','time','ended_at','status','error_category')} for a in s.get('attempts',[])]
        agent_reports = sorted([f.name for f in p.glob('agent_*.md') if f.is_file() and not f.is_symlink()])
        corrections=[c for c in s.get('corrections',[]) if isinstance(c,dict)]
        with self.lock:job=self.active.get('kind','debate') if active and self.active else None
        overview=self.result_overview(rid,p,s) if d.protocol.active(s) else None
        return {'id':rid,'topic':s.get('topic',''),'status':state_status,'created':s.get('created',''),'agents':s.get('agents',[]),'turns':turns,
                'progress':d.execution_progress(s),'attempts':attempts,
                'total_turns':len(d.run_plan(s))*len(s['agents']),'protocol_version':s.get('protocol_version',1),'mode':s['mode'],'live':live,'errors':s.get('errors',[]),'active':active,
                'available_reports':REPORTS + (DERIVED_REPORTS if overview and overview.get('report_plan') else []) + agent_reports,'web_research':d.web_enabled(s),'domain':s.get('domain'),'review_state':s.get('review_state'),'review_policy_version':s.get('review_policy_version',0),
                'course_guidance_version':s.get('course_guidance_version',0),'student_draft':s.get('student_draft',''),'submitted_cases':submitted_audit.cases(s),'submitted_audit_version':s.get('submitted_audit_version',0),'active_job':job,
                'corrections_signature':[[c.get('id'),bool(str(c.get('actual_answer','')).strip())] for c in corrections],'result_overview':overview,
                'result_document':(p/'00_결과_요약.md').is_file(),
                'pause_requested':(p/'PAUSE').exists(),'config':s.get('ui_config',{'topic':s.get('topic',''),'mode':s.get('mode'),'agents':s.get('agents',[])})}

    def result_overview(self,rid,path,state):
        """Computed from the saved record and kept until debate.json changes; a failure is shown, the rest stays readable."""
        try:
            info=(path/'debate.json').stat();key=(info.st_size,info.st_mtime_ns)
            with self.lock:cached=self.overviews.get(rid)
            if cached and cached[0]==key:return cached[1]
            overview=result_digest.overview(state,state.get('review_state'),d.run_plan(state))
            with self.lock:self.overviews[rid]=(key,overview)
            return overview
        except Exception as e:return {'error':'결과 요약을 만들지 못했습니다: '+d.redact(str(e))}

    def source_units(self,rid):
        """K-IFRS paragraph IDs present in a saved run's own materials, for a correction request. Local read only."""
        s=load_json(self.run_path(rid)/'debate.json')
        if not isinstance(s,dict):raise UIError('실행 기록을 읽을 수 없습니다',409)
        return {'run':rid,'units':d.source_plan.list_units(s.get('materials','')),'max':d.MAX_CORRECTION_UNITS}

    def report(self,rid,name):
        is_agent_report = bool(re.fullmatch(r'agent_[0-9]{2}_[A-Za-z0-9_\-가-힣]+\.md', name))
        if name not in REPORTS + DERIVED_REPORTS and not is_agent_report:raise UIError('허용되지 않은 결과 파일',404)
        if name=='report_writing_plan.md':
            path=self.run_path(rid);state=load_json(path/'debate.json')
            if not isinstance(state,dict):raise UIError('실행 기록을 읽을 수 없습니다',409)
            plan=self.result_overview(rid,path,state).get('report_plan')
            if not plan:raise UIError('회계윤리 PBL의 보고서 작성 자료가 없습니다',404)
            return result_digest.report_plan.markdown(plan)
        p=self.run_path(rid)/name
        if not p.is_file() or p.is_symlink():raise UIError('아직 생성되지 않은 결과 파일',404)
        return p.read_text(encoding='utf-8')

    def on_update(self,rid,event):
        with self.lock:
            if event['event']=='turn_started':
                a=event['agent'];self.latest[rid]={'id':event['id'],'attempt_id':event.get('attempt_id'),'run_id':event.get('run_id',rid),'name':a['name'],'provider':a['provider'],'model':a.get('model',''),'stage_title':event['stage_title'],'text':'','status':'작성 중'}
            elif event['event']=='model_event':
                live=self.latest.get(rid)
                if not live:return
                if live.get('attempt_id')!=event.get('attempt_id'):return
                e=event['data'];delta='';whole=None
                if event['provider']=='google':
                    step=e.get('step_update',{})
                    if step.get('step_type')=='agent_response':delta=step.get('text_delta','')
                elif event['provider'] in ('claude','codebuddy'):
                    raw=e.get('event',{}) if e.get('type')=='stream_event' else {}
                    sub=raw.get('delta',{})
                    if sub.get('type')=='text_delta':delta=sub.get('text','')
                    if e.get('type')=='assistant':
                        chunks=e.get('message',{}).get('content',[])
                        whole=''.join(c.get('text','') for c in chunks if c.get('type')=='text') or None
                    if event['provider']=='codebuddy' and e.get('type')=='result' and isinstance(e.get('result'),str):whole=e['result']
                elif e.get('type')=='item.completed' and e.get('item',{}).get('type')=='agent_message':whole=e['item'].get('text','')
                if whole is not None:live['text']=d.redact(whole)
                elif delta:live['text']=d.redact(live['text']+delta)
                live['updated']=d.now()
            elif event['event']=='turn_completed':
                live=self.latest.get(rid)
                if live and live.get('attempt_id')==event.get('attempt_id'):self.latest[rid]=None
            elif event['event']=='finished':self.latest[rid]=None

    def _launch(self,rid,state,max_turns):
        stop=threading.Event()
        def update(event):
            if event['event']=='finished' and event['status']!='completed':
                with self.lock:draft=copy.deepcopy(self.latest.get(rid))
                if draft and draft.get('text'):
                    state.setdefault('interrupted_drafts',[]).append({'time':d.now(),**draft})
                    d.dump(self.runs/rid/'interrupted_drafts.json',state['interrupted_drafts'])
                    d.dump(self.runs/rid/'debate.json',state)
            self.on_update(rid,event)
        def work():
            try:d.execute(state,self.runs/rid,max_turns,on_update=update,stop_event=stop)
            except Exception as e:
                state['status']='failed';state.setdefault('errors',[]).append({'time':d.now(),'error':d.redact(str(e))})
                d.render(state,self.runs/rid)
            finally:
                with self.lock:
                    self.latest[rid]=None
        thread=threading.Thread(target=work,name='debate-'+rid,daemon=True)
        self.active={'id':rid,'thread':thread,'stop':stop}
        thread.start()

    def _ensure_idle(self):
        if self.active and self.active['thread'].is_alive():raise UIError('실행 중인 토론을 먼저 중단하세요',409)
        # Recover only locks whose recorded process is definitely no longer alive.
        # Recovery happens on explicit Start/Resume, never on page load.
        for lock in self.runs.glob('*/runner.lock'):
            try:pid=int(lock.read_text(encoding='utf-8').strip())
            except (OSError,ValueError):raise UIError('실행 lock을 확인할 수 없습니다. 기존 실행기 상태를 확인하세요',409)
            if pid_is_alive(pid):raise UIError('다른 실행기가 동작 중입니다. 해당 실행기를 먼저 종료하세요',409)
            lock.unlink()

    def start(self,value):
        if value.get('approve_transfer') is not True:raise UIError('자료·지시의 외부 모델 전송에 동의한 후 시작하세요',403)
        cfg=self.validate_config(value)
        files=[self.material_path(mid) for mid in cfg['materials']]
        if sum(p.stat().st_size for p in files)>4*MAX_FILE:raise UIError('선택 자료 합계는 8MB 이하로 제한합니다')
        materials,manifest=d.bundle_files(files)
        with self.lock:
            self._ensure_idle()
            rid=time.strftime('%Y%m%d-%H%M%S')+'-'+cfg['mode']+'-'+uuid.uuid4().hex[:6]
            path=self.runs/rid
            state={'version':3,'protocol_version':d.protocol.VERSION,'review_policy_version':d.protocol.REVIEW_POLICY_VERSION,'course_guidance_version':d.protocol.COURSE_GUIDANCE_VERSION,'quote_check_version':d.protocol.QUOTE_CHECK_VERSION,'domain':cfg['domain'],'created':d.now(),'mode':cfg['mode'],'topic':cfg['topic'],'instructions':cfg['instructions'],'status':'created','agents':cfg['agents'],
                   'materials':materials,'manifest':manifest,'evidence':'','student_draft':cfg['student_draft'],'transfer_approved':True,'approval_time':d.now(),'timeout':cfg['timeout'],'turns':[],'ui_config':cfg}
            if cfg['submitted_cases']: state.update(submitted_cases=cfg['submitted_cases'],submitted_audit_version=submitted_audit.VERSION)
            state['web_research']=cfg['web_research'] and cfg['mode']!='smoke'
            if cfg['submitted_cases']:
                try: state['input_preflight'] = d.preflight_submitted_input(state)
                except (d.ProviderError, ValueError) as e: raise UIError('연구 시작 전 입력 검사: ' + str(e), 400) from None
            path.mkdir()
            d.render(state,path)
            self._launch(rid,state,cfg['max_turns'])
        return {'run':rid}

    def pause(self,rid):
        self.run_path(rid)
        with self.lock:
            if not self.active or self.active['id']!=rid or not self.active['thread'].is_alive():raise UIError('이 토론은 실행 중이 아닙니다',409)
            if self.active.get('kind')=='correction':raise UIError('교정 재호출은 일시정지할 수 없습니다. 즉시 중단을 사용하세요',409)
            (self.runs/rid/'PAUSE').touch()
        return {'run':rid,'status':'pause_requested'}

    def stop(self,rid):
        self.run_path(rid)
        with self.lock:
            if not self.active or self.active['id']!=rid or not self.active['thread'].is_alive():raise UIError('이 토론은 실행 중이 아닙니다',409)
            # A correction is a single call; leaving PAUSE behind would stop a later resume.
            if self.active.get('kind')!='correction':(self.runs/rid/'PAUSE').touch()
            self.active['stop'].set()
        return {'run':rid,'status':'stop_requested'}

    def resume(self,value):
        if value.get('approve_transfer') is not True:raise UIError('재개 시에도 저장된 자료의 전송 동의가 필요합니다',403)
        rid=value.get('run');path=self.run_path(rid)
        with self.lock:
            self._ensure_idle();state=load_json(path/'debate.json')
            if state.get('status')=='completed':raise UIError('완료된 토론입니다',409)
            state['transfer_approved']=True
            state.setdefault('events',[]).append({'time':d.now(),'event':'user_resumed_from_local_ui'})
            (path/'PAUSE').unlink(missing_ok=True)
            self._launch(rid,state,state.get('ui_config',{}).get('max_turns'))
        return {'run':rid}

    def correct(self,value):
        """Explicit user action: re-ask the original AI with a reviewer's revised question."""
        if value.get('approve_transfer') is not True:raise UIError('원질문·원답변·수정 질문의 외부 전송에 동의한 후 실행하세요',403)
        rid=value.get('run');path=self.run_path(rid)
        review_turn=value.get('review_turn');index=value.get('audit_index')
        if not isinstance(review_turn,str) or not re.fullmatch(r'S\d{1,3}A\d{1,2}',review_turn):raise UIError('검토 발언 ID 오류')
        if isinstance(index,bool) or not isinstance(index,int) or not 0<=index<=500:raise UIError('오류 검토 후보 번호 오류')
        edited=value.get('question');reason=text(value.get('reason',''),'수정 이유',MAX_CORRECTION_REASON);units=value.get('extra_units',[])
        if edited is not None:edited=text(edited,'수정 질문',MAX_CORRECTION_QUESTION,True)
        if not isinstance(units,list) or len(units)>d.MAX_CORRECTION_UNITS or not all(isinstance(u,str) and UNIT_ID.fullmatch(u) for u in units):
            raise UIError(f'추가 기준서 문단은 문단 ID로 {d.MAX_CORRECTION_UNITS}개까지 선택할 수 있습니다')
        units=list(dict.fromkeys(units))
        with self.lock:
            self._ensure_idle()
            state=load_json(path/'debate.json')
            if not isinstance(state,dict):raise UIError('실행 기록을 읽을 수 없습니다',409)
            review=next((t for t in state.get('turns',[]) if t.get('id')==review_turn),None)
            audits=review.get('parsed',{}).get('audit',[]) if review else []
            if not isinstance(audits,list) or index>=len(audits) or not isinstance(audits[index],dict):raise UIError('오류 검토 후보를 찾을 수 없습니다',404)
            audit=audits[index];proposed=str(audit.get('revised_question','')).strip();question=proposed if edited is None else edited
            target=next((t for t in state['turns'] if t.get('id')==audit.get('target_turn')),None)
            if not target or not d.quote_matches_answer(str(audit.get('original_answer','')).strip(),target.get('answer','')):raise UIError('실제 원답변과 인용이 일치하지 않아 교정 대상에서 제외합니다')
            if not question:raise UIError('수정 질문이 없습니다')
            if question!=proposed and not reason:raise UIError('AI가 제안한 수정 질문을 바꿨다면 바꾼 이유를 적어 주세요')
            known={u['id'] for u in d.source_plan.list_units(state.get('materials',''))}
            if any(u not in known for u in units):raise UIError('이 실행의 자료에 없는 기준서 문단이 있습니다')
            if any(isinstance(c,dict) and c.get('review_turn')==review_turn and c.get('target_turn')==target['id'] and c.get('revised_question')==question and
                   sorted(c.get('extra_units') or [])==sorted(units) and str(c.get('actual_answer','')).strip() for c in state.get('corrections',[])):
                raise UIError('같은 수정 질문·추가 문단의 실제 재호출 기록이 이미 있습니다',409)
            state.setdefault('events',[]).append({'time':d.now(),'event':'user_requested_correction_from_local_ui','review_turn':review_turn,'audit_index':index,
                                                  'question_source':'student_edited' if question!=proposed else 'ai_proposed','extra_units':units})
            self._launch_correction(rid,state,review_turn,index,target,question if question!=proposed else None,reason,units)
        return {'run':rid,'status':'correction_started'}

    def audit_verdict(self,value):
        """Explicit user action on one AI error candidate: the student's verdict, whether it belongs to STEP 1, and a
        correction note. Only the fields sent change; null clears one. No model call; AI records stay as saved."""
        rid=value.get('run');path=self.run_path(rid);key=value.get('key');change={}
        if not isinstance(key,str) or not AUDIT_KEY.fullmatch(key):raise UIError('오류 후보 키 오류')
        if 'verdict' in value:
            if value['verdict'] not in (None,'',*result_digest.VERDICTS):raise UIError('판정 값 오류')
            change['verdict']=value['verdict'] or None
        if 'scope' in value:
            if value['scope'] not in (None,'',*result_digest.SCOPES):raise UIError('STEP 1 분류 값 오류')
            change['scope']=value['scope'] or None
        if 'note' in value:change['note']=text(value.get('note') or '','교정 메모',MAX_VERDICT_NOTE)
        if not change:raise UIError('바꿀 판정 항목이 없습니다')
        with self.lock:
            if self.active and self.active['id']==rid and self.active['thread'].is_alive():raise UIError('진행 중인 실행에는 판정을 저장할 수 없습니다',409)
            state=load_json(path/'debate.json')
            if not isinstance(state,dict):raise UIError('실행 기록을 읽을 수 없습니다',409)
            if key not in {f['key'] for f in result_digest.audit_findings(state)}:raise UIError('오류 후보를 찾을 수 없습니다',404)
            verdicts=state.setdefault('audit_verdicts',{});record={**(verdicts.get(key) or {}),**change,'time':d.now()}
            if record.get('verdict') or record.get('scope') or str(record.get('note') or '').strip():verdicts[key]=record
            else:verdicts.pop(key,None)
            state.setdefault('events',[]).append({'time':d.now(),'event':'student_audit_verdict','key':key,'fields':sorted(change)})
            d.dump(path/'debate.json',state);d.render(state,path)
        return {'run':rid,'key':key,'record':verdicts.get(key)}

    def synthesize(self,value):
        """Explicit user action: the moderator AI turns the saved records into a plain-language result summary."""
        if value.get('approve_transfer') is not True:raise UIError('저장된 토론 기록을 총괄 AI에게 보내는 데 동의한 후 실행하세요',403)
        rid=value.get('run');path=self.run_path(rid)
        with self.lock:
            self._ensure_idle()
            state=load_json(path/'debate.json')
            if not isinstance(state,dict):raise UIError('실행 기록을 읽을 수 없습니다',409)
            if not result_digest.final_positions(state):raise UIError('최종 판단 단계가 끝난 실행에서만 결과 정리를 만들 수 있습니다',409)
            if value.get('report_plan') and state.get('domain') != 'accounting_pbl':raise UIError('SECTION 1~5 작성안은 회계윤리 PBL 실행에서 사용할 수 있습니다',409)
            agent=d.synthesis_agent(state)
            if not agent:raise UIError('결과를 정리할 참가자가 없습니다',409)
            state.setdefault('events',[]).append({'time':d.now(),'event':'user_requested_synthesis_from_local_ui','agent':agent.get('name','')})
            self._launch_synthesis(rid,state,agent)
        return {'run':rid,'status':'synthesis_started','agent':agent.get('name','')}

    def _launch_synthesis(self,rid,state,agent):
        stop=threading.Event();provider=agent.get('provider')
        def work():
            try:
                self.on_update(rid,{'event':'turn_started','id':'SYNTHESIS','agent':{'name':agent.get('name',''),'provider':provider,'model':agent.get('model','')},'stage_title':'총괄 AI 결과 정리'})
                d.run_synthesis(state,self.runs/rid,on_event=lambda e:self.on_update(rid,{'event':'model_event','provider':provider,'data':e}),stop_event=stop)
            except Exception as e:
                stopped=isinstance(e,d.RunStopped)
                state.setdefault('errors',[]).append({'time':d.now(),'error':('결과 정리 중단: ' if stopped else '결과 정리 실패: ')+d.redact(str(e)),
                                                      'category':'synthesis_stopped' if stopped else getattr(e,'category','synthesis_error')})
                d.render(state,self.runs/rid)
            finally:
                with self.lock:self.latest[rid]=None
        thread=threading.Thread(target=work,name='synthesis-'+rid,daemon=True)
        self.active={'id':rid,'thread':thread,'stop':stop,'kind':'synthesis'}
        thread.start()

    def _launch_correction(self,rid,state,review_turn,index,target,question=None,reason='',units=()):
        stop=threading.Event();provider=target.get('provider')
        def work():
            try:
                self.on_update(rid,{'event':'turn_started','id':'CORRECTION','agent':{'name':target.get('name',''),'provider':provider,'model':target.get('model','')},'stage_title':'수정 질문 실제 재호출'})
                d.run_correction(state,self.runs/rid,review_turn,index,
                                 on_event=lambda e:self.on_update(rid,{'event':'model_event','provider':provider,'data':e}),stop_event=stop,
                                 question=question,reason=reason,extra_units=units)
            except Exception as e:
                stopped=isinstance(e,d.RunStopped)
                state.setdefault('errors',[]).append({'time':d.now(),'error':('교정 재호출 중단: ' if stopped else '교정 재호출 실패: ')+d.redact(str(e)),
                                                      'category':'correction_stopped' if stopped else getattr(e,'category','correction_error')})
                d.render(state,self.runs/rid)
            finally:
                with self.lock:self.latest[rid]=None
        thread=threading.Thread(target=work,name='correction-'+rid,daemon=True)
        self.active={'id':rid,'thread':thread,'stop':stop,'kind':'correction'}
        thread.start()

    def upload(self,value):
        name=text(value.get('name',''),'파일명',160,True)
        if Path(name).name!=name or '/' in name or '\\' in name or Path(name).suffix.lower() not in ('.md','.txt'):raise UIError('Markdown 또는 TXT 파일을 선택하세요')
        # Windows also reserves CON.anything.txt and superscript COM/LPT names.
        stem = name.split('.')[0].rstrip(' .').upper()
        if stem in ('CON','PRN','AUX','NUL','CONIN$','CONOUT$') or re.fullmatch(r'(COM|LPT)[1-9¹²³]',stem):
            raise UIError('Windows 예약 장치 파일명은 사용할 수 없습니다')
        if any(ord(ch)<32 or ch in '<>:"|?*' for ch in name) or name.endswith((' ','.')):
            raise UIError('Windows에서 사용할 수 없는 파일명입니다')
        content=value.get('content')
        if not isinstance(content,str) or len(content.encode('utf-8'))>MAX_FILE:raise UIError('자료는 UTF-8 텍스트 2MB 이하로 선택하세요')
        if '\x00' in content:raise UIError('텍스트 파일만 사용할 수 있습니다')
        self.uploads.mkdir(exist_ok=True)
        dest=self.uploads/(uuid.uuid4().hex[:8]+'_'+name)
        dest.write_text(d.redact(content),encoding='utf-8')
        return {'material':next(m for m in self.materials() if m['id']=='upload:'+dest.name)}

    def bootstrap(self):
        return {'csrf':self.csrf,'server_instance':getattr(self,'server_instance',None),'defaults':self.defaults(),'providers':self.catalog,'materials':self.materials(),'runs':self.list_runs(),
                'connection_status':self.connection_status(),'reports':REPORTS,'derived_reports':DERIVED_REPORTS,'active_run':self.activity()['active_run'],'no_inference_on_load':True,'web_research_supported':True,'protocol_version_supported':d.protocol.VERSION,'review_policy_version_supported':d.protocol.REVIEW_POLICY_VERSION,
                'course_guidance_version_supported':d.protocol.COURSE_GUIDANCE_VERSION,'correction_supported':True,'correction_edit_supported':True,'audit_verdict_supported':True,'synthesis_supported':True,'report_plan_supported':True,'submitted_audit_supported':True,
                'submitted_audit_version_supported':submitted_audit.VERSION,'submitted_input_max_bytes':submitted_audit.MAX_TOTAL_BYTES}

    def activity(self):
        with self.lock:
            rid=self.active['id'] if self.active and self.active['thread'].is_alive() else None
        return {'active_run':rid}

    def close(self):
        with self.lock:
            active=self.active
            if active and active['thread'].is_alive():active['stop'].set()
        if active:active['thread'].join(timeout=12)

def make_handler(app):
    class Handler(BaseHTTPRequestHandler):
        server_version='AIDebateLocal/1.0'
        def log_message(self,format,*args):pass
        def send(self,status,body,content_type='application/json; charset=utf-8',download=None):
            if isinstance(body,(dict,list)):body=json.dumps(body,ensure_ascii=False).encode('utf-8')
            elif isinstance(body,str):body=body.encode('utf-8')
            self.send_response(status)
            self.send_header('Content-Type',content_type);self.send_header('Content-Length',str(len(body)))
            self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff')
            self.send_header('Referrer-Policy','no-referrer');self.send_header('X-Frame-Options','DENY')
            self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; object-src 'none'; base-uri 'none'")
            if download:self.send_header('Content-Disposition',"attachment; filename*=UTF-8''"+quote(download))
            self.end_headers()
            try:self.wfile.write(body)
            except (BrokenPipeError,ConnectionResetError):pass
        def guard(self,mutation=False):
            host=self.headers.get('Host','');port=self.server.server_address[1]
            if host not in (f'127.0.0.1:{port}',f'localhost:{port}'):raise UIError('로컬 주소만 사용할 수 있습니다',403)
            origin=self.headers.get('Origin')
            if origin is not None and origin not in (f'http://127.0.0.1:{port}',f'http://localhost:{port}'):raise UIError('다른 사이트의 요청은 허용하지 않습니다',403)
            if self.headers.get('Sec-Fetch-Site')=='cross-site':raise UIError('다른 사이트 요청 차단',403)
            if mutation:
                if self.headers.get('Content-Type','').split(';')[0]!='application/json':raise UIError('JSON 요청만 허용',415)
                if not secrets.compare_digest(self.headers.get('X-CSRF-Token',''),app.csrf):raise UIError('페이지를 새로 열고 다시 시도하세요',403)
        def do_GET(self):
            try:
                self.guard();url=urlparse(self.path);query=parse_qs(url.query);param=lambda k:query.get(k,[''])[0]
                if url.path=='/api/bootstrap':return self.send(200,app.bootstrap())
                if url.path=='/api/runs':return self.send(200,{'runs':app.list_runs()})
                if url.path=='/api/activity':return self.send(200,app.activity())
                if url.path=='/api/config':return self.send(200,{'config':load_json(app.config_path,app.defaults())})
                if url.path=='/api/run':return self.send(200,app.snapshot(param('run')))
                if url.path=='/api/source-units':return self.send(200,app.source_units(param('run')))
                if url.path=='/api/material':
                    p=app.material_path(param('id'));return self.send(200,{'name':p.name,'content':d.redact(p.read_text(encoding='utf-8-sig'))})
                if url.path=='/api/report':
                    content=app.report(param('run'),param('name'))
                    if param('download')=='1':return self.send(200,content,'text/plain; charset=utf-8',param('name'))
                    return self.send(200,{'name':param('name'),'content':content})
                if url.path in ('/','/index.html','/app.js','/style.css'):
                    name='index.html' if url.path=='/' else url.path[1:]
                    p=app.root/'web'/name
                    if not p.is_file():raise UIError('UI 파일 준비 중',503)
                    mime={'index.html':'text/html; charset=utf-8','app.js':'text/javascript; charset=utf-8','style.css':'text/css; charset=utf-8'}[name]
                    return self.send(200,p.read_bytes(),mime)
                raise UIError('페이지 없음',404)
            except UIError as e:self.send(e.status,{'error':str(e)})
            except Exception as e:self.send(500,{'error':d.redact(str(e))})
        def discard_body(self,size):
            """Drop an unread, size-capped body so closing the socket cannot reset a rejection (Windows WSAECONNABORTED)."""
            if self.body_read or not isinstance(size,int) or not 0<size<=MAX_BODY:return
            self.body_read=True
            try:
                self.connection.settimeout(2);remaining=size
                while remaining>0:
                    chunk=self.rfile.read(min(65536,remaining))
                    if not chunk:break
                    remaining-=len(chunk)
            except OSError:pass
        def do_POST(self):
            self.body_read=False
            try:size=int(self.headers.get('Content-Length','0'))
            except ValueError:size=None
            try:
                self.guard(True)
                if size is None:raise UIError('요청 크기 오류')
                if not 0<size<=MAX_BODY:raise UIError('요청 크기 제한 초과',413)
                self.body_read=True
                try:value=json.loads(self.rfile.read(size))
                except (ValueError,UnicodeDecodeError):raise UIError('JSON 형식 오류')
                if not isinstance(value,dict):raise UIError('JSON 객체 필요')
                path=urlparse(self.path).path
                if path=='/api/start':result=app.start(value)
                elif path=='/api/pause':result=app.pause(value.get('run'))
                elif path=='/api/stop':result=app.stop(value.get('run'))
                elif path=='/api/resume':result=app.resume(value)
                elif path=='/api/correct':result=app.correct(value)
                elif path=='/api/audit-verdict':result=app.audit_verdict(value)
                elif path=='/api/synthesize':result=app.synthesize(value)
                elif path=='/api/upload':result=app.upload(value)
                elif path=='/api/delete_run':result=app.delete_run(value.get('run'))
                elif path=='/api/delete_material':result=app.delete_material(value.get('id'))
                elif path=='/api/cleanup_junk':result=app.cleanup_junk_materials()
                elif path=='/api/config':
                    cfg=app.validate_config(value.get('config',value));d.dump(app.config_path,cfg);result={'saved':True,'config':cfg}
                else:raise UIError('요청 경로 없음',404)
                self.send(200,result)
            except UIError as e:
                self.discard_body(size);self.send(e.status,{'error':str(e)})
            except Exception as e:
                self.discard_body(size);self.send(500,{'error':d.redact(str(e))})
    return Handler

class ServerAlreadyRunning(UIError):
    def __init__(self,root):
        super().__init__('이 프로젝트의 제어판이 이미 실행 중입니다. 기존 서버를 사용하세요.',409)
        self.instance=load_json(Path(root)/'ui-server.instance.json',{}) or {}


class ServerLease:
    """One HTTP writer per project, regardless of its port. OS releases on crash."""
    def __init__(self,root):
        self.file=open(Path(root)/'ui-server.lock','a+b')
        try:
            self.file.seek(0)
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(self.file.fileno(),msvcrt.LK_NBLCK,1)
            else:
                import fcntl
                fcntl.flock(self.file.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
        except OSError:
            self.file.close();self.file=None
            raise ServerAlreadyRunning(root) from None

    def close(self):
        if self.file is not None:self.file.close();self.file=None


class ControlHTTPServer(ThreadingHTTPServer):
    daemon_threads=True
    def server_close(self):
        try:super().server_close()
        finally:
            if getattr(self,'lease',None):self.lease.close()


def create_server(port=8765,app=None):
    app=app or ControlApp()
    lease=ServerLease(app.root)
    try:
        server=ControlHTTPServer(('127.0.0.1',port),make_handler(app));server.lease=lease
        app.server_instance=uuid.uuid4().hex
        d.dump(app.root/'ui-server.instance.json',{'pid':os.getpid(),'port':server.server_port,'instance':app.server_instance})
    except Exception:
        lease.close()
        if 'server' in locals():server.server_close()
        raise
    return server,app

def main():
    parser=argparse.ArgumentParser(description='로컬 AI 토론 제어판: 열기만으로 모델을 호출하지 않습니다')
    parser.add_argument('--port',type=int,default=8765);parser.add_argument('--open',action='store_true')
    args=parser.parse_args()
    if not 1024<=args.port<=65535:parser.error('포트는 1024~65535 범위')
    try:server,app=create_server(args.port)
    except ServerAlreadyRunning as error:
        info=error.instance;port=info.get('port');url=f'http://127.0.0.1:{port}'
        try:
            if type(port) is not int or not 1024<=port<=65535:raise ValueError('포트 미확인')
            with urllib.request.urlopen(url+'/api/bootstrap',timeout=3) as response:existing=json.load(response)
            if not info.get('instance') or existing.get('server_instance')!=info['instance']:raise ValueError('서버 미확인')
        except Exception:parser.exit(1,str(error)+' 서버가 시작 중이면 잠시 후 다시 여세요.\n')
        print('이미 실행 중인 이 프로젝트의 제어판: '+url,flush=True)
        if args.open:webbrowser.open(url)
        return
    except OSError:
        url=f'http://127.0.0.1:{args.port}'
        try:
            with urllib.request.urlopen(url+'/api/bootstrap',timeout=2) as response:existing=json.load(response)
            if existing.get('no_inference_on_load') is not True:raise ValueError('다른 서버')
        except Exception:parser.exit(1,'포트를 사용할 수 없습니다. 다른 --port를 지정하세요.\n')
        print('이미 실행 중인 로컬 제어판: '+url,flush=True)
        if args.open:webbrowser.open(url)
        return
    url=f'http://127.0.0.1:{server.server_port}'
    print('로컬 제어판: '+url,flush=True);print('대기 중: 시작 버튼을 누르기 전 모델 호출 없음. 종료: Ctrl+C',flush=True)
    if args.open:webbrowser.open(url)
    try:server.serve_forever(poll_interval=.25)
    except KeyboardInterrupt:pass
    finally:app.close();server.server_close()

if __name__=='__main__':main()
