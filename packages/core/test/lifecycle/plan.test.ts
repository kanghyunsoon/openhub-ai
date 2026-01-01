import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  commitLifecycleState,
  executeWithLifecycleApproval,
  isVerifiedLifecyclePlan,
  isVerifiedPlan,
  lifecyclePlanDigest,
  lifecyclePlanSchema,
  planLifecycle,
  readLifecycleState,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  serializeLifecyclePlan,
  verifyApprovedLifecyclePlan,
  verifyApprovedPlan,
  HEALTH_GATE_SKIP_NOTICE,
  type InstallRequest,
  type LifecycleApprovalRequirement,
  type LifecyclePlanOptions,
  type LifecyclePlanResult,
  type PlannedLifecycle,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { REPO_ROOT, seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/** TASK-040 LifecyclePlan v1·Approval kernel·PLAN_STALE. 가짜 registry fetch와 임시 project·home만 쓴다. */
const seed = await seedEntries();
const scratch = await newScratch("lifecycle-plan-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const NOW = () => new Date("2026-10-07T01:02:03.000Z");
const DIGEST = "sha256:" + "d".repeat(64);

function registry(versions: { memory?: string; postgres?: string } = {}) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    if (url === "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest") return json({ name: "@modelcontextprotocol/server-memory", version: versions.memory ?? "1.2.3" });
    if (url === "https://pypi.org/pypi/postgres-mcp/json") return json({ info: { name: "postgres-mcp", version: versions.postgres ?? "0.3.0" } });
    if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
    if (url === "https://ghcr.io/v2/github/github-mcp-server/manifests/latest") return new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
    return new Response("missing", { status: 404 });
  });
  return { fetch, calls };
}

async function installed(h: Harness, toolId: string, targets: InstallRequest["targets"], includeHost = false) {
  const request = h.request(toolId, targets, includeHost);
  const planned = await plannedOf(h, request);
  const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
  expect(result.status).toBe("succeeded");
  expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: NOW })).toMatchObject({ ok: true });
}
const options = (h: Harness, over: Partial<LifecyclePlanOptions> = {}): LifecyclePlanOptions => ({
  operation: "update",
  toolId: "memory-mcp",
  projectRoot: h.projectRoot,
  homeDir: h.homeDir,
  entries: seed,
  platform: "linux",
  includeUser: false,
  fetch: registry().fetch,
  ...(h.env.configFs === undefined ? {} : { fs: h.env.configFs }),
  ...over,
});
const planned = (r: LifecyclePlanResult): PlannedLifecycle => {
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
};
async function approve(p: PlannedLifecycle, skip: readonly LifecycleApprovalRequirement[] = []) {
  const outcome = await requestLifecycleApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id).filter((id) => !skip.includes(id)) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  return outcome.approval;
}
async function memoryHarness() {
  const h = await createHarness(scratch, { entries: seed });
  await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
  h.reset();
  return h;
}
async function editState(h: Harness, edit: (e: Record<string, any>) => void) {
  const read = await readLifecycleState({ homeDir: h.homeDir });
  if (!read.ok) throw new Error(read.code);
  const next = structuredClone(read.state);
  for (const e of Object.values(next.entries)) edit(e as Record<string, any>);
  expect(await commitLifecycleState(next, read.digest, { homeDir: h.homeDir })).toMatchObject({ ok: true });
}

describe("REQ-040 LifecyclePlan v1·Approval·PLAN_STALE", () => {
  it("AC-040-01 strict schema는 모르는 key를 거부하고 digest에 target resolved identity가 들어간다", async () => {
    const h = await memoryHarness();
    const p = planned(await planLifecycle(options(h)));
    expect(p.plan.status).toBe("ready");
    expect(p.plan.current).toMatchObject({ requested: "@modelcontextprotocol/server-memory", identity: null });
    expect(p.plan.target).toEqual({
      requested: "@modelcontextprotocol/server-memory",
      identity: { kind: "npm-package", spec: "@modelcontextprotocol/server-memory@1.2.3", version: "1.2.3", digest: null, integrity: null, source: "npm-registry" },
      clientSpec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@1.2.3"] },
    });
    expect(p.plan.steps.map((s) => s.kind)).toEqual(["config-replace", "health", "state-commit"]);
    expect(p.plan.steps[0]).toMatchObject({ path: ["mcpServers", "memory"], value: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@1.2.3"] } });
    expect(lifecyclePlanSchema.safeParse({ ...p.plan, extra: true }).success).toBe(false);
    expect(lifecyclePlanSchema.safeParse({ ...p.plan, target: { ...p.plan.target, note: "x" } }).success).toBe(false);
    expect(lifecyclePlanSchema.safeParse({ ...p.plan, targets: [{ ...p.plan.targets[0]!, file: "/home/someone/.mcp.json" }] }).success).toBe(false);
    const altered = structuredClone(p.plan);
    altered.target.identity!.version = "1.2.4";
    expect(lifecyclePlanDigest(altered)).not.toBe(p.planDigest);
    expect(lifecyclePlanDigest(p.plan)).toBe(p.planDigest);
  });

  it("AC-040-02 같은 state·fake resolver 입력이면 Plan byte와 digest가 같다", async () => {
    const h = await memoryHarness();
    const a = planned(await planLifecycle(options(h)));
    const b = planned(await planLifecycle(options(h, { fetch: registry().fetch })));
    expect(serializeLifecyclePlan(b.plan)).toBe(serializeLifecyclePlan(a.plan));
    expect(b.planDigest).toBe(a.planDigest);
    const c = planned(await planLifecycle(options(h, { fetch: registry({ memory: "1.2.4" }).fetch })));
    expect(c.planDigest).not.toBe(a.planDigest);
  });

  it("AC-040-03 공통 kernel이 LifecyclePlan을 승인·검증하고 InstallPlan 경로와 승인 객체를 섞지 않는다", async () => {
    const h = await memoryHarness();
    const regen = () => planLifecycle(options(h));
    const p = planned(await regen());
    const approval = await approve(p);
    const gate = await verifyApprovedLifecyclePlan(approval, regen);
    expect(gate.ok).toBe(true);
    if (!gate.ok) return;
    expect(isVerifiedLifecyclePlan(gate.verified)).toBe(true);
    expect(isVerifiedPlan(gate.verified)).toBe(false);
    expect(gate.verified.acknowledgements).toEqual(["base", "health-execution"]);

    // InstallPlan 경로는 같은 kernel 위에서 M4와 똑같이 동작한다. 종류가 다른 Approval은 서로의 gate를 통과하지 못한다.
    const request = h.request("chrome-devtools-mcp", [{ client: "claude-code", scope: "project" }]);
    const install = await plannedOf(h, request);
    const installApproval = await approveAll(install);
    expect(await verifyApprovedLifecyclePlan(installApproval as never, regen)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const lifecycleApproval = await approve(p);
    expect(await verifyApprovedPlan(lifecycleApproval as never, () => install)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const installGate = await verifyApprovedPlan(installApproval, () => plannedOf(h, request));
    expect(installGate.ok && isVerifiedPlan(installGate.verified) && !isVerifiedLifecyclePlan(installGate.verified)).toBe(true);
  });

  it("AC-040-04 승인 후 resolver가 다른 버전을 돌려주면 PLAN_STALE{resolution}이고 spawn·write가 0회다", async () => {
    const h = await memoryHarness();
    const approval = await approve(planned(await planLifecycle(options(h))));
    const effect = vi.fn(async () => "ran");
    const r = await executeWithLifecycleApproval(approval, () => planLifecycle(options(h, { fetch: registry({ memory: "1.3.0" }).fetch })), effect);
    expect(r).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(!r.ok && r.changed).toContain("resolution");
    expect(effect).not.toHaveBeenCalled();
    expect(h.spawns).toEqual([]);
    expect(h.writes).toEqual([]);
    // 소모된 Approval은 다시 쓸 수 없다.
    expect(await executeWithLifecycleApproval(approval, () => planLifecycle(options(h)), effect)).toMatchObject({ ok: false, code: "APPROVAL_CONSUMED" });
  });

  it("AC-040-05 승인 후 state revision이 바뀌면 changed에 state가 있다", async () => {
    const h = await memoryHarness();
    const approval = await approve(planned(await planLifecycle(options(h))));
    await editState(h, (e) => (e["revision"] = 2));
    const r = await verifyApprovedLifecyclePlan(approval, () => planLifecycle(options(h)));
    expect(r).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(!r.ok && r.changed).toContain("state");
  });

  it("AC-040-06 승인 후 config 항목을 수정하면 changed에 config-precondition이 있다", async () => {
    const h = await memoryHarness();
    const approval = await approve(planned(await planLifecycle(options(h))));
    const file = path.join(h.projectRoot, ".mcp.json");
    const doc = JSON.parse(await readFile(file, "utf8"));
    doc.mcpServers.memory.args.push("--verbose");
    await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
    const r = await verifyApprovedLifecyclePlan(approval, () => planLifecycle(options(h)));
    expect(r).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(!r.ok && r.changed).toContain("config-precondition");
  });

  it("AC-040-07 approvalRequirements가 §8 규칙과 같고 required env가 없으면 Health 생략을 거부한다", async () => {
    const h = await memoryHarness();
    expect(planned(await planLifecycle(options(h))).plan.approvalRequirements).toEqual(["base", "health-execution"]);
    expect(await planLifecycle(options(h, { skipHealth: true }))).toMatchObject({ ok: false, code: "HEALTH_SKIP_NOT_ALLOWED" });
    expect(await planLifecycle(options(h, { operation: "health", skipHealth: true }))).toMatchObject({ ok: false, code: "HEALTH_SKIP_NOT_ALLOWED" });
    const health = planned(await planLifecycle(options(h, { operation: "health" })));
    expect([health.plan.approvalRequirements, health.plan.steps.map((s) => s.kind)]).toEqual([["base", "health-execution"], ["health", "health-record"]]);

    const pg = await createHarness(scratch, { entries: seed });
    await installed(pg, "postgres-mcp", [{ client: "claude-code", scope: "project" }]);
    const pgOptions = options(pg, { toolId: "postgres-mcp" });
    const required = planned(await planLifecycle(pgOptions)).plan;
    expect(required.approvalRequirements).toEqual(["base", "health-execution", "environment-unverified"]);
    expect(required.target.clientSpec).toEqual({ command: "uvx", args: ["postgres-mcp==0.3.0", "--access-mode=restricted"] });
    const skipped = planned(await planLifecycle({ ...pgOptions, skipHealth: true })).plan;
    expect(skipped.approvalRequirements).toEqual(["base", "environment-unverified", "health-gate-skipped"]);
    expect([skipped.healthPolicy.gate, skipped.steps.map((s) => s.kind)]).toEqual(["skipped-by-approval", ["config-replace", "state-commit"]]);
    expect(skipped.warnings).toContainEqual({ code: "health-gate-skipped", message: HEALTH_GATE_SKIP_NOTICE });

    const user = await createHarness(scratch, { entries: seed });
    await installed(user, "memory-mcp", [{ client: "cursor", scope: "user" }], true);
    expect(planned(await planLifecycle(options(user, { includeUser: true }))).plan.approvalRequirements).toEqual(["base", "health-execution", "user-scope-config"]);
    expect(await planLifecycle(options(user))).toMatchObject({ ok: false, code: "NOT_MANAGED" });

    const docker = await createHarness(scratch, { entries: seed });
    await installed(docker, "github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const d = planned(await planLifecycle(options(docker, { toolId: "github-mcp-server" }))).plan;
    expect(d.steps.map((s) => s.kind)).toEqual(["run", "config-replace", "health", "state-commit"]);
    expect(d.steps[0]).toMatchObject({ executable: "docker", args: ["pull", "ghcr.io/github/github-mcp-server@" + DIGEST] });

    // 승인 항목 하나라도 빠지면 실행할 수 없다.
    const missing = await approve(planned(await planLifecycle(pgOptions)), ["environment-unverified"]);
    expect(await verifyApprovedLifecyclePlan(missing, () => planLifecycle(pgOptions))).toMatchObject({ ok: false, code: "APPROVAL_INCOMPLETE", missing: ["environment-unverified"] });
  });

  it("AC-040-08 current와 target identity가 같으면 up-to-date이고 steps 0개이며 승인할 수 없다", async () => {
    const h = await memoryHarness();
    await editState(h, (e) => {
      e["artifact"]["resolved"] = { kind: "npm-package", spec: "@modelcontextprotocol/server-memory@1.2.3", version: "1.2.3", digest: null, integrity: null, source: "npm-registry" };
    });
    const p = planned(await planLifecycle(options(h)));
    expect([p.plan.status, p.plan.steps, p.plan.approvalRequirements]).toEqual(["up-to-date", [], ["base"]]);
    expect(await requestLifecycleApproval(p, { channel: "cli-tty", confirm: async () => ["base"] })).toMatchObject({ status: "not-approvable", code: "PLAN_NOT_EXECUTABLE" });
    expect(planned(await planLifecycle(options(h, { fetch: registry({ memory: "1.2.4" }).fetch }))).plan.status).toBe("ready");
  });

  // M6 TASK-058(D-028): M1 approvePlan을 삭제해 "@deprecated 표시" 확인은 "삭제됨" 확인으로 바꿨다. 보장(직접 만든 승인은 gate 통과 불가)은 같다.
  it("AC-040-09 Core가 발급하지 않은 승인 객체로는 lifecycle gate를 통과할 수 없고 M1 approvePlan은 삭제됐다", async () => {
    const h = await memoryHarness();
    const regen = () => planLifecycle(options(h));
    const p = planned(await regen());
    const legacy = { planDigest: p.planDigest, approvedBy: "someone", approvedAt: new Date(0).toISOString() };
    expect(await verifyApprovedLifecyclePlan(legacy as never, regen)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const forged = { planDigest: p.planDigest, acknowledgements: ["base", "health-execution"], channel: "cli-tty" } as const;
    expect(await verifyApprovedLifecyclePlan(forged, regen)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const source = await readFile(path.join(REPO_ROOT, "packages/core/src/installer/approval.ts"), "utf8");
    expect(source).not.toMatch(/export (?:function|class) (?:approvePlan|assertApproved|ApprovalMismatchError|planDigest)\b/u);
  });

  it("AC-040-10 config-drift·untracked-foreign이면 blocked(CONFIG_DRIFT)이고 resolver를 부르지 않으며 승인할 수 없다", async () => {
    const h = await memoryHarness();
    const file = path.join(h.projectRoot, ".mcp.json");
    const original = await readFile(file, "utf8");
    await writeFile(file, original.replace("@modelcontextprotocol/server-memory", "@modelcontextprotocol/server-memory@0.9.0"));
    const net = registry();
    const drift = planned(await planLifecycle(options(h, { fetch: net.fetch })));
    expect([drift.plan.status, drift.plan.steps, drift.plan.warnings.map((w) => w.code)]).toEqual(["blocked", [], ["CONFIG_DRIFT"]]);
    expect(net.calls).toEqual([]);
    expect(await requestLifecycleApproval(drift, { channel: "cli-tty", confirm: async () => ["base"] })).toMatchObject({ status: "not-approvable", code: "PLAN_NOT_EXECUTABLE" });

    await writeFile(file, original);
    await mkdir(path.join(h.projectRoot, ".cursor"), { recursive: true });
    await writeFile(path.join(h.projectRoot, ".cursor", "mcp.json"), '{ "mcpServers": { "memory": { "command": "node", "args": ["server.js"] } } }\n');
    const foreign = planned(
      await planLifecycle(options(h, { targets: [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "project" }] })),
    );
    expect(foreign.plan.status).toBe("blocked");
    expect(foreign.plan.warnings.find((w) => w.code === "CONFIG_DRIFT")?.message).toContain("untracked-foreign");

    await rm(file);
    expect(planned(await planLifecycle(options(h))).plan.warnings.map((w) => w.code)).toEqual(["MISSING_CONFIG"]);
  });
});

