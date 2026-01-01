import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { containsAbsolutePath, nodeConfigFs, readLifecycleState, type BackendProbeReport, type ConfigFs, type ExecChild, type ExecSpawner, type LifecycleEnvironment } from "@openhub/core";
import { runCli } from "../src/cli";
import { memoryIO } from "./helpers";
import { COMMIT, newHome, pinokioManifest, ptermLayout, realFs } from "../../../packages/core/test/pinokio/helpers";

/** TASK-056 CLI: releases·impact·update 머리말·discover·install --backend pinokio·pinokio inspect. 네트워크는 가짜 fetch뿐이다. */
const REPO = path.resolve(import.meta.dirname, "../../..");
const GOLDENS = path.join(import.meta.dirname, "fixtures/m6");
const UPDATE = process.env["OPENHUB_UPDATE_GOLDEN"] === "1";
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-cli-m6-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const TOKEN = "ghp_" + "Cl1T0kenValue000000000000000000000000";
const OPENAI_KEY = "sk-proj-" + "CliKeyValue0000000000000000000000000";
const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "shim-not-executed" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};
const NOTES_NEW = "## What's Changed\n### Bug Fixes\n- Fixed entity dedupe\n### Features\n- Added search_nodes limit\n<script>alert(1)</script>";
const NOTES_MID = "- BREAKING: renamed open_nodes to read_nodes\n- See the migration guide";

interface Ctx {
  base: string;
  project: string;
  home: string;
  repo: string;
  fetches: { url: string; auth: boolean }[];
  spawns: string[][];
  writes: string[];
  latest: string;
  stdout: string[];
  stderr: string[];
  run(args: string[], opts?: { tty?: boolean; answer?: (q: string) => string; extra?: Record<string, unknown> }): Promise<number>;
}

const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
async function ctx(): Promise<Ctx> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const c: Ctx = { base, project: path.join(base, "project"), home: path.join(base, "home"), repo: path.join(base, "repo"), fetches: [], spawns: [], writes: [], latest: "2025.8.4", stdout: [], stderr: [], run: async () => 0 };
  await mkdir(c.project);
  await mkdir(c.home);
  await cp(path.join(REPO, "registry"), path.join(c.repo, "registry"), { recursive: true });
  // YAML은 JSON의 상위 집합이다(CLI 패키지에 yaml 의존성을 더하지 않는다).
  await writeFile(path.join(c.repo, "registry", "mcp", "local-llm-ui.yaml"), JSON.stringify(pinokioManifest(), null, 2));
  await writeFile(path.join(c.project, "package.json"), '{ "name": "api" }\n');
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    c.fetches.push({ url, auth: Object.keys(headers).some((k) => k.toLowerCase() === "authorization") });
    if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: c.latest, engines: { node: ">=18" } });
    if (url.startsWith("https://api.github.com/repos/modelcontextprotocol/servers/releases")) {
      return json([
        { tag_name: "2025.9.25", name: "2025.9.25", body: NOTES_NEW, draft: false, prerelease: false, published_at: "2025-09-25T00:00:00Z", html_url: "https://github.com/modelcontextprotocol/servers/releases/tag/2025.9.25" },
        { tag_name: "2025.9.1", name: "2025.9.1", body: NOTES_MID, draft: false, prerelease: false, published_at: "2025-09-01T00:00:00Z", html_url: "https://github.com/modelcontextprotocol/servers/releases/tag/2025.9.1" },
        { tag_name: "2025.8.4", name: "2025.8.4", body: "- old", draft: false, prerelease: false, published_at: "2025-08-04T00:00:00Z", html_url: "https://github.com/modelcontextprotocol/servers/releases/tag/2025.8.4" },
      ]);
    }
    if (url === "https://api.openai.com/v1/responses") return json({ output: [{ type: "message", content: [{ type: "output_text", text: "Memory 2025.9.25: 버그 수정과 검색 개선." }] }] });
    if (url.startsWith("https://api.github.com/repos/someone/pinokio-app/contents/install.js")) return new Response("module.exports = { run: [{ method: \"shell.run\", params: { message: \"sudo apt install x\" } }] }", { status: 200 });
    if (url.startsWith("https://api.github.com/search/repositories")) return json({ items: [{ full_name: "acme/weather-mcp", description: "Weather MCP", stargazers_count: 5 }] });
    if (url.startsWith("https://registry.npmjs.org/-/v1/search")) return json({ objects: [{ package: { name: "@acme/weather-mcp", links: { repository: "https://github.com/acme/weather-mcp" } } }] });
    if (url.startsWith("https://registry.modelcontextprotocol.io/v0.1/servers")) return json({ servers: [], metadata: {} });
    if (url === "http://127.0.0.1:42000/pinokio/version") return json({ pinokiod: "4.0.3", script: "4.0" });
    if (url === "http://127.0.0.1:42000/pinokio/home") return json({ path: pinokioHome });
    return new Response("missing", { status: 404 });
  };
  const pinokioHome = await newHome();
  const layout = await ptermLayout();
  c.run = async (args, opts = {}) => {
    const io = memoryIO(c.repo);
    const spawner: ExecSpawner = (exe, a) => {
      c.spawns.push([exe, ...a]);
      const events = new EventEmitter();
      queueMicrotask(() => events.emit("close", 0, null));
      return { stdout: null, stderr: null, on: (e: string, l: (...x: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
    };
    const configFs: ConfigFs = { ...nodeConfigFs, writeFile: async (f, d) => (c.writes.push(path.relative(base, f)), nodeConfigFs.writeFile(f, d)) };
    const runHealth: NonNullable<LifecycleEnvironment["runHealth"]> = async () => ({ ok: true, result: { status: "healthy", reason: null, toolCount: 4, environmentUnverified: false, terminated: true, excerpt: null } });
    const toolArg = args.find((a, i) => i > 0 && !a.startsWith("-") && ["install", "update"].includes(args[i - 1]!)) ?? "";
    Object.assign(io, {
      prompter: { isTTY: opts.tty ?? true, ask: async (q: string) => opts.answer?.(q) ?? (q.includes("Tool ID") ? toolArg : "y") },
      spawner,
      pinokioSpawner: spawner,
      configFs,
      runHealth,
      fetch,
      probe: async () => PROBES,
      homeDir: c.home,
      hostEnvironment: { homeDir: c.home, pathEnv: "", pathExt: "" },
      pinokioProbe: { pathEnv: layout.pathEnv, platform: process.platform, fs: realFs() },
      platform: "linux",
      tempBase: base,
      resolveToken: async () => ({ token: TOKEN, source: "GITHUB_TOKEN" }),
      env: { OPENAI_API_KEY: OPENAI_KEY, PATH: "/usr/bin" },
      now: () => new Date("2026-10-07T09:00:00.000Z"),
      isolatedDir: async () => {
        const dir = await mkdtemp(path.join(base, "iso-"));
        return { path: dir, base, cleanup: () => rm(dir, { recursive: true, force: true }) };
      },
      ...opts.extra,
    });
    const code = await runCli(args, io);
    c.stdout = io.stdout;
    c.stderr = io.stderr;
    return code;
  };
  return c;
}
/** memory-mcp를 설치하고 2025.8.4로 업데이트해 둔 상태(Version State resolved 2025.8.4). */
async function installedAt(c: Ctx) {
  expect(await c.run(["install", "memory-mcp", "--client", "claude-code", "--project", c.project])).toBe(0);
  expect(await c.run(["update", "memory-mcp", "--project", c.project])).toBe(0);
  c.latest = "2025.9.25";
  c.fetches.length = 0;
  c.spawns.length = 0;
  c.writes.length = 0;
}
async function golden(name: string, actual: string) {
  const file = path.join(GOLDENS, name);
  if (UPDATE) {
    await mkdir(GOLDENS, { recursive: true });
    await writeFile(file, actual);
  }
  if (!existsSync(file)) throw new Error("golden 없음: " + name + " — OPENHUB_UPDATE_GOLDEN=1로 생성하세요");
  expect(actual).toBe(await readFile(file, "utf8"));
}
const all = (c: Ctx) => [...c.stdout, ...c.stderr].join("\n");

describe("REQ-045 REQ-041 REQ-042 REQ-052 REQ-032 M6 CLI", () => {
  it("AC-056-01 openhub releases 출력(current → target, 결정론 요약, notes 원문 일부, 링크)이 golden과 같다", async () => {
    const c = await ctx();
    await installedAt(c);
    expect(await c.run(["releases", "memory-mcp", "--project", c.project])).toBe(0);
    expect(c.stdout.join("\n")).toContain("현재        2025.8.4");
    expect(c.stdout.join("\n")).toContain("  | <script>alert(1)</script>");
    await golden("releases-memory.txt", c.stdout.join("\n") + "\n");
    expect(await c.run(["releases", "memory-mcp", "--project", c.project, "--json"])).toBe(0);
    const doc = JSON.parse(c.stdout.join("\n")) as { snapshot: { target: { version: string } }; summary: { categories: Record<string, unknown[]> } };
    expect([doc.snapshot.target.version, doc.summary.categories["breaking"]!.length]).toEqual(["2025.9.25", 1]);
  });

  it("AC-056-02 openhub impact 출력(판정·reasons·evidence·영향 파일)이 golden과 같다", async () => {
    const c = await ctx();
    await installedAt(c);
    expect(await c.run(["impact", "memory-mcp", "--project", c.project])).toBe(0);
    expect(c.stdout).toContain("판정        HIGH (WARNING)");
    await golden("impact-memory.txt", c.stdout.join("\n") + "\n");
    expect(await c.run(["impact", "memory-mcp", "--project", c.project, "--to", "2025.9.1", "--json"])).toBe(0);
    expect(JSON.parse(c.stdout.join("\n"))).toMatchObject({ to: { version: "2025.9.1" }, verdict: "high", affectedFiles: [".mcp.json"] });
  });

  it("AC-056-03 openhub update Preview 앞에 Update available·Impact·Reasons·Summary가 붙고 LifecyclePlan JSON은 그대로다", async () => {
    const c = await ctx();
    await installedAt(c);
    expect(await c.run(["update", "memory-mcp", "--project", c.project], { answer: () => "n" })).toBe(1);
    const title = c.stdout.findIndex((l) => / 업데이트 계획$/u.test(l));
    expect(c.stdout.slice(0, 4)).toEqual([
      "Update available: 2025.8.4 → 2025.9.25",
      "Impact: HIGH (WARNING)",
      "Reasons: notes-breaking, notes-migration, version-minor",
      "Summary: Breaking 1 · Security 0 · Compatibility 1 · Performance 0 · Fix 1 · Other 1",
    ]);
    expect(title).toBeGreaterThan(4);
    const digest = c.stdout.find((l) => l.startsWith("Plan digest"))!.split(/\s+/u).at(-1);
    expect(await c.run(["update", "memory-mcp", "--project", c.project, "--json"])).toBe(0);
    const doc = JSON.parse(c.stdout.join("\n")) as { planDigest: string; plan: Record<string, unknown> };
    expect(doc.planDigest).toBe(digest);
    expect(JSON.stringify(doc.plan)).not.toMatch(/impact|Impact|summary/u);
    expect(c.spawns).toEqual([]);
  });

  it("AC-056-04 --json은 releases·impact·update·install --backend pinokio·discover 모두 실행(spawn·config·state·candidate 쓰기)이 0회다", async () => {
    const c = await ctx();
    await installedAt(c);
    const stateBefore = await readFile(path.join(c.home, ".openhub", "state", "lifecycle.json"), "utf8");
    for (const args of [["releases", "memory-mcp"], ["impact", "memory-mcp"], ["update", "memory-mcp"], ["install", "local-llm-ui", "--backend", "pinokio", "--client", "claude-code"], ["discover"]]) {
      expect(await c.run([...args, "--project", c.project, "--json"].filter((a, i, arr) => !(args[0] === "discover" && (a === "--project" || arr[i - 1] === "--project")))), args.join(" ")).toBe(0);
      expect(() => JSON.parse(c.stdout.join("\n")), args.join(" ")).not.toThrow();
    }
    expect([c.spawns, c.writes]).toEqual([[], []]);
    expect(await readFile(path.join(c.home, ".openhub", "state", "lifecycle.json"), "utf8")).toBe(stateBefore);
    expect(existsSync(path.join(c.repo, "registry-candidates"))).toBe(false);
    expect(existsSync(path.join(c.home, ".openhub", "state", "pinokio.json"))).toBe(false);
  });

  it("AC-056-05 --yes·-y·--approve는 exit 2다", async () => {
    const c = await ctx();
    for (const cmd of [["releases", "memory-mcp"], ["impact", "memory-mcp"], ["discover"], ["pinokio", "inspect", "someone/pinokio-app@" + COMMIT], ["install", "local-llm-ui", "--backend", "pinokio"], ["update", "memory-mcp"]]) {
      for (const flag of ["--yes", "-y", "--approve", "--approve=sha256:abc"]) expect(await c.run([...cmd, flag]), cmd.join(" ") + " " + flag).toBe(2);
    }
    expect([c.spawns, c.writes, c.fetches]).toEqual([[], [], []]);
  });

  it("AC-056-06 비TTY 실행 요청은 exit 3 APPROVAL_REQUIRED다", async () => {
    const c = await ctx();
    expect(await c.run(["install", "local-llm-ui", "--backend", "pinokio", "--project", c.project], { tty: false })).toBe(3);
    expect(c.stderr.join("\n")).toContain("APPROVAL_REQUIRED");
    expect(await c.run(["update", "memory-mcp", "--project", c.project], { tty: false })).toBe(3);
    expect([c.spawns, c.writes]).toEqual([[], []]);
  });

  it("AC-056-07 openhub discover와 openhub pinokio inspect(제3자 Preview, 실행 0)가 동작한다", async () => {
    const c = await ctx();
    expect(await c.run(["discover"])).toBe(0);
    expect(c.stdout.join("\n")).toContain("acme-weather-mcp");
    expect(await readdir(path.join(c.repo, "registry-candidates"))).toEqual(["acme-weather-mcp.yaml"]);
    expect(await c.run(["discover", "--out", "registry"])).toBe(2);
    expect(await c.run(["pinokio", "inspect", "someone/pinokio-app@" + COMMIT])).toBe(0);
    const text = c.stdout.join("\n");
    expect(text).toContain("  | module.exports = { run: [{ method: \"shell.run\", params: { message: \"sudo apt install x\" } }] }");
    expect(text).toContain("L1 sudo");
    expect(text).toContain("OpenHub는 제3자 Pinokio script를 실행하지 않습니다");
    expect(await c.run(["pinokio", "inspect", "someone/pinokio-app@main"])).toBe(2);
    expect(c.spawns).toEqual([]);
  });

  it("AC-056-08 모든 출력에 token·API key·env 값·절대 경로가 0건이다", async () => {
    const c = await ctx();
    await installedAt(c);
    const outputs: string[] = [];
    for (const args of [["releases", "memory-mcp", "--llm-summary", "--llm-model", "gpt-test"], ["releases", "memory-mcp", "--json", "--llm-summary", "--llm-model", "gpt-test"], ["impact", "memory-mcp"], ["impact", "memory-mcp", "--json"], ["update", "memory-mcp", "--json"]]) {
      await c.run([...args, "--project", c.project]);
      outputs.push(all(c));
    }
    for (const args of [["discover", "--json"], ["pinokio", "inspect", "someone/pinokio-app@" + COMMIT], ["install", "local-llm-ui", "--backend", "pinokio", "--json"]]) {
      await c.run(args);
      outputs.push(all(c));
    }
    expect(outputs[0]).toContain("LLM 요약(표시 전용, gpt-test)");
    expect(c.fetches.some((f) => f.url.startsWith("https://api.github.com/") && f.auth)).toBe(true);
    for (const out of outputs) {
      for (const banned of [TOKEN, OPENAI_KEY, "/usr/bin", c.base, c.home, c.project]) expect(out).not.toContain(banned);
      expect(containsAbsolutePath(out.replace(/"content": "module\.exports[^\n]*/gu, ""))).toBe(false);
    }
    const state = await readLifecycleState({ homeDir: c.home });
    expect(state.ok).toBe(true);
  });
});

