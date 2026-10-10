// AI Summary(TASK-063, D-030): [릴리스 확인] 결과 아래에 model 입력과 [AI Summary] 버튼을 붙인다.
// 누를 때만 main process가 OPENAI_API_KEY를 읽어 호출한다(이 화면은 key를 받지도 보내지도 않는다).
// 결과·오류는 textContent로만 넣는다. 실패해도 결정론 요약은 그대로다. timer·polling이 없다.
(() => {
  const t = window.openhubI18n.t;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  let model = "";
  const list = document.getElementById("lifecycle-list");
  function attach(view) {
    if (view.querySelector(".ai-summary")) return;
    const li = view.closest("li.entry");
    if (!li) return;
    const box = el("div", "ai-summary");
    const label = el("label", "field", t("ai.model") + " ");
    const input = document.createElement("input");
    input.type = "text";
    input.autocomplete = "off";
    input.spellcheck = false;
    input.value = model;
    input.addEventListener("input", () => (model = input.value));
    label.append(input);
    const out = el("pre", "ai-summary-text");
    out.hidden = true;
    const note = el("p", "todo", t("ai.note"));
    const run = el("button", "ai-summary-run", t("ai.run"));
    run.type = "button";
    run.addEventListener("click", async () => {
      out.hidden = false;
      out.textContent = t("ai.requesting");
      const r = await window.openhubAi.aiSummary(li.dataset.entryId, input.value);
      out.textContent = r.status === "ok" ? t("ai.result", { model: r.model }) + "\n" + r.text : r.message;
    });
    box.append(label, run, note, out);
    view.append(box);
  }
  new MutationObserver(() => {
    for (const view of list.querySelectorAll(".release-view")) attach(view);
  }).observe(list, { childList: true, subtree: true });
})();

