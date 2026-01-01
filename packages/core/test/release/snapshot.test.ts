import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RELEASE_ALLOWED_HOSTS,
  boundedRequest,
  collectReleaseSnapshot,
  comparePep440,
  compareSemver,
  isAllowedReleaseUrl,
  parsePep440,
  parseSemver,
  serializeReleaseSnapshot,
  type ReleaseRequest,
  type ReleaseSnapshotResult,
} from "../../src/index";

/** TASK-047 ReleaseSnapshot v1과 버전 출처. 실제 네트워크 없이 가짜 fetch만 쓴다. */
type Route = (init: RequestInit | undefined) => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    return route === undefined ? new Response("missing", { status: 404 }) : route(init);
  });
  return { fetch, calls };
}
const json = (doc: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json", ...headers } });
const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);
const NOW = () => new Date("2026-10-07T00:00:00.000Z");
const LATER = () => new Date("2026-10-08T12:00:00.000Z");
const ok = (r: ReleaseSnapshotResult) => {
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.snapshot;
};
afterEach(() => vi.useRealTimers());

const memory: ReleaseRequest = { toolId: "memory-mcp", versionSource: "npm", backend: "npx", requested: "@modelcontextprotocol/server-memory", resolved: null };
const NPM_LATEST = "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest";
const npmRoutes = (version = "2.1.0") => ({
  [NPM_LATEST]: json({ name: "@modelcontextprotocol/server-memory", version, engines: { node: ">=20" }, deprecated: "use @mcp/memory instead" }),
});
const pg = (resolvedVersion: string | null): ReleaseRequest => ({
  toolId: "postgres-mcp",
  versionSource: "pypi",
  backend: "uvx",
  requested: "postgres-mcp",
  resolved: resolvedVersion === null ? null : { kind: "python-package", spec: "postgres-mcp==" + resolvedVersion, version: resolvedVersion, digest: null, integrity: null, source: "pypi" },
});
const file = (time: string, extra: Record<string, unknown> = {}) => ({ upload_time_iso_8601: time, requires_python: ">=3.12", yanked: false, ...extra });
const PYPI = "https://pypi.org/pypi/postgres-mcp/json";
const pypiDoc = {
  info: { name: "postgres-mcp", version: "0.3.1" },
  releases: {
    "0.1.0": [file("2025-01-01T00:00:00Z")],
    "0.2.0": [file("2025-03-01T00:00:00Z")],
    "0.3.0": [file("2025-05-01T00:00:00Z")],
    "0.3.1": [file("2025-06-01T00:00:00Z"), file("2025-06-01T01:00:00Z")],
    "0.4.0rc1": [file("2025-07-01T00:00:00Z")],
    "0.4.0": [file("2025-08-01T00:00:00Z", { yanked: true })],
    "not-a-version": [file("2025-08-01T00:00:00Z")],
    "0.5.0": [],
  },
};
const github: ReleaseRequest = { toolId: "github-mcp-server", versionSource: "docker-tag", backend: "docker", requested: "ghcr.io/github/github-mcp-server", resolved: null };
const GHCR_TOKEN = "https://ghcr.io/token?scope=repository:github/github-mcp-server:pull";
const tagsPage = (n: number) => "https://ghcr.io/v2/github/github-mcp-server/tags/list?" + (n === 1 ? "n=100" : "last=p" + (n - 1) + "&n=100");
function dockerRoutes(pages: string[][], digest = D1) {
  const routes: Record<string, Route> = { [GHCR_TOKEN]: json({ token: "anon-token" }) };
  pages.forEach((tags, i) => {
    const link = i < pages.length - 1 ? { link: "</v2/github/github-mcp-server/tags/list?last=p" + (i + 1) + "&n=100>; rel=\"next\"" } : {};
    routes[tagsPage(i + 1)] = json({ name: "github/github-mcp-server", tags }, link as Record<string, string>);
  });
  routes["https://ghcr.io/v2/github/github-mcp-server/manifests/v1.3.0"] = () => new Response(null, { status: 200, headers: { "docker-content-digest": digest } });
  return routes;
}

describe("REQ-045 ReleaseSnapshot v1과 버전 출처", () => {
  it("AC-047-01 같은 source·clock·옵션이면 byte가 같고 collectedAt만 다르면 metadataDigest가 같다", async () => {
    const a = ok(await collectReleaseSnapshot(memory, { fetch: fakeFetch(npmRoutes()).fetch, now: NOW }));
    const b = ok(await collectReleaseSnapshot(memory, { fetch: fakeFetch(npmRoutes()).fetch, now: NOW }));
    expect(serializeReleaseSnapshot(b)).toBe(serializeReleaseSnapshot(a));
    const later = ok(await collectReleaseSnapshot(memory, { fetch: fakeFetch(npmRoutes()).fetch, now: LATER }));
    expect(serializeReleaseSnapshot(later)).not.toBe(serializeReleaseSnapshot(a));
    expect(later.collectedAt).toBe("2026-10-08T12:00:00.000Z");
    expect(later.metadataDigest).toBe(a.metadataDigest);
    const changed = ok(await collectReleaseSnapshot(memory, { fetch: fakeFetch(npmRoutes("2.2.0")).fetch, now: NOW }));
    expect(changed.metadataDigest).not.toBe(a.metadataDigest);
    const pre = ok(await collectReleaseSnapshot(memory, { fetch: fakeFetch(npmRoutes()).fetch, now: NOW, includePrerelease: true }));
    expect(pre.metadataDigest).not.toBe(a.metadataDigest);
  });

  it("AC-047-02 npm은 scoped %2f latest 문서로 target·deprecated·engines.node를 채운다", async () => {
    const f = fakeFetch(npmRoutes());
    const s = ok(await collectReleaseSnapshot(memory, { fetch: f.fetch, now: NOW }));
    expect(f.calls.map((c) => c.url)).toEqual([NPM_LATEST]);
    expect(s).toMatchObject({ versionSource: "npm", notesSource: "none", current: { spec: "@modelcontextprotocol/server-memory", version: null, digest: null } });
    expect(s.target).toEqual({ version: "2.1.0", tag: null, publishedAt: null, prerelease: false, yanked: false, deprecated: "use @mcp/memory instead", title: null, notes: null, url: null, digest: null, runtime: { node: ">=20", python: null } });
    const wrong = fakeFetch({ [NPM_LATEST]: json({ name: "evil", version: "1.0.0" }) });
    expect(await collectReleaseSnapshot(memory, { fetch: wrong.fetch, now: NOW })).toMatchObject({ ok: false, code: "RELEASE_INVALID" });
  });

  it("AC-047-03 PyPI는 releases로 target·yanked·requires_python·publishedAt을 채우고 yanked는 target이 되지 않는다", async () => {
    const f = fakeFetch({ [PYPI]: json(pypiDoc) });
    const s = ok(await collectReleaseSnapshot(pg("0.2.0"), { fetch: f.fetch, now: NOW }));
    expect(f.calls.map((c) => c.url)).toEqual([PYPI]);
    expect(s.target).toMatchObject({ version: "0.3.1", yanked: false, publishedAt: "2025-06-01T00:00:00.000Z", url: "https://pypi.org/project/postgres-mcp/0.3.1/", runtime: { python: ">=3.12", node: null } });
    expect(s.between.map((e) => e.version)).toEqual(["0.3.1", "0.3.0"]);
    expect(s.selection).toEqual({ includePrerelease: false, comparable: true, skippedDrafts: 0, skippedPrereleases: 1, truncated: false });
    // prerelease 포함 시 yanked 0.4.0은 between에만 표시되고 target은 rc1이다.
    const p = ok(await collectReleaseSnapshot(pg("0.3.1"), { fetch: fakeFetch({ [PYPI]: json(pypiDoc) }).fetch, now: NOW, includePrerelease: true }));
    expect(p.target?.version).toBe("0.4.0rc1");
    expect(p.between.map((e) => [e.version, e.yanked])).toEqual([["0.4.0rc1", false]]);
    const yankedTop = ok(await collectReleaseSnapshot(pg("0.3.1"), { fetch: fakeFetch({ [PYPI]: json({ ...pypiDoc, releases: { ...pypiDoc.releases, "0.4.0rc1": [] } }) }).fetch, now: NOW, includePrerelease: true }));
    expect(yankedTop.target?.version).toBe("0.3.1");
  });

  it("AC-047-04 Docker는 tags list와 manifest HEAD로 SemVer target과 digest를 확정하고 SemVer tag가 없으면 비교 불가다", async () => {
    const f = fakeFetch(dockerRoutes([["latest", "v1.2.0", "sha-abc"], ["v1.3.0", "1.3.0-rc.1", "main"]]));
    const s = ok(await collectReleaseSnapshot(github, { fetch: f.fetch, now: NOW }));
    expect(s.target).toMatchObject({ version: "1.3.0", tag: "v1.3.0", digest: D1, prerelease: false });
    expect(s.between.map((e) => e.tag)).toEqual(["v1.3.0", "v1.2.0"]);
    expect(s.selection).toMatchObject({ comparable: true, skippedPrereleases: 1, truncated: false });
    expect(f.calls.filter((c) => c.url.includes("/manifests/")).map((c) => c.init?.method)).toEqual(["HEAD"]);
    const none = ok(await collectReleaseSnapshot(github, { fetch: fakeFetch(dockerRoutes([["latest", "main", "sha-abc"]])).fetch, now: NOW }));
    expect([none.target, none.between, none.selection.comparable]).toEqual([null, [], false]);
  });

  it("AC-047-05 allowlist 밖 출처와 지원하지 않는 버전 출처는 RELEASE_SOURCE_UNSUPPORTED이고 fetch 0회다", async () => {
    const f = fakeFetch({});
    for (const req of [
      { ...github, requested: "quay.io/org/tool" },
      { ...github, requested: "registry.example.com/team/mcp:1.0" },
      { ...memory, versionSource: "github-release" as const },
      { ...memory, versionSource: "git" as const },
      { ...memory, versionSource: "pypi" as const },
    ]) {
      expect(await collectReleaseSnapshot(req, { fetch: f.fetch, now: NOW }), req.requested + " " + req.versionSource).toMatchObject({ ok: false, code: "RELEASE_SOURCE_UNSUPPORTED" });
    }
    expect(f.calls).toEqual([]);
    expect(RELEASE_ALLOWED_HOSTS).toEqual(["registry.npmjs.org", "pypi.org", "ghcr.io", "registry-1.docker.io", "auth.docker.io", "api.github.com"]);
    for (const url of ["http://pypi.org/x", "https://user:pw@pypi.org/x", "https://pypi.org:8443/x", "https://evil.example/x", "https://api.github.com.evil.example/x"]) expect(isAllowedReleaseUrl(url), url).toBe(false);
    await expect(boundedRequest("https://evil.example/x", { method: "GET", maxBytes: 10 }, { fetch: f.fetch })).rejects.toMatchObject({ code: "RELEASE_SOURCE_UNSUPPORTED" });
    expect(f.calls).toEqual([]);
  });

  it("AC-047-06 10초 무응답은 RELEASE_TIMEOUT, fetch reject와 5xx는 RELEASE_OFFLINE이다", async () => {
    vi.useFakeTimers();
    const hang = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const pending = collectReleaseSnapshot(memory, { fetch: hang, now: NOW });
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, code: "RELEASE_TIMEOUT" });
    vi.useRealTimers();
    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await collectReleaseSnapshot(pg(null), { fetch: offline, now: NOW })).toMatchObject({ ok: false, code: "RELEASE_OFFLINE" });
    expect(await collectReleaseSnapshot(pg(null), { fetch: fakeFetch({ [PYPI]: () => new Response("busy", { status: 503 }) }).fetch, now: NOW })).toMatchObject({ ok: false, code: "RELEASE_OFFLINE" });
  });

  it("AC-047-07 npm·Docker 1 MiB, PyPI 8 MiB를 넘으면 읽기를 멈추고 RELEASE_TOO_LARGE다", async () => {
    const declared = (n: number) => () => new Response("{}", { status: 200, headers: { "content-length": String(n) } });
    expect(await collectReleaseSnapshot(memory, { fetch: fakeFetch({ [NPM_LATEST]: declared(1048577) }).fetch, now: NOW })).toMatchObject({ ok: false, code: "RELEASE_TOO_LARGE" });
    expect(await collectReleaseSnapshot(github, { fetch: fakeFetch({ [GHCR_TOKEN]: declared(1048577) }).fetch, now: NOW })).toMatchObject({ ok: false, code: "RELEASE_TOO_LARGE" });
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024).fill(32);
    const stream = () =>
      new Response(new ReadableStream<Uint8Array>({ pull: (c) => (++pulled > 40 ? c.close() : c.enqueue(chunk)) }), { status: 200 });
    expect(await collectReleaseSnapshot(pg(null), { fetch: fakeFetch({ [PYPI]: stream }).fetch, now: NOW })).toMatchObject({ ok: false, code: "RELEASE_TOO_LARGE" });
    expect(pulled).toBeLessThan(12);
    const big = JSON.stringify({ ...pypiDoc, pad: "x".repeat(3 * 1024 * 1024) });
    expect((await collectReleaseSnapshot(pg(null), { fetch: fakeFetch({ [PYPI]: () => new Response(big, { status: 200 }) }).fetch, now: NOW })).ok).toBe(true);
  });

  it("AC-047-08 Docker tags는 3 페이지까지만 요청하고 더 있으면 truncated다", async () => {
    const pages = [["v1.0.0"], ["v1.1.0"], ["v1.2.0"], ["v1.3.0"], ["v1.4.0"]];
    const routes = dockerRoutes(pages);
    routes["https://ghcr.io/v2/github/github-mcp-server/manifests/v1.2.0"] = () => new Response(null, { status: 200, headers: { "docker-content-digest": D2 } });
    const g = fakeFetch(routes);
    const s = ok(await collectReleaseSnapshot(github, { fetch: g.fetch, now: NOW }));
    expect(g.calls.filter((c) => c.url.includes("/tags/list")).length).toBe(3);
    expect(s.selection.truncated).toBe(true);
    expect(s.target).toMatchObject({ tag: "v1.2.0", digest: D2 });
    // Link가 다른 저장소를 가리키면 따라가지 않는다.
    const evil = dockerRoutes([["v1.0.0"]]);
    evil[tagsPage(1)] = json({ tags: ["v1.0.0"] }, { link: "</v2/other/repo/tags/list?last=x&n=100>; rel=\"next\"" });
    evil["https://ghcr.io/v2/github/github-mcp-server/manifests/v1.0.0"] = () => new Response(null, { status: 200, headers: { "docker-content-digest": D1 } });
    const e = fakeFetch(evil);
    expect(ok(await collectReleaseSnapshot(github, { fetch: e.fetch, now: NOW })).selection.truncated).toBe(false);
    expect(e.calls.some((c) => c.url.includes("/other/"))).toBe(false);
  });

  it("AC-047-09 redirect는 따라가지 않고 credential·cookie 없이 요청한다", async () => {
    const f = fakeFetch({ ...npmRoutes(), [PYPI]: json(pypiDoc), ...dockerRoutes([["v1.3.0"]]) });
    await collectReleaseSnapshot(memory, { fetch: f.fetch, now: NOW });
    await collectReleaseSnapshot(pg(null), { fetch: f.fetch, now: NOW });
    await collectReleaseSnapshot(github, { fetch: f.fetch, now: NOW });
    for (const c of f.calls) {
      expect(c.init?.redirect, c.url).toBe("error");
      expect(c.init?.credentials, c.url).toBe("omit");
      const headers = Object.keys((c.init?.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase());
      expect(headers, c.url).not.toContain("cookie");
      if (!c.url.includes("/v2/")) expect(headers, c.url).not.toContain("authorization");
    }
    const moved = fakeFetch({ "https://api.github.com/repos/o/r/releases": () => new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/1" } }) });
    await expect(boundedRequest("https://api.github.com/repos/o/r/releases", { method: "GET", maxBytes: 100, redirect: "manual" }, { fetch: moved.fetch })).rejects.toMatchObject({ code: "RELEASE_SOURCE_MOVED" });
    expect(moved.calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/o/r/releases"]);
    const rejecting = vi.fn(async () => {
      throw new TypeError("redirect mode is set to error");
    });
    await expect(boundedRequest("https://pypi.org/pypi/x/json", { method: "GET", maxBytes: 100 }, { fetch: rejecting })).rejects.toMatchObject({ code: "RELEASE_OFFLINE" });
  });

  it("AC-047-10 current가 unlocked여도 Snapshot을 만들고 between은 20개 이하·버전 내림차순이다", async () => {
    const releases: Record<string, unknown[]> = {};
    for (let i = 0; i < 25; i += 1) releases["1." + i + ".0"] = [file("2025-01-01T00:00:00Z")];
    const doc = { info: { name: "postgres-mcp", version: "1.24.0" }, releases };
    const s = ok(await collectReleaseSnapshot(pg(null), { fetch: fakeFetch({ [PYPI]: json(doc) }).fetch, now: NOW }));
    expect(s.current).toEqual({ spec: "postgres-mcp", version: null, digest: null });
    expect(s.between).toHaveLength(20);
    expect(s.between[0]!.version).toBe("1.24.0");
    expect(s.between.at(-1)!.version).toBe("1.5.0");
    expect(s.selection.truncated).toBe(true);
    const locked = ok(await collectReleaseSnapshot(pg("1.21.0"), { fetch: fakeFetch({ [PYPI]: json(doc) }).fetch, now: NOW }));
    expect(locked.current).toEqual({ spec: "postgres-mcp==1.21.0", version: "1.21.0", digest: null });
    expect(locked.between.map((e) => e.version)).toEqual(["1.24.0", "1.23.0", "1.22.0"]);
  });

  it("AC-047-01 SemVer·PEP 440 비교 규칙(prerelease·post·dev 포함)이 정해진 순서다", () => {
    const sem = ["1.0.0-alpha", "1.0.0-alpha.1", "1.0.0-alpha.beta", "1.0.0-beta.2", "1.0.0-beta.11", "1.0.0-rc.1", "1.0.0", "v1.0.1", "1.10.0"];
    const parsedSem = sem.map((v) => parseSemver(v)!);
    for (let i = 1; i < parsedSem.length; i += 1) expect(compareSemver(parsedSem[i - 1]!, parsedSem[i]!), sem[i - 1] + " < " + sem[i]).toBe(-1);
    expect(parseSemver("1.2")).toBeNull();
    expect(parseSemver("latest")).toBeNull();
    const pep = ["1.0.dev1", "1.0a1", "1.0a2.dev1", "1.0a2", "1.0b1", "1.0rc1", "1.0", "1.0.post1", "1.0.1", "1.1"];
    const parsedPep = pep.map((v) => parsePep440(v)!);
    for (let i = 1; i < parsedPep.length; i += 1) expect(comparePep440(parsedPep[i - 1]!, parsedPep[i]!), pep[i - 1] + " < " + pep[i]).toBe(-1);
    expect(comparePep440(parsePep440("1.0")!, parsePep440("1.0.0")!)).toBe(0);
    expect(parsePep440("not-a-version")).toBeNull();
  });
});

