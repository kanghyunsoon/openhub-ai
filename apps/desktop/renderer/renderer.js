// 화면 렌더러. 데이터는 preload가 노출한 window.openhub로만 받는다. innerHTML을 쓰지 않는다.
// 문구·숫자·날짜는 window.openhubI18n(현재 언어)으로 만든다.
const i18nRenderer = window.openhubI18n;

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toolItem(tool) {
  const li = el("li", "tool");
  li.dataset.toolId = tool.name;
  const head = el("div", "tool-head");
  head.append(el("strong", "tool-name", tool.displayName));
  head.append(el("span", "stars", tool.stars === null ? "★ —" : `★ ${i18nRenderer.formatNumber(tool.stars)}`));
  li.append(head);
  li.append(el("p", "summary", tool.summary));
  const meta = el("div", "meta");
  for (const c of tool.categories) meta.append(el("span", "chip", c));
  meta.append(el("span", "repo", tool.repository));
  if (tool.latestRelease) meta.append(el("span", "release", tool.latestRelease));
  if (tool.archived) meta.append(el("span", "chip warn", "archived"));
  li.append(meta);
  return li;
}

async function render() {
  const view = await window.openhub.listRegistry();
  const list = document.getElementById("tools");
  list.replaceChildren(...view.tools.map(toolItem));

  const issues = document.getElementById("issues");
  issues.replaceChildren(...view.issues.map((i) => el("li", "", i)));
  issues.hidden = view.issues.length === 0;

  const collected = view.metadataCollectedAt
    ? i18nRenderer.t("registry.metadataAt", { date: i18nRenderer.formatDateTime(view.metadataCollectedAt) })
    : i18nRenderer.t("registry.metadataMissing");
  document.getElementById("status").textContent = i18nRenderer.t("registry.status", { count: view.tools.length, metadata: collected });
  return view.tools.length;
}

window.__openhubReady = render();
