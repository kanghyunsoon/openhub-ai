// Release·Impact(TASK-057): INSTALLED 항목에 [릴리스 확인]을 붙인다. 누르면 main이 비인증으로 release를 조회해
// 최신 버전·Update available·Impact 등급·이유·결정론 요약·release notes(텍스트)·링크(텍스트)를 돌려준다.
// [업데이트 계획]은 같은 항목의 M5 [업데이트 계획] 버튼을 눌러 기존 Lifecycle 계획·승인 화면으로 잇는다.
// PINOKIO 카드: Plan Preview와 제3자 script Preview만 보여 준다(실행 버튼 없음).
// 모든 외부 문자열은 textContent로만 넣는다. timer·polling이 없고 network는 버튼을 눌렀을 때만이다.
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

  const list = document.getElementById("lifecycle-list");

  function renderView(li, view) {
    const box = el("div", "release-view");
    box.append(el("p", "entry-title", view.title));
    box.append(el("p", "entry-line", t("release.versions", { current: view.current, latest: view.latest, available: view.updateAvailable ? t("release.updateAvailable") : "" })));
    box.append(el("p", view.impact.status === "OK" ? "entry-line" : "install-warning", t("release.impact", { verdict: view.impact.verdict, status: view.impact.status })));
    for (const reason of view.impact.reasons) box.append(el("p", "entry-line", "  - " + reason));
    const summary = el("div", "release-summary");
    for (const s of view.summary) {
      summary.append(el("p", "entry-line", t("release.summaryLine", { label: s.label, count: s.count })));
      for (const item of s.items) summary.append(el("p", "entry-line release-item", "    " + item));
    }
    box.append(summary);
    if (view.notes) {
      box.append(el("p", "entry-line", t("release.notesTitle", { version: view.notes.version })));
      box.append(el("pre", "release-notes", view.notes.lines.join("\n") + (view.notes.more > 0 ? "\n" + t("release.notesMore", { count: view.notes.more }) : "")));
    }
    if (view.url) box.append(el("p", "entry-line release-link", t("release.link", { url: view.url })));
    box.append(el("p", "todo", t("release.notApproval")));
    const plan = li.querySelector(".lifecycle-update");
    if (plan) box.append(button("release-plan", t("release.plan"), () => plan.click()));
    li.append(box);
  }

  async function check(li) {
    const old = li.querySelector(".release-view, .release-status");
    if (old) old.remove();
    const status = el("p", "release-status", t("release.checking"));
    li.append(status);
    const response = await window.openhubRelease.checkRelease(li.dataset.entryId);
    if (response.status !== "ok") {
      status.textContent = t("release.checkFailed", { message: response.message || response.status });
      return response;
    }
    status.remove();
    renderView(li, response.view);
    return response;
  }

  function decorate() {
    for (const li of list.querySelectorAll("li.entry")) {
      if (li.querySelector(".release-check") || !li.querySelector(".lifecycle-update")) continue;
      const actions = li.querySelector(".entry-actions");
      if (actions) actions.append(button("release-check", t("release.check"), () => void check(li)));
    }
  }
  // INSTALLED 목록이 다시 그려질 때만 버튼을 붙인다(timer·polling 없음).
  new MutationObserver(decorate).observe(list, { childList: true });

  const panel = document.getElementById("pinokio-panel");
  function show(nodes) {
    panel.replaceChildren(...nodes);
    panel.hidden = nodes.length === 0;
  }
  function field(label, value) {
    const wrap = el("label", "field", label + " ");
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = value;
    wrap.append(input);
    return { wrap, input };
  }
  // PINOKIO 카드 입력·버튼은 여기서 만든다. 미리보기 버튼 두 개뿐이고 실행 버튼은 없다.
  const toolField = field(t("pinokio.toolField"), "");
  const refField = field(t("pinokio.refField"), "");
  const pathField = field(t("pinokio.pathField"), "install.js");
  const previewButton = button("pinokio-preview", t("pinokio.preview"), () => void preview());
  const inspectButton = button("pinokio-inspect", t("pinokio.inspect"), () => void inspect());
  document.getElementById("pinokio-body").append(toolField.wrap, previewButton, refField.wrap, pathField.wrap, inspectButton);
  async function preview() {
    show([el("p", "todo", t("pinokio.planning"))]);
    const response = await window.openhubRelease.previewPinokio(toolField.input.value);
    if (response.status !== "ok") return show([el("p", "install-warning", t("pinokio.planFailed", { message: response.message || response.code }))]);
    show([el("pre", "install-preview", response.lines.join("\n"))]);
  }
  async function inspect() {
    show([el("p", "todo", t("pinokio.fetching"))]);
    const response = await window.openhubRelease.inspectPinokio(refField.input.value, pathField.input.value);
    if (response.status !== "ok") return show([el("p", "install-warning", t("pinokio.inspectFailed", { message: response.message || response.code }))]);
    const p = response.preview;
    show([el("p", "entry-title", p.title), el("pre", "install-preview", p.lines.join("\n")), el("p", "install-warning", t("pinokio.staticWarnings", { warnings: p.warnings.length === 0 ? t("common.none") : p.warnings.join(", ") })), el("p", "todo", p.notice)]);
  }

  // 스모크(--smoke + OPENHUB_SMOKE_RELEASE): 화면과 같은 경로로 [릴리스 확인]을 누르고 텍스트 렌더링을 확인한다.
  window.__openhubRelease = async (toolId) => {
    decorate();
    const li = [...list.querySelectorAll("li.entry")].find((x) => x.dataset.toolId === toolId);
    if (!li) return { status: "not-managed", impact: "", notesText: false, innerHtml: 0 };
    const response = await check(li);
    const notes = li.querySelector(".release-notes");
    return {
      status: response.status,
      impact: response.status === "ok" ? response.view.impact.verdict : "",
      notesText: Boolean(notes && notes.textContent.includes("<script>") && notes.querySelector("script") === null),
      innerHtml: li.querySelectorAll(".release-view script").length,
    };
  };
})();

