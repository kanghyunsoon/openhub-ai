// INSTALLED의 Adopt·Benchmark(TASK-070).
// - Adopt: OpenHub가 관리하지 않는 project 설정 중 exact·strong으로 식별되고 표현 가능한 항목에만 버튼이 있다(strong은 표시).
//   weak·unresolved에는 버튼이 없다. 승인은 main process 네이티브 대화상자에서만 만들어지고 설정 파일은 바뀌지 않는다.
// - Benchmark: 관리 항목마다 "승인이 필요한 실행" 버튼. artifact-unlocked 등 blocked면 비활성 + 이유.
//   결과는 median·min·max·실패 수뿐이다. renderer는 항목 id 하나만 보낸다. timer·polling 없음, textContent만.
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
    if (item.grade === "strong") li.append(el("p", "entry-warning", "strong 식별: 설정 이름은 다르지만 package·image가 Registry 도구와 일치합니다"));
    li.append(el("pre", "install-preview", item.lines.join("\n")));
    li.append(button("adopt-run", "Adopt (승인 필요)", () => void adopt(item.id)));
    return li;
  }

  async function adopt(id) {
    show([el("p", "todo", "확인 대화상자에서 승인하면 Version State에만 등록합니다…")]);
    const r = await window.openhubDiscover.runAdopt(id);
    if (r.status === "rejected") return show([el("p", "todo", "승인하지 않아 중단했습니다. 아무것도 바꾸지 않았습니다.")]);
    if (r.status === "blocked") return show([el("pre", "install-preview", r.lines.join("\n"))]);
    if (r.status !== "done") return show([el("p", "install-warning", "Adopt할 수 없습니다: " + (r.message || r.status))]);
    show([el("pre", "install-preview", r.lines.join("\n"))]);
    if (r.adopted) document.dispatchEvent(new CustomEvent("openhub:installed-changed"));
  }

  async function benchmark(id) {
    show([el("p", "todo", "확인 대화상자에서 승인하면 MCP 서버를 6번 실행합니다(tool 호출 없음)…")]);
    const r = await window.openhubDiscover.runBenchmark(id);
    if (r.status === "rejected") return show([el("p", "todo", "승인하지 않아 실행하지 않았습니다.")]);
    if (r.status === "blocked") return show([el("pre", "install-preview", r.lines.join("\n"))]);
    if (r.status !== "done") return show([el("p", "install-warning", "Benchmark할 수 없습니다: " + (r.message || r.status))]);
    show([el("h3", "", "Benchmark 결과"), el("pre", "install-preview", r.lines.join("\n"))]);
  }

  // INSTALLED 관리 항목에 Benchmark 버튼을 붙인다(목록이 다시 그려지거나 대상이 바뀔 때만).
  function decorate() {
    for (const li of installed.querySelectorAll("li.entry")) {
      for (const old of li.querySelectorAll(".benchmark-run, .benchmark-reason")) old.remove();
      const t = targets.find((x) => x.id === li.dataset.entryId);
      if (!t) continue;
      const b = button("benchmark-run", "Benchmark · 승인이 필요한 실행(MCP 서버 6번 실행, tool 호출 없음)", () => void benchmark(t.id));
      b.disabled = !t.ready;
      li.append(b);
      if (!t.ready) for (const reason of t.reasons) li.append(el("p", "entry-warning benchmark-reason", "Benchmark 불가: " + reason));
    }
  }
  new MutationObserver(decorate).observe(installed, { childList: true });

  async function refresh() {
    const r = await window.openhubDiscover.adoptCandidates();
    if (r.status !== "ok") {
      targets = [];
      list.replaceChildren();
      status.textContent = r.status === "no-project" ? "프로젝트를 선택하면 OpenHub가 관리하지 않는 설정 중 식별된 항목을 보여줍니다." : r.message || r.status;
      return r;
    }
    targets = r.benchmark;
    list.replaceChildren(...r.items.map(candidate));
    status.textContent = r.items.length === 0 ? "Adopt할 수 있는 미관리 항목이 없습니다(weak·미식별 항목은 Adopt하지 않습니다)." : "Adopt 가능 " + r.items.length + "개";
    decorate();
    return r;
  }
  new MutationObserver(() => void refresh()).observe(document.getElementById("project-body"), { childList: true });
  document.addEventListener("openhub:installed-changed", () => void refresh());
})();
