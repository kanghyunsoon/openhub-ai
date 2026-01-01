import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { stringify as stringifyYaml } from "yaml";
import { containsAbsolutePath } from "../analyzer/index";
import { buildFingerprintIndex, dockerKey, isKnownArtifact, npmKey, pypiKey } from "../identity/fingerprint";
import { canonicalize } from "../installer/plan";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, redactSensitive } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { ReleaseError, boundedRequest, parseJsonObject, type ReleaseFetchOptions } from "../release/fetch";

/**
 * Discovery Candidate pipeline(TASK-055, D-025). 사용자가 실행하거나 원격 workflow가 실행한다(사용자 PC timer 없음).
 * GitHub Search·Topics · npm search · 공식 MCP Registry v0.1 → DiscoveryCandidate(메모리) → fingerprint 중복 제거
 * → registry-candidates/<id>.yaml(draft Manifest 초안 + candidate 메타).
 * - Candidate는 Registry entry가 아니다. loadRegistry는 registry-candidates/를 읽지 않고 Recommendation에 나오지 않는다.
 * - 비신뢰 입력: README·description·topics·MCP Registry metadata는 데이터다. 그 안의 install command는 Manifest 명령으로 채택하지
 *   않고 실행하지 않는다(문자열로만 보존). draft의 install은 package registry 메타데이터(npm·PyPI 이름, docker image)를 결정론
 *   parser로 읽어 만들고 verification: draft로 고정한다(Router는 draft를 실행하지 않는다, CON-005).
 * - 상한: GitHub 쿼리 5·페이지 2(per_page 30)·2 MiB, npm 쿼리 5·size 50 1 페이지·1 MiB, MCP Registry /v0.1/ limit 100·cursor 3 페이지·2 MiB.
 *   timeout 10초, redirect error, retry 없음, allowlist 밖 fetch 0회. 개발 API /v0/은 쓰지 않는다.
 * - 자동 merge·PR 생성·registry/ 쓰기가 없다.
 */

export const DISCOVERY_ALLOWED_HOSTS = ["api.github.com", "registry.npmjs.org", "registry.modelcontextprotocol.io"] as const;
export const DISCOVERY_LIMITS = Object.freeze({ githubQueries: 5, githubPages: 2, githubPerPage: 30, githubMaxBytes: 2 * 1024 * 1024, npmQueries: 5, npmSize: 50, npmMaxBytes: 1024 * 1024, mcpPages: 3, mcpLimit: 100, mcpMaxBytes: 2 * 1024 * 1024 });
export const DISCOVERY_SOURCES = ["github-search", "github-topic", "npm-search", "mcp-registry"] as const;
export type DiscoverySource = (typeof DISCOVERY_SOURCES)[number];
export const CANDIDATES_DIR = "registry-candidates";
const MCP_BASE = "https://registry.modelcontextprotocol.io/v0.1/servers";
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;
const DESC_MAX = 300;
const INSTALL_TEXT_MAX = 500;

const text = z.string().min(1).max(300);
export const discoveryCandidateSchema = z
  .strictObject({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64),
    sources: z.array(z.enum(DISCOVERY_SOURCES)).min(1),
    repository: z.string().regex(REPO).nullable(),
    package: z.strictObject({ kind: z.enum(["npm", "pypi", "docker"]), name: text, key: text }).nullable(),
    signals: z.strictObject({ stars: z.number().int().min(0).nullable(), updatedAt: z.iso.datetime().nullable(), archived: z.boolean().nullable(), description: z.string().max(DESC_MAX).nullable() }),
    confidence: z.enum(["high", "medium", "low"]),
    evidence: z.array(z.strictObject({ source: z.enum(DISCOVERY_SOURCES), ref: text })),
    /** README·metadata의 설치 문구(비신뢰 데이터, 채택·실행하지 않는다) */
    untrustedInstallText: z.string().max(INSTALL_TEXT_MAX).nullable(),
    discoveredAt: z.iso.datetime(),
  })
  .superRefine((c, ctx) => {
    const walk = (v: unknown, p: (string | number)[]): void => {
      if (typeof v === "string") {
        if (TOKEN_PATTERN.test(v) || URL_CREDENTIAL_PATTERN.test(v)) ctx.addIssue({ code: "custom", path: p, message: "Candidate에 credential이 포함될 수 없습니다" });
      } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, [...p, i]));
      else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, [...p, k]);
    };
    walk(c, []);
  });
export type DiscoveryCandidate = z.output<typeof discoveryCandidateSchema>;

interface Raw {
  source: DiscoverySource;
  repository: string | null;
  package: { kind: "npm" | "pypi" | "docker"; name: string; key: string } | null;
  stars: number | null;
  updatedAt: string | null;
  archived: boolean | null;
  description: string | null;
  ref: string;
  installText: string | null;
}

const isoOrNull = (v: unknown) => {
  if (typeof v !== "string") return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
};
/** 데이터로만 쓰는 설명. 제어 문자 제거·credential 가림·길이 제한(내용 해석·실행 없음). */
const dataText = (v: unknown, max: number) => {
  if (typeof v !== "string" || v.trim() === "") return null;
  const cleaned = redactSensitive(v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").trim());
  return cleaned === "[redacted]" ? null : cleaned.slice(0, max);
};
export function githubRepoFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^(?:git\+)?https:\/\/github\.com\/([A-Za-z0-9-]{1,39})\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[#?].*)?$/u.exec(url.trim());
  return m === null ? null : m[1] + "/" + m[2];
}
const packageOf = (kind: "npm" | "pypi" | "docker", name: unknown) => {
  if (typeof name !== "string") return null;
  const key = kind === "npm" ? npmKey(name) : kind === "pypi" ? pypiKey(name) : dockerKey(name);
  return key === null ? null : { kind, name: key.slice(key.indexOf(":") + 1), key };
};

async function getJson(url: string, maxBytes: number, options: ReleaseFetchOptions, headers: Record<string, string> = {}) {
  const res = await boundedRequest(url, { method: "GET", headers: { accept: "application/json", "user-agent": "openhub-ai", ...headers }, maxBytes, allowedHosts: DISCOVERY_ALLOWED_HOSTS }, options);
  return parseJsonObject(res.body);
}

async function githubSearch(queries: readonly string[], options: ReleaseFetchOptions & { githubToken?: string }, out: Raw[], errors: DiscoveryError[]) {
  const headers = { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(options.githubToken === undefined ? {} : { authorization: "Bearer " + options.githubToken }) };
  for (const q of queries.slice(0, DISCOVERY_LIMITS.githubQueries)) {
    const source: DiscoverySource = /^topic:/u.test(q.trim()) ? "github-topic" : "github-search";
    try {
      for (let page = 1; page <= DISCOVERY_LIMITS.githubPages; page += 1) {
        const doc = await getJson("https://api.github.com/search/repositories?q=" + encodeURIComponent(q) + "&per_page=" + String(DISCOVERY_LIMITS.githubPerPage) + "&page=" + String(page), DISCOVERY_LIMITS.githubMaxBytes, options, headers);
        const items = Array.isArray(doc["items"]) ? (doc["items"] as Record<string, unknown>[]) : [];
        for (const item of items) {
          const repo = typeof item["full_name"] === "string" && REPO.test(item["full_name"]) ? item["full_name"] : null;
          if (repo === null) continue;
          out.push({ source, repository: repo, package: null, stars: typeof item["stargazers_count"] === "number" ? item["stargazers_count"] : null, updatedAt: isoOrNull(item["pushed_at"]), archived: typeof item["archived"] === "boolean" ? item["archived"] : null, description: dataText(item["description"], DESC_MAX), ref: "github:" + repo, installText: null });
        }
        if (items.length < DISCOVERY_LIMITS.githubPerPage) break;
      }
    } catch (error) {
      errors.push({ source, code: error instanceof ReleaseError ? error.code : "RELEASE_INVALID" });
    }
  }
}

async function npmSearch(queries: readonly string[], options: ReleaseFetchOptions, out: Raw[], errors: DiscoveryError[]) {
  for (const q of queries.slice(0, DISCOVERY_LIMITS.npmQueries)) {
    try {
      const doc = await getJson("https://registry.npmjs.org/-/v1/search?text=" + encodeURIComponent(q) + "&size=" + String(DISCOVERY_LIMITS.npmSize), DISCOVERY_LIMITS.npmMaxBytes, options);
      const objects = Array.isArray(doc["objects"]) ? (doc["objects"] as Record<string, unknown>[]) : [];
      for (const o of objects) {
        const p = (o["package"] ?? {}) as Record<string, unknown>;
        const pkg = packageOf("npm", p["name"]);
        if (pkg === null) continue;
        const links = (p["links"] ?? {}) as Record<string, unknown>;
        out.push({ source: "npm-search", repository: githubRepoFromUrl(links["repository"]), package: pkg, stars: null, updatedAt: isoOrNull(p["date"]), archived: null, description: dataText(p["description"], DESC_MAX), ref: "npm:" + pkg.name, installText: null });
      }
    } catch (error) {
      errors.push({ source: "npm-search", code: error instanceof ReleaseError ? error.code : "RELEASE_INVALID" });
    }
  }
}

async function mcpRegistry(options: ReleaseFetchOptions, out: Raw[], errors: DiscoveryError[]) {
  let cursor: string | null = null;
  try {
    for (let page = 1; page <= DISCOVERY_LIMITS.mcpPages; page += 1) {
      const url: string = MCP_BASE + "?limit=" + String(DISCOVERY_LIMITS.mcpLimit) + (cursor === null ? "" : "&cursor=" + encodeURIComponent(cursor));
      const doc = await getJson(url, DISCOVERY_LIMITS.mcpMaxBytes, options);
      const servers = Array.isArray(doc["servers"]) ? (doc["servers"] as Record<string, unknown>[]) : [];
      for (const wrapped of servers) {
        const s = (wrapped["server"] !== null && typeof wrapped["server"] === "object" ? wrapped["server"] : wrapped) as Record<string, unknown>;
        const name = typeof s["name"] === "string" ? s["name"].slice(0, 200) : null;
        if (name === null) continue;
        const repo = githubRepoFromUrl(((s["repository"] ?? {}) as Record<string, unknown>)["url"]);
        const packages = Array.isArray(s["packages"]) ? (s["packages"] as Record<string, unknown>[]) : [];
        const first = packages.find((p) => ["npm", "pypi", "oci", "docker"].includes(String(p["registryType"] ?? p["registry_type"] ?? "")));
        const type = String(first?.["registryType"] ?? first?.["registry_type"] ?? "");
        const pkg = first === undefined ? null : packageOf(type === "npm" ? "npm" : type === "pypi" ? "pypi" : "docker", first["identifier"] ?? first["name"]);
        // 설치 문구(runtimeHint·인자)는 데이터로만 보존한다.
        const hint = first === undefined ? null : dataText(JSON.stringify({ runtimeHint: first["runtimeHint"] ?? first["runtime_hint"] ?? null, arguments: first["packageArguments"] ?? first["runtimeArguments"] ?? null }), INSTALL_TEXT_MAX);
        out.push({ source: "mcp-registry", repository: repo, package: pkg, stars: null, updatedAt: isoOrNull((s["_meta"] as Record<string, unknown> | undefined)?.["updatedAt"]), archived: null, description: dataText(s["description"], DESC_MAX), ref: "mcp:" + name, installText: hint });
      }
      const meta = (doc["metadata"] ?? {}) as Record<string, unknown>;
      const next = meta["nextCursor"] ?? meta["next_cursor"];
      cursor = typeof next === "string" && next.length > 0 && next.length <= 500 ? next : null;
      if (cursor === null) break;
    }
  } catch (error) {
    errors.push({ source: "mcp-registry", code: error instanceof ReleaseError ? error.code : "RELEASE_INVALID" });
  }
}

export interface DiscoveryError {
  source: DiscoverySource;
  code: string;
}
export interface DiscoveryOptions extends ReleaseFetchOptions {
  githubQueries?: readonly string[];
  npmQueries?: readonly string[];
  mcpRegistry?: boolean;
  /** CLI 계층이 D-007로 해석해 넘기는 opaque token(선택) */
  githubToken?: string;
  now: () => Date;
}

const idOf = (raw: Raw) => {
  const pkgName = raw.package === null ? null : raw.package.kind === "docker" ? raw.package.name.replace(/^[^/]*[.:][^/]*\//u, "").replace(/^library\//u, "") : raw.package.name;
  const base = pkgName !== null ? pkgName.replace(/^@/u, "").replace(/[/@:.]/gu, "-") : (raw.repository ?? "").replace("/", "-");
  return base.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 64).replace(/-+$/u, "");
};

/** 세 출처에서 Candidate를 만든다. Registry에 이미 있는 package·image·저장소는 제외한다. 실패한 출처는 errors로만 보고한다. */
export async function discoverCandidates(entries: readonly RegistryEntry[], options: DiscoveryOptions): Promise<{ candidates: DiscoveryCandidate[]; errors: DiscoveryError[] }> {
  const fetchOptions: ReleaseFetchOptions = { ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) };
  const raws: Raw[] = [];
  const errors: DiscoveryError[] = [];
  await githubSearch(options.githubQueries ?? [], { ...fetchOptions, ...(options.githubToken === undefined ? {} : { githubToken: options.githubToken }) }, raws, errors);
  await npmSearch(options.npmQueries ?? [], fetchOptions, raws, errors);
  if (options.mcpRegistry === true) await mcpRegistry(fetchOptions, raws, errors);

  const index = buildFingerprintIndex(entries);
  const knownRepos = new Set(entries.map((e) => e.manifest.repository.github.toLowerCase()));
  const groups = new Map<string, Raw[]>();
  for (const raw of raws) {
    if (raw.package !== null && isKnownArtifact(raw.package.key, index)) continue;
    if (raw.package === null && raw.repository !== null && knownRepos.has(raw.repository.toLowerCase())) continue;
    const key = raw.package?.key ?? "repo:" + (raw.repository ?? "").toLowerCase();
    if (key === "repo:") continue;
    groups.set(key, [...(groups.get(key) ?? []), raw]);
  }
  // 저장소만 아는 Candidate는 같은 저장소의 package Candidate에 합친다.
  for (const [key, list] of [...groups]) {
    if (!key.startsWith("repo:")) continue;
    const target = [...groups].find(([k, l]) => !k.startsWith("repo:") && l.some((r) => r.repository?.toLowerCase() === key.slice(5)));
    if (target !== undefined) {
      target[1].push(...list);
      groups.delete(key);
    }
  }
  const discoveredAt = options.now().toISOString();
  const usedIds = new Set<string>();
  const candidates: DiscoveryCandidate[] = [];
  for (const key of [...groups.keys()].sort()) {
    // 필드 선택 순서를 출처 순서(GitHub → npm → MCP Registry)로 고정한다(입력 순서와 무관).
    const list = [...groups.get(key)!].sort((a, b) => DISCOVERY_SOURCES.indexOf(a.source) - DISCOVERY_SOURCES.indexOf(b.source) || (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0));
    const withPkg = list.find((r) => r.package !== null) ?? list[0]!;
    let id = idOf(withPkg) || "candidate";
    for (let i = 2; usedIds.has(id); i += 1) id = (idOf(withPkg) || "candidate").slice(0, 60) + "-" + String(i);
    usedIds.add(id);
    const sources = [...new Set(list.map((r) => r.source))].sort((a, b) => DISCOVERY_SOURCES.indexOf(a) - DISCOVERY_SOURCES.indexOf(b));
    const repository = list.map((r) => r.repository).find((r) => r !== null) ?? null;
    const pkg = withPkg.package;
    const confidence = pkg !== null && repository !== null && sources.length >= 2 ? "high" : pkg !== null || sources.length >= 2 ? "medium" : "low";
    const stars = list.map((r) => r.stars).find((s) => s !== null) ?? null;
    const updatedAt = list.map((r) => r.updatedAt).filter((d): d is string => d !== null).sort().at(-1) ?? null;
    const evidence = [...new Map(list.map((r) => [r.source + r.ref, { source: r.source, ref: r.ref.slice(0, 300) }])).values()].sort((a, b) => (a.source + a.ref < b.source + b.ref ? -1 : 1));
    candidates.push(
      discoveryCandidateSchema.parse({
        id,
        sources,
        repository,
        package: pkg,
        signals: { stars, updatedAt, archived: list.map((r) => r.archived).find((a) => a !== null) ?? null, description: list.map((r) => r.description).find((d) => d !== null) ?? null },
        confidence,
        evidence,
        untrustedInstallText: list.map((r) => r.installText).find((t) => t !== null) ?? null,
        discoveredAt,
      }),
    );
  }
  return { candidates, errors };
}

/**
 * draft Manifest 초안. install은 package 메타데이터만으로 만든다(README·metadata 설치 문구 미사용). 저장소·package가 없으면 null.
 * 비신뢰 설명은 draft에 복사하지 않는다(summary는 사람이 검토하며 쓴다). 설명은 candidate 메타의 데이터로만 남는다.
 */
export function draftManifestOf(candidate: DiscoveryCandidate): Record<string, unknown> | null {
  if (candidate.repository === null || candidate.package === null) return null;
  const p = candidate.package;
  const install =
    p.kind === "npm"
      ? { preferredAdapter: "npx", options: { command: "npx -y " + p.name }, fallback: [] }
      : p.kind === "pypi"
        ? { preferredAdapter: "uvx", options: { command: "uvx " + p.name }, fallback: [] }
        : { preferredAdapter: "docker", options: { image: p.key.slice("docker:".length).replace(/^docker\.io\/(?:library\/)?/u, "") }, fallback: [] };
  return {
    schemaVersion: 1,
    name: candidate.id,
    displayName: candidate.id,
    repository: { github: candidate.repository },
    category: ["mcp"],
    capabilities: [],
    targets: ["claude-code", "codex", "cursor"],
    platform: { windows: true, macos: true, linux: true },
    install,
    healthCheck: { type: "mcp-handshake" },
    update: { source: p.kind === "npm" ? "npm" : p.kind === "pypi" ? "pypi" : "docker-tag" },
    rollback: { supported: true },
    verification: "draft",
  };
}

/** registry-candidates/<id>.yaml에만 쓴다(registry/ 쓰기 0). 결과에는 논리 경로만 남는다. */
export async function writeCandidates(repoRoot: string, candidates: readonly DiscoveryCandidate[]): Promise<string[]> {
  const dir = path.join(path.resolve(repoRoot), CANDIDATES_DIR);
  await mkdir(dir, { recursive: true });
  const written: string[] = [];
  for (const c of candidates) {
    const parsed = discoveryCandidateSchema.parse(c);
    const file = path.join(dir, parsed.id + ".yaml");
    if (path.dirname(file) !== dir) throw new Error("candidate 경로가 registry-candidates 밖입니다");
    const doc = { candidate: canonicalize(parsed), draftManifest: draftManifestOf(parsed) };
    const body = "# OpenHub Discovery Candidate — Registry entry가 아닙니다. 사람이 검토·수정해 registry/로 옮기기 전에는 추천·설치 대상이 아닙니다.\n" + stringifyYaml(doc);
    if (containsAbsolutePath(body)) throw new Error("candidate에 절대 경로가 있습니다");
    await writeFile(file, body);
    written.push(CANDIDATES_DIR + "/" + parsed.id + ".yaml");
  }
  return written;
}

