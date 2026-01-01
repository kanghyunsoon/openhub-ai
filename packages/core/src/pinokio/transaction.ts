import path from "node:path";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import type { FetchLike } from "../discovery/github";
import { ConfigWriteError, applyLoopbackHttpEntry, atomicWrite, nodeConfigFs, restoreConfig, type ConfigFs, type ConfigWriteReceipt } from "../installer/config-writer";
import { CONFIG_SCOPES, INSTALL_CLIENTS, canonicalize } from "../installer/plan";
import { spawnPterm, ptermInvocation, type PtermLaunch, type PtermRun } from "../process/pterm";
import type { ExecSpawner } from "../process/executor";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";
import { PINOKIO_SCRIPT_NAMES, type PinokioScriptName } from "./compiler";
import { loopbackGet } from "./http";
import {
  PINOKIO_OPERATIONS,
  VENV_NOT_RESTORED_NOTICE,
  isVerifiedPinokioPlan,
  readAppState,
  resolveAppFolder,
  resolvePinokioHome,
  verifyPinokioApproval,
  type PinokioApproval,
  type PinokioGateFailure,
  type PlannedPinokio,
  type VerifiedPinokioPlan,
} from "./plan";
import { PINOKIO_HEALTH_STATUSES, commitPinokioState, readPinokioState, type PinokioHealthStatus, type PinokioToolCore } from "./state";

/**
 * Pinokio 실행·Health·Lifecycle(TASK-053, D-027).
 * - VerifiedPinokioPlan(공통 kernel 발급)만 받는다. 없으면 APPROVAL_REQUIRED이고 spawn·write가 0회다. 같은 VerifiedPlan은 한 번만 쓴다.
 * - app 폴더는 `<PINOKIO_HOME>/api/openhub-<toolId>`만. 실행 직전 다시 해석하고 symlink·junction escape를 거부한다. 쓰는 파일은
 *   `openhub-install.js`·`openhub-start.js`·`openhub-update.js`(와 그 `.done` 완료 표시 정리)뿐이며 원본 byte 영수증으로 되돌린다.
 * - 성공 판정은 pterm exit code가 아니라 완료 표시 파일(marker)과 Health다.
 * - Health(필수): `pterm start openhub-start.js` → loopback GET 기대 status → `pterm stop`. 정리 실패도 Health 실패다. 앱을 상주시키지 않는다.
 * - Health·config·state 단계가 실패하면 config를 되돌리고, update·rollback은 승인된 recovery script로 이전 commit을 다시 checkout하며,
 *   생성 script를 원본 byte로 복구하고 Pinokio state를 바꾸지 않는다.
 * - 결과·state·로그에 절대 경로·env 값·token이 없다. pinokiod 셸 출력은 보관하지 않는다.
 */

export interface PinokioTimeouts {
  runMs: number;
  healthMs: number;
  pollMs: number;
  stopMs: number;
}
export const PINOKIO_TIMEOUTS: Readonly<PinokioTimeouts> = Object.freeze({ runMs: 30 * 60_000, healthMs: 120_000, pollMs: 1000, stopMs: 15_000 });
export const PINOKIO_LEFTOVER_NOTICE = "Pinokio가 만든 app·env 폴더는 남아 있을 수 있습니다. 필요하면 Pinokio에서 직접 정리하세요.";
const APP_FILES = [...PINOKIO_SCRIPT_NAMES, ...PINOKIO_SCRIPT_NAMES.map((n) => n.replace(/\.js$/u, ".done"))].sort();
const doneOf = (name: PinokioScriptName) => name.replace(/\.js$/u, ".done");

const text = z.string().min(1).max(300);
const strings = (value: unknown, p: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path: p, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...p, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...p, k]));
  return [];
};
export const pinokioResultSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("pinokio-result"),
    operation: z.enum(PINOKIO_OPERATIONS),
    toolId: text,
    status: z.enum(["succeeded", "failed"]),
    code: text.nullable(),
    commit: z.string().regex(/^[0-9a-f]{40}$/u),
    health: z.strictObject({ status: z.enum(PINOKIO_HEALTH_STATUSES), httpStatus: z.number().int().nullable() }).nullable(),
    steps: z.array(z.strictObject({ id: text, status: z.enum(["done", "failed", "skipped"]) })),
    recovered: z.boolean().nullable(),
    config: z.array(z.strictObject({ client: z.enum(INSTALL_CLIENTS), scope: z.enum(CONFIG_SCOPES), file: text, status: z.enum(["written", "manual-setup-required", "failed", "restored"]) })),
    stateRevision: z.number().int().nullable(),
    notices: z.array(z.strictObject({ code: text, message: z.string().min(1).max(500) })),
  })
  .superRefine((r, ctx) => {
    for (const found of strings(r)) {
      const problem = containsAbsolutePath(found.value) ? "절대 경로" : URL_CREDENTIAL_PATTERN.test(found.value) ? "URL credential" : TOKEN_PATTERN.test(found.value) ? "token" : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: "Pinokio 결과에 " + problem + "이(가) 포함될 수 없습니다" });
    }
  });
export type PinokioResultV1 = z.output<typeof pinokioResultSchema>;
export function serializePinokioResult(result: PinokioResultV1): string {
  return JSON.stringify(canonicalize(pinokioResultSchema.parse(result)), null, 2) + "\n";
}

export interface PinokioExecuteOptions {
  /** 비실행 probe가 찾은 node·pterm index.js(planPinokio 결과의 entry) */
  entry: PtermLaunch;
  /** OpenHub state home(~/.openhub)과 user config root */
  homeDir: string;
  /** project config root(HTTP MCP project 항목) */
  projectRoot?: string;
  fetch?: FetchLike;
  fs?: ConfigFs;
  spawner?: ExecSpawner;
  now?: () => Date;
  timeouts?: Partial<PinokioTimeouts>;
}
export type PinokioExecuteReport = { ok: true; result: PinokioResultV1 } | { ok: false; code: "APPROVAL_REQUIRED" | "VERIFIED_PLAN_CONSUMED"; message: string };

const used = new WeakSet<object>();
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number) => Promise.race([p, sleep(ms).then(() => "timeout" as const)]);

interface Ctx {
  verified: VerifiedPinokioPlan;
  options: PinokioExecuteOptions;
  fs: ConfigFs;
  timeouts: PinokioTimeouts;
  dir: string;
  steps: PinokioResultV1["steps"];
}

async function readOptional(fs: ConfigFs, file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
}

/** pterm start <script>를 실행하고 끝나기를 기다린 뒤 완료 표시를 확인한다(exit code는 판정에 쓰지 않는다). */
async function runScript(ctx: Ctx, script: PinokioScriptName, marker: string): Promise<boolean> {
  await ctx.fs.rm(path.join(ctx.dir, doneOf(script))).catch(() => undefined);
  const run = spawnPterm(ptermInvocation(ctx.verified, ctx.options.entry, "start", script), { cwd: ctx.dir, ...(ctx.options.spawner === undefined ? {} : { spawner: ctx.options.spawner }) });
  const exited = await withTimeout(run.exited, ctx.timeouts.runMs);
  if (exited === "timeout") {
    run.child.kill();
    return false;
  }
  const done = await readOptional(ctx.fs, path.join(ctx.dir, doneOf(script)));
  return done !== null && done.toString("utf8").trim() === marker;
}

async function runHealth(ctx: Ctx): Promise<{ status: PinokioHealthStatus; httpStatus: number | null }> {
  const plan = ctx.verified.plan;
  const spawnOpts = { cwd: ctx.dir, ...(ctx.options.spawner === undefined ? {} : { spawner: ctx.options.spawner }) };
  let start: PtermRun;
  try {
    start = spawnPterm(ptermInvocation(ctx.verified, ctx.options.entry, "start", "openhub-start.js"), spawnOpts);
  } catch {
    return { status: "launch-failed", httpStatus: null };
  }
  let launchFailed = false;
  let startExited = false;
  void start.exited.then((r) => {
    startExited = true;
    if (r.error) launchFailed = true;
  });
  let healthy = false;
  let httpStatus: number | null = null;
  const deadline = Date.now() + ctx.timeouts.healthMs;
  while (Date.now() < deadline && !launchFailed) {
    const res = await loopbackGet(plan.health.url, { ...(ctx.options.fetch === undefined ? {} : { fetch: ctx.options.fetch }), timeoutMs: Math.min(1000, ctx.timeouts.healthMs) });
    if (res.ok) {
      httpStatus = res.status;
      if (res.status === plan.health.expectStatus) {
        healthy = true;
        break;
      }
    }
    await sleep(ctx.timeouts.pollMs);
  }
  // 결과와 무관하게 항상 정리한다. 정리 실패는 Health 실패다.
  let cleanupOk = false;
  try {
    const stop = spawnPterm(ptermInvocation(ctx.verified, ctx.options.entry, "stop", "openhub-start.js"), spawnOpts);
    const stopped = await withTimeout(stop.exited, ctx.timeouts.stopMs);
    const startDone = startExited ? "done" : await withTimeout(start.exited.then(() => "done" as const), ctx.timeouts.stopMs);
    cleanupOk = stopped !== "timeout" && !stopped.error && startDone !== "timeout";
    if (stopped === "timeout") stop.child.kill();
  } catch {
    cleanupOk = false;
  }
  if (!cleanupOk) {
    start.child.kill();
    ctx.steps.push({ id: "health-stop", status: "failed" });
    return { status: "cleanup-failed", httpStatus };
  }
  ctx.steps.push({ id: "health-stop", status: "done" });
  if (healthy) return { status: "healthy", httpStatus };
  if (launchFailed) return { status: "launch-failed", httpStatus };
  return { status: httpStatus === null ? "timeout" : "unhealthy", httpStatus };
}

/** 승인된 VerifiedPinokioPlan을 실행한다. */
export async function executePinokioPlan(verified: VerifiedPinokioPlan, options: PinokioExecuteOptions): Promise<PinokioExecuteReport> {
  if (!isVerifiedPinokioPlan(verified)) return { ok: false, code: "APPROVAL_REQUIRED", message: "사람이 승인하고 실행 직전 검증을 통과한 PinokioPlan이 없습니다" };
  if (used.has(verified)) return { ok: false, code: "VERIFIED_PLAN_CONSUMED", message: "이미 실행한 VerifiedPlan입니다. 다시 승인하세요" };
  used.add(verified);
  const plan = verified.plan;
  const fs = options.fs ?? nodeConfigFs;
  const timeouts = { ...PINOKIO_TIMEOUTS, ...(options.timeouts ?? {}) };
  const now = options.now ?? (() => new Date());
  const steps: PinokioResultV1["steps"] = [];
  const config: PinokioResultV1["config"] = [];
  const notices: PinokioResultV1["notices"] = [];
  if (plan.operation === "rollback") notices.push({ code: "venv-not-restored", message: VENV_NOT_RESTORED_NOTICE });
  for (const t of plan.configTargets.filter((x) => x.mode === "manual-setup-required")) config.push({ client: t.client, scope: t.scope, file: t.file, status: "manual-setup-required" });
  const finish = (status: "succeeded" | "failed", code: string | null, extra: Partial<Pick<PinokioResultV1, "health" | "recovered" | "stateRevision">> = {}): PinokioExecuteReport => ({
    ok: true,
    result: pinokioResultSchema.parse({
      schemaVersion: 1,
      kind: "pinokio-result",
      operation: plan.operation,
      toolId: plan.toolId,
      status,
      code,
      commit: plan.commit,
      health: extra.health ?? null,
      steps,
      recovered: extra.recovered ?? null,
      config,
      stateRevision: extra.stateRevision ?? null,
      notices,
    }),
  });

  // 1. 설치 상태 전제(Plan이 본 상태와 같아야 한다)
  const read = await readPinokioState({ homeDir: options.homeDir, fs });
  if (!read.ok) return finish("failed", read.code);
  const current = read.state.entries[plan.toolId] ?? null;
  const expectedCommit = plan.operation === "install" ? null : plan.operation === "health" ? plan.commit : plan.previousCommit;
  if ((current?.commit ?? null) !== expectedCommit) return finish("failed", "PLAN_STALE");

  // 2. app 폴더 재확인(실행 직전)
  const home = await resolvePinokioHome({ fs, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
  if (!home.ok) return finish("failed", home.code);
  const appId = plan.appRef.slice("api/".length);
  const folder = await resolveAppFolder(home.home, appId, fs);
  if (!folder.ok) return finish("failed", folder.code);
  if ((await readAppState(folder, fs)).digest !== plan.appState.digest) return finish("failed", "PLAN_STALE");
  if (!folder.exists) {
    if (plan.operation !== "install") return finish("failed", "PINOKIO_APP_MISSING");
    try {
      await fs.mkdir(folder.dir);
    } catch {
      return finish("failed", "PINOKIO_WRITE_FAILED");
    }
    const again = await resolveAppFolder(home.home, appId, fs);
    if (!again.ok || !again.exists || again.dir !== folder.dir) return finish("failed", "PINOKIO_PATH_ESCAPE");
  }
  steps.push({ id: "app-folder", status: "done" });
  const ctx: Ctx = { verified, options, fs, timeouts, dir: folder.dir, steps };

  // 3. 영수증 → 생성 script 쓰기
  const originals = new Map<string, Buffer | null>();
  for (const name of APP_FILES) originals.set(name, await readOptional(fs, path.join(folder.dir, name)));
  const restoreFiles = async (): Promise<boolean> => {
    let ok = true;
    for (const [name, bytes] of originals) {
      const file = path.join(folder.dir, name);
      try {
        if (bytes === null) await fs.rm(file);
        else if (!(await readOptional(fs, file))?.equals(bytes)) await atomicWrite(fs, file, bytes);
      } catch {
        ok = false;
      }
    }
    return ok;
  };
  const toWrite = plan.operation === "health" ? plan.scripts.filter((s) => s.name === "openhub-start.js") : plan.scripts;
  try {
    for (const s of toWrite) {
      const file = path.join(folder.dir, s.name);
      await fs.rm(file).catch(() => undefined);
      await atomicWrite(fs, file, Buffer.from(s.content, "utf8"));
    }
    steps.push({ id: "write-scripts", status: "done" });
  } catch {
    steps.push({ id: "write-scripts", status: "failed" });
    return finish("failed", "PINOKIO_WRITE_FAILED", { recovered: await restoreFiles() });
  }

  const recover = async (): Promise<boolean> => {
    let ok = true;
    if (plan.recovery !== null) {
      try {
        const file = path.join(folder.dir, "openhub-update.js");
        await fs.rm(file).catch(() => undefined);
        await atomicWrite(fs, file, Buffer.from(plan.recovery.content, "utf8"));
        ok = await runScript(ctx, "openhub-update.js", plan.recovery.marker);
      } catch {
        ok = false;
      }
      steps.push({ id: "recovery", status: ok ? "done" : "failed" });
    } else if (plan.operation === "install") notices.push({ code: "app-folder-leftover", message: PINOKIO_LEFTOVER_NOTICE });
    return (await restoreFiles()) && ok;
  };

  // 4. install·update·rollback script 실행(완료 표시로 판정)
  if (plan.run.script !== null) {
    const marker = plan.scripts.find((s) => s.name === plan.run.script)!.marker;
    const ok = await runScript(ctx, plan.run.script, marker).catch(() => false);
    steps.push({ id: "run:" + plan.run.script, status: ok ? "done" : "failed" });
    if (!ok) return finish("failed", "PINOKIO_RUN_INCOMPLETE", { recovered: await recover() });
  }

  // 5. Health(필수)
  await fs.rm(path.join(folder.dir, "openhub-start.done")).catch(() => undefined);
  const health = await runHealth(ctx);
  steps.push({ id: "health", status: health.status === "healthy" ? "done" : "failed" });
  const checkedAt = now().toISOString();
  if (plan.operation === "health") {
    // 단독 Health는 관찰만 기록한다(revision·commit은 그대로).
    const restored = await restoreFiles();
    if (current !== null) {
      const next = structuredClone(read.state);
      next.entries[plan.toolId] = { ...current, lastHealth: { status: health.status, checkedAt } };
      const committed = await commitPinokioState(next, read.digest, { homeDir: options.homeDir, fs });
      steps.push({ id: "state-commit", status: committed.ok ? "done" : "failed" });
    }
    return finish(health.status === "healthy" ? "succeeded" : "failed", health.status === "healthy" ? null : "PINOKIO_HEALTH_FAILED", { health, recovered: restored, stateRevision: current?.revision ?? null });
  }
  if (health.status !== "healthy") return finish("failed", "PINOKIO_HEALTH_FAILED", { health, recovered: await recover() });

  // 6. HTTP MCP config(install, write 대상만)
  const receipts: ConfigWriteReceipt[] = [];
  const roots = { projectRoot: options.projectRoot ?? options.homeDir, homeDir: options.homeDir, fs };
  for (const t of plan.configTargets.filter((x) => x.mode === "write" && x.entry !== null)) {
    if (t.scope === "project" && options.projectRoot === undefined) {
      config.push({ client: t.client, scope: t.scope, file: t.file, status: "failed" });
      continue;
    }
    try {
      receipts.push(await applyLoopbackHttpEntry({ client: t.client, scope: t.scope, serverName: t.serverName, url: t.entry!.url }, { ...roots, userScopeApproved: verified.acknowledgements.includes("user-scope-config") }));
      config.push({ client: t.client, scope: t.scope, file: t.file, status: "written" });
    } catch (error) {
      for (const r of receipts.reverse()) await restoreConfig(r, fs);
      for (const c of config) if (c.status === "written") c.status = "restored";
      config.push({ client: t.client, scope: t.scope, file: t.file, status: "failed" });
      steps.push({ id: "config", status: "failed" });
      return finish("failed", error instanceof ConfigWriteError ? error.code : "CONFIG_WRITE_FAILED", { health, recovered: await recover() });
    }
  }
  if (config.some((c) => c.status === "failed")) {
    for (const r of receipts.reverse()) await restoreConfig(r, fs);
    for (const c of config) if (c.status === "written") c.status = "restored";
    steps.push({ id: "config", status: "failed" });
    return finish("failed", "CONFIG_WRITE_FAILED", { health, recovered: await recover() });
  }
  if (receipts.length > 0) steps.push({ id: "config", status: "done" });

  // 7. Pinokio state commit(CAS)
  const digestOf = (name: PinokioScriptName) => plan.scripts.find((s) => s.name === name)!.digest;
  const core: PinokioToolCore = {
    toolId: plan.toolId,
    appRef: plan.appRef,
    repo: plan.repo,
    commit: plan.commit,
    revision: (current?.revision ?? 0) + 1,
    scriptDigests: { install: digestOf("openhub-install.js"), start: digestOf("openhub-start.js"), update: digestOf("openhub-update.js") },
    versions: { ...plan.versions },
    appliedPlanDigest: verified.planDigest,
    committedAt: checkedAt,
  };
  const previous: PinokioToolCore | null =
    current === null ? null : { toolId: current.toolId, appRef: current.appRef, repo: current.repo, commit: current.commit, revision: current.revision, scriptDigests: current.scriptDigests, versions: current.versions, appliedPlanDigest: current.appliedPlanDigest, committedAt: current.committedAt };
  const next = structuredClone(read.state);
  next.entries[plan.toolId] = { ...core, lastHealth: { status: "healthy", checkedAt }, previous };
  const committed = await commitPinokioState(next, read.digest, { homeDir: options.homeDir, fs });
  if (!committed.ok) {
    for (const r of receipts.reverse()) await restoreConfig(r, fs);
    for (const c of config) if (c.status === "written") c.status = "restored";
    steps.push({ id: "state-commit", status: "failed" });
    return finish("failed", committed.code, { health, recovered: await recover() });
  }
  steps.push({ id: "state-commit", status: "done" });
  return finish("succeeded", null, { health, stateRevision: core.revision });
}

/** 검증(재생성·digest 비교)을 통과했을 때만 실행한다. 실패하면 spawn·write가 0회다. */
export async function executeWithPinokioApproval(
  approval: PinokioApproval | undefined,
  regenerate: () => PlannedPinokio | Promise<PlannedPinokio>,
  options: PinokioExecuteOptions,
): Promise<PinokioExecuteReport | PinokioGateFailure> {
  const gate = await verifyPinokioApproval(approval, regenerate);
  if (!gate.ok) return gate;
  return executePinokioPlan(gate.verified, options);
}

