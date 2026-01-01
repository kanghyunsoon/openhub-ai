import { EventEmitter } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  ROLLBACK_UNLOCKED_NOTICE,
  configEntryDigest,
  formatLifecyclePlanPreview,
  formatLifecycleResult,
  lifecycleStatus,
  planLifecycleRequest,
  readLifecycleState,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type ExecSpawner,
  type HealthCheckStatus,
  type HealthFailureReason,
  type InstallRequest,
  type LifecycleApprovalRequirement,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/** TASK-044 Rollback. install → update → rollback을 실제 config·Version State로 실행한다(registry·준비·Health는 가짜). */
const seed = await seedEntries();
const scratch = await newScratch("rollback-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const D1 = "sha256:" + "1".repeat(64);
const D2 = "sha256:" + "2".repeat(64);

interface EnvOptions {
  digest?: string;
  exitCode?: number;
  health?: [HealthCheckStatus, HealthFailureReason | null];
  entries?: readonly RegistryEntry[];
}
function envFor(h: Harness, o: EnvOptions = {}) {
  const fetch = vi.fn(async (url: string) => {
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: "1.2.3" });
    if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
    if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": o.digest ?? D1 } });
    return new Response("missing", { status: 404 });
  });
  const pulls: string[][] = [];
  const spawner: ExecSpawner = (exe, args) => {
    pulls.push([exe, ...args]);
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: () => true });
    queueMicrotask(() => child.emit("close", o.exitCode ?? 0, null));
    return child as never;
  };
  const [status, reason] = o.health ?? ["healthy", null];
  const env: LifecycleEnvironment = {
    loadEntries: async () => o.entries ?? seed,
    probe: () => h.env.probe(),
    tempBase: scratch,
    now: () => new Date("2026-10-09T00:00:00.000Z"),
    fetch,
    configFs: h.env.configFs!,
    spawner,
    runHealth: async (verified) => ({
      ok: true,
      result: { status, reason, toolCount: status === "healthy" ? 1 : null, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null },
    }),
  };
  return { env, fetch, pulls };
}
const requestOf = (h: Harness, toolId: string, operation: LifecycleRequest["operation"], targets: InstallRequest["targets"]): LifecycleRequest => ({
  operation,
  toolId,
  projectRoot: h.projectRoot,
  homeDir: h.homeDir,
  platform: "linux",
  includeUser: false,
  targets,
});
async function planOf(request: LifecycleRequest, env: LifecycleEnvironment) {
  const r = await planLifecycleRequest(request, env);
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
}
async function approve(p: Awaited<ReturnType<typeof planOf>>, skip: readonly LifecycleApprovalRequirement[] = []) {
  const o = await requestLifecycleApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id).filter((id) => !skip.includes(id)) });
  if (o.status !== "approved") throw new Error(o.status);
  return o.approval;
}
async function execute(request: LifecycleRequest, env: LifecycleEnvironment) {
  const planned = await planOf(request, env);
  const approval = await approve(planned);
  return { planned, approval, result: await runLifecycleTransaction(planned, approval, request, env) };
}
/** 설치 후 update 횟수만큼 실행한다(docker는 digest를 바꿔 가며). */
async function updatedHarness(toolId: string, targets: InstallRequest["targets"], digests: readonly string[] = [D1]) {
  const h = await createHarness(scratch, { entries: seed });
  const install = h.request(toolId, targets);
  const p = await plannedOf(h, install);
  const installed = await runInstallTransaction(p, await approveAll(p), install, h.env);
  await recordInstallInState(p, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-07T00:00:00.000Z") });
  const original = await readFile(path.join(h.projectRoot, targets[0]!.client === "cursor" ? ".cursor/mcp.json" : ".mcp.json"));
  const updates = [];
  for (const digest of digests) updates.push(await execute(requestOf(h, toolId, "update", targets), envFor(h, { digest }).env));
  for (const u of updates) expect(u.result.status).toBe("updated");
  h.reset();
  return { h, original, updates };
}
async function entry(h: Harness) {
  const r = await readLifecycleState({ homeDir: h.homeDir });
  if (!r.ok) throw new Error(r.code);
  return Object.values(r.state.entries)[0]!;
}
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];
const CURSOR = [{ client: "cursor" as const, scope: "project" as const }];

describe("REQ-050 Rollback", () => {
  it("AC-044-01 RollbackPlan은 state.previous로 만들고 npx·uvx는 fetch 0회, docker는 이전 digest를 pull한다", async () => {
    const { h } = await updatedHarness("memory-mcp", CLAUDE);
    const { env, fetch } = envFor(h);
    const plan = (await planOf(requestOf(h, "memory-mcp", "rollback", CLAUDE), env)).plan;
    expect(fetch).not.toHaveBeenCalled();
    expect(plan).toMatchObject({
      operation: "rollback",
      status: "ready",
      current: { identity: { spec: "@modelcontextprotocol/server-memory@1.2.3" } },
      target: { requested: "@modelcontextprotocol/server-memory", identity: null, clientSpec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
    });
    expect(plan.steps.map((s) => s.kind)).toEqual(["config-replace", "health", "state-commit"]);

    const docker = await updatedHarness("github-mcp-server", CURSOR, [D1, D2]);
    const d = envFor(docker.h);
    const dplan = (await planOf(requestOf(docker.h, "github-mcp-server", "rollback", CURSOR), d.env)).plan;
    expect(d.fetch).not.toHaveBeenCalled();
    expect(dplan.steps[0]).toMatchObject({ kind: "run", args: ["pull", "ghcr.io/github/github-mcp-server@" + D1] });
    expect(dplan.target.clientSpec.args.at(-1)).toBe("ghcr.io/github/github-mcp-server@" + D1);
  });

  it("AC-044-02 previous snapshot이 없으면 NO_ROLLBACK_TARGET이고 Plan을 만들지 않는다", async () => {
    const { h } = await updatedHarness("memory-mcp", CLAUDE, []);
    expect((await entry(h)).previous).toBeNull();
    expect(await planLifecycleRequest(requestOf(h, "memory-mcp", "rollback", CLAUDE), envFor(h).env)).toMatchObject({ ok: false, code: "NO_ROLLBACK_TARGET" });
  });

  it("AC-044-03 rollback-to-previous를 포함한 별도 승인이 필요하고 update Approval로는 실행할 수 없다", async () => {
    const { h, updates } = await updatedHarness("memory-mcp", CLAUDE);
    const { env } = envFor(h);
    const request = requestOf(h, "memory-mcp", "rollback", CLAUDE);
    const planned = await planOf(request, env);
    expect(planned.plan.approvalRequirements).toEqual(["base", "health-execution", "rollback-to-previous"]);
    const usedUpdateApproval = updates[0]!.approval;
    expect(await runLifecycleTransaction(planned, usedUpdateApproval, request, env)).toMatchObject({ status: "approval-required", code: "APPROVAL_REQUIRED" });
    const missing = await approve(planned, ["rollback-to-previous"]);
    expect(await runLifecycleTransaction(planned, missing, request, env)).toMatchObject({ status: "approval-required", code: "APPROVAL_INCOMPLETE" });
    expect(h.writes.filter((w) => !w.startsWith("mkdir"))).toEqual([]);
  });

  it("AC-044-04 rollback이 성공하면 revision+1이고 previous는 rollback 직전 상태가 된다", async () => {
    const { h, original } = await updatedHarness("memory-mcp", CLAUDE);
    const before = await entry(h);
    const { result } = await execute(requestOf(h, "memory-mcp", "rollback", CLAUDE), envFor(h).env);
    expect(result).toMatchObject({ status: "rolled-back", artifact: { from: "@modelcontextprotocol/server-memory@1.2.3", to: null }, targets: [{ revisionBefore: 2, revisionAfter: 3 }] });
    const after = await entry(h);
    const { previous: _p, lastHealth: _h, ...beforeCore } = before;
    expect(after.revision).toBe(3);
    expect(after.previous).toEqual(beforeCore);
    expect(after.artifact).toEqual({ requested: "@modelcontextprotocol/server-memory", resolved: null });
    expect(after.lastHealth?.status).toBe("healthy");
    expect((await readFile(path.join(h.projectRoot, ".mcp.json"))).equals(original)).toBe(true);
    expect(after.config.entryDigest).toBe(configEntryDigest(JSON.parse(original.toString("utf8")).mcpServers.memory));
  });

  it("AC-044-05 rollback 후 Health가 실패하면 rollback 직전 config로 되돌리고 state는 그대로이며 health-failed다", async () => {
    const { h } = await updatedHarness("memory-mcp", CLAUDE);
    const config = await readFile(path.join(h.projectRoot, ".mcp.json"));
    const state = await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"));
    const { result } = await execute(requestOf(h, "memory-mcp", "rollback", CLAUDE), envFor(h, { health: ["handshake-failed", "invalid-message"] }).env);
    expect(result).toMatchObject({ status: "health-failed", compensated: true, stateCommitted: false });
    expect((await readFile(path.join(h.projectRoot, ".mcp.json"))).equals(config)).toBe(true);
    expect((await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"))).equals(state)).toBe(true);
  });

  it("AC-044-06 state 이후 config가 수정됐으면 blocked(CONFIG_DRIFT)다", async () => {
    const { h } = await updatedHarness("memory-mcp", CLAUDE);
    const file = path.join(h.projectRoot, ".mcp.json");
    await writeFile(file, (await readFile(file, "utf8")).replace("server-memory@1.2.3", "server-memory@1.2.9"));
    const plan = (await planOf(requestOf(h, "memory-mcp", "rollback", CLAUDE), envFor(h).env)).plan;
    expect([plan.status, plan.steps, plan.warnings.map((w) => w.code)]).toEqual(["blocked", [], ["CONFIG_DRIFT"]]);
  });

  it("AC-044-07 이전 digest pull이 실패하면 preparation-failed이고 config는 byte 그대로다", async () => {
    const { h } = await updatedHarness("github-mcp-server", CURSOR, [D1, D2]);
    const config = await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"));
    const e = envFor(h, { exitCode: 1 });
    const { result } = await execute(requestOf(h, "github-mcp-server", "rollback", CURSOR), e.env);
    expect(result).toMatchObject({ status: "preparation-failed", stateCommitted: false });
    expect(e.pulls).toEqual([["docker", "pull", "ghcr.io/github/github-mcp-server@" + D1]]);
    expect((await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"))).equals(config)).toBe(true);
  });

  it("AC-044-04 직전 버전이 unlocked였으면 설정·launch spec·Version State만 되돌리고 정확한 artifact를 보장하지 않는다고 표시하며 Health·승인 규칙은 같다", async () => {
    const { h } = await updatedHarness("memory-mcp", CLAUDE);
    expect((await entry(h)).previous?.artifact.resolved).toBeNull();
    const e = envFor(h);
    const request = requestOf(h, "memory-mcp", "rollback", CLAUDE);
    const planned = await planOf(request, e.env);
    expect(planned.plan.target.identity).toBeNull();
    expect(planned.plan.approvalRequirements).toEqual(["base", "health-execution", "rollback-to-previous"]);
    expect(planned.plan.healthPolicy.gate).toBe("required");
    expect(planned.plan.steps.map((s) => s.kind)).toEqual(["config-replace", "health", "state-commit"]);
    expect(planned.plan.warnings).toContainEqual({ code: "rollback-artifact-unlocked", message: ROLLBACK_UNLOCKED_NOTICE });
    const preview = formatLifecyclePlanPreview(planned).join("\n");
    expect(preview).toContain("되돌릴 버전  @modelcontextprotocol/server-memory (고정되지 않음)");
    expect(preview).toContain(ROLLBACK_UNLOCKED_NOTICE);
    const result = await runLifecycleTransaction(planned, await approve(planned), request, e.env);
    expect(result).toMatchObject({ status: "rolled-back", artifact: { to: null } });
    expect(result.warnings).toContainEqual({ code: "rollback-artifact-unlocked", message: ROLLBACK_UNLOCKED_NOTICE });
    const lines = formatLifecycleResult(result).join("\n");
    expect(lines).toContain(ROLLBACK_UNLOCKED_NOTICE);
    for (const text of [preview, lines]) expect(text).not.toMatch(/locked rollback|정확한 이전 버전으로 복구|artifact-locked/u);
    expect((await entry(h)).artifact.resolved).toBeNull();
    const status = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false });
    expect(status.ok && status.items[0]?.artifact?.lock).toBe("artifact-unlocked");
    // 직전 버전이 고정돼 있었으면(update 2회 뒤) 이 고지가 없다.
    const locked = await updatedHarness("github-mcp-server", CURSOR, [D1, D2]);
    expect((await planOf(requestOf(locked.h, "github-mcp-server", "rollback", CURSOR), envFor(locked.h).env)).plan.warnings.map((x) => x.code)).not.toContain("rollback-artifact-unlocked");
  });

  it("AC-044-08 Manifest rollback.supported가 false이면 unsupported다", async () => {
    const { h } = await updatedHarness("memory-mcp", CLAUDE);
    const entries = seed.map((e) => (e.manifest.name === "memory-mcp" ? { ...e, manifest: { ...e.manifest, rollback: { supported: false } } } : e));
    const planned = await planOf(requestOf(h, "memory-mcp", "rollback", CLAUDE), envFor(h, { entries }).env);
    expect([planned.plan.status, planned.plan.steps, planned.plan.warnings.map((w) => w.code)]).toEqual(["unsupported", [], ["ROLLBACK_UNSUPPORTED"]]);
    expect(await requestLifecycleApproval(planned, { channel: "cli-tty", confirm: async () => ["base"] })).toMatchObject({ status: "not-approvable", code: "PLAN_NOT_EXECUTABLE" });
  });
});

