import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  createTreeKiller,
  isVerifiedPlan,
  locateWindowsNpxLauncher,
  nodeHealthSpawner,
  planLifecycle,
  recordInstallInState,
  requestLifecycleApproval,
  runHealthCheck,
  runInstallTransaction,
  verifyApprovedLifecyclePlan,
  type ExecSpawner,
  type HealthChild,
  type HealthRunOptions,
  type HealthSpawnOptions,
  type InstallRequest,
  type LifecyclePlanOptions,
  type VerifiedLifecyclePlan,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/** TASK-041 MCP Health Check. 가짜 MCP 서버(child)와 실제 node 프로세스 1개로 handshake·종료를 확인한다. */
const seed = await seedEntries();
const scratch = await newScratch("health-test");
const tempBase = await mkdtemp(path.join(scratch, "tmp-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.useRealTimers());
const NOW = () => new Date("2026-10-07T01:02:03.000Z");
const DIGEST = "sha256:" + "e".repeat(64);
const HOST = process.platform === "win32" ? "windows" : process.platform === "darwin" ? "macos" : "linux";

function registry() {
  return vi.fn(async (url: string) => {
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: "1.2.3" });
    if (url === "https://pypi.org/pypi/postgres-mcp/json") return json({ info: { name: "postgres-mcp", version: "0.3.0" } });
    if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
    if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
    return new Response("missing", { status: 404 });
  });
}
async function installed(h: Harness, toolId: string, platform: "linux" | "windows" | "macos" = "linux") {
  const request: InstallRequest = { ...h.request(toolId, [{ client: "claude-code", scope: "project" }]), platform };
  const planned = await plannedOf(h, request);
  const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
  expect(result.status).toBe("succeeded");
  await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: NOW });
}
async function verifiedFor(toolId: string, operation: "health" | "update" = "health", platform: "linux" | "windows" | "macos" = "linux", over: Partial<LifecyclePlanOptions> = {}): Promise<VerifiedLifecyclePlan> {
  const h = await createHarness(scratch, { entries: seed });
  await installed(h, toolId, platform);
  const regen = () => planLifecycle({ operation, toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform, includeUser: false, fetch: registry(), ...over });
  const first = await regen();
  if (!first.ok) throw new Error(first.code);
  const outcome = await requestLifecycleApproval(first.planned, { channel: "cli-tty", confirm: async (req) => req.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  const gate = await verifyApprovedLifecyclePlan(outcome.approval, regen);
  if (!gate.ok) throw new Error(gate.code);
  return gate.verified;
}

type Reply = "ok" | "error" | "bad" | "none";
interface Script {
  init?: Reply;
  tools?: Reply;
  exitEarly?: string;
  linger?: boolean;
  flood?: boolean;
}
class FakeChild extends EventEmitter implements HealthChild {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  readonly sent: Record<string, unknown>[] = [];
  ended = false;
  #closed = false;
  constructor(private readonly script: Script) {
    super();
    if (script.exitEarly !== undefined) {
      queueMicrotask(() => {
        this.stderr.emit("data", Buffer.from(script.exitEarly!));
        this.close(1);
      });
    }
  }
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const msg = JSON.parse(line) as Record<string, unknown>;
        this.sent.push(msg);
        queueMicrotask(() => this.react(msg));
      }
      return true;
    },
    end: () => {
      this.ended = true;
      if (this.script.linger !== true) this.close(0);
    },
    on: () => undefined,
  };
  out(o: unknown) {
    this.stdout.emit("data", Buffer.from(JSON.stringify(o) + "\n"));
  }
  react(msg: Record<string, unknown>) {
    if (this.#closed) return;
    const reply = msg["method"] === "initialize" ? (this.script.init ?? "ok") : msg["method"] === "tools/list" ? (this.script.tools ?? "ok") : undefined;
    if (reply === undefined || reply === "none") return;
    if (msg["method"] === "initialize" && this.script.flood === true) {
      for (let i = 0; i < 20; i += 1) this.stdout.emit("data", Buffer.alloc(64 * 1024, 120));
      return;
    }
    if (reply === "bad") return void this.stdout.emit("data", Buffer.from("this is not json\n"));
    if (reply === "error") return this.out({ jsonrpc: "2.0", id: msg["id"], error: { code: -32603, message: "boom" } });
    this.out({ jsonrpc: "2.0", id: msg["id"], result: msg["method"] === "initialize" ? { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake", version: "1" } } : { tools: [{ name: "a" }, { name: "b" }] } });
  }
  close(code: number | null) {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", code, code === null ? "SIGKILL" : null));
  }
}
function fake(script: Script = {}, killResult = true) {
  const spawns: string[][] = [];
  const options: HealthSpawnOptions[] = [];
  const children: FakeChild[] = [];
  const kills: [number, string][] = [];
  const spawner = (exe: string, args: readonly string[], opts: HealthSpawnOptions) => {
    spawns.push([exe, ...args]);
    options.push(opts);
    const child = new FakeChild(script);
    children.push(child);
    return child;
  };
  const killTree = async (pid: number, platform: string) => {
    kills.push([pid, platform]);
    if (killResult) children.at(-1)?.close(null);
    return killResult;
  };
  const run = (verified: VerifiedLifecyclePlan, over: Partial<HealthRunOptions> = {}) => runHealthCheck(verified, { healthCheckType: "mcp-handshake", spawner, killTree, tempBase, ...over });
  return { spawns, options, children, kills, run };
}
const healthOf = async (r: Awaited<ReturnType<typeof runHealthCheck>>) => {
  if (!r.ok) throw new Error(r.code);
  return r.result;
};
const spawned = async (spawns: unknown[]) => {
  for (let i = 0; i < 20_000 && spawns.length === 0; i += 1) await new Promise((res) => setImmediate(res));
  expect(spawns.length).toBe(1);
};

describe("REQ-044 MCP Health Check", () => {
  it("AC-041-01 backend·OS별 argv가 정확하고 모두 shell:false이며 cmd·cmd.exe·.cmd 실행이 0건이다", async () => {
    const all: string[][] = [];
    const posix = fake();
    await posix.run(await verifiedFor("memory-mcp"));
    expect(posix.spawns[0]).toEqual(["npx", "-y", "@modelcontextprotocol/server-memory"]);
    expect(posix.options[0]).toMatchObject({ shell: false, detached: true, stdio: ["pipe", "pipe", "pipe"] });

    const launcher = { node: "C:\\nodejs\\node.exe", npxCli: "C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" };
    const win = fake();
    const winPlan = await verifiedFor("memory-mcp", "health", "windows");
    expect(winPlan.plan.target.clientSpec.command).toBe("cmd");
    await win.run(winPlan, { windowsNpx: launcher });
    expect(win.spawns[0]).toEqual([launcher.node, launcher.npxCli, "-y", "@modelcontextprotocol/server-memory"]);
    expect(win.options[0]).toMatchObject({ shell: false, detached: false });
    const missing = fake();
    expect(await healthOf(await missing.run(await verifiedFor("memory-mcp", "health", "windows")))).toMatchObject({ status: "launch-failed", reason: "launcher-not-found" });
    expect(missing.spawns).toEqual([]);

    const uvx = fake();
    await uvx.run(await verifiedFor("postgres-mcp"));
    expect(uvx.spawns[0]).toEqual(["uvx", "postgres-mcp", "--access-mode=restricted"]);
    const docker = fake();
    await docker.run(await verifiedFor("github-mcp-server", "update"));
    expect(docker.spawns[0]).toEqual(["docker", "run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server@" + DIGEST]);
    all.push(...posix.spawns, ...win.spawns, ...uvx.spawns, ...docker.spawns);
    for (const argv of all) expect(argv[0]!.toLowerCase()).not.toMatch(/(^|[\\/])cmd(\.exe)?$|\.cmd$|\.bat$|\.ps1$/u);
    expect(all.flat()).not.toContain("/c");

    // npx shim 옆 node.exe와 npm npx-cli.js를 찾는다(실행 없음). 하나라도 없으면 null이다.
    const files = new Set(["C:\\nodejs\\npx.cmd", "C:\\nodejs\\node.exe", "C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js"]);
    const fs = { stat: async (f: string) => (files.has(f) ? { isFile: () => true, size: 1 } : Promise.reject(new Error("ENOENT"))), readFile: async () => "" };
    expect(await locateWindowsNpxLauncher({ pathEnv: "C:\\Windows\\System32;relative\\dir;C:\\nodejs", fs })).toEqual(launcher);
    files.delete("C:\\nodejs\\node.exe");
    expect(await locateWindowsNpxLauncher({ pathEnv: "C:\\nodejs", fs })).toBeNull();
  });

  it("AC-041-02 initialize·tools/list에 정상 응답하면 healthy이고 toolCount가 기록된다", async () => {
    const f = fake();
    const result = await healthOf(await f.run(await verifiedFor("memory-mcp")));
    expect(result).toEqual({ status: "healthy", reason: null, toolCount: 2, environmentUnverified: false, terminated: true, excerpt: null });
    expect(f.children[0]!.sent.map((m) => m["method"])).toEqual(["initialize", "notifications/initialized", "tools/list"]);
    expect(f.children[0]!.ended).toBe(true);
    expect(f.kills).toEqual([]);
  });

  it("AC-041-03 startup·handshake 시간 안에 응답이 없으면 timeout이고 process tree kill이 호출된다", async () => {
    const verified = await verifiedFor("memory-mcp");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const silent = fake({ init: "none" });
    const pending = silent.run(verified);
    await spawned(silent.spawns);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(silent.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(await healthOf(await pending)).toMatchObject({ status: "timeout", reason: "startup-timeout", terminated: true });
    expect(silent.kills).toEqual([[4242, "linux"]]);

    const slowTools = fake({ tools: "none" });
    const pending2 = slowTools.run(await (async () => {
      vi.useRealTimers();
      const v = await verifiedFor("memory-mcp");
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      return v;
    })());
    await spawned(slowTools.spawns);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await healthOf(await pending2)).toMatchObject({ status: "timeout", reason: "handshake-timeout" });
    expect(slowTools.kills).toHaveLength(1);
  });

  it("AC-041-04 initialize 전에 프로세스가 끝나면 launch-failed이고 redact한 1KB 이하 출력이 남는다", async () => {
    const noisy = "x".repeat(3000) + "\nerror: cannot open /home/alice/.config/secret.json\ntoken ghp_" + "A".repeat(36) + "\nfatal: missing module\n";
    const f = fake({ exitEarly: noisy });
    const result = await healthOf(await f.run(await verifiedFor("memory-mcp")));
    expect(result).toMatchObject({ status: "launch-failed", reason: "process-exited", terminated: true });
    expect(Buffer.byteLength(result.excerpt ?? "")).toBeLessThanOrEqual(1024);
    expect(result.excerpt).toContain("fatal: missing module");
    expect(result.excerpt).not.toContain("/home/alice");
    expect(result.excerpt).not.toContain("ghp_" + "A".repeat(36));
    const enoent = fake();
    const throwing = (() => {
      throw Object.assign(new Error("spawn npx ENOENT"), { code: "ENOENT" });
    }) as never;
    expect(await healthOf(await enoent.run(await verifiedFor("memory-mcp"), { spawner: throwing }))).toMatchObject({ status: "launch-failed", reason: "spawn-failed" });
  });

  it("AC-041-05 JSON-RPC 형식 오류는 handshake-failed, tools/list 오류 응답은 unhealthy다", async () => {
    expect(await healthOf(await fake({ init: "bad" }).run(await verifiedFor("memory-mcp")))).toMatchObject({ status: "handshake-failed", reason: "invalid-message" });
    expect(await healthOf(await fake({ init: "error" }).run(await verifiedFor("memory-mcp")))).toMatchObject({ status: "handshake-failed", reason: "initialize-error" });
    expect(await healthOf(await fake({ tools: "bad" }).run(await verifiedFor("memory-mcp")))).toMatchObject({ status: "handshake-failed", reason: "invalid-message" });
    expect(await healthOf(await fake({ tools: "error" }).run(await verifiedFor("memory-mcp")))).toMatchObject({ status: "unhealthy", reason: "tools-list-error", toolCount: null });
  });

  it("AC-041-06 출력이 1MB를 넘으면 kill하고 handshake-failed(output-limit)다", async () => {
    const f = fake({ flood: true });
    expect(await healthOf(await f.run(await verifiedFor("memory-mcp")))).toMatchObject({ status: "handshake-failed", reason: "output-limit", terminated: true });
    expect(f.kills).toHaveLength(1);
  });

  it("AC-041-07 tree kill: Windows taskkill.exe /T /F /PID, POSIX process group이며 실제 실행 후 남은 child가 0개다", async () => {
    const calls: [string, readonly string[], boolean][] = [];
    const taskkill = (code: number): ExecSpawner =>
      (exe, args, opts) => {
        calls.push([exe, args, opts.shell]);
        const child = new EventEmitter() as EventEmitter & { stdout: null; stderr: null; kill: () => boolean };
        Object.assign(child, { stdout: null, stderr: null, kill: () => true });
        queueMicrotask(() => child.emit("close", code, null));
        return child as never;
      };
    expect(await createTreeKiller({ spawner: taskkill(0), cwd: tempBase })(4321, "windows")).toBe(true);
    expect(await createTreeKiller({ spawner: taskkill(128), cwd: tempBase })(4321, "windows")).toBe(true);
    expect(await createTreeKiller({ spawner: taskkill(1), cwd: tempBase })(4321, "windows")).toBe(false);
    expect(calls[0]).toEqual(["taskkill.exe", ["/T", "/F", "/PID", "4321"], false]);
    const groups: [number, string][] = [];
    expect(await createTreeKiller({ killGroup: (p, s) => void groups.push([p, s]), cwd: tempBase })(4321, "linux")).toBe(true);
    expect(groups).toEqual([[-4321, "SIGKILL"]]);
    const esrch = createTreeKiller({ killGroup: () => { throw Object.assign(new Error("gone"), { code: "ESRCH" }); }, cwd: tempBase });
    const eperm = createTreeKiller({ killGroup: () => { throw Object.assign(new Error("denied"), { code: "EPERM" }); }, cwd: tempBase });
    expect([await esrch(1, "macos"), await eperm(1, "macos")]).toEqual([true, false]);

    // 종료 실패는 Health 실패다(healthy여도 unhealthy·termination-failed).
    const stuck = fake({ linger: true }, false);
    expect(await healthOf(await stuck.run(await verifiedFor("memory-mcp")))).toMatchObject({ status: "unhealthy", reason: "termination-failed", terminated: false, toolCount: 2 });

    // 실제 node 프로세스: stdin을 닫아도 끝나지 않고 손자 프로세스를 띄운 가짜 MCP 서버를 실제 tree kill로 정리한다.
    const script = path.join(scratch, "fake-mcp-server.cjs");
    const pidFile = path.join(scratch, "grandchild.pid");
    await writeFile(
      script,
      [
        'const { spawn } = require("node:child_process");',
        'const grand = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
        "const out = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
        "let buf = '';",
        "process.stdin.on('data', (d) => {",
        "  buf += d;",
        "  for (let i = buf.indexOf('\\n'); i !== -1; i = buf.indexOf('\\n')) {",
        "    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);",
        "    if (m.method === 'initialize') out({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'fake', version: '1' } } });",
        "    if (m.method === 'tools/list') { require('node:fs').writeFileSync(" + JSON.stringify(pidFile) + ", String(grand.pid)); out({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 't1' }] } }); }",
        "  }",
        "});",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
    const realSpawner = (_exe: string, _args: readonly string[], opts: HealthSpawnOptions) => nodeHealthSpawner(process.execPath, [script], opts);
    const verified = await verifiedFor("postgres-mcp", "health", HOST);
    const real = await healthOf(await runHealthCheck(verified, { healthCheckType: "mcp-handshake", spawner: realSpawner, tempBase: os.tmpdir() }));
    expect(real).toMatchObject({ status: "healthy", toolCount: 1, terminated: true, environmentUnverified: true });
    const grandPid = Number(await readFile(pidFile, "utf8"));
    const alive = () => {
      try {
        process.kill(grandPid, 0);
        return true;
      } catch {
        return false;
      }
    };
    for (let i = 0; i < 50 && alive(); i += 1) await new Promise((res) => setTimeout(res, 100));
    expect(alive()).toBe(false);
  }, 30_000);

  it("AC-041-08 spawn 옵션에 env key가 없고 Health 중 process.env 접근이 0회이며 required env면 environmentUnverified다", async () => {
    const verified = await verifiedFor("postgres-mcp");
    const f = fake();
    const original = process.env;
    const touched: PropertyKey[] = [];
    process.env = new Proxy(original, {
      get: (t, k) => (touched.push(k), Reflect.get(t, k)),
      has: (t, k) => (touched.push(k), Reflect.has(t, k)),
      ownKeys: (t) => (touched.push("ownKeys"), Reflect.ownKeys(t)),
    });
    let result;
    try {
      result = await healthOf(await f.run(verified));
    } finally {
      process.env = original;
    }
    expect(touched).toEqual([]);
    expect(Object.keys(f.options[0]!)).not.toContain("env");
    expect(result).toMatchObject({ status: "healthy", environmentUnverified: true });
    expect((await healthOf(await fake().run(await verifiedFor("memory-mcp")))).environmentUnverified).toBe(false);
  });

  it("AC-041-09 cwd는 OpenHub가 만든 격리 임시 디렉터리이고 healthCheck가 mcp-handshake가 아니면 unsupported·spawn 0회다", async () => {
    const f = fake();
    const base = await mkdtemp(path.join(scratch, "iso-"));
    await f.run(await verifiedFor("memory-mcp"), { tempBase: base });
    const cwd = f.options[0]!.cwd;
    expect(path.basename(cwd)).toMatch(/^openhub-health-/u);
    expect(path.dirname(cwd)).toBe(await realpath(base));
    expect(await readdir(base)).toEqual([]);
    const unsupported = fake();
    for (const type of ["process", "http", "command", undefined]) {
      expect(await healthOf(await unsupported.run(await verifiedFor("memory-mcp"), { healthCheckType: type }))).toMatchObject({ status: "unsupported", reason: "unsupported-health-check" });
    }
    expect(unsupported.spawns).toEqual([]);
  });

  it("AC-041-10 health 단계를 포함한 VerifiedPlan 없이 실행하면 APPROVAL_REQUIRED이고 spawn 0회다", async () => {
    const f = fake();
    const verified = await verifiedFor("memory-mcp");
    const forged = { plan: verified.plan, planDigest: verified.planDigest, acknowledgements: verified.acknowledgements, channel: "cli-tty" } as VerifiedLifecyclePlan;
    expect(await f.run(forged)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const skipped = await verifiedFor("postgres-mcp", "update", "linux", { skipHealth: true });
    expect(skipped.plan.steps.some((s) => s.kind === "health")).toBe(false);
    expect(await f.run(skipped)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const h = await createHarness(scratch, { entries: seed });
    const install = await plannedOf(h, h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]));
    const { verifyApprovedPlan } = await import("../../src/index");
    const gate = await verifyApprovedPlan(await approveAll(install), () => install);
    if (!gate.ok) throw new Error(gate.code);
    expect(isVerifiedPlan(gate.verified)).toBe(true);
    expect(await f.run(gate.verified as never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(f.spawns).toEqual([]);
    expect((await f.run(verified)).ok).toBe(true);
    expect(await f.run(verified)).toMatchObject({ ok: false, code: "VERIFIED_PLAN_CONSUMED" });
    expect(f.spawns).toHaveLength(1);
  });
});

