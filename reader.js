/* Shared saved-run reader. Only navigation, viewing and local downloads are bound. */
"use strict";
(async function bootSharedConsole(){
  try {
    const response=await fetch('./results.json',{credentials:'omit'});
    if(!response.ok)throw new Error('저장된 연구를 불러올 수 없습니다.');
    const bundle=await response.json();
    window.SharedResultBundle=bundle;
    window.DebateReportIssueReviews=bundle.reviews;
    state.providers=normalizeModelCatalog(bundle.providers);
    state.materials=bundle.materials;
    state.runs=[{id:bundle.run.id,topic:bundle.run.topic,status:bundle.run.status,created:bundle.run.created,turns:bundle.run.turns.length,total_turns:bundle.run.total_turns}];
    state.reports=Object.keys(bundle.report_files);
    Object.assign(state,{webResearchSupported:true,sectionSessionsSupported:true,protocolVersionSupported:3,
      reviewPolicyVersionSupported:1,courseGuidanceSupported:3,submittedAuditSupported:true,
      submittedAuditVersion:bundle.run.submitted_audit_version,submittedInputMaxBytes:18000});
    applyConfig(bundle.config);
    state.currentRun=bundle.run;
    state.selectedRun=bundle.run.id;
    state.summaryCache.set(bundle.run.id,{key:summaryKey(bundle.run),record:bundle.run});
    window.DebateSummary.mount('classified-summary');
    // Do not attach original execution, upload, save, deletion or correction handlers.
    summaryOptions=function(){return {onOpenTurn:openSharedTurn,onOpenReport:openSummaryReport};};
    const originalLoadReport=loadReport;
    loadReport=async function(quiet=false){
      await originalLoadReport(quiet);
      const target=bundle.report_files[$('report-select').value];
      if(target)$('download-report').href=target;
    };
    renderRuns();renderReportList();renderRun(bundle.run);
    renderConnections(Object.fromEntries(bundle.run.agents.map(a=>[a.provider,{summary:'저장된 토론 발언 있음'}])));
    $('run-select').value=bundle.run.id;
    $('summary-run-select').value=bundle.run.id;
    [$('run-select'),$('summary-run-select')].forEach(select=>{
      [...select.options].filter(option=>!option.value).forEach(option=>option.remove());
      select.value=bundle.run.id;select.disabled=true;
    });
    $('view-workspace').addEventListener('click',()=>showView('workspace'));
    $('view-summary').addEventListener('click',()=>showView('summary'));
    $('report-select').addEventListener('change',()=>{state.reportSignature='';loadReport();});
    $('close-source-dialog').addEventListener('click',()=>$('source-dialog').close());
    $('close-dialog').addEventListener('click',()=>$('material-dialog').close());
    $('refresh-summary').addEventListener('click',()=>renderClassifiedSummary());
    $('refresh-runs').addEventListener('click',()=>{renderRun(bundle.run);lockSharedControls();});
    const locked=['start-button','pause-button','stop-button','resume-button','reset-research',
      'delete-run-button','delete-result-button','save-config','load-config','add-agent','upload-button',
      'cleanup-junk-button','select-all','select-none','save-report-notes'];
    function lockSharedControls(){
      locked.forEach(id=>{if($(id)){$(id).disabled=true;$(id).title='공유 페이지에서는 실행·변경할 수 없습니다.';}});
      document.querySelectorAll('.setup-column input,.setup-column textarea,.setup-column select,.setup-column button').forEach(input=>input.disabled=true);
      $('activity-title').textContent='저장된 연구';
      $('activity-detail').textContent=bundle.run.turns.length+'개 발언 완료 · 결과 조회 전용';
    }
    lockSharedControls();
    $('report-notes-panel').classList.add('hidden');
    $('activity-title').textContent='저장된 연구';
    $('activity-detail').textContent=bundle.run.turns.length+'개 발언 완료 · 결과 조회 전용';
    const notice=el('p','share-readonly-notice','지난 토론이 선택되어 있습니다. 설정·실행 화면과 분류별 연구 요약을 오가며 볼 수 있습니다. 실행·수정 기능은 잠겨 있습니다.');
    document.querySelector('.view-navigation').before(notice);
    await loadReport();
    await showView('summary');
    ($('ds-tab-easy')||$('ds-tab-results'))?.click();
    state.initialized=true;
  }catch(error){$('connection-error').textContent=error.message;$('connection-error').classList.remove('hidden');}
})();

function openSharedTurn(id){
  const bundle=window.SharedResultBundle;
  const turn=bundle.run.turns.find(item=>item.id===id);
  if(!turn)return;
  $('source-dialog-title').textContent=turn.name+' · '+turn.stage_title;
  const body=$('source-dialog-content');
  body.replaceChildren(DebateSummary.renderMarkdown(turn.parsed?.analysis||turn.answer||'원문 없음'));
  if(turn.parsed?.analysis){
    const details=el('details'),label=el('summary','','저장된 전체 응답 보기');
    details.append(label,el('pre','source-record-text',turn.answer||JSON.stringify(turn.parsed,null,2)));
    body.append(details);
  }
  $('source-dialog').showModal();
}
