import { readdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { RESOLVER_MAX_BYTES, RESOLVER_TIMEOUT_MS, lifecycleStatus, parseImageRef, recordInstallInState, resolveArtifact, runInstallTransaction, type ResolveResult } from "../../src/index";
import { uvxArtifact } from "../../src/installer/command";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { REPO_ROOT, seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/** TASK-039 Artifact Resolver. 실제 네트워크는 쓰지 않고 가짜 fetch만 쓴다. */
type Call = { url: string; init: RequestInit | undefined };
type Route = (init: RequestInit | undefined) => Response | Promise<Response>;

function fakeFetch(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    if (route === undefined) return new Response("not found", { status: 404 });
    return route(init);
  });
  return { fetch, calls };
}
const jsonRes = (doc: unknown, headers: Record<string, string> = {}) => () => new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json", ...headers } });
const DIGEST = "sha256:" + "c".repeat(64);
const ANON_TOKEN = "anon-registry-token-QWERTY";
const ok = (r: ResolveResult) => {
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r;
};
const NPM_SCOPED = "https://registry.npmjs.org/@upstash%2fcontext7-mcp/latest";

const scratch = await newScratch("resolver-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("REQ-040 REQ-043 Artifact Resolver", () => {
  it("AC-039-01 npm dist-tag는 registry 조회로 정확한 버전이 되고 scoped 이름은 %2f로 조회한다", async () => {
    const { fetch, calls } = fakeFetch({
      "https://registry.npmjs.org/chrome-devtools-mcp/latest": jsonRes({ name: "chrome-devtools-mcp", version: "1.2.3", dist: { integrity: "sha512-AbC+/1=" } }),
      [NPM_SCOPED]: jsonRes({ name: "@upstash/context7-mcp", version: "2.0.1", dist: {} }),
    });
    const a = ok(await resolveArtifact("npx", "chrome-devtools-mcp@latest", { fetch }));
    expect(a).toEqual({ ok: true, fetched: true, identity: { kind: "npm-package", spec: "chrome-devtools-mcp@1.2.3", version: "1.2.3", digest: null, integrity: "sha512-AbC+/1=", source: "npm-registry" } });
    const b = ok(await resolveArtifact("npx", "@upstash/context7-mcp", { fetch }));
    expect(b.identity.spec).toBe("@upstash/context7-mcp@2.0.1");
    expect(calls.map((c) => [c.url, c.init?.method])).toEqual([
      ["https://registry.npmjs.org/chrome-devtools-mcp/latest", "GET"],
      [NPM_SCOPED, "GET"],
    ]);
  });

  it("AC-039-02 이미 정확한 pkg@1.2.3·name==1.2.3·image@sha256은 fetch 0회로 resolved가 된다", async () => {
    const { fetch, calls } = fakeFetch({});
    expect(ok(await resolveArtifact("npx", "@scope/pkg@1.2.3", { fetch }))).toEqual({
      ok: true,
      fetched: false,
      identity: { kind: "npm-package", spec: "@scope/pkg@1.2.3", version: "1.2.3", digest: null, integrity: null, source: "npm-registry" },
    });
    expect(ok(await resolveArtifact("uvx", "postgres-mcp==0.3.0", { fetch })).identity).toEqual({ kind: "python-package", spec: "postgres-mcp==0.3.0", version: "0.3.0", digest: null, integrity: null, source: "pypi" });
    expect(ok(await resolveArtifact("docker", "ghcr.io/github/github-mcp-server@" + DIGEST, { fetch })).identity).toEqual({
      kind: "container-image",
      spec: "ghcr.io/github/github-mcp-server@" + DIGEST,
      version: null,
      digest: DIGEST,
      integrity: null,
      source: "docker-registry",
    });
    expect(calls).toEqual([]);
  });

  it("AC-039-03 uvx는 PyPI info.version으로 name==x.y.z가 되고 --from serena-agent도 같은 규칙이다", async () => {
    const { fetch, calls } = fakeFetch({
      "https://pypi.org/pypi/postgres-mcp/json": jsonRes({ info: { name: "postgres-mcp", version: "0.3.0" }, releases: {} }),
      "https://pypi.org/pypi/serena-agent/json": jsonRes({ info: { name: "serena_agent", version: "0.1.4" } }),
    });
    expect(ok(await resolveArtifact("uvx", "postgres-mcp", { fetch })).identity.spec).toBe("postgres-mcp==0.3.0");
    const from = uvxArtifact(["--from", "serena-agent", "serena", "start-mcp-server"]);
    expect(from?.spec).toBe("serena-agent");
    expect(ok(await resolveArtifact("uvx", from!.spec, { fetch })).identity).toEqual({ kind: "python-package", spec: "serena-agent==0.1.4", version: "0.1.4", digest: null, integrity: null, source: "pypi" });
    expect(calls.map((c) => c.url)).toEqual(["https://pypi.org/pypi/postgres-mcp/json", "https://pypi.org/pypi/serena-agent/json"]);
  });

  it("AC-039-04 ghcr·Docker Hub image는 익명 token 후 manifest HEAD의 Docker-Content-Digest로 확정된다", async () => {
    const head = () => new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
    const { fetch, calls } = fakeFetch({
      "https://ghcr.io/token?scope=repository:github/github-mcp-server:pull": jsonRes({ token: ANON_TOKEN }),
      "https://ghcr.io/v2/github/github-mcp-server/manifests/latest": head,
      "https://auth.docker.io/token?service=registry.docker.io&scope=repository:crystaldba/postgres-mcp:pull": jsonRes({ token: ANON_TOKEN }),
      "https://registry-1.docker.io/v2/crystaldba/postgres-mcp/manifests/0.3": head,
    });
    expect(ok(await resolveArtifact("docker", "ghcr.io/github/github-mcp-server", { fetch })).identity).toEqual({
      kind: "container-image",
      spec: "ghcr.io/github/github-mcp-server@" + DIGEST,
      version: null,
      digest: DIGEST,
      integrity: null,
      source: "docker-registry",
    });
    expect(ok(await resolveArtifact("docker", "crystaldba/postgres-mcp:0.3", { fetch })).identity.spec).toBe("crystaldba/postgres-mcp@" + DIGEST);
    expect(calls.map((c) => [c.url, c.init?.method])).toEqual([
      ["https://ghcr.io/token?scope=repository:github/github-mcp-server:pull", "GET"],
      ["https://ghcr.io/v2/github/github-mcp-server/manifests/latest", "HEAD"],
      ["https://auth.docker.io/token?service=registry.docker.io&scope=repository:crystaldba/postgres-mcp:pull", "GET"],
      ["https://registry-1.docker.io/v2/crystaldba/postgres-mcp/manifests/0.3", "HEAD"],
    ]);
    expect((calls[1]!.init?.headers as Record<string, string>)["authorization"]).toBe("Bearer " + ANON_TOKEN);
    expect(parseImageRef("postgres:16")).toMatchObject({ host: "registry-1.docker.io", repo: "library/postgres", tag: "16", original: "postgres" });
  });

  it("AC-039-05 allowlist 밖 image registry는 RESOLVER_SOURCE_UNSUPPORTED이고 fetch 0회다", async () => {
    const { fetch, calls } = fakeFetch({});
    for (const image of ["registry.example.com/team/mcp:1.0", "quay.io/org/tool", "localhost:5000/tool:dev", "10.0.0.5/tool"]) {
      const r = await resolveArtifact("docker", image, { fetch });
      expect(r, image).toMatchObject({ ok: false, code: "RESOLVER_SOURCE_UNSUPPORTED" });
    }
    expect(calls).toEqual([]);
  });

  it("AC-039-06 10초 무응답은 RESOLUTION_TIMEOUT, fetch reject·429·5xx는 RESOLUTION_OFFLINE이다", async () => {
    expect(RESOLVER_TIMEOUT_MS).toBe(10_000);
    vi.useFakeTimers();
    const hang = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    );
    const pending = resolveArtifact("npx", "chrome-devtools-mcp", { fetch: hang });
    await vi.advanceTimersByTimeAsync(9_999);
    let settled = false;
    void pending.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toMatchObject({ ok: false, code: "RESOLUTION_TIMEOUT" });
    vi.useRealTimers();

    const offline = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    expect(await resolveArtifact("uvx", "postgres-mcp", { fetch: offline })).toMatchObject({ ok: false, code: "RESOLUTION_OFFLINE" });
    for (const status of [429, 500, 503]) {
      const { fetch } = fakeFetch({ "https://pypi.org/pypi/postgres-mcp/json": () => new Response("busy", { status }) });
      expect(await resolveArtifact("uvx", "postgres-mcp", { fetch }), String(status)).toMatchObject({ ok: false, code: "RESOLUTION_OFFLINE" });
    }
  });

  it("AC-039-07 npm·Docker 1 MiB·PyPI 8 MiB 상한을 넘으면 읽기를 멈추고 RESOLUTION_TOO_LARGE다", async () => {
    expect(RESOLVER_MAX_BYTES).toEqual({ npm: 1048576, docker: 1048576, pypi: 8388608 });
    const declared = (n: number) => () => new Response("{}", { status: 200, headers: { "content-length": String(n) } });
    const a = fakeFetch({ "https://registry.npmjs.org/big/latest": declared(1048577) });
    expect(await resolveArtifact("npx", "big", { fetch: a.fetch })).toMatchObject({ ok: false, code: "RESOLUTION_TOO_LARGE" });
    const b = fakeFetch({ "https://ghcr.io/token?scope=repository:o/big:pull": declared(1048577) });
    expect(await resolveArtifact("docker", "ghcr.io/o/big", { fetch: b.fetch })).toMatchObject({ ok: false, code: "RESOLUTION_TOO_LARGE" });
    const c = fakeFetch({ "https://pypi.org/pypi/big/json": declared(8388609) });
    expect(await resolveArtifact("uvx", "big", { fetch: c.fetch })).toMatchObject({ ok: false, code: "RESOLUTION_TOO_LARGE" });

    // content-length 없이 흘러오는 응답: 상한을 넘는 순간 읽기를 멈춘다.
    let pulled = 0;
    const chunk = new Uint8Array(256 * 1024).fill(32);
    const stream = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            pulled += 1;
            if (pulled > 40) controller.close();
            else controller.enqueue(chunk);
          },
        }),
        { status: 200 },
      );
    const d = fakeFetch({ "https://registry.npmjs.org/stream/latest": stream });
    expect(await resolveArtifact("npx", "stream", { fetch: d.fetch })).toMatchObject({ ok: false, code: "RESOLUTION_TOO_LARGE" });
    expect(pulled).toBeLessThan(10);

    // PyPI는 2 MiB 응답도 받아들인다(8 MiB 상한).
    const bigInfo = JSON.stringify({ info: { name: "big", version: "1.0.0" }, releases: { pad: "x".repeat(2 * 1024 * 1024) } });
    const e = fakeFetch({ "https://pypi.org/pypi/big/json": () => new Response(bigInfo, { status: 200 }) });
    expect(ok(await resolveArtifact("uvx", "big", { fetch: e.fetch })).identity.spec).toBe("big==1.0.0");
  });

  it("AC-039-08 버전·digest·응답 형식이 맞지 않으면 RESOLUTION_INVALID다", async () => {
    const { fetch } = fakeFetch({
      "https://registry.npmjs.org/short/latest": jsonRes({ name: "short", version: "1.2" }),
      "https://registry.npmjs.org/other/latest": jsonRes({ name: "evil", version: "1.2.3" }),
      "https://registry.npmjs.org/text/latest": () => new Response("<html>", { status: 200 }),
      "https://pypi.org/pypi/weird/json": jsonRes({ info: { name: "weird", version: "latest!" } }),
      "https://ghcr.io/token?scope=repository:o/bad:pull": jsonRes({ token: ANON_TOKEN }),
      "https://ghcr.io/v2/o/bad/manifests/latest": () => new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:xyz" } }),
      "https://ghcr.io/token?scope=repository:o/notoken:pull": jsonRes({}),
    });
    for (const [backend, spec] of [
      ["npx", "short"],
      ["npx", "other"],
      ["npx", "text"],
      ["npx", "missing"],
      ["npx", "pkg@^1.2.3"],
      ["uvx", "weird"],
      ["uvx", "pkg[extra]>=1"],
      ["docker", "ghcr.io/o/bad"],
      ["docker", "ghcr.io/o/notoken"],
    ] as const) {
      expect(await resolveArtifact(backend, spec, { fetch }), spec).toMatchObject({ ok: false, code: "RESOLUTION_INVALID" });
    }
    expect(parseImageRef("ghcr.io/o/x@sha256:short")).toBeNull();
  });

  it("AC-039-09 credential·cookie 없이 요청하고 process.env 접근 0회이며 익명 token은 결과에 남지 않는다", async () => {
    const head = () => new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
    const { fetch, calls } = fakeFetch({
      "https://registry.npmjs.org/chrome-devtools-mcp/latest": jsonRes({ name: "chrome-devtools-mcp", version: "1.2.3" }, { "set-cookie": "sid=1" }),
      "https://pypi.org/pypi/postgres-mcp/json": jsonRes({ info: { name: "postgres-mcp", version: "0.3.0" } }),
      "https://ghcr.io/token?scope=repository:github/github-mcp-server:pull": jsonRes({ token: ANON_TOKEN }),
      "https://ghcr.io/v2/github/github-mcp-server/manifests/latest": head,
    });
    const original = process.env;
    const touched: PropertyKey[] = [];
    process.env = new Proxy(original, { get: (t, k) => (touched.push(k), Reflect.get(t, k)), has: (t, k) => (touched.push(k), Reflect.has(t, k)) });
    const results: ResolveResult[] = [];
    try {
      results.push(await resolveArtifact("npx", "chrome-devtools-mcp", { fetch }));
      results.push(await resolveArtifact("uvx", "postgres-mcp", { fetch }));
      results.push(await resolveArtifact("docker", "ghcr.io/github/github-mcp-server", { fetch }));
    } finally {
      process.env = original;
    }
    expect(touched).toEqual([]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(JSON.stringify(results)).not.toContain(ANON_TOKEN);
    expect(JSON.stringify(results)).not.toContain("sid=1");
    for (const c of calls) {
      expect(c.init?.credentials, c.url).toBe("omit");
      expect(c.init?.redirect, c.url).toBe("error");
      const headers = Object.keys((c.init?.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase());
      expect(headers, c.url).not.toContain("cookie");
      if (!c.url.includes("/manifests/")) expect(headers, c.url).not.toContain("authorization");
    }
    const src = await readFile(path.join(REPO_ROOT, "packages/core/src/lifecycle/resolver.ts"), "utf8");
    expect(src).not.toMatch(/process\.env\s*[.[]|=\s*process\.env\b|\{[^}]*\}\s*=\s*process\.env/u);
  });

  it("AC-039-10 status·recommend·install 경로는 resolver를 import·호출하지 않는다", async () => {
    const files = [
      "packages/core/src/lifecycle/status.ts",
      "packages/core/src/lifecycle/store.ts",
      "packages/core/src/lifecycle/state.ts",
      "apps/cli/src/install.ts",
      "apps/cli/src/recommend.ts",
      "apps/desktop/src/install.ts",
      "apps/desktop/src/recommend.ts",
    ];
    for (const dir of ["packages/core/src/installer", "packages/core/src/recommendation"]) {
      for (const f of await readdir(path.join(REPO_ROOT, dir))) files.push(dir + "/" + f);
    }
    for (const file of files) {
      const text = await readFile(path.join(REPO_ROOT, file), "utf8");
      expect(text, file).not.toMatch(/lifecycle\/resolver|\.\/resolver["']|resolveArtifact|parseImageRef/u);
    }
    // 런타임 spy: install → state 기록 → status 전 과정에서 네트워크 호출 0회.
    const net = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", net);
    const seed = await seedEntries();
    const h = await createHarness(scratch, { entries: seed });
    const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }], false);
    const planned = await plannedOf(h, request);
    const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(result.status).toBe("succeeded");
    await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-07T00:00:00.000Z") });
    const st = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false });
    expect(st.ok).toBe(true);
    expect(net).not.toHaveBeenCalled();
  });
});

