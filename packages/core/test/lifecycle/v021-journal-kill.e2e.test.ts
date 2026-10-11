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
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/**
 * v0.2.1 P0-3 실제 강제 종료(OPENHUB_E2E=1일 때만). 별도 node 프로세스가 Update를 승인·실행해 Client 설정을 바꾸고 Health에서 기다리는 동안
 * 테스트가 그 프로세스 트리를 강제 종료한다(Windows taskkill /T /F, Linux 프로세스 그룹 SIGKILL). 그 뒤 새 실행(이 테스트 프로세스)이
 * Journal로 중단을 알아보고, 승인한 Recovery만 설정을 되돌린다. 기본 테스트·CI는 프로세스를 띄우지 않는다(AC-031-09).
 */
const skip = process.env["OPENHUB_E2E"] !== "1";
const scratch = await newScratch("v021-journal-kill-e2e");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const seed = await seedEntries();
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const worker = path.join(import.meta.dirname, "fixtures", "update-worker.ts");

async function killedDuringHealth(scope: "project" | "user") {
  const h = await createHarness(scratch, { entries: seed });
  if (scope === "user") {
    await mkdir(path.join(h.homeDir, ".cursor"), { recursive: true });
    await writeFile(path.join(h.homeDir, ".cursor", "mcp.json"), '{\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n');
  }
  const targets: InstallRequest["targets"] = [{ client: "cursor", scope }];
  const install = h.request("github-mcp-server", targets, scope === "user");
  const p = await plannedOf(h, install);
  const r = await runInstallTransaction(p, await approveAll(p), install, h.env);
  expect(r.status).toBe("succeeded");
  expect(await recordInstallInState(p, r, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
  const cursorFile = scope === "project" ? path.join(h.projectRoot, ".cursor", "mcp.json") : path.join(h.homeDir, ".cursor", "mcp.json");
  const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
  const original = [await readFile(cursorFile, "utf8"), await readFile(stateFile, "utf8")];

  const hold = await mkdtemp(path.join(h.base, "hold-"));
  const child = spawn(process.execPath, [tsx, worker, JSON.stringify({ toolId: "github-mcp-server", client: "cursor", scope, base: h.base, projectRoot: h.projectRoot, homeDir: h.homeDir, holdDir: hold })], { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (d) => (stderr += d.toString()));
  let exitedBeforeKill = false;
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => child.on("close", (code, signal) => resolve({ code, signal })));
  void closed.then(() => (exitedBeforeKill = true));
  const until = Date.now() + 90_000;
  while (!existsSync(path.join(hold, "in-health"))) {
    if (Date.now() > until) throw new Error("worker did not reach Health: " + stderr.slice(-400));
    await new Promise((r) => setTimeout(r, 25));
  }
  // 종료 전: Journal이 디스크에 있고(단계 health), 설정은 이미 바뀌었고, Version State는 그대로다.
  const before = await readJournals(h.homeDir);
  expect(before.ok && before.journals.map((j) => [j.operation, j.phase])).toEqual([["update", "health"]]);
  // 프로세스가 스스로 끝나지 않고 Health에서 살아 있는 상태에서 강제 종료한다.
  await new Promise((r) => setTimeout(r, 300));
  expect(exitedBeforeKill, "worker exited on its own: " + stderr.slice(-300)).toBe(false);
  if (process.platform === "win32") spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
  else process.kill(-child.pid!, "SIGKILL");
  const end = await closed;
  // Linux: SIGKILL, Windows: taskkill /F(종료 코드 1). 정상 종료(코드 0)가 아니다.
  expect(end.signal === "SIGKILL" || (end.code !== 0 && end.code !== null)).toBe(true);
  const killed = [await readFile(cursorFile, "utf8"), await readFile(stateFile, "utf8")];
  expect(killed[0]).not.toBe(original[0]);
  expect(killed[1]).toBe(original[1]);
  return { h, scope, cursorFile, stateFile, original, killed };
}

const approveAllRecovery = async (opts: Parameters<typeof planRecovery>[0]) => {
  const built = await planRecovery(opts);
  if (!built.ok) throw new Error(built.code);
  const o = await requestRecoveryApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (o.status !== "approved") throw new Error(o.status);
  return { built, approval: o.approval };
};

describe.skipIf(skip)("v0.2.1 P0-3 실제 강제 종료 후 Recovery", () => {
  for (const scope of ["project", "user"] as const) {
    it(scope + " 범위: 종료 전 Journal 기록, 재시작 후 interrupted-update, 승인 전 쓰기 0, 승인 후 변경 전으로 복구, Journal 정리, 중복 요청 차단", async () => {
      const k = await killedDuringHealth(scope);
      const status = await lifecycleStatus({ projectRoot: k.h.projectRoot, homeDir: k.h.homeDir, entries: seed, platform: "linux", includeUser: scope === "user" });
      expect(status.ok && status.items.map((i) => i.state)).toEqual(["interrupted-update"]);
      const opts = { toolId: "github-mcp-server", projectRoot: k.h.projectRoot, homeDir: k.h.homeDir, mode: "undo" as const };
      const { built, approval } = await approveAllRecovery(opts);
      expect(built.ok && built.planned.plan.status).toBe("ready");
      expect(built.ok && built.planned.plan.approvalRequirements).toEqual(scope === "user" ? ["base", "user-scope-config"] : ["base"]);
      expect([await readFile(k.cursorFile, "utf8"), await readFile(k.stateFile, "utf8")]).toEqual(k.killed);
      const r = await executeRecovery(approval, { ...opts, regenerate: () => planRecovery(opts) });
      expect(r).toMatchObject({ status: "recovered" });
      expect(JSON.parse(await readFile(k.cursorFile, "utf8"))).toEqual(JSON.parse(k.original[0]!));
      expect(await readFile(k.stateFile, "utf8")).toBe(k.original[1]);
      const after = await lifecycleStatus({ projectRoot: k.h.projectRoot, homeDir: k.h.homeDir, entries: seed, platform: "linux", includeUser: scope === "user" });
      expect(after.ok && after.items.map((i) => i.state)).toEqual(["state-consistent"]);
      const journals = await readJournals(k.h.homeDir);
      expect(journals.ok && journals.journals).toEqual([]);
      expect(await planRecovery(opts)).toMatchObject({ ok: false, code: "NO_INTERRUPTED_OPERATION" });
    }, 180_000);
  }

  it("종료 뒤 사용자가 같은 항목을 바꿨으면 복구는 blocked이고 덮어쓰기 0", async () => {
    const k = await killedDuringHealth("project");
    const external = '{ "mcpServers": { "github": { "command": "docker", "args": ["run", "-i", "--rm", "my-own-image"] } } }\n';
    await writeFile(k.cursorFile, external);
    const opts = { toolId: "github-mcp-server", projectRoot: k.h.projectRoot, homeDir: k.h.homeDir, mode: "undo" as const };
    const built = await planRecovery(opts);
    expect(built.ok && built.planned.plan.status).toBe("blocked");
    expect(built.ok && built.planned.plan.blockers.map((b) => b.code)).toContain("EXTERNAL_CHANGE");
    expect(await readFile(k.cursorFile, "utf8")).toBe(external);
  }, 180_000);
});
