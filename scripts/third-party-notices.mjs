#!/usr/bin/env node
// THIRD_PARTY_NOTICES.md 생성기(D-006). 배포물에 포함되는 런타임 의존성(직접·전이)을 pnpm licenses 기준으로 모으고
// 각 패키지의 라이선스 원문을 그대로 싣는다. 개발 의존성은 배포물에 포함되지 않으므로 제외한다.
//   node scripts/third-party-notices.mjs          → 파일 갱신
//   node scripts/third-party-notices.mjs --check  → 최신이 아니면 종료 코드 1
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(root, "THIRD_PARTY_NOTICES.md");

/**
 * 배포 패키지 안에 라이선스 원문 파일이 없는 경우에만 쓰는 대체 원문.
 * 반드시 upstream 저장소의 실제 LICENSE를 출처(커밋)와 함께 그대로 옮긴다. 추측해서 쓰지 않는다.
 */
const LICENSE_OVERRIDES = {
  "@nodable/entities": {
    file: "license-overrides/nodable__entities.LICENSE",
    source: "https://github.com/nodable/val-parsers/blob/4fe544c219e52cb6e302c43a88824a8333babe3e/LICENSE",
  },
};

function workspaceDirectDeps() {
  const direct = new Set();
  for (const group of ["packages", "apps"]) {
    const base = path.join(root, group);
    if (!existsSync(base)) continue;
    for (const name of readdirSync(base)) {
      const pkgFile = path.join(base, name, "package.json");
      if (!existsSync(pkgFile)) continue;
      const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
      for (const [dep, spec] of Object.entries(pkg.dependencies ?? {})) if (!String(spec).startsWith("workspace:")) direct.add(dep);
    }
  }
  return direct;
}

function packagedLicenseText(dir) {
  const file = readdirSync(dir).filter((f) => /^(licen[cs]e|copying)(\.|$)/iu.test(f)).sort()[0];
  if (file === undefined) return undefined;
  return readFileSync(path.join(dir, file), "utf8").replace(/\r\n/gu, "\n").trim();
}

function licenseOf(p) {
  const packaged = packagedLicenseText(p.dir);
  if (packaged !== undefined) return { text: packaged, note: undefined };
  const override = LICENSE_OVERRIDES[p.name];
  if (override === undefined) return undefined;
  const text = readFileSync(path.join(root, "scripts", override.file), "utf8").replace(/\r\n/gu, "\n").trim();
  return { text, note: `배포 패키지에 라이선스 파일이 없어 upstream 저장소의 LICENSE를 그대로 옮겼다: <${override.source}>` };
}

function electronInfo() {
  const pkgFile = path.join(root, "apps", "desktop", "node_modules", "electron", "package.json");
  if (!existsSync(pkgFile)) return undefined;
  const pkg = JSON.parse(readFileSync(pkgFile, "utf8"));
  return { version: pkg.version, license: pkg.license };
}

export function generate() {
  const raw = JSON.parse(execSync("pnpm licenses list --prod --json", { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
  const direct = workspaceDirectDeps();
  const packages = Object.values(raw)
    .flat()
    .map((p) => ({ name: p.name, version: [...p.versions].sort().join(", "), license: p.license, homepage: p.homepage ?? "", dir: p.paths[0] }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const missing = packages.filter((p) => licenseOf(p) === undefined).map((p) => p.name);
  if (missing.length > 0) throw new Error(`라이선스 파일을 찾지 못한 패키지: ${missing.join(", ")}`);
  const electron = electronInfo();

  const lines = [
    "# Third-Party Notices",
    "",
    "OpenHub AI는 MIT 라이선스로 배포된다(LICENSE). 이 파일은 OpenHub AI 배포물(CLI, 데스크톱 앱 번들 `apps/desktop/dist`)에 포함되는",
    "제3자 런타임 의존성의 라이선스 고지다(Decision D-006).",
    "",
    "- 생성: `pnpm notices` (`scripts/third-party-notices.mjs`), 기준: `pnpm licenses list --prod`. 직접 편집하지 않는다.",
    "- 검사: `pnpm notices:check` — 테스트와 CI에서 이 파일이 의존성과 일치하는지 확인한다.",
    "- 개발 의존성(TypeScript, Vitest, tsx, esbuild 등)은 배포물에 포함되지 않아 제외한다.",
    "",
    "## 요약",
    "",
    "| 패키지 | 버전 | 라이선스 | 구분 | 고지 의무 |",
    "| --- | --- | --- | --- | --- |",
    ...packages.map((p) => `| ${p.name} | ${p.version} | ${p.license} | ${direct.has(p.name) ? "직접" : "전이"} | ${obligation(p.license)} |`),
    "",
    "## Electron 런타임",
    "",
    electron === undefined
      ? "데스크톱 앱은 Electron 런타임 위에서 동작한다."
      : `데스크톱 앱은 Electron ${electron.version}(${electron.license}) 런타임 위에서 동작한다.`,
    "Electron 배포물에는 Electron 자체의 `LICENSE`와 Chromium 및 그 구성요소의 고지를 모은 `LICENSES.chromium.html`이 들어 있다.",
    "데스크톱 앱을 패키징해 배포할 때는 이 두 파일을 수정 없이 앱 패키지에 함께 넣는다. 현재 저장소에는 패키징 단계가 없으며,",
    "패키징을 도입하는 시점(M7 공개, REQ-062)에 이 방침을 빌드 설정으로 강제한다.",
    "",
    "## 라이선스 원문",
    "",
  ];
  for (const p of packages) {
    const lic = licenseOf(p);
    lines.push(`### ${p.name}@${p.version} (${p.license})`, "");
    if (p.homepage) lines.push(`<${p.homepage}>`, "");
    if (lic.note) lines.push(lic.note, "");
    lines.push("```text", lic.text, "```", "");
  }
  return lines.join("\n");
}

function obligation(license) {
  switch (license) {
    case "MIT":
    case "ISC":
      return "저작권 고지·허가 문구 포함";
    case "BSD-3-Clause":
      return "저작권 고지·조건·면책 문구 포함, 저작자 이름으로 홍보 금지";
    default:
      return "라이선스 원문 확인 필요";
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = generate();
  if (process.argv.includes("--check")) {
    const current = existsSync(OUT) ? readFileSync(OUT, "utf8") : "";
    if (current !== next) {
      process.stderr.write("THIRD_PARTY_NOTICES.md가 최신이 아닙니다. pnpm notices를 실행하세요.\n");
      process.exit(1);
    }
    process.stdout.write("THIRD_PARTY_NOTICES.md 최신\n");
  } else {
    writeFileSync(OUT, next);
    process.stdout.write("THIRD_PARTY_NOTICES.md 갱신\n");
  }
}
