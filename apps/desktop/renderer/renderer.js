// 화면 렌더러. 데이터는 preload가 노출한 window.openhub로만 받는다. innerHTML을 쓰지 않는다.
const number = new Intl.NumberFormat("ko-KR");

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
  head.append(el("span", "stars", tool.stars === null ? "★ —" : `★ ${number.format(tool.stars)}`));
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
    ? `메타데이터 ${new Date(view.metadataCollectedAt).toLocaleString("ko-KR")}`
    : "메타데이터 없음 — pnpm openhub collect";
  document.getElementById("status").textContent = `Registry ${view.tools.length}개 · ${collected}`;
  return view.tools.length;
}

window.__openhubReady = render();
