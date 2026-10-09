/**
 * pnpm release <command>(TASK-072, D-034·D-037 §13). release.yml의 각 job이 이 명령을 부른다(로컬에서도 같은 명령으로 dry-run 한다).
 * tag·GitHub Release·npm publish를 하지 않는다. 쓰는 곳은 --out·--dir·--report로 받은 경로와 OS 임시 디렉터리뿐이다.
 *
 *   deps-sbom   --out <dir> [--cli-metafile f] [--desktop-metafile f]   Layer A dependency SBOM 2개(+Electron), 검증·semantic 결정론·inventory
 *   artifact-sbom --dir <unpacked|tgz> --name <source> [--out <file>] [--count-only] --kind k   Layer B Syft 검사
 *   electron-provenance --dir <win-unpacked>        공식 Electron archive checksum + runtime file provenance(Windows)
 *   notices     --kind cli|desktop (--dir <dir> | --tgz <file>) --artifact k
 *   smoke-cli   --tgz <file>                       깨끗한 임시 prefix 설치 → 임시 cwd에서 명령 3개
 *   smoke-unpacked --dir <win-unpacked>             unpacked 앱 --smoke + runtime 버전(Windows)
 *   smoke-nsis  --installer <exe>                  임시 경로 silent 설치 → --smoke·runtime 버전 → 제거(Windows)
 *   smoke-appimage --file <AppImage>               --appimage-extract 후 AppImage의 AppRun --smoke·runtime 버전(Linux, xvfb)
 *   sums        --dir <dist>                       SHA256SUMS 작성(installer·AppImage·tgz·SBOM)
 *   verify-sums --dir <dist>                       SHA256SUMS 재계산 비교
 *   coverage    --dir <dist> --reports <dir>       job별 보고서를 합쳐 release-coverage.json 작성·검사
 *
 * GitHub Release 단계(release job·release-verify.yml). GitHub API 호출은 workflow의 gh가 하고, 이 명령은 그 JSON만 읽는다.
 *   check-tag      --tag <vX.Y.Z>                                    SemVer tag이고 package 버전과 같은지
 *   release-assets --dir <dist> [--list <file>]                       필수 asset 8개·버전·SHA256SUMS 확인, 올릴 경로 목록 작성
 *   github-plan    --tag <t> --releases <json> --github-output <file> 같은 tag Release 판정(create·reuse, 공개됐거나 여럿이면 중단)
 *   github-notes   --tag <t> --releases <json> --notes-file <md> --out <json>   tag_name을 보존하는 draft notes PATCH 본문
 *   github-verify  --tag <t> --releases <json> --expect draft|published (--dir <dist> | --sums <file>)   Release API 기준 asset 검증
 * 각 명령은 --report <file>에 자기 결과를 합쳐 쓴다(job별 부분 보고서).
 */
import { execFileSync, execSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkBundledSnapshot, validateRegistry } from "../packages/core/src/index";
import { bundledPackages, sbomComponentNames } from "./bundle-inventory-lib.mjs";
import {
  DESKTOP_PRODUCT_NAME,
  ELECTRON_DOWNLOAD_LIMITS,
  SBOM_FILES,
  SYFT_VERSION,
  addElectronRuntime,
  artifactSummary,
  buildCoverage,
  compareElectronProvenance,
  electronArchiveName,
  electronReleaseUrl,
  electronShasumFor,
  lockfileElectronVersion,
  mergeReports,
  missingNotices,
  parseSha256Sums,
  readZipEntries,
  sbomSemanticDigest,
  sha256,
  sha256SumsText,
  validateCycloneDx,
  type ArtifactKind,
  type CycloneDxBom,
  type DryRunReport,
  type RuntimeEvidence,
  type RuntimeTarget,
} from "./release-lib";
import {
  SHA256SUMS_FILE,
  checkLocalAssets,
  checkReleaseTag,
  draftNotesUpdate,
  flattenReleases,
  planDraftRelease,
  releaseAssetNames,
  verifyGithubRelease,
  type LocalAsset,
} from "./release-github-lib";

const ROOT = path.resolve(import.meta.dirname, "..");
const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({
  args: rest,
  options: {
    out: { type: "string" }, dir: { type: "string" }, name: { type: "string" }, kind: { type: "string" }, tgz: { type: "string" }, file: { type: "string" },
    installer: { type: "string" }, report: { type: "string" }, reports: { type: "string" }, artifact: { type: "string" }, "count-only": { type: "boolean", default: false },
    "cli-metafile": { type: "string" }, "desktop-metafile": { type: "string" },
    tag: { type: "string" }, releases: { type: "string" }, sums: { type: "string" }, expect: { type: "string" }, "notes-file": { type: "string" }, list: { type: "string" }, "github-output": { type: "string" },
  },
  strict: true,
});
const fail = (msg: string): never => {
  console.error("✗ " + msg);
  process.exit(1);
};
const need = (v: string | undefined, flag: string): string => v ?? fail(flag + "가 필요합니다");
const version = (JSON.parse(readFileSync(path.join(ROOT, "apps/cli/package.json"), "utf8")) as { version: string }).version;
const expectedElectron = (): string => lockfileElectronVersion(readFileSync(path.join(ROOT, "pnpm-lock.yaml"), "utf8")) ?? fail("lockfile에서 apps/desktop electron 버전을 찾지 못했습니다");

/** job별 부분 보고서에 결과를 합친다. */
function record(partial: Partial<DryRunReport>) {
  if (values.report === undefined) return;
  const file = path.resolve(values.report);
  const current: DryRunReport = existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as DryRunReport) : { version, scans: {}, checks: {} };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(mergeReports([current, { version, scans: {}, checks: {}, ...partial } as DryRunReport]), null, 2) + "\n");
}
const setCheck = (kind: ArtifactKind, key: "bundleInventory" | "notices" | "smoke", ok: boolean) => record({ checks: { [kind]: { [key]: ok } } as DryRunReport["checks"] });

function pnpmSbom(filter: string): CycloneDxBom {
  return JSON.parse(execSync("pnpm --filter " + filter + " sbom --sbom-format cyclonedx --sbom-type application --prod", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 })) as CycloneDxBom;
}
function electronRuntime() {
  const pkg = JSON.parse(readFileSync(path.join(ROOT, "apps/desktop/node_modules/electron/package.json"), "utf8")) as { version: string; license: string };
  const locked = expectedElectron();
  if (locked !== pkg.version) fail("설치된 electron " + pkg.version + "이 lockfile " + locked + "과 다릅니다");
  return { version: pkg.version, license: pkg.license };
}

async function depsSbom() {
  const out = path.resolve(need(values.out, "--out"));
  mkdirSync(out, { recursive: true });
  const electron = electronRuntime();
  const make = () => ({ cli: pnpmSbom("@openhub/cli"), desktop: addElectronRuntime(pnpmSbom("@openhub/desktop"), electron) });
  const first = make();
  const second = make();
  const digests = { cli: [sbomSemanticDigest(first.cli), sbomSemanticDigest(second.cli)], desktop: [sbomSemanticDigest(first.desktop), sbomSemanticDigest(second.desktop)] };
  for (const [k, [a, b]] of Object.entries(digests)) if (a !== b) fail(k + " dependency SBOM의 semantic digest가 두 번 생성에서 다릅니다");
  for (const [k, bom] of Object.entries(first) as ["cli" | "desktop", CycloneDxBom][]) {
    const text = JSON.stringify(bom, null, 2) + "\n";
    const v = await validateCycloneDx(text);
    if (!v.ok) fail(k + " dependency SBOM 검증 실패: " + JSON.stringify(v));
    if (typeof bom.serialNumber !== "string" || typeof bom.metadata?.timestamp !== "string") fail(k + " SBOM에 실제 serialNumber·timestamp가 없습니다");
    writeFileSync(path.join(out, SBOM_FILES[k]), text);
    console.log("✓ " + SBOM_FILES[k] + " (CycloneDX " + v.specVersion + ", component " + String(bom.components?.length ?? 0) + ", semantic " + digests[k][0]!.slice(0, 12) + ")");
  }
  const sbomElectron = first.desktop.components?.find((c) => c.name === "electron")?.version ?? null;
  record({ electron: { expectedVersion: expectedElectron(), dependencySbomVersion: sbomElectron } });
  // bundle inventory ⊆ dependency SBOM(AC-072-18)
  const inventory: [ArtifactKind[], string | undefined, CycloneDxBom][] = [[["cli"], values["cli-metafile"], first.cli], [["windows", "linux"], values["desktop-metafile"], first.desktop]];
  for (const [kinds, metafile, bom] of inventory) {
    if (metafile === undefined) continue;
    const pkgs = bundledPackages(JSON.parse(readFileSync(metafile, "utf8")) as { inputs?: Record<string, unknown> });
    const names = sbomComponentNames(bom);
    const missing = pkgs.filter((p) => !names.has(p));
    for (const k of kinds) setCheck(k, "bundleInventory", missing.length === 0);
    if (missing.length > 0) fail(kinds.join("·") + " bundle package가 dependency SBOM에 없습니다: " + missing.join(", "));
    console.log("✓ bundle inventory " + kinds.join("·") + ": " + pkgs.length + "개 ⊆ dependency SBOM");
  }
  writeFileSync(path.join(out, "sbom-semantic.json"), JSON.stringify({ cli: digests.cli[0], desktop: digests.desktop[0], electron }, null, 2) + "\n");
}

async function artifactSbom() {
  const target = path.resolve(need(values.dir, "--dir"));
  const name = need(values.name, "--name");
  const kind = need(values.kind, "--kind") as ArtifactKind;
  const tmp = mkdtempSync(path.join(os.tmpdir(), "openhub-syft-"));
  try {
    const file = path.join(tmp, "scan.cdx.json");
    const source = target.endsWith(".tgz") || target.endsWith(".AppImage") ? "file:" + target : "dir:" + target;
    execFileSync(process.env["SYFT"] ?? "syft", ["scan", source, "-o", "cyclonedx-json=" + file, "--source-name", name, "--source-version", version, "-q"], { env: { ...process.env, SYFT_FILE_METADATA_SELECTION: "none", SYFT_CHECK_FOR_APP_UPDATE: "false" }, stdio: ["ignore", "inherit", "inherit"] });
    const text = readFileSync(file, "utf8");
    const summary = artifactSummary(text);
    record({ scans: { [kind]: { detectedComponents: summary.components } } });
    if (values["count-only"]) {
      console.log("Syft " + SYFT_VERSION + " " + name + ": detectedComponents " + summary.components + " (artifact SBOM은 배포하지 않음)");
      return;
    }
    const v = await validateCycloneDx(text);
    if (!v.ok) fail("artifact SBOM 검증 실패: " + JSON.stringify(v));
    if (summary.components < 1) fail("artifact SBOM component가 0개입니다");
    if (summary.absolutePaths.length > 0) fail("artifact SBOM에 절대 경로가 있습니다: " + summary.absolutePaths.join(", "));
    if (summary.sensitive > 0) fail("artifact SBOM에 token·credential로 보이는 값이 " + summary.sensitive + "건 있습니다");
    // D-037: Syft의 Electron 이름 식별은 요구하지 않는다. 식별 여부와 주 실행 파일 이름을 그대로 기록한다.
    const brandingPreserved = summary.mainExecutable !== null && summary.mainExecutable.startsWith(DESKTOP_PRODUCT_NAME + " ") && summary.electronVersion === null;
    record({ electron: { syft: { electronDetected: summary.electronVersion !== null, mainExecutable: summary.mainExecutable, brandingPreserved } } });
    const out = path.resolve(need(values.out, "--out"));
    mkdirSync(path.dirname(out), { recursive: true });
    writeFileSync(out, text);
    console.log("✓ " + path.basename(out) + " (component " + summary.components + ", 주 실행 파일 " + String(summary.mainExecutable) + ", Electron 이름 식별 " + (summary.electronVersion ?? "없음(필수 아님)") + ", 절대 경로·token 0)");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** 고정 공식 URL에서 크기·시간 한도 안으로만 받는다. */
async function boundedDownload(url: string, maxBytes: number, timeoutMs: number): Promise<Buffer> {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: "follow" });
  if (!res.ok || res.body === null) fail("다운로드 실패 " + res.status + ": " + url);
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > maxBytes) fail("다운로드 크기 한도 초과(" + declared + " > " + maxBytes + "): " + url);
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
    total += chunk.byteLength;
    if (total > maxBytes) fail("다운로드 크기 한도 초과: " + url);
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
function treeHashes(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.set(path.relative(root, full).split(path.sep).join("/"), sha256(readFileSync(full)));
    }
  };
  walk(root);
  return out;
}
/** 패키지 Registry 리소스: Registry 검증 issue 0, 각 파일이 저장소 registry와 byte 일치, snapshot은 schema·credential 검사. */
async function verifiedRegistryFiles(registryDir: string): Promise<Set<string>> {
  const { entries, issues } = await validateRegistry(registryDir, { catalog: { asOf: new Date() } });
  if (issues.length > 0) fail("패키지 Registry 검증 실패: " + issues.length + "건");
  const files = treeHashes(registryDir);
  const ok = new Set<string>();
  for (const [rel, hash] of files) {
    if (rel === "metadata.snapshot.json") {
      const checked = await checkBundledSnapshot(path.join(registryDir, rel));
      if (!checked.ok) fail("포함 metadata snapshot 검사 실패: " + checked.reason);
      ok.add(rel);
      continue;
    }
    const source = path.join(ROOT, "registry", ...rel.split("/"));
    if (existsSync(source) && sha256(readFileSync(source)) === hash) ok.add(rel);
  }
  if (entries.length === 0) fail("패키지 Registry에 Manifest가 없습니다");
  return ok;
}
async function electronProvenance() {
  const dir = path.resolve(need(values.dir, "--dir"));
  const expected = expectedElectron();
  const file = electronArchiveName(expected);
  const shasums = (await boundedDownload(electronReleaseUrl(expected, "SHASUMS256.txt"), ELECTRON_DOWNLOAD_LIMITS.shasumsBytes, ELECTRON_DOWNLOAD_LIMITS.shasumsTimeoutMs)).toString("utf8");
  const published = electronShasumFor(shasums, file);
  if (published === null) {
    record({ electron: { expectedVersion: expected, officialArchive: { file, sha256: null, checksum: "missing-entry" } } });
    fail("공식 SHASUMS256.txt에 " + file + " 항목이 없습니다");
  }
  const zip = await boundedDownload(electronReleaseUrl(expected, "archive"), ELECTRON_DOWNLOAD_LIMITS.archiveBytes, ELECTRON_DOWNLOAD_LIMITS.archiveTimeoutMs);
  const actual = sha256(zip);
  const checksum = actual === published ? "verified" : "mismatch";
  record({ electron: { expectedVersion: expected, officialArchive: { file, sha256: actual, checksum } } });
  if (checksum !== "verified") fail("공식 Electron archive SHA256 불일치: " + actual + " ≠ " + published);
  const entries = readZipEntries(zip, undefined, ["version"]);
  const official = new Map(entries.map((e) => [e.path, e.sha256]));
  const versionText = entries.find((e) => e.path === "version")?.text ?? null;
  const registryFiles = await verifiedRegistryFiles(path.join(dir, "resources", "registry"));
  const result = compareElectronProvenance({ official, officialVersionText: versionText, packaged: treeHashes(dir), expectedVersion: expected, registryFiles });
  record({ electron: { runtimeFileProvenance: result } });
  if (result.status !== "verified") fail("runtime file provenance 실패: " + JSON.stringify({ mismatches: result.mismatches, missing: result.missing, unexpected: result.unexpected, exceptions: result.exceptionViolations }));
  console.log("✓ 공식 " + file + " SHA256 일치(" + actual.slice(0, 12) + "…), runtime file " + result.compared + "개 byte 일치, 의도된 예외 " + result.intentionalExceptions.join("·") + ", Registry 리소스 " + result.registryFiles + "개 검증");
}

function extractTgz(tgz: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "openhub-tgz-"));
  execFileSync("tar", ["-xzf", tgz, "-C", dir]);
  return dir;
}
function notices() {
  const kind = need(values.kind, "--kind") as "cli" | "desktop";
  const artifact = need(values.artifact, "--artifact") as ArtifactKind;
  let dir: string;
  let cleanup: string | null = null;
  if (values.tgz !== undefined) {
    cleanup = extractTgz(path.resolve(values.tgz));
    dir = path.join(cleanup, "package");
  } else dir = path.resolve(need(values.dir, "--dir"));
  try {
    const missing = missingNotices(readdirSync(dir), kind);
    setCheck(artifact, "notices", missing.length === 0);
    if (missing.length > 0) fail("고지 파일이 없습니다(" + kind + "): " + missing.join(", "));
    console.log("✓ notices " + kind + ": " + readdirSync(dir).filter((f) => /LICEN[CS]E|NOTICES/iu.test(f)).sort().join(", "));
  } finally {
    if (cleanup !== null) rmSync(cleanup, { recursive: true, force: true });
  }
}

function smokeCli() {
  const tgz = path.resolve(need(values.tgz, "--tgz"));
  const base = mkdtempSync(path.join(os.tmpdir(), "openhub-cli-smoke-"));
  try {
    const prefix = path.join(base, "prefix");
    const cwd = path.join(base, "cwd");
    mkdirSync(cwd);
    execSync("npm install -g --no-audit --no-fund --prefix " + JSON.stringify(prefix) + " " + JSON.stringify(tgz), { stdio: "pipe" });
    const bin = process.platform === "win32" ? path.join(prefix, "openhub.cmd") : path.join(prefix, "bin", "openhub");
    const env = { ...process.env, OPENHUB_REGISTRY: "", OPENHUB_METADATA: "" };
    const run = (args: string) => execSync(JSON.stringify(bin) + " " + args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    const v = run("--version").trim();
    const tools = (JSON.parse(run("registry list --json")) as unknown[]).length;
    const scan = JSON.parse(run("project scan " + JSON.stringify(path.join(ROOT, "packages/core/test/fixtures/projects/react-spring-monorepo")) + " --json")) as { schemaVersion?: number };
    const ok = v === version && tools > 0 && typeof scan.schemaVersion === "number";
    setCheck("cli", "smoke", ok);
    if (!ok) fail("CLI smoke 실패: version " + v + ", tools " + tools);
    console.log("✓ CLI smoke: --version " + v + " · registry list " + tools + "개 · project scan OK");
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

/** 패키징된 앱 --smoke 결과에서 Registry 수와 runtime 정체성을 읽어 lockfile·패키지 버전과 비교한다. */
function checkSmoke(target: RuntimeTarget, stdout: string, status: number | null, stderr: string): boolean {
  const line = stdout.split(/\r?\n/u).find((l) => l.startsWith("OPENHUB_SMOKE "));
  const s = line === undefined ? null : (JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as { tools: number; runtime?: RuntimeEvidence });
  const runtime = s?.runtime ?? { electronVersion: null, chromeVersion: null, openhubVersion: null };
  record({ electron: { expectedVersion: expectedElectron(), runtime: { [target]: runtime } } });
  const ok = status === 0 && s !== null && s.tools > 0 && runtime.electronVersion === expectedElectron() && runtime.openhubVersion === version;
  if (!ok) console.error("✗ " + target + " --smoke 실패 (exit " + String(status) + ", runtime " + JSON.stringify(runtime) + ") " + stderr.slice(-1000));
  else console.log("✓ " + target + " --smoke: tools " + String(s?.tools) + " · Electron " + runtime.electronVersion + " · Chrome " + runtime.chromeVersion + " · OpenHub " + runtime.openhubVersion);
  return ok;
}
const cleanEnv = () => {
  const env = { ...process.env };
  delete env["OPENHUB_REGISTRY"];
  delete env["OPENHUB_METADATA"];
  return env;
};
function smokeUnpacked() {
  if (process.platform !== "win32") fail("smoke-unpacked는 Windows에서만 실행합니다");
  const dir = path.resolve(need(values.dir, "--dir"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "openhub-unpacked-"));
  try {
    const r = spawnSync(path.join(dir, DESKTOP_PRODUCT_NAME + ".exe"), ["--smoke"], { cwd, env: cleanEnv(), encoding: "utf8", timeout: 120_000 });
    if (!checkSmoke("windows-unpacked", r.stdout ?? "", r.status, r.stderr ?? "")) process.exit(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}
function smokeNsis() {
  if (process.platform !== "win32") fail("smoke-nsis는 Windows에서만 실행합니다");
  const installer = path.resolve(need(values.installer, "--installer"));
  const base = mkdtempSync(path.join(os.tmpdir(), "openhub-nsis-"));
  const target = path.join(base, "app");
  const cwd = path.join(base, "cwd");
  mkdirSync(cwd);
  let ok = false;
  try {
    const install = spawnSync(installer, ["/S", "/D=" + target], { stdio: "inherit", timeout: 300_000, windowsVerbatimArguments: true });
    const exe = path.join(target, DESKTOP_PRODUCT_NAME + ".exe");
    if (install.status !== 0 || !existsSync(exe)) throw new Error("NSIS silent 설치 실패 (exit " + String(install.status) + ")");
    for (const f of ["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "LICENSE.electron.txt", "LICENSES.chromium.html", "resources/registry/catalog.yaml"]) if (!existsSync(path.join(target, f))) throw new Error("설치본에 " + f + "가 없습니다");
    const r = spawnSync(exe, ["--smoke"], { cwd, env: cleanEnv(), encoding: "utf8", timeout: 120_000 });
    ok = checkSmoke("windows-installed", r.stdout ?? "", r.status, r.stderr ?? "");
  } catch (error) {
    console.error("✗ " + String(error instanceof Error ? error.message : error));
  } finally {
    const uninstaller = path.join(target, "Uninstall " + DESKTOP_PRODUCT_NAME + ".exe");
    if (existsSync(uninstaller)) {
      spawnSync(uninstaller, ["/S", "_?=" + target], { stdio: "inherit", timeout: 120_000, windowsVerbatimArguments: true });
      const left = existsSync(path.join(target, DESKTOP_PRODUCT_NAME + ".exe"));
      console.log(left ? "✗ 제거 후에도 실행 파일이 남았습니다" : "✓ NSIS silent 제거 완료");
      if (left) ok = false;
    }
    setCheck("windows", "smoke", ok);
    rmSync(base, { recursive: true, force: true });
  }
  if (!ok) process.exit(1);
}
function smokeAppImage() {
  if (process.platform !== "linux") fail("smoke-appimage는 Linux에서만 실행합니다");
  const file = path.resolve(need(values.file, "--file"));
  const cwd = mkdtempSync(path.join(os.tmpdir(), "openhub-appimage-"));
  try {
    // --appimage-extract-and-run은 푼 파일 목록을 stdout에 섞어 결과 줄을 가린다(실측). 먼저 풀고 AppImage의 AppRun으로 실행한다.
    const extract = spawnSync(file, ["--appimage-extract"], { cwd, stdio: "ignore", timeout: 180_000 });
    const appRun = path.join(cwd, "squashfs-root", "AppRun");
    if (extract.status !== 0 || !existsSync(appRun)) fail("AppImage를 풀지 못했습니다 (exit " + String(extract.status) + ")");
    const r = spawnSync(appRun, ["--no-sandbox", "--smoke"], { cwd, env: cleanEnv(), encoding: "utf8", timeout: 180_000 });
    const ok = checkSmoke("linux-appimage", r.stdout ?? "", r.status, r.stderr ?? "");
    setCheck("linux", "smoke", ok);
    if (!ok) process.exit(1);
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

const RELEASE_FILE = /^(openhub-ai-\d+\.\d+\.\d+\.tgz|OpenHub-AI-Setup-\d+\.\d+\.\d+-x64\.exe|OpenHub-AI-\d+\.\d+\.\d+-x86_64\.AppImage|openhub-[a-z]+-(dependencies|artifact)\.cdx\.json)$/u;
function sums() {
  const dir = path.resolve(need(values.dir, "--dir"));
  const files = readdirSync(dir).filter((f) => RELEASE_FILE.test(f));
  writeFileSync(path.join(dir, "SHA256SUMS"), sha256SumsText(files.map((f) => ({ name: f, sha256: sha256(readFileSync(path.join(dir, f))) }))));
  console.log("✓ SHA256SUMS: " + files.length + "개 (" + files.sort().join(", ") + ")");
}
function verifySums() {
  const dir = path.resolve(need(values.dir, "--dir"));
  const entries = parseSha256Sums(readFileSync(path.join(dir, "SHA256SUMS"), "utf8"));
  const bad = entries.filter((e) => !existsSync(path.join(dir, e.name)) || sha256(readFileSync(path.join(dir, e.name))) !== e.sha256);
  const uncovered = readdirSync(dir).filter((f) => RELEASE_FILE.test(f) && !entries.some((e) => e.name === f));
  if (bad.length > 0 || uncovered.length > 0) fail("SHA256SUMS 불일치: " + [...bad.map((e) => e.name), ...uncovered.map((f) => f + "(목록에 없음)")].join(", "));
  console.log("✓ SHA256SUMS 재계산 일치: " + entries.length + "개");
}
function coverage() {
  const dir = path.resolve(need(values.dir, "--dir"));
  const reportsDir = path.resolve(need(values.reports, "--reports"));
  const parts = readdirSync(reportsDir).filter((f) => f.endsWith(".json")).sort().map((f) => JSON.parse(readFileSync(path.join(reportsDir, f), "utf8")) as DryRunReport);
  const report = mergeReports(parts);
  const names = parseSha256Sums(readFileSync(path.join(dir, "SHA256SUMS"), "utf8")).map((e) => e.name);
  const { rows, errors } = buildCoverage(names, report);
  writeFileSync(path.join(dir, "release-coverage.json"), JSON.stringify({ version: report.version, syft: SYFT_VERSION, rows, scans: report.scans }, null, 2) + "\n");
  if (errors.length > 0) fail("release coverage 실패:\n  " + errors.join("\n  "));
  console.log("✓ release-coverage.json: artifact " + rows.length + "개 모두 SBOM·검사·Electron evidence 있음");
}

function localAssets(dir: string): LocalAsset[] {
  return readdirSync(dir)
    .filter((f) => statSync(path.join(dir, f)).isFile())
    .map((f) => {
      const buf = readFileSync(path.join(dir, f));
      return { name: f, size: buf.length, sha256: sha256(buf) };
    });
}
const readReleases = () => flattenReleases(JSON.parse(readFileSync(path.resolve(need(values.releases, "--releases")), "utf8")));
const printIssues = (warnings: readonly string[]) => {
  for (const w of warnings) console.log("  경고: " + w);
};
function checkTag() {
  const errors = checkReleaseTag(need(values.tag, "--tag"), version);
  if (errors.length > 0) fail(errors.join("; "));
  console.log("✓ tag " + values.tag + " = package v" + version);
}
function releaseAssets() {
  const dir = path.resolve(need(values.dir, "--dir"));
  const sumsPath = path.join(dir, SHA256SUMS_FILE);
  const sumsEntries = existsSync(sumsPath) ? parseSha256Sums(readFileSync(sumsPath, "utf8")) : [];
  const errors = checkLocalAssets(version, localAssets(dir), sumsEntries);
  if (errors.length > 0) fail("Release asset 계약 위반:\n  " + errors.join("\n  "));
  const names = releaseAssetNames(version);
  if (values.list !== undefined) writeFileSync(path.resolve(values.list), names.map((n) => path.join(dir, n)).join("\n") + "\n");
  console.log("✓ Release asset " + names.length + "개 (" + names.join(", ") + ")");
}
function githubPlan() {
  const tag = need(values.tag, "--tag");
  const plan = planDraftRelease(readReleases(), tag);
  if (plan.action === "stop") fail(plan.reason);
  const lines = "action=" + plan.action + "\nrelease_id=" + (plan.action === "reuse" ? String(plan.releaseId) : "") + "\n";
  if (values["github-output"] !== undefined) writeFileSync(path.resolve(values["github-output"]), lines, { flag: "a" });
  console.log("✓ " + tag + ": " + (plan.action === "reuse" ? "기존 draft 재사용(id " + plan.releaseId + ")" : "새 draft 생성"));
}
function githubNotes() {
  const tag = need(values.tag, "--tag");
  const plan = planDraftRelease(readReleases(), tag);
  if (plan.action !== "reuse") return fail(tag + "에 고칠 draft가 하나 있어야 합니다(" + (plan.action === "stop" ? plan.reason : "Release 없음") + ")");
  const release = readReleases().find((r) => r.id === plan.releaseId)!;
  const payload = draftNotesUpdate(release, tag, { body: readFileSync(path.resolve(need(values["notes-file"], "--notes-file")), "utf8") });
  writeFileSync(path.resolve(need(values.out, "--out")), JSON.stringify(payload) + "\n");
  console.log("✓ draft id " + release.id + " notes 갱신 본문(tag_name " + payload.tag_name + " 유지)");
}
function githubVerify() {
  const tag = need(values.tag, "--tag");
  const expect = values.expect === "draft" || values.expect === "published" ? values.expect : fail("--expect draft|published가 필요합니다");
  const dir = values.dir === undefined ? null : path.resolve(values.dir);
  const sumsText = readFileSync(dir === null ? path.resolve(need(values.sums, "--sums 또는 --dir")) : path.join(dir, SHA256SUMS_FILE), "utf8");
  const result = verifyGithubRelease({ tag, version, releases: readReleases(), expect, sums: parseSha256Sums(sumsText), ...(dir === null ? {} : { local: localAssets(dir) }) });
  printIssues(result.warnings);
  if (!result.ok) fail("GitHub Release 검증 실패(id " + String(result.releaseId) + "):\n  " + result.errors.join("\n  "));
  console.log("✓ GitHub Release id " + result.releaseId + " (" + expect + "): 필수 asset " + releaseAssetNames(version).length + "개 이름·중복·상태·크기 확인");
  console.log("  digest 일치(독립 기대 해시와 비교): " + result.digestVerified.length + "개 — " + result.digestVerified.join(", "));
  if (result.digestUnchecked.length > 0) console.log("  digest 비교 안 함(독립 기대 해시 없음): " + result.digestUnchecked.join(", "));
}

const commands: Record<string, () => unknown> = {
  "deps-sbom": depsSbom,
  "artifact-sbom": artifactSbom,
  "electron-provenance": electronProvenance,
  notices,
  "smoke-cli": smokeCli,
  "smoke-unpacked": smokeUnpacked,
  "smoke-nsis": smokeNsis,
  "smoke-appimage": smokeAppImage,
  sums,
  "verify-sums": verifySums,
  coverage,
  "check-tag": checkTag,
  "release-assets": releaseAssets,
  "github-plan": githubPlan,
  "github-notes": githubNotes,
  "github-verify": githubVerify,
};
const run = commands[command ?? ""];
if (run === undefined) fail("알 수 없는 명령: " + String(command) + " (" + Object.keys(commands).join(", ") + ")");
await run!();
