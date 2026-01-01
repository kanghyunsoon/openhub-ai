// PROJECT 카드: Core analyzeProject 결과(ProjectProfile)를 그대로 보여준다. 탐지 로직·Mock 데이터는 없다.
// 데이터는 preload의 window.openhub.scanProject()로만 받고, 이 함수는 경로 인자를 받지 않는다.
(() => {
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
    node.title = `confidence ${item.confidence} · ${first.file} (${first.type}: ${first.value})${item.evidence.length > 1 ? ` 외 ${item.evidence.length - 1}건` : ""}`;
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
    if (count === 0) blocks.push(el("p", "todo", "탐지된 항목이 없습니다."));
    if (profile.warnings.length > 0) blocks.push(el("p", "project-warn", `경고 ${profile.warnings.length}건 (일부 설정을 해석하지 못함)`));
    body.replaceChildren(...blocks);
    return count;
  }

  async function scan() {
    const status = document.getElementById("project-status");
    status.textContent = "분석 중…";
    const result = await window.openhub.scanProject();
    if (result.status === "canceled") {
      status.textContent = "선택을 취소했습니다.";
      return 0;
    }
    if (result.status === "error") {
      status.textContent = `분석할 수 없습니다: ${result.message}`;
      return 0;
    }
    const count = render(result.profile);
    status.textContent = `탐지 ${count}개 · confidence 1.0 미만은 흐리게 표시`;
    return count;
  }

  document.getElementById("project-select").addEventListener("click", () => {
    void scan();
  });
  // 스모크 실행(OPENHUB_SMOKE_PROJECT)이 버튼과 같은 경로를 쓰도록 노출한다.
  window.__openhubScanProject = scan;
})();
