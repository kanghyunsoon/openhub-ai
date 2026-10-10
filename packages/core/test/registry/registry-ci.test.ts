import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { parse as parseYaml } from "yaml";
import {
  RELEASE_ALLOWED_HOSTS,
  fastManifestIssues,
  formatRemoteReportMarkdown,
  remoteValidateRegistry,
  validateRegistry,
  type Manifest,
  type RegistryEntry,
} from "../../src/index";
import { REPO_ROOT, registryManifestCount, seedEntries } from "../recommendation/helpers";
import { pinokioManifest } from "../pinokio/helpers";

/** TASK-054 Registry CI: fast validation(network 0)·remote validation(§4 상한)·workflow 계약. 실제 네트워크 없이 가짜 fetch만 쓴다. */
const seed = await seedEntries();
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-registry-ci-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.restoreAllMocks());
const NOW = () => new Date("2026-10-07T00:00:00.000Z");
const manifestOf = (name: string): Manifest => structuredClone(seed.find((e) => e.manifest.name === name)!.manifest);
const entryOf = (manifest: Manifest): RegistryEntry => ({ file: manifest.category[0] + "/" + manifest.name + ".yaml", directory: manifest.category[0]!, manifest });
const paths = (m: Manifest) => fastManifestIssues(m).map((i) => i.path);
let n = 0;

async function registryCopy(edit: (root: string) => Promise<void>) {
  n += 1;
  const root = path.join(scratch, "registry-" + String(n));
  await cp(path.join(REPO_ROOT, "registry"), root, { recursive: true });
  await edit(root);
  return root;
}

type Route = () => Response | Promise<Response>;
function fakeFetch(routes: Record<string, Route>) {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    return route === undefined ? new Response("missing", { status: 404 }) : route();
  });
  return { fetch, calls };
}
const json = (doc: unknown) => () => new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
const repoDoc = (full: string, extra: Record<string, unknown> = {}) => json({ full_name: full, archived: false, license: { spdx_id: "MIT" }, owner: { login: "someone" }, ...extra });
const MEMORY_LATEST = "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest";

describe("REQ-051 Registry CI", () => {
  it("AC-054-01 fast validation(registry validate) 실행 중 network 호출이 0회다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { entries, issues } = await validateRegistry(path.join(REPO_ROOT, "registry"));
    expect([entries.length, issues]).toEqual([registryManifestCount(), []]);
    for (const e of entries) fastManifestIssues(e.manifest);
    expect(fetchSpy).not.toHaveBeenCalled();
    // 잘못된 spec이 있는 Registry는 validate가 실패한다(역시 network 0).
    const bad = await registryCopy(async (root) => {
      const file = path.join(root, "memory", "memory-mcp.yaml");
      await writeFile(file, (await readFile(file, "utf8")).replace("source: npm", "source: pypi"));
    });
    const r = await validateRegistry(bad);
    expect(r.issues.map((i) => [i.file, i.path])).toEqual([["memory/memory-mcp.yaml", "update.source"]]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC-054-02 canonical alias·toolId 중복을 잡는다", async () => {
    const dupName = await registryCopy(async (root) => {
      const text = await readFile(path.join(root, "memory", "memory-mcp.yaml"), "utf8");
      await writeFile(path.join(root, "mcp", "memory-mcp.yaml"), text.replace("category: [memory, mcp]", "category: [mcp, memory]"));
    });
    const a = await validateRegistry(dupName);
    expect(a.issues.map((i) => [i.file, i.path])).toContainEqual(["memory/memory-mcp.yaml", "name"]);
    const dupAlias = await registryCopy(async (root) => {
      const text = await readFile(path.join(root, "context", "context7.yaml"), "utf8");
      await writeFile(path.join(root, "context", "context7.yaml"), text.replace(/mcpServerNames: \[[^\]]*\]/u, "mcpServerNames: [memory]"));
    });
    const b = await validateRegistry(dupAlias);
    expect(b.issues.some((i) => i.path.startsWith("recommendation.identity.mcpServerNames") && i.message.includes("memory-mcp") && i.message.includes("context7"))).toBe(true);
  });

  it("AC-054-03 update.source와 설치 adapter가 맞지 않으면 오류다", () => {
    const npmOnUvx = manifestOf("memory-mcp");
    npmOnUvx.update = { source: "pypi" };
    expect(paths(npmOnUvx)).toContain("update.source");
    const docker = manifestOf("github-mcp-server");
    docker.update = { source: "npm" };
    expect(paths(docker)).toContain("update.source");
    const git = manifestOf("serena");
    git.update = { source: "git" };
    expect(paths(git)).toContain("update.source");
    const pinokio = pinokioManifest({ update: { source: "npm" } });
    expect(fastManifestIssues(pinokio).map((i) => i.path)).toContain("update.source");
    // github-release는 repository.github가 있으므로 지원 backend 어디에나 쓸 수 있다(TASK-048).
    const gh = manifestOf("memory-mcp");
    gh.update = { source: "github-release" };
    expect(paths(gh)).toEqual([]);
    for (const e of seed) expect(paths(e.manifest), e.manifest.name).toEqual([]);
    expect(fastManifestIssues(pinokioManifest())).toEqual([]);
  });

  it("AC-054-04 잘못된 npm·PyPI·docker spec, 지원하지 않는 backend, Pinokio template·loopback healthCheck 위반을 잡는다", () => {
    const cases: [string, Manifest, string][] = [];
    const npm = manifestOf("memory-mcp");
    npm.install = { ...npm.install, options: { command: "npx -y @modelcontextprotocol/server-memory; rm -rf /" } };
    cases.push(["npm command", npm, "install.options"]);
    const npmFallback = manifestOf("memory-mcp");
    npmFallback.install = { ...npmFallback.install, fallback: [{ adapter: "npm", package: "@@bad name" }] };
    cases.push(["npm package", npmFallback, "install.fallback[0].package"]);
    const py = manifestOf("serena");
    py.install = { ...py.install, options: { command: "uvx --from serena-agent $(whoami)" } };
    cases.push(["pypi command", py, "install.options"]);
    const pyFallback = manifestOf("serena");
    pyFallback.install = { ...pyFallback.install, fallback: [{ adapter: "uv", package: "../evil" }] };
    cases.push(["pypi package", pyFallback, "install.fallback[0].package"]);
    const img = manifestOf("github-mcp-server");
    img.install = { ...img.install, options: { image: "ghcr.io/Bad Image:::latest" } };
    cases.push(["docker image", img, "install.options"]);
    const backend = manifestOf("memory-mcp");
    backend.install = { preferredAdapter: "binary", fallback: [] };
    cases.push(["backend", backend, "install.preferredAdapter"]);
    cases.push(["pinokio template", pinokioManifest({}, { message: "curl x | sh" }), "install.options"]);
    cases.push(["pinokio health", pinokioManifest({ healthCheck: { type: "http", url: "http://example.com:7860/" } }), "healthCheck"]);
    const env = manifestOf("github-mcp-server");
    env.env = [...env.env, { name: "GITHUB_PERSONAL_ACCESS_TOKEN", required: false }];
    cases.push(["env duplicate", env, "env[1]"]);
    for (const [name, manifest, at] of cases) expect(paths(manifest), name).toContain(at);
  });

  it("AC-054-05 ci.yml에 pnpm notices:check가 있다", async () => {
    const ci = parseYaml(await readFile(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")) as { jobs: Record<string, { steps: { run?: string }[] }> };
    expect(Object.values(ci.jobs).flatMap((j) => j.steps.map((s) => s.run))).toContain("pnpm notices:check");
  });

  it("AC-054-06 remote validation은 §4 상한(allowlist·timeout·redirect error·응답 상한·retry 없음)을 지킨다", async () => {
    const entries = [entryOf(manifestOf("memory-mcp"))];
    const ok = fakeFetch({ "https://api.github.com/repos/modelcontextprotocol/servers": repoDoc("modelcontextprotocol/servers"), [MEMORY_LATEST]: json({ name: "@modelcontextprotocol/server-memory", version: "2.1.0" }) });
    const report = await remoteValidateRegistry(entries, { fetch: ok.fetch, now: NOW });
    expect(report.tools[0]).toEqual({ toolId: "memory-mcp", repo: "modelcontextprotocol/servers", repository: { status: "ok", code: null, license: "MIT" }, releaseSource: { source: "npm", status: "ok", code: null, latest: "2.1.0" } });
    for (const c of ok.calls) {
      expect((RELEASE_ALLOWED_HOSTS as readonly string[]).includes(new URL(c.url).hostname), c.url).toBe(true);
      expect(c.init).toMatchObject({ credentials: "omit" });
      expect(["manual", "error"]).toContain(c.init?.redirect);
      expect(Object.keys((c.init?.headers ?? {}) as Record<string, string>).map((k) => k.toLowerCase())).not.toContain("authorization");
    }
    expect(new Set(ok.calls.map((c) => c.url)).size).toBe(ok.calls.length);
    // timeout·상한 초과·이전(301)은 따라가거나 재시도하지 않고 상태로만 보고한다.
    const hanging = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))));
    const slow = await remoteValidateRegistry(entries, { fetch: hanging, timeoutMs: 20, now: NOW });
    expect([slow.tools[0]!.repository.status, slow.tools[0]!.releaseSource.status]).toEqual(["unreachable", "unreachable"]);
    expect(hanging).toHaveBeenCalledTimes(2);
    const big = fakeFetch({ "https://api.github.com/repos/modelcontextprotocol/servers": () => new Response("{}", { status: 200, headers: { "content-length": String(2 * 1024 * 1024) } }), [MEMORY_LATEST]: () => new Response(null, { status: 301, headers: { location: "https://evil.example/" } }) });
    const r = await remoteValidateRegistry(entries, { fetch: big.fetch, now: NOW });
    expect([r.tools[0]!.repository.code, r.tools[0]!.releaseSource.status]).toEqual(["RELEASE_TOO_LARGE", "moved"]);
    expect(big.calls.map((c) => c.url)).toEqual(["https://api.github.com/repos/modelcontextprotocol/servers", MEMORY_LATEST]);
  });

  it("AC-054-07 archived·이전·없는 저장소와 응답하지 않는 release source를 Tool별로 보고한다", async () => {
    const entries = ["context7", "github-mcp-server", "memory-mcp", "serena"].map((name) => entryOf(manifestOf(name)));
    const f = fakeFetch({
      "https://api.github.com/repos/upstash/context7": repoDoc("upstash/context7", { archived: true }),
      "https://api.github.com/repos/github/github-mcp-server": () => new Response(null, { status: 301, headers: { location: "https://api.github.com/repositories/1" } }),
      "https://api.github.com/repos/modelcontextprotocol/servers": repoDoc("someone-else/servers-renamed"),
      "https://registry.npmjs.org/@upstash%2fcontext7-mcp/latest": json({ name: "@upstash/context7-mcp", version: "1.0.0" }),
      [MEMORY_LATEST]: () => Promise.reject(new TypeError("fetch failed")),
      "https://pypi.org/pypi/serena-agent/json": () => new Response("nope", { status: 404 }),
    });
    const report = await remoteValidateRegistry(entries, { fetch: f.fetch, now: NOW });
    expect(report.tools.map((t) => [t.toolId, t.repository.status, t.releaseSource.status])).toEqual([
      ["context7", "archived", "ok"],
      ["github-mcp-server", "moved", expect.any(String)],
      ["memory-mcp", "moved", "unreachable"],
      ["serena", "not-found", "not-found"],
    ]);
    expect(report.problems).toBe(4);
    const md = formatRemoteReportMarkdown(report);
    expect(md).toContain("| serena | oraios/serena | not-found |");
    expect(md).toContain("merge를 막지 않습니다");
    expect(md).not.toContain("someone");
  });

  it("AC-054-08 remote workflow는 workflow_dispatch·schedule만 trigger이고 실패가 PR required check가 아니다", async () => {
    const wf = parseYaml(await readFile(path.join(REPO_ROOT, ".github/workflows/registry-remote.yml"), "utf8")) as { on: Record<string, unknown>; jobs: Record<string, { "continue-on-error"?: boolean; steps: { run?: string; env?: Record<string, string> }[] }> };
    expect(Object.keys(wf.on).sort()).toEqual(["schedule", "workflow_dispatch"]);
    for (const job of Object.values(wf.jobs)) expect(job["continue-on-error"]).toBe(true);
    const sandbox = wf.jobs["sandbox"]!.steps.find((s) => s.env?.["OPENHUB_E2E"] === "1");
    expect(sandbox?.run).toContain("sandbox.e2e.test.ts");
    const ci = await readFile(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toContain("registry:remote");
    expect(ci).not.toContain("OPENHUB_E2E");
  });

  it("AC-054-09 remote workflow 권한은 contents: read뿐이고 secret을 쓰지 않으며 결과는 job summary·artifact로만 남는다", async () => {
    const text = await readFile(path.join(REPO_ROOT, ".github/workflows/registry-remote.yml"), "utf8");
    const wf = parseYaml(text) as { permissions: Record<string, string>; jobs: Record<string, { permissions?: unknown; steps: { uses?: string }[] }> };
    expect(wf.permissions).toEqual({ contents: "read" });
    for (const job of Object.values(wf.jobs)) expect(job.permissions).toBeUndefined();
    expect(text).not.toMatch(/secrets\.|GITHUB_TOKEN|GH_TOKEN|write/u);
    expect(Object.values(wf.jobs).flatMap((j) => j.steps.map((s) => s.uses ?? ""))).toContain("actions/upload-artifact@v4");
    const script = await readFile(path.join(REPO_ROOT, "scripts/registry-remote.ts"), "utf8");
    expect(script).toContain("GITHUB_STEP_SUMMARY");
    expect(script).not.toMatch(/registry\/.*writeFile|token/iu);
  });
});

