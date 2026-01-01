import { createHash } from "node:crypto";
import { z } from "zod";
import { parseNpmSpec } from "../installer/command";
import { canonicalize } from "../installer/plan";
import { parseImageRef, resolveArtifact } from "../lifecycle/resolver";
import type { ArtifactIdentity } from "../lifecycle/state";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, redactSensitive } from "../recommendation/index";
import { ReleaseError, boundedRequest, parseJsonObject, type ReleaseErrorCode, type ReleaseFetchOptions } from "./fetch";
import { GITHUB_TAG_DATE_LIMIT, githubCommitDate, isGithubRepo, listGithubReleases, tagMatches, truncateNotes, versionFromTag, type GithubListing } from "./github";
import { comparePep440, compareSemver, isPep440Prerelease, parsePep440, parseSemver, semverText, type Pep440, type SemVer } from "./version";

/**
 * ReleaseSnapshot v1과 버전 출처(TASK-047, D-022).
 * - 메모리 객체다. Version State(LifecycleStateFile v1)에 넣지 않는다.
 * - 같은 source 입력 + 같은 주입 clock + 같은 옵션이면 직렬화 byte가 같다. metadataDigest는 collectedAt을 빼고 계산한다.
 * - 버전 출처: npm(dist-tag latest 문서), PyPI(프로젝트 JSON의 releases), Docker(tags list 3 페이지 + target manifest digest),
 *   github-release(repository.github의 releases tag, TASK-048). git은 지원하지 않는다.
 * - notes: request.github(Manifest repository.github)가 있으면 GitHub releases(없으면 tags 날짜)로 target·between을 채운다(TASK-048).
 * - draft는 항상 제외한다(skippedDrafts). prerelease는 current가 prerelease이거나 includePrerelease일 때만 target·between에 들어간다.
 * - 비교할 수 없는 버전은 추측하지 않는다: target을 고르지 못하면 null이고 selection.comparable false다.
 */

export const RELEASE_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const VERSION_SOURCES = ["npm", "pypi", "docker-tag", "github-release", "git"] as const;
export type VersionSource = (typeof VERSION_SOURCES)[number];
export const NOTES_SOURCES = ["github-release", "github-tag", "none"] as const;
export const RELEASE_MAX_BYTES = { npm: 1024 * 1024, pypi: 8 * 1024 * 1024, docker: 1024 * 1024 } as const;
export const DOCKER_TAG_PAGES = 3;
export const RELEASE_BETWEEN_LIMIT = 20;
export const DEPRECATED_MAX_CHARS = 300;

const text = z.string().min(1).max(300);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);

export const releaseEntrySchema = z.strictObject({
  version: text,
  tag: text.nullable(),
  publishedAt: z.iso.datetime().nullable(),
  prerelease: z.boolean(),
  yanked: z.boolean(),
  deprecated: z.string().min(1).max(DEPRECATED_MAX_CHARS).nullable(),
  title: z.string().min(1).max(300).nullable(),
  notes: z.strictObject({ text: z.string().max(64 * 1024), truncated: z.boolean(), originalBytes: z.number().int().min(0) }).nullable(),
  url: z.url().nullable(),
  /** Docker tag의 manifest digest(그 밖의 출처는 null). */
  digest: sha256.nullable(),
  runtime: z.strictObject({ node: z.string().min(1).max(100).nullable(), python: z.string().min(1).max(100).nullable() }),
});
export type ReleaseEntry = z.output<typeof releaseEntrySchema>;

export const releaseSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(RELEASE_SNAPSHOT_SCHEMA_VERSION),
    toolId: text,
    versionSource: z.enum(VERSION_SOURCES),
    notesSource: z.enum(NOTES_SOURCES),
    current: z.strictObject({ spec: text, version: z.string().min(1).max(100).nullable(), digest: sha256.nullable() }),
    target: releaseEntrySchema.nullable(),
    between: z.array(releaseEntrySchema).max(RELEASE_BETWEEN_LIMIT),
    selection: z.strictObject({
      includePrerelease: z.boolean(),
      /** 버전을 비교해 target을 고를 수 있었는지(Docker SemVer tag 없음 등은 false). */
      comparable: z.boolean(),
      skippedDrafts: z.number().int().min(0),
      skippedPrereleases: z.number().int().min(0),
      truncated: z.boolean(),
    }),
    collectedAt: z.iso.datetime(),
    metadataDigest: sha256,
  })
  .superRefine((snap, ctx) => {
    // notes 원문은 외부 데이터라 검사하지 않는다(TASK-048에서 표시 규칙으로 다룬다). 나머지에는 credential이 없어야 한다.
    const walk = (value: unknown, path: (string | number)[]): void => {
      if (typeof value === "string") {
        if (URL_CREDENTIAL_PATTERN.test(value) || TOKEN_PATTERN.test(value)) ctx.addIssue({ code: "custom", path, message: "ReleaseSnapshot에 credential이 포함될 수 없습니다" });
      } else if (Array.isArray(value)) value.forEach((v, i) => walk(v, [...path, i]));
      else if (value !== null && typeof value === "object") {
        for (const [k, v] of Object.entries(value)) if (k !== "notes") walk(v, [...path, k]);
      }
    };
    walk(snap, []);
  });
export type ReleaseSnapshotV1 = z.output<typeof releaseSnapshotSchema>;

export function releaseMetadataDigest(snapshot: Omit<ReleaseSnapshotV1, "metadataDigest" | "collectedAt"> & Partial<Pick<ReleaseSnapshotV1, "metadataDigest" | "collectedAt">>): string {
  const { collectedAt: _c, metadataDigest: _d, ...rest } = snapshot;
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonicalize(rest))).digest("hex");
}

export function serializeReleaseSnapshot(snapshot: ReleaseSnapshotV1): string {
  return JSON.stringify(canonicalize(releaseSnapshotSchema.parse(snapshot)), null, 2) + "\n";
}

// ---------------------------------------------------------------- 출처별 후보

interface Candidate {
  entry: ReleaseEntry;
  /** 같은 출처 안에서만 쓰는 비교 함수용 키 */
  key: unknown;
}
interface SourceResult {
  candidates: Candidate[];
  compare: (a: unknown, b: unknown) => number;
  /** 문자열 버전을 같은 규칙으로 해석한다(current 비교용). */
  parse: (version: string) => unknown;
  isPrerelease: (key: unknown) => boolean;
  truncated: boolean;
  /** 출처가 target 하나만 알려 준다(npm latest 문서). 중간 버전은 GitHub releases로 보충한다(TASK-048). */
  partialHistory?: boolean;
  resolveDigest?: (tag: string) => Promise<string>;
}

const baseEntry = (version: string): ReleaseEntry => ({
  version,
  tag: null,
  publishedAt: null,
  prerelease: false,
  yanked: false,
  deprecated: null,
  title: null,
  notes: null,
  url: null,
  digest: null,
  runtime: { node: null, python: null },
});
const shortText = (v: unknown, max: number) => (typeof v === "string" && v.trim() !== "" ? redactSensitive(v.trim()).slice(0, max) : null);
const isoOrNull = (v: unknown) => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};

async function npmSource(requested: string, options: ReleaseFetchOptions): Promise<SourceResult> {
  const parsed = parseNpmSpec(requested);
  if (parsed === null) throw new ReleaseError("RELEASE_INVALID", "npm 패키지 이름을 해석하지 못했습니다");
  const name = parsed.name.startsWith("@") ? parsed.name.replace("/", "%2f") : parsed.name;
  // dist-tag latest 문서가 target 버전 문서다(version·deprecated·engines가 들어 있다).
  const res = await boundedRequest("https://registry.npmjs.org/" + name + "/latest", { method: "GET", headers: { accept: "application/json" }, maxBytes: RELEASE_MAX_BYTES.npm }, options);
  const doc = parseJsonObject(res.body);
  const version = typeof doc["version"] === "string" ? parseSemver(doc["version"]) : null;
  if (doc["name"] !== parsed.name || version === null) throw new ReleaseError("RELEASE_INVALID", "npm registry가 올바른 버전을 돌려주지 않았습니다");
  const engines = doc["engines"] as Record<string, unknown> | undefined;
  const entry: ReleaseEntry = {
    ...baseEntry(semverText(version)),
    prerelease: version.pre.length > 0,
    deprecated: shortText(doc["deprecated"], DEPRECATED_MAX_CHARS),
    runtime: { node: shortText(engines?.["node"], 100), python: null },
  };
  return { candidates: [{ entry, key: version }], ...SEMVER_RULES, truncated: false, partialHistory: true };
}

const SEMVER_RULES = {
  compare: (a: unknown, b: unknown) => compareSemver(a as SemVer, b as SemVer),
  parse: (v: string) => parseSemver(v),
  isPrerelease: (k: unknown) => (k as SemVer).pre.length > 0,
};

const PY_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;

async function pypiSource(requested: string, options: ReleaseFetchOptions): Promise<SourceResult> {
  const name = requested.split("==")[0]!.trim();
  if (!PY_NAME.test(name)) throw new ReleaseError("RELEASE_INVALID", "Python 패키지 이름을 해석하지 못했습니다");
  const res = await boundedRequest("https://pypi.org/pypi/" + name + "/json", { method: "GET", headers: { accept: "application/json" }, maxBytes: RELEASE_MAX_BYTES.pypi }, options);
  const doc = parseJsonObject(res.body);
  const info = doc["info"] as Record<string, unknown> | undefined;
  const releases = doc["releases"];
  const normalize = (s: string) => s.toLowerCase().replace(/[-_.]+/gu, "-");
  if (typeof info?.["name"] !== "string" || normalize(info["name"]) !== normalize(name) || releases === null || typeof releases !== "object" || Array.isArray(releases)) {
    throw new ReleaseError("RELEASE_INVALID", "PyPI 응답 형식이 올바르지 않습니다");
  }
  const candidates: Candidate[] = [];
  for (const [raw, files] of Object.entries(releases as Record<string, unknown>)) {
    const v = parsePep440(raw);
    if (v === null || !Array.isArray(files) || files.length === 0) continue;
    const list = files.filter((f): f is Record<string, unknown> => f !== null && typeof f === "object");
    const times = list.map((f) => isoOrNull(f["upload_time_iso_8601"])).filter((t): t is string => t !== null).sort();
    candidates.push({
      key: v,
      entry: {
        ...baseEntry(raw),
        prerelease: isPep440Prerelease(v),
        yanked: list.length > 0 && list.every((f) => f["yanked"] === true),
        publishedAt: times[0] ?? null,
        url: "https://pypi.org/project/" + name + "/" + raw + "/",
        runtime: { node: null, python: shortText(list.find((f) => typeof f["requires_python"] === "string")?.["requires_python"], 100) },
      },
    });
  }
  return {
    candidates,
    compare: (a, b) => comparePep440(a as Pep440, b as Pep440),
    parse: (v) => parsePep440(v),
    isPrerelease: (k) => isPep440Prerelease(k as Pep440),
    truncated: false,
  };
}

async function dockerSource(requested: string, options: ReleaseFetchOptions): Promise<SourceResult> {
  const ref = parseImageRef(requested);
  if (ref === null) throw new ReleaseError("RELEASE_SOURCE_UNSUPPORTED", "ghcr.io·Docker Hub 이외의 image registry는 지원하지 않습니다");
  const tokenUrl =
    ref.host === "ghcr.io"
      ? "https://ghcr.io/token?scope=repository:" + ref.repo + ":pull"
      : "https://auth.docker.io/token?service=registry.docker.io&scope=repository:" + ref.repo + ":pull";
  const tokenDoc = parseJsonObject((await boundedRequest(tokenUrl, { method: "GET", headers: { accept: "application/json" }, maxBytes: RELEASE_MAX_BYTES.docker }, options)).body);
  const token = tokenDoc["token"] ?? tokenDoc["access_token"];
  if (typeof token !== "string" || token.length === 0 || token.length > 16384) throw new ReleaseError("RELEASE_INVALID", "registry 익명 token을 받지 못했습니다");
  const tags: string[] = [];
  let next: string | null = "/v2/" + ref.repo + "/tags/list?n=100";
  let pages = 0;
  while (next !== null && pages < DOCKER_TAG_PAGES) {
    const res = await boundedRequest("https://" + ref.host + next, { method: "GET", headers: { accept: "application/json", authorization: "Bearer " + token }, maxBytes: RELEASE_MAX_BYTES.docker }, options);
    pages += 1;
    const doc = parseJsonObject(res.body);
    if (!Array.isArray(doc["tags"])) throw new ReleaseError("RELEASE_INVALID", "registry tag 목록 형식이 올바르지 않습니다");
    for (const t of doc["tags"]) if (typeof t === "string" && t.length <= 128) tags.push(t);
    const link = /<([^>]+)>\s*;\s*rel="next"/u.exec(res.headers.get("link") ?? "");
    next = link !== null && link[1]!.startsWith("/v2/" + ref.repo + "/tags/list?") ? link[1]! : null;
  }
  const candidates: Candidate[] = [];
  for (const tag of tags) {
    const v = parseSemver(tag);
    if (v !== null) candidates.push({ key: v, entry: { ...baseEntry(semverText(v)), tag, prerelease: v.pre.length > 0 } });
  }
  return {
    candidates,
    ...SEMVER_RULES,
    truncated: next !== null,
    resolveDigest: async (tag) => {
      const r = await resolveArtifact("docker", ref.original + ":" + tag, { ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
      if (r.ok && r.identity.digest !== null) return r.identity.digest;
      const map: Record<string, ReleaseErrorCode> = { RESOLUTION_TIMEOUT: "RELEASE_TIMEOUT", RESOLUTION_OFFLINE: "RELEASE_OFFLINE", RESOLUTION_TOO_LARGE: "RELEASE_TOO_LARGE", RESOLVER_SOURCE_UNSUPPORTED: "RELEASE_SOURCE_UNSUPPORTED" };
      throw new ReleaseError(r.ok ? "RELEASE_INVALID" : (map[r.code] ?? "RELEASE_INVALID"), "target tag의 digest를 확정하지 못했습니다");
    },
  };
}

// ---------------------------------------------------------------- Snapshot

export interface ReleaseRequest {
  toolId: string;
  /** Manifest update.source */
  versionSource: VersionSource;
  /** Version State의 backend·requested·resolved */
  backend: "npx" | "uvx" | "docker";
  requested: string;
  resolved: ArtifactIdentity | null;
  /** Manifest repository.github(owner/repo). 있으면 release notes를 GitHub에서 가져온다(TASK-048). */
  github?: string | null;
}

export interface ReleaseSnapshotOptions extends ReleaseFetchOptions {
  now: () => Date;
  includePrerelease?: boolean;
  /** CLI 계층이 D-007로 해석해 넘기는 opaque GitHub token. 없으면 비인증 REST다. 결과·오류·로그에 남지 않는다. */
  githubToken?: string;
}

export type ReleaseSnapshotResult = { ok: true; snapshot: ReleaseSnapshotV1 } | { ok: false; code: ReleaseErrorCode; message: string; resetAt: string | null };

const SOURCE_BACKEND: Readonly<Partial<Record<VersionSource, ReleaseRequest["backend"]>>> = { npm: "npx", pypi: "uvx", "docker-tag": "docker" };

/** {pkg}@{ver} tag 매칭에 쓰는 package 이름(Docker는 없음). */
function packageName(request: ReleaseRequest): string | null {
  if (request.backend === "npx") return parseNpmSpec(request.requested)?.name ?? null;
  if (request.backend === "uvx") {
    const name = request.requested.split("==")[0]!.trim();
    return PY_NAME.test(name) ? name : null;
  }
  return null;
}

/** github-release 버전 출처: releases tag(없으면 tags)를 버전 후보로 쓴다. */
function githubSource(listing: GithubListing, request: ReleaseRequest, pkg: string | null): SourceResult {
  const rules =
    request.backend === "uvx"
      ? { compare: (a: unknown, b: unknown) => comparePep440(a as Pep440, b as Pep440), parse: (v: string) => parsePep440(v), isPrerelease: (k: unknown) => isPep440Prerelease(k as Pep440) }
      : SEMVER_RULES;
  const repoUrl = "https://github.com/" + (request.github ?? "");
  const candidates: Candidate[] = [];
  for (const rel of listing.releases) {
    const raw = versionFromTag(rel.tag, pkg);
    const key = rules.parse(raw);
    if (key === null || !tagMatches(rel.tag, raw, pkg)) continue;
    candidates.push({ key, entry: { ...baseEntry(raw), ...releaseFields(rel), tag: rel.tag, prerelease: rel.prerelease || rules.isPrerelease(key) } });
  }
  for (const t of listing.tags) {
    const raw = versionFromTag(t.tag, pkg);
    const key = rules.parse(raw);
    if (key === null || !tagMatches(t.tag, raw, pkg)) continue;
    candidates.push({ key, entry: { ...baseEntry(raw), tag: t.tag, prerelease: rules.isPrerelease(key), url: repoUrl + "/tree/" + encodeURIComponent(t.tag) } });
  }
  return { candidates, ...rules, truncated: listing.truncated };
}

function releaseFields(rel: GithubListing["releases"][number]): Pick<ReleaseEntry, "title" | "notes" | "publishedAt" | "url"> {
  return { title: shortText(rel.title, 300), notes: rel.body === null ? null : truncateNotes(rel.body), publishedAt: rel.publishedAt, url: rel.url };
}

/** 버전 출처를 조회해 ReleaseSnapshot v1을 만든다. 실패하면 Snapshot을 만들지 않는다. */
export async function collectReleaseSnapshot(request: ReleaseRequest, options: ReleaseSnapshotOptions): Promise<ReleaseSnapshotResult> {
  try {
    const repo = request.github ?? null;
    if (repo !== null && !isGithubRepo(repo)) throw new ReleaseError("RELEASE_INVALID", "repository.github 값이 owner/repo 형식이 아닙니다");
    const expected = SOURCE_BACKEND[request.versionSource];
    const githubVersions = request.versionSource === "github-release" && repo !== null;
    if (!githubVersions && (expected === undefined || expected !== request.backend)) {
      throw new ReleaseError("RELEASE_SOURCE_UNSUPPORTED", "이 도구의 버전 출처(" + request.versionSource + ")는 지원하지 않습니다");
    }
    const pkg = packageName(request);
    const currentVersion = request.resolved?.version ?? null;
    const stopAt = (tag: string) => currentVersion !== null && tagMatches(tag, currentVersion, pkg);
    const listGithub = () => listGithubReleases(repo!, stopAt, options.githubToken, options);
    let listing: GithubListing | null = null;
    let source: SourceResult;
    if (githubVersions) {
      listing = await listGithub();
      source = githubSource(listing, request, pkg);
    } else {
      source =
        request.versionSource === "npm" ? await npmSource(request.requested, options) : request.versionSource === "pypi" ? await pypiSource(request.requested, options) : await dockerSource(request.requested, options);
    }

    const currentKey = currentVersion === null ? null : source.parse(currentVersion);
    const includePrerelease = options.includePrerelease === true || (currentKey !== null && source.isPrerelease(currentKey));

    const eligible = source.candidates.filter((c) => includePrerelease || !c.entry.prerelease);
    const skippedPrereleases = source.candidates.length - eligible.length;
    const sorted = [...eligible].sort((a, b) => source.compare(b.key, a.key) || (a.entry.version < b.entry.version ? -1 : a.entry.version > b.entry.version ? 1 : 0));
    const targetCandidate = sorted.find((c) => !c.entry.yanked) ?? null;
    let target = targetCandidate === null ? null : { ...targetCandidate.entry };
    if (target !== null && source.resolveDigest !== undefined && target.tag !== null) target = { ...target, digest: await source.resolveDigest(target.tag) };

    const within = targetCandidate === null ? [] : sorted.filter((c) => source.compare(c.key, targetCandidate.key) <= 0 && (currentKey === null || source.compare(c.key, currentKey) > 0));
    let between = within.slice(0, RELEASE_BETWEEN_LIMIT).map((c) => (target !== null && c === targetCandidate ? target : { ...c.entry }));

    // GitHub notes·날짜로 target·between을 채운다(같은 버전은 한 번만 계산).
    let notesSource: ReleaseSnapshotV1["notesSource"] = "none";
    let historyTruncated = false;
    if (repo !== null) {
      listing ??= await listGithub();
      notesSource = listing.kind === "releases" ? "github-release" : listing.kind === "tags" ? "github-tag" : "none";
      const usable = listing.releases.filter((r) => includePrerelease || !r.prerelease);
      const done = new Map<string, ReleaseEntry>();
      let dateLookups = 0;
      const enrich = async (entry: ReleaseEntry): Promise<ReleaseEntry> => {
        const cached = done.get(entry.version);
        if (cached !== undefined) return cached;
        let next = entry;
        const rel = entry.notes === null && entry.title === null ? usable.find((r) => tagMatches(r.tag, entry.version, pkg)) : undefined;
        if (rel !== undefined) {
          const fields = releaseFields(rel);
          next = { ...entry, tag: entry.tag ?? rel.tag, title: fields.title, notes: fields.notes, publishedAt: entry.publishedAt ?? fields.publishedAt, url: fields.url ?? entry.url };
        } else if (listing!.kind === "tags") {
          const tag = listing!.tags.find((t) => tagMatches(t.tag, entry.version, pkg));
          if (tag !== undefined) {
            let publishedAt = entry.publishedAt;
            if (publishedAt === null && dateLookups < GITHUB_TAG_DATE_LIMIT) {
              dateLookups += 1;
              publishedAt = await githubCommitDate(repo, tag.sha, options.githubToken, options);
            }
            next = { ...entry, tag: entry.tag ?? tag.tag, publishedAt, url: entry.url ?? "https://github.com/" + repo + "/tree/" + encodeURIComponent(tag.tag) };
          }
        }
        done.set(entry.version, next);
        return next;
      };
      if (target !== null) target = await enrich(target);
      const enriched: ReleaseEntry[] = [];
      for (const e of between) enriched.push(await enrich(e));
      between = enriched;

      // npm처럼 target만 아는 출처는 current < v < target인 GitHub release로 between을 보충한다.
      if (source.partialHistory === true && targetCandidate !== null) {
        const known = new Set(between.map((e) => e.version));
        const extra: Candidate[] = [];
        for (const r of listing.releases) {
          const raw = versionFromTag(r.tag, pkg);
          const key = source.parse(raw);
          if (key === null || !tagMatches(r.tag, raw, pkg) || known.has(raw)) continue;
          if (source.compare(key, targetCandidate.key) >= 0 || (currentKey !== null && source.compare(key, currentKey) <= 0)) continue;
          const prerelease = r.prerelease || source.isPrerelease(key);
          if (prerelease && !includePrerelease) continue;
          known.add(raw);
          extra.push({ key, entry: { ...baseEntry(raw), ...releaseFields(r), tag: r.tag, prerelease } });
        }
        if (extra.length > 0) {
          extra.sort((a, b) => source.compare(b.key, a.key));
          const merged = [...between, ...extra.map((c) => c.entry)];
          if (merged.length > RELEASE_BETWEEN_LIMIT) historyTruncated = true;
          between = merged.slice(0, RELEASE_BETWEEN_LIMIT);
        }
      }
    }

    const draft: Omit<ReleaseSnapshotV1, "collectedAt" | "metadataDigest"> = {
      schemaVersion: RELEASE_SNAPSHOT_SCHEMA_VERSION,
      toolId: request.toolId,
      versionSource: request.versionSource,
      notesSource,
      current: { spec: request.resolved?.spec ?? request.requested, version: currentVersion, digest: request.resolved?.digest ?? null },
      target,
      between,
      selection: {
        includePrerelease,
        comparable: targetCandidate !== null,
        skippedDrafts: listing?.skippedDrafts ?? 0,
        skippedPrereleases,
        truncated: source.truncated || within.length > RELEASE_BETWEEN_LIMIT || historyTruncated,
      },
    };
    const snapshot = releaseSnapshotSchema.parse({ ...draft, collectedAt: options.now().toISOString(), metadataDigest: releaseMetadataDigest(draft) });
    return { ok: true, snapshot };
  } catch (error) {
    if (error instanceof ReleaseError) return { ok: false, code: error.code, message: error.message, resetAt: error.resetAt };
    return { ok: false, code: "RELEASE_INVALID", message: "release 정보를 만들지 못했습니다", resetAt: null };
  }
}

