// Release·Impact(TASK-057): INSTALLED 항목에 [릴리스 확인]을 붙인다. 누르면 main이 비인증으로 release를 조회해
// 최신 버전·Update available·Impact 등급·이유·결정론 요약·release notes(텍스트)·링크(텍스트)를 돌려준다.
// [업데이트 계획]은 같은 항목의 M5 [업데이트 계획] 버튼을 눌러 기존 Lifecycle 계획·승인 화면으로 잇는다.
// PINOKIO 카드: Plan Preview와 제3자 script Preview만 보여 준다(실행 버튼 없음).
// 모든 외부 문자열은 textContent로만 넣는다. timer·polling이 없고 network는 버튼을 눌렀을 때만이다.
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

  const list = document.getElementById("lifecycle-list");

  function renderView(li, view) {
    const box = el("div", "release-view");
    box.append(el("p", "entry-title", view.title));
    box.append(el("p", "entry-line", "현재 " + view.current + " · 최신 " + view.latest + (view.updateAvailable ? " · 업데이트 있음" : "")));
    box.append(el("p", view.impact.status === "OK" ? "entry-line" : "install-warning", "Impact: " + view.impact.verdict + " (" + view.impact.status + ")"));
    for (const reason of view.impact.reasons) box.append(el("p", "entry-line", "  - " + reason));
    const summary = el("div", "release-summary");
    for (const s of view.summary) {
      summary.append(el("p", "entry-line", s.label + " " + s.count));
      for (const item of s.items) summary.append(el("p", "entry-line release-item", "    " + item));
    }
    box.append(summary);
    if (view.notes) {
      box.append(el("p", "entry-line", "Release notes " + view.notes.version + " (원문, 해석하지 않음)"));
      box.append(el("pre", "release-notes", view.notes.lines.join("\n") + (view.notes.more > 0 ? "\n… " + view.notes.more + "줄 더" : "")));
    }
    if (view.url) box.append(el("p", "entry-line release-link", "링크(텍스트): " + view.url));
    box.append(el("p", "todo", "Impact·요약은 판단 근거이며 승인이 아닙니다."));
    const plan = li.querySelector(".lifecycle-update");
    if (plan) box.append(button("release-plan", "업데이트 계획", () => plan.click()));
    li.append(box);
  }

  async function check(li) {
    const old = li.querySelector(".release-view, .release-status");
    if (old) old.remove();
    const status = el("p", "release-status", "릴리스 확인 중…");
    li.append(status);
    const response = await window.openhubRelease.checkRelease(li.dataset.entryId);
    if (response.status !== "ok") {
      status.textContent = "릴리스를 확인할 수 없습니다: " + (response.message || response.status);
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
      if (actions) actions.append(button("release-check", "릴리스 확인", () => void check(li)));
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
  const toolField = field("Registry 도구 ID", "");
  const refField = field("제3자 script owner/repo@commit", "");
  const pathField = field("script 경로", "install.js");
  const previewButton = button("pinokio-preview", "Pinokio 계획 미리보기", () => void preview());
  const inspectButton = button("pinokio-inspect", "제3자 script 미리보기", () => void inspect());
  document.getElementById("pinokio-body").append(toolField.wrap, previewButton, refField.wrap, pathField.wrap, inspectButton);
  async function preview() {
    show([el("p", "todo", "Pinokio 계획을 만드는 중…")]);
    const response = await window.openhubRelease.previewPinokio(toolField.input.value);
    if (response.status !== "ok") return show([el("p", "install-warning", "계획을 만들 수 없습니다: " + (response.message || response.code))]);
    show([el("pre", "install-preview", response.lines.join("\n"))]);
  }
  async function inspect() {
    show([el("p", "todo", "제3자 script를 가져오는 중…")]);
    const response = await window.openhubRelease.inspectPinokio(refField.input.value, pathField.input.value);
    if (response.status !== "ok") return show([el("p", "install-warning", "미리 볼 수 없습니다: " + (response.message || response.code))]);
    const p = response.preview;
    show([el("p", "entry-title", p.title), el("pre", "install-preview", p.lines.join("\n")), el("p", "install-warning", "정적 경고: " + (p.warnings.length === 0 ? "없음" : p.warnings.join(", "))), el("p", "todo", p.notice)]);
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

