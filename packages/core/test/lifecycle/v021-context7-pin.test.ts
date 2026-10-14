import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  npxPrepareArgs,
  planLifecycleRequest,
  readLifecycleState,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type HealthCheckStatus,
  type HealthFailureReason,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedWithNpxFixture } from "../recommendation/helpers";
import { fakeNpmSpawner } from "../process/fake-npm";
import { newScratch } from "./helpers";

/**
 * v0.2.1(#70): Context7을 검토한 정확한 버전(@upstash/context7-mcp@4.1.0)으로 고정했다.
 * - 신규 설치: 승인 → npx Prepare(4.1.0) → 같은 버전으로 Client 설정 기록. Prepare 실패면 설정·Version State가 그대로다.
 * - 기존 floating 설치(v0.2.0·v0.2.1 이전 Registry의 "npx -y @upstash/context7-mcp"): 계획·상태 조회만으로는 아무것도 바뀌지 않는다(자동 덮어쓰기 없음).
 *   update는 승인 뒤 4.1.0을 Prepare하고 설정을 바꾸며 Health 성공 뒤에만 Version State를 commit한다. Health 실패·Prepare 실패·외부 변경은 원래 상태를 지킨다.
 * - 고정된 Manifest에서도 INSTALLED의 정확한 버전 입력(--to)은 다른 정확한 버전(예: 4.1.1)을 계획한다(RC 단계 9·10).
 * 가짜 npm(fake-npm)·가짜 Health만 쓴다. 실제 npm·MCP 서버 검증은 registry/npx-prepare.e2e·npx-lifecycle-real.e2e(OPENHUB_E2E=1)이다.
 */
const seed = await seedWithNpxFixture();
const scratch = await newScratch("v021-context7-pin");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const PKG = "@upstash/context7-mcp";
const V1 = PKG + "@4.1.0";
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];
const INSTALLED_AT = () => new Date("2026-10-07T01:02:03.000Z");
/** v0.2.1 이전 Registry의 Context7 Manifest(고정 안 됨). 기존 사용자의 설치를 만든다. */
const floating: RegistryEntry[] = seed.map((e) => (e.manifest.name === "context7" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: "npx -y " + PKG } } } } : e));

function healthOf(log: string[], status: HealthCheckStatus = "healthy", reason: HealthFailureReason | null = null) {
  const run: NonNullable<LifecycleEnvironment["runHealth"]> = async () => {
    log.push("health:run");
    return { ok: true, result: { status, reason, toolCount: status === "healthy" ? 2 : null, environmentUnverified: false, terminated: true, excerpt: null } };
  };
  return run;
}

async function floatingInstall() {
  const h = await createHarness(scratch, { entries: floating });
  const request = h.request("context7", CLAUDE);
  const planned = await plannedOf(h, request);
  expect(planned.plan.artifact).toMatchObject({ spec: PKG, pinned: false, preparation: "launch-on-demand" });
  const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
  expect(result.status).toBe("succeeded");
  expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: INSTALLED_AT })).toMatchObject({ ok: true });
  h.reset();
  return h;
}

function lifecycleEnv(h: Awaited<ReturnType<typeof floatingInstall>>, opts: { prepare?: "ok" | "fail"; health?: [HealthCheckStatus, HealthFailureReason | null] } = {}) {
  const exec = fakeNpmSpawner({ cacheRoot: path.join(scratch, "npm-cache-" + Math.random().toString(36).slice(2, 8)), exitCode: 0, prepare: opts.prepare ?? "ok" });
  const fetch = vi.fn(async () => new Response("no registry lookup expected", { status: 500 }));
  const env: LifecycleEnvironment = {
    mcpSourceEnv: () => ({}),
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: scratch,
    now: () => new Date("2026-10-14T00:00:00.000Z"),
    fetch,
    configFs: h.env.configFs!,
    spawner: exec.spawner,
    runHealth: healthOf(h.writes, ...(opts.health ?? ["healthy", null])),
    trace: (p) => h.writes.push("phase:" + p),
  };
  return { env, exec, fetch };
}

const request = (h: Awaited<ReturnType<typeof floatingInstall>>, to?: string): LifecycleRequest => ({ operation: "update", toolId: "context7", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets: CLAUDE, ...(to === undefined ? {} : { to }) });
const files = async (h: Awaited<ReturnType<typeof floatingInstall>>) => ({ config: await readFile(path.join(h.projectRoot, ".mcp.json")), state: await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json")) });
async function approved(h: Awaited<ReturnType<typeof floatingInstall>>, env: LifecycleEnvironment, to?: string) {
  const r = await planLifecycleRequest(request(h, to), env);
  if (!r.ok) throw new Error(r.code + " " + r.message);
  const outcome = await requestLifecycleApproval(r.planned, { channel: "cli-tty", confirm: async (q) => q.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  return { planned: r.planned, approval: outcome.approval };
}

describe("v0.2.1 #70 Context7 정확한 버전 고정", () => {
  it("Registry Manifest는 4.1.0이고 신규 설치는 승인 뒤 같은 버전을 Prepare한 다음 그 버전으로 Client 설정을 쓴다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const planned = await plannedOf(h, h.request("context7", CLAUDE));
    expect(planned.plan.artifact).toEqual({ kind: "npm-package", spec: V1, pinned: true, preparation: "npm-cache" });
    expect(planned.plan.approvalRequirements).not.toContain("floating-artifact");
    expect(planned.plan.steps.map((s) => s.kind)).toEqual(["run", "config-patch"]);
    expect(planned.plan.steps[0]).toMatchObject({ id: "npx-prepare", executable: "npx", args: npxPrepareArgs(V1) });
    expect(planned.plan.steps[1]).toMatchObject({ value: { command: "npx", args: ["-y", V1] } });
    // 승인 전에는 실행·쓰기가 없다.
    expect(h.spawns).toEqual([]);
    expect(h.writes.filter((w) => !w.startsWith("phase:"))).toEqual([]);
  });

  it("기존 floating 설치: update 계획(조회)만으로는 설정·Version State가 바뀌지 않고 registry 조회 없이 4.1.0 Prepare → 교체 → Health → commit 계획이 된다", async () => {
    const h = await floatingInstall();
    const before = await files(h);
    const { env, exec, fetch } = lifecycleEnv(h);
    const r = await planLifecycleRequest(request(h), env);
    if (!r.ok) throw new Error(r.code);
    expect(r.planned.plan.status).toBe("ready");
    expect(r.planned.plan.current).toMatchObject({ requested: PKG, identity: null, clientSpec: { command: "npx", args: ["-y", PKG] } });
    expect(r.planned.plan.target).toMatchObject({ requested: V1, identity: { spec: V1, version: "4.1.0" }, clientSpec: { command: "npx", args: ["-y", V1] } });
    expect(r.planned.plan.steps.map((s) => s.kind)).toEqual(["run", "config-replace", "health", "state-commit"]);
    expect(r.planned.plan.steps[0]).toMatchObject({ id: "npx-prepare", args: npxPrepareArgs(V1) });
    expect(fetch).not.toHaveBeenCalled();
    expect(exec.calls).toEqual([]);
    const after = await files(h);
    expect(after.config.equals(before.config)).toBe(true);
    expect(after.state.equals(before.state)).toBe(true);
  });

  it("기존 floating 설치 → 승인한 update: Prepare 뒤 설정을 4.1.0으로 바꾸고 Health 성공 뒤 commit한다. previous는 floating 설치다", async () => {
    const h = await floatingInstall();
    const { env } = lifecycleEnv(h);
    const { planned, approval } = await approved(h, env);
    const result = await runLifecycleTransaction(planned, approval, request(h), env);
    expect(result).toMatchObject({ status: "updated", stateCommitted: true, artifact: { from: PKG, to: V1 } });
    const phases = h.writes.filter((l) => l === "phase:prepare" || l === "phase:config-replace" || l === "health:run" || l === "phase:state-commit");
    expect(phases).toEqual(["phase:prepare", "phase:config-replace", "health:run", "phase:state-commit"]);
    expect(JSON.parse((await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).toString()).mcpServers.context7).toEqual({ command: "npx", args: ["-y", V1] });
    const state = await readLifecycleState({ homeDir: h.homeDir });
    if (!state.ok) throw new Error(state.code);
    const entry = Object.values(state.state.entries)[0]!;
    expect(entry.artifact).toMatchObject({ requested: V1, resolved: { spec: V1 } });
    expect(entry.previous?.artifact.requested).toBe(PKG);
  });

  it("기존 floating 설치: Prepare 실패면 설정·Version State가 byte 그대로이고 Health를 실행하지 않는다", async () => {
    const h = await floatingInstall();
    const before = await files(h);
    const { env } = lifecycleEnv(h, { prepare: "fail" });
    const { planned, approval } = await approved(h, env);
    const result = await runLifecycleTransaction(planned, approval, request(h), env);
    expect(result).toMatchObject({ status: "preparation-failed", stateCommitted: false });
    const after = await files(h);
    expect(after.config.equals(before.config)).toBe(true);
    expect(after.state.equals(before.state)).toBe(true);
    expect(h.writes).not.toContain("health:run");
  });

  it("기존 floating 설치: Health 실패면 설정을 원래 byte로 되돌리고 Version State를 commit하지 않는다(강행 경로 없음)", async () => {
    const h = await floatingInstall();
    const before = await files(h);
    const { env } = lifecycleEnv(h, { health: ["unhealthy", "startup-timeout"] });
    const { planned, approval } = await approved(h, env);
    const result = await runLifecycleTransaction(planned, approval, request(h), env);
    expect(result).toMatchObject({ status: "health-failed", compensated: true, stateCommitted: false });
    const after = await files(h);
    expect(after.config.equals(before.config)).toBe(true);
    expect(after.state.equals(before.state)).toBe(true);
    expect(await runLifecycleTransaction(planned, approval, request(h), env)).toMatchObject({ status: "approval-required", code: "APPROVAL_CONSUMED" });
  });

  it("기존 floating 설치: 승인 뒤 Client 설정이 바뀌면 실행하지 않고 외부 변경을 덮어쓰지 않는다(PLAN_STALE)", async () => {
    const h = await floatingInstall();
    const { env, exec } = lifecycleEnv(h);
    const { planned, approval } = await approved(h, env);
    const file = path.join(h.projectRoot, ".mcp.json");
    const external = JSON.stringify({ mcpServers: { context7: { command: "npx", args: ["-y", PKG + "@4.4.1"] } } }, null, 2) + "\n";
    await writeFile(file, external);
    const result = await runLifecycleTransaction(planned, approval, request(h), env);
    expect(result.stateCommitted).toBe(false);
    expect(JSON.stringify(result)).toContain("PLAN_STALE");
    expect(await readFile(file, "utf8")).toBe(external);
    expect(exec.calls).toEqual([]);
  });

  it("고정된 Manifest에서도 정확한 버전 입력(--to 4.1.1)은 그 버전을 Prepare하는 update를 계획한다(RC 단계 9·10의 V1 → V2)", async () => {
    const h = await floatingInstall();
    const { env, fetch } = lifecycleEnv(h);
    const r = await planLifecycleRequest(request(h, "4.1.1"), env);
    if (!r.ok) throw new Error(r.code);
    expect(r.planned.plan.status).toBe("ready");
    expect(r.planned.plan.target).toMatchObject({ requested: PKG + "@4.1.1", clientSpec: { command: "npx", args: ["-y", PKG + "@4.1.1"] } });
    expect(r.planned.plan.steps[0]).toMatchObject({ id: "npx-prepare", args: npxPrepareArgs(PKG + "@4.1.1") });
    expect(fetch).not.toHaveBeenCalled();
  });
});

