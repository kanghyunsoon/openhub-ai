import { execFileSync, execSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it } from "vitest";
import {
  ARTIFACT_PATTERNS,
  ELECTRON_OFFICIAL_EXCEPTIONS,
  ELECTRON_RELEASE_BASE,
  PACKAGED_ONLY_ALLOWED,
  REQUIRED_NOTICES,
  SBOM_FILES,
  SYFT_SHA256,
  SYFT_VERSION,
  addElectronRuntime,
  artifactSummary,
  buildCoverage,
  compareElectronProvenance,
  electronReleaseUrl,
  electronShasumFor,
  lockfileElectronVersion,
  mergeReports,
  missingNotices,
  parseSha256Sums,
  readZipEntries,
  safeZipPath,
  sbomSemanticDigest,
  sha256,
  sha256SumsText,
  validateCycloneDx,
  type CycloneDxBom,
  type DryRunReport,
} from "../scripts/release-lib";

/**
 * REQ-065 TASK-072 release dry-run(D-034·D-037). workflow YAML·release 로직을 fixture로 검증한다.
 * 실제 산출물(NSIS·AppImage·Syft·공식 Electron archive)은 release.yml dry-run과 로컬 dry-run으로 확인한다.
 * 이 파일의 child process는 pnpm sbom·tsx scripts뿐이다(network 0).
 */
const ROOT = path.resolve(import.meta.dirname, "..");
const read = (rel: string) => readFileSync(path.join(ROOT, rel), "utf8");
const yml = read(".github/workflows/release.yml");
const scratch = mkdtempSync(path.join(tmpdir(), "openhub-release-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const tsxCli = path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");
const pnpmSbom = (filter: string) => JSON.parse(execSync("pnpm --filter " + filter + " sbom --sbom-format cyclonedx --sbom-type application --prod", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })) as CycloneDxBom;
const ELECTRON = lockfileElectronVersion(read("pnpm-lock.yaml"))!;
const WINDOWS_ARTIFACT = read("test/fixtures/release/windows-artifact.cdx.json");
/** release.yml에서 job 하나의 본문을 잘라 낸다. */
const job = (name: string) => {
  const start = yml.indexOf("\n  " + name + ":\n");
  const next = yml.slice(start + 1).search(/\n {2}[a-z]+:\n/u);
  return next === -1 ? yml.slice(start) : yml.slice(start, start + 1 + next);
};

/** 테스트용 zip(stored·deflate). 이름은 검증 없이 그대로 넣는다(traversal fixture용). */
function zip(entries: { name: string; body: string; deflate?: boolean }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const body = Buffer.from(e.body);
    const data = e.deflate === true ? deflateRawSync(body) : body;
    const name = Buffer.from(e.name);
    const crc = crc32(body);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(e.deflate === true ? 8 : 0, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(e.deflate === true ? 8 : 0, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, data);
    centrals.push(central, name);
    offset += 30 + name.length + data.length;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, eocd]);
}

/** 44.5.1 실측과 같은 모양의 작은 공식 archive·패키지 파일 지도. */
function provenanceInput() {
  const official = new Map<string, string>([
    ["electron.exe", "e0"],
    ["resources/default_app.asar", "d0"],
    ["version", "v0"],
    ["LICENSE", "l0"],
    ["ffmpeg.dll", "f0"],
    ["locales/ko.pak", "k0"],
    ["resources.pak", "r0"],
  ]);
  const packaged = new Map<string, string>([
    ["OpenHub AI.exe", "branded"],
    ["LICENSE.electron.txt", "l0"],
    ["ffmpeg.dll", "f0"],
    ["locales/ko.pak", "k0"],
    ["resources.pak", "r0"],
    ["resources/app.asar", "app"],
    ["resources/elevate.exe", "el"],
    ["LICENSE.txt", "oh"],
    ["THIRD_PARTY_NOTICES.md", "tp"],
    ["resources/registry/catalog.yaml", "c"],
    ["resources/registry/memory/memory-mcp.yaml", "m"],
  ]);
  return { official, officialVersionText: ELECTRON + "\n", packaged, expectedVersion: ELECTRON, registryFiles: new Set(["catalog.yaml", "memory/memory-mcp.yaml"]) };
}

function completeReport(): DryRunReport {
  const runtime = { electronVersion: ELECTRON, chromeVersion: "152.0.7977.130", openhubVersion: "0.1.0" };
  return {
    version: "0.1.0",
    scans: { cli: { detectedComponents: 0 }, windows: { detectedComponents: 8 }, linux: { detectedComponents: 0 } },
    checks: { cli: { bundleInventory: true, notices: true, smoke: true }, windows: { bundleInventory: true, notices: true, smoke: true }, linux: { bundleInventory: true, notices: true, smoke: true } },
    electron: {
      expectedVersion: ELECTRON,
      dependencySbomVersion: ELECTRON,
      runtime: { "windows-unpacked": runtime, "windows-installed": runtime, "linux-appimage": runtime },
      officialArchive: { file: "electron-v" + ELECTRON + "-win32-x64.zip", sha256: "9b".repeat(32), checksum: "verified" },
      runtimeFileProvenance: compareElectronProvenance(provenanceInput()),
      syft: { electronDetected: false, mainExecutable: "OpenHub AI 0.1.0.0", brandingPreserved: true },
    },
  };
}
const SUMS = ["openhub-ai-0.1.0.tgz", "OpenHub-AI-Setup-0.1.0-x64.exe", "OpenHub-AI-0.1.0-x86_64.AppImage", SBOM_FILES.cli, SBOM_FILES.desktop, SBOM_FILES.windows];

describe("REQ-065 TASK-072 release workflow", () => {
  it("AC-072-01 trigger는 dispatch(dry_run 기본 true·publish 기본 false)·tag v*이고 최상위 contents: read, release job만 contents: write다", () => {
    expect(yml).toMatch(/on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}dry_run:\n[^]*?default: true\n {6}publish:\n[^]*?default: false\n {2}push:\n {4}tags: \["v\*"\]\n/u);
    expect(yml).not.toMatch(/\n {2}(pull_request|schedule|workflow_run|workflow_call):/u);
    expect(yml).toMatch(/\npermissions:\n {2}contents: read\n/u);
    expect([...yml.matchAll(/contents: write/gu)]).toHaveLength(1);
    expect(job("release")).toContain("    permissions:\n      contents: write");
  });

  it("AC-072-02 release job은 publish·!dry_run·SemVer tag·tag = package 버전일 때만 draft Release를 만든다", () => {
    const r = job("release");
    expect(r).toContain("if: github.event_name == 'workflow_dispatch' && inputs.publish == true && inputs.dry_run == false && startsWith(github.ref, 'refs/tags/v')");
    // SemVer·package 버전 비교는 release-github-lib checkReleaseTag(test/release-github.test.ts)가 한다.
    expect(r).toContain('pnpm release check-tag --tag "$TAG"');
    expect(r).toContain("gh release create \"$TAG\" --draft");
    expect(r).toContain("needs: verify");
  });

  it("AC-072-03 dry-run은 CLI(ubuntu)·Windows NSIS(windows-latest)·Linux AppImage(ubuntu)를 workflow artifact로만 올린다", () => {
    expect(job("cli")).toContain("runs-on: ubuntu-latest");
    expect(job("windows")).toContain("runs-on: windows-latest");
    expect(job("linux")).toContain("runs-on: ubuntu-latest");
    for (const [name, file] of [["cli", "release-out/openhub-ai-*.tgz"], ["windows", "release-out/desktop/OpenHub-AI-Setup-*-x64.exe"], ["linux", "release-out/desktop/OpenHub-AI-*-x86_64.AppImage"]] as const) {
      expect(job(name)).toContain("actions/upload-artifact@v4");
      expect(job(name)).toContain(file);
    }
    for (const name of ["metadata", "cli", "windows", "linux", "sbom", "verify"]) expect(job(name), name).not.toMatch(/gh release|softprops|create-release/u);
    const builder = read("apps/desktop/electron-builder.yml");
    expect(builder).toContain("publish: null");
    expect(builder).not.toMatch(/signAndEditExecutable/u);
  });

  it("AC-072-04 Layer A dependency SBOM은 frozen install 후 pnpm sbom --sbom-type application --prod이고 Desktop에 Electron runtime component 1건이 있다", { timeout: 60_000 }, () => {
    expect(job("sbom")).toContain("pnpm install --frozen-lockfile");
    expect(job("sbom")).toContain("pnpm release deps-sbom");
    expect(read("scripts/release.ts")).toContain("sbom --sbom-format cyclonedx --sbom-type application --prod");
    const desktop = addElectronRuntime(pnpmSbom("@openhub/desktop"), { version: ELECTRON, license: "MIT" });
    const electron = desktop.components!.filter((c) => c.name === "electron");
    expect(electron).toHaveLength(1);
    expect(electron[0]).toMatchObject({ type: "framework", version: ELECTRON, purl: "pkg:npm/electron@" + ELECTRON, properties: [{ name: "openhub:source", value: "electron-runtime" }] });
    expect(desktop.dependencies!.find((d) => d.ref === desktop.metadata!.component!["bom-ref"])!.dependsOn).toContain("pkg:npm/electron@" + ELECTRON);
    expect(ELECTRON).toBe((JSON.parse(read("apps/desktop/node_modules/electron/package.json")) as { version: string }).version);
  });

  it("AC-072-05 Windows Electron provenance: branding 유지, dependency·runtime·공식 archive·runtime file provenance·Syft inventory(Electron 이름 식별 불필요)", async () => {
    // (1) branding 유지: 실행 파일 편집을 끄지 않고 Syft가 주 실행 파일을 OpenHub AI로 식별한다.
    const summary = artifactSummary(WINDOWS_ARTIFACT);
    expect(summary).toMatchObject({ electronVersion: null, mainExecutable: "OpenHub AI 0.1.0.0", absolutePaths: [], sensitive: 0 });
    expect(summary.components).toBeGreaterThanOrEqual(1);
    expect((await validateCycloneDx(WINDOWS_ARTIFACT)).ok).toBe(true);
    // (3) runtime: 패키징된 앱 --smoke가 process.versions를 낸다.
    const main = read("apps/desktop/src/main.ts");
    expect(main).toContain("const runtime = { electronVersion: process.versions.electron ?? null, chromeVersion: process.versions.chrome ?? null, openhubVersion: OPENHUB_CORE_VERSION };");
    for (const s of ["smoke-unpacked", "smoke-nsis", "electron-provenance"]) expect(job("windows")).toContain("pnpm release " + s);
    // (4) 공식 archive: 고정 URL·SemVer만, SHASUMS 항목 없음·불일치는 FAIL.
    expect(electronReleaseUrl(ELECTRON, "archive")).toBe(ELECTRON_RELEASE_BASE + "v" + ELECTRON + "/electron-v" + ELECTRON + "-win32-x64.zip");
    expect(electronReleaseUrl(ELECTRON, "SHASUMS256.txt")).toBe("https://github.com/electron/electron/releases/download/v" + ELECTRON + "/SHASUMS256.txt");
    for (const bad of ["44.5", "44.5.1/../../x", "https://evil.example/x", "v44.5.1"]) expect(() => electronReleaseUrl(bad, "archive")).toThrow();
    const sums = "9b".repeat(32) + " *electron-v" + ELECTRON + "-win32-x64.zip\n" + "aa".repeat(32) + " *ffmpeg-v" + ELECTRON + "-win32-x64.zip\n";
    expect(electronShasumFor(sums, "electron-v" + ELECTRON + "-win32-x64.zip")).toBe("9b".repeat(32));
    expect(electronShasumFor(sums, "electron-v0.0.1-win32-x64.zip")).toBeNull();
    const rel = read("scripts/release.ts");
    expect(rel).toContain('fail("공식 SHASUMS256.txt에 " + file + " 항목이 없습니다")');
    expect(rel).toContain('fail("공식 Electron archive SHA256 불일치: "');
    expect(rel).toContain("AbortSignal.timeout(timeoutMs)");
    // zip containment: traversal·절대 경로·backslash·drive는 예외, 정상 entry는 hash·text를 얻는다.
    const good = readZipEntries(zip([{ name: "version", body: ELECTRON }, { name: "locales/ko.pak", body: "ko".repeat(50), deflate: true }]), undefined, ["version"]);
    expect(good.map((e) => [e.path, e.sha256, e.text ?? null])).toEqual([["version", sha256(ELECTRON), ELECTRON], ["locales/ko.pak", sha256("ko".repeat(50)), null]]);
    for (const name of ["../evil.dll", "a/../../evil", "/abs.dll", "C:/x.dll", "dir\\..\\evil"]) {
      expect(safeZipPath(name), name).toBeNull();
      expect(() => readZipEntries(zip([{ name, body: "x" }])), name).toThrow(/containment/u);
    }
    // (5) runtime file provenance
    const ok = compareElectronProvenance(provenanceInput());
    expect(ok).toMatchObject({ status: "verified", compared: 4, mismatches: [], missing: [], unexpected: [], exceptionViolations: [] });
    expect(Object.keys(ELECTRON_OFFICIAL_EXCEPTIONS)).toEqual(["electron.exe", "resources/default_app.asar", "version"]);
    expect([...PACKAGED_ONLY_ALLOWED]).toEqual(["OpenHub AI.exe", "resources/app.asar", "LICENSE.txt", "THIRD_PARTY_NOTICES.md", "LICENSE.electron.txt", "resources/elevate.exe"]);
    const vary = (f: (i: ReturnType<typeof provenanceInput>) => void) => {
      const i = provenanceInput();
      f(i);
      return compareElectronProvenance(i);
    };
    expect(vary((i) => i.packaged.set("ffmpeg.dll", "tampered"))).toMatchObject({ status: "failed", mismatches: ["ffmpeg.dll"] });
    expect(vary((i) => i.packaged.set("LICENSE.electron.txt", "other"))).toMatchObject({ status: "failed", mismatches: ["LICENSE.electron.txt"] });
    expect(vary((i) => i.packaged.delete("locales/ko.pak"))).toMatchObject({ status: "failed", missing: ["locales/ko.pak"] });
    expect(vary((i) => i.packaged.set("extra.dll", "x"))).toMatchObject({ status: "failed", unexpected: ["extra.dll"] });
    // registry 아래라도 검증 통과 목록에 없는 파일은 통과하지 않는다.
    expect(vary((i) => i.packaged.set("resources/registry/evil.js", "x"))).toMatchObject({ status: "failed", unexpected: ["resources/registry/evil.js"] });
    expect(vary((i) => i.packaged.set("resources/default_app.asar", "d0")).exceptionViolations).toEqual(["resources/default_app.asar가 패키지에 남아 있음"]);
    expect(vary((i) => i.packaged.delete("OpenHub AI.exe")).status).toBe("failed");
    expect(vary((i) => (i.officialVersionText = "44.0.0")).exceptionViolations).toEqual(["공식 archive version 파일 ≠ " + ELECTRON]);
    expect(rel).toContain("validateRegistry(registryDir");
    expect(rel).toContain('path.join(ROOT, "registry", ...rel.split("/"))');
    // (9) coverage에 Electron evidence가 그대로 남고 Syft 미식별은 실패가 아니다.
    const { rows, errors } = buildCoverage(SUMS, completeReport());
    expect(errors).toEqual([]);
    expect(rows.find((r) => r.kind === "windows")!.electron).toMatchObject({
      expectedVersion: ELECTRON, dependencySbomVersion: ELECTRON, runtimeVersion: ELECTRON, installedRuntimeVersion: ELECTRON, chromeVersion: "152.0.7977.130",
      officialArchive: { checksum: "verified" }, runtimeFileProvenance: { status: "verified", compared: 4, mismatches: 0 },
      syftDetectionRequired: false, syftElectronDetected: false, brandingPreserved: true, mainExecutable: "OpenHub AI 0.1.0.0",
    });
    const mutations: [string, (r: DryRunReport) => void][] = [
      ["runtime", (r) => (r.electron!.runtime!["windows-installed"] = { electronVersion: "43.0.0", chromeVersion: null, openhubVersion: "0.1.0" })],
      ["dependency", (r) => (r.electron!.dependencySbomVersion = "43.0.0")],
      ["checksum", (r) => (r.electron!.officialArchive!.checksum = "mismatch")],
      ["branding", (r) => (r.electron!.syft!.brandingPreserved = false)],
    ];
    for (const [label, mutate] of mutations) {
      const report = completeReport();
      mutate(report);
      expect(buildCoverage(SUMS, report).errors.length, label).toBeGreaterThan(0);
    }
  });

  it("AC-072-06 sbomSemanticDigest는 serialNumber·timestamp·tools와 순서를 무시하고 같은 commit 두 번 생성에서 같으며 배포 SBOM에는 실제 값이 남는다", { timeout: 60_000 }, () => {
    const a = pnpmSbom("@openhub/cli");
    const b = pnpmSbom("@openhub/cli");
    expect(sbomSemanticDigest(a)).toBe(sbomSemanticDigest(b));
    expect(a.serialNumber).toMatch(/^urn:uuid:/u);
    expect(typeof a.metadata?.timestamp).toBe("string");
    const shuffled = { ...a, serialNumber: "urn:uuid:00000000-0000-0000-0000-000000000000", metadata: { ...a.metadata, timestamp: "2000-01-01T00:00:00Z", tools: [] }, components: [...(a.components ?? [])].reverse() };
    expect(sbomSemanticDigest(shuffled)).toBe(sbomSemanticDigest(a));
    const changed = { ...a, components: (a.components ?? []).map((c, i) => (i === 0 ? { ...c, version: "9.9.9" } : c)) };
    expect(sbomSemanticDigest(changed)).not.toBe(sbomSemanticDigest(a));
    expect(read("scripts/release.ts")).toContain("semantic digest가 두 번 생성에서 다릅니다");
  });

  it("AC-072-07 SHA256SUMS는 installer·AppImage·tgz·SBOM 전부를 덮고 verify job이 재계산한다", () => {
    const entries = SUMS.map((name) => ({ name, sha256: sha256(name) }));
    const text = sha256SumsText(entries);
    expect(parseSha256Sums(text).map((e) => e.name).sort()).toEqual([...SUMS].sort());
    expect(() => parseSha256Sums("nothex  file\n")).toThrow();
    const v = job("verify");
    expect(v.indexOf("pnpm release sums --dir dist")).toBeLessThan(v.indexOf("pnpm release verify-sums --dir dist"));
    const pattern = new RegExp(read("scripts/release.ts").match(/const RELEASE_FILE = (\/.*\/)u;/u)![1]!.slice(1, -1), "u");
    for (const f of SUMS) expect(pattern.test(f), f).toBe(true);
    for (const f of ["SHA256SUMS", "release-coverage.json", "sbom-semantic.json"]) expect(pattern.test(f), f).toBe(false);
  });

  it("AC-072-08 고지 파일은 실제 산출물 목록에서 확인하고 하나라도 빠지면 실패한다(설정으로 빠지는 경우 포함)", () => {
    expect(REQUIRED_NOTICES).toEqual({ cli: ["LICENSE", "THIRD_PARTY_NOTICES.md"], desktop: ["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "LICENSE.electron.txt", "LICENSES.chromium.html"] });
    expect(missingNotices(["LICENSE", "THIRD_PARTY_NOTICES.md", "dist"], "cli")).toEqual([]);
    expect(missingNotices(["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "LICENSE.electron.txt"], "desktop")).toEqual(["LICENSES.chromium.html"]);
    // electron-builder 설정에서 extraFiles를 빼면 산출물에 OpenHub 고지가 없어진다 → 같은 검사가 잡는다.
    const builder = read("apps/desktop/electron-builder.yml");
    expect(builder).toContain("  - from: ../../LICENSE\n    to: LICENSE.txt");
    expect(builder).toContain("  - from: ../../THIRD_PARTY_NOTICES.md\n    to: THIRD_PARTY_NOTICES.md");
    const withoutExtraFiles = ["LICENSE.electron.txt", "LICENSES.chromium.html", "OpenHub AI.exe", "resources"];
    expect(missingNotices(withoutExtraFiles, "desktop")).toEqual(["LICENSE.txt", "THIRD_PARTY_NOTICES.md"]);
    expect(job("windows")).toContain("pnpm release notices --kind desktop --dir release-out/desktop/win-unpacked --artifact windows");
    expect(job("linux")).toContain("--appimage-extract");
    expect(job("linux")).toContain("pnpm release notices --kind desktop --dir \"$RUNNER_TEMP/appimage/squashfs-root\" --artifact linux");
    expect(job("cli")).toContain("pnpm release notices --kind cli --tgz");
  });

  it("AC-072-09 smoke install: NSIS silent 설치→--smoke→제거, AppImage --smoke(xvfb), CLI tgz 깨끗한 prefix", () => {
    const rel = read("scripts/release.ts");
    for (const s of ['spawnSync(installer, ["/S", "/D=" + target]', '"Uninstall " + DESKTOP_PRODUCT_NAME + ".exe"', 'spawnSync(file, ["--appimage-extract"]', 'spawnSync(appRun, ["--no-sandbox", "--smoke"]', 'run("--version")', 'run("registry list --json")', 'run("project scan "']) expect(rel).toContain(s);
    expect(job("linux")).toContain("xvfb-run -a pnpm release smoke-appimage");
    expect(job("windows")).toContain("pnpm release smoke-nsis");
    expect(job("cli")).toContain("pnpm release smoke-cli");
  });

  it("AC-072-10 workflow에 npm publish·추가 secret·tag 생성이 없다", () => {
    expect(yml).not.toMatch(/npm publish|pnpm publish|secrets\.|git tag|git push/u);
    expect([...yml.matchAll(/\$\{\{ github\.token \}\}/gu)]).toHaveLength(2);
    expect([...yml.matchAll(/gh release create/gu)]).toHaveLength(1);
  });

  it("AC-072-11 CLI dependency SBOM이 공식 JsonStrictValidator와 참조 무결성 검사를 통과한다", { timeout: 60_000 }, async () => {
    const v = await validateCycloneDx(JSON.stringify(pnpmSbom("@openhub/cli")));
    expect(v).toMatchObject({ ok: true, specVersion: "1.7", schemaError: null, duplicateRefs: [], brokenRefs: [] });
  });

  it("AC-072-12 Electron을 보강한 Desktop dependency SBOM이 schema·참조 무결성 검사를 통과한다", { timeout: 60_000 }, async () => {
    const v = await validateCycloneDx(JSON.stringify(addElectronRuntime(pnpmSbom("@openhub/desktop"), { version: ELECTRON, license: "MIT" })));
    expect(v.ok).toBe(true);
  });

  it("AC-072-13 Windows artifact Syft SBOM이 schema·참조 무결성 검사를 통과한다(고정 Syft·checksum)", async () => {
    expect(await validateCycloneDx(WINDOWS_ARTIFACT)).toMatchObject({ ok: true, specVersion: "1.7" });
    expect(SYFT_VERSION).toBe("v1.54.1");
    expect(yml).toContain("SYFT_VERSION: " + SYFT_VERSION);
    expect(yml).toContain("SYFT_SHA256_LINUX: " + SYFT_SHA256.linux);
    expect(yml).toContain("SYFT_SHA256_WINDOWS: " + SYFT_SHA256.windows);
    expect(yml).toContain("sha256sum -c -");
    expect(yml).toContain('throw "Syft checksum 불일치"');
    expect(read("scripts/release.ts")).toContain('SYFT_FILE_METADATA_SELECTION: "none"');
  });

  it("AC-072-14 schema 위반 fixture(잘못된 type·필수 필드 누락)는 FAIL이다", async () => {
    const base = JSON.parse(WINDOWS_ARTIFACT) as CycloneDxBom;
    const badType = structuredClone(base);
    badType.components![0]!.type = "not-a-type";
    const noName = structuredClone(base);
    delete noName.components![1]!.name;
    for (const bom of [badType, noName]) {
      const v = await validateCycloneDx(JSON.stringify(bom));
      expect(v.ok).toBe(false);
      expect(v.schemaError).not.toBeNull();
    }
    expect((await validateCycloneDx("{")).ok).toBe(false);
  });

  it("AC-072-15 내용이 다른 bom-ref 중복과 없는 bom-ref를 가리키는 dependsOn은 각각 FAIL이다", async () => {
    const base = addElectronRuntime(JSON.parse(WINDOWS_ARTIFACT) as CycloneDxBom, { version: ELECTRON, license: "MIT" });
    const dup = structuredClone(base);
    dup.components!.push({ ...structuredClone(dup.components![0]!), name: "different" });
    const vd = await validateCycloneDx(JSON.stringify(dup));
    expect(vd).toMatchObject({ ok: false, duplicateRefs: [dup.components![0]!["bom-ref"]] });
    const broken = structuredClone(base);
    broken.dependencies!.push({ ref: "pkg:npm/electron@" + ELECTRON, dependsOn: ["pkg:npm/does-not-exist@0.0.0"] });
    const vb = await validateCycloneDx(JSON.stringify(broken));
    expect(vb).toMatchObject({ ok: false, brokenRefs: ["pkg:npm/does-not-exist@0.0.0"] });
  });

  it("AC-072-16 release-coverage.json은 SHA256SUMS의 모든 artifact에 SBOM·검사를 요구하고 빠지면 FAIL이다", () => {
    expect(buildCoverage(SUMS, completeReport()).errors).toEqual([]);
    expect(buildCoverage(SUMS.filter((f) => f !== SBOM_FILES.desktop), completeReport()).errors.join("\n")).toContain("openhub-desktop-dependencies.cdx.json");
    expect(buildCoverage(SUMS.filter((f) => f !== SBOM_FILES.windows), completeReport()).errors.join("\n")).toContain("artifact SBOM");
    const noSmoke = completeReport();
    delete (noSmoke.checks.linux as Record<string, boolean>)["smoke"];
    expect(buildCoverage(SUMS, noSmoke).errors.join("\n")).toContain("smoke");
    expect(buildCoverage(SUMS.filter((f) => !ARTIFACT_PATTERNS.linux.test(f)), completeReport()).errors.join("\n")).toContain("linux 공식 artifact");
    // job별 부분 보고서를 깊게 합친다.
    const merged = mergeReports([
      { version: "0.1.0", scans: { cli: { detectedComponents: 0 } }, checks: { cli: { bundleInventory: true } as never } },
      { version: "0.1.0", scans: {}, checks: { cli: { notices: true, smoke: true } as never }, electron: { expectedVersion: ELECTRON } },
    ]);
    expect(merged).toMatchObject({ scans: { cli: { detectedComponents: 0 } }, checks: { cli: { bundleInventory: true, notices: true, smoke: true } }, electron: { expectedVersion: ELECTRON } });
    expect(job("verify")).toContain("pnpm release coverage --dir dist --reports reports");
  });

  it("AC-072-17 Linux·CLI는 detectedComponents만 기록하고 artifact SBOM을 배포하지 않으며 문서에 scan 한계가 있다", () => {
    expect(job("linux")).toContain("--kind linux --count-only");
    expect(job("cli")).toContain("--kind cli --count-only");
    expect(buildCoverage([...SUMS, "openhub-linux-artifact.cdx.json"], completeReport()).errors.join("\n")).toContain("Windows 외 artifact SBOM은 배포하지 않습니다");
    const rows = buildCoverage(SUMS, completeReport()).rows;
    expect(rows.find((r) => r.kind === "linux")!.artifactScan.detectedComponents).toBe(0);
    expect(rows.find((r) => r.kind === "cli")!.artifactSbom).toBeNull();
    const doc = read("docs/release-process.md");
    const readme = read("README.md");
    const readmeKo = read("README.ko.md");
    for (const t of [doc, readme, readmeKo]) {
      expect(t).toContain("app.asar");
      expect(t).toMatch(/Syft/u);
    }
    expect(doc).toContain("Syft may not identify the Electron executable as Electron");
    expect(readme).toContain("Syft may not identify it as Electron");
    expect(readmeKo).toContain("Syft artifact inventory는 Electron 실행 파일을 Electron으로 식별하지 않을 수 있으며");
  });

  it("AC-072-18 bundle package가 dependency SBOM에 없으면 deps-sbom이 FAIL이다(CLI·Desktop)", { timeout: 120_000 }, () => {
    const meta = path.join(scratch, "missing.metafile.json");
    writeFileSync(meta, JSON.stringify({ inputs: { "node_modules/.pnpm/left-pad@1.3.0/node_modules/left-pad/index.js": {}, "node_modules/.pnpm/zod@4.6.5/node_modules/zod/index.js": {} } }));
    for (const flag of ["--cli-metafile", "--desktop-metafile"]) {
      let failed = false;
      let stderr = "";
      try {
        execFileSync(process.execPath, [tsxCli, "scripts/release.ts", "deps-sbom", "--out", path.join(scratch, "sbom" + flag), flag, meta], { cwd: ROOT, stdio: "pipe" });
      } catch (error) {
        failed = true;
        stderr = String((error as { stderr?: Buffer }).stderr ?? "");
      }
      expect(failed, flag).toBe(true);
      expect(stderr).toContain("left-pad");
    }
  });
});
