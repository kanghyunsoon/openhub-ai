// Desktop Electron E2E 도우미(desktop-e2e.yml 전용, 의존성 없는 Node 스크립트).
//   node scripts/desktop-e2e.mjs changes <changed-files.txt>   → stdout "run=true|false"(GITHUB_OUTPUT용), 이유는 stderr
//   node scripts/desktop-e2e.mjs list [--root <dir>]           → 발견한 Electron E2E 파일(한 줄에 하나)
//   node scripts/desktop-e2e.mjs check <results-dir> [--root <dir>]
//     결과 JSON(vitest JSON reporter)마다 실행 테스트 1개 이상·실패/건너뜀/todo 0을 요구하고,
//     발견한 Electron E2E 파일이 모두 실행됐는지 확인한다(워크플로에 등록하지 않은 새 E2E 파일이 있으면 실패).
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 변경 파일 중 이것만 있으면 Electron E2E가 필요 없다(실제 의존 관계로 확인한 목록). 여기에 없는 경로는 모두 실행한다
 * (모르는 변경은 실행). Desktop 빌드는 scripts/stage-registry.mjs를, E2E는 examples/·packages/core/test의 helper·fixture·
 * 루트 vitest.config.ts·tsconfig.json·registry/를 쓰므로 그것들은 여기에 넣지 않는다.
 */
export const NOT_NEEDED = [
  { pattern: /^docs\//u, why: "documentation" },
  { pattern: /^[^/]+\.md$/u, why: "root markdown" },
  { pattern: /^LICENSE$/u, why: "license text" },
  { pattern: /^\.editorconfig$/u, why: "editor settings" },
  { pattern: /^\.gitleaks\.toml$/u, why: "secret scan settings" },
  { pattern: /^\.github\/(?!workflows\/desktop-e2e\.yml$)/u, why: "other GitHub settings and workflows" },
  // 테스트 파일은 다른 파일이 import하지 않는다(helper·fixture는 실행 대상). Desktop 테스트 파일은 apps/desktop이라 실행한다.
  { pattern: /^packages\/[^/]+\/test\/.+\.test\.ts$/u, why: "package test file (not imported by the Desktop E2E)" },
  { pattern: /^apps\/cli\//u, why: "CLI (the Desktop does not depend on it)" },
  { pattern: /^test\//u, why: "repository tests (not used by the Desktop E2E)" },
];

/** 변경 파일 목록 → E2E 필요 여부. 하나라도 NOT_NEEDED에 없으면 실행한다. */
export function needsDesktopE2e(files) {
  const list = files.map((f) => f.trim().replace(/\\/gu, "/")).filter((f) => f !== "");
  const needed = list.filter((f) => !NOT_NEEDED.some((n) => n.pattern.test(f)));
  return { run: needed.length > 0, needed, skipped: list.filter((f) => !needed.includes(f)) };
}

// 줄 머리의 describe/it/test.skipIf(…OPENHUB_E2E…)로 켜지는 테스트(문자열 안의 예시는 세지 않는다).
const isE2eSource = (text) => /^\s*(describe|it|test)\.skipIf\([^\n]*process\.env\[["']OPENHUB_E2E["']\]/mu.test(text);

/** apps/desktop/test 아래에서 OPENHUB_E2E로 켜지는 테스트 파일(실제 Electron E2E). 정렬된 상대 경로. */
export function discoverElectronE2e(root) {
  const dir = path.join(root, "apps", "desktop", "test");
  const out = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".test.ts") && isE2eSource(readFileSync(full, "utf8"))) out.push(path.relative(root, full).replace(/\\/gu, "/"));
    }
  };
  walk(dir);
  return out.sort();
}

/** 결과 디렉터리 검사. { ok, lines } */
export function checkResults(resultsDir, root) {
  const lines = [];
  let ok = true;
  const ran = new Set();
  let files = [];
  try {
    files = readdirSync(resultsDir).filter((f) => f.endsWith(".json")).sort();
  } catch {
    return { ok: false, lines: ["no results directory: " + resultsDir] };
  }
  if (files.length === 0) return { ok: false, lines: ["no result files in " + resultsDir] };
  for (const f of files) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(path.join(resultsDir, f), "utf8"));
    } catch {
      lines.push(f + ": unreadable result");
      ok = false;
      continue;
    }
    const passed = doc.numPassedTests ?? 0;
    const failed = doc.numFailedTests ?? 0;
    const pending = doc.numPendingTests ?? 0;
    const todo = doc.numTodoTests ?? 0;
    const line = f + ": passed " + passed + ", failed " + failed + ", skipped " + pending + ", todo " + todo;
    if (passed === 0 || failed > 0 || pending > 0 || todo > 0 || doc.success !== true) {
      lines.push(line + " — not accepted");
      ok = false;
    } else lines.push(line);
    for (const r of doc.testResults ?? []) if (typeof r.name === "string") ran.add(path.relative(root, path.resolve(root, r.name)).replace(/\\/gu, "/"));
  }
  const discovered = discoverElectronE2e(root);
  if (discovered.length === 0) {
    lines.push("no Electron E2E files found under apps/desktop/test");
    ok = false;
  }
  for (const file of discovered) {
    if (!ran.has(file)) {
      lines.push(file + ": Electron E2E file was not run (add a step for it in .github/workflows/desktop-e2e.yml)");
      ok = false;
    }
  }
  lines.push("Electron E2E files: " + discovered.length + " found, " + discovered.filter((f) => ran.has(f)).length + " run");
  return { ok, lines };
}

function rootArg(args) {
  const i = args.indexOf("--root");
  return i >= 0 && args[i + 1] !== undefined ? path.resolve(args[i + 1]) : process.cwd();
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === "changes" && args[0] !== undefined) {
    const result = needsDesktopE2e(readFileSync(args[0], "utf8").split("\n"));
    for (const f of result.needed) console.error("needs Electron E2E: " + f);
    for (const f of result.skipped) console.error("not needed: " + f);
    console.log("run=" + String(result.run));
  } else if (mode === "list") {
    for (const f of discoverElectronE2e(rootArg(args))) console.log(f);
  } else if (mode === "check" && args[0] !== undefined) {
    const result = checkResults(path.resolve(args[0]), rootArg(args));
    for (const l of result.lines) (result.ok ? console.log : console.error)(l);
    process.exit(result.ok ? 0 : 1);
  } else {
    console.error("usage: node scripts/desktop-e2e.mjs changes <file> | list [--root dir] | check <results-dir> [--root dir]");
    process.exit(2);
  }
}

