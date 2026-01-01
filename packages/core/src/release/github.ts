import { ReleaseError, boundedRequest, parseJsonObject, type ReleaseFetchOptions } from "./fetch";

/**
 * GitHub releases·tags notes(TASK-048, D-007, D-022).
 * - REST `GET api.github.com/repos/{o}/{r}/releases?per_page=30`, 최대 2 페이지, 응답 2 MiB. current tag를 찾으면 멈춘다.
 * - releases가 0개일 때만 `/tags?per_page=30`(최대 2 페이지)으로 tag와 날짜만 얻는다(notes 없음).
 * - draft는 항상 버린다(skippedDrafts). 301 등 저장소 이전은 따라가지 않는다(RELEASE_SOURCE_MOVED).
 * - token은 호출 측(CLI 계층, D-007)이 opaque 값으로 넘길 때만 Authorization header에 붙는다. 결과·오류·로그에 넣지 않는다.
 * - notes 원문은 바꾸지 않는다. 64 KiB(UTF-8 byte)를 넘으면 문자 경계에서 잘라 truncated·originalBytes를 둔다.
 */

export const GITHUB_PER_PAGE = 30;
export const GITHUB_PAGES = 2;
export const GITHUB_MAX_BYTES = 2 * 1024 * 1024;
export const RELEASE_NOTES_MAX_BYTES = 64 * 1024;
/** tags 대체 경로에서 commit 날짜를 조회할 최대 항목 수(target 1 + between 20). */
export const GITHUB_TAG_DATE_LIMIT = 21;

const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;
const TOKEN = /^[\x21-\x7e]{1,4096}$/u;
const SHA = /^[0-9a-f]{40}$/u;

export interface GithubRelease {
  tag: string;
  title: string | null;
  body: string | null;
  publishedAt: string | null;
  url: string | null;
  prerelease: boolean;
}
export interface GithubTag {
  tag: string;
  sha: string;
}
export interface GithubListing {
  kind: "releases" | "tags" | "empty";
  releases: GithubRelease[];
  tags: GithubTag[];
  skippedDrafts: number;
  /** 페이지 상한 때문에 끝까지 보지 못했고 멈춤 조건도 만족하지 못했다. */
  truncated: boolean;
}

export function isGithubRepo(repo: string): boolean {
  return REPO.test(repo) && !repo.split("/").some((part) => part === "." || part === "..");
}

function githubHeaders(token: string | undefined): Record<string, string> {
  if (token !== undefined && !TOKEN.test(token)) throw new ReleaseError("RELEASE_INVALID", "GitHub 인증 값 형식이 올바르지 않습니다");
  return {
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
    "user-agent": "openhub-ai",
    ...(token === undefined ? {} : { authorization: "Bearer " + token }),
  };
}

function parseJsonArray(body: string): unknown[] {
  try {
    const doc: unknown = JSON.parse(body);
    if (Array.isArray(doc)) return doc;
  } catch {
    // 아래에서 형식 오류로 처리한다.
  }
  throw new ReleaseError("RELEASE_INVALID", "GitHub 응답 형식이 올바르지 않습니다");
}

const isoOrNull = (v: unknown) => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
const githubUrl = (v: unknown) => {
  if (typeof v !== "string" || v.length > 2000) return null;
  try {
    const u = new URL(v);
    return u.protocol === "https:" && u.hostname === "github.com" && u.username === "" && u.password === "" && u.port === "" ? u.toString() : null;
  } catch {
    return null;
  }
};

async function page(url: string, token: string | undefined, options: ReleaseFetchOptions): Promise<unknown[]> {
  const res = await boundedRequest(url, { method: "GET", headers: githubHeaders(token), maxBytes: GITHUB_MAX_BYTES, redirect: "manual" }, options);
  return parseJsonArray(res.body);
}

/** releases(없으면 tags)를 최대 2 페이지 읽는다. stopAt(tag)이 true인 항목을 만나면 다음 페이지를 읽지 않는다. */
export async function listGithubReleases(repo: string, stopAt: (tag: string) => boolean, token: string | undefined, options: ReleaseFetchOptions): Promise<GithubListing> {
  if (!isGithubRepo(repo)) throw new ReleaseError("RELEASE_INVALID", "repository.github 값이 owner/repo 형식이 아닙니다");
  const base = "https://api.github.com/repos/" + repo;
  const releases: GithubRelease[] = [];
  let skippedDrafts = 0;
  let seen = 0;
  let truncated = false;
  for (let n = 1; n <= GITHUB_PAGES; n += 1) {
    const items = await page(base + "/releases?per_page=" + String(GITHUB_PER_PAGE) + "&page=" + String(n), token, options);
    seen += items.length;
    let stop = items.length < GITHUB_PER_PAGE;
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const r = item as Record<string, unknown>;
      if (r["draft"] === true) {
        skippedDrafts += 1;
        continue;
      }
      const tag = r["tag_name"];
      if (typeof tag !== "string" || tag.length === 0 || tag.length > 300) continue;
      const name = typeof r["name"] === "string" && r["name"].trim() !== "" ? r["name"].trim() : null;
      releases.push({
        tag,
        title: name,
        body: typeof r["body"] === "string" && r["body"].length > 0 ? r["body"] : null,
        publishedAt: isoOrNull(r["published_at"]),
        url: githubUrl(r["html_url"]),
        prerelease: r["prerelease"] === true,
      });
      if (stopAt(tag)) stop = true;
    }
    if (stop) break;
    if (n === GITHUB_PAGES) truncated = true;
  }
  if (seen > 0) return { kind: "releases", releases, tags: [], skippedDrafts, truncated };

  const tags: GithubTag[] = [];
  for (let n = 1; n <= GITHUB_PAGES; n += 1) {
    const items = await page(base + "/tags?per_page=" + String(GITHUB_PER_PAGE) + "&page=" + String(n), token, options);
    let stop = items.length < GITHUB_PER_PAGE;
    for (const item of items) {
      if (item === null || typeof item !== "object") continue;
      const t = item as Record<string, unknown>;
      const commit = t["commit"] as Record<string, unknown> | undefined;
      const tag = t["name"];
      if (typeof tag !== "string" || tag.length === 0 || tag.length > 300 || typeof commit?.["sha"] !== "string" || !SHA.test(commit["sha"])) continue;
      tags.push({ tag, sha: commit["sha"] });
      if (stopAt(tag)) stop = true;
    }
    if (stop) break;
    if (n === GITHUB_PAGES) truncated = true;
  }
  return { kind: tags.length > 0 ? "tags" : "empty", releases: [], tags, skippedDrafts, truncated };
}

/** tag commit의 날짜(committer, 없으면 author). 날짜만 쓰고 이름·email 등 계정 정보는 버린다. */
export async function githubCommitDate(repo: string, sha: string, token: string | undefined, options: ReleaseFetchOptions): Promise<string | null> {
  if (!isGithubRepo(repo) || !SHA.test(sha)) throw new ReleaseError("RELEASE_INVALID", "GitHub commit을 해석하지 못했습니다");
  const res = await boundedRequest("https://api.github.com/repos/" + repo + "/commits/" + sha, { method: "GET", headers: githubHeaders(token), maxBytes: GITHUB_MAX_BYTES, redirect: "manual" }, options);
  const commit = parseJsonObject(res.body)["commit"] as Record<string, unknown> | undefined;
  const committer = commit?.["committer"] as Record<string, unknown> | undefined;
  const author = commit?.["author"] as Record<string, unknown> | undefined;
  return isoOrNull(committer?.["date"]) ?? isoOrNull(author?.["date"]);
}

/** tag가 정확히 v{ver}·{ver}·{pkg}@{ver} 중 하나인지. 그 밖은 추측하지 않는다. */
export function tagMatches(tag: string, version: string, pkg: string | null): boolean {
  return tag === version || tag === "v" + version || (pkg !== null && tag === pkg + "@" + version);
}

/** tag에서 버전 문자열을 꺼낸다(v{ver}·{pkg}@{ver}·{ver}). */
export function versionFromTag(tag: string, pkg: string | null): string {
  if (pkg !== null && tag.startsWith(pkg + "@")) return tag.slice(pkg.length + 1);
  return /^v\d/u.test(tag) ? tag.slice(1) : tag;
}

/** 원문을 바꾸지 않고 64 KiB에서 UTF-8 문자 경계로 자른다. */
export function truncateNotes(body: string): { text: string; truncated: boolean; originalBytes: number } {
  const buf = Buffer.from(body, "utf8");
  if (buf.byteLength <= RELEASE_NOTES_MAX_BYTES) return { text: body, truncated: false, originalBytes: buf.byteLength };
  let end = RELEASE_NOTES_MAX_BYTES;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end -= 1;
  return { text: buf.subarray(0, end).toString("utf8"), truncated: true, originalBytes: buf.byteLength };
}

