// Tool 상세(TASK-070): OpenScore(의미 문구)·Project Fit·카테고리·Why for this project·backend·요구사항·지원 OS.
// 데이터는 window.openhubDiscover.toolDetail(toolId)로만 받는다. Install 버튼은 이 프로젝트 FOR YOU 추천에 있는 도구에만 있고
// 누르면 FOR YOU 카드의 기존 [설치 계획 보기](계획 → 승인 항목 → 네이티브 대화상자)로 잇는다. 모든 문자열은 textContent.
(() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function button(className, text, onClick) {
    const b = el("button", className, text);
    b.type = "button";
    b.addEventListener("click", onClick);
    return b;
  }
  const panel = document.getElementById("tool-detail");
  function show(nodes) {
    panel.replaceChildren(...nodes);
    panel.hidden = nodes.length === 0;
    if (!panel.hidden) panel.scrollIntoView({ block: "start" });
  }

  function openInstall(toolId) {
    const card = [...document.querySelectorAll("#for-you-list li.rec")].find((li) => li.dataset.toolId === toolId);
    const open = card ? card.querySelector(".install-open") : null;
    if (open) open.click();
  }

  async function detail(toolId) {
    show([el("p", "todo", "도구 정보를 불러오는 중…")]);
    const r = await window.openhubDiscover.toolDetail(toolId);
    if (r.status !== "ok") {
      show([el("p", "install-warning", r.status === "not-found" ? "Registry에 없는 도구입니다." : r.message || r.status)]);
      return { status: r.status, fields: [], install: false };
    }
    const d = r.detail;
    const nodes = [el("h3", "", d.title)];
    if (d.summary) nodes.push(el("p", "summary", d.summary));
    const fields = [
      ["OpenScore", d.openScore],
      ["Project Fit", d.projectFit],
      ["카테고리", d.categories.join(", ") || "—"],
      ["설치 backend", d.backends.join(", ") || "—"],
      ["요구사항", d.requirements.join(", ") || "없음"],
      ["지원 OS", d.platforms.join(", ") || "—"],
    ];
    for (const [label, value] of fields) nodes.push(el("p", "entry-line", label + ": " + value));
    nodes.push(el("p", "notice", d.openScoreMeaning));
    nodes.push(el("h4", "", "Why for this project"));
    const reasons = el("ul", "rec-reasons");
    for (const reason of d.reasons) reasons.append(el("li", "", reason));
    if (d.reasons.length === 0) reasons.append(el("li", "more", "이 프로젝트의 추천 이유가 없습니다"));
    nodes.push(reasons);
    if (d.canInstall) nodes.push(button("detail-install", "설치 계획 보기", () => openInstall(d.toolId)));
    nodes.push(el("p", "todo", d.installNote));
    nodes.push(button("detail-close", "닫기", () => show([])));
    show(nodes);
    return { status: "ok", fields: [...fields.map(([label]) => label), "Why for this project"], install: d.canInstall };
  }
  document.addEventListener("openhub:tool-detail", (event) => void detail(String(event.detail)));
  // 스모크(--smoke): 화면과 같은 경로로 상세를 그린다.
  window.__openhubDetail = detail;
})();
