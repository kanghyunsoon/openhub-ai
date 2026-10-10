// DISCOVER(TASK-070): New for your project · Trending · Verified Registry · Unverified Candidates 네 탭.
// 데이터는 window.openhubDiscover.discoverView()로만 받는다(인자 없음, network 0). 기존 Star 순 목록(#tools)은 Verified Registry 탭이다.
// Candidate 카드에는 UNVERIFIED·DRAFT 배지와 [Prepare contribution package]만 있고 설치·Adopt·업데이트 버튼은 없다.
// 비신뢰 문자열(Candidate 설명·설치 문구)은 textContent로만 넣는다. timer·polling 없음.
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

  const TABS = [
    ["new", t("discover.tab.new")],
    ["trending", t("discover.tab.trending")],
    ["verified", t("discover.tab.verified")],
    ["candidates", t("discover.tab.candidates")],
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
    return button("detail-open", t("discover.detail"), () => document.dispatchEvent(new CustomEvent("openhub:tool-detail", { detail: toolId })));
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
    if (c.untrusted.description !== null) li.append(el("p", "untrusted-label", t("discover.untrustedDescription")), el("p", "untrusted", c.untrusted.description));
    if (c.untrusted.installText !== null) li.append(el("p", "untrusted-label", t("discover.untrustedInstall")), el("pre", "untrusted", c.untrusted.installText));
    if (c.evidence.length > 0) {
      const ev = el("ul", "install-next");
      for (const e of c.evidence) ev.append(el("li", "", e));
      li.append(el("p", "untrusted-label", t("discover.evidence")), ev);
    }
    if (c.actions.includes("prepare-contribution")) li.append(button("candidate-prepare", t("discover.prepare"), () => void prepare(c.id)));
    return li;
  }

  async function prepare(id) {
    const out = document.getElementById("candidate-result");
    out.textContent = t("discover.chooseFolder");
    const r = await window.openhubDiscover.prepareCandidate(id);
    if (r.status === "cancelled") out.textContent = t("discover.cancelled");
    else if (r.status !== "ok") out.textContent = t("discover.prepareFailed", { message: r.message || r.code });
    else out.textContent = t("discover.prepared", { count: r.files.length, note: r.note });
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
    status.textContent = t("discover.loading");
    const r = await window.openhubDiscover.discoverView();
    if (mine !== sequence) return r;
    if (r.status !== "ok") {
      status.textContent = r.message || r.status;
      return r;
    }
    const s = r.sections;
    fill("discover-new-list", s.newForProject.map(toolItem), t("discover.newEmpty"));
    document.getElementById("trend-meaning").textContent = t("discover.trendMeaning", { meaning: r.trendMeaning });
    fill("discover-trending-list", s.trending.map(toolItem), t("discover.trendingEmpty"));
    fill("discover-candidates-list", s.candidates.map(candidateItem), t("discover.candidatesEmpty"));
    status.textContent = t("discover.status", { asOf: r.asOf.slice(0, 10), metadata: r.metadataCollectedAt === null ? t("common.none") : r.metadataCollectedAt.slice(0, 10), count: s.candidates.length });
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
      // Trend를 보안·품질·신뢰 점수로 표현하지 않는다(Core AC와 같은 규칙). "보안·품질을 평가하지 않는다"는 부정 고지는 허용한다.
      trendClean: !/(security|quality|trust)[ -]score|보안 점수|품질 점수|신뢰 점수/iu.test(trendText),
      firstTool: first ? first.dataset.toolId : null,
      innerHtml: document.querySelectorAll("#discover img, #discover script").length,
    };
  };
})();
