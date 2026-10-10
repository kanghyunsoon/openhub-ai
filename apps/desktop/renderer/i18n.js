// 다국어(v0.2.0 P0-3 PR B): 정적 문구(data-i18n·data-i18n-aria)를 현재 언어로 채우고 언어 선택을 연결한다.
// 번역은 preload의 window.openhubI18n.t()가 돌려주는 텍스트이고 textContent·속성으로만 넣는다(HTML 해석 없음).
// 언어를 바꾸면 main이 저장한 뒤 화면을 다시 읽는다. timer·polling이 없다.
(() => {
  const i18n = window.openhubI18n;
  const t = i18n.t;
  document.documentElement.lang = i18n.locale;
  for (const node of document.querySelectorAll("[data-i18n]")) node.textContent = t(node.dataset.i18n);
  for (const node of document.querySelectorAll("[data-i18n-aria]")) node.setAttribute("aria-label", t(node.dataset.i18nAria));

  const select = document.getElementById("language-select");
  const error = document.getElementById("language-error");
  select.value = i18n.locale;
  select.addEventListener("change", async () => {
    const response = await i18n.setLanguage(select.value);
    if (response && response.status === "ok") {
      location.reload();
      return;
    }
    select.value = i18n.locale;
    error.textContent = t("app.languageSaveFailed", { reason: (response && (response.reason || response.status)) || "error" });
    error.hidden = false;
  });

  // 스모크(--smoke): 현재 언어·정적 문구·번역 누락을 돌려준다. 누락 key는 t()가 key 자체를 돌려주는 경우다.
  window.__openhubI18n = () => {
    const keys = [...document.querySelectorAll("[data-i18n]")].map((n) => n.dataset.i18n);
    const texts = {};
    for (const id of ["project-select", "for-you-status", "lifecycle-status", "status"]) texts[id] = (document.getElementById(id) || {}).textContent || "";
    const onboarding = document.querySelector("#onboarding-steps li strong");
    texts["onboarding-step1"] = onboarding ? onboarding.textContent : "";
    const visible = [...document.querySelectorAll("[data-i18n]")].map((n) => n.textContent).join("\n");
    return {
      locale: i18n.locale,
      htmlLang: document.documentElement.lang,
      selectValue: select.value,
      texts,
      hangul: (visible.match(/[\uac00-\ud7a3]/gu) || []).length,
      missingKeys: keys.filter((k) => t(k) === k),
    };
  };
  // 스모크: 화면의 언어 선택을 사람처럼 바꾼다(change 이벤트 → 저장 → 다시 읽기).
  window.__openhubSetLanguage = (value) => {
    select.value = value;
    select.dispatchEvent(new Event("change"));
    return true;
  };
})();

