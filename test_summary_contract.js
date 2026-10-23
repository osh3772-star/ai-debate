"use strict";

// Offline contract tests. Runs the actual summary module against an inert DOM;
// no browser, HTTP server, installed AI CLI, or model is started.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");

class Element {
  constructor(tag, value = "") {
    this.tagName = tag.toUpperCase(); this.children = []; this._text = value;
    this.attributes = {}; this.events = {}; this.className = ""; this.isConnected = true;
    this.classList = { add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].filter(Boolean).join(" "); } };
  }
  append(...items) {
    for (const item of items) {
      if (item?.tagName === "#FRAGMENT") this.children.push(...item.children);
      else this.children.push(typeof item === "string" ? new Element("#text", item) : item);
    }
  }
  replaceChildren(...items) { this.children = []; this._text = ""; this.append(...items); }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(""); }
  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(name, handler) { (this.events[name] ||= []).push(handler); }
  click() { for (const action of this.events.click || []) action({ target: this }); }
  focus() { this.focused = true; }
  get options() { return this.children.filter(child => child.tagName === "OPTION"); }
  querySelector(selector) {
    // Only selectors used by the summary module are needed in this inert DOM.
    const last = selector.trim().split(/\s+/).at(-1);
    return walk(this).find(item => {
      if (last.startsWith("#")) return item.id === last.slice(1);
      if (last.startsWith(".")) return item.className.split(/\s+/).includes(last.slice(1));
      const attr = last.match(/^\[([^=]+)=([^\]]+)\]$/);
      if (attr) return item.getAttribute(attr[1]) === attr[2].replace(/["']/g, "");
      return item.tagName === last.toUpperCase();
    }) || null;
  }
}
function walk(element) { return element.children.flatMap(child => [child, ...walk(child)]); }

const host = new Element("main"); host.id = "classified-summary";
let networkCalls = 0;
const sandbox = {
  window: {}, URL,
  document: {
    createElement: tag => new Element(tag),
    createTextNode: value => new Element("#text", value),
    createDocumentFragment: () => new Element("#fragment"),
    getElementById: id => id === host.id ? host : host.querySelector("#" + id),
    querySelector: selector => selector === "#classified-summary" ? host : host.querySelector(selector),
  },
  fetch: () => { networkCalls++; throw new Error("Network forbidden by offline contract"); },
};
const summarySource = fs.readFileSync(path.join(__dirname, "web", "summary.js"), "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g,"\n");
const servedBundle = fs.readFileSync(path.join(__dirname, "web", "app.js"), "utf8").replace(/\r\n?/g,"\n");
assert.ok(servedBundle.startsWith(summarySource), "served app.js must contain the current tested summary source");
vm.runInNewContext(servedBundle.slice(0, summarySource.length), sandbox, { filename: "web/app.js (summary module)" });
const summary = sandbox.window.DebateSummary;
summary.mount(host);

const phases = ["independent", "cross", "alternatives", "perspectives", "professor", "revision"];
function fixture(overrides = {}) {
  return { id: "OFFLINE-FIXTURE", mode: "research", status: "paused", topic: "OFFLINE ONLY", agents: [
    { name: "GPT", provider: "codex" }, { name: "Claude", provider: "claude" }, { name: "Gemini", provider: "google" },
  ], turns: [], ...overrides };
}
function turn(stage, agent, overrides = {}) {
  return { id: `S${stage}A${agent}`, name: ["GPT", "Claude", "Gemini"][agent - 1] || "GPT", provider: ["codex", "claude", "google"][agent - 1] || "codex", stage: phases[stage - 1], stage_title: phases[stage - 1], prompt: "OFFLINE QUESTION", answer: "OFFLINE ANSWER", parsed: { analysis: "OFFLINE ANALYSIS", conclusion: "OFFLINE PROVISIONAL CONCLUSION", claims: [], audit: [], proposals: [], unresolved: [] }, ...overrides };
}
function render(record, tab = "overview") {
  summary.reset(); summary.render(record);
  if (tab !== "overview") {
    const button = host.querySelector("#ds-tab-" + tab); assert.ok(button, "Tab exists: " + tab); button.click();
  }
  return host.textContent;
}
function metricValues() { return walk(host).filter(item => item.className === "ds-metric").map(item => item.children[0].textContent); }
let passed = 0;
function test(name, fn) {
  try { fn(); passed++; process.stdout.write("PASS " + name + "\n"); }
  catch (error) { process.stderr.write("FAIL " + name + "\n"); throw error; }
}

test("classification reads records without mutation or network", () => {
  const record = fixture({ turns: [turn(1, 1)] }); const original = JSON.stringify(record);
  render(record, "research"); render(record, "evidence");
  assert.equal(JSON.stringify(record), original); assert.equal(networkCalls, 0);
});

test("partial record counts actual turns and leaves unrun phases pending", () => {
  const content = render(fixture({ turns: [turn(1, 1)] }));
  assert.equal(metricValues()[0], "1 / 18");
  assert.equal(walk(host).filter(item => item.className.includes("ds-stage is-pending")).length, 5);
  assert.match(content, /아직 조사하지 않음/);
});

test("partial stages and attempts never imply completed research", () => {
  const record = fixture({ turns: [turn(1, 1)], attempts: [
    { id: "S1A2", attempt_id: "OLD-ATTEMPT", number: 1, status: "failed", error_category: "timeout" },
    { id: "S1A2", attempt_id: "NEW-ATTEMPT", number: 2, status: "started" }
  ] });
  const content = render(record);
  assert.match(content, /단계 미완료/); assert.match(content, /1 \/ 3명 응답/);
  assert.match(content, /1 \/ 6회 발언 수신 · 담당 발언 미완료/);
  assert.doesNotMatch(content, /일부 완료/);
  assert.match(content, /OLD-ATTEMPT/); assert.match(content, /NEW-ATTEMPT/);
  assert.match(content, /종료 미확인/); assert.match(content, /timeout/);
  assert.equal(metricValues()[0], "1 / 18", "attempts do not count as responses");
  assert.match(render({ ...record, status: "completed" }), /실행 종료 · 발언 미완료/);
});

test("completed status alone never invents a final research conclusion", () => {
  const content = render(fixture({ status: "completed", turns: [turn(1, 1)] }), "decisions");
  assert.match(content, /아직 최종 결론이 없습니다/);
  assert.match(content, /참가자별 잠정 결론/);
  assert.doesNotMatch(content, /최종 수정 단계 완료 · 참가자별 결론/);
});

test("active draft is excluded from completed response count", () => {
  render(fixture({ turns: [turn(1, 1)], live: { id: "S1A2", name: "Claude", text: "INCOMPLETE DRAFT" } }));
  assert.equal(metricValues()[0], "1 / 18");
  assert.match(host.textContent, /작성 중인 응답은 완료 집계에서 제외/);
});

test("same provider and same name remain distinct participant slots", () => {
  const agents = [1, 2, 3, 4].map(() => ({ name: "SAME", provider: "codex" }));
  const t1 = turn(1, 1, { name: "SAME", provider: "codex", parsed: { analysis: "FIRST_SLOT_RESULT", conclusion: "FIRST_SLOT_CONCLUSION" } });
  const t4 = turn(1, 4, { name: "SAME", provider: "codex", parsed: { analysis: "FOURTH_SLOT_RESULT", conclusion: "FOURTH_SLOT_CONCLUSION" } });
  render(fixture({ agents, turns: [t1, t4] }));
  const cards = walk(host).filter(item => item.className === "ds-participant-card");
  assert.equal(cards.length, 4);
  assert.match(cards[0].textContent, /FIRST_SLOT_CONCLUSION/); assert.doesNotMatch(cards[0].textContent, /FOURTH_SLOT_CONCLUSION/);
  assert.match(cards[3].textContent, /FOURTH_SLOT_CONCLUSION/); assert.doesNotMatch(cards[3].textContent, /FIRST_SLOT_CONCLUSION/);
  assert.match(cards[1].textContent, /아직 조사하지 않음/);
});

test("smoke rounds are not presented as completed five-stage research", () => {
  const content = render(fixture({ mode: "smoke", turns: [turn(1, 1, { stage: "round1" })] }));
  assert.equal(metricValues()[0], "1 / 6"); assert.match(content, /연구 5단계나 최종 연구 결론의 완료로 집계하지 않습니다/);
});

test("fallback stage IDs classify older records that omit stage names", () => {
  const record = fixture({ turns: [turn(2, 2, { stage: undefined, stage_title: undefined, parsed: { analysis: "CROSS_REVIEW_SENTINEL" } })] });
  assert.match(render(record, "debate"), /CROSS_REVIEW_SENTINEL/);
});

test("model verification flags remain claims pending independent review", () => {
  const record = fixture({ turns: [turn(1, 1, { parsed: { claims: [{ id: "X", claim: "A MODEL CLAIM", kind: "verified_external", status: "모델은 확인했다고 주장", source: "https://example.com/" }], audit: [{ target_turn: "MISSING", original_answer: "NOT IN LOG", error: "MODEL ALLEGATION", verified: true, improved_answer: "PROPOSED_ONLY" }] } })] });
  const content = render(record, "evidence");
  assert.match(content, /원문 대조 대기/); assert.match(content, /오류 여부 미확정/);
  assert.match(content, /인용의 저장 로그 일치 확인 안 됨/); assert.match(content, /개선 답변 후보 · 검토자가 제안/);
  assert.doesNotMatch(content, /실제 교정 호출 기록 있음/);
});

test("only actual nonempty correction responses get actual-rerun labels", () => {
  const review = turn(2, 2, { parsed: { audit: [{ target_turn: "S1A1", original_answer: "OFFLINE ANSWER", revised_question: "REVISED QUESTION" }] } });
  const incomplete = { review_turn: "S2A2", target_turn: "S1A1", revised_question: "REVISED QUESTION" };
  const record = fixture({ turns: [turn(1, 1), review], corrections: [incomplete] });
  assert.doesNotMatch(render(record, "evidence"), /실제 교정 호출 기록 있음/);
  record.corrections.push({ ...incomplete, id: "ACTUAL_CORRECTION", actual_answer: "ACTUAL_RERUN_SENTINEL" });
  const content = render(record, "evidence"); assert.match(content, /실제 교정 호출 기록 있음/); assert.match(content, /ACTUAL_RERUN_SENTINEL/);
});

test("malformed structured model fields do not break any classification tab", () => {
  const values = [null, false, 3, "UNSTRUCTURED", {}, { proposal: "VALID PROPOSAL", claim: "VALID CLAIM" }];
  const record = fixture({ turns: [turn(1, 1, { parsed: { analysis: { text: "OBJECT ANALYSIS" }, claims: values, audit: values, proposals: values, unresolved: values } })] });
  for (const tab of ["overview", "research", "debate", "decisions", "evidence"]) assert.doesNotThrow(() => render(record, tab), tab);
});

test("all long analysis and original answer details remain accessible", () => {
  const full = "FIRST_WORD " + "상세 분석 ".repeat(2500) + " LAST_WORD_SENTINEL";
  const record = fixture({ turns: [turn(1, 1, { prompt: "ORIGINAL_QUESTION_SENTINEL", answer: "ORIGINAL_ANSWER_SENTINEL", parsed: { analysis: full } })] });
  const content = render(record, "research");
  assert.match(content, /LAST_WORD_SENTINEL/); assert.match(content, /ORIGINAL_ANSWER_SENTINEL/); assert.match(content, /ORIGINAL_QUESTION_SENTINEL/);
});

test("Markdown presents headings tables and lists through inert DOM nodes", () => {
  const result = summary.renderMarkdown("# Heading\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\n- First\n- Second\n\n**Strong**");
  const tags = walk(result).map(item => item.tagName);
  for (const tag of ["H2", "TABLE", "TH", "TD", "UL", "LI", "STRONG"]) assert.ok(tags.includes(tag), tag);
});

test("HTML images and unsafe links never become executable or tracking elements", () => {
  const result = summary.renderMarkdown('<script>FAIL()</script>\n<img src=x onerror=FAIL()>\n\n[Unsafe](javascript:FAIL()) [Data](data:text/html,FAIL) [Safe](https://example.com/reference) ![image](https://example.com/pixel)');
  const items = walk(result); assert.ok(items.every(item => !["SCRIPT", "IMG", "IFRAME", "OBJECT"].includes(item.tagName)));
  const links = items.filter(item => item.tagName === "A"); assert.equal(links.length, 2);
  assert.ok(links.every(item => /^https?:/.test(item.href) && item.rel === "noopener noreferrer"));
  assert.match(result.textContent, /<script>/); assert.equal(networkCalls, 0);
});

test("all participants final revisions are labelled as participant opinions", () => {
  const turns = phases.flatMap((_, index) => [1, 2, 3].map(agent => turn(index + 1, agent)));
  const content = render(fixture({ status: "completed", turns }), "decisions");
  assert.match(content, /최종 수정 단계 완료 · 참가자별 결론/);
  assert.match(content, /합의 결론을 새로 작성하거나 채택 여부를 추정하지 않습니다/);
});

test("duplicate response IDs do not count as additional completed slots", () => {
  const t = turn(1, 1); render(fixture({ turns: [t, { ...t }] }));
  assert.equal(metricValues()[0], "1 / 18");
});

test("pure inspection preserves separate participants and incomplete stages", () => {
  const agents = [1, 2, 3, 4].map(() => ({ name: "SAME", provider: "codex" }));
  const record = fixture({ status: "completed", agents, turns: [turn(1, 1), turn(1, 4)] });
  const result = summary.inspect(record);
  assert.equal(result.completed, 2); assert.equal(result.total, 24); assert.equal(result.finalComplete, false);
  assert.deepEqual(Array.from(result.participants, item => item.turns.length), [1, 0, 0, 1]);
  assert.deepEqual(Array.from(result.phases, item => item.done), [2, 0, 0, 0, 0, 0]);
});

test("pure inspection does not change currently displayed record", () => {
  render(fixture({ turns: [turn(1, 1)] })); const previous = host.textContent;
  summary.inspect(fixture({ id: "OTHER", mode: "smoke", turns: [] }));
  assert.equal(host.textContent, previous);
  host.querySelector("#ds-tab-decisions").click(); assert.match(host.textContent, /참가자별 잠정 결론/);
  assert.match(host.textContent, /OFFLINE PROVISIONAL CONCLUSION/);
});

const consensusPhases = ["independent", "cross", "rebuttal", "consensus"];
const consensusAgents = [...fixture().agents, { name: "DeepSeek Flash", provider: "codebuddy", model: "OFFLINE_MODEL_ID" }];
function consensusTurn(stage, agent, overrides = {}) {
  return turn(stage, agent, { name: consensusAgents[agent - 1].name, provider: consensusAgents[agent - 1].provider, stage: consensusPhases[stage - 1], stage_title: ["독립 분석", "교차 반박", "재반론", "최종 합의 검토"][stage - 1], ...overrides });
}

test("four participant consensus mode preserves its four actual stages", () => {
  const record = fixture({ mode: "consensus", agents: consensusAgents, turns: [consensusTurn(1, 4), consensusTurn(3, 4)] });
  const result = summary.inspect(record);
  assert.deepEqual(Array.from(result.phases, phase => phase.id), consensusPhases);
  assert.deepEqual(Array.from(result.phases, phase => phase.done), [1, 0, 1, 0]);
  assert.equal(result.completed, 2); assert.equal(result.total, 16); assert.equal(result.finalComplete, false);
  const content = render(record);
  assert.equal(metricValues()[0], "2 / 16"); assert.match(content, /최종 합의 검토/); assert.match(content, /단계 완료는 발언 수만 의미/);
  assert.equal(host.querySelector("#ds-tab-decisions").textContent, "최종 결론 · 합의 검토");
});

test("consensus stage fallback classifies old snapshots and exposes rebuttal text", () => {
  const record = fixture({ mode: undefined, config: { mode: "consensus" }, agents: consensusAgents, turns: [consensusTurn(3, 4, { stage: undefined, stage_title: undefined, parsed: { analysis: "DEEPSEEK_REBUTTAL_SENTINEL" } })] });
  const content = render(record, "debate");
  assert.match(content, /재반론 · 반박에 대한 답변/); assert.match(content, /DEEPSEEK_REBUTTAL_SENTINEL/);
  assert.doesNotMatch(content, /아직 다중 관점 재검토/); assert.equal(summary.inspect(record).phases[2].done, 1);
});

test("completed consensus status cannot supply missing participant conclusions", () => {
  const record = fixture({ mode: "consensus", status: "completed", agents: consensusAgents, turns: [1, 2, 3].map(agent => consensusTurn(4, agent)) });
  const content = render(record, "decisions");
  assert.match(content, /이 참가자의 최종 검토가 아직 없습니다/);
  assert.match(content, /최종 검토 일부 완료 또는 대기/); assert.match(content, /DeepSeek Flash/);
  const result = summary.inspect(record); assert.equal(result.finalComplete, false);
  assert.deepEqual(Array.from(result.finalOpinions, item => !!item.turn), [true, true, true, false]);
});

test("four final opinions preserve explicit agreement and dissent without inventing unanimity", () => {
  const turns = consensusPhases.flatMap((_, index) => [1, 2, 3, 4].map(agent => consensusTurn(index + 1, agent, { parsed: { analysis: `ANALYSIS_${index}_${agent}`, conclusion: `FINAL_OPINION_${agent}`, agreements: index === 3 ? [`EXPLICIT_AGREEMENT_${agent}`] : [], dissent: index === 3 && agent === 4 ? ["DEEPSEEK_DISSENT_SENTINEL"] : [], unresolved: [] } })));
  const record = fixture({ mode: "consensus", status: "completed", agents: consensusAgents, turns });
  const content = render(record, "decisions"), result = summary.inspect(record);
  for (const agent of [1, 2, 3, 4]) { assert.match(content, new RegExp(`FINAL_OPINION_${agent}`)); assert.match(content, new RegExp(`EXPLICIT_AGREEMENT_${agent}`)); }
  assert.match(content, /DEEPSEEK_DISSENT_SENTINEL/); assert.match(content, /합의 여부 별도 확인/); assert.match(content, /전원 합의로 판정하지 않습니다/);
  assert.equal(result.completed, 16); assert.equal(result.finalComplete, true);
  assert.equal(result.finalOpinions.length, 4); assert.equal(result.agreements.length, 4); assert.equal(result.dissent.length, 1);
  assert.equal(result.dissent[0].item, "DEEPSEEK_DISSENT_SENTINEL");
});

test("expanded consensus includes C design professor critique and final revision", () => {
  const stages = ["independent", "cross", "rebuttal", "alternatives", "professor", "consensus"];
  const turns = stages.flatMap((stage, index) => [1,2,3,4].map(agent => consensusTurn(index+1, agent, { stage, stage_title: stage, parsed: { analysis: "EXPANDED_"+stage, conclusion: "OPINION", claims: [], audit: [] } })));
  const record = fixture({ mode: "consensus", protocol_version: 2, agents: consensusAgents, turns });
  const result = summary.inspect(record);
  assert.equal(result.total, 24); assert.equal(result.completed, 24); assert.equal(result.finalComplete, true);
  assert.match(render(record, "decisions"), /EXPANDED_alternatives/);
  assert.match(render(record, "evidence"), /EXPANDED_professor/);
  assert.match(render(record, "overview"), /6단계/);
});

test("audit quote normalizes complete decoded quotes but rejects altered suffixes", () => {
  const original = turn(1,1,{ answer: JSON.stringify({analysis:'계약 실질에 관한 판단을 먼저 검토해야 한다.\n독립 검증 필요.'}) });
  const review = turn(2,2,{ parsed: { audit: [{target_turn:'S1A1',original_answer:'“계약 실질에 관한 판단을 먼저 검토해야 한다. 독립 검증 필요.”'}] } });
  const valid = render(fixture({turns:[original,review]}), 'evidence');
  assert.match(valid,/원답변 인용이 저장 로그와 일치/);
  review.parsed.audit[0].original_answer='계약 실질에 관한 판단을 먼저 검토하지 않아도 된다.';
  assert.match(render(fixture({turns:[original,review]}), 'evidence'), /인용의 저장 로그 일치 확인 안 됨/);
});

assert.equal(networkCalls, 0);
test("web evidence shows provenance and access failures as self reports", () => {
  const record = fixture({ turns: [turn(2,1,{ parsed: { web_checks: [{
    claim_id: "c-web", reason: "MISSING_SOURCE", query: "PUBLIC_QUERY",
    url: "https://example.org/source", title: "SOURCE_TITLE", checked_at: "CHECK_TIME",
    passage: "PASSAGE_SENTINEL", result: "access_failed", limitation: "ACCESS_LIMIT"
  }] } })] });
  const content = render(record, "evidence");
  for (const value of ["PUBLIC_QUERY", "https://example.org/source", "CHECK_TIME", "PASSAGE_SENTINEL", "ACCESS_LIMIT", "접근 실패", "모델 자기 보고"])
    assert.ok(content.includes(value), value);
});
test("v3 shows seven phases and keeps seed ideas unselected", () => {
  const first = turn(1,1,{ protocol_checks:{decision_status:"not_due"}, parsed:{analysis:"INDEPENDENT_ONLY",conclusion:"EARLY_OPINION",candidate_seeds:[{id:"S1A1.SEED1",idea:"SEED_DETAIL",assumptions:"SEED_ASSUMPTION"}],proposals:[{proposal:"EARLY_PROPOSAL",decision:"채택"}]}});
  const record=fixture({protocol_version:3,domain:"accounting_pbl",turns:[first],review_state:{status:"gathering",expected_reviews:2,recorded_reviews:0,critical_pending_count:0}});
  const overview=render(record);
  assert.match(overview,/반론 응답/);assert.match(overview,/1 \/ 21/);
  assert.match(overview,/잠정 의견 · 선정 전/);
  const decisions=render(record,"decisions");
  assert.match(decisions,/SEED_DETAIL/);assert.match(decisions,/SEED_ASSUMPTION/);
  assert.match(decisions,/미평가 후보/);
  assert.match(decisions,/아직 최종 판단 단계가 아닙니다/);
  assert.doesNotMatch(decisions,/채택 · 1건/);
});
test("v3 traces actual claim, challenge, response and unresolved critical review", () => {
  const claim=turn(1,1,{parsed:{claims:[{id:"S1A1.CLM1",claim:"ORIGINAL_CLAIM"}]}});
  const challenge=turn(2,2,{stage:"cross",parsed:{challenges:[{id:"S2A2.CH1",target_claim:"S1A1.CLM1",target_turn:"S1A1",quote:"ORIGINAL_CLAIM",disposition:"challenge",reason:"CHALLENGE_REASON",evidence:"SOURCE_REQUIRED"}]}});
  const reply=turn(3,1,{stage:"rebuttal",parsed:{responses:[{challenge_id:"S2A2.CH1",disposition:"부분 수용",reason:"REPLY_REASON",resolution:"open",revised_claim:"REVISED_CLAIM"}]}});
  const record=fixture({protocol_version:3,turns:[claim,challenge,reply],review_state:{status:"needs_review",critical_pending_count:1,pending_challenges:[{challenge_id:"S2A2.CH1",target:"S1A1.CLM1",critical:true,reason:"UNRESOLVED"}]}});
  const content=render(record,"debate");
  for(const value of ["원주장 → 반박 → 응답","ORIGINAL_CLAIM","CHALLENGE_REASON","REPLY_REASON","REVISED_CLAIM","미해결로 남김"]) assert.ok(content.includes(value),value);
  assert.match(render(record),/핵심 반박 미해결 1건/);
});
test("v3 withholds final recommendation even when all calls report completed", () => {
  const final=turn(7,1,{stage:"revision",protocol_checks:{decision_status:"withheld",reasons:["MISSING_EVIDENCE"]},parsed:{conclusion:"MODEL_FINAL_WORDING",decision:{status:"conditional_recommendation",reason:"MODEL_REASON"}}});
  const record=fixture({protocol_version:3,status:"completed",turns:[final],review_state:{status:"needs_review",final_complete:true,critical_pending_count:1,blockers:["MISSING_EVIDENCE"]}});
  const content=render(record,"decisions");
  assert.match(content,/최종 권고 보류/);assert.match(content,/MISSING_EVIDENCE/);assert.match(content,/MODEL_FINAL_WORDING/);
  assert.doesNotMatch(content,/전원 합의 완료/);
});
test("v3 one-round general debate neither invents a second round nor accounting C", () => {
  const record=fixture({protocol_version:3,domain:"general",mode:"smoke",smoke_rounds:1,turns:[turn(1,1,{stage:"round1"})]});
  const content=render(record);
  assert.match(content,/1 \/ 3/);assert.doesNotMatch(content,/22라운드 토론/);
  const decision=render(record,"decisions");assert.match(decision,/설명·선택지 비교/);
});
test("supplied answers display original, per-AI changes, cross discussion and moderator judgment separately", () => {
  const first = {id:"S1A1.SC1",case_id:"USERCASE1",owner:"A1",turn:"S1A1",name:"GPT",stage:"independent",stage_title:"독립 조사",verdict:"error",label:"오류",valid:true,reason:"FIRST REASON",evidence:"SOURCE",limitations:"LIMIT",change_reason:"FIRST"};
  const final = {...first,id:"S7A2.SC1",owner:"A2",turn:"S7A2",name:"Claude",stage:"revision",stage_title:"최종 판단",verdict:"not_error",label:"오류 아님",reason:"FINAL REASON",corrected_answer:"",revised_question:""};
  final.item_coverage = [{item:"Repo",status:"partial",reason:"MISSING TRANSACTION PREMISE"}];
  const cases = [{id:"USERCASE1",question:"Q",answer:"<script>UNTRUSTED ANSWER</script>",source:"USER SOURCE",suspicion:"PRIVATE REASON",history:[first,final],latest:[first,final],moderator:final,label:"오류 아님",scope:"AI 판단"},
    {id:"USERCASE2",answer:"SECOND",label:"총괄 최종 판단 대기",history:[],latest:[],moderator:null},
    {id:"USERCASE3",answer:"THIRD",label:"일부 오류·조건 누락",history:[],latest:[],moderator:null}];
  const record = fixture({turns:[{...turn(1,1),name:"GPT"},{...turn(2,2),name:"Claude",parsed:{challenges:[{id:"S2A2.CH1",target_claim:"S1A1.SC1",reason:"CROSS REASON"}]}}],result_overview:{submitted_audit:{cases,issues:[]}}});
  for (const tab of ["results","evidence"]) {
    const content=render(record,tab);
    for (const value of ["의심 답변 1","의심 답변 2","의심 답변 3","FINAL REASON","FIRST REASON","GPT","Claude","CROSS REASON","UNTRUSTED ANSWER","총괄의 최종 판단"]) assert.ok(content.includes(value),value);
    assert.ok(!walk(host).some(n=>n.tagName==="SCRIPT"));
  }
  const evidenceText = render(record,"evidence");
  for (const value of ["1. 의심 답변 검증","2. 근거 자료","3. 최종 적대적 검토","일부 대응 · 보완 필요","MISSING TRANSACTION PREMISE"]) assert.ok(evidenceText.includes(value),value);
  const auxiliary = walk(host).find(n=>n.tagName === "DETAILS" && n.textContent.includes("토론 중 발견한 오류 · 보조 이력"));
  assert.ok(auxiliary && !auxiliary.open, "incidental audits remain readable but initially collapsed");
  assert.equal(networkCalls,0);
});
assert.equal(networkCalls,0);
test("v3 malformed seed and candidate records leave raw data readable", () => {
  const record=fixture({protocol_version:3,turns:[turn(1,1,{parsed:{analysis:"ORIGINAL_BODY",candidate_seeds:[null,false,{}],candidates:[null,false,{}],decision:17}})]});
  assert.match(render(record,"research"),/ORIGINAL_BODY/);
  assert.match(render(record,"decisions"),/미평가 후보/);
});
assert.equal(networkCalls,0);
test("balanced final review displays original retention without fabricated defects", () => {
  const assessment = { status: "no_material_defect", checked_ids: ["S4A2.C1"], criteria: ["ACTUAL_CRITERION"], retained_reasons: ["VALID_ORIGINAL_REASON"], scope_limitations: ["LIMITED_SCOPE"], summary: "KEEP_ORIGINAL" };
  const record = fixture({ protocol_version: 3, review_policy_version: 1, turns: [turn(6, 1, { stage: "professor", stage_title: "평가 기준 기반 최종 검토", parsed: { analysis: "OFFLINE REVIEW", review_assessment: assessment, challenges: [] } })], review_state: { final_reviews: [{ turn_id: "S6A1", record_complete: true, reported_status: "no_material_defect" }] } });
  const original = JSON.stringify(record), content = render(record, "evidence");
  assert.match(content, /중대한 결함 없음 · 원안 유지/);
  assert.match(content, /VALID_ORIGINAL_REASON/);
  assert.match(content, /ACTUAL_CRITERION/);
  assert.match(content, /LIMITED_SCOPE/);
  assert.match(content, /실제 교수 평가나 독립 검증 완료를 의미하지 않습니다/);
  assert.doesNotMatch(content, /감점 요인을 담은/);
  assert.equal(JSON.stringify(record), original);
});

test("missing or malformed review assessment is never presented as a pass", () => {
  const record = fixture({ protocol_version: 3, review_policy_version: 1, turns: [turn(6, 1, { stage: "professor", parsed: { analysis: "RAW_REVIEW", review_assessment: [] } })] });
  const content = render(record, "evidence");
  assert.match(content, /검토 판정 미기록/);
  assert.match(content, /통과로 집계하지 않습니다/);
  assert.doesNotMatch(content, /중대한 결함 없음 · 원안 유지/);
});

test("review finding types and reasoned rejection stay distinct", () => {
  const check = turn(6, 2, { stage: "professor", parsed: { challenges: [{ id: "S6A2.CH1", target_candidate: "S4A1.C1", finding_type: "optional_suggestion", criterion: "OPTIONAL_CRITERION", impact: "OPTIONAL_IMPACT", reason: "CRITIQUE_REASON", disposition: "challenge" }] } });
  const reply = turn(7, 1, { stage: "revision", parsed: { responses: [{ challenge_id: "S6A2.CH1", disposition: "기각", reason: "REJECTION_EVIDENCE", resolution: "addressed", revised_claim: "RETAIN_ORIGINAL" }] } });
  const record = fixture({ protocol_version: 3, review_policy_version: 1, turns: [check, reply] });
  const content = render(record, "debate");
  assert.match(content, /선택적 제안 · 자체로 권고 차단 안 함/);
  assert.match(content, /OPTIONAL_CRITERION/);
  assert.match(content, /OPTIONAL_IMPACT/);
  assert.match(content, /REJECTION_EVIDENCE/);
  assert.match(content, /RETAIN_ORIGINAL/);
});

test("legacy records retain professor phase while new records use final review", () => {
  const record = fixture({ protocol_version: 3 });
  assert.match(render(record), /교수 관점 비판/);
  record.review_policy_version = 1;
  assert.match(render(record), /평가 기준 기반 최종 검토/);
  assert.match(host.textContent, /중대한 결함이 없으면 원안을 유지/);
});
test("course-guided records show downsides, ethics lenses, counterexamples, notes and an explicit correction action", () => {
  const original = turn(1, 1, { answer: JSON.stringify({ analysis: "ORIGINAL_AUDITED_ANSWER" }), parsed: { analysis: "ORIGINAL_AUDITED_ANSWER", claims: [{ id: "S1A1.CLM1", claim: "NOTE_CLAIM_SENTINEL", kind: "task_fact", source: "case.md:L1" }] } });
  const review = turn(2, 2, { stage: "cross", parsed: { audit: [{ target_turn: "S1A1", original_answer: "ORIGINAL_AUDITED_ANSWER", error: "AUDIT_ERROR", error_type: "기준서 왜곡", revised_question: "REVISED_QUESTION_SENTINEL", lesson: "LESSON_SENTINEL" }], student_feedback: [{ id: "S2A2.SF1", quote: "DRAFT", blind_spot: "BLIND_SPOT_SENTINEL", question: "SELF_CHECK_SENTINEL" }] } });
  const alternative = turn(4, 1, { stage: "alternatives", parsed: { candidates: [{ id: "S4A1.C1", proposal: "CANDIDATE", a_downside: "A_DOWNSIDE_SENTINEL", b_downside: "B_DOWNSIDE_SENTINEL", mechanism: "MECHANISM_SENTINEL", removal_status: "goal" }] } });
  const perspective = turn(5, 1, { stage: "perspectives", parsed: { ethics_assessment: [{ candidate_id: "S4A1.C1", utilitarian: "UTIL_SENTINEL", deontological: "DEON_SENTINEL", communitarian: "COMM_SENTINEL", minority_burden: "MINORITY_SENTINEL" }] } });
  const professor = turn(6, 2, { stage: "professor", parsed: { analysis: "REVIEW", review_assessment: { status: "no_material_defect", checked_ids: ["S4A1.C1"], criteria: ["CRITERION"], retained_reasons: ["RETAINED"], scope_limitations: ["SCOPE"], summary: "SUMMARY", counterexample_checks: [{ target_id: "S4A1.C1", counterexample: "COUNTEREXAMPLE_SENTINEL", holds: "no", outcome: "no_material_defect" }], fact_checks: [{ item: "FACT_ITEM", result: "일치", source: "FACT_SOURCE" }] } } });
  const final = turn(7, 1, { stage: "revision", parsed: { decision: { status: "conditional_recommendation", candidate_id: "S4A1.C1", basis_claim_ids: ["S1A1.CLM1"] } } });
  const record = fixture({ protocol_version: 3, review_policy_version: 1, course_guidance_version: 1, domain: "accounting_pbl", student_draft: "STUDENT_DRAFT_SENTINEL", turns: [original, review, alternative, perspective, professor, final], review_state: { status: "conditional", guidance_checks: { candidate_field_gaps: ["S4A9.C9"] } } });
  const calls = []; summary.reset(); summary.render(record, { onCorrect: (...args) => calls.push(args) });
  for (const value of ["STUDENT_DRAFT_SENTINEL", "BLIND_SPOT_SENTINEL", "최종 적대적 검토 · 반례 확인", "S4A9.C9"]) assert.ok(host.textContent.includes(value), value);
  host.querySelector("#ds-tab-decisions").click();
  for (const value of ["A_DOWNSIDE_SENTINEL", "MECHANISM_SENTINEL", "목표 단계 · 입증 전", "[주석 1] S1A1.CLM1", "NOTE_CLAIM_SENTINEL"]) assert.ok(host.textContent.includes(value), value);
  host.querySelector("#ds-tab-debate").click();
  for (const value of ["UTIL_SENTINEL", "MINORITY_SENTINEL"]) assert.ok(host.textContent.includes(value), value);
  host.querySelector("#ds-tab-evidence").click();
  for (const value of ["COUNTEREXAMPLE_SENTINEL", "반례 불성립 · 원안 유지", "FACT_ITEM", "LESSON_SENTINEL", "기준서 왜곡", "근거 · 오류 · 적대적 검토"]) assert.ok(host.textContent.includes(value), value);
  assert.ok(host.querySelector("#claim-S1A1.CLM1"), "evidence rows are addressable by claim ID");
  const action = walk(host).find(item => item.tagName === "BUTTON" && item.textContent === "수정 질문으로 실제 재호출");
  assert.ok(action, "matched audit with a revised question offers an explicit correction action"); action.click();
  assert.deepEqual(calls, [["S2A2", 0, "REVISED_QUESTION_SENTINEL"]]);
  summary.render({ ...record, corrections: [{ id: "DONE", review_turn: "S2A2", target_turn: "S1A1", revised_question: "REVISED_QUESTION_SENTINEL", actual_answer: "DONE_ANSWER" }] });
  host.querySelector("#ds-tab-evidence").click();
  assert.ok(!walk(host).some(item => item.tagName === "BUTTON" && item.textContent === "수정 질문으로 실제 재호출"), "a completed correction is not offered again as-is");
  assert.ok(walk(host).some(item => item.tagName === "BUTTON" && item.textContent === "질문을 고쳐 다시 재호출"), "after a rerun the student may send an edited question");
  assert.equal(networkCalls, 0);
});

test("v2 records separate run, judgment and assignment states and show what each call received", () => {
  const delivery = { source_plan: 1, stage: "independent", case_file: "(PBL)7주차_중간PBL과제.md", units: ["K1115:5", "K1115:B66"], abridged: ["K1115:B66"], lectures: ["W6-부정의 3요소"], omitted: [{ id: "K1037:19", reason: "입력 한도" }], auxiliary_lines: { "2주차_PRE.md": 12 },
    shared_record: { policy: 1, bytes: 12345, full: ["S1A2.CLM1"], abridged: ["S1A2.CLM2"], omitted: { "OMITTED_LABEL_SENTINEL": 3 } }, stretched: true, prompt_budget: 119500 };
  const independent = turn(1, 1, { stage: "independent", delivery, parsed: { analysis: "A", legality_checks: [{ id: "S1A1.LQ1", item: "Repo", question: "LEGAL_Q_SENTINEL", judgment: "undetermined", basis: "BASIS_SENTINEL", uncertainty: "UNCERTAIN_SENTINEL" }], requirement_notes: [{ requirement_id: "R6", status: "addressed", claim_ids: ["S1A1.CLM1"], reason: "NOTE_REASON_SENTINEL" }] } });
  const cross = turn(2, 2, { stage: "cross", parsed: { audit: [{ target_turn: "S1A1", original_answer: "OFFLINE ANSWER", error: "E", revised_question: "AI_QUESTION_SENTINEL" }] } });
  const professor = turn(6, 2, { stage: "professor", parsed: { review_assessment: { status: "verification_needed", checked_ids: ["S1A1.CLM1"], criteria: ["C"], retained_reasons: [], scope_limitations: ["S"], summary: "SUM", fact_checks: [], fact_check_note: "FACT_NOTE_SENTINEL",
    counterexample_checks: [{ target_id: "S1A1.CLM1", counterexample: "CX", sources: "원문 미제공", checked: "미확인", scope: "SCOPE_SENTINEL", holds: "assumption_changed", assumption_change: "ASSUMPTION_SENTINEL", outcome: "premise_unverified" }] } } });
  const review_state = { status: "gathering", requirements: [{ id: "R1", title: "TITLE_R1_SENTINEL", source: "case:L85~L89", stage: "independent", status: "partial", links: ["S1A1.LQ1"], note: "R1_NOTE_SENTINEL", parts: [{ name: "최초 질의 기록", status: "recorded", note: "" }, { name: "다른 AI의 원문 대조", status: "missing", note: "" }, { name: "오류 후보·교정", status: "info", note: "" }] }, { id: "R10", title: "TITLE_R10", source: "case:L144~L148", stage: "professor", status: "not_due", links: [], note: "" }],
    assignment_record: { counts: { partial: 1, not_due: 1 } }, delivery_omissions: [{ turn: "S1A1", omitted: ["K1037:19"] }], unselected_sources: ["K1109:3.2.6"] };
  const corrections = [{ id: "C1", review_turn: "S2A2", audit_index: 0, target_turn: "S1A1", revised_question: "STUDENT_Q_SENTINEL", question_source: "student_edited", ai_revised_question: "AI_QUESTION_SENTINEL", student_reason: "REASON_SENTINEL", extra_units: ["K1115:B66"], actual_answer: "RERUN_SENTINEL" }];
  const record = fixture({ protocol_version: 3, review_policy_version: 1, course_guidance_version: 2, domain: "accounting_pbl", turns: [independent, cross, professor], review_state, corrections });
  summary.reset(); summary.render(record, { onCorrect() {} });
  for (const value of ["실행 상태", "일시정지", "판단 상태", "검토 자료 수집 중", "과제 요건 기록", "기록 0 · 일부 1 · 없음 0", "점수 아님", "TITLE_R1_SENTINEL", "R1_NOTE_SENTINEL", "일부 기록", "담당 단계 전", "다른 AI의 원문 대조 · 기록 없음", "오류 후보·교정 · 참고", "S1A1: K1037:19", "선택 자료에 없는 필수 근거 1개", "K1109:3.2.6"]) assert.ok(host.textContent.includes(value), value);
  host.querySelector("#ds-tab-research").click();
  for (const value of ["LEGAL_Q_SENTINEL", "판단 보류", "UNCERTAIN_SENTINEL", "NOTE_REASON_SENTINEL", "이 발언에 실제 전달된 근거 · 기준서 2개 · 강의 1개 · 미전달 1개", "K1115:5, K1115:B66", "그중 생략 표시가 있는 발췌 문단", "역할별 공유 기록", "원문 1건 · 축약 1건", "OMITTED_LABEL_SENTINEL 3건", "질문 한도 확장", "119,500바이트", "2주차_PRE.md 12행", "K1037:19 (입력 한도)"]) assert.ok(host.textContent.includes(value), value);
  host.querySelector("#ds-tab-evidence").click();
  for (const value of ["SCOPE_SENTINEL", "가정을 바꿔야 성립", "ASSUMPTION_SENTINEL", "FACT_NOTE_SENTINEL", "학생이 고친 질문", "STUDENT_Q_SENTINEL", "AI_QUESTION_SENTINEL", "REASON_SENTINEL", "K1115:B66", "RERUN_SENTINEL"]) assert.ok(host.textContent.includes(value), value);
  assert.ok(walk(host).some(item => item.tagName === "BUTTON" && item.textContent === "질문을 고쳐 다시 재호출"), "an edited rerun links by audit position");
  summary.reset(); summary.render({ ...record, course_guidance_version: 1 });
  assert.ok(!host.textContent.includes("과제 요건 기록"), "version 1 records keep their earlier review panel");
  assert.equal(networkCalls, 0);
});
test("a finished run opens on a '결과' tab: conclusion, positions, flow, who rebutted whom, C candidates and error candidates", () => {
  const position = (turnId, name, reason) => ({ turn: turnId, name, status: "conditional_recommendation", label: "조건부 권고", candidate_id: "S4A1.C1", candidate: "정정 선행형: CANDIDATE-SENTINEL", reason,
    conditions: ["CONDITION-SENTINEL"], blockers: ["BLOCKER-SENTINEL"], program_status: "withheld", program_label: "보류", program_reasons: [] });
  const finding = { key: "S2A2#1", step1: true, step1_source: "auto", tier: "ai_confirmed", label: "AI 교차 확인 · 학생 최종 확인 필요", tone: "red", target_turn: "S1A1", target_name: "GPT", quote: "WRONG_QUOTE_SENTINEL",
    error_types: ["기준서 왜곡"], verdict: { verdict: null, scope: null, note: "", time: null }, lines: [{ file: "09_제1115호.md", line: 8, text: "SOURCE_LINE_SENTINEL" }],
    signals: { quote_ok: true, evidence: "source", sources_ok: true, cited: true, reply: "admitted", admitted: true, corroborated: false, reviewers: ["Claude"] },
    reports: [{ review_turn: "S2A2", index: 0, reviewer: "Claude", error: "ERROR_SENTINEL", improved_answer: "FIX_SENTINEL", evidence_kind: "source", unresolved: [], reply: { link: "linked", challenge_id: "S2A2.CH1", disposition: "수용", reason: "REPLY-SENTINEL" } },
      { review_turn: "S3A2", index: 0, reviewer: "Claude", error: "SECOND_REPORT_SENTINEL", improved_answer: "", evidence_kind: "unresolved", unresolved: ["L145"], reply: { link: "ambiguous", challenge_id: null } }] };
  const other = { key: "S2A1#1", step1: false, step1_source: "auto", tier: "suspected", label: "오류 의심 · 원문 대조 필요", tone: "amber", target_turn: "S4A2", target_name: "Claude", quote: "OTHER_QUOTE_SENTINEL", error_types: [],
    verdict: { verdict: null, scope: null, note: "", time: null }, lines: [], signals: { quote_ok: true, evidence: "reasoning", sources_ok: true, cited: false, reply: "none", admitted: false, corroborated: false, reviewers: ["GPT"] },
    reports: [{ review_turn: "S2A1", index: 0, reviewer: "GPT", error: "OTHER_ERROR", evidence_kind: "reasoning", unresolved: [], reply: { link: "none" } }] };
  const overview = { participants: 2, complete: true, program_withheld: 2,
    positions: [position("S7A1", "GPT", "GPT_FINAL_SENTINEL"), position("S7A2", "Claude", "CLAUDE_FINAL_SENTINEL")], tally: [{ candidate_id: "S4A1.C1", names: ["GPT", "Claude"], candidate: "정정 선행형: CANDIDATE-SENTINEL" }],
    withheld: { quote_rule: 1, failed_answers: [{ turn: "S2A2", name: "Claude", stage_title: "교차 검증" }], invalid_reviews: { self_review: 2 }, invalid_total: 2, unlinked_responses: 1, missing_total: 3, missing_reviews: { A1: 3 },
      critical: [{ challenge_id: "S6A2.CH1", target: "S4A1.C1", reason: "CRITICAL-SENTINEL" }], final_review_issues: 2 },
    program_reasons: [{ reason: "필수 근거가 미확인", explain: "EXPLAIN_SENTINEL", names: ["GPT"] }],
    recheck: { from_version: 1, to_version: 2, newly_valid: 23, by_field: [{ field: "uncertainty", label: "최초 판단의 불확실성", count: 15 }], still_invalid: { self_review: 21 },
      before: { invalid_references: 173, missing_reviews: 56, final_withheld: 4, critical_pending: 1 }, after: { invalid_references: 127, missing_reviews: 56, final_withheld: 4, critical_pending: 4, blockers: ["AFTER-BLOCKER"] }, checked_at: "2026-10-23T14:00:00+09:00", source_sha256: "abcdef" },
    findings: [finding, other], step1: { required: 3, count: 1, student_confirmed: 0, ai_confirmed: 1, suspected: 0, corrected: 0, auto_classified: 1 },
    requirements: { total: 13, counts: { recorded: 12, partial: 1 }, gaps: [{ id: "R1", title: "환각 감사", status: "partial", note: "NOTE_SENTINEL" }] }, next_steps: ["NEXT_STEP_SENTINEL · S4A1.C1"],
    people: [{ owner: "A1", name: "GPT", model: "gpt-x", effort: "low", moderator: false, final: position("S7A1", "GPT", "GPT_FINAL_SENTINEL"), claims: ["FIRST_CLAIM_SENTINEL"], claim_count: 1, last_change: "", failed: [] },
      { owner: "A2", name: "Claude", model: "claude-x", effort: "low", moderator: true, final: position("S7A2", "Claude", "CLAUDE_FINAL_SENTINEL"), claims: [], claim_count: 0, last_change: "CHANGE-SENTINEL", failed: ["S2A2"] }],
    rebuttals: { people: [{ owner: "A1", name: "GPT" }, { owner: "A2", name: "Claude" }], cells: [{ from: "A2", to: "A1", challenge: 3, unverified: 1, supports: 2, accepted: 3, rejected: 1, unanswered: 0 }],
      highlights: [{ challenge_id: "S2A2.CH1", from_name: "Claude", to_name: "GPT", kind: "핵심 반박", point: "HIGHLIGHT-SENTINEL", answer: "수용", answer_reason: "" }], more_highlights: 0, skipped: { self: 2, unknown: 5 } },
    flow: [{ stage: "independent", title: "독립 조사", claims: 9, challenges: 0, responses: 0, accepted: 0, candidates: 0, lines: [{ turn: "S1A1", name: "GPT", failed: false, line: "FLOW-LINE-SENTINEL" }] }],
    candidates: [{ id: "S4A1.C1", name: "정정 선행형", number: "1", label: "GPT · 4단계 대안 C 설계 · 후보 1", author: "GPT", summary: "정정 선행형: CANDIDATE-SENTINEL", mechanism: "MECHANISM-SENTINEL", a_downside: "", b_downside: "", residual_risk: "",
      combines: [{ ref: "C3", id: "S4A1.C3", text: "COMBINED-SENTINEL" }], supporters: ["GPT", "Claude"] }],
    synthesis: null };
  const review = turn(2, 2, { stage: "cross", parsed: { audit: [{ target_turn: "S1A1", original_answer: "WRONG_QUOTE_SENTINEL", error: "ERROR_SENTINEL" }] } });
  const finals = [turn(7, 1, { stage: "revision", parsed: { decision: { status: "conditional_recommendation", candidate_id: "S4A1.C1", reason: "GPT_FINAL_SENTINEL" } }, protocol_checks: { decision_status: "withheld" } }),
    turn(7, 2, { stage: "revision", parsed: { decision: { status: "conditional_recommendation", candidate_id: "S4A1.C1", reason: "CLAUDE_FINAL_SENTINEL" } }, protocol_checks: { decision_status: "withheld" } })];
  const candidateTurn = turn(4, 1, { stage: "alternatives", stage_title: "대안 C 설계", parsed: { candidates: [{ id: "S4A1.C1", proposal: "정정 선행형: CANDIDATE-SENTINEL" }] } });
  const record = fixture({ protocol_version: 3, review_policy_version: 1, course_guidance_version: 3, domain: "accounting_pbl", status: "completed", agents: [{ name: "GPT", provider: "codex" }, { name: "Claude", provider: "claude", is_moderator: true }],
    turns: [turn(1, 1), review, candidateTurn, ...finals], result_overview: overview, result_document: true, review_state: { status: "needs_review" } });
  const original = JSON.stringify(record), calls = [], asked = [];
  summary.reset(); summary.render(record, { onAuditVerdict: (...args) => calls.push(args), onSynthesize: name => asked.push(name), onOpenReport() {} });
  assert.equal(host.querySelector("#ds-tab-results")?.getAttribute("aria-selected"), "true", "a finished run opens on its results");
  const text = host.textContent;
  for (const value of ["결론", "AI 2명 중 2명이 '정정 선행형 (GPT의 후보 1)'을 권고했습니다", "1. 정정 선행형", "원문에 명시한 후보·아이디어", "'조건부 권고'란?", "누가 어떤 후보를 권고했나", "2명 · GPT, Claude",
    "AI별 최종 입장", "CONDITION-SENTINEL", "BLOCKER-SENTINEL", "FIRST_CLAIM_SENTINEL", "CHANGE-SENTINEL", "총괄",
    "대화 흐름", "주장 9", "FLOW-LINE-SENTINEL", "누가 누구를 반박했나", "반박 4", "수용 3 · 기각 1 · 무응답 0", "자기 주장 검토 2건 · 대상 ID가 없는 검토 5건", "HIGHLIGHT-SENTINEL",
    "C 후보 한눈에", "GPT의 후보 1개", "권고 · GPT, Claude", "GPT · 4단계 대안 C 설계 · 후보 3 = COMBINED-SENTINEL",
    "환각·오류 후보", "과제 STEP 1 관련 1건", "WRONG_QUOTE_SENTINEL", "ERROR_SENTINEL", "FIX_SENTINEL", "OTHER_QUOTE_SENTINEL",
    "프로그램 검사 상세", "검토 기록 보완 필요 2건", "173건 → 127건", "미해결 핵심 반박 1건 → 4건", "NEXT_STEP_SENTINEL · GPT · 4단계 대안 C 설계 · 후보 1", "결과 요약 문서(Markdown) 열기"])
    assert.ok(text.includes(value), value);
  assert.equal(JSON.stringify(record), original, "readable labels preserve stored IDs");
  assert.ok(walk(host).some(item => item.className === "ds-heat-4"), "the busiest reviewer pair is shaded darkest");
  assert.ok(walk(host).some(item => item.className === "ds-vote-fill ds-pct-100"), "the vote bar width comes from a class, not an inline style");
  const red = walk(host).find(item => item.className === "ds-halluc ds-halluc-red"), amber = walk(host).find(item => item.className === "ds-halluc ds-halluc-amber");
  assert.ok(red?.tagName === "DETAILS" && red.textContent.includes("WRONG_QUOTE_SENTINEL") && amber?.textContent.includes("OTHER_QUOTE_SENTINEL"), "one compact row per error candidate, coloured by its tier");
  for (const value of ["REPLY-SENTINEL", "SECOND_REPORT_SENTINEL", "응답 연결 미확인", "SOURCE_LINE_SENTINEL"]) assert.ok(red.textContent.includes(value), "the row keeps the full card: " + value);
  walk(red).find(item => item.tagName === "BUTTON" && item.textContent === "오류 맞음").click();
  walk(red).find(item => item.tagName === "BUTTON" && item.textContent === "STEP 1에서 제외").click();
  assert.equal(JSON.stringify(calls), JSON.stringify([["S2A2#1", { verdict: "error", currentNote: "" }], ["S2A2#1", { scope: "out", currentNote: "" }]]), "objects made inside the sandbox are compared by value");
  walk(host).find(item => item.tagName === "BUTTON" && item.textContent === "총괄 AI에게 결론·설명 정리 맡기기").click();
  assert.deepEqual(asked, ["Claude"], "the moderator is asked only on an explicit click");
  const synthesis = { id: "SYN", time: "2026-10-23T15:00:00+09:00", agent: "Claude", model: "claude-x", failed: false, stale: false, parsed: {
    conclusion: { headline: "HEADLINE-SENTINEL", recommendation: "RECOMMEND-SENTINEL", candidate_ids: ["S4A1.C1"], why: "WHY-SENTINEL", conditions: [{ condition: "COND-A", meaning: "MEANING-A", how_to_check: "CHECK-A" }],
      if_conditions_fail: "FAIL-SENTINEL", not_recommended: [{ option: "A안", why: "NOT-WHY" }], remaining_risks: ["RISK-SENTINEL"], agreement: "AGREE-SENTINEL", minority_views: [] },
    participants: [{ name: "GPT", final_position: "PLAIN-POSITION-SENTINEL", key_points: [], changed: "" }], conversation: [{ stage: "독립 조사", summary: "TALK-SENTINEL" }],
    rebuttals: [{ from: "Claude", to: "GPT", point: "SYN-REBUTTAL-SENTINEL", outcome: "수용" }], candidates: [{ id: "S4A1.C1", plain_name: "PLAIN-NAME-SENTINEL", what: "WHAT-SENTINEL", combines: "" }],
    hallucinations: [{ key: "S2A2#1", plain: "PLAIN-ERROR-SENTINEL" }] } };
  summary.reset(); summary.render({ ...record, result_overview: { ...overview, synthesis } }, { onSynthesize() {} });
  for (const value of ["총괄 AI 정리 · Claude", "HEADLINE-SENTINEL", "총괄 AI의 의견", "RECOMMEND-SENTINEL", "WHY-SENTINEL", "COND-A", "MEANING-A", "CHECK-A", "FAIL-SENTINEL", "A안: NOT-WHY", "RISK-SENTINEL",
    "PLAIN-POSITION-SENTINEL", "TALK-SENTINEL", "SYN-REBUTTAL-SENTINEL", "PLAIN-NAME-SENTINEL", "WHAT-SENTINEL", "PLAIN-ERROR-SENTINEL", "총괄 AI로 다시 정리하기"])
    assert.ok(host.textContent.includes(value), value);
  summary.reset(); summary.render({ ...record, active: true }, { onAuditVerdict() {}, onSynthesize() {} });
  assert.ok(!walk(host).some(item => item.tagName === "BUTTON" && ["오류 맞음", "총괄 AI에게 결론·설명 정리 맡기기"].includes(item.textContent)), "no verdict or AI call while a call is running");
  summary.reset(); summary.render({ ...record, result_overview: undefined });
  assert.ok(!host.querySelector("#ds-tab-results"), "older records without an overview keep their earlier screen");
  summary.reset(); summary.render(record); host.querySelector("#ds-tab-overview").click();
  assert.ok(host.textContent.includes("에서 한눈에 볼 수 있습니다"), "the overview points to the results tab");
  assert.equal(networkCalls, 0);
});
test("result conversation keeps final judgment separate from other stages containing 검토", () => {
  const flow = [{ stage: "perspectives", title: "윤리·손익·실패 검토", lines: [] },
    { stage: "professor", title: "최종 적대적 검토 · 평가 기준·반례 확인", lines: [] },
    { stage: "revision", title: "검토 채택·기각 및 최종 판단", lines: [] }];
  const record = conversation => fixture({ status: "completed", result_overview: { flow, synthesis: { parsed: { conversation } } } });
  render(record(flow.map((f, i) => ({ stage: f.title, summary: ["ETHICS-ONLY", "REVIEW-ONLY", "FINAL-ONLY"][i] }))), "results");
  let steps = walk(host).filter(x => x.className === "ds-flow-step");
  assert.ok(steps[2].textContent.includes("FINAL-ONLY"));
  assert.ok(!steps[2].textContent.includes("ETHICS-ONLY"));
  render(record([{ stage: "윤리·손익·실패 검토", summary: "ETHICS-ONLY" }]), "results");
  steps = walk(host).filter(x => x.className === "ds-flow-step");
  assert.ok(!steps[2].textContent.includes("ETHICS-ONLY"), "a partial summary cannot match the shared word 검토");
  render(record([{ stage_id: "revision", stage: "결론", summary: "FINAL-BY-ID" },
    { stage_id: "perspectives", stage: "효용", summary: "ETHICS-BY-ID" },
    { stage_id: "professor", stage: "검증", summary: "REVIEW-BY-ID" }]), "results");
  steps = walk(host).filter(x => x.className === "ds-flow-step");
  assert.ok(steps[2].textContent.includes("FINAL-BY-ID"), "stable stage IDs work even when output is reordered");
});

test("old summaries warn about missing inputs and keep speculative combinations out of current candidate descriptions", () => {
  const record = fixture({ status: "completed", result_overview: {
    candidates: [{ id: "S4A2.C2", number: "2", name: "실제 성과 지표", author: "Claude", summary: "고객 성과 공개", combines: [],
      combination_reason: "C1+C3에 붙일 수 있다" }],
    synthesis: { stale: true, stale_reasons: ["반박 응답 전달을 보완한 요약 방식으로 변경됨"], parsed: {
      conclusion: { headline: "S4A2.C2를 검토한다" }, candidates: [{ id: "S4A2.C2", plain_name: "실제 성과 지표", combines: "OLD-COMBINATION-CLAIM" }] } }
  } });
  const before = JSON.stringify(record); render(record, "results");
  assert.ok(host.textContent.includes("반박 응답 전달을 보완"));
  assert.ok(host.textContent.includes("원문에 명시한 결합 구성요소 없음"));
  const old = walk(host).find(x => x.tagName === "DETAILS" && x.children[0].textContent === "이전 총괄의 결합 설명 · 재확인 필요");
  assert.ok(old && !old.open && old.textContent.includes("OLD-COMBINATION-CLAIM"), "old output is retained as a collapsed, qualified record");
  const headline = walk(host).find(x => x.className === "ds-headline");
  assert.equal(headline.textContent, "실제 성과 지표 (Claude의 후보 2)를 검토한다");
  assert.equal(JSON.stringify(record), before);
});
test("report plan separates one recommendation, execution readiness and SECTION 1–5 without calling an AI", () => {
  const opened = [], generated = [];
  const evidence = { id: "S1A1.CLM1", turn: "S1A1", label: "GPT의 독립 조사 · 교차매출 근거", text: "SAVED-EVIDENCE-SENTINEL", kind: "unverified", source: "case.md:L20", status: "정정 내역과 대조 필요" };
  const plan = { mode: "records", status: "not_generated", decision: { candidate_id: "S4A2.C1", name: "정정과 자금 계획을 병행하는 안", recommendation: "RECOMMEND-ONE-SENTINEL", why: "WHY-ONE-SENTINEL", now: ["NOW-SENTINEL"],
    conditions: [{ condition: "COND-SENTINEL", check: "CHECK-SENTINEL", if_fail: "FALLBACK-SENTINEL" }], alternatives: [{ candidate_id: "S4A2.C2", why_not: "REJECT-SENTINEL" }], evidence_ids: [evidence.id], minority_views: ["MINORITY-SENTINEL"] },
    sections: [1, 2, 3, 4, 5].map(n => ({ number: n, title: "작성 섹션 " + n, steps: n === 1 ? [4] : n === 2 ? [1] : n === 3 ? [2] : n === 4 ? [3, 4] : [5], purpose: "PURPOSE-" + n, points: ["POINT-" + n], evidence: n === 2 ? [evidence] : [], assumptions: n === 3 ? ["ASSUMPTION-SENTINEL"] : [], unknowns: n === 5 ? ["KILL-UNKNOWN-SENTINEL"] : [], appendix_ids: n === 2 ? ["audit"] : [] })),
    appendices: [{ id: "audit", title: "AI 오류·개선 질문 기록", record_ids: [evidence.id] }], issues: ["VERIFY-ISSUE-SENTINEL"] };
  const record = fixture({ domain: "accounting_pbl", status: "completed", agents: [{ name: "GPT" }, { name: "Claude", is_moderator: true }],
    turns: [turn(1, 1, { stage_title: "독립 조사" }), turn(4, 2, { stage: "alternatives", stage_title: "대안 C 설계" })],
    result_overview: { report_plan: plan, positions: [{ candidate_id: "S4A2.C1" }], candidates: [{ id: "S4A2.C1", name: "정정 병행", author: "Claude", number: "1" }, { id: "S4A2.C2", name: "단순 연기", author: "Claude", number: "2" }] } });
  const before = JSON.stringify(record);
  summary.reset(); summary.render(record, { onReportPlan: name => generated.push(name), onOpenTurn: id => opened.push(id) });
  const shortcut = walk(host).find(x => x.tagName === "BUTTON" && x.textContent === "보고서 작성안 보기"); assert.ok(shortcut); shortcut.click();
  assert.equal(host.querySelector("#ds-tab-report").getAttribute("aria-selected"), "true");
  for (const phrase of ["기존 총괄 권고로 구성한 작성 자료", "정정과 자금 계획을 병행하는 안", "총괄이 C안 1개 선택", "실행 조건 확인 필요", "전원 합의를 뜻하지 않음", "RECOMMEND-ONE-SENTINEL", "WHY-ONE-SENTINEL", "NOW-SENTINEL", "COND-SENTINEL", "CHECK-SENTINEL", "FALLBACK-SENTINEL", "REJECT-SENTINEL", "MINORITY-SENTINEL", "STEP 4 → SECTION 1", "STEP 1 → SECTION 2", "STEP 2 → SECTION 3", "STEP 3 · STEP 4 → SECTION 4", "STEP 5 → SECTION 5", "SAVED-EVIDENCE-SENTINEL", "case.md:L20", "정정 내역과 대조 필요", "ASSUMPTION-SENTINEL", "KILL-UNKNOWN-SENTINEL", "AI 오류·개선 질문 기록"]) assert.ok(host.textContent.includes(phrase), phrase);
  const sectionCards = walk(host).filter(x => x.className.split(/\s+/).includes("ds-report-section"));
  assert.equal(sectionCards.length, 5); assert.equal(sectionCards[0].open, true);
  assert.ok(sectionCards.slice(1).every(x => !x.open), "only SECTION 1 starts open, avoiding a wall of report content");
  assert.deepEqual(generated, [], "viewing records never requests synthesis");
  const evidenceCard = walk(host).find(x => x.className === "ds-report-evidence");
  assert.ok(evidenceCard.textContent.includes("GPT의 독립 조사 · 교차매출 근거"));
  assert.ok(!evidenceCard.textContent.includes("S1A1.CLM1"), "the internal ID stays out of the evidence title");
  walk(evidenceCard).find(x => x.tagName === "BUTTON").click(); assert.deepEqual(opened, ["S1A1"]);
  walk(host).find(x => x.tagName === "BUTTON" && x.textContent === "총괄 권고 1개·SECTION 작성안 생성").click();
  assert.deepEqual(generated, ["Claude"], "only an explicit click requests the configured moderator");
  assert.equal(JSON.stringify(record), before, "reading a report never alters debate records");
  summary.reset(); summary.render({ ...record, active: true }, { onReportPlan: name => generated.push(name) }); host.querySelector("#ds-tab-report").click();
  assert.ok(!walk(host).some(x => x.tagName === "BUTTON" && /SECTION 작성안 생성/.test(x.textContent)), "an active run cannot generate another report");
  assert.equal(networkCalls, 0);
});

test("stale generated report plans remain qualified, preserve missing-data notes and safely render malformed fields", () => {
  const plan = { mode: "generated", status: "stale", decision: { candidate_id: "S4A1.C1", name: "STORED-CHOICE", recommendation: "<script>MODEL-TEXT</script>", conditions: [null, { condition: "MISSING-CHECK" }], minority_views: ["DISSENT"] },
    sections: [null, { number: 1, title: "기존 작성안", steps: null, points: ["<img src=x onerror=alert(1)>"], evidence: [null, { id: "UNKNOWN", text: "MALFORMED-EVIDENCE" }] }], appendices: [null, { id: "a", title: "APPENDIX" }], issues: ["STALE-ISSUE"] };
  const record = fixture({ domain: "accounting_pbl", result_overview: { report_plan: plan } });
  assert.doesNotThrow(() => render(record, "report"));
  for (const phrase of ["이전 기록 기준 · 재확인 필요", "기존 작성안을 보존했습니다", "STORED-CHOICE", "DISSENT", "기록 없음 · 보완 필요", "MALFORMED-EVIDENCE", "<script>MODEL-TEXT</script>", "<img src=x onerror=alert(1)>"]) assert.ok(host.textContent.includes(phrase), phrase);
  assert.ok(!walk(host).some(x => ["SCRIPT", "IMG", "IFRAME"].includes(x.tagName)), "model strings are inert content");
  const noChoice = { ...plan, mode: "records", status: "not_generated", decision: {} };
  render(fixture({ result_overview: { report_plan: noChoice } }), "report");
  assert.ok(host.textContent.includes("총괄의 단일 권고 미기록"));
  assert.ok(!host.textContent.includes("총괄이 C안 1개 선택"));
  render(fixture({ domain: "general", result_overview: {} }), "results");
  assert.ok(!host.querySelector("#ds-tab-report"), "records without a report contract retain their existing tabs");
  assert.equal(networkCalls, 0);
});
test("invalid selected candidates are not presented as a completed choice, and excerpts remain distinct from generated points", () => {
  const plan = { mode: "records", status: "needs_review", decision: { candidate_id: "S99A9.C9", selection_valid: false, name: "INVALID-CHOICE", recommendation: "OLD-RECOMMENDATION" },
    sections: [{ number: 1, title: "Memo", points: ["REAL-RECORD-EXCERPT"], evidence: [{ id: "S1A1.CLM1", label: "GPT의 첫 주장", status: "수정 전 주장 · 감사 이력", text: "ORIGINAL-RECORD" }] }] };
  render(fixture({ result_overview: { report_plan: plan } }), "report");
  assert.ok(host.textContent.includes("권고 후보 연결 재확인 필요"));
  assert.ok(host.textContent.includes("작성안 검토 필요"));
  assert.ok(host.textContent.includes("기존 권고 문장 · 후보 연결 재확인 필요"));
  assert.ok(host.textContent.includes("OLD-RECOMMENDATION"), "the earlier narrative is retained, with qualification");
  assert.ok(!host.textContent.includes("총괄이 C안 1개 선택"));
  assert.ok(!host.textContent.includes("총괄 작성안 생성됨"));
  assert.ok(host.textContent.includes("저장 기록의 핵심 발췌"));
  assert.ok(!host.textContent.includes("작성할 핵심 요점"));
  assert.ok(host.textContent.includes("수정 전 주장 · 감사 이력"));
  render(fixture({ result_overview: { report_plan: { ...plan, mode: "generated" } } }), "report");
  assert.ok(host.textContent.includes("작성할 핵심 요점"));
  assert.ok(!host.textContent.includes("저장 기록의 핵심 발췌"));
  assert.equal(networkCalls, 0);
});
test("shared condition-failure guidance appears once and absent immediate sequencing never erases the recommendation", () => {
  const decision = { candidate_id: "S4A1.C1", name: "C안", recommendation: "RECORDED-ACTION", now: [], if_conditions_fail: "SHARED-FALLBACK-SENTINEL",
    conditions: [1, 2, 3, 4, 5].map(n => ({ condition: "CHECK-CONDITION-" + n, check: "CHECK-METHOD-" + n, if_fail: "" })) };
  const record = value => fixture({ result_overview: { report_plan: { mode: "records", status: "not_generated", decision: value, sections: [] } } });
  render(record(decision), "report");
  assert.equal(host.textContent.split("SHARED-FALLBACK-SENTINEL").length - 1, 1, "shared fallback is not repeated in each table row");
  assert.ok(host.textContent.includes("즉시 실행 순서는 별도로 정리되지 않았습니다. 위 권고 행동과 아래 확인 조건을 참고하세요."));
  assert.ok(!host.textContent.includes("지금 할 일이 기록되지 않았습니다"));
  let table = walk(host).find(x => x.className === "ds-data-table ds-report-conditions");
  assert.equal(walk(table).filter(x => x.tagName === "TH").length, 2, "a shared response does not create five empty row-response cells");
  assert.ok(!table.textContent.includes("SHARED-FALLBACK-SENTINEL"));
  render(record({ ...decision, conditions: [{ ...decision.conditions[0], if_fail: "ROW-ONLY-RESPONSE" }, decision.conditions[1]] }), "report");
  table = walk(host).find(x => x.className === "ds-data-table ds-report-conditions");
  assert.equal(walk(table).filter(x => x.tagName === "TH").length, 3);
  assert.ok(table.textContent.includes("ROW-ONLY-RESPONSE"));
  assert.equal(host.textContent.split("SHARED-FALLBACK-SENTINEL").length - 1, 1);
  assert.equal(networkCalls, 0);
});
assert.equal(networkCalls,0);
process.stdout.write(`Offline summary contract: ${passed} tests passed; AI and HTTP calls: 0.\n`);
