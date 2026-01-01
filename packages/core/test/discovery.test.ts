import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  collectGitHubMetadata,
  resolveGitHubToken,
  toMetadataCache,
  writeMetadataCache,
  type FetchLike,
} from "../src/index";

const TOKEN = "ghp_SECRET_TOKEN_VALUE";
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

interface Call {
  url: string;
  method: string;
  body?: { query: string; variables: Record<string, string> };
  auth?: string | undefined;
}

function recorder(handler: (call: Call) => Response): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: FetchLike = async (url, init) => {
    const h = (init?.headers ?? {}) as Record<string, string>;
    const call: Call = {
      url,
      method: init?.method ?? "GET",
      auth: h["Authorization"],
      ...(typeof init?.body === "string" ? { body: JSON.parse(init.body) as NonNullable<Call["body"]> } : {}),
    };
    calls.push(call);
    return handler(call);
  };
  return { fetch, calls };
}

const gqlRepo = (nameWithOwner: string, stars: number, release = true) => ({
  nameWithOwner,
  description: "desc",
  stargazerCount: stars,
  forkCount: 3,
  pushedAt: "2026-10-01T00:00:00Z",
  isArchived: false,
  licenseInfo: { spdxId: "MIT" },
  repositoryTopics: { nodes: [{ topic: { name: "mcp" } }] },
  latestRelease: release ? { tagName: "v1.2.0", publishedAt: "2026-09-30T00:00:00Z", url: "https://example/r" } : null,
});

describe("REQ-003 GitHub Metadata Collector", () => {
  it("AC-006-01 토큰이 있으면 GraphQL 요청 1회로 여러 저장소를 조회한다", async () => {
    const { fetch, calls } = recorder(() => json({ data: { r0: gqlRepo("a/one", 10), r1: gqlRepo("b/two", 20, false) } }));
    const r = await collectGitHubMetadata(["a/one", "b/two", "a/one"], { fetch, token: TOKEN });
    expect(r.mode).toBe("graphql");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://api.github.com/graphql");
    expect(calls[0]?.body?.variables).toEqual({ o0: "a", n0: "one", o1: "b", n1: "two" });
    expect(r.results.map((x) => x.ok && x.metadata.stars)).toEqual([10, 20]);
  });

  it("AC-006-01 GraphQL은 batchSize 단위로 나눠 요청한다", async () => {
    const { fetch, calls } = recorder((c) => {
      const keys = Object.keys(c.body?.variables ?? {}).filter((k) => k.startsWith("n"));
      return json({ data: Object.fromEntries(keys.map((k, i) => [`r${i}`, gqlRepo(`o/${c.body?.variables[k]}`, 1)])) });
    });
    const r = await collectGitHubMetadata(["o/a", "o/b", "o/c"], { fetch, token: TOKEN, batchSize: 2 });
    expect(calls).toHaveLength(2);
    expect(r.results.every((x) => x.ok)).toBe(true);
  });

  it("AC-006-01 토큰이 없으면 REST로 저장소와 최신 Release를 조회한다", async () => {
    const { fetch, calls } = recorder((c) => {
      if (c.url.endsWith("/releases/latest")) return json({ tag_name: "v2.0.0", published_at: "2026-09-01T00:00:00Z", html_url: "https://example/r2" });
      return json({ full_name: "a/one", description: null, stargazers_count: 5, forks_count: 1, pushed_at: "2026-09-02T00:00:00Z", archived: true, license: { spdx_id: "NOASSERTION" }, topics: ["ai"] });
    });
    const r = await collectGitHubMetadata(["a/one"], { fetch });
    expect(r.mode).toBe("rest");
    expect(calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/a/one", "https://api.github.com/repos/a/one/releases/latest"]);
    expect(calls.every((c) => c.auth === undefined)).toBe(true);
    expect(r.results[0]).toMatchObject({ ok: true, metadata: { stars: 5, archived: true, license: null, latestRelease: { tag: "v2.0.0" } } });
  });

  it("AC-006-02 토큰은 GITHUB_TOKEN → GH_TOKEN → gh auth token 순서로 찾는다", async () => {
    const gh = async () => "from-gh\n";
    expect(await resolveGitHubToken({ GITHUB_TOKEN: "a", GH_TOKEN: "b" }, gh)).toEqual({ token: "a", source: "GITHUB_TOKEN" });
    expect(await resolveGitHubToken({ GH_TOKEN: "b" }, gh)).toEqual({ token: "b", source: "GH_TOKEN" });
    expect(await resolveGitHubToken({}, gh)).toEqual({ token: "from-gh", source: "gh" });
    expect(await resolveGitHubToken({}, async () => { throw new Error("gh not installed"); })).toBeUndefined();
  });

  it("AC-006-02 AC-006-03 수집 결과를 캐시에 저장하고 토큰은 기록하지 않는다", async () => {
    const { fetch } = recorder(() => json({ data: { r0: gqlRepo("a/one", 42), r1: null }, errors: [{ type: "NOT_FOUND", path: ["r1"], message: "Could not resolve" }] }));
    const r = await collectGitHubMetadata(["a/one", "a/missing"], { fetch, token: TOKEN, now: () => new Date("2026-10-06T00:00:00Z") });
    const dir = await mkdtemp(path.join(tmpdir(), "openhub-cache-"));
    try {
      const file = path.join(dir, ".openhub-cache", "metadata.json");
      await writeMetadataCache(file, toMetadataCache(r));
      const text = await readFile(file, "utf8");
      expect(text).not.toContain(TOKEN);
      const cache = JSON.parse(text);
      expect(cache).toMatchObject({ version: 1, mode: "graphql", collectedAt: "2026-10-06T00:00:00.000Z" });
      expect(cache.repositories["a/one"]).toEqual({
        repository: "a/one",
        description: "desc",
        stars: 42,
        forks: 3,
        pushedAt: "2026-10-01T00:00:00Z",
        archived: false,
        license: "MIT",
        topics: ["mcp"],
        latestRelease: { tag: "v1.2.0", publishedAt: "2026-09-30T00:00:00Z", url: "https://example/r" },
      });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AC-006-05 없는 저장소는 그 저장소만 not-found 오류로 기록한다", async () => {
    const { fetch } = recorder(() => json({ data: { r0: gqlRepo("a/one", 1), r1: null }, errors: [{ type: "NOT_FOUND", path: ["r1"] }] }));
    const r = await collectGitHubMetadata(["a/one", "a/missing"], { fetch, token: TOKEN });
    expect(r.results.map((x) => (x.ok ? "ok" : x.kind))).toEqual(["ok", "not-found"]);
  });

  it("AC-006-05 REST Rate Limit 이후 저장소는 호출 없이 rate-limited로 기록하고 앞선 결과는 유지한다", async () => {
    let n = 0;
    const { fetch, calls } = recorder((c) => {
      if (c.url.endsWith("/releases/latest")) return json({ message: "Not Found" }, 404);
      n++;
      if (n === 1) return json({ full_name: "a/one", description: null, stargazers_count: 1, forks_count: 0, pushed_at: null, archived: false, license: null });
      return json({ message: "API rate limit exceeded" }, 403, { "x-ratelimit-remaining": "0" });
    });
    const r = await collectGitHubMetadata(["a/one", "a/two", "a/three"], { fetch });
    expect(r.results.map((x) => (x.ok ? "ok" : x.kind))).toEqual(["ok", "rate-limited", "rate-limited"]);
    expect(r.results[0]).toMatchObject({ ok: true, metadata: { latestRelease: null } });
    expect(calls).toHaveLength(3);
  });

  it("AC-006-05 네트워크 오류와 잘못된 저장소 이름도 저장소별 오류로 남고 토큰이 메시지에 섞이지 않는다", async () => {
    const fetch: FetchLike = async () => {
      throw new Error("ECONNRESET");
    };
    const r = await collectGitHubMetadata(["a/one", "not a repo"], { fetch, token: TOKEN });
    expect(r.results.map((x) => (x.ok ? "ok" : x.kind))).toEqual(["network", "invalid-repository"]);
    expect(JSON.stringify(r)).not.toContain(TOKEN);
  });
});
