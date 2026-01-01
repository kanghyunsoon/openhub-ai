// 설치 흐름(TASK-036): FOR YOU 카드 → 설치 계획 보기 → 승인 항목 체크 → (main 프로세스 네이티브 확인 대화상자) → 결과.
// renderer는 toolId 하나만 보낸다(window.openhub.planInstall / runInstall). Plan·digest·승인을 보내지 않는다.
// 체크박스는 확인 버튼을 켜는 화면 단계일 뿐이고, 실제 Approval은 main 프로세스의 네이티브 대화상자에서만 만들어진다.
// 모든 문자열은 textContent로만 넣는다. 확인 상태 이름은 Prepared / Configured / Detected다.
(() => {
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const panel = document.getElementById("install-panel");
  let current = null;

  function show(children) {
    panel.replaceChildren(...children);
    panel.hidden = children.length === 0;
    if (!panel.hidden) panel.scrollIntoView({ block: "start" });
  }

  function renderResult(result) {
    const nodes = [el("h3", "", "설치 결과 · " + result.status + (result.code ? " (" + result.code + ")" : ""))];
    const stages = el("ul", "install-stages");
    for (const s of result.stages) stages.append(el("li", "stage", s.name + "  " + s.value));
    nodes.push(stages);
    if (result.stages.length > 0) nodes.push(el("p", "todo", "Prepared·Configured·Detected는 서버가 실행 중이거나 정상임을 뜻하지 않습니다"));
    for (const c of result.configChanges) nodes.push(el("p", "install-change", c));
    for (const w of result.warnings) nodes.push(el("p", "install-warning", w));
    if (result.nextActions.length > 0) {
      const next = el("ul", "install-next");
      for (const a of result.nextActions) next.append(el("li", "", a));
      nodes.push(el("h4", "", "다음에 할 일"), next);
    }
    show(nodes);
    return result;
  }

  async function run(toolId) {
    const status = el("p", "todo", "확인 대화상자에서 승인하면 실행합니다…");
    panel.append(status);
    const response = await window.openhub.runInstall(toolId);
    if (response.status === "rejected") {
      status.textContent = "승인하지 않아 설치를 중단했습니다. 아무것도 바꾸지 않았습니다.";
      return { status: "rejected", stages: [] };
    }
    if (response.status !== "done") {
      status.textContent = "설치할 수 없습니다: " + (response.message || response.status);
      return { status: response.status, stages: [] };
    }
    if (response.result.reapprove) {
      // PLAN_STALE: 계획이 바뀌었으므로 새 계획을 다시 보여 주고 재승인을 받는다.
      const view = await open(toolId);
      panel.prepend(el("p", "install-warning", "승인 후 설치 계획이 바뀌었습니다(" + response.result.changed.join(", ") + "). 새 계획을 확인하고 다시 승인하세요."));
      return { status: "stale", stages: [], reopened: view !== null };
    }
    return renderResult(response.result);
  }

  function renderPlan(view) {
    const nodes = [el("h3", "", view.displayName + " 설치 계획")];
    nodes.push(el("pre", "install-preview", view.previewLines.join("\n")));
    const targets = el("ul", "install-targets");
    for (const t of view.targets) {
      targets.append(el("li", t.userScope ? "target warn-user-scope" : "target", t.file + " · " + t.client + " · " + (t.userScope ? "사용자 범위(다른 프로젝트에도 영향)" : "프로젝트 범위") + (t.manual ? " · 직접 설정" : "")));
    }
    nodes.push(targets);
    if (view.alreadyInstalled) {
      nodes.push(el("p", "todo", "이미 설정되어 있어 바꿀 것이 없습니다."));
      show(nodes);
      return;
    }
    if (!view.executable) {
      nodes.push(el("p", "install-warning", "이 환경에서는 실행할 수 없는 계획입니다 (" + view.status + ")."));
      show(nodes);
      return;
    }
    const boxes = [];
    const list = el("div", "install-requirements");
    for (const r of view.requirements) {
      const label = el("label", r.userScope ? "requirement warn-user-scope" : "requirement");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.requirement = r.id;
      label.append(box, el("span", "", "[" + r.id + "] " + r.message));
      list.append(label);
      boxes.push(box);
    }
    const confirm = el("button", "install-confirm", "승인 대화상자 열기");
    confirm.type = "button";
    confirm.disabled = true;
    const update = () => {
      confirm.disabled = !boxes.every((b) => b.checked);
    };
    for (const b of boxes) b.addEventListener("change", update);
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void run(view.toolId);
    });
    nodes.push(list, confirm);
    show(nodes);
  }

  const MESSAGES = {
    "no-project": "프로젝트를 먼저 선택하세요.",
    "not-recommended": "현재 추천 목록에 있는 도구만 설치할 수 있습니다.",
    "no-client": "프로젝트에서 지원 Agent Client를 찾지 못했습니다. CLI의 --client를 쓰세요.",
  };

  async function open(toolId) {
    current = toolId;
    show([el("p", "todo", "설치 계획을 만드는 중…")]);
    const response = await window.openhub.planInstall(toolId);
    if (current !== toolId) return null;
    if (response.status !== "ok") {
      show([el("p", "install-warning", MESSAGES[response.status] || "설치 계획을 만들 수 없습니다: " + (response.message || response.status))]);
      return null;
    }
    renderPlan(response.view);
    return response.view;
  }

  // FOR YOU 카드가 다시 그려지면 각 카드에 [설치 계획 보기]를 붙인다(FOR YOU 코드와 분리).
  function decorate() {
    for (const li of document.querySelectorAll("#for-you-list li.rec")) {
      if (li.querySelector(".install-open")) continue;
      const button = el("button", "install-open", "설치 계획 보기");
      button.type = "button";
      button.addEventListener("click", () => void open(li.dataset.toolId));
      li.append(button);
    }
  }
  new MutationObserver(decorate).observe(document.getElementById("for-you-list"), { childList: true });

  // 스모크(--smoke + OPENHUB_SMOKE_INSTALL): 화면과 같은 경로로 계획 → 체크 → 확인 → 결과를 기다린다.
  window.__openhubInstall = async (toolId) => {
    decorate();
    const card = [...document.querySelectorAll("#for-you-list li.rec")].find((li) => li.dataset.toolId === toolId);
    if (!card) return { status: "not-recommended", stages: [] };
    const view = await open(toolId);
    if (view === null) return { status: "no-plan", stages: [] };
    for (const box of panel.querySelectorAll('input[type="checkbox"]')) {
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    }
    const confirm = panel.querySelector(".install-confirm");
    if (!confirm || confirm.disabled) return { status: view.alreadyInstalled ? "no-op" : "not-executable", stages: [] };
    confirm.disabled = true;
    const result = await run(toolId);
    return { status: result.status, stages: (result.stages || []).map((s) => s.name + ":" + s.value), preview: view.previewLines.length };
  };
})();
