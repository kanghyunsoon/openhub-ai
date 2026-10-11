// PROJECT 카드: Core analyzeProject 결과(ProjectProfile)를 그대로 보여준다. 탐지 로직·Mock 데이터는 없다.
// 데이터는 preload의 window.openhub.scanProject()로만 받고, 이 함수는 경로 인자를 받지 않는다.
(() => {
  const t = window.openhubI18n.t;
  const SECTIONS = [
    ["languages", "Languages"],
    ["frameworks", "Frameworks"],
    ["databases", "Databases"],
    ["packageManagers", "Package Managers"],
    ["infrastructure", "Infrastructure"],
    ["aiClients", "AI Clients"],
    ["aiTools", "AI Tools"],
  ];

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function chip(item) {
    const label = item.kind ? `${item.name} · ${item.kind}` : item.name;
    const node = el("span", item.confidence < 1 ? "tech weak" : "tech", label);
    const first = item.evidence[0];
    const more = item.evidence.length > 1 ? t("project.evidenceMore", { count: item.evidence.length - 1 }) : "";
    node.title = t("project.evidenceTitle", { confidence: item.confidence, file: first.file, type: first.type, value: first.value, more });
    return node;
  }

  function render(profile) {
    const body = document.getElementById("project-body");
    const blocks = [el("p", "project-name", profile.project.name)];
    let count = 0;
    for (const [key, title] of SECTIONS) {
      const items = profile[key];
      if (items.length === 0) continue;
      const block = el("div", "project-section");
      block.append(el("h3", "", title));
      const chips = el("div", "chips");
      for (const item of items) chips.append(chip(item));
      block.append(chips);
      blocks.push(block);
      count += items.length;
    }
    if (count === 0) blocks.push(el("p", "todo", t("project.none")));
    if (profile.warnings.length > 0) blocks.push(el("p", "project-warn", t("project.warnings", { count: profile.warnings.length })));
    body.replaceChildren(...blocks);
    return count;
  }

  // (v0.2.1 P0-1) 선택·분석 중에는 이전 프로젝트의 추천·설치·INSTALLED 패널을 "이전 프로젝트" 상태로 흐리게 하고 누를 수 없게 한다.
  // main도 분석이 끝나기 전에는 설치·계획을 받지 않는다. 취소하면 그대로 되돌리고, 실패하면 프로젝트 영역을 비운다.
  const STALE_IDS = ["for-you", "lifecycle"];
  function markStale(on) {
    for (const id of STALE_IDS) {
      const node = document.getElementById(id);
      if (!node) continue;
      node.classList.toggle("project-stale", on);
      if (on) node.setAttribute("aria-busy", "true");
      else node.removeAttribute("aria-busy");
    }
  }
  let scanSeq = 0;

  async function scan() {
    const my = ++scanSeq;
    const status = document.getElementById("project-status");
    status.textContent = t("project.analyzing");
    markStale(true);
    const result = await window.openhub.scanProject();
    // 더 새 선택이 화면을 맡고 있으면 이 응답은 버린다(main도 superseded로 알린다).
    if (result.status === "superseded" || my !== scanSeq) return 0;
    markStale(false);
    if (result.status === "canceled") {
      status.textContent = t("project.canceled");
      return 0;
    }
    if (result.status === "error") {
      // main은 현재 프로젝트를 비웠다. 이전 프로젝트의 분석 결과를 남기지 않는다(추천·INSTALLED도 다시 읽혀 비워진다).
      document.getElementById("project-body").replaceChildren();
      status.textContent = t("project.error", { message: result.message });
      return 0;
    }
    const count = render(result.profile);
    status.textContent = t("project.done", { count });
    return count;
  }

  document.getElementById("project-select").addEventListener("click", () => {
    void scan();
  });
  // 스모크 실행(OPENHUB_SMOKE_PROJECT)이 버튼과 같은 경로를 쓰도록 노출한다.
  window.__openhubScanProject = scan;
  // 스모크(사용자 범위 프로젝트 이동): 실제 [프로젝트 선택] 버튼을 누르고 분석 결과가 다시 그려질 때까지 기다린다(timer 없음).
  window.__openhubReselectProject = () =>
    new Promise((resolve) => {
      const body = document.getElementById("project-body");
      const observer = new MutationObserver(() => {
        observer.disconnect();
        resolve(body.querySelectorAll("*").length);
      });
      observer.observe(body, { childList: true });
      document.getElementById("project-select").click();
    });
})();
