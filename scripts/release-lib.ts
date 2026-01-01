/**
 * Release dry-run 공용 로직(TASK-072, D-036 §13). 테스트(test/release.test.ts)와 scripts/release.ts가 같이 쓴다.
 * - SBOM은 구성 요소 목록, SHA256SUMS는 artifact 무결성이다. 두 역할을 섞지 않는다.
 * - 실제 Release SBOM의 serialNumber·timestamp는 그대로 둔다. 결정론 비교는 sbomSemanticDigest로만 한다.
 */
import { createHash } from "node:crypto";
import { crc32, inflateRawSync } from "node:zlib";
import { Spec, Validation } from "@cyclonedx/cyclonedx-library";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../packages/core/src/recommendation/report";

export const SYFT_VERSION = "v1.54.1";
export const SYFT_SHA256 = {
  windows: "8b56e8285e295e0bbed26eeea9b16ed51c493be97ccdf42dae6326c84fe8e19f",
  linux: "c069905b391cc4c20a5ba65ad5c10be2a7ba074f8ea6ad203e24d14e303dad47",
} as const;
export const SBOM_FILES = { cli: "openhub-cli-dependencies.cdx.json", desktop: "openhub-desktop-dependencies.cdx.json", windows: "openhub-windows-artifact.cdx.json" } as const;
/** 산출물별 필수 고지 파일(산출물 루트 기준). Desktop LICENSE.txt는 OpenHub LICENSE다(electron-builder extraFiles). */
export const REQUIRED_NOTICES = {
  cli: ["LICENSE", "THIRD_PARTY_NOTICES.md"],
  desktop: ["LICENSE.txt", "THIRD_PARTY_NOTICES.md", "LICENSE.electron.txt", "LICENSES.chromium.html"],
} as const;
export type ArtifactKind = "cli" | "windows" | "linux";
export const ARTIFACT_PATTERNS: Record<ArtifactKind, RegExp> = {
  cli: /^openhub-ai-\d+\.\d+\.\d+\.tgz$/u,
  windows: /^OpenHub-AI-Setup-\d+\.\d+\.\d+-x64\.exe$/u,
  linux: /^OpenHub-AI-\d+\.\d+\.\d+-x86_64\.AppImage$/u,
};
/** 절대 경로로 보이는 값(Windows drive, 사용자·runner·임시 디렉터리). URL scheme(http:// 등)은 drive로 보지 않는다. */
export const ABSOLUTE_PATH = /(?<![A-Za-z])[A-Za-z]:[\\/]|\/home\/|\/Users\/|\/tmp\/|\/runner\/|\/github\/workspace|\\\\Users\\\\/u;

type Json = Record<string, unknown>;
interface Component {
  type?: string;
  name?: string;
  group?: string;
  version?: string;
  purl?: string;
  "bom-ref"?: string;
  components?: Component[];
  [k: string]: unknown;
}
export interface CycloneDxBom {
  bomFormat?: string;
  specVersion?: string;
  serialNumber?: string;
  metadata?: { timestamp?: string; tools?: unknown; component?: Component; [k: string]: unknown };
  components?: Component[];
  dependencies?: { ref: string; dependsOn?: string[] }[];
  [k: string]: unknown;
}

export function missingNotices(files: readonly string[], kind: keyof typeof REQUIRED_NOTICES): string[] {
  const have = new Set(files);
  return REQUIRED_NOTICES[kind].filter((f) => !have.has(f));
}

function allComponents(bom: CycloneDxBom): Component[] {
  const out: Component[] = [];
  const walk = (list: Component[] | undefined) => {
    for (const c of list ?? []) {
      out.push(c);
      walk(c.components);
    }
  };
  walk(bom.components);
  return out;
}

/** 참조 무결성: 내용이 다른 component의 bom-ref 중복, dependencies의 ref·dependsOn이 없는 bom-ref를 가리키는 것. */
export function referenceIssues(bom: CycloneDxBom): { duplicateRefs: string[]; brokenRefs: string[] } {
  const seen = new Map<string, string>();
  const duplicateRefs: string[] = [];
  const nodes = [...(bom.metadata?.component === undefined ? [] : [bom.metadata.component]), ...allComponents(bom)];
  for (const c of nodes) {
    const ref = c["bom-ref"];
    if (ref === undefined) continue;
    const body = JSON.stringify(c);
    const prev = seen.get(ref);
    if (prev !== undefined && prev !== body) duplicateRefs.push(ref);
    if (prev === undefined) seen.set(ref, body);
  }
  const brokenRefs = (bom.dependencies ?? []).flatMap((d) => [d.ref, ...(d.dependsOn ?? [])]).filter((r) => !seen.has(r));
  return { duplicateRefs: [...new Set(duplicateRefs)], brokenRefs: [...new Set(brokenRefs)] };
}

/** 공식 @cyclonedx/cyclonedx-library JsonStrictValidator(문서 specVersion) + 참조 무결성. */
export async function validateCycloneDx(text: string): Promise<{ ok: boolean; specVersion: string | null; schemaError: string | null; duplicateRefs: string[]; brokenRefs: string[] }> {
  let bom: CycloneDxBom;
  try {
    bom = JSON.parse(text) as CycloneDxBom;
  } catch {
    return { ok: false, specVersion: null, schemaError: "JSON이 아닙니다", duplicateRefs: [], brokenRefs: [] };
  }
  const specVersion = typeof bom.specVersion === "string" ? bom.specVersion : null;
  const known = (Object.values(Spec.Version) as string[]).includes(specVersion ?? "");
  let schemaError: string | null = known ? null : "지원하지 않는 specVersion: " + String(specVersion);
  if (known) {
    const err = await new Validation.JsonStrictValidator(specVersion as Spec.Version).validate(text);
    schemaError = err === null ? null : JSON.stringify(err).slice(0, 400);
  }
  const { duplicateRefs, brokenRefs } = referenceIssues(bom);
  return { ok: schemaError === null && duplicateRefs.length === 0 && brokenRefs.length === 0, specVersion, schemaError, duplicateRefs, brokenRefs };
}

/** Desktop dependency SBOM에 Electron runtime component 1건을 더한다(electron은 devDependency라 --prod에서 빠진다). */
export function addElectronRuntime(bom: CycloneDxBom, electron: { version: string; license: string }): CycloneDxBom {
  const out = structuredClone(bom);
  const ref = "pkg:npm/electron@" + electron.version;
  out.components = [
    ...(out.components ?? []),
    { type: "framework", name: "electron", version: electron.version, purl: ref, "bom-ref": ref, licenses: [{ license: { id: electron.license } }], properties: [{ name: "openhub:source", value: "electron-runtime" }] },
  ];
  const root = out.metadata?.component?.["bom-ref"];
  const deps = (out.dependencies ?? []).map((d) => (d.ref === root ? { ...d, dependsOn: [...(d.dependsOn ?? []), ref] } : d));
  out.dependencies = [...deps, { ref, dependsOn: [] }];
  return out;
}

const canonical = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonical);
  if (v !== null && typeof v === "object") return Object.fromEntries(Object.keys(v as Json).sort().map((k) => [k, canonical((v as Json)[k])]));
  return v;
};
const keyOf = (c: unknown) => JSON.stringify(canonical(c));

/** serialNumber·timestamp·metadata.tools를 뺀 canonical 형태의 sha256. component·dependency 순서에 영향받지 않는다. */
export function sbomSemanticDigest(bom: CycloneDxBom): string {
  const meta = { ...(bom.metadata ?? {}) };
  delete meta.timestamp;
  delete meta.tools;
  const body = {
    bomFormat: bom.bomFormat,
    specVersion: bom.specVersion,
    metadata: canonical(meta),
    components: allComponents(bom).map((c) => {
      const copy: Json = { ...c };
      delete copy["components"];
      return canonical(copy);
    }).sort((a, b) => (keyOf(a) < keyOf(b) ? -1 : 1)),
    dependencies: (bom.dependencies ?? []).map((d) => ({ ref: d.ref, dependsOn: [...(d.dependsOn ?? [])].sort() })).sort((a, b) => (a.ref < b.ref ? -1 : 1)),
  };
  return createHash("sha256").update(JSON.stringify(body)).digest("hex");
}

/** Desktop 주 실행 파일의 제품 이름(electron-builder productName). Syft가 이 이름으로 식별하면 branding 유지 evidence다. */
export const DESKTOP_PRODUCT_NAME = "OpenHub AI";
/**
 * Syft artifact SBOM 요약: component 수, Electron 이름 식별 여부(필수 아님, D-037), 주 실행 파일 식별 이름,
 * 절대 경로로 보이는 문자열, token·credential URL로 보이는 문자열 수.
 */
export function artifactSummary(text: string): { components: number; electronVersion: string | null; mainExecutable: string | null; absolutePaths: string[]; sensitive: number } {
  const bom = JSON.parse(text) as CycloneDxBom;
  const list = allComponents(bom);
  const electron = list.find((c) => (c.name ?? "").toLowerCase() === "electron");
  const main = list.find((c) => c.name === DESKTOP_PRODUCT_NAME);
  const absolutePaths = [...new Set([...text.matchAll(new RegExp(ABSOLUTE_PATH.source, "gu"))].map((m) => m[0]))];
  const sensitive = [...text.matchAll(new RegExp(TOKEN_PATTERN.source, "gu"))].length + [...text.matchAll(new RegExp(URL_CREDENTIAL_PATTERN.source, "gu"))].length;
  return { components: list.length, electronVersion: electron?.version ?? null, mainExecutable: main === undefined ? null : String(main.name) + " " + String(main.version ?? ""), absolutePaths, sensitive };
}

export const sha256 = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
export function sha256SumsText(entries: readonly { name: string; sha256: string }[]): string {
  return [...entries].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)).map((e) => e.sha256 + "  " + e.name).join("\n") + "\n";
}
export function parseSha256Sums(text: string): { name: string; sha256: string }[] {
  return text.split(/\r?\n/u).filter(Boolean).map((line) => {
    const m = /^([0-9a-f]{64}) {2}(\S.*)$/u.exec(line);
    if (m === null) throw new Error("SHA256SUMS 형식 오류: " + line);
    return { sha256: m[1]!, name: m[2]! };
  });
}

/** 패키징된 앱 --smoke의 runtime 정체성(D-037). */
export interface RuntimeEvidence {
  electronVersion: string | null;
  chromeVersion: string | null;
  openhubVersion: string | null;
}
export type RuntimeTarget = "windows-unpacked" | "windows-installed" | "linux-appimage";
/** job별 부분 보고서가 모으는 Electron evidence. */
export interface ElectronReport {
  expectedVersion?: string;
  dependencySbomVersion?: string | null;
  runtime?: Partial<Record<RuntimeTarget, RuntimeEvidence>>;
  officialArchive?: { file: string; sha256: string | null; checksum: "verified" | "mismatch" | "missing-entry" };
  runtimeFileProvenance?: ProvenanceResult;
  syft?: { electronDetected: boolean; mainExecutable: string | null; brandingPreserved: boolean };
}
/** release-coverage.json Windows 항목의 Electron evidence. Syft의 Electron 미식별은 실패가 아니라 그대로 기록한다. */
export interface WindowsElectronEvidence {
  expectedVersion: string | null;
  dependencySbomVersion: string | null;
  runtimeVersion: string | null;
  installedRuntimeVersion: string | null;
  chromeVersion: string | null;
  openhubVersion: string | null;
  officialArchive: { file: string | null; sha256: string | null; checksum: string };
  runtimeFileProvenance: { status: string; compared: number; mismatches: number; missing: number; unexpected: number; intentionalExceptions: string[]; packagedOnlyAllowed: string[] };
  syftDetectionRequired: false;
  syftElectronDetected: boolean | null;
  brandingPreserved: boolean | null;
  mainExecutable: string | null;
}
export interface LinuxElectronEvidence {
  expectedVersion: string | null;
  dependencySbomVersion: string | null;
  runtimeVersion: string | null;
  chromeVersion: string | null;
  openhubVersion: string | null;
  syftDetectionRequired: false;
}

/** 공식 artifact ↔ SBOM·검사 표(§13). */
export interface CoverageRow {
  artifact: string;
  kind: ArtifactKind;
  dependencySbom: string;
  artifactSbom: string | null;
  artifactScan: { tool: "syft"; version: string; detectedComponents: number };
  checks: { bundleInventory: boolean; notices: boolean; smoke: boolean };
  electron?: WindowsElectronEvidence | LinuxElectronEvidence;
}
export interface DryRunReport {
  version: string;
  scans: Partial<Record<ArtifactKind, { detectedComponents: number }>>;
  checks: Partial<Record<ArtifactKind, { bundleInventory: boolean; notices: boolean; smoke: boolean }>>;
  electron?: ElectronReport;
}

const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
/** job별 부분 보고서를 합친다(객체는 깊게, 나머지는 뒤 값). */
export function mergeReports(parts: readonly DryRunReport[]): DryRunReport {
  const merge = (a: unknown, b: unknown): unknown => {
    if (!isObject(a) || !isObject(b)) return b === undefined ? a : b;
    const out: Record<string, unknown> = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = merge(a[k], v);
    return out;
  };
  return parts.reduce<DryRunReport>((acc, p) => merge(acc, p) as DryRunReport, { version: parts[0]?.version ?? "", scans: {}, checks: {} });
}

function windowsElectron(e: ElectronReport, version: string, errors: string[]): WindowsElectronEvidence {
  const expected = e.expectedVersion ?? null;
  const unpacked = e.runtime?.["windows-unpacked"];
  const installed = e.runtime?.["windows-installed"];
  const prov = e.runtimeFileProvenance;
  const need = (ok: boolean, msg: string) => {
    if (!ok) errors.push("Windows Electron evidence: " + msg);
  };
  need(expected !== null, "lockfile Electron 버전이 없습니다");
  need(e.dependencySbomVersion === expected, "dependency SBOM Electron " + String(e.dependencySbomVersion) + " ≠ lockfile " + String(expected));
  need(unpacked?.electronVersion === expected, "win-unpacked runtime Electron " + String(unpacked?.electronVersion) + " ≠ lockfile " + String(expected));
  need(installed?.electronVersion === expected, "NSIS 설치본 runtime Electron " + String(installed?.electronVersion) + " ≠ lockfile " + String(expected));
  need(unpacked?.openhubVersion === version && installed?.openhubVersion === version, "runtime OpenHub 버전 ≠ " + version);
  need(e.officialArchive?.checksum === "verified", "공식 Electron archive checksum " + String(e.officialArchive?.checksum ?? "없음"));
  need(prov?.status === "verified", "runtime file provenance " + String(prov?.status ?? "없음"));
  need(e.syft?.brandingPreserved === true, "주 실행 파일 branding(OpenHub AI) 확인 실패");
  return {
    expectedVersion: expected,
    dependencySbomVersion: e.dependencySbomVersion ?? null,
    runtimeVersion: unpacked?.electronVersion ?? null,
    installedRuntimeVersion: installed?.electronVersion ?? null,
    chromeVersion: unpacked?.chromeVersion ?? null,
    openhubVersion: unpacked?.openhubVersion ?? null,
    officialArchive: { file: e.officialArchive?.file ?? null, sha256: e.officialArchive?.sha256 ?? null, checksum: e.officialArchive?.checksum ?? "not-run" },
    runtimeFileProvenance: {
      status: prov?.status ?? "not-run",
      compared: prov?.compared ?? 0,
      mismatches: prov?.mismatches.length ?? 0,
      missing: prov?.missing.length ?? 0,
      unexpected: prov?.unexpected.length ?? 0,
      intentionalExceptions: prov?.intentionalExceptions ?? [],
      packagedOnlyAllowed: prov?.packagedOnlyAllowed ?? [],
    },
    syftDetectionRequired: false,
    syftElectronDetected: e.syft?.electronDetected ?? null,
    brandingPreserved: e.syft?.brandingPreserved ?? null,
    mainExecutable: e.syft?.mainExecutable ?? null,
  };
}
function linuxElectron(e: ElectronReport, version: string, errors: string[]): LinuxElectronEvidence {
  const expected = e.expectedVersion ?? null;
  const r = e.runtime?.["linux-appimage"];
  if (expected === null || r?.electronVersion !== expected) errors.push("Linux Electron evidence: AppImage runtime Electron " + String(r?.electronVersion) + " ≠ lockfile " + String(expected));
  if (r?.openhubVersion !== version) errors.push("Linux Electron evidence: runtime OpenHub 버전 ≠ " + version);
  if (e.dependencySbomVersion !== expected) errors.push("Linux Electron evidence: dependency SBOM Electron ≠ lockfile");
  return { expectedVersion: expected, dependencySbomVersion: e.dependencySbomVersion ?? null, runtimeVersion: r?.electronVersion ?? null, chromeVersion: r?.chromeVersion ?? null, openhubVersion: r?.openhubVersion ?? null, syftDetectionRequired: false };
}

export function buildCoverage(sumsNames: readonly string[], report: DryRunReport): { rows: CoverageRow[]; errors: string[] } {
  const rows: CoverageRow[] = [];
  const errors: string[] = [];
  const has = new Set(sumsNames);
  for (const name of [...sumsNames].sort()) {
    const kind = (Object.keys(ARTIFACT_PATTERNS) as ArtifactKind[]).find((k) => ARTIFACT_PATTERNS[k].test(name));
    if (kind === undefined) continue;
    const dependencySbom = kind === "cli" ? SBOM_FILES.cli : SBOM_FILES.desktop;
    const artifactSbom = kind === "windows" ? SBOM_FILES.windows : null;
    const scan = report.scans[kind];
    const checks = report.checks[kind];
    if (!has.has(dependencySbom)) errors.push(name + ": dependency SBOM " + dependencySbom + "이 SHA256SUMS에 없습니다");
    if (artifactSbom !== null && !has.has(artifactSbom)) errors.push(name + ": artifact SBOM " + artifactSbom + "이 SHA256SUMS에 없습니다");
    if (scan === undefined) errors.push(name + ": Syft 검사 결과(detectedComponents)가 없습니다");
    if (kind === "windows" && scan !== undefined && scan.detectedComponents < 1) errors.push(name + ": Windows Syft component가 0개입니다");
    if (checks === undefined) errors.push(name + ": 검사 결과가 없습니다");
    else for (const k of ["bundleInventory", "notices", "smoke"] as const) if (checks[k] !== true) errors.push(name + ": " + k + " 검사가 통과하지 않았거나 결과가 없습니다");
    const row: CoverageRow = { artifact: name, kind, dependencySbom, artifactSbom, artifactScan: { tool: "syft", version: SYFT_VERSION, detectedComponents: scan?.detectedComponents ?? -1 }, checks: checks ?? { bundleInventory: false, notices: false, smoke: false } };
    if (kind === "windows") row.electron = windowsElectron(report.electron ?? {}, report.version, errors);
    if (kind === "linux") row.electron = linuxElectron(report.electron ?? {}, report.version, errors);
    rows.push(row);
  }
  for (const kind of Object.keys(ARTIFACT_PATTERNS) as ArtifactKind[]) if (!rows.some((r) => r.kind === kind)) errors.push(kind + " 공식 artifact가 SHA256SUMS에 없습니다");
  // 0개인 artifact SBOM은 배포하지 않는다(빈 SBOM을 완전한 SBOM처럼 보이지 않게).
  for (const n of sumsNames) if (/-artifact\.cdx\.json$/u.test(n) && n !== SBOM_FILES.windows) errors.push(n + ": Windows 외 artifact SBOM은 배포하지 않습니다");
  return { rows, errors };
}

/** pnpm-lock.yaml에서 apps/desktop의 electron 버전을 읽는다. */
export function lockfileElectronVersion(lock: string): string | null {
  const m = /\n {2}apps\/desktop:[\s\S]*?\n {6}electron:\n {8}specifier: [^\n]+\n {8}version: (\d+\.\d+\.\d+)/u.exec(lock.replace(/\r\n/gu, "\n"));
  return m?.[1] ?? null;
}

// ─── Windows Electron provenance (TASK-072, D-037) ───────────────────────────────

/** 공식 Electron release에서만 받는다. version은 lockfile에서 읽은 SemVer만 허용하고 임의 URL·경로 입력은 없다. */
export const ELECTRON_RELEASE_BASE = "https://github.com/electron/electron/releases/download/";
export const ELECTRON_DOWNLOAD_LIMITS = { shasumsBytes: 1024 * 1024, archiveBytes: 512 * 1024 * 1024, shasumsTimeoutMs: 60_000, archiveTimeoutMs: 600_000 } as const;
export function electronArchiveName(version: string): string {
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new Error("Electron 버전 형식이 아닙니다: " + version);
  return "electron-v" + version + "-win32-x64.zip";
}
export function electronReleaseUrl(version: string, file: "SHASUMS256.txt" | "archive"): string {
  const name = file === "archive" ? electronArchiveName(version) : "SHASUMS256.txt";
  return ELECTRON_RELEASE_BASE + "v" + version + "/" + name;
}
/** Electron SHASUMS256.txt("<sha256> *<file>")에서 한 파일의 hash를 찾는다. 없으면 null. */
export function electronShasumFor(text: string, file: string): string | null {
  for (const line of text.split(/\r?\n/u)) {
    const m = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line.trim());
    if (m !== null && m[2] === file) return m[1]!;
  }
  return null;
}

/** zip entry 이름 containment: 상대 경로·"/" 구분자만, "..", 빈 segment, drive, 절대 경로, backslash, NUL 금지. */
export function safeZipPath(name: string): string | null {
  if (name === "" || name.includes("\\") || name.includes("\0") || name.startsWith("/") || /^[A-Za-z]:/u.test(name)) return null;
  const parts = name.replace(/\/$/u, "").split("/");
  if (parts.some((p) => p === "" || p === "." || p === "..")) return null;
  return parts.join("/");
}

export interface ZipFileEntry {
  path: string;
  size: number;
  sha256: string;
  /** captureText에 이름이 있는 작은 entry의 UTF-8 내용 */
  text?: string;
}
/**
 * 압축을 풀어 쓰지 않고 메모리에서 zip entry의 sha256을 계산한다(디스크 쓰기·path traversal 없음).
 * stored·deflate만 지원하고 zip64·암호화·알 수 없는 method·containment 위반·CRC 불일치·한도 초과는 예외다.
 */
export function readZipEntries(buf: Buffer, limits: { maxEntries: number; maxTotalBytes: number } = { maxEntries: 5000, maxTotalBytes: 2 * 1024 * 1024 * 1024 }, captureText: readonly string[] = []): ZipFileEntry[] {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("zip end of central directory가 없습니다");
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) throw new Error("zip64는 지원하지 않습니다");
  if (count > limits.maxEntries) throw new Error("zip entry가 너무 많습니다: " + count);
  const out: ZipFileEntry[] = [];
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("zip central directory 형식 오류");
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const compSize = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const raw = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    const name = safeZipPath(raw);
    if (name === null) throw new Error("zip entry 경로가 containment를 벗어납니다: " + JSON.stringify(raw));
    if (raw.endsWith("/")) continue;
    if ((flags & 1) !== 0) throw new Error("암호화된 zip entry: " + name);
    if (compSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new Error("zip64 entry는 지원하지 않습니다: " + name);
    total += size;
    if (total > limits.maxTotalBytes) throw new Error("zip 압축 해제 크기 한도 초과");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("zip local header 형식 오류: " + name);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + compSize);
    const body = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: Math.max(1, size) }) : null;
    if (body === null) throw new Error("지원하지 않는 zip method " + method + ": " + name);
    if (body.length !== size || crc32(body) !== crc) throw new Error("zip entry 크기·CRC 불일치: " + name);
    out.push({ path: name, size, sha256: createHash("sha256").update(body).digest("hex"), ...(captureText.includes(name) && size <= 4096 ? { text: body.toString("utf8") } : {}) });
  }
  return out;
}

/** 공식 archive 쪽 의도된 예외(D-037). 각 항목은 이유와 패키지 쪽 기대 상태를 가진다. */
export const ELECTRON_OFFICIAL_EXCEPTIONS = {
  "electron.exe": { packaged: "OpenHub AI.exe", expect: "renamed-branded", reason: "electron-builder가 이름·버전 리소스·asar integrity 리소스를 바꾼다(존재만 확인)" },
  "resources/default_app.asar": { packaged: null, expect: "absent", reason: "앱의 resources/app.asar로 교체된다" },
  version: { packaged: null, expect: "absent", reason: "electron-builder가 제거한다. archive 안 내용 = lockfile 버전" },
} as const;
/** 이름만 바뀌고 byte는 같아야 하는 파일. */
export const ELECTRON_RENAMES: Record<string, string> = { LICENSE: "LICENSE.electron.txt" };
/** 패키지에만 있어도 되는 파일(정확한 경로). resources/registry/는 별도로 Registry 검증 결과와 연결한다. */
export const PACKAGED_ONLY_ALLOWED = ["OpenHub AI.exe", "resources/app.asar", "LICENSE.txt", "THIRD_PARTY_NOTICES.md", "LICENSE.electron.txt", "resources/elevate.exe"] as const;
export const REGISTRY_RESOURCE_PREFIX = "resources/registry/";

export interface ProvenanceResult {
  status: "verified" | "failed";
  compared: number;
  mismatches: string[];
  missing: string[];
  unexpected: string[];
  exceptionViolations: string[];
  intentionalExceptions: string[];
  packagedOnlyAllowed: string[];
  registryFiles: number;
}
/**
 * 공식 archive ↔ 패키지 파일 비교. official·packaged는 상대 경로("/") → sha256.
 * registryFiles: 검증(Registry validation·byte 일치·snapshot 검사)을 통과한 resources/registry/ 아래 상대 경로 집합.
 */
export function compareElectronProvenance(input: {
  official: ReadonlyMap<string, string>;
  officialVersionText: string | null;
  packaged: ReadonlyMap<string, string>;
  expectedVersion: string;
  registryFiles: ReadonlySet<string>;
}): ProvenanceResult {
  const mismatches: string[] = [];
  const missing: string[] = [];
  const unexpected: string[] = [];
  const exceptionViolations: string[] = [];
  const covered = new Set<string>();
  let compared = 0;
  for (const [file, hash] of [...input.official].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const exception = (ELECTRON_OFFICIAL_EXCEPTIONS as Record<string, { packaged: string | null; expect: string }>)[file];
    if (exception !== undefined) {
      if (exception.expect === "renamed-branded" && !input.packaged.has(exception.packaged!)) exceptionViolations.push(file + " → " + String(exception.packaged) + " 없음");
      if (exception.expect === "absent" && input.packaged.has(file)) exceptionViolations.push(file + "가 패키지에 남아 있음");
      if (exception.packaged !== null) covered.add(exception.packaged);
      continue;
    }
    const target = ELECTRON_RENAMES[file] ?? file;
    covered.add(target);
    const got = input.packaged.get(target);
    if (got === undefined) missing.push(target);
    else if (got !== hash) mismatches.push(target);
    else compared += 1;
  }
  if (!input.official.has("version") || (input.officialVersionText ?? "").trim() !== input.expectedVersion) exceptionViolations.push("공식 archive version 파일 ≠ " + input.expectedVersion);
  for (const file of [...input.packaged.keys()].sort()) {
    if (covered.has(file) || (PACKAGED_ONLY_ALLOWED as readonly string[]).includes(file)) continue;
    if (file.startsWith(REGISTRY_RESOURCE_PREFIX) && input.registryFiles.has(file.slice(REGISTRY_RESOURCE_PREFIX.length))) continue;
    unexpected.push(file);
  }
  const ok = mismatches.length === 0 && missing.length === 0 && unexpected.length === 0 && exceptionViolations.length === 0 && compared > 0;
  return {
    status: ok ? "verified" : "failed",
    compared,
    mismatches,
    missing,
    unexpected,
    exceptionViolations,
    intentionalExceptions: Object.keys(ELECTRON_OFFICIAL_EXCEPTIONS),
    packagedOnlyAllowed: [...PACKAGED_ONLY_ALLOWED, REGISTRY_RESOURCE_PREFIX + "(Registry 검증 통과 파일 " + input.registryFiles.size + "개)"],
    registryFiles: input.registryFiles.size,
  };
}
