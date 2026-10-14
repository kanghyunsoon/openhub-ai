import { existsSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  nodeConfigFs,
  planLifecycleRequest,
  readLifecycleState,
  requestLifecycleApproval,
  runInstallAndRecord,
  runInstallTransaction,
  runLifecycleTransaction,
  type ConfigFs,
  type InstallRequest,
  type LifecycleEnvironment,
  type LifecycleRequest,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { seedWithNpxFixture } from "../recommendation/helpers";
import { fakeNpmSpawner } from "../process/fake-npm";
import { newScratch } from "./helpers";

/**
 * v0.2.1 B [A] 설치 + Version State 기록은 하나의 작업 잠금 안에서 한다(runInstallAndRecord, CLI·Desktop 공통).
 * - 설정을 쓴 뒤 기록하기 전에 멈춰 있어도 다른 install·Health·update는 OPERATION_IN_PROGRESS이고 아무것도 바꾸지 않는다.
 * - 기록이 실패하면 설정을 되돌리고 STATE_RECORD_FAILED다(성공 + 경고가 아니다). 되돌리지 못하면 COMPENSATION_INCOMPLETE다.
 */
const seed = await seedWithNpxFixture();
const scratch = await newScratch("v021-install-record");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const now = () => new Date("2026-10-11T00:00:00.000Z");

/** Version State 임시 파일 쓰기(커밋)를 가로채는 ConfigFs. */
function stateWriteHook(base: ConfigFs, onStateWrite: () => Promise<void>): ConfigFs {
  return {
    ...base,
    writeFile: async (file, data) => {
      if (path.basename(file).startsWith(".lifecycle.json.openhub-")) await onStateWrite();
      return base.writeFile(file, data);
    },
  };
}

function lifecycleEnv(h: Harness): LifecycleEnvironment {
  return {
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: h.base,
    now,
    fetch: async () => new Response("missing", { status: 404 }),
    configFs: nodeConfigFs,
    mcpSourceEnv: () => ({}),
    spawner: fakeNpmSpawner({ cacheRoot: path.join(h.base, "npm-cache") }).spawner,
    runHealth: async (verified) => ({ ok: true, result: { status: "healthy", reason: null, toolCount: 3, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null } }),
  };
}

async function installRecorded(h: Harness, toolId: string, targets: InstallRequest["targets"]) {
  const request = h.request(toolId, targets);
  const planned = await plannedOf(h, request);
  const r = await runInstallAndRecord(planned, await approveAll(planned), request, h.env, { now });
  expect(r.result.status).toBe("succeeded");
  return r;
}

const entryNames = async (homeDir: string) => {
  const read = await readLifecycleState({ homeDir });
  if (!read.ok) throw new Error(read.code);
  return Object.values(read.state.entries).map((e) => e.toolId + ":" + e.target.client).sort();
};

describe("v0.2.1 B [A] 설치와 Version State 기록은 하나의 작업 잠금 안에서 한다", () => {
  it("성공하면 기록한 항목 수를 돌려주고 Version State와 설정이 일치한다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const r = await installRecorded(h, "fixture-npx-mcp", [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "project" }]);
    expect(r.recorded).toBe(2);
    expect(await entryNames(h.homeDir)).toEqual(["fixture-npx-mcp:claude-code", "fixture-npx-mcp:cursor"]);
  });

  it("설정을 쓴 뒤 기록 전에 멈춰 있으면 다른 install·Health·update는 OPERATION_IN_PROGRESS이고, 끝난 뒤 기록 유실이 없다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installRecorded(h, "postgres-mcp", [{ client: "claude-code", scope: "project" }]);
    let reached!: () => void;
    let release!: () => void;
    const atRecord = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    let armed = true;
    const paused = { ...h.env, configFs: stateWriteHook(h.env.configFs!, async () => {
      if (!armed) return;
      armed = false;
      reached();
      await gate;
    }) };
    const phases: string[] = [];
    const request = h.request("fixture-npx-mcp", [{ client: "claude-code", scope: "project" }]);
    const planned = await plannedOf(h, request);
    const running = runInstallAndRecord(planned, await approveAll(planned), request, { ...paused, trace: (p) => phases.push(p) }, { now });
    await atRecord;
    // 지금: memory 설정은 이미 쓰였고(config-write·verify 끝) Version State 기록 직전에 멈춰 있다.
    expect(phases.slice(-2)).toEqual(["verify", "record"]);
    expect(JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).mcpServers["fixture-npx"]).toBeDefined();
    const during = { claude: await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8"), state: await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8") };

    const otherInstall = h.request("postgres-mcp", [{ client: "codex", scope: "project" }]);
    const otherPlanned = await plannedOf(h, otherInstall);
    expect(await runInstallTransaction(otherPlanned, await approveAll(otherPlanned), otherInstall, h.env)).toMatchObject({ status: "failed", code: "OPERATION_IN_PROGRESS" });

    const env = lifecycleEnv(h);
    for (const operation of ["health", "update"] as const) {
      const req: LifecycleRequest = { operation, toolId: "postgres-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets: [{ client: "claude-code", scope: "project" }] };
      const built = await planLifecycleRequest(req, env);
      // 이 seed의 postgres-mcp는 Manifest 버전(0.3.0)으로 고정돼 update가 up-to-date이거나 막힐 수 있다(그 경우 실행·쓰기 0).
      if (!built.ok || built.planned.plan.status !== "ready") {
        expect(operation).toBe("update");
        continue;
      }
      const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (outcome.status !== "approved") throw new Error(outcome.status);
      expect(await runLifecycleTransaction(built.planned, outcome.approval, req, env)).toMatchObject({ status: "config-failed", code: "OPERATION_IN_PROGRESS" });
    }
    expect(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).toBe(during.claude);
    expect(await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8")).toBe(during.state);
    expect(existsSync(path.join(h.projectRoot, ".codex", "config.toml"))).toBe(false);

    release();
    expect(await running).toMatchObject({ result: { status: "succeeded" }, recorded: 1 });
    expect(existsSync(path.join(h.homeDir, ".openhub", "state", "operation.lock"))).toBe(false);
    // 끝난 뒤 다시 하면 진행되고, 두 기록 모두 남는다.
    expect((await runInstallAndRecord(otherPlanned, await approveAll(otherPlanned), otherInstall, h.env, { now })).result.status).toBe("succeeded");
    expect(await entryNames(h.homeDir)).toEqual(["fixture-npx-mcp:claude-code", "postgres-mcp:claude-code", "postgres-mcp:codex"]);
  });

  it("기록이 실패하면 이번에 쓴 설정을 원래 byte로 되돌리고 STATE_RECORD_FAILED다(succeeded가 아니다)", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const original = JSON.stringify({ mcpServers: { mine: { command: "node", args: ["keep.js"] } } }, null, 2) + "\n";
    await writeFile(path.join(h.projectRoot, ".mcp.json"), original);
    const failing = { ...h.env, configFs: stateWriteHook(h.env.configFs!, async () => {
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    }) };
    const request = h.request("fixture-npx-mcp", [{ client: "claude-code", scope: "project" }]);
    const planned = await plannedOf(h, request);
    const r = await runInstallAndRecord(planned, await approveAll(planned), request, failing, { now });
    expect(r.recorded).toBe(0);
    expect(r.result).toMatchObject({ status: "partial-compensated", code: "STATE_RECORD_FAILED", retryable: true });
    expect(r.result.configChanges).toEqual([expect.objectContaining({ client: "claude-code", applied: true, restored: true })]);
    expect(r.result.warnings.map((w) => w.code)).toContain("state-record-failed");
    expect(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).toBe(original);
    expect(existsSync(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"))).toBe(false);
    expect(existsSync(path.join(h.homeDir, ".openhub", "state", "operation.lock"))).toBe(false);
  });

  it("손상된 Version State면 기록하지 않고 설정을 되돌리며(STATE_CORRUPT, 재시도 불가) 손상 파일을 덮어쓰지 않는다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
    await rm(path.dirname(stateFile), { recursive: true, force: true });
    await (await import("node:fs/promises")).mkdir(path.dirname(stateFile), { recursive: true });
    await writeFile(stateFile, "{ not json");
    const request = h.request("fixture-npx-mcp", [{ client: "claude-code", scope: "project" }]);
    const planned = await plannedOf(h, request);
    const r = await runInstallAndRecord(planned, await approveAll(planned), request, h.env, { now });
    expect(r.result).toMatchObject({ status: "partial-compensated", code: "STATE_RECORD_FAILED", retryable: false });
    expect(r.result.warnings.find((w) => w.code === "state-record-failed")?.message).toContain("STATE_CORRUPT");
    expect(existsSync(path.join(h.projectRoot, ".mcp.json"))).toBe(false);
    expect(await readFile(stateFile, "utf8")).toBe("{ not json");
  });

  it("기록 실패 뒤 되돌릴 설정이 그 사이 바뀌었으면 덮어쓰지 않고 COMPENSATION_INCOMPLETE다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const mcp = path.join(h.projectRoot, ".mcp.json");
    const external = JSON.stringify({ mcpServers: { edited: { command: "x" } } }) + "\n";
    const failing = { ...h.env, configFs: stateWriteHook(h.env.configFs!, async () => {
      await writeFile(mcp, external); // 다른 프로그램이 설정을 바꿨다
      throw Object.assign(new Error("denied"), { code: "EACCES" });
    }) };
    const request = h.request("fixture-npx-mcp", [{ client: "claude-code", scope: "project" }]);
    const planned = await plannedOf(h, request);
    const r = await runInstallAndRecord(planned, await approveAll(planned), request, failing, { now });
    expect(r.result).toMatchObject({ status: "failed", code: "COMPENSATION_INCOMPLETE", retryable: false });
    expect(await readFile(mcp, "utf8")).toBe(external);
  });

  it("승인이 없거나 이미 설치된 계획이면 잠금·기록 없이 기존 결과다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const request = h.request("fixture-npx-mcp", [{ client: "claude-code", scope: "project" }]);
    const planned = await plannedOf(h, request);
    expect(await runInstallAndRecord(planned, undefined, request, h.env, { now })).toMatchObject({ result: { status: "approval-required" }, recorded: 0 });
    await installRecorded(h, "fixture-npx-mcp", [{ client: "claude-code", scope: "project" }]);
    const again = await plannedOf(h, request);
    expect(await runInstallAndRecord(again, undefined, request, h.env, { now })).toMatchObject({ result: { status: "no-op", code: "ALREADY_INSTALLED" }, recorded: 0 });
  });
});
