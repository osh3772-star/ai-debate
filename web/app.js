/* Read-only classification of existing records. This module never calls a model or an endpoint. */
(function () {
  "use strict";
  const researchPhases = [
    ["independent", "독립 조사", "각 AI가 다른 의견을 보기 전 작성한 조사"],
    ["cross", "교차 검증", "다른 AI의 주장·수치·출처에 대한 검토"],
    ["alternatives", "대안 C 설계", "후보·비용·실행 가능성 비교와 선정"],
    ["perspectives", "다중 관점 재검토", "윤리 이론·이해관계자·실패 조건 검토"],
    ["professor", "교수 관점 비판", "감점 요인·반례·수정 요구"],
    ["revision", "C안 최종 수정", "비판 반영·남은 약점·소수의견"]
  ];
  const smokePhases = [["round1", "1라운드 토론", "참가자별 독립 제안"], ["round2", "2라운드 토론", "다른 참가자 발언을 인용한 상호 반박"]];
  const consensusPhases = [["independent", "독립 분석", "각 AI가 서로의 의견을 보기 전 작성한 분석"], ["cross", "교차 반박", "다른 참가자의 주장·근거에 대한 반박"], ["rebuttal", "재반론", "받은 반박에 대한 답변과 입장 재검토"], ["consensus", "최종 합의 검토", "참가자별 최종 결론·동의 항목·남은 이견"]];
  const expandedConsensusPhases = [...consensusPhases.slice(0, 3), ["alternatives", "혁신적 대안 C 설계", "후보 비교·결합 및 선정"], ["professor", "교수 관점 적대적 비판", "오류·논리·실행성 검토"], ["consensus", "최종 합의 및 비판 수정", "C안 수정·최종 의견과 이견"]];
  const reviewedResearchPhases = [...researchPhases.slice(0, 2), ["rebuttal", "반론 응답", "받은 반박에 대한 수용·수정·기각과 근거"], ...researchPhases.slice(2)];
  const tabs = [["results", "결과"], ["report", "보고서 작성안"], ["overview", "전체 현황"], ["research", "AI별 조사"], ["debate", "토론 · 반박"], ["decisions", "대안 C · 결론"], ["evidence", "근거 · 오류 · 교수 비판"]];
  const statuses = { running: "진행 중", starting: "시작 중", completed: "완료", complete: "완료", paused: "일시정지", stopped: "중단", stopped_by_user: "사용자 중단", interrupted: "중단됨", failed: "오류", error: "오류", pending: "대기", ready: "대기", created: "준비", pause_requested: "정지 대기", pausing: "정지 대기", stopping: "중단 중", stop_requested: "중단 요청" };
  const kinds = { task_fact: "과제 사실", verified_external: "외부 확인 주장", assumption: "가정", unverified: "미확인 주장" };
  let host = null, run = null, options = {}, activeTab = "overview", signature = "", detailsState = new Map(), participantFilter = "all";

  function text(value) {
    if (value === null || value === undefined) return "";
    if (Array.isArray(value)) return value.map(text).filter(Boolean).join("\n");
    if (typeof value === "object") return Object.entries(value).map(([k, v]) => k + ": " + text(v)).join("\n");
    return String(value);
  }
  function arr(value) { return Array.isArray(value) ? value : []; }
  function quoteMatches(quote, turn) {
    const normalize = value => String(value || "").replace(/["'`“”‘’]+/g, "").replace(/(?<![\p{L}\p{N}_])\*+|\*+(?![\p{L}\p{N}_])/gu, "").replace(/\s+/g, " ").trim();
    const needle = normalize(quote), candidates = [turn.answer];
    function collect(value) {
      if (typeof value === "string") candidates.push(value);
      else if (Array.isArray(value)) value.forEach(collect);
      else if (value && typeof value === "object") Object.values(value).forEach(collect);
    }
    try { collect(JSON.parse(turn.answer)); } catch (_) { collect(turn.parsed); }
    return !!needle && candidates.some(value => normalize(value).includes(needle));
  }
  function node(tag, cls, value) { const e = document.createElement(tag); if (cls) e.className = cls; if (value !== undefined) e.textContent = text(value); return e; }
  function add(parent, ...children) { children.filter(Boolean).forEach(child => parent.append(child)); return parent; }
  function badge(label, tone) { return node("span", "ds-badge" + (tone ? " ds-" + tone : ""), label); }
  function button(label, action, cls) { const b = node("button", cls || "ds-link-button", label); b.type = "button"; b.addEventListener("click", action); return b; }
  function empty(message, detail) { return add(node("div", "ds-empty"), node("strong", "", message), detail ? node("p", "", detail) : null); }
  function section(title, detail) { return add(node("section", "ds-section"), add(node("div", "ds-section-title"), node("h3", "", title), detail ? node("p", "", detail) : null)); }
  function rich(value, cls) { const e = node("div", "ds-markdown" + (cls ? " " + cls : "")); e.append(renderMarkdown(text(value))); return e; }
  function excerpt(value, max) { const clean = text(value).replace(/[#>*_`|]/g, "").replace(/\s+/g, " ").trim(); return clean.length > (max || 240) ? clean.slice(0, max || 240) + "…" : clean; }
  function detail(label, content, key, opened) {
    const e = node("details", "ds-details"); e.append(node("summary", "", label));
    if (key && (detailsState.has(key) ? detailsState.get(key) : opened)) e.open = true;
    if (key) e.addEventListener("toggle", () => detailsState.set(key, e.open));
    e.append(content); return e;
  }
  function resolveTurn(turnOrId) {
    if (!turnOrId) return null;
    if (typeof turnOrId === "object" && turnOrId.id) return turnOrId;
    if (typeof turnOrId === "string") {
      const match = arr(run.turns).find(t => t.id === turnOrId);
      if (match) return match;
      return { id: turnOrId };
    }
    return null;
  }
  function friendlyTurnLabel(turnOrId) {
    const turn = resolveTurn(turnOrId);
    if (!turn) return "발언 미기록";
    const id = turn.id || "";
    const m = String(id).match(/^S(\d+)A(\d+)$/i);
    const stageNum = m ? m[1] : null;
    const agentNum = m ? m[2] : null;

    let stageName = "";
    if (turn.stage_title) {
      stageName = turn.stage_title.split(/[:(]/)[0].trim();
    } else if (stageNum) {
      stageName = `${stageNum}단계`;
    }

    let agentName = "";
    if (turn.name) {
      agentName = turn.name.replace(/\s*\([^)]*\)/g, "").trim();
      if (!agentName) agentName = turn.name;
    } else if (agentNum) {
      const plist = participants();
      const p = plist[parseInt(agentNum, 10) - 1];
      agentName = p?.name?.replace(/\s*\([^)]*\)/g, "").trim() || `AI ${agentNum}`;
    }

    if (stageName && agentName) {
      return `[${stageName} · ${agentName}]`;
    } else if (agentName) {
      return `[${agentName}]`;
    } else if (stageName) {
      return `[${stageName}]`;
    }
    return id || "발언";
  }
  function friendlyClaimLabel(claimId, turn) {
    if (!claimId) return { label: "주장 미기록", rawId: "" };
    const rawId = String(claimId);
    let t = resolveTurn(turn);
    let turnPart = null;
    let clmNum = null;

    const dotMatch = rawId.match(/^(S\d+A\d+)\.(?:CLM-?)?(\d+)$/i);
    if (dotMatch) {
      turnPart = dotMatch[1];
      clmNum = dotMatch[2];
    } else {
      const dashMatch = rawId.match(/^(?:CLM-)?(S\d+A\d+)-(\d+)$/i);
      if (dashMatch) {
        turnPart = dashMatch[1];
        clmNum = dashMatch[2];
      } else {
        const numMatch = rawId.match(/(?:CLM-?|C-?)?(\d+)$/i);
        if (numMatch) {
          clmNum = numMatch[1];
        }
      }
    }

    if (!t && turnPart) {
      t = resolveTurn(turnPart);
    }

    let agentShort = "";
    if (t) {
      const n = t.name ? t.name.replace(/\s*\([^)]*\)/g, "").trim() : "";
      agentShort = n || t.id || "";
    }

    let label = "";
    if (agentShort && clmNum) {
      label = `[${agentShort}] 주장 #${clmNum}`;
    } else if (clmNum) {
      label = `주장 #${clmNum}`;
    } else {
      label = rawId;
    }
    return { label, rawId };
  }
  function claimIdBadge(claimId, turn) {
    if (!claimId) return null;
    const { label, rawId } = friendlyClaimLabel(claimId, turn);
    const span = node("strong", "ds-claim-id", label);
    if (rawId && rawId !== label) span.title = `내부 식별 ID: ${rawId}`;
    return span;
  }
  // Display saved references in plain language; IDs remain unchanged in records and callbacks.
  function recordLabel(id) {
    const raw = text(id), match = raw.match(/^S(\d+)A(\d+)(?:\.(CLM|CH|LQ|SC|CX|SEED|C)(\d+))?$/);
    if (/^USERCASE[1-3]$/.test(raw)) return "사용자 제출 의심 답변 " + raw.slice(-1);
    const turn = match && arr(run?.turns).find(t => t.id === `S${match[1]}A${match[2]}`);
    if (!turn) return raw || "기록 미지정";
    const knownStage = phases().find(p => p[0] === turn.stage)?.[1];
    const title = turn.stage_title && !/^[a-z_]+$/i.test(turn.stage_title) ? turn.stage_title : knownStage;
    const stage = mode() === "smoke" ? `${match[1]}라운드` : `${match[1]}단계${title ? " " + title : ""}`;
    const kind = { C: "후보", CLM: "주장", CH: "검토", LQ: "합법성 질의", SC: "의심 답변 검증", CX: "반례", SEED: "초기 아이디어" }[match[3]];
    return `${turn.name || `참가자 ${match[2]}`} · ${stage}${kind ? ` · ${kind} ${match[4]}` : ""}`;
  }
  function recordReference(id, tag = "span", cls = "") {
    const e = node(tag, cls, recordLabel(id));
    if (id) e.title = `내부 참조 ID: ${id}`;
    return e;
  }
  function readableReferences(value) {
    return text(value).replace(/\b(?:USERCASE[1-3]|S\d+A\d+(?:\.(?:CLM|CH|LQ|SC|CX|SEED|C)\d+)?)\b/g, recordLabel);
  }
  function linkSource(turn) {
    const e = node("div", "ds-source");
    const label = friendlyTurnLabel(turn);
    const textSpan = node("span", "", `${label} · ${turn.stage_title || "단계 미기록"}`);
    if (turn.id) textSpan.title = `내부 발언 ID: ${turn.id}`;
    e.append(textSpan);
    if (turn.id) {
      const idSpan = node("span", "ds-muted", ` (${turn.id})`);
      idSpan.title = `시스템 원시 ID: ${turn.id}`;
      e.append(idSpan);
    }
    if (options.onOpenTurn) e.append(button("발언 원문", () => options.onOpenTurn(turn.id)));
    return e;
  }
  function reportButton(name, label) { return options.onOpenReport ? button(label, () => options.onOpenReport(name), "ds-report-button") : null; }
  function markdownField(label, value, fallback) { return add(node("div", "ds-field"), node("h4", "", label), value ? rich(value) : node("p", "ds-muted", fallback || "기록 없음")); }

  /* All Markdown is built as text nodes. Raw HTML, images and script URLs are never interpreted. */
  function inline(value, target) {
    const source = text(value), pattern = /(`+)([^`]+)\1|\[([^\]]+)\]\(([^\s)]+)(?:\s+"[^"\n]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|~~([^~]+)~~/g;
    let match, at = 0;
    while ((match = pattern.exec(source))) {
      target.append(document.createTextNode(source.slice(at, match.index)));
      if (match[1]) target.append(node("code", "", match[2]));
      else if (match[3]) {
        let safe = false;
        try { const u = new URL(match[4]); safe = ["https:", "http:"].includes(u.protocol); } catch (_) {}
        if (safe) { const a = node("a", "", match[3]); a.href = match[4]; a.target = "_blank"; a.rel = "noopener noreferrer"; target.append(a); }
        else target.append(document.createTextNode(match[3] + " (" + match[4] + ")"));
      } else { const e = node(match[5] || match[6] ? "strong" : match[7] ? "em" : "del", "", match[5] || match[6] || match[7] || match[8]); target.append(e); }
      at = pattern.lastIndex;
    }
    target.append(document.createTextNode(source.slice(at)));
  }
  function cells(line) { return line.trim().replace(/^\|/, "").replace(/\|$/, "").split(/(?<!\\)\|/).map(s => s.trim().replace(/\\\|/g, "|")); }
  function renderMarkdown(value) {
    const fragment = document.createDocumentFragment(), lines = text(value).replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    const block = line => /^(?:\s*$|\s{0,3}#{1,6}\s|\s*```|\s*~~~|\s*>|\s*[-+*]\s+|\s*\d+[.)]\s+|\s*[-*_]{3,}\s*$)/.test(line);
    while (i < lines.length) {
      const line = lines[i];
      if (!line.trim()) { i++; continue; }
      let m;
      if ((m = line.match(/^\s*(`{3,}|~{3,})(.*)$/))) {
        const marker = m[1][0], length = m[1].length, language = m[2].trim(), body = []; i++;
        while (i < lines.length && !new RegExp("^\\s*" + marker + "{" + length + ",}\\s*$").test(lines[i])) body.push(lines[i++]);
        if (i < lines.length) i++;
        const pre = node("pre", ""); pre.append(node("code", "", body.join("\n"))); if (language) pre.setAttribute("aria-label", language + " 코드"); fragment.append(pre); continue;
      }
      if ((m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/))) { const h = node("h" + Math.min(6, m[1].length + 1), ""); inline(m[2], h); fragment.append(h); i++; continue; }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { fragment.append(node("hr")); i++; continue; }
      if (line.includes("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(lines[i + 1])) {
        const wrap = node("div", "ds-table-wrap"), table = node("table", "ds-data-table"), head = node("thead"), headrow = node("tr"), body = node("tbody");
        const headers = cells(line); headers.forEach(value => { const th = node("th"); th.scope = "col"; inline(value, th); headrow.append(th); }); head.append(headrow); i += 2;
        while (i < lines.length && lines[i].trim() && lines[i].includes("|")) { const row = node("tr"), values = cells(lines[i++]); for (let col = 0; col < Math.max(headers.length, values.length); col++) { const cell = node("td"); inline(values[col] || "", cell); row.append(cell); } body.append(row); }
        table.append(head, body); wrap.append(table); fragment.append(wrap); continue;
      }
      if (/^\s*>/.test(line)) { const quote = []; while (i < lines.length && /^\s*>/.test(lines[i])) quote.push(lines[i++].replace(/^\s*>\s?/, "")); const b = node("blockquote"); b.append(renderMarkdown(quote.join("\n"))); fragment.append(b); continue; }
      if ((m = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/))) {
        const ordered = /^\d/.test(m[2]), list = node(ordered ? "ol" : "ul"); if (ordered && parseInt(m[2], 10) !== 1) list.start = parseInt(m[2], 10);
        while (i < lines.length) { const item = lines[i].match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/); if (!item || /^\d/.test(item[2]) !== ordered) break; const li = node("li"); inline(item[3], li); list.append(li); i++; while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*[-+*]\s|^\s*\d+[.)]\s/.test(lines[i])) { li.append(node("br")); inline(lines[i++].trim(), li); } }
        fragment.append(list); continue;
      }
      const paragraph = node("p"), words = [line]; i++;
      while (i < lines.length && !block(lines[i]) && !(lines[i].includes("|") && i + 1 < lines.length && /-\s*\|/.test(lines[i + 1]))) words.push(lines[i++]);
      words.forEach((word, index) => { if (index) paragraph.append(node("br")); inline(word, paragraph); }); fragment.append(paragraph);
    }
    return fragment;
  }

  function mode() { return run?.mode || run?.config?.mode || run?.ui_config?.mode || "research"; }
  function protocolV3() { return Number(run?.protocol_version || 0) >= 3; }
  function balancedReview() { return protocolV3() && Number(run?.review_policy_version || 0) >= 1; }
  function guided() { return protocolV3() && Number(run?.course_guidance_version || 0) >= 1; }
  function guidedPbl() { return guided() && run?.domain === "accounting_pbl"; }
  function planned() { return guidedPbl() && Number(run?.course_guidance_version || 0) >= 2 && mode() !== "smoke"; }
  const requirementLabels = { not_due: "담당 단계 전", recorded: "기록 있음", partial: "일부 기록", missing: "기록 없음", needs_check: "근거 ID 확인 필요", not_applicable: "해당 없음 · 사유 기록" };
  const legalityLabels = { permitted: "허용된다고 판단", not_permitted: "허용되지 않는다고 판단", undetermined: "판단 보류" };
  function decisionLabel(turn) {
    return ({ not_due: "잠정 의견 · 선정 전", provisional: "잠정 검토", conditional_recommendation: "조건부 권고 · 사실 검증 별도", withheld: "최종 권고 보류" })[turn?.protocol_checks?.decision_status] || "잠정 의견 · 검토 상태 미기록";
  }
  function expandedConsensus() { return mode() === "consensus" && Number(run?.protocol_version || 1) >= 2; }
  function smokeRoundsCount() {
    const fromConfig = Number(run?.ui_config?.smoke_rounds || run?.smoke_rounds || run?.config?.smoke_rounds || 0);
    let maxTurnRound = 0;
    arr(run?.turns).forEach(t => {
      const m = text(t.stage || t.id).match(/round(\d+)/i) || text(t.stage_title).match(/(\d+)라운드/);
      if (m) maxTurnRound = Math.max(maxTurnRound, Number(m[1]));
    });
    return Math.max(fromConfig > 0 ? 1 : 2, fromConfig, maxTurnRound);
  }
  function dynamicSmokePhases() {
    const total = smokeRoundsCount();
    const list = [];
    for (let r = 1; r <= total; r++) {
      let desc = "다른 참가자 발언을 인용한 상호 반박";
      if (r === 1) desc = "참가자별 독립 제안";
      else if (r === total && total > 1) desc = protocolV3() && total === 2 ? "상호 검토 · 최종 연구·합의 전" : "판단 정리 · 미해결·이견 보존";
      list.push([`round${r}`, `${r}라운드 토론`, desc]);
    }
    return list;
  }
  function phases() {
    const list = mode() === "smoke" ? dynamicSmokePhases() : mode() === "consensus" ? expandedConsensus() ? expandedConsensusPhases : consensusPhases : protocolV3() ? reviewedResearchPhases : researchPhases;
    return list.map(p => balancedReview() && p[0] === "professor" ? guidedPbl() ? [p[0], "최종 적대적 검토 · 반례 확인", "감점 요인·반례·사실 확인 · 근거 있으면 원안 유지"] : [p[0], "평가 기준 기반 최종 검토", "원안 유지·결함·미확인 전제·조건부 위험 검토"] : balancedReview() && ["revision", "consensus"].includes(p[0]) ? [p[0], "검토 채택·기각 및 최종 판단", "근거 있는 수정·원안 유지·남은 이견"] : protocolV3() && run?.domain === "general" && p[0] === "alternatives" ? [p[0], "설명·선택지 비교", "원래 질문의 설명과 선택지 비교"] : protocolV3() && run?.domain === "general" && p[0] === "revision" ? [p[0], "비판 반영·최종 판단", "조건부 판단·보류·남은 이견"] : p);
  }
  function tabLabel(id, label) { if (balancedReview() && id === "evidence") return guidedPbl() ? "근거 · 오류 · 적대적 검토" : "근거 · 오류 · 최종 검토"; return mode() === "consensus" ? ({ research: "AI별 분석", decisions: expandedConsensus() ? "대안 C · 최종 합의" : "최종 결론 · 합의 검토", evidence: expandedConsensus() ? "근거 · 오류 · 교수 비판" : "근거 · 오류" })[id] || label : label; }
  function phaseOf(turn) { const named = phases().find(p => p[0] === turn.stage || p[1] === turn.stage_title); if (named) return named[0]; const m = text(turn.id).match(/^S(\d+)A\d+$/); return m ? phases()[Number(m[1]) - 1]?.[0] || "other" : "other"; }
  function participants() {
    const records = arr(run?.agents).map((a, index) => ({ ...(a || {}), key: "a" + (index + 1), index, name: a?.name || "참가자 " + (index + 1) }));
    for (const t of arr(run?.turns)) { const match = text(t.id).match(/^S\d+A(\d+)$/), index = match ? Number(match[1]) - 1 : -1; if (index >= 0 && records[index]) continue; if (!records.some(a => a.name === t.name && a.provider === t.provider)) records.push({ key: "extra" + records.length, name: t.name || "이름 미기록", provider: t.provider, model: t.model, index: records.length }); }
    return records;
  }
  function belongs(turn, agent) { const m = text(turn.id).match(/^S\d+A(\d+)$/); return m ? Number(m[1]) - 1 === agent.index : turn.name === agent.name && turn.provider === agent.provider; }
  function turnsFor(agent) { return arr(run?.turns).filter(t => belongs(t, agent)); }
  function parsed(turn) { return turn?.parsed && typeof turn.parsed === "object" && !Array.isArray(turn.parsed) ? turn.parsed : {}; }
  function analysis(turn) { const p = parsed(turn); return text(p.analysis || (!Object.keys(p).length ? turn.answer : "")); }
  function records(field) { return arr(run?.turns).flatMap(turn => arr(parsed(turn)[field]).filter(item => item !== null && item !== undefined).map((item, index) => ({ item: typeof item === "object" || ["unresolved", "agreements", "dissent"].includes(field) ? item : { claim: text(item), proposal: text(item), error: text(item) }, turn, index }))); }
  function completedSlots(phase) { const seen = new Set(); arr(run?.turns).filter(t => phaseOf(t) === phase).forEach(t => { const p = participants().find(a => belongs(t, a)); if (p) seen.add(p.key); }); return seen.size; }
  function completedCount() { return phases().reduce((count, phase) => count + completedSlots(phase[0]), 0); }
  function nextTab(id) { activeTab = id; paint(); host?.querySelector(".ds-tabs [aria-selected=true]")?.focus(); }
  function latestConclusion(agent) { return [...turnsFor(agent)].reverse().find(t => text(parsed(t).conclusion).trim()); }
  function finalDecision(agent) { return [...turnsFor(agent)].reverse().find(t => ["conditional_recommendation", "withheld"].includes(parsed(t).decision?.status)); }
  const PARSE_FAILED = "구조화 응답 실패; 원문 확인";
  const problemLabels = { target_missing: "검토 대상 ID가 비었거나 없는 ID", target_turn_mismatch: "대상 발언 번호 불일치", self_review: "자기 주장을 스스로 검토", bad_disposition: "판정 값 형식 오류", no_reason: "검토 이유 없음", quote_mismatch: "인용이 원문과 다름" };

  /* The result overview is computed by the server from the saved record (result_digest.py); this only lays it out.
     A finding is red only when the program could check its quote and source lines and another AI's record backs it,
     and it is confirmed only by the student's own verdict. */
  function findingFor(turnId, index) { return arr(run.result_overview?.findings).find(f => arr(f.reports).some(r => r.review_turn === turnId && r.index === index)) || null; }
  const evidenceLabels = { source: "자료 행 확인", reasoning: "계산·논리 근거(자료 행 인용 없음)", unresolved: "인용한 파일·행을 선택 자료에서 찾지 못함", missing: "선택 자료에 없는 행 포함" };
  const replyLabels = { admitted: "인정", disputed: "반박", no_reply: "응답 없음", ambiguous: "응답 연결 미확인", none: "연결된 검토 기록 없음" };
  // The verdict, the STEP 1 scope and the correction note are three separate student records; none is inferred.
  function verdictControls(finding) {
    const box = node("div", "ds-verdict"), v = finding.verdict || {}, current = v.verdict, time = v.time ? " · " + String(v.time).slice(0, 16).replace("T", " ") : "";
    box.append(node("span", "ds-muted", current ? `학생 판정 · ${current === "error" ? "오류 맞음" : "오류 아님"}${time}` : "학생 판정 · 아직 안 함 · 원문을 읽고 표시하세요"));
    const call = change => options.onAuditVerdict(finding.key, { ...change, currentNote: v.note || "" });
    if (options.onAuditVerdict && !run.active) {
      if (current !== "error") box.append(button("오류 맞음", () => call({ verdict: "error" }), "ds-report-button ds-verdict-error"));
      if (current !== "not_error") box.append(button("오류 아님", () => call({ verdict: "not_error" }), "ds-report-button"));
      if (current) box.append(button("판정 취소", () => call({ verdict: null }), "ds-link-button"));
      box.append(button(finding.step1 ? "STEP 1에서 제외" : "STEP 1에 포함", () => call({ scope: finding.step1 ? "out" : "in" }), "ds-report-button"));
      if (v.scope) box.append(button("분류를 자동으로", () => call({ scope: null }), "ds-link-button"));
      if (current === "error") box.append(button(v.note ? "교정 메모 고치기" : "교정 메모 쓰기", () => call({ note: true }), "ds-link-button"));
    }
    const wrap = add(node("div", ""), box);
    if (text(v.note).trim()) wrap.append(markdownField("학생 교정 메모 · 원문 근거와 고친 문장", v.note));
    return wrap;
  }
  function replyText(reply) {
    if (!reply || reply.link === "none") return replyLabels.none;
    if (reply.link === "ambiguous") return "응답 연결 미확인 · 같은 문장을 인용한 검토가 여럿이라 하나로 정하지 않았습니다";
    if (reply.link === "no_reply") return `${recordLabel(reply.challenge_id)} · 응답 없음`;
    return `${recordLabel(reply.challenge_id)}에 '${reply.disposition}' · ${excerpt(reply.reason, 220)}`;
  }
  function reportBlock(r, n) {
    const who = recordLabel(r.review_turn) === text(r.review_turn) ? `${r.reviewer || "검토 AI"} · ${r.review_turn}` : recordLabel(r.review_turn);  // the label already names the reviewer
    return add(node("div", "ds-finding-report"), node("h5", "", `지적 ${n} · ${who}${r.error_type ? " · " + r.error_type : ""}`),
      rich(r.error || "지적 내용 미기록"),
      node("p", "ds-signals", `근거 · ${evidenceLabels[r.evidence_kind] || "미분류"}${arr(r.unresolved).length ? " · 찾지 못한 참조 " + arr(r.unresolved).join(", ") : ""}`),
      node("p", "ds-signals", "지적받은 AI의 응답 · " + replyText(r.reply)),
      text(r.improved_answer).trim() ? markdownField("교정 후보 · 검토 AI 제안", r.improved_answer) : null);
  }
  function findingCard(f) {
    const card = node("article", "ds-finding ds-finding-" + (f.tone || "neutral")), reports = arr(f.reports), sig = f.signals || {}, mark = ok => ok ? "✔" : "✖";
    add(card, add(node("div", "ds-card-heading"), node("h4", "", `${recordLabel(f.target_turn) || f.target_name || "참가자"} · ${arr(f.error_types).join(", ") || "유형 미기록"}`), badge(f.label, f.tone)));
    card.append(badge(f.step1_source === "student" ? (f.step1 ? "학생이 STEP 1에 포함" : "학생이 STEP 1에서 제외") : f.step1 ? "STEP 1 관련 후보 · 분류 확인 필요" : "STEP 1 관련으로 분류되지 않음", "neutral"));
    add(card, markdownField("AI가 한 말 · 원답변 인용", f.quote),
      node("p", "ds-signals", `인용 일치 ${mark(sig.quote_ok)} · 근거 ${evidenceLabels[sig.evidence] || "미분류"} · 지적받은 AI ${replyLabels[sig.reply] || "미확인"} · 다른 AI도 지적 ${mark(sig.corroborated)}`));
    if (reports.length) card.append(reportBlock(reports[0], 1));
    if (reports.length > 1) card.append(detail(`같은 문장에 대한 다른 지적 ${reports.length - 1}건`, add(node("div", "ds-record-stack"), ...reports.slice(1).map((r, i) => reportBlock(r, i + 2))), "finding-" + f.key, false));
    const lines = arr(f.lines);
    if (lines.length) card.append(add(node("div", "ds-source-lines"), node("h5", "", "인용한 원문 · 이 실행에 선택된 자료(지적을 입증하는지는 별도 판단)"), ...lines.map(l => add(node("p", ""), node("strong", "", `${l.file} L${l.line}`), node("span", "", " " + text(l.text))))));
    card.append(verdictControls(f));
    return card;
  }
  function recheckBlock(rc) {
    const b = rc.before || {}, a = rc.after || {}, list = node("ul", "ds-plain-list");
    list.append(node("li", "", `인용이 실제로 대상 기록의 다른 항목에 있던 검토 ${rc.newly_valid || 0}건을 인정: ${arr(rc.by_field).map(x => `${x.label} ${x.count}건`).join(" · ") || "없음"}`));
    list.append(node("li", "", `참조·인용 검토 필요 ${b.invalid_references}건 → ${a.invalid_references}건 · 교차 검토 누락 ${b.missing_reviews}건 → ${a.missing_reviews}건 · 미해결 핵심 반박 ${b.critical_pending || 0}건 → ${a.critical_pending || 0}건 · 프로그램 보류 ${b.final_withheld}건 → ${a.final_withheld}건`));
    list.append(node("li", "ds-muted", "새로 인정된 검토 가운데 응답받지 못한 핵심 반박이 있으면 미해결 핵심 반박이 늘어납니다. 인정 범위가 넓어진 결과이며 새 오류가 생긴 것이 아닙니다."));
    list.append(node("li", "", "여전히 인정되지 않는 검토: " + (Object.entries(rc.still_invalid || {}).map(([k, n]) => `${problemLabels[k] || k} ${n}건`).join(" · ") || "없음")));
    list.append(node("li", "", "재검사 후 보류 사유: " + (arr(a.blockers).join(", ") || "없음")));
    list.append(node("li", "ds-muted", `계산 시각 ${rc.checked_at || "미기록"} · 원본 발언 기록 해시 ${String(rc.source_sha256 || "").slice(0, 16)}… · 인용이 있다는 확인은 반박 내용이 옳다는 뜻이 아닙니다.`));
    return detail(`수정된 인용 검사로 다시 계산한 결과 · 참고 (규칙 ${rc.from_version} → ${rc.to_version}, 실행 당시 판정은 그대로)`, list, "quote-recheck", false);
  }
  /* '결과' tab: the finished run in plain language. The moderator's summary (an explicit AI call) is shown as its opinion
     when present; every section also stands on the saved records alone. Nothing here calls a model or an endpoint. */
  function hasResults() { return !!run?.result_overview && typeof run.result_overview === "object"; }
  function reportPlan() { const p = run?.result_overview?.report_plan; return p && typeof p === "object" && !Array.isArray(p) ? p : null; }
  function synthesis() { const s = run?.result_overview?.synthesis; return s && !s.failed && s.parsed && typeof s.parsed === "object" ? s.parsed : null; }
  function moderatorName() { return arr(run.agents).find(a => a.is_moderator)?.name || arr(run.agents)[0]?.name || ""; }
  // A candidate is named by what it does; 'C1+C3' style labels are resolved by the server (result_digest.candidate_name).
  function candidateName(id) {
    const c = arr(run?.result_overview?.candidates).find(x => x.id === id), name = arr(synthesis()?.candidates).find(x => x.id === id)?.plain_name || c?.name;
    return name ? `${name} (${c ? `${c.author}의 후보 ${c.number}` : recordLabel(id)})` : recordLabel(id);
  }
  function resultReferences(value) {
    // Use the candidate's meaning in the result narrative; full provenance stays on its card.
    return readableReferences(text(value).replace(/\bS\d+A\d+\.C\d+\b/g, id => candidateName(id)));
  }
  function plainField(label, value) { return markdownField(label, Array.isArray(value) ? value.map(v => "- " + resultReferences(v)).join("\n") : resultReferences(value)); }
  function pct(n, total) { return "ds-pct-" + Math.max(0, Math.min(100, Math.round((total ? n / total : 0) * 20) * 5)); }

  function conclusionSection(view, syn) {
    const s = section("결론", "토론이 어떻게 끝났는지, 무엇을 하라는 권고인지입니다."), meta = view.synthesis || {}, positions = arr(view.positions), tally = arr(view.tally), card = node("div", "ds-conclusion-card");
    if (syn) {
      const c = syn.conclusion || {};
      card.append(node("p", "ds-kicker", `총괄 AI 정리 · ${meta.agent || "총괄"}${meta.model ? " (" + meta.model + ")" : ""} · ${String(meta.time || "").slice(0, 16).replace("T", " ")}`));
      card.append(node("h3", "ds-headline", resultReferences(c.headline || "결론 문장이 기록되지 않았습니다")));
      card.append(badge("총괄 AI의 의견 · 다른 AI의 동의나 사실 검증이 아님", "neutral"));
      if (meta.stale) card.append(node("p", "ds-callout", "이전 총괄 요약 · " + (arr(meta.stale_reasons).join(" ") || "기록 또는 요약 입력 방식이 바뀌었습니다.") + " 기존 요약은 보존했습니다. 다시 정리하기 전까지 결론·반박 설명을 원문과 함께 확인하세요."));
      if (c.recommendation) card.append(plainField("무엇을 하라는 권고인가", c.recommendation));
      if (arr(c.candidate_ids).length) card.append(node("p", "ds-muted", "택한 후보 · " + arr(c.candidate_ids).map(candidateName).join(", ")));
      if (c.why) card.append(plainField("왜 이 안인가", c.why));
      if (arr(c.conditions).length) card.append(conditionTable(c.conditions));
      if (c.if_conditions_fail) card.append(plainField("조건이 맞지 않으면", c.if_conditions_fail));
      if (arr(c.not_recommended).length) card.append(plainField("택하지 않은 안", c.not_recommended.map(x => `${x.option}: ${x.why}`)));
      if (arr(c.remaining_risks).length) card.append(plainField("남는 위험", c.remaining_risks));
      if (c.agreement) card.append(plainField("AI들 사이 합의 정도", c.agreement));
      if (arr(c.minority_views).length) card.append(plainField("소수의견", c.minority_views));
    } else {
      const top = tally[0], split = tally.length > 1;
      card.append(node("p", "ds-kicker", "저장 기록으로 정리 · 총괄 AI 정리 전"));
      card.append(node("h3", "ds-headline", top ? `AI ${view.participants}명 중 ${arr(top.names).length}명이 '${candidateName(top.candidate_id)}'을 권고했습니다${split ? " · 의견이 갈렸습니다" : ""}` : positions.length ? "모든 AI가 권고를 보류했습니다" : "최종 판단 단계의 기록이 아직 없습니다"));
      card.append(add(node("p", "ds-callout"), node("strong", "", "'조건부 권고'란? "), node("span", "", "'아래 조건들이 확인되면 이 안을 실행하라'는 뜻입니다. 조건이 확인되지 않으면 실행하지 말라는 뜻이기도 합니다. 각 AI가 단 조건은 아래 'AI별 최종 입장'에 있습니다. 하나의 결론과 쉬운 설명이 필요하면 총괄 AI에게 정리를 맡기세요.")));
    }
    if (Number(view.program_withheld)) card.append(node("p", "ds-muted", `프로그램 검사는 최종 판단 ${view.program_withheld}건을 '보류'로 표시했습니다. AI 결론이 틀렸다는 뜻이 아니라 확정할 기록이 부족하다는 뜻이며, 이유는 맨 아래 '프로그램 검사 상세'에 있습니다.`));
    if (meta.failed) card.append(badge("직전 총괄 정리는 응답 형식이 깨져 읽지 못했습니다 · 다시 정리해 주세요", "amber"));
    if (options.onSynthesize && !run.active && positions.length)
      card.append(add(node("div", "ds-report-links"), button(syn ? "총괄 AI로 다시 정리하기" : "총괄 AI에게 결론·설명 정리 맡기기", () => options.onSynthesize(moderatorName()), "ds-report-button ds-primary-button"),
        node("span", "ds-muted", `${moderatorName() || "총괄 AI"} · AI 호출 1회 · 전송 동의 필요 · 저장 기록만 사용`)));
    s.append(card);
    if (tally.length || positions.length) s.append(voteBars(view, tally));
    return s;
  }
  function conditionTable(conds) {
    const wrap = node("div", "ds-table-wrap"), table = node("table", "ds-data-table ds-cond-table"), head = node("thead"), headrow = node("tr"), body = node("tbody");
    ["권고가 성립하려면", "쉬운 뜻", "무엇을 확인하나"].forEach(label => { const th = node("th", "", label); th.scope = "col"; headrow.append(th); }); head.append(headrow);
    conds.forEach((c, i) => { const tr = node("tr"); tr.append(node("td", "", `${i + 1}. ${readableReferences(c.condition)}`), node("td", "", readableReferences(c.meaning)), node("td", "", readableReferences(c.how_to_check))); body.append(tr); });
    table.append(head, body); wrap.append(table);
    return add(node("div", "ds-field"), node("h4", "", "조건 · 이것이 확인돼야 권고대로 실행합니다"), wrap);
  }
  function voteBars(view, tally) {
    const box = add(node("div", "ds-votes"), node("h4", "", "누가 어떤 후보를 권고했나")), total = Number(view.participants) || 1;
    tally.forEach(t => {
      const bar = node("div", "ds-vote-bar"); bar.append(node("span", "ds-vote-fill " + pct(arr(t.names).length, total)));
      box.append(add(node("div", "ds-vote-row"), add(node("div", "ds-vote-label"), node("strong", "", candidateName(t.candidate_id)), node("span", "ds-muted", excerpt(t.candidate, 140))), bar,
        node("span", "ds-vote-count", `${arr(t.names).length}명 · ${arr(t.names).join(", ")}`)));
    });
    const held = arr(view.positions).filter(p => p.status !== "conditional_recommendation");
    if (held.length) box.append(node("p", "ds-muted", "권고 보류 · " + held.map(p => p.name).join(", ")));
    return box;
  }

  function peopleSection(view, syn) {
    const s = section("AI별 최종 입장", "각 AI가 마지막에 무엇을 권고했고 어떤 조건을 달았는지입니다."), grid = node("div", "ds-people-grid");
    arr(view.people).forEach(p => {
      const card = node("article", "ds-person-card"), f = p.final, sp = arr(syn?.participants).find(x => x.name === p.name);
      add(card, add(node("div", "ds-card-heading"), node("h4", "", p.name), badge(p.moderator ? "총괄" : "토론자", p.moderator ? "teal" : "neutral")), node("p", "ds-model", [p.model, p.effort && "추론 " + p.effort].filter(Boolean).join(" · ")));
      if (f) card.append(add(node("p", "ds-person-pick"), node("span", "", f.status === "conditional_recommendation" ? "조건부 권고 → " : "권고 보류 "), node("strong", "", f.candidate_id ? candidateName(f.candidate_id) : "")));
      else card.append(node("p", "ds-muted", "최종 판단 기록 없음"));
      if (sp?.final_position) card.append(rich(readableReferences(sp.final_position)));
      else if (f?.reason) card.append(node("p", "", excerpt(readableReferences(f.reason), 160)));
      const conds = arr(f?.conditions), blocks = arr(f?.blockers);
      if (conds.length) card.append(add(node("div", "ds-field"), node("h4", "", `이 AI가 단 조건 ${conds.length}개 중 앞의 ${Math.min(2, conds.length)}개`), add(node("ul", "ds-plain-list ds-small"), ...conds.slice(0, 2).map(x => node("li", "", excerpt(readableReferences(x), 100))))));
      const more = add(node("div", ""), conds.length > 2 ? plainField("조건 전체", conds) : null, blocks.length ? plainField("권고를 뒤집을 수 있는 것", blocks) : null);
      if (more.children.length) card.append(detail(`조건 전체 · 권고를 뒤집을 수 있는 것 ${blocks.length}개`, more, "person-more-" + p.owner, false));
      const points = arr(sp?.key_points).length ? sp.key_points : arr(p.claims);
      if (points.length) card.append(detail(`처음 낸 핵심 주장 ${points.length}개`, add(node("ul", "ds-plain-list"), ...points.map(x => node("li", "", readableReferences(x)))), "person-claims-" + p.owner, false));
      if (sp?.changed || p.last_change) card.append(node("p", "ds-muted", "입장 변화 · " + excerpt(readableReferences(sp?.changed || p.last_change), 140)));
      if (arr(p.failed).length) card.append(badge("분석 실패 발언 · " + p.failed.map(recordLabel).join(", "), "amber"));
      grid.append(card);
    });
    s.append(grid); return s;
  }

  function flowSection(view, syn) {
    const s = section("대화 흐름", "단계마다 무엇이 오갔는지입니다. 전체 발언은 '토론 · 반박' 탭에 있습니다."), list = node("ol", "ds-flow"), flow = arr(view.flow), talk = arr(syn?.conversation);
    flow.forEach((f, i) => {
      const stats = [f.claims && `주장 ${f.claims}`, f.challenges && `반박·검토 ${f.challenges}`, f.responses && `응답 ${f.responses} (수용 ${f.accepted})`, f.candidates && `C 후보 ${f.candidates}`].filter(Boolean).join(" · ");
      // Shared words such as '검토' are not stage identities. A partial summary must never land on another stage.
      const stageKey = value => text(value).replace(/\s+/g, "").trim();
      const matches = talk.filter(x => x.stage_id ? x.stage_id === f.stage : stageKey(x.stage) === stageKey(f.title));
      const positional = talk.length === flow.length && talk.every(x => !x.stage_id) ? talk[i] : null;
      const summary = (matches.length === 1 ? matches[0] : matches.length ? null : positional)?.summary || "";
      const lines = add(node("ul", "ds-plain-list ds-small"), ...arr(f.lines).map(x => add(node("li", ""), node("strong", "", x.name + " "), node("span", "", x.failed ? "분석 실패(응답 형식 오류)" : excerpt(readableReferences(x.line), 100)))));
      list.append(add(node("li", "ds-flow-step"), node("span", "ds-flow-num", i + 1),
        add(node("div", "ds-flow-body"), node("strong", "", f.title), stats ? node("p", "ds-muted", stats) : null, summary ? rich(readableReferences(summary)) : null,
          detail("AI별 한 줄", lines, "flow-" + f.stage, !summary))));
    });
    if (!flow.length) list.append(node("li", "ds-muted", "기록된 단계가 없습니다."));
    s.append(list); return s;
  }

  function rebuttalSection(view, syn) {
    const r = view.rebuttals || {}, people = arr(r.people), cells = arr(r.cells);
    const s = section("누가 누구를 반박했나", "가로줄이 검토한 AI, 세로줄이 검토받은 AI입니다. 칸에는 반박(확인 요구 포함) 건수와, 반박받은 AI가 수용·기각·무응답한 수가 있습니다. 색이 진할수록 반박이 많습니다.");
    const wrap = node("div", "ds-table-wrap"), table = node("table", "ds-matrix"), head = node("thead"), headrow = node("tr"), body = node("tbody"), max = Math.max(1, ...cells.map(c => c.challenge + c.unverified));
    headrow.append(node("th", "", "검토한 AI ↓ / 받은 AI →")); people.forEach(p => headrow.append(node("th", "", p.name))); head.append(headrow);
    people.forEach(from => {
      const tr = node("tr"); tr.append(node("th", "", from.name));
      people.forEach(to => {
        const c = cells.find(x => x.from === from.owner && x.to === to.owner), td = node("td");
        if (from.owner === to.owner) { td.className = "ds-cell-self"; td.textContent = "—"; }
        else if (!c) { td.className = "ds-cell-empty"; td.textContent = "없음"; }
        else {
          const n = c.challenge + c.unverified; td.className = "ds-heat-" + (n ? Math.max(1, Math.ceil(n / max * 4)) : 0);
          add(td, node("strong", "", `반박 ${n}`), node("span", "", `수용 ${c.accepted} · 기각 ${c.rejected} · 무응답 ${c.unanswered}`), node("span", "ds-muted", `지지 ${c.supports}`));
        }
        tr.append(td);
      });
      body.append(tr);
    });
    table.append(head, body); wrap.append(table); s.append(wrap);
    const skipped = r.skipped || {};
    if (skipped.self || skipped.unknown) s.append(node("p", "ds-muted", `표에서 뺀 검토 · 자기 주장 검토 ${skipped.self || 0}건 · 대상 ID가 없는 검토 ${skipped.unknown || 0}건 (AI의 기록 형식 문제)`));
    const list = add(node("div", "ds-record-stack"), node("h4", "", syn && arr(syn.rebuttals).length ? "결론에 영향을 준 반박 · 총괄 AI 정리" : "핵심 반박 · 저장 기록"));
    const rows = syn && arr(syn.rebuttals).length ? syn.rebuttals.map(x => arrowRow(x.from, x.to, x.point, x.outcome))
      : arr(r.highlights).map(h => arrowRow(h.from_name, h.to_name, `${h.kind} · ${h.point}`, `${h.answer}${h.answer_reason ? " · " + excerpt(h.answer_reason, 120) : ""}`));
    rows.slice(0, 5).forEach(row => list.append(row));
    if (rows.length > 5) list.append(detail(`나머지 ${rows.length - 5}건 더 보기`, add(node("div", "ds-record-stack"), ...rows.slice(5)), "rebuttal-more", false));
    if (!(syn && arr(syn.rebuttals).length) && r.more_highlights) list.append(node("p", "ds-muted", `그 밖의 핵심 반박 ${r.more_highlights}건은 '토론 · 반박' 탭에 있습니다.`));
    s.append(list); return s;
  }
  function arrowRow(from, to, point, outcome) {
    return add(node("div", "ds-arrow-row"), add(node("div", "ds-arrow-who"), node("strong", "", from || "?"), node("span", "ds-arrow", "→"), node("strong", "", to || "?")),
      add(node("div", "ds-arrow-what"), node("p", "", readableReferences(point || "")), outcome ? node("p", "ds-muted", "결과 · " + readableReferences(outcome)) : null));
  }

  function candidateSection(view, syn) {
    const s = section("C 후보 한눈에", "각 AI가 낸 대안 C 후보입니다. 'C1+C3' 같은 결합 후보는 무엇을 합쳤는지 함께 보여 줍니다. 초록 테두리는 최종 단계에서 누군가 권고한 후보입니다."), cands = arr(view.candidates);
    [...new Set(cands.map(c => c.author))].forEach(author => {
      const mine = cands.filter(c => c.author === author), group = add(node("div", "ds-cand-group"), node("h4", "", `${author}의 후보 ${mine.length}개`)), grid = node("div", "ds-cand-grid");
      mine.forEach(c => {
        const sc = arr(syn?.candidates).find(x => x.id === c.id), picked = arr(c.supporters).length, card = node("article", "ds-cand-card" + (picked ? " is-picked" : ""));
        add(card, add(node("div", "ds-card-heading"), node("h5", "", `${c.number}. ${sc?.plain_name || c.name || "이름 없음"}`), picked ? badge("권고 · " + c.supporters.join(", "), "teal") : null));
        card.append(node("p", "", excerpt(readableReferences(sc?.what || c.summary), 130)));
        const staleCombination = !!view.synthesis?.stale, showCombination = sc?.combines && !staleCombination;
        if (showCombination) card.append(node("p", "ds-muted", "결합 · " + resultReferences(sc.combines)));
        if (staleCombination) card.append(node("p", "ds-muted", arr(c.combines).length ? "원문에 명시한 구성요소 · " + c.combines.map(p => p.text || recordLabel(p.id)).join(" / ") : arr(c.source_combines).length ? "원문에 결합 참조가 있지만 구성요소를 찾지 못했습니다. 아래 원문 설명을 확인하세요." : "원문에 명시한 결합 구성요소 없음 · 결합 가능성은 아래 원문 설명을 확인하세요."));
        const more = add(node("div", ""), !showCombination && arr(c.combines).length ? add(node("div", "ds-small"), node("strong", "", "원문에 명시한 후보·아이디어"), add(node("ul", "ds-plain-list ds-small"), ...c.combines.map(p => node("li", "", `${recordLabel(p.id)} = ${p.text}`)))) : null,
          c.combination_reason ? plainField("원문의 결합·비교 설명", c.combination_reason) : null,
          staleCombination && sc?.combines ? detail("이전 총괄의 결합 설명 · 재확인 필요", node("p", "", resultReferences(sc.combines)), "old-combination-" + c.id, false) : null,
          c.mechanism ? plainField("실행 장치", c.mechanism) : null, c.a_downside ? plainField("A안의 어떤 단점을 없애나", c.a_downside) : null,
          c.b_downside ? plainField("B안의 어떤 단점을 없애나", c.b_downside) : null, c.residual_risk ? plainField("남는 위험", c.residual_risk) : null);
        if (more.children.length) card.append(detail(arr(c.combines).length && !showCombination ? `자세히 · 명시한 구성요소 ${c.combines.length}개` : "자세히", more, "cand-" + c.id, false));
        card.append(node("p", "ds-muted ds-id", recordLabel(c.id)));
        grid.append(card);
      });
      group.append(grid); s.append(group);
    });
    if (!cands.length) s.append(empty("C 후보 기록이 없습니다."));
    return s;
  }

  function hallucinationSection(view, syn) {
    const s1 = view.step1 || {}, findings = arr(view.findings);
    const s = section("환각·오류 후보", "AI가 기준서나 과제 사실을 잘못 말했다고 지적된 문장입니다. 색은 프로그램이 확인한 정도이고, 오류 확정은 학생이 합니다. 줄을 누르면 설명이 펼쳐집니다.");
    if (view.submitted_audit) s.append(node("p", "ds-callout", "이 목록은 토론 참가자의 발언에서 발견된 오류 후보입니다. 직접 입력한 의심 답변의 검증 결과는 위에 별도로 표시하며, 아래 건수에 중복 합산하지 않습니다."));
    s.append(add(node("div", "ds-kind-counts"), badge(view.submitted_audit ? `토론 중 STEP 1 오류 후보 ${s1.count || 0}건` : `과제 STEP 1 관련 ${s1.count || 0}건 · 기준 3건 이상`, "neutral"), badge(`🔴 AI 교차 확인 ${s1.ai_confirmed || 0}`, "red"), badge(`🟠 의심 ${s1.suspected || 0}`, "amber"),
      badge(`학생 확인 오류 ${s1.student_confirmed || 0} · 교정 메모 ${s1.corrected || 0}`, "red")));
    s.append(node("p", "ds-muted", "🔴 AI 교차 확인 = 인용이 실제 답변과 맞고, 지적받은 AI가 그 지적을 인정했거나 다른 AI도 같은 문장을 지적함 · 🟠 의심 = 원문 대조가 더 필요함 · ⚪ = 인용 불일치 또는 학생이 오류 아님으로 판정"));
    const block = (title, list) => { const box = add(node("div", "ds-halluc-list"), node("h4", "", title)); list.forEach((f, i) => box.append(hallucinationRow(f, i + 1, syn))); if (!list.length) box.append(node("p", "ds-muted", "없음 · 건수를 채우려고 만들지 않습니다.")); return box; };
    s.append(block("과제 STEP 1 관련 · 4대 회계처리 합법성 답변", findings.filter(f => f.step1)));
    const others = findings.filter(f => !f.step1);
    if (others.length) s.append(detail(`그 밖의 단계에서 지적된 오류 후보 ${others.length}건`, block("그 밖의 단계", others), "halluc-others", false));
    return s;
  }
  function hallucinationRow(f, n, syn) {
    const plain = arr(syn?.hallucinations).find(x => x.key === f.key)?.plain, first = arr(f.reports)[0] || {};
    const row = node("details", "ds-halluc ds-halluc-" + (f.tone || "neutral")), summary = node("summary", "");
    add(summary, node("span", "ds-dot"), node("span", "ds-halluc-who", `${n}. ${f.target_name || "AI"}`), node("span", "ds-halluc-what", `“${excerpt(f.quote, 80)}”`), badge(f.label, f.tone));
    row.append(summary);
    row.append(add(node("div", "ds-halluc-body"), plain ? plainField("쉬운 설명 · 총괄 AI", plain) : null,
      plainField(`왜 틀렸다고 보나 · ${arr(f.signals?.reviewers).join(", ") || "검토 AI"}`, first.error),
      text(first.improved_answer).trim() ? plainField("바른 내용 · 교정 후보", first.improved_answer) : null,
      detail("근거 원문 · 응답 · 판정 버튼", findingCard(f), "halluc-card-" + f.key, false)));
    return row;
  }

  function programChecks(view) {
    const box = node("div", "ds-record-stack"), w = view.withheld || {}, format = node("ul", "ds-plain-list"), content = node("ul", "ds-plain-list");
    arr(w.failed_answers).forEach(f => format.append(node("li", "", `분석 실패: ${f.turn} ${f.name} (${f.stage_title}) · 응답은 받았지만 구조화된 분석이 없음`)));
    if (Number(w.invalid_total)) format.append(node("li", "", `검토로 인정되지 않은 기록 ${w.invalid_total}건: ` + Object.entries(w.invalid_reviews || {}).map(([k, n]) => `${problemLabels[k] || k} ${n}건`).join(" · ")));
    if (Number(w.unlinked_responses)) format.append(node("li", "", `위 기록에 딸린 응답 ${w.unlinked_responses}건(알 수 없는 반박 참조)`));
    if (Number(w.missing_total)) format.append(node("li", "", `그 결과 교차 검토 누락 ${w.missing_total}건: ` + Object.entries(w.missing_reviews || {}).map(([k, n]) => `${k} ${n}건`).join(" · ")));
    if (Number(w.final_review_issues)) format.append(node("li", "", `검토 기록 보완 필요 ${w.final_review_issues}건 (최종 검토의 대상·근거·판정 기록 형식 · 새 내용 오류가 아님)`));
    arr(w.critical).forEach(c => content.append(node("li", "", `미해결 핵심 반박 ${recordLabel(c.challenge_id)} → ${recordLabel(c.target)} · ${excerpt(c.reason, 220)}`)));
    arr(view.program_reasons).forEach(r => content.append(node("li", "", `${r.reason}${r.explain ? " · " + r.explain : ""} (${arr(r.names).join(", ")})`)));
    add(box, node("h5", "", `기록 형식 문제 · AI가 기록 규칙을 지키지 않은 것(내용의 옳고 그름과 별개 · 인용 검사 규칙 ${w.quote_rule || 1})`), format.children.length ? format : node("p", "ds-muted", "없음"),
      node("h5", "", "내용상 남은 문제"), content.children.length ? content : node("p", "ds-muted", "없음"));
    if (view.recheck && typeof view.recheck === "object") box.append(recheckBlock(view.recheck));
    const req = view.requirements || {}, gaps = node("ul", "ds-plain-list");
    arr(req.gaps).forEach(g => gaps.append(node("li", "", `${g.id} ${g.title} · ${requirementLabels[g.status] || g.status}${g.note ? " · " + excerpt(g.note, 200) : ""}`)));
    add(box, node("h5", "", "과제 요건 기록"), node("p", "", `요건 ${req.total || 0}개 · ` + Object.entries(req.counts || {}).map(([k, n]) => `${requirementLabels[k] || k} ${n}`).join(" · ") + " · 기록의 존재·연결 검사이며 점수가 아님"), gaps.children.length ? gaps : null);
    const steps = node("ol", "ds-next-steps"); arr(view.next_steps).forEach(x => steps.append(node("li", "", readableReferences(x))));
    add(box, node("h5", "", "다음에 할 일"), steps);
    return detail("프로그램 검사 상세 · 보류 이유 · 재검사 · 과제 요건 · 다음에 할 일", box, "result-checks", false);
  }

  function results() {
    const container = node("div", "ds-pane ds-results"), view = run.result_overview;
    if (!hasResults()) { container.append(empty("결과 정리가 없는 기록입니다.", "버전 3 연구 실행에서 결과 탭을 볼 수 있습니다.")); return container; }
    if (view.error) { container.append(empty(view.error)); return container; }
    if (reportPlan()) container.append(reportShortcut(reportPlan()));
    const syn = synthesis();
    const hasSubmitted = arr(view.submitted_audit?.cases).length > 0;
    const incidentalAudit = hallucinationSection(view, syn);
    add(container, conclusionSection(view, syn), submittedAuditSection(), peopleSection(view, syn), flowSection(view, syn), rebuttalSection(view, syn), candidateSection(view, syn), hasSubmitted ? detail("토론 중 발견한 오류 · 보조 이력", incidentalAudit, "incidental-result-audit") : incidentalAudit, programChecks(view));
    if (run.result_document) container.append(add(node("div", "ds-report-links"), reportButton("00_결과_요약.md", "결과 요약 문서(Markdown) 열기")));
    return container;
  }

  function reportShortcut(plan) {
    const chosen = !!plan.decision?.candidate_id && plan.decision.selection_valid !== false, generated = plan.mode === "generated";
    return add(node("div", "ds-report-shortcut"), add(node("div", ""), node("strong", "", chosen ? "총괄 권고안 → SECTION 1~5 작성안" : "저장된 토론 → SECTION 1~5 작성 자료"),
      node("p", "ds-muted", generated ? "선택 이유, 실행 조건, 섹션별 작성 요점과 근거를 한곳에서 확인합니다." : "기존 총괄 권고와 분석 기록을 제출 목차에 맞춰 확인합니다.")),
      button("보고서 작성안 보기", () => nextTab("report"), "ds-report-button ds-primary-button"));
  }
  function reportList(label, values, cls = "") {
    const items = arr(values).filter(x => x !== null && x !== undefined && text(x).trim());
    return items.length ? add(node("div", "ds-field " + cls), node("h4", "", label), add(node("ul", "ds-plain-list"), ...items.map(x => node("li", "", resultReferences(x))))) : null;
  }
  function reportEvidence(items, key) {
    const evidence = arr(items).filter(x => x && typeof x === "object"), list = node("div", "ds-report-evidence-list");
    evidence.forEach(e => {
      const rawId = text(e.id), turnId = text(e.turn) || rawId.match(/^S\d+A\d+/)?.[0], turn = arr(run.turns).find(t => t.id === turnId);
      const heading = node("strong", "", e.label || recordLabel(rawId)); heading.title = `근거 기록 ID: ${rawId}`;
      const card = add(node("article", "ds-report-evidence"), heading, e.kind ? badge(({ ...kinds, claim: "AI 주장", candidate: "대안 후보", challenge: "검토·반박", response: "반박 응답", audit: "오류 검토", correction: "교정 기록" })[e.kind] || e.kind, "neutral") : null);
      if (e.status) card.append(node("p", "ds-report-evidence-status", text(e.status)));
      if (e.text) card.append(rich(resultReferences(e.text)));
      if (e.source) card.append(node("p", "ds-muted", "기록에 적힌 출처 · " + text(e.source)));
      if (turn && options.onOpenTurn) card.append(button(`${turn.name || "AI"}의 ${turn.stage_title || "해당 단계"} 발언 원문`, () => options.onOpenTurn(turn.id)));
      list.append(card);
    });
    return evidence.length ? detail(`연결된 근거 ${evidence.length}개 · 저장된 AI 기록`, add(node("div", ""), node("p", "ds-muted", "아래는 실제 저장된 기록입니다. 연결되어 있다는 사실이 외부 원문 검증이나 주장의 참을 뜻하지는 않습니다."), list), "report-evidence-" + key, false) : node("p", "ds-muted", "이 섹션에 연결된 근거가 없습니다. 확인된 내용처럼 쓰지 마세요.");
  }
  function reportConditions(conditions) {
    const rows = arr(conditions).filter(c => c && typeof c === "object");
    if (!rows.length) return node("p", "ds-muted", "실행 조건이 기록되지 않았습니다. 실행 준비가 끝났다는 뜻은 아닙니다.");
    const head = node("tr"), body = node("tbody"), table = node("table", "ds-data-table ds-report-conditions"), hasRowResponse = rows.some(c => text(c.if_fail).trim());
    ["실행 전에 확인할 것", "확인 방법", ...(hasRowResponse ? ["이 조건을 충족하지 못하면"] : [])].forEach(label => { const th = node("th", "", label); th.scope = "col"; head.append(th); });
    rows.forEach(c => {
      const row = add(node("tr", ""), ...[c.condition, c.check].map(v => node("td", "", resultReferences(v || "기록 없음 · 보완 필요"))));
      if (hasRowResponse) row.append(node("td", "", text(c.if_fail).trim() ? resultReferences(c.if_fail) : "—"));
      body.append(row);
    });
    table.append(add(node("thead", ""), head), body); return add(node("div", "ds-table-wrap"), table);
  }
  function report() {
    const container = node("div", "ds-pane ds-report-plan"), plan = reportPlan();
    if (!plan) { container.append(empty("작성 자료가 아직 없습니다.", "연구 기록을 선택하면 기존 토론 결과를 SECTION 1~5에 연결해 확인할 수 있습니다.")); return container; }
    const decision = plan.decision && typeof plan.decision === "object" ? plan.decision : {}, generated = plan.mode === "generated", chosen = !!decision.candidate_id && decision.selection_valid !== false;
    const invalidChoice = !!decision.candidate_id && decision.selection_valid === false;
    const stale = plan.status === "stale", issues = arr(plan.issues), sections = arr(plan.sections).filter(s => s && typeof s === "object").sort((a, b) => Number(a.number) - Number(b.number));
    const header = section("보고서 작성안", "STEP은 분석 순서, SECTION은 제출 순서입니다. 기존 토론을 목차에 맞춰 재배열하며, 최종 문장은 학생이 확인하고 직접 작성합니다.");
    const states = node("div", "ds-state-grid");
    [["권고안 선택", chosen ? "총괄이 C안 1개 선택" : invalidChoice ? "권고 후보 연결 재확인 필요" : "총괄의 단일 권고 미기록", "선택 근거와 소수의견을 함께 보존"],
      ["실행 준비", "실행 조건 확인 필요", "권고 선택과 실제 실행 승인은 별개"],
      ["작성 자료", stale ? "이전 기록 기준 · 재확인 필요" : plan.status === "needs_review" ? "작성안 검토 필요" : generated ? "총괄 작성안 생성됨" : "저장 기록에서 구성", generated ? "총괄의 작성 보조안 · 제출 전 확인" : "새로운 AI 판정 없이 읽기 가능"]].forEach(([label, value, note]) => states.append(add(node("div", "ds-state"), node("span", "", label), node("strong", "", value), node("p", "", note))));
    header.append(states); container.append(header);
    if (stale) container.append(add(node("div", "ds-report-notice"), node("strong", "", "기존 작성안을 보존했습니다"), node("p", "", "입력 기록 또는 작성 방식이 달라졌습니다. 아래 권고·근거를 다시 확인한 뒤 사용하세요.")));
    if (issues.length) container.append(detail(`확인할 항목 ${issues.length}개`, reportList("작성 전 확인", issues), "report-issues", false));
    const hero = node("article", "ds-conclusion-card ds-report-decision");
    hero.append(node("p", "ds-kicker", generated ? "총괄 최종 권고 · 보고서 작성 보조안" : "기존 총괄 권고로 구성한 작성 자료"));
    hero.append(node("h3", "ds-headline", chosen ? resultReferences(decision.name || candidateName(decision.candidate_id)) : invalidChoice ? "권고가 실제 후보와 연결되지 않았습니다 · 확인 필요" : "총괄이 선택한 하나의 권고안이 아직 없습니다"));
    hero.append(badge("총괄의 판단 · 전원 합의를 뜻하지 않음", "neutral"));
    if (decision.recommendation) hero.append(plainField(invalidChoice ? "기존 권고 문장 · 후보 연결 재확인 필요" : "보고서에서 권고할 행동", decision.recommendation));
    if (decision.why) hero.append(plainField("이 안을 선택한 이유", decision.why));
    const other = arr(decision.alternatives).filter(x => x && typeof x === "object");
    if (other.length) hero.append(detail("다른 안을 선택하지 않은 이유", add(node("ul", "ds-plain-list"), ...other.map(x => add(node("li", ""), node("strong", "", x.candidate_id ? candidateName(x.candidate_id) : "비교안"), node("span", "", " · " + resultReferences(x.why_not))))), "report-alternatives", false));
    const minority = reportList("남긴 반대 의견", decision.minority_views);
    if (minority) hero.append(detail("소수의견 · 선택해도 남는 이견", minority, "report-minority", false));
    const refs = arr(decision.evidence_ids), allEvidence = sections.flatMap(s => arr(s.evidence)).filter(e => e && refs.includes(e.id));
    if (allEvidence.length) hero.append(reportEvidence([...new Map(allEvidence.map(e => [e.id, e])).values()], "decision"));
    if (options.onReportPlan && !run.active && (arr(run.result_overview?.positions).length || chosen)) hero.append(add(node("div", "ds-report-links"),
      button(generated ? "총괄 권고·작성안 다시 정리" : "총괄 권고 1개·SECTION 작성안 생성", () => options.onReportPlan(moderatorName()), "ds-report-button ds-primary-button"),
      node("span", "ds-muted", `${moderatorName() || "총괄 AI"} · 저장된 토론으로 AI 호출 1회 · 새 토론 없음`)));
    if (run.active) hero.append(node("p", "ds-muted", "현재 실행이 끝난 뒤 총괄 작성안을 만들 수 있습니다."));
    container.append(hero);
    const execution = section("선택한 안을 어떻게 실행하나", "무엇을 권고할지는 위에서 정하고, 실행 전에 확인할 내용은 여기서 따로 관리합니다.");
    execution.append(reportList("지금 할 일", decision.now) || node("p", "ds-muted", "즉시 실행 순서는 별도로 정리되지 않았습니다. " + (decision.recommendation ? "위 권고 행동과 아래 확인 조건을 참고하세요." : "아래 확인 조건과 연결된 기록을 참고하세요.")), reportConditions(decision.conditions));
    if (decision.if_conditions_fail) execution.append(plainField("조건을 충족하지 못할 때의 공통 대응", decision.if_conditions_fail));
    container.append(execution);
    const writing = section("SECTION 1~5 · 제출 목차에 배치", "SECTION 1만 펼쳐 두었습니다. 다른 섹션 제목을 누르면 작성 요점과 연결된 근거가 열립니다. 본문 A4 4페이지 이내, 상세 근거는 부록에 배치합니다.");
    sections.forEach(s => {
      const body = node("div", "ds-report-section-body"), mapping = arr(s.steps).map(step => /^STEP\b/i.test(text(step)) ? text(step) : "STEP " + text(step)).join(" · ");
      body.append(node("p", "ds-report-step", `${mapping || "분석 단계 연결 미기록"} → SECTION ${s.number}`));
      if (s.purpose) body.append(plainField("이 섹션이 답할 내용", s.purpose));
      body.append(reportList(generated ? "작성할 핵심 요점" : "저장 기록의 핵심 발췌", s.points) || node("p", "ds-muted", "작성 요점이 없습니다. 아래 기록을 확인해 보완하세요."));
      const caution = add(node("div", "ds-report-cautions"), reportList("가정으로 밝혀야 할 내용", s.assumptions), reportList("미확인 · 학생 확인 필요", s.unknowns));
      if (caution.children.length) body.append(caution);
      body.append(reportEvidence(s.evidence, s.number));
      const appendixNames = arr(s.appendix_ids).map(id => arr(plan.appendices).find(a => a?.id === id)?.title || text(id));
      if (appendixNames.length) body.append(node("p", "ds-muted", "연결할 부록 · " + appendixNames.join(" / ")));
      const item = detail(`SECTION ${s.number}. ${s.title || "제목 미기록"}`, body, "report-section-" + s.number, Number(s.number) === 1); item.classList.add("ds-report-section"); writing.append(item);
    });
    if (!sections.length) writing.append(empty("섹션별 작성 자료가 아직 없습니다.", "새 토론 없이 총괄 작성안을 생성할 수 있습니다."));
    container.append(writing);
    const appendices = arr(plan.appendices).filter(a => a && typeof a === "object");
    if (appendices.length) container.append(detail(`부록 배치 · ${appendices.length}개 묶음`, add(node("div", "ds-report-appendices"), ...appendices.map(a => {
      const card = add(node("article", "ds-report-appendix"), node("h4", "", a.title || "부록"));
      const ids = arr(a.record_ids); if (ids.length) card.append(add(node("ul", "ds-plain-list"), ...ids.map(id => {
        const turnId = text(id).match(/^S\d+A\d+/)?.[0], turn = arr(run.turns).find(t => t.id === turnId);
        return add(node("li", ""), recordReference(id), turn && options.onOpenTurn ? button("발언 원문", () => options.onOpenTurn(turn.id)) : null);
      }))); else card.append(node("p", "ds-muted", "연결된 기록 없음 · 확인 후 추가"));
      return card;
    })), "report-appendices", false));
    if (options.onOpenReport) container.append(add(node("div", "ds-report-links"), reportButton("report_writing_plan.md", "보고서 작성 자료 문서 열기")));
    return container;
  }

  function turnCard(turn, expand) {
    const card = node("article", "ds-turn-card"), p = parsed(turn), body = node("div", "ds-turn-body");
    add(card, add(node("div", "ds-card-heading"), node("h4", "", turn.name || "참가자"), badge(turn.stage_title || "단계 미기록")), linkSource(turn));
    if (turn.model) card.append(node("p", "ds-model", turn.model + (turn.effort ? " · 추론 " + turn.effort : "")));
    if (protocolV3()) {
      card.append(badge(decisionLabel(turn), turn.protocol_checks?.decision_status === "withheld" ? "amber" : "neutral"));
      arr(turn.protocol_checks?.warnings).concat(arr(turn.protocol_checks?.reasons)).forEach(reason => card.append(node("p", "ds-muted", reason)));
    }
    if (p.conclusion) card.append(markdownField(phaseOf(turn) === "consensus" ? "이 참가자의 최종 검토 결론" : "이 발언의 잠정 결론", p.conclusion));
    if (analysis(turn)) body.append(rich(analysis(turn)));
    else body.append(empty("분석 본문이 별도로 분류되지 않았습니다.", "아래 발언 원문에서 전체 응답을 확인할 수 있습니다."));
    if (p.position_change) body.append(markdownField("입장 변화 기록", p.position_change));
    if (p.provisional_position) body.append(markdownField("잠정 입장 · 변경 조건", p.provisional_position));
    if (arr(p.candidate_seeds).length) {
      const seeds = node("div", "ds-record-stack");
      arr(p.candidate_seeds).filter(seed => seed && typeof seed === "object").forEach(seed => seeds.append(add(node("article", "ds-mini-record"), badge("미평가 아이디어"), node("h4", "", seed.id), rich(seed.idea), markdownField("확인할 가정", seed.assumptions))));
      body.append(detail("미평가 후보 · 선정 전", seeds, "seeds-" + turn.id));
    }
    arr(p.candidates).filter(candidate => candidate && typeof candidate === "object").forEach(candidate => {
      const c = add(node("article", "ds-mini-record"), badge("후보 · 잠정 비교"), recordReference(candidate.id, "h4"), rich(candidate.proposal));
      for (const [key, label] of [["a_downside", "A의 단점 · 없앨 것"], ["b_downside", "B의 단점 · 없앨 것"], ["mechanism", "단점을 없애는 실행 장치"], ["residual_risk", "남는 비용·위험"], ["difference", "A/B와 다른 점"], ["issue_ids", "해결할 쟁점"], ["cost", "비용·산식·가정"], ["feasibility", "실행·책임·일정"], ["ethics", "윤리성"], ["delay_risk", "일정 위험"], ["combines", "결합한 원래 후보"], ["combination_reason", "결합·비교 이유"], ["limitations", "한계"]]) if (candidate[key]) c.append(markdownField(label, ["issue_ids", "combines"].includes(key) ? readableReferences(candidate[key]) : candidate[key]));
      if (candidate.removal_status) c.append(markdownField("단점 해소 입증 상태 · 모델 보고", ({ goal: "목표 단계 · 입증 전", partially_supported: "일부 입증", supported: "근거로 입증했다고 보고" })[candidate.removal_status] || candidate.removal_status));
      body.append(c);
    });
    arr(p.student_feedback).filter(f => f && typeof f === "object").forEach(f => body.append(add(node("article", "ds-mini-record"), badge("내 첫 생각에 대한 맹점 비판"), node("h4", "", f.id || "맹점"), markdownField("학생 초안 인용", f.quote), markdownField("맹점", f.blind_spot), markdownField("결론에 미치는 영향", f.why), markdownField("근거", f.evidence), markdownField("스스로 점검할 질문", f.question))));
    if (p.report_plan && typeof p.report_plan === "object" && !Array.isArray(p.report_plan) && Object.keys(p.report_plan).length) body.append(markdownField("잠정 보고서 계획 · AI 제안이며 완성 문장 아님", p.report_plan));
    arr(p.ethics_assessment).filter(e => e && typeof e === "object").forEach(e => {
      const c = add(node("article", "ds-mini-record"), badge("윤리 3관점 통합 검토"), e.candidate_id ? recordReference(e.candidate_id, "h4") : node("h4", "", "후보 미기록"));
      for (const [key, label] of [["utilitarian", "공리주의 · 결과·장기 효용"], ["deontological", "의무론 · 의도·의무·방법"], ["communitarian", "공동체주의 · 신뢰"], ["minority_burden", "소수의 부담"], ["conflicts", "관점 충돌과 조정"], ["why_fraud_fails", "분식이 탈락하는 이유"]]) if (e[key]) c.append(markdownField(label, e[key]));
      body.append(c);
    });
    arr(p.legality_checks).filter(c => c && typeof c === "object").forEach(c => body.append(add(node("article", "ds-mini-record"), badge(legalityLabels[c.judgment] || "판단 미기록", c.judgment === "undetermined" ? "amber" : "neutral"),
      node("h4", "", `${c.id || "최초 질의"} · ${c.item || "항목 미기록"}`), markdownField("중립 질문", c.question), markdownField("판단 근거 · 모델 보고", c.basis), markdownField("모르는 사실·관할·시점", c.uncertainty),
      node("p", "ds-muted", "AI의 최초 판단입니다. 맞고 틀림은 교차 검증과 기준서 원문 대조로 확인합니다."))));
    const notes = arr(p.requirement_notes).filter(n => n && typeof n === "object");
    if (notes.length) body.append(detail("이 발언이 처리했다고 보고한 과제 요건 · " + notes.length + "건", add(node("div", "ds-record-stack"), ...notes.map(n => add(node("article", "ds-mini-record"),
      badge(({ addressed: "처리했다고 보고", partial: "일부 처리 보고", not_applicable: "해당 없음 보고" })[n.status] || "상태 미기록", "neutral"), node("h4", "", n.requirement_id || "요건 미기록"),
      markdownField("근거 주장 ID", arr(n.claim_ids).join(", ")), markdownField("처리 내용·사유", n.reason)))), "notes-" + turn.id));
    if (p.decision) {
      if (p.decision.candidate_id) body.append(add(node("div", "ds-field"), node("h4", "", "권고 후보"), recordReference(p.decision.candidate_id)));
      body.append(detail("모델의 판단 원기록 · 내부 참조 ID 포함", markdownField("판단 원기록 · 검토 상태는 위 배지 참조", p.decision), "decision-raw-" + turn.id));
    }
    if (arr(p.agreements).length) body.append(markdownField("이 참가자가 명시한 동의 항목", p.agreements));
    if (arr(p.dissent).length) body.append(markdownField("이 참가자가 명시한 이견", p.dissent));
    if (arr(p.unresolved).length) body.append(markdownField("남은 쟁점 · 소수의견 기록", p.unresolved));
    if (arr(p.proposals).length) {
      const proposals = section("이 발언의 제안과 판단"); arr(p.proposals).filter(Boolean).forEach(x => proposals.append(add(node("div", "ds-mini-record"), badge(protocolV3() ? decisionLabel(turn) : x.decision || "판단 미기록"), rich(x.proposal || x), x.reason ? markdownField("근거", x.reason) : null))); body.append(proposals);
    }
    card.append(detail("분석 · 입장 변화 · 세부 내용", body, "turn-" + turn.id, expand));
    if (turn.answer) card.append(detail("전체 발언 원문 보기", rich(turn.answer), "raw-" + turn.id));
    if (turn.delivery && typeof turn.delivery === "object" && !Array.isArray(turn.delivery)) card.append(deliveryDetail(turn));
    if (turn.prompt) card.append(detail("이 발언에 전달된 원질문 보기", rich(turn.prompt), "prompt-" + turn.id));
    return card;
  }
  /* What the call actually received, from the saved manifest. Missing required sources are shown, never filled in. */
  function deliveryDetail(turn) {
    const d = turn.delivery, units = arr(d.units), lectures = arr(d.lectures), omitted = arr(d.omitted).filter(o => o && typeof o === "object"), limited = omitted.filter(o => o.reason === "입력 한도");
    const aux = d.auxiliary_lines && typeof d.auxiliary_lines === "object" ? Object.entries(d.auxiliary_lines).map(([name, count]) => `${name} ${count}행`) : [];
    const shared = d.shared_record && typeof d.shared_record === "object" && !Array.isArray(d.shared_record) ? d.shared_record : null;
    const sharedOmitted = shared && shared.omitted && typeof shared.omitted === "object" ? Object.entries(shared.omitted).map(([label, count]) => `${label} ${count}건`) : [];
    const box = add(node("div", "ds-record-stack"), limited.length ? badge(`필수 근거 ${limited.length}개 미전달 · 입력 한도`, "amber") : null,
      markdownField("과제 원문", d.case_file || "", "전달하지 못함"), markdownField(`기준서 문단 원문 ${units.length}개 · 선택 자료 그대로, 자르지 않음`, units.join(", "), "없음"),
      arr(d.abridged).length ? markdownField("그중 생략 표시가 있는 발췌 문단 · 원 기준서의 일부 하위 항목만 포함", arr(d.abridged).join(", ")) : null,
      markdownField(`강의 원문 범위 ${lectures.length}개 · 범위 전체`, lectures.join(", "), "없음"), markdownField("보조 발췌 · 비연속 행", aux.join(", "), "없음"),
      omitted.length ? markdownField("전달하지 못한 필수 근거", omitted.map(o => `${o.id || "미기록"} (${o.reason || "사유 미기록"})`).join(", ")) : null,
      d.stretched ? markdownField("질문 한도 확장", `필수 기록과 원문 자료를 함께 넣기 위해 이 발언만 ${Number(d.prompt_budget || 0).toLocaleString()}바이트까지 늘렸습니다(평소 105,000바이트).`) : null,
      shared ? markdownField(`역할별 공유 기록 · ${Number(shared.bytes || 0).toLocaleString()}바이트 · 원문 ${arr(shared.full).length}건 · 축약 ${arr(shared.abridged).length}건`,
        sharedOmitted.length ? "생략: " + sharedOmitted.join(", ") : "", "생략한 기록 없음") : null,
      node("p", "ds-muted", "실행할 때 실제 질문에 넣은 자료 목록입니다. 보조 발췌에 없는 행과 전달하지 못한 근거는 이 발언에서 확인되지 않은 내용입니다."));
    return detail(`이 발언에 실제 전달된 근거 · 기준서 ${units.length}개 · 강의 ${lectures.length}개${limited.length ? " · 미전달 " + limited.length + "개" : ""}`, box, "delivery-" + turn.id);
  }
  function timeline() {
    const timeline = node("ol", "ds-timeline"), count = participants().length;
    phases().forEach((phase, index) => {
      const done = completedSlots(phase[0]), isLive = run.live && phaseOf(run.live) === phase[0], complete = count > 0 && done >= count;
      const item = node("li", "ds-stage " + (complete ? "is-complete" : done || isLive ? "is-partial" : "is-pending"));
      add(item, node("span", "ds-stage-number", index + 1), add(node("div", "ds-stage-copy"), node("strong", "", phase[1]), node("p", "", phase[2])), add(node("div", "ds-stage-status"), badge(complete ? "단계 발언 수신 완료" : isLive ? "응답 수신 중 · 단계 미완료" : done ? "단계 미완료" : "아직 진행하지 않음", complete ? "teal" : done || isLive ? "amber" : "neutral"), node("span", "", done + " / " + count + "명 응답")));
      timeline.append(item);
    }); return timeline;
  }
  function reviewPanel() {
    const review = run.review_state || {}, panel = section("검토 상태 · 실행 진행과 별도", "구조·인용·응답 연결 검사입니다. 사실의 진위나 반박의 타당성을 독립 검증한 결과가 아닙니다.");
    const reviewLabel = ({ gathering: "검토 자료 수집 중", needs_review: "최종 권고 보류 · 추가 검토 필요", conditional: "조건부 권고 기록 · 원문 검증 별도" })[review.status] || "검토 상태 미기록";
    if (planned()) panel.append(stateGrid(review, reviewLabel));
    panel.append(badge(reviewLabel, review.status === "needs_review" ? "amber" : "neutral"));
    panel.append(node("p", "", `교차 검토 ${Number(review.recorded_reviews) || 0} / ${Number(review.expected_reviews) || 0}건 · 핵심 반박 미해결 ${Number(review.critical_pending_count) || 0}건`));
    arr(review.blockers).forEach(reason => panel.append(node("p", "", reason)));
    if (balancedReview()) {
      const reviews = arr(review.final_reviews);
      panel.append(node("p", "", `최종 검토 기록 ${reviews.filter(r => r.record_complete).length} / ${participants().length}명 · 기록 형식 집계이며 통과 판정의 진위는 별도 확인`));
      arr(review.final_review_issues).forEach(reason => panel.append(node("p", "", text(reason))));
    }
    const guidance = review.guidance_checks;
    if (guided() && guidance && typeof guidance === "object" && !Array.isArray(guidance)) {
      const labels = { student_feedback_unmatched: "학생 초안 인용이 맞지 않는 맹점 비판", report_plan_missing: "잠정 보고서 계획이 없는 반론 응답", audit_unmatched: "원답변 인용이 맞지 않는 오류 후보", candidate_field_gaps: "A·B 단점 해소 항목이 빠진 C 후보", ethics_gaps: "윤리 3관점 기록이 부족한 발언" };
      const rows = Object.entries(labels).filter(([key]) => arr(guidance[key]).length).map(([key, label]) => node("p", "", `${label} · ${arr(guidance[key]).map(text).join(", ")}`));
      panel.append(detail("과제 지침 반영 기록 점검 · 정보용", rows.length ? add(node("div", "ds-record-stack"), ...rows) : node("p", "ds-muted", "형식상 빠진 항목이 없습니다. 내용의 타당성은 원문과 직접 대조하세요."), "guidance-checks"));
    }
    if (planned()) {
      const omissions = arr(review.delivery_omissions).filter(o => o && typeof o === "object");
      if (omissions.length) panel.append(markdownField("입력 한도로 전달하지 못한 필수 근거 · 해당 판단은 미확인", omissions.map(o => `${o.turn}: ${arr(o.omitted).join(", ")}`)));
      const unselected = arr(review.unselected_sources);
      if (unselected.length) panel.append(add(node("div", "ds-field"), badge(`선택 자료에 없는 필수 근거 ${unselected.length}개`, "amber"), node("p", "", unselected.join(", ")),
        node("p", "ds-muted", "이 근거가 필요한 판단은 원문으로 확인되지 않았습니다. 해당 기준서·과제 파일을 선택한 새 실행이 필요합니다.")));
      panel.append(requirementRegister(review));
    }
    const pending = node("div", "ds-record-stack");
    arr(review.pending_challenges).forEach(issue => pending.append(node("p", "", `${issue.critical ? "핵심" : "일반"} · ${issue.challenge_id} → ${issue.target} · ${issue.reason}`)));
    arr(review.missing_peer_reviews).forEach(issue => pending.append(node("p", "", `${issue.reviewer} · 검토 대기 주장 ${issue.claim_id}`)));
    arr(review.invalid_references).forEach(issue => pending.append(node("p", "", "참조·인용 확인 필요 · " + text(issue))));
    if (pending.children.length) panel.append(detail("미응답·누락·확인 필요 목록", pending, "review-pending"));
    return panel;
  }
  /* Run progress, the judgment status and the assignment record are three different things. */
  function stateGrid(review, reviewLabel) {
    const counts = review.assignment_record?.counts || {}, grid = node("div", "ds-state-grid");
    const cell = (label, value, note) => add(node("div", "ds-state"), node("span", "", label), node("strong", "", value), node("p", "", note));
    return add(grid, cell("실행 상태", statuses[run.status] || run.status || "미기록", "AI 호출이 어디까지 진행됐는지"),
      cell("판단 상태", reviewLabel, "주장·반박·응답의 연결 검사 · 진위 검증 아님"),
      cell("과제 요건 기록", `기록 ${counts.recorded || 0} · 일부 ${counts.partial || 0} · 없음 ${counts.missing || 0}`, `확인 필요 ${counts.needs_check || 0} · 단계 전 ${counts.not_due || 0} · 해당 없음 ${counts.not_applicable || 0} · 점수 아님`));
  }
  function requirementRegister(review) {
    const rows = arr(review.requirements).filter(r => r && typeof r === "object"), wrap = node("div", "ds-table-wrap"), table = node("table", "ds-data-table"), head = node("thead"), headrow = node("tr"), body = node("tbody");
    ["요건", "내용 · 과제 원문", "담당 단계", "기록 상태", "연결 기록 · 비고"].forEach(label => { const th = node("th", "", label); th.scope = "col"; headrow.append(th); }); head.append(headrow);
    rows.forEach(r => {
      const tone = r.status === "recorded" ? "teal" : ["partial", "missing", "needs_check"].includes(r.status) ? "amber" : "neutral", tr = node("tr");
      tr.append(add(node("td"), node("strong", "", r.id)), add(node("td"), node("p", "", r.title), node("p", "ds-muted", r.source)), node("td", "", phases().find(ph => ph[0] === r.stage)?.[1] || r.stage),
        add(node("td"), badge(requirementLabels[r.status] || r.status || "미기록", tone), ...arr(r.parts).filter(x => x && typeof x === "object").map(x => node("p", "ds-muted", `${x.name} · ${x.status === "info" ? "참고" : requirementLabels[x.status] || x.status}`))),
        add(node("td"), node("p", "", arr(r.links).join(", ") || "-"), r.note ? node("p", "ds-muted", r.note) : null));
      body.append(tr);
    });
    table.append(head, body); wrap.append(table);
    const content = add(node("div", ""), node("p", "ds-muted", "AI 발언에 요건별 기록과 연결 ID가 있는지만 검사합니다. 내용이 과제 요건을 충족하는지와 점수는 원문과 대조해 직접 판단하세요."), rows.length ? wrap : empty("요건 대장 기록이 없습니다."));
    return detail(`과제 요건 기록 대장 · ${rows.length}개 요건`, content, "requirements", true);
  }
  function correctionBlock(c) {
    const student = c.question_source === "student_edited";
    return add(node("div", "ds-correction"), text(c.actual_answer).trim() ? badge("실제 교정 호출 기록 있음", "teal") : null, badge(student ? "학생이 고친 질문" : c.question_source === "ai_proposed" ? "AI 제안 질문 그대로" : "질문 출처 미기록 · 이전 기록", "neutral"),
      markdownField("실제 수정 질문", c.revised_question), student ? markdownField("AI가 제안한 원래 수정 질문", c.ai_revised_question) : null, student ? markdownField("학생이 바꾼 이유", c.student_reason) : null,
      arr(c.extra_units).length ? markdownField("학생이 추가로 보낸 기준서 문단", arr(c.extra_units).join(", ")) : null, markdownField("실제 재응답", c.actual_answer, "아직 실제 재응답이 기록되지 않았습니다."), node("p", "ds-muted", c.id || "교정 기록"));
  }
  function claimTrace() {
    const panel = section("원주장 → 반박 → 응답", "ID로 연결한 원기록입니다. 반박의 수용 여부와 근거의 진위는 원문에서 확인하세요.");
    const targets = new Map(records("claims").concat(records("candidates")).map(row => [row.item.id, row]));
    const replies = records("responses"), checks = records("challenges");
    checks.forEach(({ item: check, turn }) => {
      const targetId = check.target_claim || check.target_candidate, target = targets.get(targetId);
      const card = add(node("article", "ds-mini-record"), node("h4", "", `${check.id} → ${targetId || "대상 미기록"}`), badge(check.disposition || "판정 미기록"));
      if (target) { card.append(markdownField("원주장·후보", target.item.claim || target.item.proposal)); card.append(linkSource(target.turn)); }
      else card.append(node("p", "ds-muted", "대상 ID 원문을 찾지 못했습니다."));
      card.append(markdownField("검토자가 남긴 실제 인용", check.quote));
      card.append(markdownField("반박·수용 근거", check.reason));
      if (check.finding_type) card.append(markdownField("지적 분류 · 모델 판단", ({ confirmed_defect: "확인된 결함이라는 주장", unverified_premise: "미확인 전제", conditional_risk: "조건부 위험", optional_suggestion: "선택적 제안 · 자체로 권고 차단 안 함", supported: "근거 있는 지지" })[check.finding_type] || check.finding_type));
      if (check.criterion) card.append(markdownField("연결된 평가 기준", check.criterion));
      if (check.impact) card.append(markdownField("결론에 미치는 영향", check.impact));
      if (check.evidence) card.append(markdownField("출처·확인 요구", check.evidence));
      card.append(linkSource(turn));
      const answers = replies.filter(row => row.item.challenge_id === check.id);
      if (!answers.length) card.append(badge(check.disposition === "supports" ? "수용 기록 · 반론 응답 불필요" : "응답 대기", "amber"));
      answers.forEach(({ item: response, turn: author }) => card.append(add(node("div", "ds-field"), badge(response.disposition || "응답 미분류"), markdownField("응답 근거", response.reason), response.revised_claim ? markdownField("수정 내용·유지 이유", response.revised_claim) : null, node("p", "ds-muted", response.resolution === "addressed" ? "응답자가 처리했다고 보고 · 타당성 확인 별도" : "미해결로 남김"), linkSource(author))));
      panel.append(card);
    });
    if (!checks.length) panel.append(empty("아직 연결된 검토 기록이 없습니다."));
    return panel;
  }
  function overview() {
    const container = node("div", "ds-pane"), progress = section("연구 진행 지도", "연구 프로토콜 5단계에 비판 반영 수정 절차를 이어서 표시합니다. 완료 발언만 집계하며, 미실행 단계의 결과를 만들지 않습니다.");
    if (mode() === "smoke") progress.querySelector("p").textContent = "이 기록은 자유 라운드 토론입니다. 각 라운드별 독립 제안 및 상호 공방 결과를 단계별로 표시합니다. 연구 5단계나 최종 연구 결론의 완료로 집계하지 않습니다.";
    if (mode() === "consensus" && !expandedConsensus()) progress.querySelector("p").textContent = "독립 분석 → 교차 반박 → 재반론 → 최종 합의 검토의 4단계입니다. 단계 완료는 발언 수만 의미하며 전원 동의를 뜻하지 않습니다.";
    if (expandedConsensus()) progress.querySelector("p").textContent = "독립 분석 → 교차 반박 → 재반론 → 대안 C → 교수 비판 → 최종 합의 및 수정의 6단계입니다. 단계 완료는 발언 수만 의미하며 전원 동의를 뜻하지 않습니다.";
    if (protocolV3() && mode() === "research") progress.querySelector("p").textContent = "독립 조사 → 교차 검증 → 반론 응답 → 선택지 비교 → 관점·실패 검토 → 교수 비판 → 수정·최종 판단. 발언 수신과 근거 검토 상태를 나눠 표시합니다.";
    if (balancedReview() && mode() !== "smoke") progress.querySelector("p").textContent = phases().map(p => p[1]).join(" → ") + ". 중대한 결함이 없으면 원안을 유지합니다. 판정은 AI의 보고이며 독립 검증은 별도입니다.";
    if (hasResults() && arr(run.result_overview.positions).length) container.append(add(node("p", "ds-callout"), node("span", "", "결론·AI별 입장·대화 흐름·반박·C 후보·환각 후보는 "), button("'결과' 탭", () => nextTab("results"), "ds-link-button"), node("span", "", "에서 한눈에 볼 수 있습니다.")));
    progress.append(timeline()); container.append(progress);
    const attempts = arr(run.attempts);
    if (attempts.length) {
      const history = node("div", "ds-records"), labels = { completed: "응답 수신 완료", failed: "실패", cancelled: "사용자 취소", interrupted: "중단됨" };
      const unparsed = new Set(arr(run.turns).filter(t => parsed(t).position_change === PARSE_FAILED).map(t => t.id));
      attempts.forEach(a => {
        const status = (a.status === "started" ? run.active ? "호출 중" : "종료 미확인" : labels[a.status] || a.status || "상태 미기록") + (a.status === "completed" && unparsed.has(a.turn_id) ? " · 분석 실패(응답 형식 오류)" : "");
        history.append(add(node("article", "ds-mini-record"), node("h4", "", `${a.turn_id || a.id || "발언 미기록"} · ${a.number ? a.number + "번째 시도 · " : ""}${status}`),
          node("p", "ds-muted", `${a.attempt_id || "이전 기록 · 시도 ID 미기록"} · ${a.time || "시각 미기록"}${a.error_category ? " · " + a.error_category : ""}`)));
      });
      container.append(detail("호출 시도 기록 · " + attempts.length + "건", history, "attempt-history"));
    }
    if (protocolV3()) container.append(reviewPanel());
    const positions = section("참가자별 현재 위치", "각 참가자가 실제로 남긴 마지막 결론과 진행 상태입니다. 참가자 간 합의 여부를 자동 판정하지 않습니다."), grid = node("div", "ds-participant-grid");
    participants().forEach(agent => {
      const all = turnsFor(agent), last = all[all.length - 1], conclusion = latestConclusion(agent), card = node("article", "ds-participant-card");
      const expected = phases().length, received = phases().filter(p => all.some(t => phaseOf(t) === p[0])).length;
      add(card, node("p", "ds-kicker", agent.provider || "공급자 미기록"), node("h4", "", agent.name), badge(received ? `${received} / ${expected}회 발언 수신 · ${received === expected ? "담당 발언 완료" : "담당 발언 미완료"}` : "아직 조사하지 않음", received === expected ? "teal" : received ? "amber" : "neutral"));
      const decided = finalDecision(agent), decision = decided ? parsed(decided).decision : null;
      if (last && decision) {
        card.append(node("p", "ds-muted", "마지막 수신 단계 · " + last.stage_title));
        card.append(badge(`AI 결론 · ${decision.status === "conditional_recommendation" ? "조건부 권고" : "권고 보류"}`, "teal"));
        if (decision.candidate_id) card.append(recordReference(decision.candidate_id, "p", "ds-recommended-candidate"));
        if (protocolV3()) card.append(badge("프로그램 판정 · " + decisionLabel(decided), "neutral"));
        card.append(rich(decision.reason || "이유 미기록")); card.append(linkSource(decided));
      } else if (last) { card.append(node("p", "ds-muted", "마지막 수신 단계 · " + last.stage_title)); if (protocolV3()) card.append(badge(decisionLabel(conclusion || last), "neutral")); card.append(conclusion ? rich(parsed(conclusion).conclusion) : node("p", "ds-muted", "별도 결론 항목 없음 · 분석 본문에서 확인")); card.append(linkSource(conclusion || last)); }
      else card.append(node("p", "ds-muted", "이 참가자의 조사·반박·결론은 아직 기록되지 않았습니다."));
      grid.append(card);
    }); positions.append(grid); container.append(positions);
    if (guided()) {
      const draft = text(run.student_draft).trim(), feedback = records("student_feedback");
      const mine = section("내 첫 생각 · AI가 지적한 맹점", "학생이 직접 쓴 초안은 독립 조사에 공개하지 않고 교차 검증 단계에서만 비판받습니다. 부록 B에 그대로 옮길 수 있습니다.");
      mine.append(draft ? markdownField("학생이 직접 쓴 첫 생각", draft) : empty("입력한 첫 생각이 없습니다.", "새 연구 설정의 '내 첫 생각'에 직접 쓰면 교차 검증 단계에서 맹점 비판을 받을 수 있습니다."));
      feedback.forEach(({ item, turn }) => mine.append(add(node("article", "ds-mini-record"), node("h4", "", item.id || "맹점"), markdownField("학생 초안 인용", item.quote), markdownField("맹점", item.blind_spot), markdownField("스스로 점검할 질문", item.question), linkSource(turn))));
      container.append(mine);
    }
    const latest = arr(run.turns).slice(-4).reverse(), recent = section("최근 완료된 발언", "아래 문장은 원문 앞부분을 발췌한 것입니다. 분석 전체는 AI별 조사·토론 탭에서 펼쳐볼 수 있습니다.");
    latest.forEach(t => recent.append(add(node("article", "ds-extract"), linkSource(t), node("p", "", excerpt(analysis(t) || parsed(t).conclusion || t.answer, 280)), badge("원문 발췌"))));
    if (!latest.length) recent.append(empty("아직 완료된 발언이 없습니다.", "설정 화면에서 직접 시작한 뒤 완료된 응답이 이곳에 표시됩니다."));
    container.append(recent);
    const drafts = arr(run.interrupted_drafts).filter(d => d && typeof d === "object");
    if (drafts.length) {
      const interrupted = section("중단 시 보존된 임시 발언", "완료 전 중단된 응답입니다. 조사·발언 완료 수, 채택된 결론, 검증 결과에 포함하지 않습니다.");
      drafts.forEach((draft, index) => {
        const card = node("article", "ds-mini-record");
        add(card, badge("미완료 초안", "amber"), node("h4", "", `${draft.name || "참가자"} · ${draft.stage_title || "단계 미기록"}`), node("p", "ds-muted", `${draft.id || "발언 ID 미기록"}${draft.time ? " · " + draft.time : ""}`));
        card.append(detail("중단 당시 수신한 임시 원문", rich(draft.text || draft.answer || draft.partial_text || "기록된 임시 본문 없음"), "draft-" + index)); interrupted.append(card);
      }); container.append(interrupted);
    }
    const materials = arr(run.manifest).filter(m => m && typeof m === "object");
    if (materials.length) { const s = section("사용된 자료", materials.length + "개 자료의 기존 실행 기록입니다."); materials.forEach(m => s.append(node("p", "ds-material-name", m.file || m.name || "자료명 미기록"))); container.append(s); }
    const documents = section("관련 연구 문서", "기존 문서를 웹에서 읽기 쉬운 서식으로 확인합니다. 원본 Markdown과 JSON은 그대로 보존됩니다."), links = node("div", "ds-report-links");
    [...(run.result_document ? [["00_결과_요약.md", "결과 요약 · 먼저 읽기"]] : []), ["research_dossier.md", "연구 자료집"], ["alternatives_c.md", "대안 C"], ["evidence_register.md", "근거 대장"], ["ai_audit.md", "AI 오류 검토"], ["debate_log.md", "전체 토론 기록"], ["report_outline.md", guidedPbl() ? "결론 우선 4페이지 목차" : "4페이지 SCQA 목차"], ["professor_review.md", balancedReview() ? "최종 검토" : "교수 비판"], ["summary.md", "기존 결론·쟁점 문서"], ["ai_usage_appendix.md", "AI 활용 부록"]].forEach(([name, label]) => add(links, reportButton(name, label)));
    documents.append(links); container.append(documents);
    return container;
  }
  function research() {
    const container = node("div", "ds-pane"), bar = node("div", "ds-filter-bar"), select = node("select", "ds-filter"); select.id = "ds-participant-filter"; select.setAttribute("aria-label", "조사 참가자 선택");
    const all = node("option", "", "모든 참가자"); all.value = "all"; select.append(all);
    participants().forEach(a => { const option = node("option", "", a.name + " · " + (a.provider || "")); option.value = a.key; select.append(option); });
    if (!Array.from(select.options).some(o => o.value === participantFilter)) participantFilter = "all";
    select.value = participantFilter; select.addEventListener("change", () => { participantFilter = select.value; paint(); });
    add(bar, node("label", "", "참가자별 조사 보기"), select); bar.querySelector("label").htmlFor = select.id; container.append(bar);
    participants().filter(a => participantFilter === "all" || participantFilter === a.key).forEach(agent => {
      const allTurns = turnsFor(agent), independent = allTurns.filter(t => ["independent", "round1"].includes(phaseOf(t))), s = section(agent.name, `${agent.provider || ""} · ${agent.model || allTurns[0]?.model || "CLI 기본 모델"}`);
      if (!independent.length) s.append(empty("아직 조사하지 않음", "독립 조사 발언이 완료되면 핵심 논점과 쟁점 분석 원문을 이곳에서 확인합니다."));
      independent.forEach(t => s.append(turnCard(t, true)));
      const later = allTurns.filter(t => !["independent", "round1"].includes(phaseOf(t)));
      if (later.length) { const follow = node("div", "ds-record-stack"); later.forEach(t => follow.append(turnCard(t))); s.append(detail("이 참가자의 후속 검토 전체 · " + later.length + "회", follow, "follow-" + agent.key)); }
      container.append(s);
    });
    if (!participants().length) container.append(empty("참가자 기록 없음"));
    return container;
  }
  function debate() {
    const container = node("div", "ds-pane"), cross = arr(run.turns).filter(t => ["cross", "round2"].includes(phaseOf(t)) || (mode() === "smoke" && phaseOf(t) !== "round1")), multi = arr(run.turns).filter(t => phaseOf(t) === "perspectives");
    const main = section("교차 검증 · 핵심 반박", "다른 AI를 검토한 발언을 분리해 표시합니다. 발언 ID와 실제 인용이 반박의 근거인지 원문에서 대조하세요.");
    if (!cross.length) main.append(empty("아직 교차 검증하지 않았습니다.", "독립 조사만으로 상호 토론이나 합의가 이루어진 것으로 표시하지 않습니다.")); cross.forEach(t => main.append(turnCard(t, true))); container.append(main);
    if (protocolV3()) container.append(claimTrace());
    if (mode() === "consensus" || protocolV3() && mode() === "research") {
      const rebuttals = arr(run.turns).filter(t => phaseOf(t) === "rebuttal"), rebuttal = section("재반론 · 반박에 대한 답변", "교차 반박을 받은 뒤 실제로 남긴 재반론입니다. 입장 유지·수정, 수용한 지적과 남은 이견을 확인합니다.");
      if (!rebuttals.length) rebuttal.append(empty("아직 재반론을 진행하지 않았습니다.")); rebuttals.forEach(t => rebuttal.append(turnCard(t, true))); container.append(rebuttal);
    }
    const perspective = section("윤리 이론 · 이해관계자 · 실패 조건", "공리주의·의무론·공동체주의, 단기/장기 손익, 계산 가정과 Kill Conditions가 기록된 재검토 원문입니다.");
    if (mode() !== "consensus") { if (!multi.length) perspective.append(empty("아직 다중 관점 재검토를 진행하지 않았습니다.")); multi.forEach(t => perspective.append(turnCard(t, true))); container.append(perspective); }
    const change = section("입장 변화 이력", "변경 없음·입장 변경을 포함한 모델의 실제 기록입니다. 같은 공급자의 여러 참가자도 발언 번호별로 분리합니다.");
    const positions = arr(run.turns).filter(t => text(parsed(t).position_change).trim());
    positions.forEach(t => change.append(add(node("article", "ds-mini-record"), linkSource(t), rich(parsed(t).position_change))));
    if (!positions.length) change.append(empty("입장 변화 기록 없음")); container.append(change);
    container.append(unresolvedSection());
    const all = section("전체 발언 순서", "분류 탭에서 찾지 못한 내용도 원문을 빠짐없이 조회할 수 있습니다.");
    arr(run.turns).forEach(t => all.append(turnCard(t))); if (!arr(run.turns).length) all.append(empty("완료된 발언 없음")); container.append(all);
    return container;
  }
  function unresolvedSection() {
    const s = section("미해결 쟁점 · 남은 약점 · 소수의견", "각 발언에서 명시한 미해결 기록입니다. 중복과 의견 차이를 보존합니다."), values = records("unresolved");
    values.forEach(({ item, turn }) => s.append(add(node("article", "ds-mini-record"), rich(item), linkSource(turn))));
    if (!values.length) s.append(empty("명시적으로 기록된 미해결 항목 없음", "이 표시가 모든 쟁점의 해결이나 전원 동의를 의미하지는 않습니다.")); return s;
  }
  function decisions() {
    if (protocolV3()) return reviewedDecisions();
    if (mode() === "consensus") return consensusDecisions();
    const container = node("div", "ds-pane"), cTurns = arr(run.turns).filter(t => phaseOf(t) === "alternatives"), revisions = arr(run.turns).filter(t => phaseOf(t) === "revision");
    const design = section("대안 C 후보 · 비교 · 결합", "C안 설계 단계에 기록된 후보, 비용·실행 가능성·윤리성·상장 지연 위험, 후보 결합 및 선정 이유를 원문 그대로 분류합니다.");
    if (!cTurns.length) design.append(empty("대안 C 설계 단계는 아직 진행하지 않았습니다.", "독립 조사에서 제안한 초안은 아래 제안 기록과 AI별 조사에서 확인할 수 있습니다. 후보 수를 임의로 채우지 않습니다."));
    cTurns.forEach(t => design.append(turnCard(t, true))); container.append(design);
    const proposals = records("proposals"), selected = section("채택 · 기각 · 보류된 제안", "모델이 proposals에 남긴 제안 전체입니다. A/B 관련 제안도 포함되며, 모든 제안을 C안 후보로 간주하지 않습니다. 개별 AI의 채택은 전체 합의를 뜻하지 않습니다.");
    if (!proposals.length) selected.append(empty("제안 판단 기록 없음"));
    for (const [label, test] of [["채택", x => x === "채택"], ["기각", x => x === "기각"], ["보류 · 판단 미기록", x => !["채택", "기각"].includes(x)]]) {
      const group = proposals.filter(r => test(text(r.item.decision))), wrap = node("div", "ds-decision-group");
      if (!group.length) continue; wrap.append(node("h4", "", label + " · " + group.length + "건"));
      group.forEach(({ item, turn }) => wrap.append(add(node("article", "ds-mini-record"), badge(item.decision || "판단 미기록"), rich(item.proposal || item), item.reason ? markdownField("선택 근거", item.reason) : null, linkSource(turn)))); selected.append(wrap);
    }
    container.append(selected);
    const final = section("결론 도출 · 비판 반영 수정", "최종 수정 단계의 발언과 참가자별 결론을 구분합니다. 시스템이 합의 결론을 새로 작성하거나 채택 여부를 추정하지 않습니다.");
    const completeRevision = completedSlots("revision") >= participants().length && participants().length > 0;
    if (!revisions.length) final.append(empty("아직 최종 결론이 없습니다.", "교수 관점 비판을 반영한 최종 수정 단계가 완료되지 않았습니다. 아래 현재 결론은 잠정 의견입니다."));
    else { final.append(badge(completeRevision ? "최종 수정 단계 완료 · 참가자별 결론" : "최종 수정 단계 일부 완료 · 전체 결론 미완료", completeRevision ? "teal" : "amber")); revisions.forEach(t => final.append(turnCard(t, true))); }
    if (!completeRevision) {
      const interim = section("참가자별 잠정 결론", "현재까지 기록된 가장 최근의 결론입니다. 최종 합의와 구분합니다.");
      participants().forEach(agent => { const t = latestConclusion(agent); interim.append(add(node("article", "ds-mini-record"), node("h4", "", agent.name), t ? rich(parsed(t).conclusion) : node("p", "ds-muted", "아직 결론 기록 없음"), t ? linkSource(t) : null)); }); final.append(interim);
    }
    container.append(final, unresolvedSection());
    const resources = node("div", "ds-report-links"); add(resources, reportButton("alternatives_c.md", "대안 C 전체 문서"), reportButton("report_outline.md", "4페이지 SCQA 목차"), reportButton("summary.md", "기존 결론·쟁점 문서")); container.append(resources); return container;
  }
  function reviewedDecisions() {
    const container = node("div", "ds-pane"); container.append(reviewPanel());
    const independent = section("미평가 후보 · 초기 제안", "독립 조사에서 만든 아이디어입니다. 선정·실행 권고로 집계하지 않습니다.");
    const seeds = arr(run.turns).filter(t => arr(parsed(t).candidate_seeds).length);
    seeds.forEach(t => independent.append(turnCard(t))); if (!seeds.length) independent.append(empty("기록된 독립 후보 없음")); container.append(independent);
    const candidates = section(run.domain === "general" ? "설명·선택지 비교" : "C 후보 비교 · 잠정 우선안", "검토한 쟁점, 비용·가정, 실행·윤리·일정 위험, 결합 원본 ID와 한계를 확인합니다.");
    const cTurns = arr(run.turns).filter(t => phaseOf(t) === "alternatives"); cTurns.forEach(t => candidates.append(turnCard(t, true)));
    if (!cTurns.length) candidates.append(empty("후보 비교 단계 전입니다.")); container.append(candidates);
    const proposals = section("제안 원기록 · 단계별 판단 상태", "모델이 초반에 채택이라고 표현해도 최종 권고로 승격하지 않습니다. 모델의 원문은 그대로 보존합니다.");
    records("proposals").forEach(({ item, turn }) => proposals.append(add(node("article", "ds-mini-record"), badge(decisionLabel(turn)), rich(item.proposal || item), item.reason ? markdownField("이유", item.reason) : null, linkSource(turn))));
    if (records("proposals").length) container.append(proposals);
    const final = section(balancedReview() ? "검토 채택·기각 · 참가자별 최종 판단" : "비판 반영 · 참가자별 최종 판단", "핵심 반박·근거 누락이 남으면 권고를 보류합니다. 근거 있는 기각과 원안 유지를 허용하며, 개별 권고는 전체 합의나 독립 사실 검증을 뜻하지 않습니다.");
    const finals = arr(run.turns).filter(t => ["revision", "consensus"].includes(phaseOf(t)) || mode() === "smoke" && phases().length >= 3 && phaseOf(t) === phases().at(-1)[0]);
    finals.forEach(t => final.append(turnCard(t, true))); if (!finals.length) final.append(empty("아직 최종 판단 단계가 아닙니다.", "현재 참가자 의견은 잠정 의견입니다.")); container.append(final);
    if (guided()) container.append(noteCandidates(finals));
    container.append(unresolvedSection());
    const resources = node("div", "ds-report-links"); add(resources, reportButton("alternatives_c.md", "후보·비교 전체"), reportButton("report_outline.md", "직접 작성 목차"), reportButton("summary.md", "판단·쟁점 기록")); container.append(resources); return container;
  }
  /* Footnote candidates come from saved decision basis IDs only; clicking jumps to the evidence row. */
  function noteCandidates(finals) {
    const ids = [];
    finals.forEach(t => { const decision = parsed(t).decision; arr(decision && typeof decision === "object" ? decision.basis_claim_ids : []).forEach(id => { if (typeof id === "string" && !ids.includes(id)) ids.push(id); }); });
    const claims = new Map(records("claims").map(row => [row.item.id, row]));
    const notes = section("결론 근거 주석 후보", "최종 판단이 근거로 든 주장 ID입니다. 보고서 본문에 [주석 n]을 달고 부록에 같은 번호로 원문을 옮기세요. 원문 대조 전에는 확정 근거가 아닙니다.");
    if (!ids.length) notes.append(empty("아직 최종 판단의 근거 ID가 없습니다.", "주석 후보를 임의로 만들지 않습니다."));
    ids.forEach((id, index) => {
      const row = claims.get(id);
      notes.append(add(node("article", "ds-mini-record"), node("h4", "", `[주석 ${index + 1}] ${id}`), row ? rich(row.item.claim) : node("p", "ds-muted", "주장 원문을 찾지 못했습니다."),
        row && row.item.source ? markdownField("출처", row.item.source) : null, row ? button("근거 대장에서 보기", () => openClaim(id)) : null, row ? linkSource(row.turn) : null));
    });
    return notes;
  }
  function openClaim(id) {
    activeTab = "evidence"; paint();
    const target = document.getElementById("claim-" + id);
    if (target && typeof target.scrollIntoView === "function") target.scrollIntoView({ block: "center" });
  }
  function consensusDecisions() {
    if (protocolV3()) return reviewedDecisions();
    const container = node("div", "ds-pane"), finalTurns = arr(run.turns).filter(t => phaseOf(t) === "consensus"), done = completedSlots("consensus"), count = participants().length;
    if (expandedConsensus()) {
      const design = section("대안 C 후보 · 비교 · 결합", "C안 설계 단계의 원문과 최종 비판 반영 결과를 구분합니다."), cTurns = arr(run.turns).filter(t => phaseOf(t) === "alternatives");
      if (!cTurns.length) design.append(empty("대안 C 설계 단계는 아직 진행하지 않았습니다."));
      cTurns.forEach(t => design.append(turnCard(t, true))); container.append(design);
    }
    const final = section("최종 합의 검토 · 참가자별 최종 결론", "각 참가자가 최종 단계에서 명시한 결론·동의·이견을 보존합니다. 모든 발언이 완료되어도 시스템이 전원 합의로 판정하지 않습니다.");
    final.append(badge(count > 0 && done >= count ? "최종 검토 발언 완료 · 합의 여부 별도 확인" : "최종 검토 일부 완료 또는 대기", count > 0 && done >= count ? "teal" : "amber"));
    participants().forEach(agent => {
      const t = [...finalTurns].reverse().find(t => belongs(t, agent)), card = section(agent.name, (agent.provider || "") + " · 최종 합의 검토");
      if (!t) card.append(empty("이 참가자의 최종 검토가 아직 없습니다.", "이전 단계의 결론은 최종 동의로 간주하지 않습니다."));
      else {
        const p = parsed(t);
        card.append(markdownField("참가자별 최종 결론", p.conclusion, "구조화된 최종 결론 없음 · 발언 본문 확인"));
        card.append(markdownField("명시한 동의 항목", arr(p.agreements).length ? p.agreements : "", "별도 동의 항목 미기록 · 전원 동의 추정 안 함"));
        card.append(markdownField("명시한 이견", arr(p.dissent).length ? p.dissent : "", "별도 이견 항목 미기록 · 이견 없음으로 추정 안 함"));
        card.append(turnCard(t, true));
      }
      final.append(card);
    }); container.append(final);
    const judgments = section("참가자별 채택 · 기각 · 보류", "각 제안의 결정은 발언한 참가자의 판단입니다. 다른 참가자가 동의한 것으로 확대하지 않습니다."), proposals = records("proposals");
    if (!proposals.length) judgments.append(empty("제안 판단 기록 없음"));
    proposals.forEach(({ item, turn }) => judgments.append(add(node("article", "ds-mini-record"), badge(item.decision || "판단 미기록"), rich(item.proposal || item), item.reason ? markdownField("선택 근거", item.reason) : null, linkSource(turn)))); container.append(judgments, unresolvedSection());
    if (!finalTurns.length) {
      const interim = section("참가자별 잠정 결론", "최종 단계 이전의 가장 최근 결론이며 합의 결과가 아닙니다.");
      participants().forEach(agent => { const t = latestConclusion(agent); interim.append(add(node("article", "ds-mini-record"), node("h4", "", agent.name), t ? rich(parsed(t).conclusion) : node("p", "ds-muted", "아직 결론 기록 없음"), t ? linkSource(t) : null)); }); container.append(interim);
    }
    add(container, reportButton("summary.md", "결론·쟁점 문서")); return container;
  }
  function claimsTable(items) {
    const wrap = node("div", "ds-table-wrap"), table = node("table", "ds-data-table ds-claims-table"), head = node("thead"), tr = node("tr"), body = node("tbody");
    ["주장 · 출처 발언", "분류", "근거 · 출처", "모델의 확인 주장", "독립 확인 상태"].forEach(label => { const th = node("th", "", label); th.scope = "col"; tr.append(th); }); head.append(tr);
    items.forEach(({ item, turn }) => {
      const row = node("tr"), claim = node("td"), kind = node("td"), source = node("td"), declared = node("td"), actual = node("td");
      if (typeof item.id === "string" && item.id) row.id = "claim-" + item.id;
      add(claim, item.id ? claimIdBadge(item.id, turn) : null, rich(item.claim || item), linkSource(turn)); kind.append(badge(kinds[item.kind] || item.kind || "미분류"));
      source.append(item.source ? rich(item.source) : node("span", "ds-muted", "출처 미기록")); if (item.check) source.append(markdownField("확인 범위 · 다음 검증", item.check));
      declared.append(node("span", "", item.status || "미기록")); actual.append(badge(item.kind === "assumption" ? "가정 · 사실 검증 대상과 구분" : "원문 대조 대기", item.kind === "assumption" ? "neutral" : "amber"));
      if (item.kind !== "assumption") actual.append(node("p", "ds-muted", "모델 자기 보고와 별도 · 시스템의 독립 확인 기록 없음"));
      row.append(claim, kind, source, declared, actual); body.append(row);
    }); table.append(head, body); wrap.append(table); return wrap;
  }
  function submittedAuditSection() {
    const audit = run?.result_overview?.submitted_audit;
    if (!arr(audit?.cases).length) return null;
    const s = section("내가 가져온 답변 · 검증 결과", "독립 조사 → 교차 검증 → 반론 응답 → 총괄 판단. 오류 아님·일부 오류·판단 보류를 구분하며 SECTION 2와 감사 부록에 연결합니다.");
    const tone = v => v === "error" ? "red" : v === "not_error" ? "teal" : "amber";
    const renderCheck = r => {
      const b = node("div", "ds-mini-record"), turn = arr(run.turns).find(t => t.id === r.turn);
      add(b, node("h5", "", `${r.name} · ${r.stage_title || r.stage}`), badge(r.valid ? r.label : "기록 보완 필요", r.valid ? tone(r.verdict) : "amber"),
        markdownField("판정 이유", r.reason), markdownField("확인 근거", r.evidence), markdownField("남은 한계", r.limitations), markdownField("판정 변경·유지 이유", r.change_reason));
      if (r.corrected_answer) b.append(markdownField("교정 답변 후보 · 별도 재호출 아님", r.corrected_answer));
      if (r.revised_question) b.append(markdownField("개선 질문 후보", r.revised_question));
      if (arr(r.item_coverage).length) b.append(markdownField("질의 범위 대응 · 답변의 진위와 별개", r.item_coverage.map(v => `${v.item}: ${({covered:"대응함",partial:"일부 대응 · 보완 필요",not_covered:"대응하지 않음"})[v.status] || "확인 필요"} — ${v.reason || "이유 미기록"}`).join("\n\n")));
      if (turn) b.append(linkSource(turn));
      return b;
    };
    audit.cases.forEach((c, i) => {
      const card = node("article", "ds-audit-card"), original = node("div", "ds-audit-fields");
      add(card, node("h4", "", `의심 답변 ${i + 1}`), badge(c.label, c.moderator ? tone(c.moderator.verdict) : "amber"));
      card.append(node("p", "ds-muted", "사용자가 연결한 회계처리: " + (arr(c.items).join(" · ") || "미지정 · 기존 최초 질의 유지")));
      add(original, markdownField("원래 질문", c.question || "미제공 · 문맥을 추정하지 않음"), node("h5", "", "답변 원문"), node("pre", "ds-submitted-original", c.answer),
        markdownField("출처 · 사용자 기재", c.source || "미제공"), markdownField("의심 이유 · 교차 검증부터 공개", c.suspicion || "미입력"));
      card.append(detail("검증한 원답변·질문 보기", original, "submitted-original-" + c.id));
      if (c.moderator) add(card, node("h5", "", "총괄의 최종 판단"), renderCheck(c.moderator));
      else card.append(node("p", "ds-muted", audit.moderator_count === 0 ? "총괄을 지정하지 않은 실행입니다. 각 AI의 최종 판단과 이견을 아래에서 확인하세요." : audit.moderator_count > 1 ? "총괄이 여러 명이므로 하나의 판정을 임의로 선택하지 않습니다." : "총괄의 유효한 최종 판정이 아직 없습니다. 아래 AI별 의견을 최종 합의로 계산하지 않습니다."));
      card.append(node("p", "ds-muted", c.scope));
      const latest = node("div", "ds-submitted-grid");
      arr(c.latest).forEach(r => {
        const first = arr(c.history).find(h => h.owner === r.owner && h.stage === "independent"), b = node("div", "ds-mini-record");
        add(b, node("h5", "", r.name), node("p", "", `최초: ${first?.valid ? first.label : "미기록·보완 필요"} → 현재: ${r.valid ? r.label : "기록 보완 필요"}`), markdownField("현재 판단 이유", r.reason));
        b.append(detail("근거·교정안·변경 이력", add(node("div"), ...arr(c.history).filter(h => h.owner === r.owner).map(renderCheck)), `submitted-history-${c.id}-${r.owner}`));
        latest.append(b);
      });
      if (!arr(c.latest).length) latest.append(node("p", "ds-muted", "검증 발언 대기"));
      card.append(latest);
      const ids = new Set(arr(c.history).map(r => r.id)), discussions = node("div");
      records("challenges").filter(({item}) => ids.has(item.target_claim)).forEach(({item, turn}) => {
        const target = arr(c.history).find(r => r.id === item.target_claim), row = node("div", "ds-mini-record");
        add(row, node("h5", "", `${turn.name} → ${target?.name || "검증자"}`), markdownField("검토·반박", item.reason), linkSource(turn));
        records("responses").filter(({item:r}) => r.challenge_id === item.id).forEach(({item:r,turn:t}) => row.append(markdownField(`${t.name}의 응답 · ${r.disposition || "미기록"}`, `${r.reason || ""}\n\n${r.revised_claim || ""}`)));
        discussions.append(row);
      });
      card.append(detail("누가 누구의 판정을 검토했나", discussions.children.length ? discussions : node("p", "ds-muted", "교차 검토 기록 대기"), "submitted-discussion-" + c.id));
      s.append(card);
    });
    if (arr(audit.issues).length) s.append(detail("누락·중복 등 기록 보완 사항", rich(audit.issues.map(v => "- " + readableReferences(v)).join("\n")), "submitted-gaps"));
    return s;
  }
  function evidence() {
    const container = node("div", "ds-pane"), claims = records("claims"), s = section("주장별 근거 대장", "모델의 ‘확인됨’ 표시는 독립 검증으로 승격하지 않습니다. 과제·기준서 원문, 문단, 수치와 적용 범위를 사람이 대조해야 합니다.");
    const hasSubmitted = arr(run.result_overview?.submitted_audit?.cases).length > 0;
    if (hasSubmitted) container.append(node("h3", "", "1. 의심 답변 검증"));
    add(container, submittedAuditSection());
    if (hasSubmitted) container.append(node("h3", "", "2. 근거 자료"));
    const counts = node("div", "ds-kind-counts"); Object.entries(kinds).forEach(([kind, label]) => counts.append(badge(label + " " + claims.filter(r => r.item.kind === kind).length))); s.append(counts);
    if (!claims.length) s.append(empty("구조화된 주장 기록 없음", "분석 본문에 포함된 주장과 출처는 AI별 조사 원문에서 확인할 수 있습니다."));
    else s.append(claimsTable(claims)); container.append(s);
    const webChecks = records("web_checks"), webSection = section("공개 웹 검증 기록", "검색·열람에 대한 모델 자기 보고입니다. URL·확인 시점·근거 문단을 확인하세요. 도구 원본 이벤트는 제공된 경우 JSON 로그에 보존되며, 검색 성공이나 사실 여부를 자동 확정하지 않습니다.");
    if (!webChecks.length) webSection.append(empty("웹 확인 기록 없음", "기록이 없으면 검색·원문 열람을 완료했다고 볼 수 없습니다."));
    const webResults = { supports: "주장 지지", contradicts: "주장과 충돌", inconclusive: "판단 불충분", access_failed: "접근 실패" };
    webChecks.forEach(({ item, turn }) => {
      if (!item || typeof item !== "object") return;
      const card = node("article", "ds-mini-record");
      const cLabel = item.claim_id ? friendlyClaimLabel(item.claim_id, turn).label : "주장 ID 미기록"; add(card, node("h4", "", `${turn.name || ""} · ${cLabel}` + (item.claim_id ? ` (${item.claim_id})` : "")),
        badge(webResults[item.result] || "판정 미기록", "amber"),
        markdownField("검색 필요 이유", item.reason), markdownField("검색어", item.query),
        markdownField("원문 URL · 제목", `${item.url || "URL 미기록"}\n\n${item.title || ""}`),
        markdownField("확인 시점", item.checked_at), markdownField("근거 문단 · 발췌", item.passage),
        markdownField("확인 범위 · 한계", item.limitation), linkSource(turn));
      webSection.append(card);
    });
    container.append(webSection);
    const auditRecords = records("audit"), audits = section("AI 오류 검토 · 질문 개선", `검토 후보 ${auditRecords.length}건 · 독립적으로 확정한 오류 수는 집계하지 않습니다. 실제 오류가 없는 경우 항목을 만들지 않습니다.`);
    if (!auditRecords.length) audits.append(empty("기록된 오류 검토 후보 없음", "오류 건수를 채우기 위해 오답이나 개선 답변을 생성하지 않습니다."));
    auditRecords.forEach(({ item, turn, index }) => {
      const target = arr(run.turns).find(t => t.id === item.target_turn), quote = text(item.original_answer).trim(), matched = !!(target && quoteMatches(quote, target)), corrections = arr(run.corrections).filter(c => c && text(c.actual_answer).trim() && c.review_turn === turn.id && c.target_turn === item.target_turn && (Number.isInteger(c.audit_index) ? c.audit_index === index : !item.revised_question || c.revised_question === item.revised_question));
      const finding = findingFor(turn.id, index), card = node("article", "ds-audit-card" + (finding ? " ds-finding-" + finding.tone : ""));
      add(card, add(node("div", "ds-card-heading"), node("h4", "", "오류 검토 후보 " + (index + 1)), badge(finding ? finding.label : "오류 여부 미확정", finding ? finding.tone : "amber")), linkSource(turn));
      if (finding) card.append(verdictControls(finding));
      add(card, item.error_type ? markdownField("오류 유형 · 모델 분류", item.error_type) : null, markdownField("지적 내용", item.error), markdownField("지적의 근거", item.evidence), node("p", "ds-muted", "반박 대상: " + (item.target_turn ? `${friendlyTurnLabel(item.target_turn)} (${item.target_turn})` : "미기록") + " · " + (matched ? "원답변 인용이 저장 로그와 일치" : "원답변 인용의 저장 로그 일치 확인 안 됨") + " · 인용 일치는 오류의 사실 확인과 별개입니다."));
      const body = node("div", "ds-audit-fields");
      add(body, markdownField("기록된 원래 질문", item.original_question), target?.prompt ? detail("저장 로그의 실제 원질문 대조", rich(target.prompt), "audit-prompt-" + turn.id + index) : null, markdownField("원답변 인용", item.original_answer), markdownField("수정 질문 후보", item.revised_question), markdownField("개선 답변 후보 · 검토자가 제안", item.improved_answer, "교정 후보 미기록"), item.lesson ? markdownField("질문을 어떻게 바꿨고 왜 나아지는지 · 모델 설명", item.lesson) : null);
      body.append(node("p", "ds-callout", "위 개선 답변은 검토자의 교정 제안입니다. 별도로 실행된 교정 응답이 있을 때만 아래에 실제 재실행 결과를 표시합니다."));
      corrections.forEach(c => body.append(correctionBlock(c)));
      if (!corrections.length) body.append(badge("연결된 실제 교정 재실행 기록 없음", "neutral"));
      // The dialog lets the student send the proposal as-is or an edited question with a reason; exact repeats are refused by the server.
      if (matched && text(item.revised_question).trim() && options.onCorrect && !run.active)
        body.append(button(corrections.length ? "질문을 고쳐 다시 재호출" : "수정 질문으로 실제 재호출", () => options.onCorrect(turn.id, index, text(item.revised_question).trim()), "ds-report-button"));
      card.append(detail("원질문 · 원답변 · 수정 질문 · 개선 답변", body, "audit-" + turn.id + index, true)); audits.append(card);
    }); container.append(hasSubmitted ? detail("토론 중 발견한 오류 · 보조 이력", audits, "incidental-evidence-audit") : audits);
    const correctionRecords = arr(run.corrections).filter(c => c && typeof c === "object");
    if (correctionRecords.length) {
      const correctionSection = section("저장된 교정 재실행 기록", "원래 오류 후보와 연결되지 않는 기록도 보존합니다. 실제 응답이 있는 경우에만 재실행 결과로 표시합니다.");
      correctionRecords.forEach(c => {
        const card = node("article", "ds-mini-record"), hasAnswer = !!text(c.actual_answer).trim();
        add(card, badge(hasAnswer ? "실제 교정 응답 기록" : "교정 응답 미완료 · 내용 미기록", hasAnswer ? "teal" : "amber"), node("p", "ds-muted", `${c.id || "교정 기록"} · 검토 ${c.review_turn ? friendlyTurnLabel(c.review_turn) + " (" + c.review_turn + ")" : "미기록"} → 대상 ${c.target_turn ? friendlyTurnLabel(c.target_turn) + " (" + c.target_turn + ")" : "미기록"}`), correctionBlock(c));
        if (c.actual_prompt) card.append(detail("실제 교정 호출의 전체 질문", rich(c.actual_prompt), "correction-prompt-" + c.id));
        correctionSection.append(card);
      }); container.append(correctionSection);
    }
    const professorTurns = arr(run.turns).filter(t => phaseOf(t) === "professor"), professors = section(balancedReview() ? guidedPbl() ? "최종 적대적 검토 · 평가 기준·반례 확인" : "평가 기준 기반 최종 검토" : "교수 관점의 적대적 비판", balancedReview() ? guidedPbl() ? "칭찬 없이 채점 관점에서 감점 요인·반례·사실을 확인합니다. 반례를 찾아본 기록이 있으면 원안 유지도 허용합니다. 아래 판정은 AI의 보고입니다. 실제 교수 평가나 독립 검증 완료를 의미하지 않습니다." : "결함을 전제하지 않습니다. 원안 유지·지적·확인 필요를 구분하며, 아래 판정은 AI의 보고입니다. 실제 교수 평가나 독립 검증 완료를 의미하지 않습니다." : "사실 오류·논리 비약·근거 부족·실행 가능성·반례·감점 요인을 담은 해당 단계의 원문입니다.");
    if (mode() !== "consensus" || expandedConsensus()) {
      if (hasSubmitted) container.append(node("h3", "", "3. 최종 적대적 검토"));
      if (!professorTurns.length) professors.append(empty(balancedReview() ? "아직 최종 검토를 진행하지 않았습니다." : "아직 교수 관점 비판을 진행하지 않았습니다.", "최종 판단 전 점검 단계입니다."));
      professorTurns.forEach(t => {
        if (balancedReview()) {
          const value = parsed(t).review_assessment, assessment = value && typeof value === "object" && !Array.isArray(value) ? value : {};
          const status = ({ no_material_defect: "검토 범위 내 중대한 결함 없음 · 원안 유지", findings_present: "결함·위험 지적 기록", verification_needed: "추가 확인 필요" })[assessment.status] || "검토 판정 미기록";
          const card = section(t.name || t.id, "모델 판단 · 원문과 근거 대조 필요");
          card.append(badge(status, "neutral"));
          add(card, markdownField("검토한 주장·후보 ID", assessment.checked_ids), markdownField("적용한 평가 기준", assessment.criteria), markdownField("원안에서 유지할 요소와 근거", assessment.retained_reasons), markdownField("검토 결과와 이유", assessment.summary), markdownField("검토 범위·한계", assessment.scope_limitations));
          const counter = arr(assessment.counterexample_checks).filter(c => c && typeof c === "object");
          if (counter.length) {
            const list = node("div", "ds-record-stack");
            counter.forEach(c => list.append(add(node("article", "ds-mini-record"), badge(({ defect_found: "결함 발견 보고", premise_unverified: "전제 미확인", no_material_defect: "반례 불성립 · 원안 유지" })[c.outcome] || "결과 미기록", c.outcome === "defect_found" ? "amber" : "neutral"), node("h4", "", [c.id, c.target_id || "대상 미기록"].filter(Boolean).join(" · ")),
              markdownField("가장 강한 반례·실패 시나리오", c.counterexample), markdownField("사용한 원문·계산", c.sources), markdownField("확인 여부·범위", [c.checked, c.scope].filter(Boolean).join(" · ")),
              markdownField("원안 가정 아래 성립 여부", ({ yes: "성립", no: "성립하지 않음", assumption_changed: "가정을 바꿔야 성립" })[c.holds] || c.holds), c.assumption_change ? markdownField("바뀌어야 하는 가정", c.assumption_change) : null)));
            card.append(detail("반례 탐색 기록 · " + counter.length + "건", list, "counter-" + t.id, true));
          } else if (guidedPbl()) card.append(node("p", "ds-muted", "반례 탐색 기록이 없습니다 · 통과로 집계하지 않습니다."));
          if (arr(assessment.fact_checks).length) card.append(markdownField("사실 확인 기록", arr(assessment.fact_checks).map(f => f && typeof f === "object" ? `${f.item || "항목"} → ${f.result || "결과 미기록"} (${f.source || "근거 미기록"})` : text(f))));
          else if (assessment.fact_check_note) card.append(markdownField("확인할 사실이 없다고 본 이유 · 모델 보고", assessment.fact_check_note));
          const check = arr(run.review_state?.final_reviews).find(r => r.turn_id === t.id);
          if (check && !check.record_complete) card.append(markdownField("검토 기록 보완 필요", check.issues));
          if (!check) card.append(node("p", "ds-muted", "검토 기록 형식 확인 결과 미기록 · 통과로 집계하지 않습니다."));
          professors.append(card);
        }
        professors.append(turnCard(t, true));
      }); container.append(professors);
    }
    const related = node("div", "ds-report-links"); add(related, reportButton("evidence_register.md", "근거 대장 전체 문서"), reportButton("ai_audit.md", "AI 오류 검토 전체 문서"), reportButton("professor_review.md", balancedReview() ? "최종 검토 전체 문서" : "교수 비판 전체 문서"), reportButton("ai_usage_appendix.md", "AI 활용 부록")); container.append(related); return container;
  }

  function paint() {
    if (!host) return;
    host.replaceChildren(); host.classList.add("debate-summary");
    if (!run) { host.append(empty("아직 선택된 연구 기록이 없습니다.", "저장된 실행을 선택하면 AI별 조사부터 토론·대안·근거·교수 비판까지 이곳에서 읽을 수 있습니다. 이 화면을 여는 동작은 AI를 실행하지 않습니다.")); return; }
    const total = Number(run.total_turns) || phases().length * participants().length, done = completedCount(), claims = records("claims").length;
    const header = node("header", "ds-header"), heading = node("div", "ds-heading-copy");
    add(heading, node("p", "ds-kicker", "RESEARCH RECORDS · 분류형 연구 요약"), node("h2", "", run.topic || "주제 미기록"), node("p", "ds-intro", "저장된 토론과 출처를 읽고 결과·보고서 작성안을 확인합니다. 화면 조회는 AI를 호출하지 않으며, 총괄 정리는 버튼을 누른 경우에만 실행합니다."));
    const status = ["completed", "complete"].includes(run.status) ? total > 0 && done >= total ? "전체 실행 완료 · 합의·검증 여부 별도" : "실행 종료 · 발언 미완료" : statuses[run.status] || run.status || "상태 미기록";
    add(header, heading, badge(status, run.active ? "teal" : "neutral")); host.append(header);
    const metrics = node("div", "ds-metrics");
    [[done + " / " + total, "완료 발언"], [Math.max(0, total - done), "남은 발언"], [participants().length, "참가자"], [claims, "기록된 주장"]].forEach(([value, label]) => metrics.append(add(node("div", "ds-metric"), node("strong", "", value), node("span", "", label)))); host.append(metrics);
    if (run.live) {
      const liveBox = node("div", "ds-live-box");
      liveBox.append(add(node("div", "ds-live-note"), badge("현재 작성 중", "teal"), node("span", "", `${run.live.name || "참가자"} · ${run.live.stage_title || ""} · 작성 중인 응답은 완료 집계에서 제외됩니다.`)));
      if (text(run.live.text).trim()) {
        liveBox.append(node("p", "ds-live-caption", "수신 중인 임시 원문 · 응답 완료 후 해당 분류에 정리됩니다."));
        liveBox.append(node("pre", "ds-live-text", run.live.text));
      } else liveBox.append(node("p", "ds-live-caption", "모델 응답을 기다리고 있습니다. 아직 수신한 본문이 없습니다."));
      host.append(liveBox);
    }
    const errorRecords = arr(run.errors).filter(Boolean);
    if (errorRecords.length) host.append(detail("실행 오류 기록 · " + errorRecords.length + "건", rich(errorRecords.map(e => typeof e === "object" ? e.error || e.message || text(e) : e).join("\n\n")), "errors"));
    const nav = node("div", "ds-tabs"); nav.setAttribute("role", "tablist"); nav.setAttribute("aria-label", "연구 요약 분류");
    const shown = tabs.filter(([id]) => id === "results" ? hasResults() : id === "report" ? !!reportPlan() : true);
    if (!shown.some(([id]) => id === activeTab)) activeTab = shown[0][0];
    shown.forEach(([id, label], index) => { const b = button(tabLabel(id, label), () => nextTab(id), "ds-tab"); b.id = "ds-tab-" + id; b.setAttribute("role", "tab"); b.setAttribute("aria-controls", "ds-tab-panel"); b.setAttribute("aria-selected", String(activeTab === id)); b.tabIndex = activeTab === id ? 0 : -1; b.addEventListener("keydown", event => { if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) { event.preventDefault(); nextTab(shown[event.key === "Home" ? 0 : event.key === "End" ? shown.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + shown.length) % shown.length][0]); } }); nav.append(b); });
    host.append(nav);
    const panel = node("div", "ds-tab-panel"); panel.id = "ds-tab-panel"; panel.setAttribute("role", "tabpanel"); panel.setAttribute("aria-labelledby", "ds-tab-" + activeTab);
    panel.append(({ results, report, overview, research, debate, decisions, evidence })[activeTab]()); host.append(panel);
    host.append(node("p", "ds-footnote", `기록 ${run.id || ""} · 발언 기록만으로 출처 검증·오류 확정·전체 합의를 자동 판정하지 않습니다. 원본 Markdown·JSON은 기존 결과에서 계속 확인할 수 있습니다.`));
  }
  function mount(target) { host = typeof target === "string" ? document.querySelector(target) : target || document.getElementById("classified-summary"); signature = ""; return host; }
  function render(nextRun, nextOptions) {
    if (!host || !host.isConnected) mount(); if (!host) return;
    options = nextOptions || options;
    const nextSignature = JSON.stringify(nextRun || null); if (nextSignature === signature) return;
    const fresh = run?.id !== nextRun?.id;
    if (fresh) { detailsState = new Map(); participantFilter = "all"; }
    run = normalizeRun(nextRun); signature = nextSignature;
    if (fresh) activeTab = hasResults() && arr(run.result_overview.positions).length ? "results" : "overview";  // a finished run opens on its results
    paint();
  }
  function normalizeRun(value) { return value && typeof value === "object" && !Array.isArray(value) ? { ...value, turns: arr(value.turns).filter(t => t && typeof t === "object"), agents: arr(value.agents).map(a => a && typeof a === "object" ? a : {}) } : null; }
  /* Deterministic data inspection for offline tests; no DOM, network or model calls. */
  function inspect(value) {
    const previous = run; run = normalizeRun(value);
    try {
      const people = participants(), stageList = phases();
      const finalStage = mode() === "research" ? "revision" : mode() === "consensus" ? "consensus" : mode() === "smoke" ? `round${smokeRoundsCount()}` : null;
      return { participants: people.map(agent => ({ ...agent, turns: turnsFor(agent) })), phases: stageList.map(p => ({ id: p[0], title: p[1], done: completedSlots(p[0]), total: people.length })), completed: completedCount(), total: stageList.length * people.length, finalComplete: people.length > 0 && !!finalStage && completedSlots(finalStage) >= people.length, finalOpinions: people.map(agent => ({ name: agent.name, provider: agent.provider, turn: [...turnsFor(agent)].reverse().find(t => phaseOf(t) === finalStage) || null })), claims: records("claims"), audit: records("audit"), proposals: records("proposals"), agreements: records("agreements"), dissent: records("dissent"), unresolved: records("unresolved") };
    } finally { run = previous; }
  }
  function reset() { run = null; signature = ""; activeTab = "overview"; participantFilter = "all"; detailsState = new Map(); if (!host) mount(); paint(); }
  window.DebateSummary = { mount, render, reset, renderMarkdown, inspect };
})();


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

