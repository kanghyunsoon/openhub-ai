// 설치 흐름(TASK-036): FOR YOU 카드 → Client 선택(v0.2.0 P0-3 PR C) → 설치 계획 보기 → 승인 항목 체크
// → (main 프로세스 네이티브 확인 대화상자) → 결과.
// renderer는 toolId와 고른 Client 이름만 보낸다(window.openhub.installOptions / planInstall / runInstall). Plan·digest·승인을 보내지 않는다.
// 선택을 바꾸면 보이던 계획을 지우고 다시 계획해야 한다(승인은 항상 화면에 보인 계획에 묶인다).
// 체크박스는 확인 버튼을 켜는 화면 단계일 뿐이고, 실제 Approval은 main 프로세스의 네이티브 대화상자에서만 만들어진다.
// 모든 문자열은 textContent로만 넣는다. 확인 상태 이름은 Prepared / Configured / Detected다.
(() => {
  const t = window.openhubI18n.t;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  const panel = document.getElementById("install-panel");
  let current = null;
  // 요청 번호: 선택 화면·계획 요청마다 올린다. 응답이 왔을 때 번호가 다르면(더 새 요청·프로젝트 변경) 그 응답은 버린다.
  let seq = 0;
  /** toolId → 마지막으로 계획한 Client 목록(PLAN_STALE 재계획에 쓴다). */
  const lastSelection = new Map();
  let chooser = null;

  function show(children) {
    panel.replaceChildren(...(chooser ? [chooser] : []), ...children);
    panel.hidden = children.length === 0;
    if (!panel.hidden) panel.scrollIntoView({ block: "start" });
  }

  function renderResult(result) {
    const nodes = [el("h3", "", t("install.resultTitle", { status: result.status, code: result.code ? " (" + result.code + ")" : "" }))];
    const stages = el("ul", "install-stages");
    for (const s of result.stages) stages.append(el("li", "stage", s.name + "  " + s.value));
    nodes.push(stages);
    if (result.stages.length > 0) nodes.push(el("p", "todo", t("install.stagesNote")));
    for (const c of result.configChanges) nodes.push(el("p", "install-change", c));
    for (const w of result.warnings) nodes.push(el("p", "install-warning", w));
    if (result.nextActions.length > 0) {
      const next = el("ul", "install-next");
      for (const a of result.nextActions) next.append(el("li", "", a));
      nodes.push(el("h4", "", t("install.nextActions")), next);
    }
    show(nodes);
    return result;
  }

  async function run(toolId) {
    const status = el("p", "todo", t("install.waiting"));
    panel.append(status);
    const response = await window.openhub.runInstall(toolId);
    if (response.status === "rejected") {
      status.textContent = t("install.rejected");
      return { status: "rejected", stages: [] };
    }
    if (response.status === "plan-changed") {
      status.textContent = response.message;
      return { status: "plan-changed", stages: [] };
    }
    if (response.status !== "done") {
      status.textContent = t("install.cannotRun", { message: response.message || response.status });
      return { status: response.status, stages: [] };
    }
    if (response.result.reapprove) {
      // PLAN_STALE: 계획이 바뀌었으므로 새 계획을 다시 보여 주고 재승인을 받는다.
      const view = await review(toolId, lastSelection.get(toolId));
      panel.prepend(el("p", "install-warning", t("install.stale", { changed: response.result.changed.join(", ") })));
      return { status: "stale", stages: [], reopened: view !== null };
    }
    return renderResult(response.result);
  }

  function renderPlan(view) {
    const nodes = [el("h3", "", t("install.planTitle", { name: view.displayName }))];
    nodes.push(el("pre", "install-preview", view.previewLines.join("\n")));
    const targets = el("ul", "install-targets");
    for (const target of view.targets) {
      targets.append(
        el("li", target.userScope ? "target warn-user-scope" : "target", t("install.target", { file: target.file, client: target.client, scope: t(target.userScope ? "install.target.userScope" : "install.target.projectScope"), manual: target.manual ? t("install.target.manual") : "" })),
      );
    }
    nodes.push(targets);
    if (view.alreadyInstalled) {
      nodes.push(el("p", "todo", t("install.noChanges")));
      show(nodes);
      panel.dataset.planState = "already-installed";
      return;
    }
    if (!view.executable) {
      nodes.push(el("p", "install-warning", t("install.notExecutable", { status: view.status })));
      show(nodes);
      panel.dataset.planState = "not-executable";
      return;
    }
    const boxes = [];
    const list = el("div", "install-requirements");
    for (const r of view.requirements) {
      const label = el("label", r.userScope ? "requirement warn-user-scope" : "requirement");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.requirement = r.id;
      label.append(box, el("span", "", t("requirement.line", { id: r.id, message: r.message })));
      list.append(label);
      boxes.push(box);
    }
    const confirm = el("button", "install-confirm", t("install.openDialog"));
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
    panel.dataset.planState = "ready";
  }

  const MESSAGES = {
    "no-project": t("install.msg.noProject"),
    "not-recommended": t("install.msg.notRecommended"),
    "no-client": t("install.msg.noClient"),
    superseded: t("install.msg.superseded"),
  };

  /** Client 선택 화면. 지원하지 않는 Client는 고를 수 없고 이유를 보여 준다. 선택을 바꾸면 보이던 계획을 지운다. */
  function renderChooser(view) {
    const box = el("div", "install-clients");
    box.dataset.toolId = view.toolId;
    box.append(el("h3", "", t("install.clients.title", { name: view.displayName })));
    box.append(el("p", "todo", t("install.clients.platform", { platforms: view.platforms.join(", ") || "-", os: view.platform })));
    if (!view.platformSupported) box.append(el("p", "install-warning", t("install.clients.platformUnsupported", { os: view.platform })));
    box.append(el("p", "todo", t("install.clients.scope")));
    const inputs = [];
    for (const c of view.clients) {
      const label = el("label", "client-choice" + (c.supported ? "" : " unsupported"));
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.client = c.client;
      input.dataset.verification = c.verification;
      input.checked = c.selected;
      input.disabled = !c.supported;
      label.append(input, el("strong", "", c.label), el("span", "client-note", c.note));
      box.append(label);
      inputs.push(input);
    }
    const hint = el("p", "install-warning", t("install.clients.none"));
    const reviewButton = el("button", "install-review", t("install.clients.review"));
    reviewButton.type = "button";
    const selected = () => inputs.filter((i) => i.checked && !i.disabled).map((i) => i.dataset.client);
    const sync = () => {
      const none = selected().length === 0;
      reviewButton.disabled = none;
      hint.hidden = !none;
    };
    for (const input of inputs) {
      input.addEventListener("change", () => {
        sync();
        // 보이던 계획(또는 계획 중인 요청)은 다른 선택의 것이다. 응답을 버리고, 화면을 지우고, main의 Pending Plan도 버린다.
        seq += 1;
        void window.openhub.discardInstallPlan(view.toolId);
        if (panel.querySelector(".install-preview") || panel.dataset.planState === "planning") {
          show([el("p", "install-warning", t("install.clients.changed"))]);
          panel.dataset.planState = "changed";
        }
      });
    }
    reviewButton.addEventListener("click", () => void review(view.toolId, selected()));
    box.append(hint, reviewButton);
    sync();
    return box;
  }

  async function open(toolId) {
    current = toolId;
    const my = ++seq;
    chooser = null;
    show([el("p", "todo", t("install.planning"))]);
    const response = await window.openhub.installOptions(toolId);
    if (my !== seq || current !== toolId) return null;
    if (response.status !== "ok") {
      show([el("p", "install-warning", MESSAGES[response.status] || t("install.planFailed", { message: response.message || response.status }))]);
      return null;
    }
    chooser = renderChooser(response.view);
    show([]);
    panel.hidden = false;
    return response.view;
  }

  async function review(toolId, clients) {
    current = toolId;
    const my = ++seq;
    lastSelection.set(toolId, clients);
    panel.dataset.planState = "planning";
    show([el("p", "todo", t("install.planning"))]);
    const response = await window.openhub.planInstall(toolId, clients === undefined ? undefined : { clients });
    // 더 새 요청이 있었거나 선택·프로젝트가 바뀌었으면 이 응답은 화면에 쓰지 않는다.
    if (my !== seq || current !== toolId) return null;
    if (response.status !== "ok") {
      show([el("p", "install-warning", MESSAGES[response.status] || t("install.planFailed", { message: response.message || response.status }))]);
      panel.dataset.planState = "failed:" + response.status;
      return null;
    }
    // 사용자가 고른 Client와 실제 Plan 대상이 같은지 확인한다(다르면 승인 화면을 만들지 않고 main의 Plan도 버린다).
    if (Array.isArray(clients)) {
      const planned = [...new Set(response.view.targets.map((x) => x.client))].sort().join(",");
      if (planned !== [...new Set(clients)].sort().join(",")) {
        void window.openhub.discardInstallPlan(toolId);
        show([el("p", "install-warning", t("install.selectionMismatch"))]);
        panel.dataset.planState = "failed:selection-mismatch";
        return null;
      }
    }
    renderPlan(response.view);
    return response.view;
  }

  // FOR YOU 카드가 다시 그려지면 각 카드에 [설치 계획 보기]를 붙인다(FOR YOU 코드와 분리).
  function decorate() {
    for (const li of document.querySelectorAll("#for-you-list li.rec")) {
      if (li.querySelector(".install-open")) continue;
      const button = el("button", "install-open", t("install.open"));
      button.type = "button";
      button.addEventListener("click", () => void open(li.dataset.toolId));
      li.append(button);
    }
  }
  new MutationObserver(decorate).observe(document.getElementById("for-you-list"), { childList: true });
  // 프로젝트를 다시 고르면 진행 중인 요청의 응답을 버리고 설치 화면을 비운다(main도 Pending Plan을 버린다).
  new MutationObserver(() => {
    seq += 1;
    current = null;
    chooser = null;
    show([]);
  }).observe(document.getElementById("project-body"), { childList: true });

  // 스모크(--smoke + OPENHUB_SMOKE_INSTALL): 화면과 같은 경로로 계획 → 체크 → 확인 → 결과를 기다린다.
  // clients가 있으면 Client 선택 화면에서 그 Client만 체크한다(없으면 기본 선택 그대로).
  // race가 있으면(OPENHUB_SMOKE_INSTALL_RACE) race.first만 체크하고 [계획 보기]를 누른 직후, 응답을 기다리지 않고 clients로 바꿔 다시 누른다.
  window.__openhubInstall = async (toolId, clients, race) => {
    decorate();
    const card = [...document.querySelectorAll("#for-you-list li.rec")].find((li) => li.dataset.toolId === toolId);
    if (!card) return { status: "not-recommended", stages: [] };
    const options = await open(toolId);
    if (options === null) return { status: "no-plan", stages: [] };
    const choices = [...panel.querySelectorAll(".install-clients input[type=checkbox]")].map((i) => ({ client: i.dataset.client, enabled: !i.disabled, checked: i.checked, verification: i.dataset.verification }));
    if (Array.isArray(clients)) {
      for (const input of panel.querySelectorAll(".install-clients input[type=checkbox]")) {
        input.checked = clients.includes(input.dataset.client);
        input.dispatchEvent(new Event("change"));
      }
    }
    const setChecks = (wanted) => {
      for (const input of panel.querySelectorAll(".install-clients input[type=checkbox]")) {
        input.checked = wanted.includes(input.dataset.client);
        input.dispatchEvent(new Event("change"));
      }
    };
    const reviewButton = panel.querySelector(".install-review");
    if (race && Array.isArray(race.first) && reviewButton) {
      // 첫 계획 요청(A)을 보내고 바로 선택을 바꾼다. A의 응답은 화면에 쓰이지 않아야 한다.
      setChecks(race.first);
      reviewButton.click();
      setChecks(clients || []);
    }
    if (!reviewButton || reviewButton.disabled) return { status: "no-client", stages: [], choices };
    // 사람처럼 [선택한 Client로 계획 보기]를 누르고 계획 화면이 그려질 때까지 기다린다(planState가 planning에서 바뀔 때).
    panel.dataset.planState = "planning";
    const settled = new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (panel.dataset.planState !== "planning") {
          observer.disconnect();
          resolve(panel.dataset.planState);
        }
      });
      observer.observe(panel, { attributes: true, attributeFilter: ["data-plan-state"] });
    });
    reviewButton.click();
    const state = await settled;
    if (state.startsWith("failed:")) return { status: state.slice("failed:".length), stages: [], choices };
    const previewLines = panel.querySelector(".install-preview").textContent.split("\n").length;
    const targets = [...panel.querySelectorAll(".install-targets li")].map((li) => li.textContent);
    if (state === "already-installed") return { status: "no-op", stages: [], choices, targets };
    for (const box of panel.querySelectorAll('.install-requirements input[type="checkbox"]')) {
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    }
    const confirm = panel.querySelector(".install-confirm");
    if (!confirm || confirm.disabled) return { status: "not-executable", stages: [], choices, targets };
    confirm.disabled = true;
    const result = await run(toolId);
    return { status: result.status, stages: (result.stages || []).map((s) => s.name + ":" + s.value), preview: previewLines, choices, targets, configChanges: result.configChanges || [] };
  };
})();
