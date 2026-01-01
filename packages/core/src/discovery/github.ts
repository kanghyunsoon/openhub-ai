/**
 * GitHub Metadata Collector(기획서 §5.2, §16).
 * 토큰이 있으면 GraphQL로 저장소를 묶어 조회하고, 없으면 REST로 대체한다(P-004).
 * HTTP는 주입한 fetch로만 호출하며 토큰은 결과·오류 메시지에 남기지 않는다.
 */

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface ReleaseInfo {
  tag: string;
  publishedAt: string | null;
  url: string | null;
}

export interface RepoMetadata {
  repository: string;
  description: string | null;
  stars: number;
  forks: number;
  pushedAt: string | null;
  archived: boolean;
  license: string | null;
  topics: string[];
  latestRelease: ReleaseInfo | null;
}

export type CollectErrorKind = "not-found" | "rate-limited" | "http" | "network" | "invalid-repository";

export type RepoResult =
  | { repository: string; ok: true; metadata: RepoMetadata }
  | { repository: string; ok: false; kind: CollectErrorKind; error: string };

export interface CollectResult {
  mode: "graphql" | "rest";
  collectedAt: string;
  results: RepoResult[];
}

export interface CollectOptions {
  fetch?: FetchLike;
  token?: string | undefined;
  now?: () => Date;
  /** GraphQL 요청 하나에 묶을 저장소 수. */
  batchSize?: number;
  apiBase?: string;
}

const REPO = /^([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)$/u;
const DEFAULT_API = "https://api.github.com";

function headers(token: string | undefined): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "openhub-ai",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token !== undefined) h["Authorization"] = `Bearer ${token}`;
  return h;
}

function isRateLimited(res: Response): boolean {
  return res.status === 429 || (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0");
}

export async function collectGitHubMetadata(repositories: readonly string[], options: CollectOptions = {}): Promise<CollectResult> {
  const fetchImpl = options.fetch ?? (globalThis.fetch as FetchLike);
  const now = options.now ?? (() => new Date());
  const unique = [...new Set(repositories)];
  const results = new Map<string, RepoResult>();
  const valid: string[] = [];
  for (const repo of unique) {
    if (REPO.test(repo)) valid.push(repo);
    else results.set(repo, { repository: repo, ok: false, kind: "invalid-repository", error: "owner/repo 형식이 아닙니다" });
  }
  const api = options.apiBase ?? DEFAULT_API;
  const mode = options.token === undefined ? "rest" : "graphql";
  const collected =
    mode === "graphql"
      ? await viaGraphql(valid, fetchImpl, api, options.token as string, options.batchSize ?? 50)
      : await viaRest(valid, fetchImpl, api);
  for (const r of collected) results.set(r.repository, r);
  return { mode, collectedAt: now().toISOString(), results: unique.map((r) => results.get(r) as RepoResult) };
}

// ---------------------------------------------------------------- GraphQL

const FIELDS = `nameWithOwner description stargazerCount forkCount pushedAt isArchived
  licenseInfo { spdxId }
  repositoryTopics(first: 20) { nodes { topic { name } } }
  latestRelease { tagName publishedAt url }`;

interface GqlRepo {
  nameWithOwner: string;
  description: string | null;
  stargazerCount: number;
  forkCount: number;
  pushedAt: string | null;
  isArchived: boolean;
  licenseInfo: { spdxId: string | null } | null;
  repositoryTopics: { nodes: { topic: { name: string } }[] };
  latestRelease: { tagName: string; publishedAt: string | null; url: string | null } | null;
}

interface GqlResponse {
  data?: Record<string, GqlRepo | null> | null;
  errors?: { type?: string; path?: (string | number)[]; message?: string }[];
}

async function viaGraphql(repos: string[], fetchImpl: FetchLike, api: string, token: string, batchSize: number): Promise<RepoResult[]> {
  const out: RepoResult[] = [];
  for (let i = 0; i < repos.length; i += batchSize) {
    const batch = repos.slice(i, i + batchSize);
    const vars: Record<string, string> = {};
    const decl: string[] = [];
    const body = batch.map((repo, k) => {
      const [, owner, name] = REPO.exec(repo) as RegExpExecArray;
      vars[`o${k}`] = owner as string;
      vars[`n${k}`] = name as string;
      decl.push(`$o${k}: String!`, `$n${k}: String!`);
      return `r${k}: repository(owner: $o${k}, name: $n${k}) { ${FIELDS} }`;
    });
    const query = `query(${decl.join(", ")}) {\n${body.join("\n")}\n}`;
    let res: Response;
    try {
      res = await fetchImpl(`${api}/graphql`, {
        method: "POST",
        headers: { ...headers(token), "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables: vars }),
      });
    } catch (error) {
      out.push(...batch.map((repository) => fail(repository, "network", `GitHub에 연결할 수 없습니다: ${errorMessage(error)}`)));
      continue;
    }
    if (isRateLimited(res)) {
      out.push(...batch.map((repository) => fail(repository, "rate-limited", "GitHub API 요청 한도를 초과했습니다")));
      continue;
    }
    if (!res.ok) {
      out.push(...batch.map((repository) => fail(repository, "http", `GitHub GraphQL 응답 ${res.status}`)));
      continue;
    }
    const json = (await res.json()) as GqlResponse;
    const errorsByAlias = new Map<string, { type?: string; message?: string }>();
    for (const e of json.errors ?? []) if (typeof e.path?.[0] === "string") errorsByAlias.set(e.path[0], e);
    const globalRateLimit = (json.errors ?? []).some((e) => e.type === "RATE_LIMITED");
    batch.forEach((repository, k) => {
      const node = json.data?.[`r${k}`];
      if (node) {
        out.push({ repository, ok: true, metadata: fromGraphql(node) });
        return;
      }
      const e = errorsByAlias.get(`r${k}`);
      if (globalRateLimit || e?.type === "RATE_LIMITED") out.push(fail(repository, "rate-limited", "GitHub API 요청 한도를 초과했습니다"));
      else if (e?.type === "NOT_FOUND") out.push(fail(repository, "not-found", "저장소를 찾을 수 없습니다"));
      else out.push(fail(repository, "http", e?.message ?? "GitHub가 저장소 정보를 돌려주지 않았습니다"));
    });
  }
  return out;
}

function fromGraphql(n: GqlRepo): RepoMetadata {
  return {
    repository: n.nameWithOwner,
    description: n.description,
    stars: n.stargazerCount,
    forks: n.forkCount,
    pushedAt: n.pushedAt,
    archived: n.isArchived,
    license: normalizeLicense(n.licenseInfo?.spdxId ?? null),
    topics: n.repositoryTopics.nodes.map((t) => t.topic.name),
    latestRelease: n.latestRelease === null ? null : { tag: n.latestRelease.tagName, publishedAt: n.latestRelease.publishedAt, url: n.latestRelease.url },
  };
}

// ---------------------------------------------------------------- REST

interface RestRepo {
  full_name: string;
  description: string | null;
  stargazers_count: number;
  forks_count: number;
  pushed_at: string | null;
  archived: boolean;
  license: { spdx_id: string | null } | null;
  topics?: string[];
}

interface RestRelease {
  tag_name: string;
  published_at: string | null;
  html_url: string | null;
}

async function viaRest(repos: string[], fetchImpl: FetchLike, api: string): Promise<RepoResult[]> {
  const out: RepoResult[] = [];
  let limited = false;
  for (const repository of repos) {
    if (limited) {
      out.push(fail(repository, "rate-limited", "GitHub API 요청 한도를 초과해 조회를 건너뛰었습니다"));
      continue;
    }
    try {
      const res = await fetchImpl(`${api}/repos/${repository}`, { headers: headers(undefined) });
      if (isRateLimited(res)) {
        limited = true;
        out.push(fail(repository, "rate-limited", "GitHub API 요청 한도를 초과했습니다"));
        continue;
      }
      if (res.status === 404) {
        out.push(fail(repository, "not-found", "저장소를 찾을 수 없습니다"));
        continue;
      }
      if (!res.ok) {
        out.push(fail(repository, "http", `GitHub REST 응답 ${res.status}`));
        continue;
      }
      const repo = (await res.json()) as RestRepo;
      let latestRelease: ReleaseInfo | null = null;
      const rel = await fetchImpl(`${api}/repos/${repository}/releases/latest`, { headers: headers(undefined) });
      if (isRateLimited(rel)) limited = true;
      else if (rel.ok) {
        const r = (await rel.json()) as RestRelease;
        latestRelease = { tag: r.tag_name, publishedAt: r.published_at, url: r.html_url };
      }
      out.push({
        repository,
        ok: true,
        metadata: {
          repository: repo.full_name,
          description: repo.description,
          stars: repo.stargazers_count,
          forks: repo.forks_count,
          pushedAt: repo.pushed_at,
          archived: repo.archived,
          license: normalizeLicense(repo.license?.spdx_id ?? null),
          topics: repo.topics ?? [],
          latestRelease,
        },
      });
    } catch (error) {
      out.push(fail(repository, "network", `GitHub에 연결할 수 없습니다: ${errorMessage(error)}`));
    }
  }
  return out;
}

// ---------------------------------------------------------------- 공통

function normalizeLicense(spdx: string | null): string | null {
  return spdx === null || spdx === "NOASSERTION" ? null : spdx;
}

function fail(repository: string, kind: CollectErrorKind, error: string): RepoResult {
  return { repository, ok: false, kind, error };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
