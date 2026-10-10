// INSTALLED의 Adopt·Benchmark(TASK-070).
// - Adopt: OpenHub가 관리하지 않는 project 설정 중 exact·strong으로 식별되고 표현 가능한 항목에만 버튼이 있다(strong은 표시).
//   weak·unresolved에는 버튼이 없다. 승인은 main process 네이티브 대화상자에서만 만들어지고 설정 파일은 바뀌지 않는다.
// - Benchmark: 관리 항목마다 "승인이 필요한 실행" 버튼. artifact-unlocked 등 blocked면 비활성 + 이유.
//   결과는 median·min·max·실패 수뿐이다. renderer는 항목 id 하나만 보낸다. timer·polling 없음, textContent만.
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
  const status = document.getElementById("adopt-status");
  const list = document.getElementById("adopt-list");
  const panel = document.getElementById("adopt-panel");
  const installed = document.getElementById("lifecycle-list");
  let targets = [];

  function show(nodes) {
    panel.replaceChildren(...nodes);
    panel.hidden = nodes.length === 0;
  }

  function candidate(item) {
    const li = el("li", "entry");
    li.dataset.entryId = item.id;
    li.dataset.toolId = item.toolId;
    li.append(el("p", "entry-title", item.title));
    if (item.grade === "strong") li.append(el("p", "entry-warning", t("adopt.strong")));
    li.append(el("pre", "install-preview", item.lines.join("\n")));
    li.append(button("adopt-run", t("adopt.run"), () => void adopt(item.id)));
    return li;
  }

  async function adopt(id) {
    show([el("p", "todo", t("adopt.waiting"))]);
    const r = await window.openhubDiscover.runAdopt(id);
    if (r.status === "rejected") return show([el("p", "todo", t("adopt.rejected"))]);
    if (r.status === "blocked") return show([el("pre", "install-preview", r.lines.join("\n"))]);
    if (r.status !== "done") return show([el("p", "install-warning", t("adopt.failed", { message: r.message || r.status }))]);
    show([el("pre", "install-preview", r.lines.join("\n"))]);
    if (r.adopted) document.dispatchEvent(new CustomEvent("openhub:installed-changed"));
  }

  async function benchmark(id) {
    show([el("p", "todo", t("benchmark.waiting"))]);
    const r = await window.openhubDiscover.runBenchmark(id);
    if (r.status === "rejected") return show([el("p", "todo", t("benchmark.rejected"))]);
    if (r.status === "blocked") return show([el("pre", "install-preview", r.lines.join("\n"))]);
    if (r.status !== "done") return show([el("p", "install-warning", t("benchmark.failed", { message: r.message || r.status }))]);
    show([el("h3", "", t("benchmark.resultTitle")), el("pre", "install-preview", r.lines.join("\n"))]);
  }

  // INSTALLED 관리 항목에 Benchmark 버튼을 붙인다(목록이 다시 그려지거나 대상이 바뀔 때만).
  function decorate() {
    for (const li of installed.querySelectorAll("li.entry")) {
      for (const old of li.querySelectorAll(".benchmark-run, .benchmark-reason")) old.remove();
      const target = targets.find((x) => x.id === li.dataset.entryId);
      if (!target) continue;
      const b = button("benchmark-run", t("benchmark.run"), () => void benchmark(target.id));
      b.disabled = !target.ready;
      li.append(b);
      if (!target.ready) for (const reason of target.reasons) li.append(el("p", "entry-warning benchmark-reason", t("benchmark.blocked", { reason })));
    }
  }
  new MutationObserver(decorate).observe(installed, { childList: true });

  async function refresh() {
    const r = await window.openhubDiscover.adoptCandidates();
    if (r.status !== "ok") {
      targets = [];
      list.replaceChildren();
      status.textContent = r.status === "no-project" ? t("adopt.prompt") : r.message || r.status;
      return r;
    }
    targets = r.benchmark;
    list.replaceChildren(...r.items.map(candidate));
    status.textContent = r.items.length === 0 ? t("adopt.none") : t("adopt.count", { count: r.items.length });
    decorate();
    return r;
  }
  new MutationObserver(() => void refresh()).observe(document.getElementById("project-body"), { childList: true });
  document.addEventListener("openhub:installed-changed", () => void refresh());
})();
