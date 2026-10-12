import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  executeRecovery,
  lifecycleStatus,
  planRecovery,
  readJournals,
  recordInstallInState,
  requestRecoveryApproval,
  runInstallTransaction,
  type InstallRequest,
  type RecoveryMode,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/**
 * v0.2.1 P0-3 실제 강제 종료(OPENHUB_E2E=1일 때만). 별도 node 프로세스가 Update(또는 승인된 Recovery)를 실행하다가 정해진 지점에 멈추면
 * 테스트가 그 프로세스 트리를 강제 종료한다(Windows taskkill /T /F, Linux 프로세스 그룹 SIGKILL). 그 뒤 새 실행(이 테스트 프로세스)이
 * Journal로 중단을 알아보고, 승인한 Recovery만 설정을 되돌린다. 남은 작업 잠금(죽은 pid)은 다음 작업이 회수한다.
 * 기본 테스트·CI는 프로세스를 띄우지 않는다(AC-031-09).
 */
const skip = process.env["OPENHUB_E2E"] !== "1";
const scratch = await newScratch("v021-journal-kill-e2e");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const seed = await seedEntries();
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const worker = path.join(import.meta.dirname, "fixtures", "update-worker.ts");
const TOOL = "github-mcp-server";

type Scope = "project" | "user";
interface Setup {
  h: Harness;
  scope: Scope;
  cursorFile: string;
  stateFile: string;
  original: string[];
  files: () => Promise<string[]>;
}

async function setup(scope: Scope, withMemory = false): Promise<Setup> {
  const h = await createHarness(scratch, { entries: seed });
  if (scope === "user") {
    await mkdir(path.join(h.homeDir, ".cursor"), { recursive: true });
    await writeFile(path.join(h.homeDir, ".cursor", "mcp.json"), '{\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n');
  }
  const install = async (toolId: string, targets: InstallRequest["targets"], includeHost: boolean) => {
    const req = h.request(toolId, targets, includeHost);
    const p = await plannedOf(h, req);
    const r = await runInstallTransaction(p, await approveAll(p), req, h.env);
    expect(r.status).toBe("succeeded");
    expect(await recordInstallInState(p, r, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
  };
  await install(TOOL, [{ client: "cursor", scope }], scope === "user");
  if (withMemory) await install("memory-mcp", [{ client: "claude-code", scope: "project" }], false);
  const cursorFile = scope === "project" ? path.join(h.projectRoot, ".cursor", "mcp.json") : path.join(h.homeDir, ".cursor", "mcp.json");
  const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
  const files = async () => [await readFile(cursorFile, "utf8"), await readFile(stateFile, "utf8")];
  return { h, scope, cursorFile, stateFile, original: await files(), files };
}

type WorkerCmd = { op?: "update" | "recover"; holdAt?: string; toolId?: string; client?: "cursor" | "claude-code" | "codex"; scope?: Scope };

function start(s: Setup, cmd: WorkerCmd) {
  const holdDirP = mkdtemp(path.join(s.h.base, "hold-"));
  return holdDirP.then((holdDir) => {
    const full = { toolId: TOOL, client: "cursor", scope: s.scope, ...cmd, base: s.h.base, projectRoot: s.h.projectRoot, homeDir: s.h.homeDir, holdDir };
    const child = spawn(process.execPath, [tsx, worker, JSON.stringify(full)], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.stderr.on("data", (d) => (err += d.toString()));
    let exited = false;
    const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null; result: { status: string; code: string | null } | null }>((resolve) =>
      child.on("close", (code, signal) => {
        exited = true;
        let result = null;
        try {
          result = JSON.parse(out.trim().split("\n").pop() ?? "");
        } catch {
          result = null;
        }
        resolve({ code, signal, result });
      }),
    );
    const marker = "in-" + (cmd.holdAt ?? "health");
    const reached = async () => {
      const until = Date.now() + 90_000;
      while (!existsSync(path.join(holdDir, marker))) {
        if (exited) throw new Error("worker exited before " + marker + ": " + err.slice(-400));
        if (Date.now() > until) throw new Error("worker did not reach " + marker + ": " + err.slice(-400));
        await new Promise((r) => setTimeout(r, 25));
      }
      await new Promise((r) => setTimeout(r, 200));
      expect(exited, "worker exited on its own: " + err.slice(-300)).toBe(false);
    };
    const kill = async () => {
      if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
      else process.kill(-child.pid!, "SIGKILL");
      const end = await closed;
      expect(end.signal === "SIGKILL" || (end.code !== 0 && end.code !== null)).toBe(true);
    };
    const release = async () => {
      await writeFile(path.join(holdDir, "release"), "");
      return closed;
    };
    const pause = (on: boolean) => {
      if (process.platform !== "win32") process.kill(-child.pid!, on ? "SIGSTOP" : "SIGCONT");
    };
    return { reached, kill, release, pause };
  });
}

const lockFile = (s: Setup) => path.join(s.h.homeDir, ".openhub", "state", "operation.lock");
const statesOf = async (s: Setup) => {
  const st = await lifecycleStatus({ projectRoot: s.h.projectRoot, homeDir: s.h.homeDir, entries: seed, platform: "linux", includeUser: s.scope === "user" });
  return st.ok ? st.items.filter((i) => i.toolId === TOOL).map((i) => i.state) : [st.code];
};
const phases = async (s: Setup) => {
  const r = await readJournals(s.h.homeDir);
  return r.ok ? r.journals.filter((j) => j.toolId === TOOL).map((j) => j.phase) : ["unreadable"];
};
const optsOf = (s: Setup, mode: RecoveryMode) => ({ toolId: TOOL, projectRoot: s.h.projectRoot, homeDir: s.h.homeDir, mode });
async function recover(s: Setup, mode: RecoveryMode) {
  const opts = optsOf(s, mode);
  const built = await planRecovery(opts);
  if (!built.ok) throw new Error(built.code);
  if (built.planned.plan.status !== "ready") return { status: "blocked", blockers: built.planned.plan.blockers.map((b) => b.code) };
  const o = await requestRecoveryApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (o.status !== "approved") throw new Error(o.status);
  return executeRecovery(o.approval, { ...opts, regenerate: () => planRecovery(opts) });
}

async function killUpdateAt(s: Setup, holdAt?: string) {
  const w = await start(s, holdAt === undefined ? {} : { holdAt });
  await w.reached();
  await w.kill();
  expect(existsSync(lockFile(s))).toBe(true); // 강제 종료로 남은 잠금(다음 작업이 회수한다)
  return s.files();
}

describe.skipIf(skip)("v0.2.1 P0-3 실제 강제 종료 후 Recovery", () => {
  for (const scope of ["project", "user"] as const) {
    it(scope + " 범위: Health 중 종료 → interrupted-update, 승인 전 쓰기 0, 승인 후 변경 전으로 복구, Journal 정리, 중복 요청 차단", async () => {
      const s = await setup(scope);
      const killed = await killUpdateAt(s);
      expect(killed[0]).not.toBe(s.original[0]);
      expect(killed[1]).toBe(s.original[1]);
      expect(await phases(s)).toEqual(["health"]);
      expect(await statesOf(s)).toEqual(["interrupted-update"]);
      const built = await planRecovery(optsOf(s, "undo"));
      expect(built.ok && built.planned.plan.approvalRequirements).toEqual(scope === "user" ? ["base", "user-scope-config"] : ["base"]);
      expect(await s.files()).toEqual(killed);
      expect(await recover(s, "undo")).toMatchObject({ status: "recovered" });
      expect(JSON.parse((await s.files())[0]!)).toEqual(JSON.parse(s.original[0]!));
      expect((await s.files())[1]).toBe(s.original[1]);
      expect(await statesOf(s)).toEqual(["state-consistent"]);
      expect(await phases(s)).toEqual([]);
      expect(existsSync(lockFile(s))).toBe(false);
      expect(await planRecovery(optsOf(s, "undo"))).toMatchObject({ ok: false, code: "NO_INTERRUPTED_OPERATION" });
    }, 180_000);
  }

  // 지점별: 종료 직후 디스크 상태와, 그 상태에서 맞는 복구 방법.
  const points: { at: string; configChanged: boolean; stateChanged: boolean; phase: string; undo: "recovered" | string; final: "original" | "committed" }[] = [
    { at: "config-replace", configChanged: false, stateChanged: false, phase: "config-applying", undo: "NOTHING_TO_UNDO", final: "original" },
    { at: "config-replaced", configChanged: true, stateChanged: false, phase: "config-applying", undo: "recovered", final: "original" },
    { at: "state-commit", configChanged: true, stateChanged: false, phase: "health", undo: "recovered", final: "original" },
    { at: "journal-cleanup", configChanged: true, stateChanged: true, phase: "state-commit", undo: "OPERATION_COMPLETED", final: "committed" },
  ];
  for (const p of points) {
    it("Update가 " + p.at + " 지점에서 강제 종료되면 " + (p.undo === "recovered" ? "undo로 변경 전 복구" : "undo는 " + p.undo + "로 막고 discard로 기록만 정리"), async () => {
      const s = await setup("project");
      const killed = await killUpdateAt(s, p.at);
      expect(killed[0] !== s.original[0]).toBe(p.configChanged);
      expect(killed[1] !== s.original[1]).toBe(p.stateChanged);
      expect(await phases(s)).toEqual([p.phase]);
      expect(await statesOf(s)).toEqual(["interrupted-update"]);
      const undo = await recover(s, "undo");
      if (p.undo === "recovered") expect(undo).toMatchObject({ status: "recovered" });
      else {
        expect(undo).toEqual({ status: "blocked", blockers: [p.undo] });
        expect(await s.files()).toEqual(killed);
        expect(await recover(s, "discard")).toMatchObject({ status: "discarded" });
      }
      const end = await s.files();
      if (p.final === "original") {
        expect(JSON.parse(end[0]!)).toEqual(JSON.parse(s.original[0]!));
        expect(end[1]).toBe(s.original[1]);
      } else expect(end).toEqual(killed);
      expect(await statesOf(s)).toEqual(["state-consistent"]);
      expect(await phases(s)).toEqual([]);
    }, 180_000);
  }

  it("승인된 Recovery가 설정을 바꾸기 직전 강제 종료되면 아무것도 바뀌지 않고, 다음 Recovery가 선점·잠금을 회수해 복구한다", async () => {
    const s = await setup("project");
    const killed = await killUpdateAt(s);
    const r = await start(s, { op: "recover", holdAt: "recover-write" });
    await r.reached();
    await r.kill();
    expect(await s.files()).toEqual(killed);
    expect(await statesOf(s)).toEqual(["interrupted-update"]);
    expect(await recover(s, "undo")).toMatchObject({ status: "recovered" });
    expect(JSON.parse((await s.files())[0]!)).toEqual(JSON.parse(s.original[0]!));
    expect(await statesOf(s)).toEqual(["state-consistent"]);
  }, 180_000);

  it("승인된 Recovery가 설정을 되돌린 뒤 Journal 정리 직전 강제 종료되면 undo는 할 일이 없고 discard로 기록만 지운다", async () => {
    const s = await setup("project");
    await killUpdateAt(s);
    const r = await start(s, { op: "recover", holdAt: "recover-cleanup" });
    await r.reached();
    await r.kill();
    expect(JSON.parse((await s.files())[0]!)).toEqual(JSON.parse(s.original[0]!));
    expect(await statesOf(s)).toEqual(["interrupted-update"]);
    expect(await recover(s, "undo")).toEqual({ status: "blocked", blockers: ["NOTHING_TO_UNDO"] });
    expect(await recover(s, "discard")).toMatchObject({ status: "discarded" });
    expect(await statesOf(s)).toEqual(["state-consistent"]);
    expect(await phases(s)).toEqual([]);
  }, 180_000);

  it("Recovery가 진행 중(잠금 보유, Linux는 SIGSTOP)이면 다른 install은 OPERATION_IN_PROGRESS이고, 끝나면 둘 다 반영된다", async () => {
    const s = await setup("project");
    const killed = await killUpdateAt(s);
    const r = await start(s, { op: "recover", holdAt: "recover-write" });
    await r.reached();
    r.pause(true);
    try {
      const req = s.h.request("memory-mcp", [{ client: "codex", scope: "project" }]);
      const p = await plannedOf(s.h, req);
      expect(await runInstallTransaction(p, await approveAll(p), req, s.h.env)).toMatchObject({ status: "failed", code: "OPERATION_IN_PROGRESS" });
      expect(await s.files()).toEqual(killed);
      expect(existsSync(path.join(s.h.projectRoot, ".codex", "config.toml"))).toBe(false);
    } finally {
      r.pause(false);
    }
    expect((await r.release()).result).toMatchObject({ status: "recovered" });
    const req = s.h.request("memory-mcp", [{ client: "codex", scope: "project" }]);
    const p = await plannedOf(s.h, req);
    expect((await runInstallTransaction(p, await approveAll(p), req, s.h.env)).status).toBe("succeeded");
    expect(JSON.parse((await s.files())[0]!)).toEqual(JSON.parse(s.original[0]!));
  }, 180_000);

  it("다른 도구의 Update가 Health 대기 중(잠금 보유)이면 승인된 Recovery는 OPERATION_IN_PROGRESS이고 아무것도 바꾸지 않으며, 끝난 뒤 복구된다", async () => {
    const s = await setup("project", true);
    const killed = await killUpdateAt(s);
    const u = await start(s, { toolId: "memory-mcp", client: "claude-code", scope: "project" });
    await u.reached();
    const opts = optsOf(s, "undo");
    const built = await planRecovery(opts);
    if (!built.ok) throw new Error(built.code);
    const o = await requestRecoveryApproval(built.planned, { channel: "cli-tty", confirm: async (x) => x.requirements.map((y) => y.id) });
    if (o.status !== "approved") throw new Error(o.status);
    expect(await executeRecovery(o.approval, { ...opts, regenerate: () => planRecovery(opts) })).toMatchObject({ status: "failed", error: { code: "OPERATION_IN_PROGRESS" } });
    expect((await s.files())[0]).toBe(killed[0]);
    expect(await phases(s)).toEqual(["health"]);
    expect((await u.release()).result).toMatchObject({ status: "updated" });
    expect(await recover(s, "undo")).toMatchObject({ status: "recovered" });
    expect(await statesOf(s)).toEqual(["state-consistent"]);
  }, 180_000);

  it("종료 뒤 사용자가 같은 항목을 바꿨으면 복구는 blocked이고 덮어쓰기 0", async () => {
    const s = await setup("project");
    await killUpdateAt(s);
    const external = '{ "mcpServers": { "github": { "command": "docker", "args": ["run", "-i", "--rm", "my-own-image"] } } }\n';
    await writeFile(s.cursorFile, external);
    const built = await planRecovery(optsOf(s, "undo"));
    expect(built.ok && built.planned.plan.status).toBe("blocked");
    expect(built.ok && built.planned.plan.blockers.map((b) => b.code)).toContain("EXTERNAL_CHANGE");
    expect(await readFile(s.cursorFile, "utf8")).toBe(external);
  }, 180_000);
});
