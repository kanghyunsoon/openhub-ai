import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  BENCHMARK_REPORT_NOTES,
  benchmarkReportSchema,
  executeAdopt,
  formatBenchmarkReport,
  planAdopt,
  planBenchmark,
  requestAdoptApproval,
  requestBenchmarkApproval,
  runBenchmark,
  type BenchmarkRunOptions,
  type HealthChild,
  type HealthSpawner,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";
import { MEMORY, adoptOptions, mcp, newCase, plannedOf, type Case } from "../adopt/helpers";

/** TASK-066 Benchmark 실행·Report v1. 가짜 MCP 서버(child)·가짜 시계만 쓴다(실제 spawn·network 없음). */
const seed = await seedEntries();
const scratch = await newScratch("benchmark-run-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());
vi.setConfig({ testTimeout: 30_000 });
const NOW = () => new Date("2026-10-08T01:00:00.000Z");
const SECRET = "ghp_" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji";

interface Behaviour {
  init?: boolean;
  linger?: boolean;
  serverInfo?: unknown;
  stderr?: string;
}
class FakeServer extends EventEmitter implements HealthChild {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly methods: string[] = [];
  #closed = false;
  constructor(private readonly b: Behaviour) {
    super();
    if (b.stderr !== undefined) queueMicrotask(() => this.stderr.emit("data", Buffer.from(b.stderr!)));
  }
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        if (typeof msg["method"] === "string") this.methods.push(msg["method"]);
        queueMicrotask(() => this.react(msg));
      }
      return true;
    },
    end: () => {
      if (this.b.linger !== true) this.close();
    },
    on: () => undefined,
  };
  react(m: Record<string, unknown>) {
    const out = (o: unknown) => this.stdout.emit("data", Buffer.from(JSON.stringify(o) + "\n"));
    if (m["method"] === "initialize" && this.b.init !== false) out({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: this.b.serverInfo ?? { name: "memory", version: "1.2.3" }, capabilities: {} } });
    if (m["method"] === "tools/list") out({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }, { name: "b" }] } });
  }
  close() {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", 0, null));
  }
}

async function managed(): Promise<Case> {
  const c = await newCase(scratch, { ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }) });
  const options = adoptOptions(seed, c);
  const p = plannedOf(await planAdopt(options));
  const o = await requestAdoptApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (o.status !== "approved") throw new Error(o.status);
  expect((await executeAdopt(o.approval, { toolId: "memory-mcp", homeDir: c.homeDir, now: NOW, regenerate: () => planAdopt(options) })).status).toBe("adopted");
  return c;
}
/** 가짜 타이머를 켜기 전에 잡아 둔 실제 setTimeout(drive가 실제 시간으로 쉬는 데 쓴다). */
const realSetTimeout = globalThis.setTimeout;
/**
 * 가짜 setTimeout을 1초씩 앞당기고, 매번 실제 시간 1ms를 쉬어 회차 사이 실제 파일 I/O
 * (mkdtemp·realpath·rm·Plan 재생성)가 진행되게 한다.
 * - 반복 횟수 한도를 두지 않는다. 예전 3000회 한도는 setImmediate 1 tick(수십 µs) 단위라 I/O가 잠깐만 느려져도
 *   먼저 소진됐고, 이후 startup timeout(가짜 타이머)을 아무도 진행시키지 않아 testTimeout까지 멈췄다.
 * - 실제 timer로 쉬므로 I/O를 기다리는 동안 CPU를 계속 쓰는 busy-poll이 아니다.
 * - runBenchmark가 settle하면 끝난다. 끝나지 않으면 기존 testTimeout(30초)이 중단하고, 그 뒤 가짜 타이머가
 *   풀리면(afterEach) 루프도 멈춘다.
 */
async function drive<T>(p: Promise<T>): Promise<T> {
  let done = false;
  void p.then(() => (done = true), () => (done = true));
  while (!done && vi.isFakeTimers()) {
    await vi.advanceTimersByTimeAsync(1000);
    if (!done) await new Promise((r) => realSetTimeout(r, 1));
  }
  return p;
}
async function setup(behaviours: (i: number) => Behaviour = () => ({}), over: Partial<BenchmarkRunOptions> = {}) {
  const c = await managed();
  const regenerate = () => planBenchmark({ toolId: "memory-mcp", projectRoot: c.projectRoot, homeDir: c.homeDir, entries: seed, platform: "linux", includeUser: false });
  const first = await regenerate();
  if (!first.ok) throw new Error(first.code);
  const o = await requestBenchmarkApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (o.status !== "approved") throw new Error(o.status);
  const servers: FakeServer[] = [];
  const spawns: { exe: string; args: string[]; cwd: string; shell: boolean }[] = [];
  const spawner: HealthSpawner = (exe, args, opts) => {
    spawns.push({ exe, args: [...args], cwd: opts.cwd, shell: opts.shell });
    const s = new FakeServer(behaviours(servers.length + 1));
    servers.push(s);
    return s;
  };
  let t = 0;
  const tempBase = await mkdtemp(path.join(scratch, "tmp-"));
  // 가짜 tree kill: 실제 kill처럼 마지막 서버의 close를 일으킨다.
  const killTree = async () => (servers.at(-1)?.close(), true);
  const options: BenchmarkRunOptions = { regenerate, tempBase, spawner, killTree, clock: () => (t += 10), host: { arch: "x64", nodeVersion: "24.18.0" }, ...over };
  return { c, approval: o.approval, options, servers, spawns, tempBase, planDigest: first.planned.planDigest };
}

describe("REQ-061 Benchmark 실행과 Report v1", () => {
  it("AC-066-01 실행은 순차 6회이고 매 회 shell:false, argv는 Plan과 같으며 cmd 실행이 0이다", async () => {
    const s = await setup();
    const r = await runBenchmark(s.approval, s.options);
    if (!r.ok) throw new Error(r.code);
    expect(s.spawns).toHaveLength(6);
    for (const sp of s.spawns) expect(sp).toMatchObject({ exe: "npx", args: ["-y", MEMORY + "@1.2.3"], shell: false });
    expect(s.spawns.some((sp) => /^cmd(\.exe)?$/iu.test(sp.exe) || sp.exe.endsWith(".cmd"))).toBe(false);
    expect(r.report.runs.map((x) => x.phase)).toEqual(["warmup", "measured", "measured", "measured", "measured", "measured"]);
    // 승인 없이·재사용은 spawn 0
    const again = await runBenchmark(s.approval, s.options);
    expect(again).toMatchObject({ ok: false, code: "APPROVAL_CONSUMED" });
    expect(await runBenchmark(undefined, s.options)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(s.spawns).toHaveLength(6);
  });

  it("AC-066-02 회마다 initialize·notifications/initialized·tools/list만 보내고 tools/call은 0이다", async () => {
    const s = await setup();
    await runBenchmark(s.approval, s.options);
    for (const srv of s.servers) expect(srv.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("AC-066-03 회당 timeout은 이유와 함께 기록되고 Plan 전체 300초를 넘기면 남은 회차는 aborted다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const s = await setup((i) => (i === 2 ? { init: false } : {}));
    const pending = drive(runBenchmark(s.approval, s.options));
    const r = await pending;
    if (!r.ok) throw new Error(r.code);
    expect(r.report.runs[1]).toMatchObject({ status: "timeout", reason: "startup-timeout" });
    vi.useRealTimers();
    let t = 0;
    const slow = await setup(() => ({}), { clock: () => (t += 70_000) });
    const r2 = await runBenchmark(slow.approval, slow.options);
    if (!r2.ok) throw new Error(r2.code);
    expect(r2.report.runs.filter((x) => x.status === "aborted").every((x) => x.reason === "plan-total-timeout")).toBe(true);
    expect(r2.report.runs.some((x) => x.status === "aborted")).toBe(true);
    expect(slow.spawns.length).toBeLessThan(6);
  });

  it("AC-066-04 매 회 process tree를 정리하고 종료 실패면 termination-failed이며 이후 spawn이 없다", async () => {
    const s = await setup(() => ({ linger: true }), { killTree: async () => false });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const pending = drive(runBenchmark(s.approval, s.options));
    const r = await pending;
    if (!r.ok) throw new Error(r.code);
    expect(s.spawns).toHaveLength(1);
    expect(r.report.runs[0]).toMatchObject({ status: "termination-failed", terminated: false });
    expect(r.report.runs.slice(1).every((x) => x.status === "aborted" && x.reason === "previous-termination-failed")).toBe(true);
    const ok = await setup();
    const r2 = await runBenchmark(ok.approval, ok.options);
    if (!r2.ok) throw new Error(r2.code);
    expect(r2.report.runs.every((x) => x.terminated)).toBe(true);
  });

  it("AC-066-05 회마다 spawnMs·initializeMs·toolsListMs·readyMs·cleanupMs를 주입 시계로 기록한다", async () => {
    const s = await setup();
    const r = await runBenchmark(s.approval, s.options);
    if (!r.ok) throw new Error(r.code);
    for (const run of r.report.runs) {
      expect(run.status).toBe("succeeded");
      for (const k of ["spawnMs", "initializeMs", "toolsListMs", "readyMs", "cleanupMs"] as const) expect(run[k], k).toBeGreaterThan(0);
      expect(run.readyMs!).toBeGreaterThanOrEqual(run.spawnMs! + run.initializeMs!);
    }
  });

  it("AC-066-06 요약은 성공한 measured 회만의 median·min·max와 실패 수이고 백분위가 없으며 성공 0이면 null이다", async () => {
    const s = await setup();
    const r = await runBenchmark(s.approval, s.options);
    if (!r.ok) throw new Error(r.code);
    const ready = r.report.runs.filter((x) => x.phase === "measured").map((x) => x.readyMs!).sort((a, b) => a - b);
    expect(r.report.summary.readyMs).toEqual({ median: ready[2], min: ready[0], max: ready[4] });
    expect(r.report.summary).toMatchObject({ measured: 5, succeeded: 5, failed: 0 });
    expect(JSON.stringify(r.report.summary)).not.toMatch(/p95|p99|percentile/u);
    expect(benchmarkReportSchema.safeParse({ ...r.report, summary: { ...r.report.summary, p95: 1 } }).success).toBe(false);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const bad = await setup((i) => (i === 1 ? {} : { init: false }));
    const pending = drive(runBenchmark(bad.approval, bad.options));
    const r2 = await pending;
    if (!r2.ok) throw new Error(r2.code);
    expect(r2.report.runs[0]!.status).toBe("succeeded");
    expect(r2.report.summary).toMatchObject({ succeeded: 0, failed: 5, readyMs: null, initializeMs: null });
  });

  it("AC-066-07 environment는 허용 필드뿐이고 사용자명·경로·env 값·token이 없다", async () => {
    const s = await setup(() => ({ serverInfo: { name: "mem " + SECRET, version: "/home/alice/srv 1.2.3" }, stderr: "token=" + SECRET + " at C:\\Users\\alice\\x" }));
    const r = await runBenchmark(s.approval, s.options);
    if (!r.ok) throw new Error(r.code);
    expect(Object.keys(r.report.environment).sort()).toEqual(["arch", "backend", "nodeVersion", "os", "serverInfo", "toolVersion"]);
    expect(r.report.environment).toMatchObject({ os: "linux", arch: "x64", nodeVersion: "24.18.0", backend: "npx", toolVersion: "1.2.3" });
    const bytes = JSON.stringify(r.report) + formatBenchmarkReport(r.report).join("\n");
    for (const banned of [SECRET, "alice", s.tempBase, s.c.homeDir, s.c.projectRoot]) expect(bytes).not.toContain(banned);
  });

  it("AC-066-08 Report는 메모리 값이고 file·state·config 쓰기가 0이다", async () => {
    const s = await setup();
    const state = path.join(s.c.homeDir, ".openhub", "state", "lifecycle.json");
    const before = [await readFile(state), await readFile(path.join(s.c.projectRoot, ".mcp.json"))];
    const homeFiles = await readdir(s.c.homeDir, { recursive: true });
    await runBenchmark(s.approval, s.options);
    expect([await readFile(state), await readFile(path.join(s.c.projectRoot, ".mcp.json"))]).toEqual(before);
    expect(await readdir(s.c.homeDir, { recursive: true })).toEqual(homeFiles);
    const src = await readFile(path.join(import.meta.dirname, "../../src/benchmark/run.ts"), "utf8");
    expect(src).not.toMatch(/writeFile|appendFile|commitLifecycleState|atomicWrite/u);
  });

  it("AC-066-09 회마다 격리 임시 cwd를 쓰고 끝나면 지우며 benchmark 모듈은 process.env를 읽지 않는다", async () => {
    const s = await setup();
    await runBenchmark(s.approval, s.options);
    const cwds = new Set(s.spawns.map((x) => x.cwd));
    expect(cwds.size).toBe(6);
    for (const cwd of cwds) expect(path.dirname(cwd)).toBe(await import("node:fs/promises").then((m) => m.realpath(s.tempBase)));
    expect(await readdir(s.tempBase)).toEqual([]);
    for (const f of ["plan.ts", "run.ts"]) expect(await readFile(path.join(import.meta.dirname, "../../src/benchmark", f), "utf8"), f).not.toMatch(/process\.env[.[]/u);
  });

  it("AC-066-10 notes에 로컬 전용 고지가 있고 기기 간 순위 필드가 없으며 같은 fake 입력이면 같은 byte다", async () => {
    const a = await setup();
    const b = await setup();
    const ra = await runBenchmark(a.approval, a.options);
    const rb = await runBenchmark(b.approval, b.options);
    if (!ra.ok || !rb.ok) throw new Error("run");
    expect(ra.report.notes).toEqual([...BENCHMARK_REPORT_NOTES]);
    expect(ra.report.notes.join(" ")).toContain("not comparable across machines");
    expect(JSON.stringify(ra.report)).not.toMatch(/rank|percentile|score/iu);
    expect(JSON.stringify({ ...rb.report, planDigest: "" })).toBe(JSON.stringify({ ...ra.report, planDigest: "" }));
  });
});


