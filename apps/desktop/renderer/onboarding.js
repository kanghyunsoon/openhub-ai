// First-run onboarding(TASK-070): 이 세션에서 프로젝트를 고르기 전에만 7단계 안내를 보여 준다.
// 설정·기록을 저장하지 않는다(disk write 0, storage API 없음). 브리지를 호출하지 않는다.
(() => {
  const STEPS = [
    ["Project 선택", "[프로젝트 선택]으로 분석할 폴더를 고릅니다."],
    ["Analyze", "언어·프레임워크·DB·AI client 설정을 읽기만 합니다(실행 없음)."],
    ["Existing tools", "이미 설정된 MCP 서버를 확인합니다. user 범위는 CLI --include-host에서만 봅니다."],
    ["Recommend", "FOR YOU가 Project Fit과 OpenScore(저장소 신호)를 따로 보여 줍니다."],
    ["Install / Adopt 구분", "Install은 새로 설정하고, Adopt는 이미 설정된 도구를 관리 대상으로 등록만 합니다. 둘 다 승인 대화상자를 거칩니다."],
    ["Discover", "DISCOVER에서 새 도구·Trending·Verified Registry·검증 전 Candidate를 둘러봅니다."],
    ["Installed Lifecycle", "INSTALLED에서 업데이트·Health·롤백·Benchmark를 승인 후에만 실행합니다."],
  ];
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
