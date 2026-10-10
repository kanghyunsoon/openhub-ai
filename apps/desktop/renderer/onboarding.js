// First-run onboarding(TASK-070): 이 세션에서 프로젝트를 고르기 전에만 7단계 안내를 보여 준다.
// 설정·기록을 저장하지 않는다(disk write 0, storage API 없음). 브리지를 호출하지 않는다.
(() => {
  const t = window.openhubI18n.t;
  const STEPS = [1, 2, 3, 4, 5, 6, 7].map((n) => [t("onboarding.step" + n + ".title"), t("onboarding.step" + n + ".body")]);
  const card = document.getElementById("onboarding");
  const list = document.getElementById("onboarding-steps");
  list.replaceChildren(
    ...STEPS.map(([title, body], i) => {
      const li = document.createElement("li");
      const strong = document.createElement("strong");
      strong.textContent = String(i + 1) + ". " + title;
      const p = document.createElement("p");
      p.className = "todo";
      p.textContent = body;
      li.append(strong, p);
      return li;
    }),
  );
  // PROJECT 카드가 분석 결과를 그리면 안내를 숨긴다(이 세션에서만, 저장 없음).
  new MutationObserver(() => {
    if (document.getElementById("project-body").childElementCount > 0) card.hidden = true;
  }).observe(document.getElementById("project-body"), { childList: true });
  window.__openhubOnboarding = () => ({ visible: !card.hidden, steps: list.childElementCount });
})();
