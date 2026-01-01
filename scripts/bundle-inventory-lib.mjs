// bundle inventory 계산(TASK-071). 테스트와 scripts/bundle-inventory.ts가 같이 쓴다.

/** esbuild metafile inputs 경로에서 node_modules package 이름을 뽑는다(pnpm .pnpm 경로·scope 포함). */
export function bundledPackages(metafile) {
  const names = new Set();
  for (const input of Object.keys(metafile.inputs ?? {})) {
    const parts = input.replace(/\\/gu, "/").split("/");
    const at = parts.lastIndexOf("node_modules");
    if (at === -1 || at + 1 >= parts.length) continue;
    const first = parts[at + 1];
    names.add(first.startsWith("@") ? first + "/" + parts[at + 2] : first);
  }
  return [...names].sort();
}

/** CycloneDX components의 package 이름 집합(group이 있으면 group/name). */
export function sbomComponentNames(bom) {
  const out = new Set();
  const walk = (list) => {
    for (const c of list ?? []) {
      out.add(c.group ? c.group + "/" + c.name : c.name);
      walk(c.components);
    }
  };
  walk(bom.components);
  return out;
}
