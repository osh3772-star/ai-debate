"use strict";

// Loading this page, polling status and editing settings never invoke a model.
// Only the deliberate Start / Resume handlers below call execution endpoints.
const state = { csrf: "", providers: {}, materials: [], runs: [], selectedRun: "", currentRun: null, reports: [], polling: false, speechSignature: "", reportSignature: "", busy: false, initialized: false };
Object.assign(state, { view: "workspace", summaryCache: new Map(), summaryFetch: new Map(), activeRunId: "" });
const $ = id => document.getElementById(id);
const statusLabels = { idle: "대기", created: "준비", running: "진행 중", starting: "시작 중", pausing: "정지 대기", pause_requested: "정지 대기", paused: "일시정지", stopped: "중단", stopped_by_user: "사용자 중단", stop_requested: "중단 요청", stopping: "중단 중", interrupted: "중단됨", completed: "완료", complete: "완료", failed: "실패", error: "오류", ready: "준비", pending: "대기" };
const reportInfo = {
  "research_dossier.md": ["연구 자료집", "사례·강의 이론·근거와 단계별 분석"],
  "alternatives_c.md": ["대안 C", "후보 비교, 결합 및 선정·수정 이유"],
  "evidence_register.md": ["근거 대장", "주장별 출처와 확인 상태"],
  "ai_audit.md": ["AI 오류 검토", "실제 오류 후보와 프롬프트 개선 기록"],
  "debate_log.md": ["전체 토론 원문", "발언별 실제 전달 근거, 원질문·원답변과 연구 진행 기록"],
  "report_outline.md": ["4페이지 보고서 목차", "직접 작성하기 위한 결론 우선 구성, 주석 후보·과제 요건 기록 대장과 부록 구성"],
  "report_writing_plan.md": ["SECTION 1~5 보고서 작성안", "기존 총괄 권고와 SECTION별 작성 재료·근거·미확인 사항"],
  "professor_review.md": ["최종 검토 기록", "평가 기준·반례·사실 확인, 원안 유지 근거, 지적의 채택·기각 및 남은 한계"],
  "summary.md": ["결론·쟁점", "잠정 결론, 핵심 반박, 입장 변경과 미해결 쟁점"],
  "ai_usage_appendix.md": ["AI 활용 부록", "첫 생각과 맹점, 실수·개선 질문, 학습 기록 작성란과 AI 활용 내역"],
  "debate.json": ["원본 JSON", "실행 상태와 원본 응답 기록"],
  "events.jsonl": ["이벤트 로그", "중단·재개를 포함한 실행 이벤트"]
};

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = String(text);
  return node;
}

async function api(path, body) {
  const options = { method: body === undefined ? "GET" : "POST", cache: "no-store", credentials: "same-origin", headers: { Accept: "application/json" } };
  if (body !== undefined) {
    options.headers["Content-Type"] = "application/json";
    options.headers["X-CSRF-Token"] = state.csrf;
    options.body = JSON.stringify(body);
  }
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch (_) { throw new Error("서버의 응답을 읽을 수 없습니다. 로컬 서버가 실행 중인지 확인하세요."); }
  if (!response.ok || data.error) throw new Error(data.error || `요청을 처리하지 못했습니다 (${response.status}).`);
  return data;
}

let toastTimer;
function notify(message, error = false) {
  $("toast").textContent = message;
  $("toast").className = `toast${error ? " error" : ""}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $("toast").classList.add("hidden"), error ? 9000 : 4500);
}

function providerLabel(provider) { return state.providers[provider]?.label || ({ codex: "GPT · Codex", claude: "Claude Code", google: "Google · Antigravity", codebuddy: "DeepSeek · CodeBuddy" }[provider] || provider); }
// Older running local servers expose aliases only. Enrich the displayed catalog
// without restarting that server or disturbing a running/saved research session.
// IDs verified against official Claude model docs, 2026-10-19.
function normalizeModelCatalog(catalog) {
  if (catalog.claude) {
    const standard = [
      { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
      { id: "claude-opus-5-5", label: "Opus 5.5" },
      { id: "claude-fable-5-1", label: "Fable 5.1" },
      { id: "claude-haiku-5-5", label: "Haiku 5.5" },
      { id: "sonnet", label: "Sonnet" },
      { id: "opus", label: "Opus" },
      { id: "haiku", label: "Haiku" }
    ];
    const merged = new Map(standard.map(model => [model.id, model]));
    for (const model of catalog.claude.models || []) {
      const item = typeof model === "string" ? { id: model, label: model } : model;
      if (!merged.has(item.id)) merged.set(item.id, item);
    }
    catalog.claude.models = Array.from(merged.values());
    catalog.claude.default_model = "claude-sonnet-5-5";
  }
  if (catalog.google) {
    catalog.google.default_model = 'gemini-4-argon';
  }
  return catalog;
}
function providerInitial(provider) { return ({ codex: "G", claude: "C", google: "G", codebuddy: "D" }[provider] || "A"); }
function fieldLabel(forId, text) { const label = el("label", "", text); label.htmlFor = forId; return label; }

function cleanProviderName(prov) {
  return ({ codex: "GPT", claude: "Claude", google: "Gemini", codebuddy: "DeepSeek" }[prov] || "AI");
}
function defaultAgentName(prov, idx) {
  const base = cleanProviderName(prov);
  const existing = Array.from($("agents").children).map(c => c.querySelector(".agent-name")?.value.trim());
  if (!existing.includes(base)) return base;
  return `${base} ${idx}`;
}

function deriveAgentName(prov, modelId, modelLabel, cardElem) {
  const base = cleanProviderName(prov);
  let modelSuffix = "";

  if (modelId && modelId !== "__custom__") {
    const lowerId = String(modelId).toLowerCase();
    const rawLabel = String(modelLabel || "").trim();

    if (lowerId.includes("sol")) {
      modelSuffix = "SOL";
    } else if (rawLabel && !rawLabel.includes("기본 모델") && !rawLabel.includes("직접 입력")) {
      let clean = rawLabel.replace(new RegExp(`^${base}\\s*`, "i"), "").trim();
      clean = clean.replace(/^(Claude|GPT|Gemini|DeepSeek)[- ]*/i, "").trim();
      modelSuffix = clean;
    }
  }

  let fullName = modelSuffix ? `${base} ${modelSuffix}` : base;

  const otherNames = Array.from($("agents").children)
    .filter(c => c !== cardElem)
    .map(c => c.querySelector(".agent-name")?.value.trim())
    .filter(Boolean);

  if (!otherNames.includes(fullName)) {
    return fullName;
  }

  let num = 2;
  while (otherNames.includes(`${fullName} ${num}`)) {
    num++;
  }
  return `${fullName} ${num}`;
}

let agentSerial = 0;
function addAgent(agent = {}) {
  if ($("agents").children.length >= 5) return;
  const serial = ++agentSerial;
  const id = `agent-${serial}`;

  // 현재 등록된 에이전트들의 공급자 빈도를 분석하여 가장 적게 쓰인 공급자(또는 순환 순서)를 다음 공급자로 똑똑하게 제안
  const existingProviders = Array.from($("agents").children).map(c => c.querySelector(".provider-select")?.value).filter(Boolean);
  const provKeys = Object.keys(state.providers).length ? Object.keys(state.providers) : (state.providers.codebuddy ? ["codex", "claude", "google", "codebuddy"] : ["codex", "claude", "google"]);
  const provCounts = {};
  provKeys.forEach(k => { provCounts[k] = 0; });
  existingProviders.forEach(k => { if (provCounts[k] !== undefined) provCounts[k]++; });
  const sortedProv = [...provKeys].sort((a, b) => provCounts[a] - provCounts[b]);
  const defaultSuggested = sortedProv[0] || "claude";
  const provider = agent.provider || defaultSuggested;

  const card = el("article", "agent-card");
  card.dataset.id = id;
  const header = el("div", "agent-card-header");
  const avatar = el("span", `agent-avatar ${provider}`, providerInitial(provider));
  avatar.setAttribute("aria-hidden", "true");

  const cardIndex = $("agents").children.length + 1;
  const name = el("input", "agent-name");
  name.type = "text";
  name.value = agent.name || defaultAgentName(provider, cardIndex);
  name.maxLength = 80;
  name.setAttribute("aria-label", "참가자 이름");
  let userEditedName = Boolean(agent.name);
  name.addEventListener("input", () => {
    userEditedName = Boolean(name.value.trim());
  });

  // 카드 헤더 오른쪽의 공급자 라벨을 클릭 가능한 select 드롭다운으로 개선하여 바로 변경 가능하게 함
  const kind = el("select", "agent-kind");
  kind.setAttribute("aria-label", "공급자 변경");
  kind.title = "공급자 변경 (클릭하여 다른 AI 공급자로 변경)";
  provKeys.forEach(key => {
    const option = el("option", "", providerLabel(key));
    option.value = key;
    kind.append(option);
  });
  kind.value = provider;

  // 총괄 관리자 원클릭 체크박스
  const modWrap = el("label", "moderator-label");
  const modCheckbox = el("input", "moderator-checkbox");
  modCheckbox.type = "checkbox";
  modCheckbox.checked = Boolean(agent.is_moderator);
  modCheckbox.setAttribute("aria-label", "총괄 관리자 지정");
  modWrap.append(modCheckbox, el("span", "", "👑 총괄"));
  modWrap.title = "현재 단계의 쟁점·근거 누락·미응답을 정리합니다. 후보 비교는 후반에 수행하며 다른 참가자를 대신해 합의를 선언하지 않습니다.";

  if (modCheckbox.checked) {
    card.classList.add("is-moderator");
  }

  modCheckbox.addEventListener("change", () => {
    if (modCheckbox.checked) {
      $("agents").querySelectorAll(".agent-card").forEach(c => {
        if (c !== card) {
          const cb = c.querySelector(".moderator-checkbox");
          if (cb) cb.checked = false;
          c.classList.remove("is-moderator");
        }
      });
      card.classList.add("is-moderator");
      notify(`[${name.value || "참가자"}]이(가) 총괄 관리자로 지정되었습니다. 종합·조정 프롬프트가 자동 적용됩니다.`);
    } else {
      card.classList.remove("is-moderator");
    }
  });

  const remove = el("button", "remove-agent", "×");
  remove.type = "button";
  remove.title = "참가자 삭제";
  remove.setAttribute("aria-label", "참가자 삭제");
  remove.addEventListener("click", () => {
    if ($("agents").children.length > 2) {
      card.remove();
      updateCounts();
    } else {
      notify("참가자는 최소 2명이어야 합니다.", true);
    }
  });

  // 참여/제외 토글 체크박스 (원하는 AI만 체크)
  const enableWrap = el("label", "agent-enable-label");
  const enableCheckbox = el("input", "agent-enable-checkbox");
  enableCheckbox.type = "checkbox";
  enableCheckbox.checked = agent.enabled !== false;
  enableWrap.append(enableCheckbox);
  enableWrap.title = "이 AI를 토론에 참여시킬지 선택합니다 (체크 해제 시 제외)";

  if (!enableCheckbox.checked) {
    card.classList.add("is-disabled");
  }

  enableCheckbox.addEventListener("change", () => {
    if (enableCheckbox.checked) {
      card.classList.remove("is-disabled");
    } else {
      const activeCount = Array.from($("agents").children).filter(c => !c.classList.contains("is-disabled") && c.querySelector(".agent-enable-checkbox")?.checked !== false).length;
      if (activeCount < 2) {
        enableCheckbox.checked = true;
        notify("토론에는 최소 2명 이상의 AI가 참여해야 합니다.", true);
        return;
      }
      card.classList.add("is-disabled");
    }
    updateCounts();
  });

  header.append(enableWrap, avatar, name, modWrap, kind, remove);

  const fields = el("div", "agent-fields");
  const row = el("div", "agent-model-row");
  const providerField = el("div", "field");
  const providerSelect = el("select", "provider-select");
  providerSelect.id = `${id}-provider`;
  provKeys.forEach(key => { const option = el("option", "", providerLabel(key)); option.value = key; providerSelect.append(option); });
  if (!providerSelect.children.length) ["codex", "claude", "google"].forEach(key => { const option = el("option", "", providerLabel(key)); option.value = key; providerSelect.append(option); });
  providerSelect.value = provider;
  providerField.append(fieldLabel(providerSelect.id, "공급자"), providerSelect);

  const modelField = el("div", "field model-field");
  const modelSelect = el("select", "model-select"); modelSelect.id = `${id}-model-select`;
  // Keep the canonical ID separate from the displayed label and custom editor.
  // Saved configurations and collectAgents() continue to use .model-input.
  const modelInput = el("input", "model-input"); modelInput.type = "hidden"; modelInput.id = `${id}-model`; modelInput.value = agent.model || state.providers[provider]?.default_model || "";
  const customModel = el("input", "model-custom-input hidden"); customModel.type = "text"; customModel.id = `${id}-model-custom`; customModel.maxLength = 160; customModel.placeholder = "정확한 모델 ID 입력"; customModel.setAttribute("aria-label", "직접 입력 모델 ID");
  const modelHelp = el("p", "agent-model-help"); modelHelp.id = `${id}-model-help`;
  modelSelect.setAttribute("aria-describedby", modelHelp.id); customModel.setAttribute("aria-describedby", modelHelp.id);
  modelField.append(fieldLabel(modelSelect.id, "모델"), modelSelect, modelInput, customModel, modelHelp);
  const effortField = el("div", "field");
  const effortSelect = el("select", "effort-select"); effortSelect.id = `${id}-effort`;
  effortField.append(fieldLabel(effortSelect.id, "추론 강도"), effortSelect);
  row.append(providerField, modelField, effortField);
  const effortNote = el("p", "agent-effort-note");
  const instructionInput = el("textarea", "agent-instructions"); instructionInput.id = `${id}-instructions`; instructionInput.rows = 2; instructionInput.maxLength = 16000; instructionInput.placeholder = "예: 재무 책임자의 관점에서 수치 가정과 실행 가능성을 집중 검토하세요."; instructionInput.value = agent.instructions || "";
  const instructionLabel = fieldLabel(instructionInput.id, "개별 역할 · 명령"); instructionLabel.className = "agent-instructions-label";
  fields.append(row, effortNote, instructionLabel, instructionInput);
  card.append(header, fields);
  function updateModelDisplay() {
    const custom = modelSelect.value === "__custom__";
    customModel.classList.toggle("hidden", !custom);
    const modelId = modelInput.value.trim();
    modelHelp.textContent = modelId ? `ID: ${modelId}` : custom ? "CLI에 표시되는 정확한 모델 ID를 입력하세요." : "CLI 기본 모델 사용";
    const selectedLabel = modelSelect.selectedOptions[0]?.textContent || "모델";
    modelSelect.title = modelId ? `${selectedLabel}\n모델 ID: ${modelId}` : selectedLabel;
    customModel.title = modelId || "정확한 모델 ID 입력";
  }
  modelSelect.addEventListener("change", () => {
    modelInput.value = modelSelect.value === "__custom__" ? customModel.value : modelSelect.value;
    updateModelDisplay();
    if (!userEditedName) {
      const selectedOption = modelSelect.selectedOptions[0];
      name.value = deriveAgentName(providerSelect.value, modelInput.value, selectedOption?.textContent, card);
    }
    if (modelSelect.value === "__custom__") customModel.focus();
  });
  customModel.addEventListener("input", () => { modelInput.value = customModel.value; updateModelDisplay(); });
  function updateProvider(preserveEffort = false) {
    const value = providerSelect.value;
    kind.value = value;
    avatar.className = `agent-avatar ${value}`;
    avatar.textContent = providerInitial(value);
    modelSelect.replaceChildren();
    if (value !== "codebuddy") { const defaultModel = el("option", "", "CLI 기본 모델"); defaultModel.value = ""; modelSelect.append(defaultModel); }
    (state.providers[value]?.models || []).forEach(item => { const model = typeof item === "string" ? { id: item, label: item } : item; const option = el("option", "", model.label || model.id); option.value = model.id; option.title = model.id; modelSelect.append(option); });
    const customOption = el("option", "", "직접 입력…"); customOption.value = "__custom__";
    if (value !== "codebuddy") modelSelect.append(customOption);
    const modelId = modelInput.value;
    const knownModel = Array.from(modelSelect.options).some(option => option.value === modelId && option !== customOption);
    modelSelect.value = knownModel ? modelId : value === "codebuddy" ? state.providers[value]?.default_model || "" : "__custom__";
    if (value === "codebuddy") modelInput.value = modelSelect.value;
    customModel.value = knownModel ? "" : modelId;
    updateModelDisplay();
    if (!userEditedName) {
      const selectedOption = modelSelect.selectedOptions[0];
      name.value = deriveAgentName(value, modelInput.value, selectedOption?.textContent, card);
    }
    const currentEffort = preserveEffort ? (agent.effort || (value === "google" ? "high" : "")) : (value === "google" ? "high" : "");
    effortSelect.replaceChildren();
    let efforts = state.providers[value]?.efforts || ["low", "medium", "high", "xhigh"];
    if (!Array.isArray(efforts)) efforts = Object.keys(efforts);
    const defaultOption = el("option", "", "CLI 기본값"); defaultOption.value = ""; effortSelect.append(defaultOption);
    efforts.forEach(effort => { const item = typeof effort === "string" ? { id: effort, label: effort } : effort; if (!item.id || item.id === "default") return; const option = el("option", "", item.label || item.id); option.value = item.id; effortSelect.append(option); });
    if (currentEffort && !Array.from(effortSelect.options).some(option => option.value === currentEffort)) { const option = el("option", "", currentEffort); option.value = currentEffort; effortSelect.append(option); }
    effortSelect.value = currentEffort;
    effortSelect.disabled = false;
    effortNote.textContent = value === "codebuddy" ? "CodeBuddy DeepSeek 추론 강도는 Minimal, Low, Medium, High, XHigh, Max를 지원합니다." : value === "google" ? "Gemini 추론 강도는 High, Medium, Low 3단계로 조절할 수 있습니다." : value === "claude" ? "Claude Code 공식 추론 강도는 Low, Medium, High, XHigh, Max를 지원합니다." : "CLI 기본 모델·기본 추론은 해당 CLI의 기본 설정을 사용합니다.";
  }
  // 헤더 드롭다운과 본문 공급자 드롭다운 양방향 동기화
  kind.addEventListener("change", () => {
    if (providerSelect.value !== kind.value) {
      providerSelect.value = kind.value;
      modelInput.value = state.providers[kind.value]?.default_model || "";
      updateProvider();
    }
  });
  providerSelect.addEventListener("change", () => {
    kind.value = providerSelect.value;
    modelInput.value = state.providers[providerSelect.value]?.default_model || "";
    updateProvider();
  });
  updateProvider(true);
  $("agents").append(card);
  updateCounts();
}

function collectAgents() {
  return Array.from($("agents").children)
    .filter(card => !card.classList.contains("is-disabled") && card.querySelector(".agent-enable-checkbox")?.checked !== false)
    .map(card => ({
      name: card.querySelector(".agent-name").value.trim(),
      provider: card.querySelector(".provider-select").value,
      model: card.querySelector(".model-input").value.trim(),
      effort: card.querySelector(".effort-select").value,
      instructions: card.querySelector(".agent-instructions").value.trim(),
      is_moderator: Boolean(card.querySelector(".moderator-checkbox")?.checked)
    }));
}
function selectedMaterials() { return Array.from($("materials").querySelectorAll("input:checked")).map(input => input.value); }
function modeLabel(mode, rounds = null) {
  const r = rounds ?? (Number($("smoke-rounds")?.value) || 2);
  return ({ research: "연구 · 7절차", consensus: "합의·검증 · 6절차", smoke: `${r}라운드 자유 토론` }[mode] || mode);
}
function updateCounts() {
  const allCards = Array.from($("agents").children);
  const totalCount = allCards.length;
  const activeCards = allCards.filter(card => !card.classList.contains("is-disabled") && card.querySelector(".agent-enable-checkbox")?.checked !== false);
  const activeCount = activeCards.length;

  $("agent-count").textContent = `${activeCount}명 선택`;

  $("add-agent").disabled = totalCount >= 5;
  $("agents").querySelectorAll(".remove-agent").forEach(button => { button.disabled = totalCount <= 2; });
  const materialCount = selectedMaterials().length;
  $("material-count").textContent = `${materialCount}개 선택`;
  const mode = $("mode").value;
  const isSmoke = mode === "smoke";
  const smokeRoundsField = $("smoke-rounds-field");
  if (smokeRoundsField) smokeRoundsField.classList.toggle("hidden", !isSmoke);
  const smokeRounds = Math.max(1, Math.min(20, Number($("smoke-rounds")?.value) || 2));

  $("launch-summary").textContent = isSmoke
    ? `${activeCount}명 · 자료 ${materialCount}개 · ${modeLabel(mode, smokeRounds)} (${activeCount * smokeRounds}발언)`
    : `${activeCount}명 · 자료 ${materialCount}개 · ${modeLabel(mode)} (${activeCount * (mode === "research" ? 7 : 6)}발언)`;

  const finalReview = $("domain").value === "accounting_pbl" ? "최종 적대적 검토(반례·사실 확인)" : "평가 기준 기반 최종 검토";
  $("mode-help").textContent = mode === "research"
    ? `독립 조사 → 교차 검증 → 반론 응답 → 후보 비교 → 관점·실패 검토 → ${finalReview} → 최종 판단. ${activeCount}명 기준 ${activeCount * 7}회 발언. 중대한 결함이 없으면 원안을 유지하고, 비판도 근거에 따라 채택·기각합니다.`
    : mode === "consensus"
    ? `독립 분석 → 교차 반박 → 재반론 → 후보 비교 → ${finalReview} → 최종 판단. ${activeCount}명 기준 ${activeCount * 6}회 발언. 원안 유지·근거 있는 수정과 참가자별 이견을 보존합니다.`
    : smokeRounds === 1
    ? "1라운드 독립 의견 제시. 실제 구독 한도를 사용합니다."
    : `${smokeRounds}라운드 총 ${activeCount * smokeRounds}발언 · 독립 의견 → 상호 검토${smokeRounds >= 3 ? " → 판단 정리" : " · 최종 연구·합의 전"}. 실제 구독 한도를 사용합니다.`;
}

function humanBytes(value) { return Number(value) >= 1024 ? `${(Number(value) / 1024).toFixed(1)} KB` : `${Number(value) || 0} B`; }
function renderMaterials(selected) {
  const choices = selected ? new Set(selected) : new Set(state.materials.filter(item => item.selected).map(item => item.id));
  $("materials").replaceChildren();
  if (!state.materials.length) $("materials").append(el("p", "empty-message", "등록된 자료가 없습니다. 파일 추가로 자료를 등록하세요."));
  state.materials.forEach((item, index) => {
    const row = el("div", "material-row");
    const label = el("label"); const checkbox = el("input"); checkbox.type = "checkbox"; checkbox.value = item.id; checkbox.checked = choices.has(item.id); checkbox.addEventListener("change", updateCounts);
    const name = el("span", "material-name", item.name); label.append(checkbox, name);
    const size = el("span", "material-size", humanBytes(item.bytes));
    const actions = el("div", "material-actions");
    const preview = el("button", "material-preview-button", "미리보기"); preview.type = "button"; preview.setAttribute("aria-label", `${item.name} 미리보기`);
    preview.addEventListener("click", () => previewMaterial(item.id));
    actions.append(preview);
    if (!item.protected) {
      const delBtn = el("button", "material-delete-button", "삭제 🗑");
      delBtn.type = "button";
      delBtn.title = "이 자료 파일 삭제";
      delBtn.setAttribute("aria-label", `${item.name} 삭제`);
      delBtn.addEventListener("click", () => deleteMaterial(item.id, item.name));
      actions.append(delBtn);
    }
    row.append(label, size, actions); $("materials").append(row);
  });
  updateCounts();
}
async function deleteMaterial(id, name) {
  if (!confirm(`'${name}' 자료 파일을 정말 삭제하시겠습니까?`)) return;
  try {
    const data = await api("/api/delete_material", { id });
    state.materials = data.materials || [];
    renderMaterials();
    notify(`'${name}' 자료를 삭제했습니다.`);
  } catch (error) { notify(error.message, true); }
}
async function cleanupJunkMaterials() {
  if (!confirm("테스트 및 프롬프트 생성으로 생긴 정크 txt 파일들을 일괄 정리하시겠습니까?\n(기본 강의 및 과제 자료는 안전하게 보호됩니다)")) return;
  try {
    const data = await api("/api/cleanup_junk");
    state.materials = data.materials || [];
    renderMaterials();
    notify(`${data.deleted_count || 0}개의 정크 파일을 정리했습니다.`);
  } catch (error) { notify(error.message, true); }
}
async function previewMaterial(id) {
  try { const data = await api(`/api/material?id=${encodeURIComponent(id)}`); $("material-dialog-title").textContent = data.name || "자료 미리보기"; $("material-preview").textContent = data.content || "(빈 파일)"; $("material-dialog").showModal(); } catch (error) { notify(error.message, true); }
}

function getSubmittedCases() {
  return [1, 2, 3].map(i => ({...Object.fromEntries(["question", "answer", "source", "suspicion"].map(k => [k, String($(`case-${i}-${k}`)?.value || "").trim()])),
    items: ["교차매출", "Repo", "R&D 자본화", "빅배스"].filter((_,j) => $(`case-${i}-item-${j}`)?.checked)})).filter(c => c.answer || c.question || c.source || c.suspicion || c.items.length);
}
function submittedInputBytes(cases) {
  return cases.reduce((sum,c) => sum + ["question", "answer", "source", "suspicion"].reduce((n,k) => n + new TextEncoder().encode(c[k] || "").length,0),0);
}
function updateSubmittedBudget() {
  const used = submittedInputBytes(getSubmittedCases()), limit = state.submittedInputMaxBytes || 18000;
  if ($("submitted-input-budget")) $("submitted-input-budget").textContent = `의심 답변 전체 입력: ${used.toLocaleString()} / ${limit.toLocaleString()}바이트${used > limit ? " · 한도 초과: 입력을 줄여야 저장·시작할 수 있습니다." : ""}`;
}
function getConfig() {
  const timeout = Number($("timeout").value);
  const maxTurnsText = $("max-turns").value.trim();
  const smokeRounds = Math.max(1, Math.min(20, Number($("smoke-rounds")?.value) || 2));
  return { topic: $("topic").value.trim(), instructions: $("instructions").value.trim(), student_draft: String($("student-draft").value || "").trim(), submitted_cases: getSubmittedCases(), mode: $("mode").value, domain: $("domain").value, smoke_rounds: smokeRounds, agents: collectAgents(), materials: selectedMaterials(), timeout, max_turns: maxTurnsText ? Number(maxTurnsText) : null, web_research: $("web-research").checked };
}
function applyConfig(config) {
  [1, 2, 3].forEach(i => ["question", "answer", "source", "suspicion"].forEach(k => { if ($(`case-${i}-${k}`)) $(`case-${i}-${k}`).value = config.submitted_cases?.[i - 1]?.[k] || ""; }));
  [1, 2, 3].forEach(i => ["교차매출", "Repo", "R&D 자본화", "빅배스"].forEach((name,j) => { if ($(`case-${i}-item-${j}`)) $(`case-${i}-item-${j}`).checked = !!config.submitted_cases?.[i - 1]?.items?.includes(name); }));
  updateSubmittedBudget();
  if ($("submitted-case-panel")) $("submitted-case-panel").open = !!config.submitted_cases?.length;
  $("web-research").checked = config.web_research !== false;
  $("topic").value = config.topic || ""; $("instructions").value = config.instructions || ""; $("student-draft").value = config.student_draft || ""; $("mode").value = config.mode || "research"; $("timeout").value = config.timeout || 600; $("max-turns").value = config.max_turns || "";
  $("domain").value = config.domain || (config.mode && config.mode !== "research" ? "general" : "accounting_pbl");
  if ($("smoke-rounds")) $("smoke-rounds").value = config.smoke_rounds || 2;
  $("agents").replaceChildren();
  const agents = config.agents?.length ? config.agents : [{ provider: "codex", name: "GPT" }, { provider: "claude", name: "Claude" }];
  agents.slice(0, 5).forEach(addAgent);
  while ($("agents").children.length < 2) addAgent();
  renderMaterials(config.materials);
  $("transfer-consent").checked = false;
  updateCounts();
}
function validateConfig(config) {
  if (!config.topic) throw new Error("토론 주제를 입력하세요.");
  if (config.agents.length < 2 || config.agents.length > 5) throw new Error("토론에 참여할 AI를 최소 2명 이상 (최대 5명) 선택하세요.");
  if (config.agents.some(agent => !agent.name)) throw new Error("모든 참가자의 이름을 입력하세요.");
  if (String(config.student_draft || "").length > 3000) throw new Error("내 첫 생각은 3000자 이하로 입력하세요.");
  const cases = config.submitted_cases || [];
  if (cases.length > 3) throw new Error("의심 답변은 최대 3개입니다.");
  if (cases.some(c => !c.answer?.trim())) throw new Error("의심 답변의 원문을 입력하세요.");
  if (submittedInputBytes(cases) > (state.submittedInputMaxBytes || 18000)) throw new Error("의심 답변의 원질문·원답변·출처·의심 이유 전체 입력이 18,000바이트를 넘었습니다. 조건과 문맥을 유지하면서 검증 범위를 좁혀 주세요.");
  if (cases.some(c => Object.entries({question:1500,answer:4000,source:300,suspicion:1000}).some(([k, n]) => String(c[k] || "").length > n))) throw new Error("의심 답변 입력란의 글자 수 한도를 확인하세요.");
  if (cases.length && config.mode === "smoke") throw new Error("의심 답변 검증은 연구 또는 합의 모드에서 사용하세요.");
  if (new Set(config.agents.map(agent => agent.name)).size !== config.agents.length) throw new Error("참가자 이름은 서로 다르게 지정하세요.");
  if (config.agents.some(agent => agent.provider === "codebuddy" && agent.model !== "deepseek-v4.1-flash")) throw new Error("DeepSeek 참가자는 확인된 모델 ID deepseek-v4.1-flash를 선택하세요.");
  if (!Number.isInteger(config.timeout) || config.timeout < 30 || config.timeout > 3600) throw new Error("발언 제한 시간은 30~3600초 사이 정수로 입력하세요.");
  if (config.max_turns !== null && (!Number.isInteger(config.max_turns) || config.max_turns < 1 || config.max_turns > 200)) throw new Error("이번 실행 발언 수는 1~200 사이 정수로 입력하세요.");
  if (config.mode === "smoke") {
    if (!Number.isInteger(config.smoke_rounds) || config.smoke_rounds < 1 || config.smoke_rounds > 20) throw new Error("토론 라운드 수는 1~20 사이 정수로 입력하세요.");
  }
}

async function startRun() {
  if (state.busy) return;
  try {
    const config = getConfig(); validateConfig(config);
    if (!(state.protocolVersionSupported >= 3)) throw new Error("새 연구 절차를 적용하려면 서버를 종료하고 다시 실행한 뒤 페이지를 새로고침하세요. 기존 실행의 조회·재개는 저장된 절차를 따릅니다.");
    if (!(state.reviewPolicyVersionSupported >= 1)) throw new Error("최종 검토 기준을 적용하려면 서버를 종료하고 다시 실행한 뒤 페이지를 새로고침하세요. 저장된 실행은 당시 검토 기준을 유지합니다.");
    if (!(state.courseGuidanceSupported >= 3)) throw new Error("과제 지침 반영 절차(필수 원문 묶음·과제 요건 대장·최초 합법성 질의·반례 기록·역할별 공유 기록)를 적용하려면 서버를 종료하고 다시 실행한 뒤 페이지를 새로고침하세요.");
    if (config.web_research && !state.webResearchSupported) throw new Error("웹 검증을 적용하려면 제어실 서버를 종료하고 다시 실행한 뒤 새로고침하세요.");
    if (config.submitted_cases.length && (!state.submittedAuditSupported || state.submittedAuditVersion < 2)) throw new Error("의심 답변의 용량 검사·중복 질의 축소를 적용하려면 서버를 재시작하고 새로고침하세요.");
    if (!$("transfer-consent").checked) throw new Error("시작하려면 자료·명령의 클라우드 전송 동의에 체크하세요.");
    const modeDesc = config.mode === "smoke" ? modeLabel(config.mode, config.smoke_rounds) : modeLabel(config.mode);
    // The size of future answers is unknown; state the review scope and the pause rule instead of a byte estimate.
    const mapped = new Set(config.submitted_cases.filter(c => (c.question || "").trim()).flatMap(c => c.items || []));
    const initialQueries = 4 - mapped.size;
    const n = config.agents.length, scope = config.domain === "accounting_pbl" && config.mode !== "smoke" ? `\n교차 검토 범위: 최대 ${n * (n - 1) * (8 + initialQueries + config.submitted_cases.length)}건(참가자당 주장 8개·최초 판단 ${initialQueries}개·의심 답변 ${config.submitted_cases.length}개 기준) · 단계마다 각 AI에게 역할에 필요한 기록만 보내며, 답하거나 검토해야 할 기록이 한도를 넘으면 그 발언 전에 일시정지하고 받은 응답은 보존합니다.` : "";
    if (!window.confirm(`${n}명의 AI로 연구를 시작할까요?\n\n주제: ${config.topic}\n선택 자료: ${config.materials.length}개\n진행 방식: ${modeDesc}\n웹 검증: ${config.web_research ? "필요 시 공개 검색·원문 열람 (검색어·URL 외부 전송)" : "끄기"}\n내 첫 생각: ${config.student_draft ? "있음 · 교차 검증 단계에서만 AI에게 공개" : "없음"}\n의심 답변: ${config.submitted_cases.length}개 · 원문은 독립 조사부터, 의심 이유는 교차 검증부터 공개${scope}\n\n주제, 명령, 의심 답변, 선택한 자료와 참가자 발언을 클라우드 AI로 전송하며 구독 한도를 사용합니다.`)) return;
    setBusy(true);
    const data = await api("/api/start", { ...config, approve_transfer: true });
    $("transfer-consent").checked = false;
    await refreshRuns(data.run);
    await selectRun(data.run);
    notify("연구를 시작했습니다. 실행 모니터에서 진행 상황을 확인하세요.");
  } catch (error) { notify(error.message, true); } finally { setBusy(false); }
}
function setBusy(value) { state.busy = value; updateRunButtons(); }

async function resetResearch() {
  if (!state.initialized || state.busy || state.currentRun?.active || state.activeRunId) return;
  $("transfer-consent").checked = false;
  $("summary-load-status").textContent = "읽기 전용 · 추가 AI 호출 없음";
  await selectRun("");
  notify("조회 화면을 초기화했습니다. 설정·자료와 저장 기록은 유지했습니다. 이전 결과는 실행을 직접 선택하면 다시 볼 수 있습니다.");
}

function renderRuns() {
  const previous = state.selectedRun;
  for (const selector of [$("run-select"), $("summary-run-select")]) {
    selector.replaceChildren(); const empty = el("option", "", "실행을 선택하세요"); empty.value = ""; selector.append(empty);
    state.runs.forEach(run => { const count = Array.isArray(run.turns) ? run.turns.length : run.turns || 0; const option = el("option", "", `${statusLabels[run.status] || run.status || "저장됨"} · ${run.topic || run.id} (${count}발언)`); option.value = run.id; option.title = run.id; selector.append(option); });
    selector.value = previous;
  }
}
async function refreshRuns(preferred) {
  const data = await api("/api/runs"); state.runs = data.runs || [];
  if (preferred) state.selectedRun = preferred;
  renderRuns();
}
async function selectRun(id) {
  state.selectedRun = id || ""; state.currentRun = null; state.speechSignature = ""; state.reportSignature = "";
  $("run-select").value = state.selectedRun; $("summary-run-select").value = state.selectedRun;
  window.DebateSummary.reset();
  renderRun(null);
  if (!id) { renderRun(null); await loadReport(); return; }
  await pollRun(); await loadReport();
}
function updateRunButtons() {
  const run = state.currentRun;
  const active = !!run?.active;
  const anyActive = active || !!state.activeRunId;
  $("start-button").disabled = state.busy || anyActive;
  $("reset-research").disabled = state.busy || anyActive;
  $("reset-research").title = anyActive ? "실행 중에는 초기화할 수 없습니다. 일시정지 또는 중단 후 사용하세요." : "이전 실행 선택과 결과 화면만 비웁니다. 입력한 설정·자료·저장 기록은 유지합니다.";
  $("pause-button").disabled = state.busy || !active || run?.active_job === "correction" || !!run?.pause_requested || ["pausing", "pause_requested", "stopping", "stop_requested"].includes(run?.status);
  $("stop-button").disabled = state.busy || !active || ["stopping", "stop_requested"].includes(run?.status);
  $("resume-button").disabled = state.busy || !run || anyActive || ["completed", "complete"].includes(run.status);
  $("show-active-run").classList.toggle("hidden", !state.activeRunId);
  $("activity-title").textContent = anyActive ? "연구 실행 중" : "대기 중";
  $("activity-detail").textContent = anyActive ? "백그라운드에서 실행 중 · 실행 모니터에서 중단 가능" : "시작·재개 버튼 전 모델 호출 없음";
}
function parseFriendlyError(errorObj) {
  const rawText = typeof errorObj === "string" ? errorObj : (errorObj?.error || errorObj?.message || JSON.stringify(errorObj));
  const time = errorObj?.time ? new Date(errorObj.time).toLocaleTimeString() : "";

  // 1. Google/Gemini 한도 초과
  if (/RESOURCE_EXHAUSTED|Individual quota reached|quota reached|429/i.test(rawText) && /google|gemini|agy/i.test(rawText)) {
    const resetMatch = rawText.match(/Resets in ([^\s.]+)/i);
    const resetTime = resetMatch ? resetMatch[1] : null;
    return {
      isQuota: true,
      title: "🚨 Google (Gemini) 사용량 한도 초과 (RESOURCE_EXHAUSTED / 429)",
      summary: "구글(Antigravity) 계정의 호출 쿼터(할당량)가 모두 소진되었습니다.",
      resetInfo: resetTime ? `⏳ 쿼터 초기화 예정: 약 ${resetTime} 후` : "⏳ 일정 시간 후 쿼터가 자동으로 초기화됩니다.",
      actions: [
        "참가 AI 카드에서 'Gemini' 상단 체크박스를 해제(OFF)하고, GPT · Claude · DeepSeek 등 다른 AI 조합으로 토론을 바로 시작하세요.",
        "쿼터가 남아있는 다른 구글 계정이 있다면 터미널에서 'agy login' 후 다시 시도하세요."
      ],
      raw: rawText,
      time
    };
  }

  // 2. Claude 주간/사용량 한도
  if (/hit your weekly limit|weekly limit|rate_limit_error/i.test(rawText) || (/limit/i.test(rawText) && /claude/i.test(rawText))) {
    const resetMatch = rawText.match(/resets ([^\n]+)/i);
    const resetTime = resetMatch ? resetMatch[1] : null;
    return {
      isQuota: true,
      title: "🚨 Claude Code 사용량 한도 초과 (Weekly Limit / 429)",
      summary: "Claude 공식 구독의 주간 사용 한도에 도달했습니다.",
      resetInfo: resetTime ? `⏳ 초기화 예정: ${resetTime}` : "⏳ 리셋 시점 이후에 다시 사용 가능합니다.",
      actions: [
        "참가 AI 카드에서 'Claude' 체크박스를 해제(OFF)하고, 다른 AI들로 토론을 시작하세요.",
        "터미널에서 'claude' 계정 한도 리셋 시점을 확인하세요."
      ],
      raw: rawText,
      time
    };
  }

  // 3. OpenAI / Codex 한도
  if (/insufficient_quota|rate_limit_exceeded|Usage limit reached/i.test(rawText) || (/429/i.test(rawText) && /codex|openai/i.test(rawText))) {
    return {
      isQuota: true,
      title: "🚨 GPT (Codex) 사용량 한도 초과 (429 Quota Exceeded)",
      summary: "OpenAI ChatGPT/Codex의 사용 한도에 도달했습니다.",
      resetInfo: "⏳ 잠시 후 또는 한도 리셋 시점에 다시 이용 가능합니다.",
      actions: [
        "참가 AI 카드에서 'GPT' 체크박스를 해제하고 다른 AI들로 토론을 진행할 수 있습니다."
      ],
      raw: rawText,
      time
    };
  }

  // 4. DeepSeek / CodeBuddy 한도
  if (/quota_exceeded|balance_exhausted|insufficient balance/i.test(rawText) || (/limit/i.test(rawText) && /codebuddy|deepseek/i.test(rawText))) {
    return {
      isQuota: true,
      title: "🚨 DeepSeek 사용량 한도 초과",
      summary: "CodeBuddy DeepSeek의 호출 한도에 도달했습니다.",
      resetInfo: "⏳ 일정 시간 후 다시 시도해 주세요.",
      actions: [
        "참가 AI 카드에서 'DeepSeek' 체크박스를 해제하고 다른 AI들로 토론을 진행하세요."
      ],
      raw: rawText,
      time
    };
  }

  // 일반 오류
  return {
    isQuota: false,
    title: "⚠️ 실행 오류 발생",
    summary: rawText.split("\n")[0].slice(0, 200),
    actions: ["오류 내용을 확인하시고, 설정이나 모델 ID를 조정한 후 다시 시도하세요."],
    raw: rawText,
    time
  };
}

function renderRunErrors(errors) {
  const container = $("run-errors");
  container.replaceChildren();
  if (!errors || !errors.length) {
    container.classList.add("hidden");
    return;
  }
  container.classList.remove("hidden");

  errors.forEach(err => {
    const info = parseFriendlyError(err);
    const card = el("div", "error-card");
    
    const header = el("div", "error-header");
    header.append(el("strong", "error-title", info.title));
    if (info.time) header.append(el("span", "error-time", info.time));
    
    const body = el("div", "error-body");
    body.append(el("p", "error-summary", info.summary));

    if (info.resetInfo) {
      body.append(el("div", "error-reset-badge", info.resetInfo));
    }

    if (info.actions && info.actions.length) {
      const guideBox = el("div", "error-guide-box");
      guideBox.append(el("span", "error-guide-label", "💡 권장 조치 방법:"));
      const list = el("ul", "error-guide-list");
      info.actions.forEach(act => list.append(el("li", "", act)));
      guideBox.append(list);
      body.append(guideBox);
    }

    const details = el("details", "error-details");
    details.append(el("summary", "", "상세 기술 오류 원문 보기 (JSON / CLI 로그)"));
    details.append(el("pre", "error-raw-text", info.raw));
    body.append(details);

    card.append(header, body);
    container.append(card);
  });
}

function renderRun(run) {
  const active = !!run?.active;
  const runStatus = run?.status || "idle";
  const progress = run?.progress;
  $("run-status").textContent = ["completed", "complete"].includes(runStatus) ? progress && !progress.complete ? "실행 종료 · 발언 미완료" : "전체 실행 완료" : statusLabels[runStatus] || runStatus;
  $("run-status").className = `status-pill ${runStatus}`;
  const turns = run?.turns || [];
  const total = Number(run?.total_turns) || 0;
  const done = progress?.completed_turns ?? turns.length;
  const review = run?.review_state;
  $("turn-progress").textContent = run ? `${done} / ${total || "—"} 발언 수신${progress ? ` · ${progress.completed_stages} / ${progress.total_stages}단계 발언 수신 완료` : ""}${review ? ` · 핵심 반박 미해결 ${review.critical_pending_count || 0}건 · ${review.final_complete ? review.status === "conditional" ? "조건부 권고 기록" : "권고 보류" : "최종 판단 전"}` : ""}` : "선택한 실행 없음";
  $("progress-bar").style.width = `${total ? Math.min(100, done / total * 100) : 0}%`;
  $("run-topic").textContent = run?.topic || "시작 버튼을 누르면 여기에서 진행 상황을 확인할 수 있습니다.";
  $("activity-title").textContent = active ? (statusLabels[runStatus] || "진행 중") : "대기 중";
  $("activity-detail").textContent = active ? "사용자가 시작한 연구가 실행 중입니다" : "시작·재개 버튼 전 모델 호출 없음";
  $("live-indicator").textContent = run?.live ? `${run.live.name || "AI"} 응답 중` : "읽기 전용 조회";
  $("run-control-note").textContent = run?.pause_requested ? "현재 발언 후 일시정지 예정" : active && run?.active_job === "correction" ? "수정 질문으로 원래 AI를 다시 호출하는 중입니다. 즉시 중단으로 취소할 수 있습니다." : active ? "일시정지는 현재 발언 완료 후 멈춥니다. 즉시 중단은 현재 호출을 취소합니다." : "재개는 저장된 실행의 설정·자료로 다음 발언부터 진행합니다. 현재 입력한 새 설정은 적용되지 않습니다.";
  if (run && !active && progress?.next_turn) {
    const next = progress.next_turn;
    $("run-control-note").textContent += ` 재개 대상: ${next.stage_title} · ${next.name} (${next.id}). 미완료 발언은 처음부터 다시 호출하며 이전 시도는 보존합니다.`;
  } else if (run && !active && progress?.complete) $("run-control-note").textContent = "예정된 모든 발언을 수신했습니다. 합의 여부와 근거 검증 상태는 분류별 요약에서 별도로 확인하세요.";
  if (run && Number(run.protocol_version || 0) < 3) $("run-control-note").textContent += " 이 기록은 이전 절차를 유지합니다. 개선된 절차는 새 연구를 시작할 때 적용됩니다.";
  else if (run && Number(run.review_policy_version || 0) < 1 && run.mode !== "smoke") $("run-control-note").textContent += " 이 기록은 기존 교수 비판 기준을 유지합니다. 원안 유지를 명시하는 최종 검토 기준은 새 연구에 적용됩니다.";
  const errors = run?.errors || [];
  renderRunErrors(errors);
  updateRunButtons();
  renderReportList();
  const signature = JSON.stringify([turns, run?.live]);
  if (signature !== state.speechSignature) {
    const container = $("speeches"); const scrollTop = container.scrollTop;
    container.replaceChildren();
    if (!turns.length && !run?.live) {
      const empty = el("div", "stream-empty"); empty.append(el("span", "", "⌘"), el("strong", "", run ? "완료된 발언이 없습니다." : "새로운 관점을 기다리고 있습니다."), el("p", "", run ? "실행 상태와 오류 메시지를 확인하세요." : "현재 모델을 호출하지 않습니다.\n설정을 마치고 직접 연구를 시작하세요.")); container.append(empty);
    }
    turns.forEach((turn, index) => container.append(renderSpeech(turn, false, index)));
    if (run?.live) container.append(renderSpeech(run.live, true, turns.length));
    if ($("auto-scroll").checked) container.scrollTop = container.scrollHeight; else container.scrollTop = scrollTop;
    state.speechSignature = signature;
  }
  renderClassifiedSummary();
}

// Full saved JSON is read locally only when the summary is opened. It provides
// stage IDs, citations and actual correction records omitted by the live API.
function summaryKey(run) { return JSON.stringify([run?.status, (run?.turns || []).map(t => t.id), run?.corrections_signature || []]); }
function summaryRun() {
  const run = state.currentRun;
  if (!run) return null;
  const record = state.summaryCache.get(run.id)?.record;
  if (!record) return run;
  const sourceTurns = new Map((Array.isArray(record.turns) ? record.turns : []).map(t => [t.id, t]));
  return { ...record, ...run, turns: run.turns.map(t => ({ ...sourceTurns.get(t.id), ...t })) };
}
function summaryOptions() { return { onOpenTurn: openSourceTurn, onOpenReport: openSummaryReport, onCorrect: requestCorrection, onAuditVerdict: setAuditVerdict, onSynthesize: requestSynthesis, onReportPlan: name => requestSynthesis(name, true) }; }
// Explicit, confirmed user action only: the moderator AI writes a plain-language result summary from the saved records.
async function requestSynthesis(agentName, reportPlan = false) {
  if (state.busy) return;
  const run = state.currentRun;
  try {
    if (!state.synthesisSupported) throw new Error("결과 정리를 쓰려면 서버를 종료하고 다시 실행한 뒤 페이지를 새로고침하세요.");
    if (reportPlan && !state.reportPlanSupported) throw new Error("보고서 작성안을 지원하는 서버에서 페이지를 다시 열어 주세요. 현재 서버는 이전 버전입니다.");
    if (!run) throw new Error("저장된 실행을 먼저 선택하세요.");
    if (run.active || state.activeRunId) throw new Error("실행 중인 작업이 끝난 뒤 결과 정리를 만드세요.");
    const purpose = reportPlan ? "최종 권고안 하나와 SECTION 1~5 보고서 작성안" : "결과 정리";
    if (!window.confirm(`총괄 AI(${agentName || "모더레이터"})에게 이 실행의 저장 기록(최종 판단, C 후보, 발언 발췌, 반박과 응답, 오류 후보, 손익·실패 분석)을 보내 ${purpose}을 만듭니다.\n\n총괄 1회 호출이며 토론을 다시 돌리지 않습니다. 새 웹 검색은 하지 않으며 구독 사용량을 씁니다. 원본 발언은 바뀌지 않고 총괄의 의견과 작성 재료로 따로 저장됩니다. 진행할까요?`)) return;
    setBusy(true);
    await api("/api/synthesize", { run: run.id, approve_transfer: true, ...(reportPlan ? { report_plan: true } : {}) });
    notify(reportPlan ? "총괄 AI가 최종 권고와 SECTION 1~5 작성안을 만들고 있습니다. '보고서 작성안' 탭에서 확인하세요." : "총괄 AI가 결과 정리를 만들고 있습니다. 끝나면 '결과' 탭에 표시됩니다.");
    await pollRun();
  } catch (error) { notify(error.message, true); } finally { setBusy(false); }
}
// The student's own records on one AI error candidate: the verdict, whether it belongs to STEP 1, and a correction note.
// Saved locally; no model is called and AI records are not changed. Only the fields in `change` are sent.
async function setAuditVerdict(key, change) {
  if (state.busy) return;
  const run = state.currentRun;
  try {
    if (!state.auditVerdictSupported) throw new Error("오류 판정을 저장하려면 서버를 종료하고 다시 실행한 뒤 페이지를 새로고침하세요.");
    if (!run) throw new Error("저장된 실행을 먼저 선택하세요.");
    if (run.active) throw new Error("실행이 끝난 뒤 판정을 저장하세요.");
    const body = { run: run.id, key };
    if ("verdict" in change) body.verdict = change.verdict;
    if ("scope" in change) body.scope = change.scope;
    if (change.verdict === "error" || change.note) {
      const note = window.prompt("교정 메모(선택) · 기준서 원문 근거와 고친 문장을 적으면 'STEP 1 교정 기록'으로 셉니다. 비워 두면 판정만 저장합니다.", change.currentNote || "");
      if (note === null) return;
      body.note = note.trim();
    }
    setBusy(true);
    await api("/api/audit-verdict", body);
    notify(change.verdict === "error" ? "오류로 판정했습니다. 교정 메모가 있으면 교정 기록으로도 셉니다." : change.verdict === "not_error" ? "오류 아님으로 표시했습니다." : "verdict" in change ? "판정을 취소했습니다." : "scope" in change ? "STEP 1 분류를 저장했습니다." : "교정 메모를 저장했습니다.");
    await pollRun();
  } catch (error) { notify(error.message, true); } finally { setBusy(false); }
}
function renderClassifiedSummary() {
  if (state.view !== "summary") return;
  window.DebateSummary.render(summaryRun(), summaryOptions());
  if (state.currentRun) loadSummaryRecord();
}
// Explicit, confirmed user action only: re-ask the original AI with the reviewer's revised question
// or the student's own edit of it. The dialog keeps the AI proposal, the student's question and reason apart.
async function requestCorrection(reviewTurn, auditIndex, revisedQuestion) {
  if (state.busy) return;
  try {
    const run = state.currentRun;
    if (!state.correctionSupported || !state.correctionEditSupported) throw new Error("교정 재호출을 사용하려면 서버를 종료하고 다시 실행한 뒤 페이지를 새로고침하세요.");
    if (!run) throw new Error("저장된 실행을 먼저 선택하세요.");
    if (run.active || state.activeRunId) throw new Error("실행 중인 작업이 끝난 뒤 교정 재호출을 하세요.");
    const data = await api(`/api/source-units?run=${encodeURIComponent(run.id)}`);
    state.correction = { run: run.id, reviewTurn, auditIndex, proposed: revisedQuestion, units: Array.isArray(data.units) ? data.units : [], max: Number(data.max) || 6 };
    $("correction-target").textContent = `검토 발언 ${reviewTurn} · 오류 검토 후보 ${auditIndex + 1}. 질문을 고치면 원래 AI가 받는 질문과 기록이 학생 작성으로 표시됩니다.`;
    $("correction-ai-question").textContent = revisedQuestion;
    $("correction-question").value = revisedQuestion; $("correction-reason").value = ""; $("correction-unit-filter").value = "";
    $("correction-consent").checked = false; $("correction-error").classList.add("hidden");
    renderCorrectionUnits();
    $("correction-dialog").showModal(); $("correction-question").focus();
  } catch (error) { notify(error.message, true); }
}
function selectedCorrectionUnits() { return Array.from($("correction-units").querySelectorAll("input:checked")).map(input => input.value); }
function renderCorrectionUnits() {
  const pending = state.correction; if (!pending) return;
  // Selection lives on the pending request only, so a new request never inherits checkboxes from the last one.
  const chosen = new Set(pending.chosen || []), query = $("correction-unit-filter").value.trim().toLowerCase(), list = $("correction-units");
  list.replaceChildren();
  const rows = pending.units.filter(unit => chosen.has(unit.id) || !query || `${unit.id} ${unit.title}`.toLowerCase().includes(query));
  rows.forEach(unit => {
    const label = el("label", "correction-unit"), input = el("input"); input.type = "checkbox"; input.value = unit.id; input.checked = chosen.has(unit.id);
    input.addEventListener("change", () => { pending.chosen = selectedCorrectionUnits(); updateCorrectionUnitCount(); });
    label.append(input, el("strong", "", unit.id), el("span", "", unit.title)); list.append(label);
  });
  if (!rows.length) list.append(el("p", "empty-message", pending.units.length ? "찾는 문단이 없습니다." : "이 실행의 자료에 기준서 문단이 없습니다."));
  updateCorrectionUnitCount();
}
function updateCorrectionUnitCount() {
  const pending = state.correction, count = (pending?.chosen || []).length, max = pending?.max || 6;
  $("correction-unit-count").textContent = `선택 ${count}개 · 최대 ${max}개`;
  $("correction-unit-count").classList.toggle("required", count > max);
}
async function submitCorrection(event) {
  event.preventDefault();
  const pending = state.correction; if (!pending || state.busy) return;
  const question = $("correction-question").value.trim(), reason = $("correction-reason").value.trim(), units = pending.chosen || [], edited = question !== pending.proposed;
  const fail = message => { $("correction-error").textContent = message; $("correction-error").classList.remove("hidden"); };
  if (!question) return fail("보낼 수정 질문을 입력하세요.");
  if (edited && !reason) return fail("AI가 제안한 수정 질문을 바꿨다면 바꾼 이유를 적어 주세요. 부록 C의 '고친 질문' 기록에 쓰입니다.");
  if (units.length > pending.max) return fail(`기준서 문단은 최대 ${pending.max}개까지 선택할 수 있습니다.`);
  if (!$("correction-consent").checked) return fail("클라우드 전송 동의에 체크해야 재호출할 수 있습니다.");
  setBusy(true);
  try {
    await api("/api/correct", { run: pending.run, review_turn: pending.reviewTurn, audit_index: pending.auditIndex, approve_transfer: true, extra_units: units, ...(edited ? { question, reason } : {}) });
    $("correction-dialog").close(); state.correction = null;
    notify(edited ? "학생이 고친 질문으로 재호출을 시작했습니다. 끝나면 AI 오류 검토에 실제 재응답이 표시됩니다." : "교정 재호출을 시작했습니다. 끝나면 AI 오류 검토에 실제 재응답이 표시됩니다.");
    await pollRun();
  } catch (error) { fail(error.message); } finally { setBusy(false); }
}
async function loadSummaryRecord(force = false) {
  const run = state.currentRun;
  if (!run) return;
  const id = run.id, key = summaryKey(run);
  if (force) state.summaryCache.delete(id);
  if (state.summaryFetch.has(id) || state.summaryCache.get(id)?.key === key) return;
  state.summaryFetch.set(id, key);
  $("summary-load-status").textContent = "저장된 원본 기록을 읽는 중…";
  try {
    const data = await api(`/api/report?run=${encodeURIComponent(id)}&name=debate.json`);
    const record = JSON.parse(data.content);
    if (!record || typeof record !== "object" || !Array.isArray(record.turns)) throw new Error("원본 JSON 형식이 올바르지 않습니다.");
    state.summaryCache.set(id, { key, record });
    if (id === state.selectedRun && state.view === "summary") {
      window.DebateSummary.render(summaryRun(), summaryOptions());
      $("summary-load-status").textContent = "원본 기록 반영 · 읽기 전용 · 추가 AI 호출 없음";
    }
  } catch (error) {
    // Keep the live record available if the full file is not yet present.
    state.summaryCache.set(id, { key, record: null });
    if (id === state.selectedRun) $("summary-load-status").textContent = `상태 기록으로 표시 중 · 원본 조회 실패: ${error.message}`;
  } finally { state.summaryFetch.delete(id); }
}
async function showView(view) {
  state.view = view;
  const summary = view === "summary";
  $("workspace-view").classList.toggle("hidden", summary); $("summary-view").classList.toggle("hidden", !summary);
  for (const item of ["workspace", "summary"]) {
    $("view-" + item).classList.toggle("active", item === view);
    $("view-" + item).setAttribute("aria-pressed", String(item === view));
  }
  // Opening the reader never selects a historical run implicitly. Otherwise a
  // cleared/new workspace could show an old test answer as its current result.
  renderClassifiedSummary();
}
function openSourceTurn(id) {
  const run = summaryRun();
  const turn = run?.turns?.find(item => item.id === (typeof id === "object" ? id.id : id));
  if (!turn) { notify("해당 발언의 저장된 원본을 찾을 수 없습니다.", true); return; }
  $("source-dialog-title").textContent = `${turn.id} · ${turn.name || turn.provider} · ${turn.stage_title || turn.stage || "발언"}`;
  const body = $("source-dialog-content"); body.replaceChildren();
  if (turn.attempt_id) body.append(el("p", "field-help", `연구 ${turn.run_id || run.id} · 발언 ${turn.id} · 실행 시도 ${turn.attempt_id}`));
  for (const [title, content, markdown] of [["실제 전달한 질문", turn.prompt, false], ["실제 받은 답변", turn.answer, true]]) {
    const section = el("section", "source-section"); section.append(el("h3", "", title));
    if (markdown && typeof content === "string" && !content.trim().startsWith("{")) {
      const rich = el("div", "summary-rich"); rich.append(window.DebateSummary.renderMarkdown(content)); section.append(rich);
    } else section.append(el("pre", "source-record-text", typeof content === "string" ? content : content ? JSON.stringify(content, null, 2) : "이 기록에는 원문이 저장되어 있지 않습니다."));
    body.append(section);
  }
  $("source-dialog").showModal();
}
async function openSummaryReport(name) {
  if (!Array.from($("report-select").options).some(option => option.value === name)) return;
  await showView("workspace"); $("report-select").value = name; state.reportSignature = ""; await loadReport();
  $("reports-title").scrollIntoView({ behavior: "smooth", block: "start" });
}
function renderSpeech(turn, live, index) {
  const article = el("article", `speech${live ? " live" : ""}`);
  const meta = el("div", "speech-meta");
  const avatar = el("span", `speech-avatar ${turn.provider || ""}`, providerInitial(turn.provider)); avatar.setAttribute("aria-hidden", "true");
  const person = el("span", "speech-person", turn.name || providerLabel(turn.provider || "AI"));
  if (turn.model || turn.effort) person.append(el("small", "speech-model", `${turn.model || "CLI 기본 모델"} · ${turn.effort || "기본 추론"}`));
  if (turn.execution_metadata?.model_confirmed) person.append(el("small", "speech-model", `CLI 응답 모델 확인: ${turn.execution_metadata.reported_models.join(", ")}`));
  meta.append(avatar, person, el("span", "speech-stage", `${String(index + 1).padStart(2, "0")} · ${turn.stage_title || turn.stage || (live ? "응답 중" : "발언")}`));
  let content = live ? turn.text : (turn.parsed?.analysis ?? turn.answer ?? turn.text ?? turn.response ?? "");
  if (typeof content !== "string") content = JSON.stringify(content, null, 2);
  article.append(meta, el("div", "speech-body", content));
  return article;
}
async function pollRun() {
  if (state.polling) return;
  state.polling = true;
  try {
    const activity = await api("/api/activity");
    state.activeRunId = activity.active_run || ""; updateRunButtons();
    $("connection-error").classList.add("hidden");
    const id = state.selectedRun;
    if (!id) return;
    const run = await api(`/api/run?run=${encodeURIComponent(id)}`);
    if (id !== state.selectedRun) return;
    const previousCount = state.currentRun?.turns?.length;
    const previousStatus = state.currentRun?.status;
    state.currentRun = run; renderRun(run);
    $("connection-error").classList.add("hidden");
    if (previousCount !== run.turns?.length || previousStatus !== run.status) { await loadReport(true); await refreshRuns(); }
  } catch (error) {
    $("connection-error").textContent = `상태 조회 실패: ${error.message}`; $("connection-error").classList.remove("hidden");
  } finally { state.polling = false; }
}
async function controlRun(action) {
  if (!state.selectedRun || state.busy) return;
  try {
    const body = { run: state.selectedRun };
    if (action === "resume") {
      if (!$("transfer-consent").checked) throw new Error("재개하려면 아래 전송 동의에 다시 체크하세요. 재개에는 저장된 실행 설정·자료가 사용됩니다.");
      const run = state.currentRun;
      const materialCount = run?.config?.materials?.length;
      const agentCount = run?.agents?.length || run?.config?.agents?.length || 3;
      if (!window.confirm(`저장된 실행을 재개할까요?\n\n주제: ${run?.topic || state.selectedRun}\n참가자: ${agentCount}명\n선택 자료: ${materialCount === undefined ? "저장된 실행 자료" : `${materialCount}개`}\n웹 검증: ${run?.web_research === true ? "필요 시 허용" : "끄기 (기존 실행 설정)"}\n\n완료된 발언 이후부터 클라우드 AI 호출과 자료 전송을 재개합니다. 왼쪽의 새 설정은 적용되지 않습니다.`)) return;
      body.approve_transfer = true;
    }
    if (action === "stop" && !window.confirm("현재 AI 호출을 즉시 중단할까요?\n이미 처리된 호출은 구독 한도를 사용했을 수 있습니다. 완료된 발언은 보존됩니다.")) return;
    setBusy(true); await api(`/api/${action}`, body);
    if (action === "resume") $("transfer-consent").checked = false;
    notify(({ pause: "현재 발언이 끝나면 일시정지합니다.", stop: "즉시 중단을 요청했습니다.", resume: "저장된 실행을 재개했습니다." })[action]);
    await pollRun();
  } catch (error) { notify(error.message, true); } finally { setBusy(false); }
}

function renderReportList() {
  const currentVal = $("report-select").value;
  $("report-select").replaceChildren();

  // 1. 전체 공통 연구 결과 보고서
  const commonNames = state.reports.length ? state.reports : Object.keys(reportInfo);
  commonNames.forEach(item => {
    const name = typeof item === "string" ? item : item.name;
    if (!name) return;
    const option = el("option", "", `${reportInfo[name]?.[0] || name} · ${name}`);
    option.value = name;
    $("report-select").append(option);
  });

  // 2. 현재 선택된 실행의 AI 참가자별 전용 보고서
  const available = state.currentRun?.available_reports || [];
  let agentReports = available.filter(f => f.startsWith("agent_"));

  if (!agentReports.length && state.currentRun?.agents?.length) {
    state.currentRun.agents.forEach((ag, idx) => {
      const aname = ag.name || `참가자${idx + 1}`;
      const safe = aname.replace(/[\/:*?"<>|\s]+/g, "_").replace(/^_+|_+$/g, "");
      agentReports.push(`agent_${String(idx + 1).padStart(2, "0")}_${safe}.md`);
    });
  }

  if (agentReports.length) {
    const optgroup = el("optgroup");
    optgroup.label = "── 🤖 AI별 개별 사고 및 연구 기록 ──";
    agentReports.forEach(fname => {
      let displayName = fname;
      const m = fname.match(/^agent_\d+_(.+)\.md$/);
      if (m) {
        displayName = m[1].replace(/_/g, " ");
      }
      const option = el("option", "", `🤖 [${displayName}] 전용 연구·사고 기록`);
      option.value = fname;
      optgroup.append(option);
    });
    $("report-select").append(optgroup);
  }

  if (currentVal && Array.from($("report-select").querySelectorAll("option")).some(o => o.value === currentVal)) {
    $("report-select").value = currentVal;
  }
}

async function loadReport(quiet = false) {
  const run = state.selectedRun; const name = $("report-select").value;
  let desc = reportInfo[name]?.[1];
  if (!desc && name?.startsWith("agent_")) {
    const m = name.match(/^agent_\d+_(.+)\.md$/);
    const agentTitle = m ? m[1].replace(/_/g, " ") : "해당 AI";
    desc = `${agentTitle}의 단계별 독립 분석, 잠정 결론, 입장 변화, 수집 근거 및 원본 발언 모음`;
  }
  $("report-description").textContent = desc || "원본 결과 파일";
  const download = $("download-report");
  if (!run || !name) { $("report-content").textContent = "아직 선택한 실행이 없습니다."; download.removeAttribute("href"); download.classList.add("disabled-link"); download.setAttribute("aria-disabled", "true"); return; }
  download.href = `/api/report?run=${encodeURIComponent(run)}&name=${encodeURIComponent(name)}&download=1`; download.classList.remove("disabled-link"); download.setAttribute("aria-disabled", "false");
  try {
    const data = await api(`/api/report?run=${encodeURIComponent(run)}&name=${encodeURIComponent(name)}`);
    if (run !== state.selectedRun || name !== $("report-select").value) return;
    const content = data.content || "(빈 파일)";
    if (state.reportSignature !== `${run}\n${name}\n${content}`) {
      const container = $("report-content"), scroll = container.scrollTop; container.replaceChildren();
      if (name.endsWith(".md")) container.append(window.DebateSummary.renderMarkdown(content));
      else container.append(el("pre", "source-record-text", content));
      container.scrollTop = quiet ? scroll : 0; state.reportSignature = `${run}\n${name}\n${content}`;
    }
  } catch (error) { if (run === state.selectedRun && name === $("report-select").value) { $("report-content").textContent = `이 파일은 아직 생성되지 않았거나 읽을 수 없습니다.\n\n${error.message}`; state.reportSignature = ""; } }
}

function renderConnections(status) {
  $("connections").replaceChildren();
  const providers = status?.providers || status || {};
  Object.keys(state.providers).forEach(provider => {
    const item = providers[provider];
    let text = "저장된 상태 없음";
    if (typeof item === "string") text = item;
    else if (item && typeof item === "object") {
      if (item.probe?.passed) text = `최근 응답 성공${item.probe.model ? ` · ${item.probe.model}` : ""}`;
      else text = item.summary || item.message || item.status || (item.connected === true || item.success === true ? "최근 응답 성공" : item.installed ? `설치됨 · ${typeof item.auth === "string" ? item.auth : "인증 상태는 CLI에서 확인"}` : "설치 상태 확인 필요");
    }
    const row = el("div", "connection-item"); row.append(el("span", "", providerLabel(provider)), el("span", "connection-state", text)); $("connections").append(row);
  });
  if (status?.checked) $("connections").append(el("p", "field-help", `기록 시각: ${status.checked}`));
}

async function uploadFiles(files) {
  if (!files.length) return;
  const input = $("upload-file"); $("upload-button").disabled = true;
  try {
    for (const file of files) {
      if (!/\.(md|txt)$/i.test(file.name)) throw new Error(`${file.name}: .md 또는 .txt 파일만 추가할 수 있습니다.`);
      if (file.size > 2 * 1024 * 1024) throw new Error(`${file.name}: 파일은 2 MB 이하로 추가하세요.`);
      const selected = selectedMaterials();
      const content = await file.text(); const data = await api("/api/upload", { name: file.name, content });
      state.materials = state.materials.filter(item => item.id !== data.material.id); state.materials.push(data.material); renderMaterials([...selected, data.material.id]);
    }
    notify(`${files.length}개 파일을 로컬 자료 목록에 추가했습니다. 모델 호출은 하지 않았습니다.`);
  } catch (error) { notify(error.message, true); } finally { input.value = ""; $("upload-button").disabled = false; }
}

async function deleteCurrentRun() {
  const rid = state.selectedRun || $("run-select").value;
  if (!rid) { notify("삭제할 저장된 실행을 먼저 선택하세요.", true); return; }
  if (state.activeRunId === rid && (state.currentRun?.status === "running" || state.currentRun?.status === "starting")) {
    notify("현재 진행 중인 연구는 먼저 중단하세요.", true); return;
  }
  if (!confirm(`저장된 실행 "${rid}"의 모든 대화 기록과 결과 파일을 영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.`)) return;
  try {
    await api("/api/delete_run", { run: rid });
    state.summaryCache.delete(rid);
    state.selectedRun = "";
    state.currentRun = null;
    notify(`실행 기록 "${rid}"이(가) 삭제되었습니다.`);
    await refreshRuns();
    renderRun(null);
    renderReportList();
    loadReport();
    if (state.view === "summary") {
      await loadSummaryRecord(true);
    }
  } catch (error) {
    notify(error.message, true);
  }
}

function bindEvents() {
  $("show-active-run").addEventListener("click", async () => { try { if (state.activeRunId) { await refreshRuns(); await showView("workspace"); await selectRun(state.activeRunId); $("monitor-title").scrollIntoView({ behavior: "smooth" }); } } catch (error) { notify(error.message, true); } });
  $("reset-research").addEventListener("click", () => resetResearch().catch(error => notify(error.message, true)));
  $("view-workspace").addEventListener("click", () => showView("workspace").catch(error => notify(error.message, true)));
  $("view-summary").addEventListener("click", () => showView("summary").catch(error => notify(error.message, true)));
  $("summary-run-select").addEventListener("change", () => selectRun($("summary-run-select").value).catch(error => notify(error.message, true)));
  $("refresh-summary").addEventListener("click", async () => { try { await refreshRuns(); await pollRun(); await loadSummaryRecord(true); notify("저장된 기록에서 요약을 새로고침했습니다."); } catch (error) { notify(error.message, true); } });
  $("close-source-dialog").addEventListener("click", () => $("source-dialog").close());
  $("correction-form").addEventListener("submit", submitCorrection);
  $("close-correction-dialog").addEventListener("click", () => $("correction-dialog").close());
  $("cancel-correction").addEventListener("click", () => $("correction-dialog").close());
  $("correction-dialog").addEventListener("close", () => { state.correction = null; });
  $("correction-unit-filter").addEventListener("input", renderCorrectionUnits);
  $("add-agent").addEventListener("click", () => addAgent());
  $("mode").addEventListener("change", () => { $("domain").value = $("mode").value === "research" ? "accounting_pbl" : "general"; updateCounts(); });
  $("domain").addEventListener("change", updateCounts);
  $("rounds-dec")?.addEventListener("click", () => {
    const cur = Number($("smoke-rounds").value) || 2;
    if (cur > 1) {
      $("smoke-rounds").value = cur - 1;
      updateCounts();
    }
  });
  $("rounds-inc")?.addEventListener("click", () => {
    const cur = Number($("smoke-rounds").value) || 2;
    if (cur < 20) {
      $("smoke-rounds").value = cur + 1;
      updateCounts();
    }
  });
  $("smoke-rounds")?.addEventListener("input", updateCounts);
  $("smoke-rounds")?.addEventListener("change", () => {
    let val = parseInt($("smoke-rounds").value, 10);
    if (isNaN(val) || val < 1) val = 1;
    if (val > 20) val = 20;
    $("smoke-rounds").value = val;
    updateCounts();
  });
  $("select-all").addEventListener("click", () => { $("materials").querySelectorAll("input").forEach(input => { input.checked = true; }); updateCounts(); });
  $("select-none").addEventListener("click", () => { $("materials").querySelectorAll("input").forEach(input => { input.checked = false; }); updateCounts(); });
  if ($("cleanup-junk-button")) $("cleanup-junk-button").addEventListener("click", cleanupJunkMaterials);
  $("upload-button").addEventListener("click", () => $("upload-file").click());
  $("upload-file").addEventListener("change", event => uploadFiles(Array.from(event.target.files)));
  $("close-dialog").addEventListener("click", () => $("material-dialog").close());
  $("material-dialog").addEventListener("click", event => { if (event.target === $("material-dialog")) { const rect = $("material-dialog").getBoundingClientRect(); if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) $("material-dialog").close(); } });
  $("start-button").addEventListener("click", startRun);
  $("pause-button").addEventListener("click", () => controlRun("pause"));
  $("stop-button").addEventListener("click", () => controlRun("stop"));
  $("resume-button").addEventListener("click", () => controlRun("resume"));
  $("run-select").addEventListener("change", () => selectRun($("run-select").value).catch(error => notify(error.message, true)));
  $("refresh-runs").addEventListener("click", async () => { try { await refreshRuns(); await pollRun(); notify("실행 목록과 상태를 새로고침했습니다."); } catch (error) { notify(error.message, true); } });
  $("delete-run-button").addEventListener("click", () => deleteCurrentRun().catch(error => notify(error.message, true)));
  $("delete-result-button").addEventListener("click", () => deleteCurrentRun().catch(error => notify(error.message, true)));
  $("report-select").addEventListener("change", () => { state.reportSignature = ""; loadReport(); });
  $("save-config").addEventListener("click", async () => { try { const config = getConfig(); await api("/api/config", { config }); notify("현재 설정을 로컬에 저장했습니다. 전송 동의는 저장하지 않습니다."); } catch (error) { notify(error.message, true); } });
  $("load-config").addEventListener("click", async () => { try { const data = await api("/api/config"); if (!data.config) throw new Error("저장된 설정이 없습니다."); applyConfig(data.config); notify("저장된 설정을 불러왔습니다. 연구를 시작하지 않았습니다."); } catch (error) { notify(error.message, true); } });
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.initialized) pollRun(); });
}

async function init() {
  bindEvents();
  try {
    const data = await api("/api/bootstrap");
    state.webResearchSupported = data.web_research_supported === true;
    state.protocolVersionSupported = Number(data.protocol_version_supported || 0);
    state.reviewPolicyVersionSupported = Number(data.review_policy_version_supported || 0);
    state.courseGuidanceSupported = Number(data.course_guidance_version_supported || 0);
    state.correctionSupported = data.correction_supported === true;
    state.correctionEditSupported = data.correction_edit_supported === true;
    state.auditVerdictSupported = data.audit_verdict_supported === true;
    state.synthesisSupported = data.synthesis_supported === true;
    state.reportPlanSupported = data.report_plan_supported === true;
    state.submittedAuditSupported = data.submitted_audit_supported === true;
    state.submittedAuditVersion = data.submitted_audit_version_supported || 0;
    state.submittedInputMaxBytes = data.submitted_input_max_bytes || 18000;
    [1,2,3].forEach(i => ["question", "answer", "source", "suspicion"].forEach(k => $(`case-${i}-${k}`)?.addEventListener("input",updateSubmittedBudget)));
    state.csrf = data.csrf; state.providers = normalizeModelCatalog(data.providers || {}); state.materials = data.materials || []; state.runs = data.runs || []; state.reports = data.reports || []; state.activeRunId = data.active_run || "";
    let initialConfig = data.defaults || {};
    try { const saved = await api("/api/config"); if (saved.config) initialConfig = saved.config; } catch (_) { /* defaults remain usable */ }
    applyConfig(initialConfig); renderRuns(); renderReportList(); renderConnections(data.connection_status); renderRun(null); state.initialized = true;
    if (!state.webResearchSupported || state.protocolVersionSupported < 3 || state.reviewPolicyVersionSupported < 1 || state.courseGuidanceSupported < 3) {
      $("web-research-notice").textContent = "새 연구 절차 반영 대기: 제어실 서버 창에서 Ctrl+C로 종료한 뒤 실행 파일을 다시 열고 이 페이지를 새로고침하세요. 시작 전까지 모델 호출은 없습니다.";
      $("web-research-notice").classList.remove("hidden");
    }
  } catch (error) { $("connection-error").textContent = `제어실을 불러올 수 없습니다. ${error.message}`; $("connection-error").classList.remove("hidden"); $("start-button").disabled = true; }
  // Status and file polling is read-only. No execution endpoint is called here.
  setInterval(() => { if (state.initialized && !document.hidden) pollRun(); }, 1500);
}
init();
