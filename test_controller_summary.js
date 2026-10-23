/* Offline controller contracts. No server, CLI, or model is started. */
"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class Node {
  constructor(tag = "div") { this.tagName = tag; this.children = []; this.value = ""; this.textContent = ""; this.attributes = {}; this.style = {}; this.scrollTop = 0; this.classes = new Set(); this.classList = { toggle: (name, force) => force ? this.classes.add(name) : this.classes.delete(name), add: name => this.classes.add(name), remove: name => this.classes.delete(name) }; }
  append(...items) { this.children.push(...items); }
  replaceChildren(...items) { this.children = items; }
  setAttribute(name, value) { this.attributes[name] = value; }
  removeAttribute(name) { delete this.attributes[name]; }
  get options() { return this.children; }
  addEventListener(name, handler) { (this.events ||= {})[name] = [...(this.events[name] || []), handler]; }
  dispatch(name) { for (const handler of this.events?.[name] || []) handler({ target: this }); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatch("close"); }
  focus() { this.focused = true; }
  querySelectorAll(selector) {
    const all = node => node.children.flatMap(child => child && typeof child === "object" ? [child, ...all(child)] : []);
    return selector === "input:checked" ? all(this).filter(item => item.tagName === "input" && item.checked) : [];
  }
}

function harness(record, respond) {
  const nodes = new Map();
  const requests = [], renders = [];
  const context = vm.createContext({
    console, Map, Set, JSON, Promise, URLSearchParams, TextEncoder,
    document: { getElementById: id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); }, createElement: tag => new Node(tag) },
    window: { DebateSummary: { render: run => renders.push(run), reset() {}, renderMarkdown() {} } },
    setTimeout() {}, clearTimeout() {}, setInterval() {},
    fetch: async (url, options) => {
      requests.push({ url, options });
      if (respond) return { ok: true, json: async () => respond(url, options) };
      assert.equal(options.method, "GET", "summary must only read local state");
      assert.match(url, /^\/api\/report\?run=[^&]+&name=debate\.json$/);
      return { ok: true, json: async () => ({ content: JSON.stringify(record) }) };
    }
  });
  const source = fs.readFileSync(path.join(__dirname, "web", "controller.js"), "utf8");
  assert.match(source, /\ninit\(\);\s*$/);
  vm.runInContext(source.replace(/\ninit\(\);\s*$/, "\n"), context, { filename: "controller.js" });
  const evaluate = script => vm.runInContext(script, context);
  return { nodes, requests, renders, evaluate, context };
}

async function main() {
  const supplied = harness({});
  supplied.evaluate('state.materials=[]; state.providers={}; addAgent=()=>{$("agents").append(document.createElement("div"))}; renderMaterials=()=>{}; updateCounts=()=>{};');
  supplied.evaluate('applyConfig({submitted_cases:[{question:"Q",answer:"ORIGINAL",source:"SOURCE",suspicion:"PRIVATE"}]})');
  assert.equal(supplied.nodes.get("case-1-answer").value, "ORIGINAL");
  assert.equal(supplied.evaluate('getSubmittedCases()[0].suspicion'), "PRIVATE");
  assert.equal(supplied.nodes.get("submitted-case-panel").open, true);
  supplied.evaluate('applyConfig({})');
  assert.equal(supplied.evaluate('getSubmittedCases().length'), 0, "loading legacy config clears stale supplied answers");
  supplied.evaluate('$("case-2-answer").value="SECOND"; collectAgents=()=>[]; selectedMaterials=()=>[];');
  assert.equal(supplied.evaluate('getConfig().submitted_cases[0].answer'), "SECOND");
  assert.equal(supplied.requests.length, 0, "entering and reading cases never calls any endpoint");
  supplied.evaluate('var auditConfig={topic:"t",agents:[{name:"A"},{name:"B"}],timeout:30,max_turns:null,mode:"research",submitted_cases:[{answer:"OK"}]}; validateConfig(auditConfig)');
  assert.throws(() => supplied.evaluate('validateConfig({...auditConfig,submitted_cases:[{question:"missing answer"}]})'), /원문/);
  assert.throws(() => supplied.evaluate('validateConfig({...auditConfig,mode:"smoke",smoke_rounds:2})'), /연구 또는 합의/);
  supplied.evaluate('applyConfig({submitted_cases:[{question:"Q",answer:"가😀",items:["Repo","빅배스"]}]})');
  assert.deepEqual(Array.from(supplied.evaluate('getSubmittedCases()[0].items')), ["Repo","빅배스"]);
  assert.equal(supplied.evaluate('submittedInputBytes(getSubmittedCases())'), 8);
  assert.match(supplied.nodes.get("submitted-input-budget").textContent, /8 \/ 18,000/);
  assert.throws(() => supplied.evaluate('validateConfig({...auditConfig,submitted_cases:[{answer:"가".repeat(3000)},{answer:"가".repeat(3000)},{answer:"가".repeat(3000)}]})'), /바이트/);
  supplied.evaluate('applyConfig({})');
  assert.equal(supplied.nodes.get("case-1-item-1").checked, false, "loading legacy settings clears mappings");
  assert.equal(supplied.requests.length, 0);
  const progressHarness = harness({});
  progressHarness.evaluate(`renderRun({status:"paused", turns:[], total_turns:6, progress:{completed_turns:1, completed_stages:0, total_stages:2, complete:false, next_turn:{id:"S1A2",stage_title:"독립 조사",name:"Claude"}}})`);
  assert.match(progressHarness.nodes.get("turn-progress").textContent, /1 \/ 6 발언 수신 · 0 \/ 2단계/);
  assert.match(progressHarness.nodes.get("run-control-note").textContent, /재개 대상: 독립 조사 · Claude \(S1A2\)/);
  progressHarness.evaluate(`renderRun({status:"completed", turns:[], total_turns:6, progress:{completed_turns:1, completed_stages:0, total_stages:2, complete:false}})`);
  assert.equal(progressHarness.nodes.get("run-status").textContent, "실행 종료 · 발언 미완료");
  progressHarness.evaluate(`renderRun({status:"completed", turns:[], total_turns:6, progress:{completed_turns:6, completed_stages:2, total_stages:2, complete:true}})`);
  assert.equal(progressHarness.nodes.get("run-status").textContent, "전체 실행 완료");
  assert.match(progressHarness.nodes.get("run-control-note").textContent, /합의 여부와 근거 검증 상태/);
  assert.equal(progressHarness.requests.length, 0);
  const record = {
    mode: "research", status: "paused", materials: "PRIVATE LOCAL FIXTURE",
    manifest: [{ file: "case.md" }], corrections: [{ id: "actual-correction", actual_answer: "실제 교정 기록" }],
    turns: [{ id: "S1A1", stage: "independent", name: "A", provider: "codex", prompt: "원질문", answer: "이전 답변", parsed: { analysis: "이전 분석" } }]
  };
  const h = harness(record);
  h.evaluate(`state.selectedRun = "saved-research"; state.currentRun = { id: "saved-research", status: "paused", total_turns: 18, turns: [{ id: "S1A1", name: "A", provider: "codex", answer: "최신 답변", parsed: { analysis: "최신 분석" } }] };`);
  h.nodes.set("topic", Object.assign(new Node("textarea"), { value: "사용자 편집 중인 주제" }));
  await h.evaluate('showView("summary")');
  await h.evaluate('loadSummaryRecord()');
  await Promise.resolve();
  assert.equal(h.requests.length, 1);
  assert.equal(h.nodes.get("topic").value, "사용자 편집 중인 주제", "navigation must preserve unsaved settings");
  assert.equal(h.evaluate("summaryRun().turns[0].stage"), "independent");
  assert.equal(h.evaluate("summaryRun().turns[0].prompt"), "원질문");
  assert.equal(h.evaluate("summaryRun().turns[0].answer"), "최신 답변", "live snapshot must win over stale cached response");
  assert.equal(h.evaluate("summaryRun().corrections[0].id"), "actual-correction");
  assert.equal(h.evaluate("summaryRun().manifest[0].file"), "case.md");
  await h.evaluate("loadSummaryRecord()");
  assert.equal(h.requests.length, 1, "unchanged stopped runs must reuse local cache");
  h.evaluate('state.currentRun.turns.push({id:"S1A2", name:"B", provider:"claude", answer:"새 발언"})');
  await h.evaluate("loadSummaryRecord()");
  assert.equal(h.requests.length, 2, "a newly completed turn must refresh complete saved record");
  assert.equal(h.evaluate("summaryRun().turns.length"), 2, "new snapshot turns must survive source enrichment");
  await h.evaluate("loadSummaryRecord(true)");
  assert.equal(h.requests.length, 3, "manual refresh must reread source even with same turn IDs");
  h.evaluate('state.runs = [{id:"saved-research",topic:"연구",status:"paused",turns:2},{id:"other",topic:"기타",status:"completed",turns:6}]; renderRuns();');
  assert.equal(h.nodes.get("run-select").value, "saved-research");
  assert.equal(h.nodes.get("summary-run-select").value, "saved-research");
  assert.equal(h.nodes.get("run-select").children.length, 3);
  await h.evaluate('showView("workspace")');
  assert.equal(h.requests.length, 3, "returning to settings must not start any execution");
  assert.equal(h.nodes.get("topic").value, "사용자 편집 중인 주제");
  assert.equal(h.nodes.get("view-workspace").attributes["aria-pressed"], "true");

  h.evaluate('state.initialized=true;');
  const instructions = Object.assign(new Node("textarea"), { value: "유지할 공통 명령" });
  h.nodes.set("instructions", instructions);
  h.nodes.set("agents", Object.assign(new Node(), { children: ["GPT", "Claude", "Gemini", "DeepSeek"] }));
  h.nodes.set("materials", Object.assign(new Node(), { value: "selected materials" }));
  h.nodes.set("transfer-consent", Object.assign(new Node("input"), { checked: true }));
  await h.evaluate('showView("summary"); resetResearch()');
  assert.equal(h.requests.length, 3, "reset must not make an HTTP, model, save, stop or delete request");
  assert.equal(h.evaluate("state.selectedRun"), "");
  assert.equal(h.evaluate("state.currentRun"), null);
  assert.equal(h.nodes.get("run-select").value, "");
  assert.equal(h.nodes.get("summary-run-select").value, "");
  assert.equal(h.renders.at(-1), null, "old partial-stage badges and conclusions must be removed together");
  assert.equal(h.nodes.get("progress-bar").style.width, "0%");
  assert.equal(h.nodes.get("resume-button").disabled, true);
  assert.equal(h.nodes.get("topic").value, "사용자 편집 중인 주제");
  assert.equal(instructions.value, "유지할 공통 명령");
  assert.equal(h.nodes.get("agents").children.length, 4);
  assert.equal(h.nodes.get("materials").value, "selected materials");
  assert.equal(h.nodes.get("transfer-consent").checked, false);
  await h.evaluate('showView("workspace"); showView("summary")');
  assert.equal(h.evaluate("state.selectedRun"), "", "opening summary again must not select a previous partial run");
  assert.equal(h.renders.at(-1), null);
  assert.equal(h.requests.length, 3);
  h.evaluate('state.currentRun={id:"active",active:true}; state.selectedRun="active"; updateRunButtons()');
  assert.equal(h.nodes.get("reset-research").disabled, true);
  await h.evaluate('resetResearch()');
  assert.equal(h.evaluate("state.selectedRun"), "active", "reset must leave the running monitor available");
  h.evaluate('state.currentRun={id:"paused",active:false}; state.selectedRun="paused"; setBusy(true)');
  await h.evaluate('resetResearch()');
  assert.equal(h.evaluate("state.selectedRun"), "paused", "in-flight actions must prevent reset");

  const empty = harness({ turns: [] });
  await empty.evaluate('showView("summary")');
  assert.equal(empty.requests.length, 0, "empty summary must not make a model or execution request");
  assert.equal(empty.renders.at(-1), null);
  empty.evaluate('state.initialized=true; state.activeRunId="running-elsewhere"; updateRunButtons()');
  assert.equal(empty.nodes.get('start-button').disabled, true);
  assert.equal(empty.nodes.get('reset-research').disabled, true);
  assert.equal(empty.nodes.get('show-active-run').classes.has('hidden'), false);
  assert.match(empty.nodes.get('activity-title').textContent, /실행 중/);
  await empty.evaluate('resetResearch()');
  assert.equal(empty.evaluate('state.activeRunId'), 'running-elsewhere');
  assert.equal(empty.requests.length, 0, 'global activity controls never start or stop execution');
  const stale = harness({ turns: [] });
  stale.evaluate('getConfig=()=>({web_research:true,mode:"research"}); validateConfig=()=>{}; state.webResearchSupported=false');
  await stale.evaluate('startRun()');
  assert.equal(stale.requests.length, 0, 'old server must not silently drop the selected web policy');
  assert.match(stale.nodes.get('toast').textContent, /서버를 종료하고 다시 실행/);
  const oldReview = harness({ turns: [] });
  oldReview.evaluate('getConfig=()=>({web_research:false,mode:"research"}); validateConfig=()=>{}; state.protocolVersionSupported=3; state.webResearchSupported=true; state.reviewPolicyVersionSupported=0');
  await oldReview.evaluate('startRun()');
  assert.equal(oldReview.requests.length, 0, 'old server must not silently skip the new final review policy');
  assert.match(oldReview.nodes.get('toast').textContent, /최종 검토 기준/);
  const oldGuidance = harness({ turns: [] });
  oldGuidance.evaluate('getConfig=()=>({web_research:false,mode:"research"}); validateConfig=()=>{}; state.protocolVersionSupported=3; state.webResearchSupported=true; state.reviewPolicyVersionSupported=1; state.courseGuidanceSupported=2');
  await oldGuidance.evaluate('startRun()');
  assert.equal(oldGuidance.requests.length, 0, 'a server without role-based shared records must not start a new run');
  assert.match(oldGuidance.nodes.get('toast').textContent, /필수 원문 묶음/);

  // Correction dialog: the AI proposal is shown read-only, an edit needs a reason, consent is per request.
  const posts = [];
  const dialog = harness({ turns: [] }, (url, options) => {
    if (url.startsWith("/api/source-units")) return { units: [{ id: "K1115:B66", title: "B66 TITLE" }, { id: "K1109:3.2.6", title: "DERECOGNITION" }], max: 6 };
    if (url === "/api/correct") { posts.push(JSON.parse(options.body)); return { run: "saved", status: "correction_started" }; }
    if (url === "/api/activity") return { active_run: "" };
    return { id: "saved", status: "completed", turns: [] };
  });
  dialog.evaluate('state.correctionSupported=true; state.correctionEditSupported=true; state.currentRun={id:"saved",status:"completed",turns:[]}; state.selectedRun="saved"; state.activeRunId=""');
  await dialog.evaluate('requestCorrection("S2A1", 0, "AI 질문")');
  const field = id => dialog.nodes.get(id);
  assert.equal(field("correction-dialog").open, true);
  assert.equal(field("correction-ai-question").textContent, "AI 질문");
  assert.equal(field("correction-question").value, "AI 질문");
  assert.equal(field("correction-units").children.length, 2);
  field("correction-question").value = "학생 질문";
  await dialog.evaluate('submitCorrection({ preventDefault() {} })');
  assert.equal(posts.length, 0); assert.match(field("correction-error").textContent, /바꾼 이유/);
  field("correction-reason").value = "문단 번호부터 확인하게 바꿈";
  await dialog.evaluate('submitCorrection({ preventDefault() {} })');
  assert.equal(posts.length, 0, "consent is required for every rerun"); assert.match(field("correction-error").textContent, /전송 동의/);
  const unit = field("correction-units").children[0].children.find(child => child.tagName === "input");
  unit.checked = true; unit.dispatch("change");
  assert.match(field("correction-unit-count").textContent, /선택 1개/);
  field("correction-consent").checked = true;
  await dialog.evaluate('submitCorrection({ preventDefault() {} })');
  assert.deepEqual(posts[0], { run: "saved", review_turn: "S2A1", audit_index: 0, approve_transfer: true, extra_units: ["K1115:B66"], question: "학생 질문", reason: "문단 번호부터 확인하게 바꿈" });
  assert.equal(field("correction-dialog").open, false);
  await dialog.evaluate('requestCorrection("S2A1", 0, "AI 질문")');
  assert.equal(field("correction-consent").checked, false, "consent is not carried over to the next request");
  field("correction-consent").checked = true;
  await dialog.evaluate('submitCorrection({ preventDefault() {} })');
  assert.deepEqual(posts[1], { run: "saved", review_turn: "S2A1", audit_index: 0, approve_transfer: true, extra_units: [] }, "an unedited proposal is sent without a student question");
  const oldCorrection = harness({ turns: [] }, () => ({}));
  oldCorrection.evaluate('state.correctionSupported=true; state.correctionEditSupported=false; state.currentRun={id:"saved",status:"completed",turns:[]}');
  await oldCorrection.evaluate('requestCorrection("S2A1", 0, "AI 질문")');
  assert.equal(oldCorrection.requests.length, 0, "an old server would drop the student's edit, so the dialog is not offered");
  assert.match(oldCorrection.nodes.get("toast").textContent, /서버를 종료하고 다시 실행/);
  // A report plan is one explicit synthesis over saved records, never a new debate.
  const reportPosts = [];
  const report = harness({ turns: [] }, (url, options) => {
    if (options.method === "POST") reportPosts.push({ url, body: JSON.parse(options.body) });
    return { run: "saved", status: "synthesis_started" };
  });
  report.evaluate('state.synthesisSupported=true; state.currentRun={id:"saved",active:false}; state.activeRunId=""; pollRun=async()=>{}; window.confirm=()=>true;');
  await report.evaluate('requestSynthesis("총괄",true)');
  assert.equal(reportPosts.length, 0, "an old server cannot silently return just a summary instead of a report plan");
  assert.match(report.nodes.get("toast").textContent, /이전 버전/);
  report.evaluate('state.reportPlanSupported=true; window.confirm=()=>false;');
  await report.evaluate('requestSynthesis("총괄",true)');
  assert.equal(reportPosts.length, 0, "cancelling transmission must not call any AI");
  report.evaluate('window.confirm=message=>{window.confirmText=message;return true};');
  await report.evaluate('requestSynthesis("총괄",true)');
  assert.deepEqual(reportPosts, [{ url: "/api/synthesize", body: { run: "saved", approve_transfer: true, report_plan: true } }]);
  assert.match(report.evaluate('window.confirmText'), /SECTION 1~5/);
  assert.match(report.evaluate('window.confirmText'), /총괄 1회 호출이며 토론을 다시 돌리지 않습니다/);
  report.evaluate('state.currentRun.active=true;');
  await report.evaluate('requestSynthesis("총괄",true)');
  assert.equal(reportPosts.length, 1, "an active job cannot be duplicated");
  assert.ok(!report.requests.some(x => /\/(start|resume)$/.test(x.url)));
  console.log("controller summary contracts passed: read-only navigation, preserved settings, source merge, cache, refresh, selectors, empty state, reset without inference/deletion, no implicit old-run selection, active/busy reset guards, one-call report plan consent");
}
main().catch(error => { console.error(error); process.exitCode = 1; });
