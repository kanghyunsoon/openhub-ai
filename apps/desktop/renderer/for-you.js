// FOR YOU 카드: 메인 프로세스가 만든 추천 화면 데이터(Core RecommendationReport 기반)를 그대로 보여준다.
// 데이터는 preload의 window.openhub.recommendProject()로만 받고, 이 함수는 인자를 받지 않는다.
// 설치 버튼은 없다(M4). Project Fit과 OpenScore는 따로 표시한다. 모든 문자열은 textContent로만 넣는다.
(() => {
  const t = window.openhubI18n.t;
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function item(view) {
    const li = el("li", "rec");
    li.dataset.toolId = view.toolId;
    const head = el("div", "rec-head");
    head.append(el("span", "rec-rank", String(view.rank)), el("span", "rec-name", view.name));
    li.append(head);
    const badges = el("div", "badges");
    for (const b of view.badges) badges.append(el("span", `badge ${b.kind}`, b.label));
    li.append(badges);
    const scores = el("div", "rec-scores");
    scores.append(el("span", "fit", `Project Fit ${view.projectFit}`));
    const open = el("span", "open", `OpenScore ${view.openScore}`);
    open.title = t("forYou.openTitle");
    scores.append(open, el("span", "open-hint", t("forYou.openHint")));
    li.append(scores, el("p", "rec-capability", view.capability));
    const reasons = el("ul", "rec-reasons");
    for (const r of view.reasons) reasons.append(el("li", "", r));
    if (view.moreReasons > 0) reasons.append(el("li", "more", t("forYou.moreReasons", { count: view.moreReasons })));
    li.append(reasons);
    // Registry 등록과 OpenHub 실제 실행 검증을 구분한 한 줄(정보이며 추천 제외 사유가 아니다).
    if (view.verification) li.append(el("p", "rec-verification", view.verification));
    return li;
  }

  // 추천 진단(v0.2.0 C3): Core 진단·후보 제외 코드를 메인 프로세스가 문장으로 만든 것을 그대로 보여 준다.
  function renderDiagnosis(view) {
    const box = document.getElementById("for-you-diagnosis");
    const nodes = [];
    const d = view.diagnosis;
    if (d) {
      if (d.empty) nodes.push(el("p", "diag-title", t("forYou.diag.title")), el("p", "diag-empty", d.empty.text));
      if (d.unmappedTechs.length > 0) nodes.push(el("p", "diag-unmapped", t("forYou.diag.unmapped", { techs: d.unmappedTechs.join(", ") })));
      if (d.excluded.length > 0) {
        nodes.push(el("p", "diag-title", t("forYou.diag.excludedTitle")));
        const list = el("ul", "diag-excluded");
        for (const x of d.excluded) {
          const li = el("li", "", x.text);
          li.dataset.toolId = x.toolId;
          // "이미 사용 중"으로만 제외된 후보: 표시만 한다. 버튼은 설치 화면 스크립트가 붙인다(FOR YOU 코드와 분리).
          if (x.addable) li.dataset.addElsewhere = "1";
          list.append(li);
        }
        nodes.push(list);
      }
    }
    if (view.items.length > 0 || (d && d.excluded.length > 0)) nodes.push(el("p", "diag-verify-notice", view.verificationNotice));
    box.replaceChildren(...nodes);
    box.dataset.emptyReason = d && d.empty ? d.empty.code : "";
  }

  function render(view) {
    const list = document.getElementById("for-you-list");
    list.replaceChildren(...view.items.map(item));
    const gaps = document.getElementById("for-you-gaps");
    gaps.replaceChildren(...view.noCandidate.map((g) => el("p", "no-candidate", t("forYou.noCandidateLine", { label: g.label, message: g.message }))));
    const extra = document.getElementById("for-you-open-unavailable");
    extra.textContent = view.openScoreUnavailable ?? "";
    extra.hidden = view.openScoreUnavailable === null;
    renderDiagnosis(view);
    return view.items.length;
  }

  let sequence = 0;
  async function load() {
    const mine = ++sequence;
    const status = document.getElementById("for-you-status");
    status.textContent = t("forYou.loading");
    const result = await window.openhub.recommendProject();
    if (mine !== sequence) return document.getElementById("for-you-list").childElementCount;
    if (result.status === "no-project") {
      status.textContent = t("forYou.prompt");
      return 0;
    }
    if (result.status === "error") {
      status.textContent = t("forYou.error", { message: result.message });
      return 0;
    }
    const count = render(result.view);
    status.textContent = count === 0 ? t("forYou.none") : t("forYou.count", { scope: result.view.scope, count });
    return count;
  }

  // PROJECT 카드가 새 분석 결과를 그리면 추천을 다시 불러온다(PROJECT 코드와 분리).
  new MutationObserver(() => {
    void load();
  }).observe(document.getElementById("project-body"), { childList: true });
  // 스모크 실행이 같은 경로로 추천을 기다리도록 노출한다.
  window.__openhubRecommend = load;
  // 스모크 E2E(v0.2.0 C3): 화면에 그려진 진단 문장을 그대로 읽는다(쓰기 없음).
  window.__openhubForYouDiagnosis = () => {
    const box = document.getElementById("for-you-diagnosis");
    // 항목 문장만 읽는다(설치 화면 스크립트가 붙인 버튼 글자는 따로 센다).
    const textOf = (n) => [...n.childNodes].filter((c) => c.nodeType === Node.TEXT_NODE).map((c) => c.textContent).join("");
    return {
      status: document.getElementById("for-you-status").textContent,
      emptyReason: box.dataset.emptyReason || "",
      lines: [...box.querySelectorAll("p, li")].map(textOf),
      addButtons: [...box.querySelectorAll("li[data-add-elsewhere] button")].map((b) => b.closest("li").dataset.toolId),
      verification: [...document.querySelectorAll("#for-you-list .rec-verification")].map((n) => n.textContent),
    };
  };
})();
