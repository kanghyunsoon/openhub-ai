/**
 * GitHub Release asset 계약과 Release API 결과 검증(순수 함수). scripts/release.ts와 test/release-github.test.ts가 같이 쓴다.
 * 이 파일은 network·child process·파일 시스템을 쓰지 않는다. GitHub API 응답(JSON)과 로컬 파일 정보는 호출 측이 넘긴다.
 *
 * v0.1.0에서 tag 하나에 Release가 둘 생겼다. workflow가 asset 8개를 올린 draft는 공개되지 않았고, 사람이 따로 만든
 * Release가 asset 없이 공개된 뒤 asset을 손으로 다시 올렸다. 그래서 다음을 계약으로 둔다.
 * - 필수 asset 이름은 releaseAssetNames 한 곳에서만 정한다.
 * - 같은 tag의 Release는 하나여야 한다(이미 공개됐으면 workflow가 손대지 않는다, draft 하나면 재사용한다).
 * - asset을 올린 뒤 GitHub API로 이름·중복·상태·크기·digest를 다시 확인한다(workflow artifact가 있다는 것만으로 통과하지 않는다).
 * - draft notes를 고칠 때는 tag_name을 함께 보낸다(빠지면 GitHub가 draft의 tag 연결을 untagged-*로 바꾼다).
 */
import { SBOM_FILES } from "./release-lib";

export const SEMVER_TAG = /^v(\d+\.\d+\.\d+)$/u;
export const SHA256SUMS_FILE = "SHA256SUMS";
export const COVERAGE_FILE = "release-coverage.json";

/** SHA256SUMS가 덮는 asset(설치 파일·tgz·SBOM). */
export function checksummedAssetNames(version: string): string[] {
  return ["openhub-ai-" + version + ".tgz", "OpenHub-AI-Setup-" + version + "-x64.exe", "OpenHub-AI-" + version + "-x86_64.AppImage", SBOM_FILES.cli, SBOM_FILES.desktop, SBOM_FILES.windows];
}
/** GitHub Release에 반드시 있어야 하는 asset 전체(순서 고정). */
export function releaseAssetNames(version: string): string[] {
  return [...checksummedAssetNames(version), COVERAGE_FILE, SHA256SUMS_FILE];
}
/** 버전이 들어간 산출물 이름(다른 버전이 섞였는지 찾는 데 쓴다). */
const VERSIONED = [/^openhub-ai-(\d+\.\d+\.\d+)\.tgz$/u, /^OpenHub-AI-Setup-(\d+\.\d+\.\d+)-x64\.exe$/u, /^OpenHub-AI-(\d+\.\d+\.\d+)-x86_64\.AppImage$/u];

export function checkReleaseTag(tag: string, version: string): string[] {
  const m = SEMVER_TAG.exec(tag);
  if (m === null) return ["SemVer tag(vX.Y.Z)가 아닙니다: " + tag];
  if (m[1] !== version) return ["tag " + tag + " ≠ package v" + version];
  return [];
}

/** 사용자용 Release Notes 파일 위치(저장소 루트 기준). 유지보수자 문서(docs/release-process.md)는 Release 본문으로 쓰지 않는다. */
export function releaseNotesPath(tag: string): string {
  return "docs/release-notes/" + tag + ".md";
}
/** GitHub Release 본문 최대 길이 */
export const RELEASE_NOTES_MAX_CHARS = 125_000;

/**
 * 사용자용 Release Notes 계약: 첫 줄은 "# OpenHub AI <tag>", English, 내부 작업 식별자 없음, 유지보수자 절차 문서가 아님,
 * 이 버전의 내려받을 파일 이름 3개와 SHA256SUMS·unsigned Windows installer·macOS 공식 artifact 없음 안내가 있음.
 */
export function checkReleaseNotes(tag: string, version: string, text: string): string[] {
  const errors: string[] = [];
  const lines = text.split(/\r?\n/u);
  if (lines[0] !== "# OpenHub AI " + tag) errors.push("첫 줄이 \"# OpenHub AI " + tag + "\"가 아닙니다");
  if (text.trim().split(/\r?\n/u).length < 5) errors.push("본문이 비어 있습니다");
  if (text.length > RELEASE_NOTES_MAX_CHARS) errors.push("GitHub Release 본문 한도(" + RELEASE_NOTES_MAX_CHARS + "자)를 넘습니다");
  if (/[\uac00-\ud7a3]/u.test(text)) errors.push("사용자용 Release Notes는 English로 씁니다(한글 포함)");
  if (/\b(?:REQ|TASK|AC)-\d{3}\b|\b[DP]-0\d{2}\b/u.test(text)) errors.push("내부 작업 식별자가 있습니다");
  if (/^# Release process\b|^## Publishing \(manual\)/mu.test(text)) errors.push("유지보수자용 release-process 문서는 Release Notes가 아닙니다");
  for (const name of releaseAssetNames(version).slice(0, 3)) if (!text.includes(name)) errors.push("내려받을 파일 이름이 없습니다: " + name);
  for (const [word, label] of [["SHA256SUMS", "SHA256SUMS 안내"], ["unsigned", "Windows installer unsigned 안내"], ["macOS", "macOS 지원 범위 안내"]] as const) {
    if (!text.includes(word)) errors.push(label + "가 없습니다");
  }
  return errors;
}

export interface LocalAsset {
  name: string;
  size: number;
  sha256: string;
}
export interface SumsEntry {
  name: string;
  sha256: string;
}

/** 올리기 전 로컬 dist 검사: 필수 8개, 크기 > 0, 다른 버전 산출물 없음, SHA256SUMS가 정확히 checksum 대상 6개를 덮고 일치. */
export function checkLocalAssets(version: string, files: readonly LocalAsset[], sums: readonly SumsEntry[]): string[] {
  const errors: string[] = [];
  const byName = new Map(files.map((f) => [f.name, f]));
  for (const name of releaseAssetNames(version)) {
    const f = byName.get(name);
    if (f === undefined) errors.push("필수 asset 없음: " + name);
    else if (f.size <= 0) errors.push("크기 0: " + name);
  }
  for (const f of files) {
    for (const re of VERSIONED) {
      const m = re.exec(f.name);
      if (m !== null && m[1] !== version) errors.push("다른 버전 산출물: " + f.name + " (package v" + version + ")");
    }
  }
  errors.push(...sumsIssues(version, sums));
  for (const e of sums) {
    const f = byName.get(e.name);
    if (f !== undefined && f.sha256 !== e.sha256) errors.push("SHA256SUMS 불일치: " + e.name);
  }
  return errors;
}

function sumsIssues(version: string, sums: readonly SumsEntry[]): string[] {
  const errors: string[] = [];
  const expected = checksummedAssetNames(version);
  const names = sums.map((e) => e.name);
  for (const n of expected) if (!names.includes(n)) errors.push("SHA256SUMS에 없음: " + n);
  for (const n of names) if (!expected.includes(n)) errors.push("SHA256SUMS에 계약 밖 항목: " + n);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) errors.push("SHA256SUMS 중복: " + n);
  return errors;
}

export interface GithubAsset {
  id?: number;
  name: string;
  size: number;
  state: string;
  digest?: string | null;
}
export interface GithubRelease {
  id: number;
  tag_name: string;
  target_commitish?: string;
  name?: string | null;
  draft: boolean;
  published_at: string | null;
  body?: string | null;
  assets: GithubAsset[];
}

/** gh api --paginate --slurp 결과(페이지 배열의 배열)와 단일 배열을 모두 받는다. */
export function flattenReleases(json: unknown): GithubRelease[] {
  if (!Array.isArray(json)) throw new Error("Release 목록이 배열이 아닙니다");
  return (json.every((x) => Array.isArray(x)) ? json.flat() : json) as GithubRelease[];
}

export type DraftPlan = { action: "create" } | { action: "reuse"; releaseId: number } | { action: "stop"; reason: string };

/** release job이 Release를 새로 만들지, 기존 draft 하나를 재사용할지, 멈출지 정한다. 공개된 Release는 절대 고치지 않는다. */
export function planDraftRelease(releases: readonly GithubRelease[], tag: string): DraftPlan {
  const same = releases.filter((r) => r.tag_name === tag);
  const published = same.filter((r) => !r.draft);
  if (published.length > 0) return { action: "stop", reason: tag + "은 이미 공개된 Release가 있습니다(id " + published.map((r) => r.id).join(", ") + "). 공개된 Release는 workflow가 고치지 않습니다" };
  if (same.length > 1) return { action: "stop", reason: tag + "에 draft Release가 " + same.length + "개 있습니다(id " + same.map((r) => r.id).join(", ") + "). 하나만 남기고 다시 실행하세요" };
  if (same.length === 1) return { action: "reuse", releaseId: same[0]!.id };
  return { action: "create" };
}

/**
 * 기존 draft의 notes만 바꾸는 PATCH 본문. tag_name을 반드시 함께 보낸다(빠지면 draft의 tag 연결이 untagged-*로 풀린다).
 * asset 필드는 넣지 않는다(PATCH로는 asset이 바뀌지 않는다). 이미 tag 연결이 풀린 Release는 고치지 않고 멈춘다.
 */
export function draftNotesUpdate(release: GithubRelease, tag: string, notes: { body: string; name?: string }): { tag_name: string; name: string; body: string; draft: true } {
  if (!release.draft) throw new Error("공개된 Release(id " + release.id + ")는 이 경로로 고치지 않습니다");
  if (release.tag_name !== tag) throw new Error("Release id " + release.id + "의 tag가 " + release.tag_name + "입니다(기대 " + tag + "). tag 연결을 먼저 확인하세요");
  return { tag_name: tag, name: notes.name ?? release.name ?? "OpenHub AI " + tag, body: notes.body, draft: true };
}

export interface ReleaseCheck {
  ok: boolean;
  releaseId: number | null;
  errors: string[];
  warnings: string[];
  /** GitHub digest를 독립적인 기대 해시(SHA256SUMS 항목 또는 로컬 파일)와 비교해 맞은 asset */
  digestVerified: string[];
  /** 독립적인 기대 해시가 없어 digest를 비교하지 않은 asset(검증했다고 보고하지 않는다) */
  digestUnchecked: string[];
}

const DIGEST = /^sha256:([0-9a-f]{64})$/u;

/**
 * GitHub API가 돌려준 Release로 asset을 검증한다.
 * - 같은 tag의 Release는 하나(보이는 범위에서), 상태는 expect(draft/published)와 같다.
 * - 필수 asset 이름 ⊆ 실제 이름, 이름 중복 0, state = uploaded, size > 0(로컬 파일이 있으면 같은 크기).
 * - SHA256SUMS가 덮는 6개: GitHub digest가 있어야 하고(sha256:<64 hex>) SHA256SUMS와 같아야 한다. 로컬 파일이 있으면 로컬 해시와도 같아야 한다.
 * - release-coverage.json·SHA256SUMS: 로컬 파일이 있으면(draft 검증) digest가 있어야 하고 로컬 해시와 같아야 한다.
 *   로컬 파일이 없으면(published 검증) 독립적인 기대 해시가 없으므로 digestUnchecked로만 보고한다.
 * - 계약 밖 asset은 경고다.
 */
export function verifyGithubRelease(input: { tag: string; version: string; releases: readonly GithubRelease[]; expect: "draft" | "published"; sums: readonly SumsEntry[]; local?: readonly LocalAsset[]; preserved?: GithubRelease }): ReleaseCheck {
  const errors = [...checkReleaseTag(input.tag, input.version)];
  const warnings: string[] = [];
  const digestVerified: string[] = [];
  const digestUnchecked: string[] = [];
  const same = input.releases.filter((r) => r.tag_name === input.tag);
  if (same.length === 0) return { ok: false, releaseId: null, errors: [...errors, input.tag + "의 GitHub Release가 없습니다"], warnings, digestVerified, digestUnchecked };
  if (same.length > 1) errors.push(input.tag + "에 Release가 " + same.length + "개 있습니다(id " + same.map((r) => r.id + (r.draft ? " draft" : " published")).join(", ") + ")");
  const release = same.find((r) => (input.expect === "draft" ? r.draft : !r.draft)) ?? same[0]!;
  if (input.expect === "draft" && !release.draft) errors.push("Release id " + release.id + "가 draft가 아닙니다");
  if (input.expect === "published" && (release.draft || release.published_at === null)) errors.push("Release id " + release.id + "가 아직 공개되지 않았습니다");
  if (input.preserved !== undefined) errors.push(...preservationIssues(input.preserved, release));
  errors.push(...sumsIssues(input.version, input.sums));

  const names = release.assets.map((a) => a.name);
  for (const n of new Set(names)) if (names.filter((x) => x === n).length > 1) errors.push("asset 이름 중복: " + n);
  const expected = releaseAssetNames(input.version);
  const checksummed = checksummedAssetNames(input.version);
  const sumsByName = new Map(input.sums.map((e) => [e.name, e.sha256]));
  const localByName = new Map((input.local ?? []).map((f) => [f.name, f]));
  for (const name of expected) {
    const asset = release.assets.find((a) => a.name === name);
    if (asset === undefined) {
      errors.push("Release asset 없음: " + name);
      continue;
    }
    if (asset.state !== "uploaded") errors.push("업로드가 끝나지 않은 asset: " + name + " (" + asset.state + ")");
    if (!(asset.size > 0)) errors.push("크기 0 asset: " + name);
    const local = localByName.get(name);
    if (local !== undefined && local.size !== asset.size) errors.push("크기 불일치: " + name + " (Release " + asset.size + " ≠ 로컬 " + local.size + ")");
    // 독립적인 기대 해시: checksum 대상은 SHA256SUMS 항목, 나머지 둘은 로컬 파일(있을 때만).
    const wants = [checksummed.includes(name) ? sumsByName.get(name) : undefined, local?.sha256].filter((x): x is string => x !== undefined);
    if (wants.length === 0) {
      digestUnchecked.push(name);
      continue;
    }
    if (asset.digest === undefined || asset.digest === null) {
      errors.push("GitHub digest 없음: " + name);
      continue;
    }
    const m = DIGEST.exec(asset.digest);
    if (m === null) errors.push("GitHub digest 형식 오류: " + name);
    else if (wants.some((w) => w !== m[1])) errors.push("digest 불일치: " + name);
    else digestVerified.push(name);
  }
  for (const n of new Set(names)) if (!expected.includes(n)) warnings.push("계약 밖 asset: " + n);
  return { ok: errors.length === 0, releaseId: release.id, errors, warnings, digestVerified, digestUnchecked };
}

/**
 * 기존 draft를 재사용했을 때(workflow 재실행) asset 말고는 바뀐 것이 없는지 본다.
 * id·tag·target·제목·본문(사람이 쓴 Release Notes)·draft 상태가 실행 전과 같아야 한다.
 */
export function preservationIssues(before: GithubRelease, after: GithubRelease): string[] {
  const issues: string[] = [];
  if (after.id !== before.id) issues.push("재사용한 draft가 아닙니다(id " + before.id + " → " + after.id + ")");
  if (after.tag_name !== before.tag_name) issues.push("draft의 tag가 바뀌었습니다(" + before.tag_name + " → " + after.tag_name + ")");
  if ((after.target_commitish ?? null) !== (before.target_commitish ?? null)) issues.push("draft의 target이 바뀌었습니다");
  if ((after.name ?? null) !== (before.name ?? null)) issues.push("draft 제목이 바뀌었습니다");
  if ((after.body ?? null) !== (before.body ?? null)) issues.push("draft Release Notes 본문이 바뀌었습니다");
  if (after.draft !== before.draft) issues.push("draft 상태가 바뀌었습니다");
  return issues;
}

