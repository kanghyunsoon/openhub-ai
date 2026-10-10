// Lifecycle(TASK-046): INSTALLED 카드. 상태 → [업데이트 확인]·[업데이트 계획]·[Health Check]·[이전 버전으로 롤백]
// → Preview → 승인 항목 체크 → (main 프로세스 네이티브 확인 대화상자) → 진행 → 결과.
// [복구 계획 확인](v0.2.0): main이 Core로 ready Repair Plan을 만들 수 있다고 알려 준 항목(canRepair)에만 보인다.
// renderer는 state entry id 하나만 보낸다. Plan·digest·승인을 보내지 않는다. timer·polling이 없고
// 업데이트 확인(network)은 버튼을 눌렀을 때만 한다. 모든 문자열은 textContent로만 넣는다.
// skip된 Health는 Core 문장 그대로 "Health: Not verified"로 보인다.
(() => {
  const t = window.openhubI18n.t;
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

  const statusEl = document.getElementById("lifecycle-status");
  const list = document.getElementById("lifecycle-list");
  const panel = document.getElementById("lifecycle-panel");
  const PLANNERS = {
    update: (id) => window.openhub.planLifecycleUpdate(id),
    rollback: (id) => window.openhub.planLifecycleRollback(id),
    health: (id) => window.openhub.planLifecycleHealth(id),
    repair: (id) => window.openhub.planLifecycleRepair(id),
  };
  const TITLE = { update: t("lifecycle.op.update"), rollback: t("lifecycle.op.rollback"), health: t("lifecycle.op.health"), repair: t("lifecycle.op.repair") };
  let current = null;
  // 사용자 범위 보기(v0.2.0 P0-3 C2): 사용자가 켜거나 사용자 범위 설치를 마쳤을 때만 main이 사용자 설정을 읽는다.
  let showUser = false;
  const userToggle = button("lifecycle-user-toggle", t("lifecycle.userToggle.show"), () => {
    showUser = !showUser;
    void refresh({ includeUser: showUser });
  });
  userToggle.setAttribute("aria-pressed", "false");
  list.before(userToggle);
  const syncToggle = () => {
    userToggle.textContent = t(showUser ? "lifecycle.userToggle.hide" : "lifecycle.userToggle.show");
    userToggle.setAttribute("aria-pressed", String(showUser));
  };

  function show(children) {
    panel.replaceChildren(...children);
    panel.hidden = children.length === 0;
    if (!panel.hidden) panel.scrollIntoView({ block: "start" });
  }

  function renderEntry(item) {
    const li = el("li", "entry");
    li.dataset.entryId = item.id;
    li.dataset.scope = item.scope;
    li.dataset.toolId = item.toolId || "";
    li.append(el("p", "entry-title", item.title));
    for (const line of item.lines) li.append(el("p", line.trim().startsWith("Health:") || line.trim().startsWith("Reason:") ? "entry-line entry-health" : "entry-line", line));
    if (item.warning) li.append(el("p", "entry-warning", item.warning));
    const actions = el("div", "entry-actions");
    if (item.canUpdate) {
      actions.append(button("lifecycle-check", t("lifecycle.check"), () => void check(item.id, li)));
      actions.append(button("lifecycle-update", t("lifecycle.planUpdate"), () => void open("update", item.id)));
    }
    if (item.canHealth) actions.append(button("lifecycle-health", t("lifecycle.health"), () => void open("health", item.id)));
    if (item.canRollback) actions.append(button("lifecycle-rollback", t("lifecycle.rollback"), () => void open("rollback", item.id)));
    if (item.canRepair) actions.append(button("lifecycle-repair", t("lifecycle.repair"), () => void open("repair", item.id)));
    if (actions.childElementCount > 0) li.append(actions);
    return li;
  }

  /** options: { includeUser }(토글을 바꿀 때만). 없으면 main의 지금 설정 그대로 다시 읽는다. */
  async function refresh(options) {
    const response = await window.openhub.lifecycleStatus(options);
    if (response.status === "no-project") {
      statusEl.textContent = t("lifecycle.prompt");
      list.replaceChildren();
      return response;
    }
    if (response.status !== "ok") {
      // 손상·미지원 Version State: 경고만 보여 주고 실행 버튼을 만들지 않는다.
      statusEl.textContent = response.message || response.status;
      statusEl.className = "install-warning";
      list.replaceChildren();
      return response;
    }
    statusEl.className = "todo";
    statusEl.textContent = response.items.length === 0 ? t("lifecycle.empty") : response.note;
    showUser = response.includeUser === true;
    syncToggle();
    // Project·User 범위를 나눠 보여 준다(같은 도구가 두 범위에 있으면 항목이 따로 보이고 실제 변경 대상도 따로다).
    const nodes = [];
    for (const scope of ["project", "user"]) {
      const items = response.items.filter((i) => i.scope === scope);
      if (items.length === 0) continue;
      const header = el("li", "lifecycle-group group-" + scope, t(scope === "user" ? "lifecycle.group.user" : "lifecycle.group.project"));
      header.dataset.scopeHeader = scope;
      nodes.push(header, ...items.map(renderEntry));
    }
    list.replaceChildren(...nodes);
    return response;
  }

  async function check(id, li) {
    const old = li.querySelector(".entry-check");
    if (old) old.remove();
    const line = el("p", "entry-check", t("lifecycle.checking"));
    li.append(line);
    const response = await window.openhub.checkLifecycle(id);
    line.textContent = response.status === "ok" ? response.view.message : t("lifecycle.checkFailed", { message: response.message || response.status });
    return response;
  }

  function renderResult(result) {
    const nodes = [el("h3", "", t("lifecycle.resultTitle", { status: result.status, code: result.code ? " (" + result.code + ")" : "" }))];
    nodes[0].dataset.status = result.status;
    // 성공·실패·부분 실패·실행 안 함을 한 줄로 먼저 보여 준다(Health 실패를 성공으로 보이지 않는다).
    if (result.summary) nodes.push(el("p", "lifecycle-outcome outcome-" + result.outcome, result.summary));
    for (const line of result.lines) nodes.push(el("p", line.trim().startsWith("-") ? "install-warning" : "install-change", line));
    show(nodes);
    void refresh();
    return result;
  }

  async function run(operation, id) {
    const status = el("p", "todo", t("lifecycle.waiting"));
    panel.append(status);
    const response = await window.openhub.runLifecycle(id);
    if (response.status === "rejected") {
      status.textContent = t("lifecycle.rejected");
      status.dataset.runDone = "1";
      return { status: "rejected", health: [] };
    }
    if (response.status !== "done") {
      status.textContent = t("lifecycle.cannotRun", { message: response.message || response.status });
      status.dataset.runDone = "1";
      return { status: response.status, health: [] };
    }
    if (response.result.reapprove) {
      // PLAN_STALE: 새 계획을 다시 보여 주고 재승인을 받는다.
      const view = await open(operation, id);
      panel.prepend(el("p", "install-warning", t("lifecycle.stale", { changed: response.result.changed.join(", ") })));
      return { status: "stale", health: [], reopened: view !== null };
    }
    status.textContent = t("lifecycle.progress");
    return renderResult(response.result);
  }

  function renderPlan(view) {
    const nodes = [el("h3", "", t("lifecycle.planTitle", { name: view.displayName, operation: TITLE[view.operation] }))];
    nodes.push(el("pre", "install-preview", view.previewLines.join("\n")));
    if (view.upToDate) {
      nodes.push(el("p", "todo", t("lifecycle.upToDate")));
      show(nodes);
      return;
    }
    if (!view.executable) {
      nodes.push(el("p", "install-warning", t("lifecycle.notExecutable", { status: view.status })));
      show(nodes);
      return;
    }
    const boxes = [];
    const requirementList = el("div", "install-requirements");
    for (const r of view.requirements) {
      const label = el("label", "requirement");
      const box = document.createElement("input");
      box.type = "checkbox";
      box.dataset.requirement = r.id;
      label.append(box, el("span", "", t("requirement.line", { id: r.id, message: r.message })));
      requirementList.append(label);
      boxes.push(box);
    }
    const confirm = el("button", "lifecycle-confirm", t("lifecycle.openDialog"));
    confirm.type = "button";
    confirm.disabled = true;
    const update = () => {
      confirm.disabled = !boxes.every((b) => b.checked);
    };
    for (const b of boxes) b.addEventListener("change", update);
    confirm.addEventListener("click", () => {
      confirm.disabled = true;
      void run(view.operation, view.id);
    });
    nodes.push(requirementList, confirm);
    show(nodes);
  }

  async function open(operation, id) {
    current = operation + ":" + id;
    show([el("p", "todo", t("lifecycle.planning", { operation: TITLE[operation] }))]);
    const response = await PLANNERS[operation](id);
    if (current !== operation + ":" + id) return null;
    if (response.status !== "ok") {
      show([el("p", "install-warning", t("lifecycle.planFailed", { message: response.message || response.status }))]);
      return null;
    }
    renderPlan(response.view);
    return response.view;
  }

  // 프로젝트 분석 결과가 다시 그려질 때(사용자가 [프로젝트 선택]을 눌렀을 때)만 상태를 읽는다. timer·polling 없음.
  new MutationObserver(() => void refresh()).observe(document.getElementById("project-body"), { childList: true });
  // Adopt가 Version State에 항목을 등록하면(TASK-070) 같은 화면을 다시 읽는다. timer·polling 없음.
  // 사용자 범위 설치를 마쳤으면(detail.userScope) 사용자 범위 보기를 켠다(사용자가 고른 동작의 결과).
  document.addEventListener("openhub:installed-changed", (event) => void refresh(event.detail && event.detail.userScope ? { includeUser: true } : undefined));

  // 스모크(--smoke + OPENHUB_SMOKE_UPDATE): 화면과 같은 경로로 상태 → 업데이트 계획 → 체크 → 확인 → 결과를 기다린다.
  window.__openhubLifecycle = async (toolId) => {
    await refresh();
    const li = [...list.querySelectorAll("li.entry")].find((x) => x.dataset.toolId === toolId);
    if (!li) return { status: "not-managed", health: [] };
    const updateButton = li.querySelector(".lifecycle-update");
    if (!updateButton) return { status: "not-updatable", health: [] };
    const view = await open("update", li.dataset.entryId);
    if (view === null) return { status: "no-plan", health: [] };
    for (const box of panel.querySelectorAll('input[type="checkbox"]')) {
      box.checked = true;
      box.dispatchEvent(new Event("change"));
    }
    const confirm = panel.querySelector(".lifecycle-confirm");
    if (!confirm || confirm.disabled) return { status: view.upToDate ? "up-to-date" : "not-executable", health: [] };
    confirm.disabled = true;
    const result = await run("update", li.dataset.entryId);
    await refresh();
    const after = [...list.querySelectorAll("li.entry")].find((x) => x.dataset.toolId === toolId);
    return { status: result.status, health: result.health || [], preview: view.previewLines.length, rollbackButton: Boolean(after && after.querySelector(".lifecycle-rollback")) };
  };

  /** root 아래 DOM이 바뀔 때마다 predicate를 다시 보고, 값이 생기면 그 값으로 끝난다(timer 없음). */
  function waitFor(root, predicate) {
    return new Promise((resolve) => {
      const first = predicate();
      if (first) return resolve(first);
      const observer = new MutationObserver(() => {
        const value = predicate();
        if (value) {
          observer.disconnect();
          resolve(value);
        }
      });
      observer.observe(root, { childList: true, subtree: true, characterData: true, attributes: true });
    });
  }

  // 스모크(--smoke + OPENHUB_SMOKE_REPAIR): 사람이 하는 것과 같은 DOM 조작만 쓴다. 실제 [복구 계획 확인] click → 승인 항목 checkbox
  // click(change 이벤트) → 확인 버튼 click → (preload → main IPC → 승인 → Core 실행) → 결과 렌더링을 기다린 뒤 상태를 다시 읽는다.
  // 내부 open()·run()을 직접 부르지 않는다. main 스모크는 가짜 npm(cache 항목만)·가짜 Health를 쓴다.
  window.__openhubRepair = async (toolId) => {
    await refresh();
    const li = [...list.querySelectorAll("li.entry")].find((x) => x.dataset.toolId === toolId && x.querySelector(".lifecycle-repair"));
    if (!li) return { status: "no-repair-button", states: [...list.querySelectorAll("li.entry")].map((x) => x.dataset.entryId) };
    li.querySelector(".lifecycle-repair").click();
    const ready = await waitFor(panel, () => panel.querySelector(".lifecycle-confirm") || panel.querySelector(".install-warning"));
    if (!ready.classList.contains("lifecycle-confirm")) return { status: "not-executable", message: ready.textContent };
    const preview = (panel.querySelector(".install-preview")?.textContent || "").split("\n").length;
    const boxes = [...panel.querySelectorAll('input[type="checkbox"]')];
    const disabledBefore = ready.disabled;
    for (const box of boxes) box.click();
    if (ready.disabled) return { status: "not-executable", boxes: boxes.length };
    ready.click();
    const done = await waitFor(panel, () => panel.querySelector(".lifecycle-outcome") || panel.querySelector('[data-run-done="1"]'));
    const heading = panel.querySelector("h3");
    const after = await refresh();
    return {
      status: done.classList.contains("lifecycle-outcome") && heading ? heading.dataset.status || "unknown" : "not-run",
      outcome: done.classList.contains("lifecycle-outcome") ? [...done.classList].find((c) => c.startsWith("outcome-")).slice("outcome-".length) : done.textContent,
      health: [...panel.querySelectorAll(".install-change")].map((p) => p.textContent.trim()).filter((t) => t.startsWith("Health:")),
      preview,
      boxes: boxes.length,
      confirmDisabledBeforeChecks: disabledBefore,
      after: after.items ? after.items.filter((i) => i.toolId === toolId).map((i) => i.state) : [],
    };
  };

  // 스모크(--smoke + OPENHUB_SMOKE_USER_SCOPE): 범위가 scope인 toolId 항목에서 op 버튼 click → 승인 항목 checkbox click → 확인 click →
  // 결과를 기다린다. 사용자 범위면 먼저 [사용자 범위 보기]가 켜질 때까지 기다린다(사용자 범위 설치를 마치면 자동으로 켜진다, 직접 누르지 않는다).
  // timer 없음(AC-046-02): 끝나지 않으면 E2E 테스트의 제한 시간이 멈춘다.
  window.__openhubLifecycleOp = async (toolId, scope, op) => {
    if (scope === "user" && !(await waitFor(userToggle, () => (userToggle.getAttribute("aria-pressed") === "true" ? true : null)))) return { status: "user-scope-not-shown" };
    await refresh();
    const li = [...list.querySelectorAll("li.entry")].find((x) => x.dataset.toolId === toolId && x.dataset.scope === scope && x.querySelector(".lifecycle-" + op));
    if (!li) return { status: "no-" + op + "-button", entries: [...list.querySelectorAll("li.entry")].map((x) => x.dataset.entryId + "=" + (x.querySelector(".entry-warning")?.textContent || "")) };
    li.querySelector(".lifecycle-" + op).click();
    const ready = await waitFor(panel, () => panel.querySelector(".lifecycle-confirm") || panel.querySelector(".install-warning"));
    if (!ready.classList.contains("lifecycle-confirm")) return { status: "not-executable", message: ready.textContent };
    const requirements = [...panel.querySelectorAll('input[type="checkbox"]')].map((b) => b.dataset.requirement);
    for (const box of panel.querySelectorAll('input[type="checkbox"]')) box.click();
    ready.click();
    const done = await waitFor(panel, () => panel.querySelector(".lifecycle-outcome") || panel.querySelector('[data-run-done="1"]'));
    const heading = panel.querySelector("h3");
    const after = await refresh();
    return {
      status: done.classList.contains("lifecycle-outcome") && heading ? heading.dataset.status || "unknown" : "not-run",
      outcome: done.classList.contains("lifecycle-outcome") ? [...done.classList].find((c) => c.startsWith("outcome-")).slice("outcome-".length) : done.textContent,
      requirements,
      after: after.items ? after.items.filter((i) => i.toolId === toolId).map((i) => i.scope + ":" + i.state) : [],
    };
  };

  // 스모크(--smoke + OPENHUB_SMOKE_ROLLBACK): toolId 항목의 op 버튼(rollback·health 등) click → 승인 항목 checkbox click → 확인 click →
  // 결과를 기다린다(사람과 같은 DOM 조작, timer 없음).
  window.__openhubLifecycleRun = async (toolId, op) => {
    await refresh();
    const li = [...list.querySelectorAll("li.entry")].find((x) => x.dataset.toolId === toolId && x.querySelector(".lifecycle-" + op));
    if (!li) return { status: "no-" + op + "-button" };
    li.querySelector(".lifecycle-" + op).click();
    const ready = await waitFor(panel, () => panel.querySelector(".lifecycle-confirm") || panel.querySelector(".install-warning"));
    if (!ready.classList.contains("lifecycle-confirm")) return { status: "not-executable", message: ready.textContent };
    const requirements = [...panel.querySelectorAll('input[type="checkbox"]')].map((b) => b.dataset.requirement);
    for (const box of panel.querySelectorAll('input[type="checkbox"]')) box.click();
    ready.click();
    const done = await waitFor(panel, () => panel.querySelector(".lifecycle-outcome") || panel.querySelector('[data-run-done="1"]'));
    const heading = panel.querySelector("h3");
    const lines = [...panel.querySelectorAll(".install-change, .install-warning")].map((p) => p.textContent.trim());
    const after = await refresh();
    return {
      status: done.classList.contains("lifecycle-outcome") && heading ? heading.dataset.status || "unknown" : "not-run",
      outcome: done.classList.contains("lifecycle-outcome") ? [...done.classList].find((c) => c.startsWith("outcome-")).slice("outcome-".length) : done.textContent,
      requirements,
      lines,
      after: after.items ? after.items.filter((i) => i.toolId === toolId).map((i) => i.state) : [],
    };
  };
})();

