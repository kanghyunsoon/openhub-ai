import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTreeKiller,
  healthArgv,
  locateWindowsNpxLauncher,
  nodeExecSpawner,
  npmChildEnv,
  planLifecycle,
  recordInstallInState,
  requestLifecycleApproval,
  runHealthCheck,
  runInstallTransaction,
  verifyApprovedLifecyclePlan,
  type HealthStep,
  type InstallEnvironment,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

type McpTool = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
type McpCall = { name: string; arguments: Record<string, unknown> };
type McpReply = { error?: { message: string }; result?: { isError?: boolean; content?: { type: string; text?: string }[] } };

/**
 * 검증 전용 최소 MCP stdio client. initialize → tools/list → tools/call(순서대로)을 보내고 전체 출력을 돌려준다.
 * Health와 같은 argv(shell 없음)·process tree 종료를 쓴다. 제품 코드가 아니며 OPENHUB_E2E 테스트에서만 쓴다.
 */
async function mcpSession(argv: string[], cwd: string, calls: readonly McpCall[]): Promise<{ tools: McpTool[]; replies: McpReply[]; transcript: string }> {
  const windows = process.platform === "win32";
  const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: !windows });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  let buffer = "";
  let transcript = "";
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.on("data", (d: Buffer) => {
    transcript += d.toString();
    buffer += d.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line === "") continue;
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (typeof m["id"] === "number") waiters.get(m["id"])?.(m);
      } catch {
        // 로그 줄은 무시한다.
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => (transcript += d.toString()));
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error("timeout " + method)), 120_000);
      waiters.set(n, (m) => (clearTimeout(timer), resolve(m)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openhub-e2e", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = (await request("tools/list", {}))["result"] as { tools: McpTool[] };
    const replies: McpReply[] = [];
    for (const call of calls) replies.push((await request("tools/call", call)) as McpReply);
    return { tools: list.tools, replies, transcript };
  } finally {
    // npx → 실제 서버(손자 process)까지 끝낸다. 남으면 임시 디렉터리를 잡고 있게 된다.
    if (child.pid !== undefined) await createTreeKiller({ cwd: os.tmpdir() })(child.pid, windows ? "windows" : "linux");
    await closed;
  }
}

/** 일회용 MongoDB(docker, 127.0.0.1만, 합성 계정). 검증 전용이다. */
function docker(args: string[]): { status: number | null; stdout: string } {
  const r = spawnSync("docker", args, { encoding: "utf8", windowsHide: true, timeout: 300_000 });
  return { status: r.status, stdout: (r.stdout ?? "") + (r.stderr ?? "") };
}

/**
 * Registry sandbox install test(TASK-054, D-025 §9). registry-remote.yml의 sandbox job에서만 실행한다(OPENHUB_E2E=1).
 * CI runner 안에서 secret 없이 seed 도구(memory-mcp, npx)를 실제 설정에 적고 M5 Health(MCP handshake)를 실제로 실행한다.
 * 기본 테스트·PR CI에서는 skip이다.
 */
describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("REQ-051 Registry sandbox install", () => {
  it("AC-054-08 sandbox: memory-mcp를 설치 계획대로 적고 실제 npx로 Health handshake를 통과한다", async () => {
    const seed = await seedEntries();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-sandbox-"));
    try {
      const h = await createHarness(scratch, { entries: seed });
      const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
      const planned = await plannedOf(h, request);
      const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
      expect(result.status).toBe("succeeded");
      expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
      const regen = () => planLifecycle({ operation: "health", toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false });
      const first = await regen();
      if (!first.ok) throw new Error(first.code);
      const outcome = await requestLifecycleApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (outcome.status !== "approved") throw new Error(outcome.status);
      const gate = await verifyApprovedLifecyclePlan(outcome.approval, regen);
      if (!gate.ok) throw new Error(gate.code);
      const health = await runHealthCheck(gate.verified, { healthCheckType: "mcp-handshake", tempBase: os.tmpdir() });
      expect(health).toMatchObject({ ok: true, result: { status: "healthy" } });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 600_000);

  /**
   * v0.2.0 P0-2: mongodb-mcp-server(정확한 버전 → npx Prepare). 실제 Registry Manifest로 설치하고(임시 npm cache),
   * 승인된 Health를 실행한 뒤, 같은 argv로 합성 계정의 일회용 MongoDB에 접속해
   * - 노출 도구가 모두 readOnlyHint이고 쓰기 도구가 없으며,
   * - 쓰기 도구 호출은 "not found", $out·$merge 집계는 readOnly 오류로 거부되고, 읽기(find·count·explain)는 동작하며,
   * - 데이터·컬렉션·인덱스가 그대로이고, 합성 비밀번호·사용자 이름이 설정·출력·Result·서버 로그 어디에도 없음을 확인한다.
   * Health와 MCP session은 OS 환경을 상속하므로 이 테스트만 MDB_MCP_CONNECTION_STRING·npm_config_cache를 잠시 바꿨다가 되돌린다.
   */
  it("P0-2 sandbox: mongodb-mcp-server를 npx Prepare로 설치하고 Health·read-only 거부·자격증명 비노출을 실제로 확인한다", async () => {
    const platform = process.platform === "win32" ? "windows" : "linux";
    const USER = ["openhub", "e2e", "mongo"].join("_");
    const PASSWORD = ["OpenHub", "E2E", "fake", "pw", "5521"].join("-");
    const PORT = String(27100 + Math.floor(Math.random() * 800));
    const container = "openhub-e2e-mongo-" + String(process.pid);
    const seed = await seedEntries();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-sandbox-"));
    const npmCache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
    const logDir = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-mongo-logs-"));
    const saved = { conn: process.env["MDB_MCP_CONNECTION_STRING"], cache: process.env["npm_config_cache"], log: process.env["MDB_MCP_LOG_PATH"] };
    const mongosh = (js: string) => docker(["exec", container, "mongosh", "--quiet", "-u", USER, "-p", PASSWORD, "--authenticationDatabase", "admin", "--eval", js]);
    try {
      const started = docker(["run", "-d", "--rm", "--name", container, "-p", "127.0.0.1:" + PORT + ":27017", "-e", "MONGO_INITDB_ROOT_USERNAME=" + USER, "-e", "MONGO_INITDB_ROOT_PASSWORD=" + PASSWORD, "mongo:8.0"]);
      expect(started.status, started.stdout).toBe(0);
      let ready = false;
      for (let i = 0; i < 60 && !ready; i++) {
        ready = mongosh("db.runCommand({ ping: 1 }).ok").stdout.trim().endsWith("1");
        if (!ready) await new Promise((r) => setTimeout(r, 1000));
      }
      expect(ready).toBe(true);
      expect(mongosh("db.getSiblingDB('verifydb').items.insertMany([{n:1},{n:2},{n:3}]); db.getSiblingDB('verifydb').items.createIndex({n:1}); 'ok'").status).toBe(0);
      const snapshot = () => mongosh("JSON.stringify({ count: db.getSiblingDB('verifydb').items.countDocuments(), changed: db.getSiblingDB('verifydb').items.countDocuments({ changed: true }), cols: db.getSiblingDB('verifydb').getCollectionNames().sort(), idx: db.getSiblingDB('verifydb').items.getIndexes().length })").stdout.trim();
      const before = snapshot();
      expect(JSON.parse(before)).toEqual({ count: 3, changed: 0, cols: ["items"], idx: 2 });

      process.env["npm_config_cache"] = npmCache;
      // 서버 로그를 사용자 home 대신 임시 디렉터리에 쓴다(아래에서 자격증명 검사 대상).
      process.env["MDB_MCP_LOG_PATH"] = logDir;
      process.env["MDB_MCP_CONNECTION_STRING"] = "mongodb://" + USER + ":" + PASSWORD + "@127.0.0.1:" + PORT + "/?authSource=admin";
      const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
      const h = await createHarness(scratch, { entries: seed });
      const { spawner: _fake, ...rest } = h.env;
      const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const request = { ...h.request("mongodb-mcp-server", (["claude-code", "cursor", "codex"] as const).map((client) => ({ client, scope: "project" as const }))), platform } as const;
      const planned = await plannedOf({ ...h, env }, request);
      expect(planned.plan.steps[0]).toMatchObject({ id: "npx-prepare", args: ["--yes", "--package=mongodb-mcp-server@3.0.5", "--", "node", "--version"] });
      const t0 = Date.now();
      const result = await runInstallTransaction(planned, await approveAll(planned), request, env);
      console.log("mongodb prepare+install ms " + String(Date.now() - t0) + " " + JSON.stringify(result.steps.map((s) => ({ id: s.id, status: s.status }))));
      expect(result.status).toBe("succeeded");
      expect(result.verification?.prepared).toBe("cached");
      for (const file of [".mcp.json", ".cursor/mcp.json", ".codex/config.toml"]) {
        const written = await readFile(path.join(h.projectRoot, file), "utf8");
        for (const flag of ["mongodb-mcp-server@3.0.5", "--readOnly", "--telemetry", "disabled", "MDB_MCP_CONNECTION_STRING"]) expect(written, file).toContain(flag);
        expect(written, file).not.toContain(PASSWORD);
        expect(written, file).not.toContain(USER);
      }
      expect(JSON.stringify(result)).not.toContain(PASSWORD);
      expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });

      const regen = () => planLifecycle({ operation: "health", toolId: "mongodb-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform, includeUser: false });
      const first = await regen();
      if (!first.ok) throw new Error(first.code);
      const outcome = await requestLifecycleApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (outcome.status !== "approved") throw new Error(outcome.status);
      const gate = await verifyApprovedLifecyclePlan(outcome.approval, regen);
      if (!gate.ok) throw new Error(gate.code);
      const t1 = Date.now();
      const health = await runHealthCheck(gate.verified, { healthCheckType: "mcp-handshake", tempBase: os.tmpdir(), windowsNpx });
      console.log("mongodb health ms " + String(Date.now() - t1) + " " + JSON.stringify(health.ok ? { status: health.result.status, toolCount: health.result.toolCount } : health));
      expect(health).toMatchObject({ ok: true, result: { status: "healthy" } });
      expect(JSON.stringify(health)).not.toContain(PASSWORD);

      const step = gate.verified.plan.steps.find((s): s is HealthStep => s.kind === "health")!;
      const argv = healthArgv(step, platform, windowsNpx);
      if (argv === null) throw new Error("launcher-not-found");
      const C = { connectionId: "preconfigured" };
      const D = { ...C, database: "verifydb", collection: "items" };
      const writes: McpCall[] = [
        { name: "insert-many", arguments: { ...D, documents: [{ n: 99 }] } },
        { name: "update-many", arguments: { ...D, filter: {}, update: { $set: { changed: true } } } },
        { name: "delete-many", arguments: { ...D, filter: {} } },
        { name: "drop-collection", arguments: D },
        { name: "drop-database", arguments: { ...C, database: "verifydb" } },
        { name: "create-index", arguments: { ...D, keys: { m: 1 } } },
        { name: "create-collection", arguments: { ...C, database: "verifydb", collection: "created" } },
        { name: "rename-collection", arguments: { ...D, newName: "renamed" } },
      ];
      const pipelines: McpCall[] = [
        { name: "aggregate", arguments: { ...D, pipeline: [{ $out: "out1" }] } },
        { name: "aggregate", arguments: { ...D, pipeline: [{ $merge: { into: "out2" } }] } },
        { name: "aggregate-db", arguments: { ...C, database: "verifydb", pipeline: [{ $documents: [{ x: 1 }] }, { $out: "out3" }] } },
      ];
      const reads: McpCall[] = [
        { name: "find", arguments: { ...D, filter: {} } },
        { name: "count", arguments: D },
        { name: "explain", arguments: { ...D, method: [{ name: "find", arguments: { filter: {} } }] } },
      ];
      const session = await mcpSession(argv, scratch, [...writes, ...pipelines, ...reads]);
      const names = session.tools.map((t) => t.name).sort();
      console.log("mongodb tools: " + names.join(","));
      expect(names.length).toBe(20);
      for (const t of session.tools) {
        expect(t.annotations?.readOnlyHint, t.name).toBe(true);
        expect(t.annotations?.destructiveHint ?? false, t.name).toBe(false);
      }
      for (const wr of writes) expect(names).not.toContain(wr.name);
      const replies = session.replies;
      writes.forEach((wr, i) => expect(replies[i]?.error?.message ?? "", wr.name).toMatch(/not found/u));
      pipelines.forEach((p, i) => {
        const reply = replies[writes.length + i]!;
        expect(reply.result?.isError, p.name).toBe(true);
        expect(JSON.stringify(reply.result), p.name).toMatch(/readOnly mode/u);
      });
      reads.forEach((rd, i) => expect(replies[writes.length + pipelines.length + i]?.result?.isError ?? false, rd.name).toBe(false));
      expect(JSON.stringify(replies[writes.length + pipelines.length + 1]?.result)).toContain("Found 3 documents");
      expect(snapshot()).toBe(before);
      expect(session.transcript).not.toContain(PASSWORD);
      expect(JSON.stringify(replies)).not.toContain(PASSWORD);
      const logs = (await readdir(logDir, { recursive: true })) as string[];
      console.log("mongodb server log files: " + String(logs.length));
      for (const f of logs) {
        const body = await readFile(path.join(logDir, f), "utf8").catch(() => "");
        expect(body, f).not.toContain(PASSWORD);
      }
    } finally {
      if (saved.conn === undefined) delete process.env["MDB_MCP_CONNECTION_STRING"];
      else process.env["MDB_MCP_CONNECTION_STRING"] = saved.conn;
      if (saved.cache === undefined) delete process.env["npm_config_cache"];
      else process.env["npm_config_cache"] = saved.cache;
      if (saved.log === undefined) delete process.env["MDB_MCP_LOG_PATH"];
      else process.env["MDB_MCP_LOG_PATH"] = saved.log;
      docker(["rm", "-f", container]);
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
      await rm(logDir, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 900_000);
});

