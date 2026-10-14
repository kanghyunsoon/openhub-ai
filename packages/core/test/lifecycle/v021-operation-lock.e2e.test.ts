import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readLifecycleState, recordInstallInState, runInstallTransaction, type InstallRequest } from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedWithNpxFixture } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/**
 * v0.2.1 B 작업 잠금(OPENHUB_E2E=1일 때만): 별도 node 프로세스가 같은 project·home에서 동시에 작업한다.
 * CLI와 Desktop은 같은 Core 진입점(runInstallTransaction·runLifecycleTransaction)을 쓰므로, 두 독립 프로세스가 그 진입점을 부르는
 * 이 테스트가 CLI·Desktop 동시 실행 조건이다(실제 Electron 창은 띄우지 않는다). 기본 테스트·CI는 프로세스를 띄우지 않는다(AC-031-09).
 */
const skip = process.env["OPENHUB_E2E"] !== "1";
const scratch = await newScratch("v021-operation-lock-e2e");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const seed = await seedWithNpxFixture();
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const worker = path.join(import.meta.dirname, "fixtures", "op-worker.ts");

interface Dirs {
  base: string;
  projectRoot: string;
  homeDir: string;
}
type Op = { op: "install" | "update" | "health"; toolId: string; client: "claude-code" | "cursor" | "codex"; holdDir?: string };

function run(dirs: Dirs, op: Op) {
  const child = spawn(process.execPath, [tsx, worker, JSON.stringify({ ...dirs, ...op })], { detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout.on("data", (d) => (out += d.toString()));
  child.stderr.on("data", (d) => (err += d.toString()));
  const done = new Promise<{ status: string; code: string | null; exit: number | null; stderr: string }>((resolve) =>
    child.on("close", (exit) => {
      const line = out.trim().split("\n").pop() ?? "";
      let parsed: { status: string; code: string | null } = { status: "no-output", code: null };
      try {
        parsed = JSON.parse(line);
      } catch {
        // 강제 종료 등
      }
      resolve({ ...parsed, exit, stderr: err.slice(-400) });
    }),
  );
  return { child, done };
}

function killTree(pid: number) {
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" });
  else process.kill(-pid, "SIGKILL");
}

async function waitFor(file: string, ms = 90_000) {
  const until = Date.now() + ms;
  while (!existsSync(file)) {
    if (Date.now() > until) throw new Error("timeout waiting for " + path.basename(file));
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** fixture-npx-mcp(테스트 전용 npx fixture)를 Claude Code·Cursor 프로젝트에, postgres-mcp를 Claude Code 프로젝트에 설치·기록한 상태. */
async function setup(): Promise<{ dirs: Dirs; files: () => Promise<{ claude: string; cursor: string; state: string }> }> {
  const h = await createHarness(scratch, { entries: seed });
  const install = async (toolId: string, targets: InstallRequest["targets"]) => {
    const request = h.request(toolId, targets);
    const planned = await plannedOf(h, request);
    const r = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(r.status).toBe("succeeded");
    expect(await recordInstallInState(planned, r, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
  };
  await install("fixture-npx-mcp", [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "project" }]);
  await install("postgres-mcp", [{ client: "claude-code", scope: "project" }]);
  const dirs = { base: h.base, projectRoot: h.projectRoot, homeDir: h.homeDir };
  const files = async () => ({
    claude: await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8"),
    cursor: await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8"),
    state: await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8"),
  });
  return { dirs, files };
}

async function revisions(homeDir: string) {
  const read = await readLifecycleState({ homeDir });
  if (!read.ok) throw new Error(read.code);
  return Object.values(read.state.entries)
    .map((e) => e.toolId + ":" + e.target.client + ":r" + e.revision)
    .sort();
}

describe.skipIf(skip)("v0.2.1 B 작업 잠금: 다른 프로세스의 작업과 겹치지 않는다", () => {
  const contenders: [string, Op, string][] = [
    ["postgres Install(Codex)", { op: "install", toolId: "postgres-mcp", client: "codex" }, "failed"],
    ["postgres Health", { op: "health", toolId: "postgres-mcp", client: "claude-code" }, "config-failed"],
    ["npx Update(다른 Client: Cursor)", { op: "update", toolId: "fixture-npx-mcp", client: "cursor" }, "config-failed"],
  ];
  for (const [name, op, busyStatus] of contenders) {
    it("npx Update가 Health 대기 중일 때 " + name + "은 OPERATION_IN_PROGRESS이고 아무것도 바꾸지 않는다. 끝난 뒤에는 둘 다 반영된다", async () => {
      const { dirs, files } = await setup();
      const hold = await mkdtemp(path.join(dirs.base, "hold-"));
      const a = run(dirs, { op: "update", toolId: "fixture-npx-mcp", client: "claude-code", holdDir: hold });
      await waitFor(path.join(hold, "in-health"));
      const during = await files();
      const b = await run(dirs, op).done;
      expect(b, b.stderr).toMatchObject({ status: busyStatus, code: "OPERATION_IN_PROGRESS" });
      expect(await files()).toEqual(during);
      await writeFile(path.join(hold, "release"), "");
      expect(await a.done).toMatchObject({ status: "updated" });
      // 앞 작업이 끝나면 같은 작업을 다시 하면 된다. 기존 항목 유실·rollback-failed 0.
      const again = await run(dirs, op).done;
      expect(again.status, again.stderr).toBe(op.op === "install" ? "succeeded" : op.op === "health" ? "health-checked" : "updated");
      const revs = await revisions(dirs.homeDir);
      expect(revs).toEqual(
        expect.arrayContaining(["fixture-npx-mcp:claude-code:r2", op.op === "update" ? "fixture-npx-mcp:cursor:r2" : "fixture-npx-mcp:cursor:r1", "postgres-mcp:claude-code:r1"]),
      );
      const after = await files();
      expect(JSON.parse(after.claude).mcpServers.postgres).toEqual(JSON.parse(during.claude).mcpServers.postgres);
    }, 240_000);
  }

  it("잠금을 잡은 프로세스가 일시 정지돼 있어도(살아 있음) 잠금을 회수하지 않고, 다른 작업은 OPERATION_IN_PROGRESS다", async () => {
    const { dirs, files } = await setup();
    const hold = await mkdtemp(path.join(dirs.base, "hold-"));
    const a = run(dirs, { op: "update", toolId: "fixture-npx-mcp", client: "claude-code", holdDir: hold });
    await waitFor(path.join(hold, "in-health"));
    const lockFile = path.join(dirs.homeDir, ".openhub", "state", "operation.lock");
    const lockBefore = await readFile(lockFile, "utf8");
    // Linux: 실제 SIGSTOP. Windows에는 프로세스 일시 정지 신호가 없어 Health 대기(release 전) 상태를 정지로 본다.
    if (process.platform !== "win32") process.kill(-a.child.pid!, "SIGSTOP");
    try {
      const during = await files();
      const b = await run(dirs, { op: "install", toolId: "postgres-mcp", client: "codex" }).done;
      expect(b).toMatchObject({ status: "failed", code: "OPERATION_IN_PROGRESS" });
      expect(await readFile(lockFile, "utf8")).toBe(lockBefore);
      expect(await files()).toEqual(during);
    } finally {
      if (process.platform !== "win32") process.kill(-a.child.pid!, "SIGCONT");
    }
    await writeFile(path.join(hold, "release"), "");
    expect(await a.done).toMatchObject({ status: "updated" });
    expect(existsSync(lockFile)).toBe(false);
  }, 240_000);

  it("잠금을 잡은 프로세스가 강제 종료되면 다음 작업이 잠금을 회수해 진행하고 다른 도구 설정은 그대로다", async () => {
    const { dirs, files } = await setup();
    const hold = await mkdtemp(path.join(dirs.base, "hold-"));
    const a = run(dirs, { op: "update", toolId: "fixture-npx-mcp", client: "claude-code", holdDir: hold });
    await waitFor(path.join(hold, "in-health"));
    killTree(a.child.pid!);
    await a.done;
    const lockFile = path.join(dirs.homeDir, ".openhub", "state", "operation.lock");
    expect(existsSync(lockFile)).toBe(true); // 강제 종료로 남은 잠금
    const before = await files();
    const b = await run(dirs, { op: "install", toolId: "postgres-mcp", client: "codex" }).done;
    expect(b, b.stderr).toMatchObject({ status: "succeeded" });
    expect(existsSync(lockFile)).toBe(false);
    const after = await files();
    // npx fixture Claude Code 항목은 강제 종료 시점 그대로(P0-3, journal PR 범위), Cursor·postgres 항목은 그대로다.
    expect(after.claude).toBe(before.claude);
    expect(after.cursor).toBe(before.cursor);
    expect(await revisions(dirs.homeDir)).toEqual(["fixture-npx-mcp:claude-code:r1", "fixture-npx-mcp:cursor:r1", "postgres-mcp:claude-code:r1", "postgres-mcp:codex:r1"]);
  }, 240_000);

  // [A] 설치는 설정 쓰기 → 확인 → Version State 기록까지 하나의 잠금 안이다(CLI·Desktop 공통 runInstallAndRecord).
  const installContenders: [string, Op, string][] = [
    ["npx Update", { op: "update", toolId: "fixture-npx-mcp", client: "claude-code" }, "config-failed"],
    ["postgres Health", { op: "health", toolId: "postgres-mcp", client: "claude-code" }, "config-failed"],
    ["npx Install(Codex)", { op: "install", toolId: "fixture-npx-mcp", client: "codex" }, "failed"],
  ];
  for (const [name, op, busyStatus] of installContenders) {
    it("[A] postgres Install(Codex)이 설정을 쓴 뒤 기록 전에 멈춰 있으면 " + name + "은 OPERATION_IN_PROGRESS이고, 끝난 뒤 기록 불일치·유실이 없다", async () => {
      const { dirs, files } = await setup();
      const hold = await mkdtemp(path.join(dirs.base, "hold-"));
      const a = run(dirs, { op: "install", toolId: "postgres-mcp", client: "codex", holdDir: hold });
      await waitFor(path.join(hold, "in-record"));
      const codexFile = path.join(dirs.projectRoot, ".codex", "config.toml");
      expect(await readFile(codexFile, "utf8")).toContain("postgres"); // 설정은 이미 쓰였다
      expect(await revisions(dirs.homeDir)).not.toContain("postgres-mcp:codex:r1"); // 기록은 아직이다
      if (process.platform !== "win32") process.kill(-a.child.pid!, "SIGSTOP");
      try {
        const during = { ...(await files()), codex: await readFile(codexFile, "utf8") };
        const b = await run(dirs, op).done;
        expect(b, b.stderr).toMatchObject({ status: busyStatus, code: "OPERATION_IN_PROGRESS" });
        expect({ ...(await files()), codex: await readFile(codexFile, "utf8") }).toEqual(during);
      } finally {
        if (process.platform !== "win32") process.kill(-a.child.pid!, "SIGCONT");
      }
      await writeFile(path.join(hold, "release"), "");
      expect(await a.done).toMatchObject({ status: "succeeded", recorded: 1 });
      const again = await run(dirs, op).done;
      expect(again.status, again.stderr).toBe(op.op === "install" ? "succeeded" : op.op === "health" ? "health-checked" : "updated");
      const revs = await revisions(dirs.homeDir);
      expect(revs).toEqual(expect.arrayContaining(["postgres-mcp:codex:r1", "postgres-mcp:claude-code:r1", "fixture-npx-mcp:cursor:r1"]));
      expect(revs).toContain(op.op === "update" ? "fixture-npx-mcp:claude-code:r2" : "fixture-npx-mcp:claude-code:r1");
      if (op.op === "install") expect(revs).toContain("fixture-npx-mcp:codex:r1");
    }, 240_000);
  }

  it("[A] 설치가 기록 직전에 강제 종료되면 다음 작업이 잠금을 회수해 진행하고, 이미 기록된 항목은 그대로다", async () => {
    const { dirs, files } = await setup();
    const hold = await mkdtemp(path.join(dirs.base, "hold-"));
    const a = run(dirs, { op: "install", toolId: "postgres-mcp", client: "codex", holdDir: hold });
    await waitFor(path.join(hold, "in-record"));
    killTree(a.child.pid!);
    await a.done;
    const lockFile = path.join(dirs.homeDir, ".openhub", "state", "operation.lock");
    expect(existsSync(lockFile)).toBe(true);
    const before = await files();
    // 다시 시작한 뒤의 정상 작업: 잠금을 회수하고 진행한다.
    const b = await run(dirs, { op: "health", toolId: "postgres-mcp", client: "claude-code" }).done;
    expect(b, b.stderr).toMatchObject({ status: "health-checked" });
    expect(existsSync(lockFile)).toBe(false);
    const after = await files();
    expect(after.claude).toBe(before.claude);
    expect(after.cursor).toBe(before.cursor);
    // 강제 종료된 설치는 기록되지 않았다(Codex 설정 항목은 남을 수 있다: 중단 복구는 journal PR #40 범위). 기존 기록 유실 0.
    expect(await revisions(dirs.homeDir)).toEqual(["fixture-npx-mcp:claude-code:r1", "fixture-npx-mcp:cursor:r1", "postgres-mcp:claude-code:r1"]);
  }, 240_000);
});
