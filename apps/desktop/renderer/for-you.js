// FOR YOU 카드: 메인 프로세스가 만든 추천 화면 데이터(Core RecommendationReport 기반)를 그대로 보여준다.
// 데이터는 preload의 window.openhub.recommendProject()로만 받고, 이 함수는 인자를 받지 않는다.
// 설치 버튼은 없다(M4). Project Fit과 OpenScore는 따로 표시한다. 모든 문자열은 textContent로만 넣는다.
(() => {
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
    open.title = "저장소 유지관리·활동성·커뮤니티 신호 · 보안·코드 품질 평가 아님";
    scores.append(open, el("span", "open-hint", "저장소 신호 · 보안·품질 평가 아님"));
    li.append(scores, el("p", "rec-capability", view.capability));
    const reasons = el("ul", "rec-reasons");
    for (const r of view.reasons) reasons.append(el("li", "", r));
    if (view.moreReasons > 0) reasons.append(el("li", "more", `이유 ${view.moreReasons}개 더`));
    li.append(reasons);
    return li;
  }

  function render(view) {
    const list = document.getElementById("for-you-list");
    list.replaceChildren(...view.items.map(item));
    const gaps = document.getElementById("for-you-gaps");
    gaps.replaceChildren(...view.noCandidate.map((g) => el("p", "no-candidate", `${g.label}: ${g.message}`)));
    const extra = document.getElementById("for-you-open-unavailable");
    extra.textContent = view.openScoreUnavailable ?? "";
    extra.hidden = view.openScoreUnavailable === null;
    return view.items.length;
  }

  let sequence = 0;
  async function load() {
    const mine = ++sequence;
    const status = document.getElementById("for-you-status");
    status.textContent = "추천 계산 중…";
    const result = await window.openhub.recommendProject();
    if (mine !== sequence) return document.getElementById("for-you-list").childElementCount;
    if (result.status === "no-project") {
      status.textContent = "프로젝트를 선택하면 맞춤 추천을 보여줍니다.";
      return 0;
    }
    if (result.status === "error") {
      status.textContent = `추천할 수 없습니다: ${result.message}`;
      return 0;
    }
    const count = render(result.view);
    status.textContent = count === 0 ? "추천할 도구가 없습니다." : `${result.view.scope} · 추천 ${count}개`;
    return count;
  }

  // PROJECT 카드가 새 분석 결과를 그리면 추천을 다시 불러온다(PROJECT 코드와 분리).
  new MutationObserver(() => {
    void load();
  }).observe(document.getElementById("project-body"), { childList: true });
  // 스모크 실행이 같은 경로로 추천을 기다리도록 노출한다.
  window.__openhubRecommend = load;
})();
