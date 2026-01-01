// DISCOVER(TASK-070): New for your project · Trending · Verified Registry · Unverified Candidates 네 탭.
// 데이터는 window.openhubDiscover.discoverView()로만 받는다(인자 없음, network 0). 기존 Star 순 목록(#tools)은 Verified Registry 탭이다.
// Candidate 카드에는 UNVERIFIED·DRAFT 배지와 [Prepare contribution package]만 있고 설치·Adopt·업데이트 버튼은 없다.
// 비신뢰 문자열(Candidate 설명·설치 문구)은 textContent로만 넣는다. timer·polling 없음.
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

  const TABS = [
    ["new", "New for your project"],
    ["trending", "Trending"],
    ["verified", "Verified Registry"],
    ["candidates", "Unverified Candidates"],
  ];
  const tabBar = document.getElementById("discover-tabs");
  const status = document.getElementById("discover-status");
  const panels = [...document.querySelectorAll("#discover .tab-panel")];

  function select(tab) {
    for (const p of panels) p.hidden = p.dataset.tab !== tab;
    for (const b of tabBar.querySelectorAll("button.tab")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  }
  tabBar.replaceChildren(
    ...TABS.map(([tab, label]) => {
      const b = button("tab", label, () => select(tab));
      b.dataset.tab = tab;
      b.setAttribute("role", "tab");
      return b;
    }),
  );
  select("verified");

  function detailButton(toolId) {
    return button("detail-open", "상세", () => document.dispatchEvent(new CustomEvent("openhub:tool-detail", { detail: toolId })));
  }
  function toolItem(item) {
    const li = el("li", "discover-item");
    li.dataset.toolId = item.toolId;
    li.append(el("p", "entry-title", item.title), el("p", "entry-line", item.line), detailButton(item.toolId));
    return li;
  }
  function candidateItem(c) {
    const li = el("li", "discover-item candidate");
    li.dataset.candidateId = c.id;
    const badges = el("div", "badges");
    for (const b of c.badges) badges.append(el("span", "badge unverified", b));
    li.append(badges, el("p", "entry-title", c.id), el("p", "entry-line", c.line));
    if (c.untrusted.description !== null) li.append(el("p", "untrusted-label", "설명(비신뢰, 원문 텍스트)"), el("p", "untrusted", c.untrusted.description));
    if (c.untrusted.installText !== null) li.append(el("p", "untrusted-label", "설치 문구(비신뢰, 실행하지 않음)"), el("pre", "untrusted", c.untrusted.installText));
    if (c.evidence.length > 0) {
      const ev = el("ul", "install-next");
      for (const e of c.evidence) ev.append(el("li", "", e));
      li.append(el("p", "untrusted-label", "근거"), ev);
    }
    if (c.actions.includes("prepare-contribution")) li.append(button("candidate-prepare", "Prepare contribution package", () => void prepare(c.id)));
    return li;
  }

  async function prepare(id) {
    const out = document.getElementById("candidate-result");
    out.textContent = "저장할 폴더를 고르세요…";
    const r = await window.openhubDiscover.prepareCandidate(id);
    if (r.status === "cancelled") out.textContent = "취소했습니다. 아무것도 쓰지 않았습니다.";
    else if (r.status !== "ok") out.textContent = "만들 수 없습니다: " + (r.message || r.code);
    else out.textContent = "기여 패키지 " + r.files.length + "개 파일을 만들었습니다. " + r.note;
    return r;
  }

  function fill(listId, nodes, empty) {
    const list = document.getElementById(listId);
    list.replaceChildren(...(nodes.length === 0 ? [el("li", "todo", empty)] : nodes));
  }

  // Verified Registry(기존 Star 순 목록)에 [상세] 버튼을 붙인다. 목록이 다시 그려질 때만(timer 없음).
  const tools = document.getElementById("tools");
  function decorateVerified() {
    for (const li of tools.querySelectorAll("li.tool")) if (!li.querySelector(".detail-open") && li.dataset.toolId) li.append(detailButton(li.dataset.toolId));
  }
  new MutationObserver(decorateVerified).observe(tools, { childList: true });

  let sequence = 0;
  async function load() {
    const mine = ++sequence;
    status.textContent = "DISCOVER 불러오는 중…";
    const r = await window.openhubDiscover.discoverView();
    if (mine !== sequence) return r;
    if (r.status !== "ok") {
      status.textContent = r.message || r.status;
      return r;
    }
    const s = r.sections;
    fill("discover-new-list", s.newForProject.map(toolItem), "프로젝트를 고르면 이 프로젝트에 맞는 새 도구를 보여줍니다.");
    document.getElementById("trend-meaning").textContent = "Trend 점수: " + r.trendMeaning;
    fill("discover-trending-list", s.trending.map(toolItem), "metadata가 없어 Trending을 계산할 수 없습니다.");
    fill("discover-candidates-list", s.candidates.map(candidateItem), "검토할 Candidate가 없습니다.");
    status.textContent = "기준 " + r.asOf.slice(0, 10) + " · metadata " + (r.metadataCollectedAt === null ? "없음" : r.metadataCollectedAt.slice(0, 10)) + " · Candidate " + s.candidates.length + "개";
    decorateVerified();
    return r;
  }
  void load();
  new MutationObserver(() => void load()).observe(document.getElementById("project-body"), { childList: true });

  // 스모크(--smoke): 네 탭을 차례로 열고 Candidate 카드의 버튼·배지·텍스트 렌더링을 확인한다.
  window.__openhubDiscover = async () => {
    const r = await load();
    if (r.status !== "ok") return { status: r.status, tabs: 0, candidates: 0, forbiddenButtons: 0, badges: false, untrustedText: false, trendClean: false, firstTool: null, innerHtml: 0 };
    let shown = 0;
    for (const [tab] of TABS) {
      select(tab);
      if (panels.filter((p) => !p.hidden).length === 1 && !document.getElementById("discover-" + tab).hidden) shown += 1;
    }
    select("verified");
    const cards = [...document.querySelectorAll("#discover-candidates-list li.candidate")];
    const labels = cards.flatMap((li) => [...li.querySelectorAll("button")].map((b) => b.textContent));
    const forbidden = labels.filter((t) => /install|adopt|update|설치|업데이트/iu.test(t)).length;
    const badges = cards.length > 0 && cards.every((li) => {
      const b = [...li.querySelectorAll(".badge")].map((x) => x.textContent);
      return b.includes("UNVERIFIED") && b.includes("DRAFT");
    });
    const untrusted = cards.flatMap((li) => [...li.querySelectorAll(".untrusted")]);
    const untrustedText = untrusted.length > 0 && untrusted.every((n) => n.childElementCount === 0);
    const trendText = document.getElementById("discover-trending").textContent;
    const first = tools.querySelector("li.tool");
    return {
      status: "ok",
      tabs: shown,
      candidates: cards.length,
      forbiddenButtons: forbidden,
      badges,
      untrustedText,
      trendClean: !/security|quality|보안|품질/iu.test(trendText),
      firstTool: first ? first.dataset.toolId : null,
      innerHtml: document.querySelectorAll("#discover img, #discover script").length,
    };
  };
})();
