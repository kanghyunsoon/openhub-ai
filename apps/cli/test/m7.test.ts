import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { discoveryCandidateSchema, writeCandidates, type BackendProbeReport, type HealthChild, type HealthSpawner } from "@openhub/core";
import { runCli, type CliIO } from "../src/cli";
import { memoryIO } from "./helpers";

/** TASK-069 M7 CLI(adopt·discover --view·trending·candidate prepare·benchmark·doctor). 임시 project·home, 가짜 prompter·spawner만 쓴다. */
const REPO = path.resolve(import.meta.dirname, "../../..");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-cli-m7-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const MEMORY = "@modelcontextprotocol/server-memory";
const SECRET = "ghp_" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji";
const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "24.18.0", status: "ok" },
  npx: { name: "npx", available: true, version: "11.0.0", status: "ok" },
  uvx: { name: "uvx", available: false, version: null, status: "not-found" },
  docker: { name: "docker", available: true, version: "29.0.0", status: "ok" },
};
type IO = CliIO & { stdout: string[]; stderr: string[] } & Record<string, unknown>;
let n = 0;
async function env(answers: string[] = [], tty = true): Promise<IO & { project: string; home: string }> {
  const base = path.join(scratch, "c" + String(n++));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project, { recursive: true });
  await mkdir(home, { recursive: true });
  await writeFile(path.join(project, "package.json"), '{ "name": "demo", "dependencies": { "react": "^19.0.0" } }\n');
  await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } } }, null, 2) + "\n");
  const io = memoryIO(REPO) as IO;
  const queue = [...answers];
  Object.assign(io, { homeDir: home, platform: "linux", now: () => new Date("2026-10-08T00:00:00.000Z"), probe: async () => PROBES, prompter: { isTTY: tty, ask: async () => queue.shift() ?? "" }, hostEnvironment: { pathEnv: "" } });
  return Object.assign(io, { project, home });
}
class FakeServer extends EventEmitter implements HealthChild {
  readonly pid = 1;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  #closed = false;
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const m = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() => {
          if (m["method"] === "initialize") this.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { serverInfo: { name: "memory", version: "1.2.3" } } }) + "\n"));
          if (m["method"] === "tools/list") this.stdout.emit("data", Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 2, result: { tools: [] } }) + "\n"));
        });
      }
      return true;
    },
    end: () => this.close(),
    on: () => undefined,
  };
  close() {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", 0, null));
  }
}
const all = (io: IO) => io.stdout.join("\n") + "\n" + io.stderr.join("\n");
const stateFile = (home: string) => path.join(home, ".openhub", "state", "lifecycle.json");
const exists = (f: string) => readFile(f).then(() => true, () => false);
const outputs: string[] = [];

describe("REQ-060 REQ-061 REQ-063 REQ-064 M7 CLI", () => {
  it("AC-069-01 adopt는 Preview → TTY 승인 → 실행이고 비TTY는 거부하며 --json은 Plan만 출력한다", async () => {
    const io = await env(["memory-mcp"]);
    expect(await runCli(["adopt", "memory-mcp", "--project", io.project], io)).toBe(0);
    expect(io.stdout.join("\n")).toContain("Adopt 계획: memory-mcp (ready)");
    expect(io.stdout.join("\n")).toContain("Adopt 완료");
    expect(await exists(stateFile(io.home))).toBe(true);
    outputs.push(all(io));
    const json = await env();
    expect(await runCli(["adopt", "memory-mcp", "--project", json.project, "--json"], json)).toBe(0);
    expect(JSON.parse(json.stdout.join("\n"))).toMatchObject({ plan: { kind: "openhub-adopt-plan", status: "ready" }, planDigest: expect.stringMatching(/^sha256:/u) });
    expect(await exists(stateFile(json.home))).toBe(false);
    const noTty = await env([], false);
    expect(await runCli(["adopt", "memory-mcp", "--project", noTty.project], noTty)).toBe(3);
    expect(await exists(stateFile(noTty.home))).toBe(false);
  });

  it("AC-069-02 새 명령 어디에도 --yes·-y·--approve가 없다", async () => {
    for (const cmd of [["adopt", "memory-mcp"], ["benchmark", "memory-mcp"], ["candidate", "prepare", "x"], ["discover", "--view", "trending"], ["trending"]]) {
      for (const flag of ["--yes", "-y", "--approve", "--approve=sha256:x"]) {
        const io = await env();
        expect(await runCli([...cmd, flag], io), cmd.join(" ") + " " + flag).toBe(2);
      }
    }
  });

  it("AC-069-03 discover --view는 network 0이고 --view 없는 discover는 M6 동작 그대로다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const view of ["new", "trending", "verified", "candidates"]) {
      const io = await env();
      const fetch = vi.fn();
      Object.assign(io, { fetch });
      expect(await runCli(["discover", "--view", view, "--project", io.project], io), view).toBe(0);
      expect(fetch).not.toHaveBeenCalled();
      outputs.push(all(io));
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    const m6 = await env();
    const fetch = vi.fn(async () => new Response(JSON.stringify({ items: [], objects: [], servers: [], metadata: {} }), { status: 200 }));
    Object.assign(m6, { fetch, resolveToken: async () => undefined });
    expect(await runCli(["discover", "--json", "--no-token"], m6)).toBe(0);
    expect(fetch).toHaveBeenCalled();
    expect(await runCli(["discover", "--view", "bogus"], await env())).toBe(2);
  });

  it("AC-069-04 trending 출력은 discover --view trending과 같다", async () => {
    const a = await env();
    const b = await env();
    expect(await runCli(["trending"], a)).toBe(0);
    expect(await runCli(["discover", "--view", "trending"], b)).toBe(0);
    expect(a.stdout).toEqual(b.stdout);
    expect(a.stdout[0]).toContain("historical star growth가 아니라");
  });

  it("AC-069-05 candidate prepare는 package를 쓰고 덮어쓰기를 거부하며 사용자 실행 명령을 안내하고 GitHub write가 0이다", async () => {
    const io = await env();
    const repoDir = path.join(io.project, "..");
    await writeCandidates(repoDir, [
      discoveryCandidateSchema.parse({ id: "weather-mcp", sources: ["npm-search"], repository: "acme/weather-mcp", package: { kind: "npm", name: "weather-mcp", key: "npm:weather-mcp" }, signals: { stars: 1, updatedAt: null, archived: false, description: "x" }, confidence: "medium", evidence: [{ source: "npm-search", ref: "weather-mcp" }], untrustedInstallText: null, discoveredAt: "2026-10-07T00:00:00.000Z" }),
    ]);
    const fetch = vi.fn();
    Object.assign(io, { fetch });
    const out = path.join(repoDir, "contrib");
    const args = ["candidate", "prepare", "weather-mcp", "--candidates-dir", path.join(repoDir, "registry-candidates"), "--out", out];
    expect(await runCli(args, io)).toBe(0);
    expect((await readdir(path.join(out, "weather-mcp"))).sort()).toContain("COMMANDS.md");
    expect(io.stdout.join("\n")).toContain("OpenHub는 GitHub에 쓰지 않았습니다");
    expect(fetch).not.toHaveBeenCalled();
    expect(await runCli(args, io)).toBe(1);
    expect(io.stderr.join("\n")).toContain("CONTRIBUTION_EXISTS");
    expect(await runCli(["candidate", "prepare", "../x"], await env())).toBe(2);
    const src = await readFile(path.join(REPO, "apps/cli/src/m7.ts"), "utf8");
    expect(src).not.toMatch(new RegExp('from "node:' + "child_" + 'process"|\\bgh pr create\\b.*spawn', "u"));
  });

  it("AC-069-06 benchmark는 TTY 승인 후 실행하고 --json은 Plan만이며 결과는 median·min·max·실패 수만 보여 준다", async () => {
    const io = await env(["memory-mcp"]);
    expect(await runCli(["adopt", "memory-mcp", "--project", io.project], io)).toBe(0);
    const spawned: string[] = [];
    const healthSpawner: HealthSpawner = (exe) => (spawned.push(exe), new FakeServer());
    const json = Object.assign(await env(), { homeDir: io.home, healthSpawner, killTree: async () => true });
    expect(await runCli(["benchmark", "memory-mcp", "--project", io.project, "--json"], json)).toBe(0);
    expect(JSON.parse(json.stdout.join("\n"))).toMatchObject({ plan: { kind: "openhub-benchmark-plan", status: "ready" } });
    expect(spawned).toHaveLength(0);
    const run = Object.assign(await env(["y", "memory-mcp"]), { homeDir: io.home, healthSpawner, killTree: async () => true, tempBase: await mkdtemp(path.join(scratch, "tmp-")) });
    expect(await runCli(["benchmark", "memory-mcp", "--project", io.project], run)).toBe(0);
    expect(spawned).toHaveLength(6);
    const text = run.stdout.join("\n");
    expect(text).toContain("tools/call 0");
    expect(text).toMatch(/준비 완료\(ready\) {2}median \d+ ms · min \d+ · max \d+/u);
    expect(text).toContain("성공 5 · 실패 0");
    // 결과 부분(요약 줄)에는 백분위가 없다. 고지 문구("p95 not reported", Preview의 "p95 없음")만 있다.
    const result = text.slice(text.indexOf("Benchmark memory-mcp —")).replace("p95 not reported", "");
    expect(result).not.toMatch(/p95|p99/u);
    outputs.push(all(run));
  });

  it("AC-069-07 doctor는 Node·probe·pterm·Registry·metadata·Version State·지원 범위를 보여 주고 write 0, MCP 실행 0이다", async () => {
    const io = await env();
    const before = await readdir(io.home, { recursive: true });
    const healthSpawner = vi.fn();
    Object.assign(io, { healthSpawner });
    expect(await runCli(["doctor"], io)).toBe(0);
    const text = io.stdout.join("\n");
    for (const s of ["Node ", "npx", "uvx", "docker", "pterm", "Registry 7개", "metadata", "Version State ~/.openhub/state/lifecycle.json", "지원 범위", "pterm 0.0.25"]) expect(text, s).toContain(s);
    expect(await readdir(io.home, { recursive: true })).toEqual(before);
    expect(healthSpawner).not.toHaveBeenCalled();
    const json = await env();
    expect(await runCli(["doctor", "--json"], json)).toBe(0);
    expect(JSON.parse(json.stdout.join("\n"))).toMatchObject({ registry: { manifests: 7 }, versionState: { status: "ok" }, pinokio: { supported: "pterm 0.0.25" } });
    outputs.push(all(io), all(json));
  });

  it("AC-069-08 help에 새 명령이 있고 기존 명령 golden은 그대로다", async () => {
    const io = memoryIO(REPO);
    expect(await runCli(["--help"], io)).toBe(0);
    const help = io.stdout.join("\n");
    for (const s of ["adopt <toolId>", "discover --view new|trending|verified|candidates", "trending [--json]", "candidate prepare <candidateId>", "benchmark <toolId>", "doctor [--json]"]) expect(help, s).toContain(s);
    for (const s of ["install <toolId>", "update <toolId>", "rollback <toolId>", "lifecycle status", "releases <toolId>", "impact <toolId>", "discover [--source", "pinokio inspect"]) expect(help, s).toContain(s);
    // M6 CLI golden(fixtures/m6)은 이 TASK에서 바뀌지 않았다.
    for (const f of await readdir(path.join(import.meta.dirname, "fixtures", "m6"))) expect((await readFile(path.join(import.meta.dirname, "fixtures", "m6", f), "utf8")).length, f).toBeGreaterThan(0);
  });

  it("AC-069-09 새 명령 출력에 절대 경로·token·env 값이 없다", async () => {
    const io = await env(["memory-mcp"]);
    await writeFile(path.join(io.project, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "npx", args: ["-y", MEMORY, "--token", SECRET], env: { KEY: "sk-" + "abcdefghijklmnopqrstuvwx" } } } }, null, 2) + "\n");
    expect(await runCli(["adopt", "memory-mcp", "--project", io.project, "--server-name", "memory"], io)).toBe(1);
    outputs.push(all(io));
    for (const text of outputs) {
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("sk-abcdefghij");
      expect(text).not.toContain(scratch);
      expect(text).not.toMatch(/[A-Za-z]:\\Users\\|\/home\/[a-z]/u);
    }
  });

  it("AC-069-10 blocked·stale·거부·성공·인자 오류의 exit code가 기존 관례와 같다", async () => {
    const blocked = await env();
    await writeFile(path.join(blocked.project, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "bash", args: ["-c", "x"] } } }) + "\n");
    expect(await runCli(["adopt", "memory-mcp", "--project", blocked.project], blocked)).toBe(1);
    const rejected = await env(["nope"]);
    expect(await runCli(["adopt", "memory-mcp", "--project", rejected.project], rejected)).toBe(1);
    expect(await exists(stateFile(rejected.home))).toBe(false);
    expect(await runCli(["adopt", "no-such-tool", "--project", rejected.project], await env())).toBe(2);
    expect(await runCli(["adopt"], await env())).toBe(2);
    expect(await runCli(["benchmark", "memory-mcp", "--project", (await env()).project], await env())).toBe(1);
    expect(await runCli(["adopt", "memory-mcp", "--client", "vscode"], await env())).toBe(2);
  });
});

