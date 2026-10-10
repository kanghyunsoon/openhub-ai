import type { FetchLike } from "../discovery/github";
import path from "node:path";
import { readConfiguredEntry, restoreConfig, type ConfigFs, type ConfigWriteReceipt } from "../installer/config-writer";
import type { ConfigScope, InstallClient, ServerEntry, ToolConfigStep } from "../installer/plan";
import { toolConfigLocationFor } from "../installer/transaction";
import {
  TOOL_CONFIG_PLACEHOLDER,
  clientLauncherDigest,
  inspectToolConfig,
  materializeClientArgs,
  restoreToolConfig,
  verifyClientLauncher,
  writeToolConfig,
  type LauncherCheckFs,
  type ToolConfigFs,
  type ToolConfigLocation,
  type ToolConfigUndo,
} from "../tool-config/index";
import { executeLifecyclePreparation, type ExecSpawner, type IsolatedDir } from "../process/executor";
import { createTreeKiller, runHealthCheck, type HealthCheckResult, type HealthRunOptions, type HealthRunReport, type HealthSpawner, type TreeKiller, type WindowsNpxLauncher } from "../process/health";
import type { BackendProbeReport } from "../process/probe";
import type { RecommendPlatform } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { replaceConfigEntry } from "./config-replace";
import {
  ROLLBACK_UNLOCKED_NOTICE,
  planLifecycle,
  verifyApprovedLifecyclePlan,
  type ConfigReplaceStep,
  type LifecycleApproval,
  type LifecycleOperation,
  type LifecyclePlanResult,
  type PlannedLifecycle,
  type VerifiedLifecyclePlan,
} from "./plan";
import { lifecycleResultSchema, type LifecycleResultStatus, type LifecycleResultV1 } from "./result";
import { entryKeyOf, type LastHealth, type ToolState, type ToolStateCore } from "./state";
import type { LifecycleStateFile } from "./state";
import { configEntryDigest, tomlBlockDigest } from "./status";
import { LIFECYCLE_STATE_LOGICAL_PATH, commitLifecycleState, projectKeyFor, readLifecycleState } from "./store";

/**
 * Update transaction(TASK-043, D-019·D-020). 순서:
 *   승인 확인 → 실행 직전 재생성(state·config·resolver 재조회)·digest 비교 → probe → 준비(docker pull image@sha256, 정확한 버전 npx는 npx Prepare)
 *   → config 교체(targeted, 영수증) → Health(기본 REQUIRED) → Version State commit(revision+1, previous snapshot).
 * - 같은 승인 안의 실패(준비·config·Health·state commit)는 config 원본 byte 복구 + state 유지로 자동 보상한다.
 *   받은 image·npx cache는 지우지 않는다. 복구까지 실패하면 rollback-failed와 논리 경로 안내다.
 * - Health 실행 후 실패는 모두 update 실패다. skip 전환·강행 API는 없고 재시도는 새 Plan·승인이다.
 * - Health 성공(또는 승인된 skip) 전에는 Version State를 쓰지 않는다. skip이면 lastHealth는 skipped(checkedAt null)다.
 * - uvx update는 config args의 패키지 token 교체와 state 갱신뿐이다. npx는 그 전에 npx Prepare로 정확한 버전을 npx cache에 받는다
 *   (Health 20 s 한도 안에 시작하도록. 끊긴 설치의 불완전 항목은 Prepare가 정리한다).
 */

export type LifecyclePhase = "approval-check" | "regenerate" | "digest-compare" | "probe" | "prepare" | "config-replace" | "health" | "state-commit";

export interface LifecycleRequest {
  operation: LifecycleOperation;
  toolId: string;
  projectRoot: string;
  homeDir: string;
  platform: RecommendPlatform;
  includeUser: boolean;
  targets?: readonly { client: InstallClient; scope: ConfigScope }[];
  to?: string;
  skipHealth?: boolean;
}

export interface LifecycleEnvironment {
  loadEntries(): Promise<readonly RegistryEntry[]>;
  probe(): Promise<BackendProbeReport>;
  /** Health 격리 디렉터리 기준(호출 측이 미리 정한다). */
  tempBase: string;
  now(): Date;
  fetch?: FetchLike;
  timeoutMs?: number;
  configFs?: ConfigFs;
  /** 준비 단계(docker pull) spawner. */
  spawner?: ExecSpawner;
  isolatedDir?: () => Promise<IsolatedDir>;
  healthSpawner?: HealthSpawner;
  killTree?: TreeKiller;
  /** Windows npx Health 실행 경로(probe 단계에서 찾는다). */
  windowsNpx?: () => Promise<WindowsNpxLauncher | null>;
  /** npx Prepare의 npm 자식 process 환경(보통 npmChildEnv(process.env), CLI·Desktop이 넘긴다). 없으면 OS 기본 상속. */
  npmChildEnv?: () => Record<string, string>;
  /** Health 실행기(테스트 주입용). 기본 runHealthCheck. */
  runHealth?: (verified: VerifiedLifecyclePlan, options: HealthRunOptions) => Promise<HealthRunReport>;
  /** operation별 Plan 생성기 교체(테스트 주입용). 기본은 planLifecycle(update·rollback·health). */
  planners?: Partial<Record<LifecycleOperation, (request: LifecycleRequest, env: LifecycleEnvironment) => Promise<LifecyclePlanResult>>>;
  /** OpenHub 관리 tool config 파일 접근(v0.2.0, 테스트 주입용). */
  toolConfigFs?: ToolConfigFs;
  /** Windows Client 직접 실행 경로 검증용 fs(v0.2.0). */
  launcherCheckFs?: LauncherCheckFs;
  trace?: (phase: LifecyclePhase) => void;
}

/** 요청과 환경으로 LifecyclePlan을 만든다. 실행 직전 재생성도 같은 함수를 쓴다. */
export async function planLifecycleRequest(request: LifecycleRequest, env: LifecycleEnvironment): Promise<LifecyclePlanResult> {
  const custom = env.planners?.[request.operation];
  if (custom !== undefined) return custom(request, env);
  return planLifecycle({
    operation: request.operation,
    toolId: request.toolId,
    projectRoot: request.projectRoot,
    homeDir: request.homeDir,
    entries: await env.loadEntries(),
    platform: request.platform,
    includeUser: request.includeUser,
    ...(request.targets === undefined ? {} : { targets: request.targets }),
    ...(request.to === undefined ? {} : { to: request.to }),
    ...(request.skipHealth === undefined ? {} : { skipHealth: request.skipHealth }),
    ...(env.fetch === undefined ? {} : { fetch: env.fetch }),
    ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }),
    ...(env.configFs === undefined ? {} : { fs: env.configFs }),
    ...(env.toolConfigFs === undefined ? {} : { toolConfigFs: env.toolConfigFs }),
    ...(env.windowsNpx === undefined ? {} : { clientLauncher: env.windowsNpx }),
    ...(env.launcherCheckFs === undefined ? {} : { launcherCheckFs: env.launcherCheckFs }),
  });
}

const RESOLVER_CODES = new Set(["RESOLVER_SOURCE_UNSUPPORTED", "RESOLUTION_TIMEOUT", "RESOLUTION_OFFLINE", "RESOLUTION_TOO_LARGE", "RESOLUTION_INVALID"]);
type ResultStep = LifecycleResultV1["steps"][number];
const succeeded = (operation: LifecycleOperation): LifecycleResultStatus =>
  operation === "rollback" ? "rolled-back" : operation === "health" ? "health-checked" : operation === "repair" ? "repaired" : "updated";
const coreOf = (s: ToolState): ToolStateCore => {
  const { previous: _p, lastHealth: _h, ...core } = s;
  return core;
};

interface Draft {
  planned: PlannedLifecycle;
  status: LifecycleResultStatus;
  code?: string;
  changed?: LifecycleResultV1["changed"];
  steps?: ResultStep[];
  applied?: ReadonlySet<string>;
  restored?: ReadonlySet<string>;
  revisions?: ReadonlyMap<string, { before: number | null; after: number | null }>;
  health?: LifecycleResultV1["health"];
  compensated?: boolean;
  stateCommitted?: boolean;
  retryable: boolean;
  nextActions?: string[];
  warnings?: LifecycleResultV1["warnings"];
}

function finalize(d: Draft): LifecycleResultV1 {
  const plan = d.planned.plan;
  return lifecycleResultSchema.parse({
    schemaVersion: 1,
    operation: plan.operation,
    planDigest: d.planned.planDigest,
    toolId: plan.toolId,
    backend: plan.backend,
    status: d.status,
    ...(d.code === undefined ? {} : { code: d.code }),
    ...(d.changed === undefined ? {} : { changed: d.changed }),
    artifact: { from: plan.current.identity?.spec ?? plan.current.requested, to: plan.operation === "health" ? null : (plan.target.identity?.spec ?? null) },
    targets: plan.targets.map((t) => ({
      client: t.client,
      scope: t.scope,
      file: t.file,
      serverName: t.serverName,
      configApplied: d.applied?.has(t.entryKey) ?? false,
      configRestored: d.restored?.has(t.entryKey) ?? false,
      revisionBefore: d.revisions?.get(t.entryKey)?.before ?? t.stateRevision,
      revisionAfter: d.revisions?.get(t.entryKey)?.after ?? null,
    })),
    steps: (d.steps ?? []).map((s) => ({ ...s })),
    health: d.health ?? null,
    compensated: d.compensated ?? false,
    stateCommitted: d.stateCommitted ?? false,
    retryable: d.retryable,
    requiredEnv: plan.requiredEnv.filter((e) => e.required).map((e) => ({ name: e.name, status: "unchecked" as const })),
    warnings: d.warnings ?? [],
    nextActions: d.nextActions ?? [],
  });
}

const healthOf = (r: HealthCheckResult, at: Date | null): NonNullable<LifecycleResultV1["health"]> => ({
  status: r.status,
  reason: r.reason,
  toolCount: r.toolCount,
  environmentUnverified: r.environmentUnverified,
  checkedAt: at === null ? null : at.toISOString(),
});

/** 승인된 LifecyclePlan을 실행한다. 승인이 없거나 Plan이 바뀌었으면 아무것도 실행하지 않는다. */
export async function runLifecycleTransaction(planned: PlannedLifecycle, approval: LifecycleApproval | undefined, request: LifecycleRequest, env: LifecycleEnvironment): Promise<LifecycleResultV1> {
  const trace = env.trace ?? (() => undefined);
  trace("approval-check");
  if (planned.plan.status === "up-to-date") return finalize({ planned, status: "up-to-date", code: "UP_TO_DATE", retryable: false, nextActions: ["이미 같은 버전입니다. 바꾼 것이 없습니다"] });
  // 다른 Plan(예: update)에 받은 Approval은 이 Plan의 승인이 아니다. 소모하지 않고 거부한다(TASK-044 AC-044-03).
  if (approval !== undefined && approval.planDigest !== planned.planDigest) {
    return finalize({ planned, status: "approval-required", code: "APPROVAL_REQUIRED", retryable: true, nextActions: ["이 계획에 대한 승인이 아닙니다. 계획을 확인하고 다시 승인하세요"] });
  }

  const gate = await verifyApprovedLifecyclePlan(approval, async () => {
    trace("regenerate");
    const r = await planLifecycleRequest(request, env);
    trace("digest-compare");
    return r;
  });
  if (!gate.ok) {
    if (gate.code === "PLAN_STALE") return finalize({ planned, status: "stale", code: gate.code, changed: gate.changed ?? ["steps"], retryable: true, nextActions: ["승인 후 계획이 바뀌었습니다. 새 계획을 확인하고 다시 승인하세요"] });
    if (gate.cause !== undefined && RESOLVER_CODES.has(gate.cause)) {
      return finalize({ planned, status: "resolution-failed", code: gate.cause, retryable: true, nextActions: ["registry에서 버전을 확인하지 못해 아무것도 바꾸지 않았습니다. 네트워크를 확인한 뒤 다시 시도하세요"] });
    }
    if (gate.code === "PLAN_REGENERATION_FAILED") return finalize({ planned, status: "stale", code: gate.cause ?? gate.code, changed: ["steps"], retryable: true, nextActions: ["실행 직전 계획을 다시 만들지 못했습니다. 상태를 확인하고 다시 시도하세요"] });
    return finalize({ planned, status: "approval-required", code: gate.code, retryable: true, nextActions: ["계획을 확인하고 모든 승인 항목에 동의해야 실행합니다"] });
  }
  const verified = gate.verified;
  const plan = verified.plan;
  const fs = env.configFs;
  const roots = { projectRoot: request.projectRoot, homeDir: request.homeDir, ...(fs === undefined ? {} : { fs }) };
  const stateRead = await readLifecycleState({ homeDir: request.homeDir, ...(fs === undefined ? {} : { fs }) });
  if (!stateRead.ok) return finalize({ planned: verified, status: "state-commit-failed", code: stateRead.code, retryable: false, nextActions: ["Version State(" + LIFECYCLE_STATE_LOGICAL_PATH + ")를 읽지 못해 아무것도 바꾸지 않았습니다"] });
  const states = new Map(plan.targets.map((t) => [t.entryKey, stateRead.state.entries[t.entryKey]] as const));

  trace("probe");
  const probe = (await env.probe())[plan.backend];
  if (probe.available === false) {
    return finalize({ planned: verified, status: "preparation-failed", code: "BACKEND_UNAVAILABLE", retryable: true, nextActions: [plan.backend + "을(를) 찾지 못했습니다. 설치 상태를 확인한 뒤 다시 시도하세요"] });
  }
  const windowsNpx = plan.platform === "windows" && plan.backend === "npx" && env.windowsNpx !== undefined ? await env.windowsNpx() : null;

  const steps: ResultStep[] = [];
  const outcome = (id: string, o: Omit<ResultStep, "id">) => steps.push({ id, ...o });
  const skipRest = (fromIndex: number) => {
    for (const s of plan.steps.slice(fromIndex)) if (!steps.some((o) => o.id === s.id)) outcome(s.id, { status: "skipped" });
  };

  trace("prepare");
  const hasNpxPrepare = plan.steps.some((s) => s.kind === "run" && s.executable === "npx");
  const prep = await executeLifecyclePreparation(verified, {
    projectRoot: request.projectRoot,
    ...(env.spawner === undefined ? {} : { spawner: env.spawner }),
    ...(env.isolatedDir === undefined ? {} : { isolatedDir: env.isolatedDir }),
    ...(hasNpxPrepare
      ? { npx: { platform: plan.platform, windowsNpx, killTree: env.killTree ?? createTreeKiller({ cwd: env.tempBase }), ...(env.npmChildEnv === undefined ? {} : { childEnv: env.npmChildEnv() }) } }
      : {}),
  });
  if (!prep.ok) return finalize({ planned: verified, status: "approval-required", code: prep.code, retryable: true });
  steps.push(...prep.steps);
  if (!prep.prepared) {
    skipRest(0);
    return finalize({ planned: verified, status: "preparation-failed", code: prep.steps.find((s) => s.status === "failed")?.code ?? "STEP_FAILED", steps, retryable: true, nextActions: ["준비 단계가 실패해 설정 파일과 Version State는 바꾸지 않았습니다. 네트워크·docker 데몬 상태를 확인한 뒤 다시 시도하세요"] });
  }

  // v0.2.0 tool config: 위치·Windows Client 실행 경로를 확인한 뒤(실패하면 아무것도 쓰지 않음) 승인한 내용을 scope별로 쓴다.
  const usesToolConfig = plan.target.clientSpec.args.includes(TOOL_CONFIG_PLACEHOLDER) || plan.current.clientSpec.args.includes(TOOL_CONFIG_PLACEHOLDER);
  const locations = new Map<ConfigScope, ToolConfigLocation>();
  let clientLauncher: WindowsNpxLauncher | null = null;
  if (usesToolConfig) {
    for (const scope of new Set(plan.targets.map((t) => t.scope))) {
      const loc = await toolConfigLocationFor({ toolId: plan.toolId, projectRoot: request.projectRoot, homeDir: request.homeDir }, scope, { ...(fs === undefined ? {} : { configFs: fs }) });
      if (loc === null) {
        skipRest(0);
        return finalize({ planned: verified, status: "config-failed", code: "TOOL_CONFIG_REJECTED", steps, retryable: false, nextActions: ["tool config 위치를 확인하지 못해 아무것도 바꾸지 않았습니다"] });
      }
      locations.set(scope, loc);
    }
    if (plan.platform === "windows") {
      clientLauncher = windowsNpx;
      const checked = clientLauncher === null ? { ok: false as const, reason: "Node.js 실행 경로를 찾지 못했습니다" } : await verifyClientLauncher(clientLauncher, env.launcherCheckFs);
      if (!checked.ok) {
        skipRest(0);
        return finalize({ planned: verified, status: "config-failed", code: "MANUAL_SETUP_REQUIRED", steps, retryable: false, nextActions: ["Client 설정에 쓸 Node.js 실행 경로를 검증하지 못해 아무것도 바꾸지 않았습니다: " + checked.reason] });
      }
      // 설정을 쓰는 작업: 승인한 Plan이 본 실행 경로(digest)와 지금 쓸 실행 경로가 같아야 한다. digest가 없는 Plan(승인한 경로 없음)도
      // 실행하지 않는다(Plan 단계에서 막히지만 실행 단계에서 한 번 더 확인한다). Health는 Client 설정을 쓰지 않는다.
      const launcherDigest = clientLauncherDigest(clientLauncher!);
      const writes = plan.operation !== "health";
      if (writes && plan.targets.some((t) => t.launcher !== undefined && t.launcher.replacementDigest === null)) {
        skipRest(0);
        return finalize({ planned: verified, status: "config-failed", code: "CLIENT_LAUNCHER_UNAVAILABLE", steps, retryable: true, nextActions: ["승인한 계획에 검증된 Node.js 실행 경로가 없어 아무것도 바꾸지 않았습니다. 새 계획을 만들어 다시 승인하세요"] });
      }
      if (writes && plan.targets.some((t) => t.launcher !== undefined && t.launcher.replacementDigest !== launcherDigest)) {
        skipRest(0);
        return finalize({ planned: verified, status: "stale", code: "PLAN_STALE", changed: ["config-precondition"], steps, retryable: true, nextActions: ["승인 후 Node.js 실행 경로가 바뀌었습니다. 새 계획을 확인하고 다시 승인하세요"] });
      }
    }
  }
  const materialize = (scope: ConfigScope) => (value: ServerEntry): ServerEntry => {
    const loc = locations.get(scope);
    const m = materializeClientArgs(value, { platform: plan.platform, ...(loc === undefined ? {} : { toolConfigFile: loc.file }), launcher: clientLauncher });
    if (!m.ok) throw Object.assign(new Error(m.message), { code: m.code });
    return { ...value, command: m.command, args: m.args };
  };
  const toolUndos: { step: ToolConfigStep; loc: ToolConfigLocation; undo: ToolConfigUndo }[] = [];

  // config 교체(영수증) — 실패하면 이미 바꾼 파일을 원본 byte로 되돌린다.
  const receipts: { entryKey: string; receipt: ConfigWriteReceipt }[] = [];
  const restored = new Set<string>();
  const applied = new Set<string>();
  const written = new Map<string, ServerEntry>();
  const compensate = async (): Promise<boolean> => {
    let all = true;
    for (const { entryKey, receipt } of [...receipts].reverse()) {
      if (await restoreConfig(receipt, fs)) restored.add(entryKey);
      else all = false;
    }
    // tool config: 이번에 쓴 내용 그대로일 때만 되돌린다(그 사이 바뀌었으면 덮어쓰지 않고 실패).
    for (const t of [...toolUndos].reverse()) {
      try {
        await restoreToolConfig(t.loc, t.undo, env.toolConfigFs);
        const s = steps.find((o) => o.id === t.step.id);
        if (s !== undefined && s.status === "done" && t.undo.kind !== "unchanged") s.status = "compensated";
      } catch {
        all = false;
      }
    }
    const restoredIds = new Set(plan.targets.filter((t) => restored.has(t.entryKey)).map((t) => "config-" + t.client + "-" + t.scope));
    for (const s of steps) if (s.status === "done" && restoredIds.has(s.id)) s.status = "compensated";
    return all;
  };
  const failedRestore = () =>
    finalize({
      planned: verified,
      status: "rollback-failed",
      code: "CONFIG_RESTORE_FAILED",
      steps,
      applied,
      restored,
      compensated: false,
      retryable: false,
      nextActions: [
        "설정 파일을 원래 내용으로 되돌리지 못했습니다. 다음 파일의 " + plan.targets.map((t) => t.serverName).filter((v, i, a) => a.indexOf(v) === i).join(", ") + " 항목을 직접 확인하세요: " + receipts.filter((r) => !restored.has(r.entryKey)).map((r) => r.receipt.file).join(", "),
        "Version State(" + LIFECYCLE_STATE_LOGICAL_PATH + ")는 바꾸지 않았습니다",
      ],
    });

  for (const step of plan.steps.filter((s): s is ToolConfigStep => s.kind === "tool-config")) {
    const loc = locations.get(step.scope);
    try {
      if (loc === undefined) throw new Error("tool config 위치가 없습니다");
      const expected = step.expected.state === "absent" ? ({ state: "absent" } as const) : ({ state: "present", digest: step.expected.digest! } as const);
      const undo = await writeToolConfig(loc, step.content, expected, env.toolConfigFs);
      toolUndos.push({ step, loc, undo });
      outcome(step.id, { status: "done" });
    } catch (error) {
      const code = (error as { code?: string }).code ?? "TOOL_CONFIG_WRITE_FAILED";
      outcome(step.id, { status: "failed", code, excerpt: (error as Error).message });
      skipRest(0);
      if (!(await compensate())) return failedRestore();
      return finalize({ planned: verified, status: "config-failed", code, steps, applied, restored, compensated: toolUndos.length > 0, retryable: code === "TOOL_CONFIG_STALE" || code === "TOOL_CONFIG_WRITE_FAILED", nextActions: [code === "TOOL_CONFIG_STALE" ? "승인 뒤 tool config가 바뀌었습니다. 새 계획을 확인하고 다시 승인하세요" : "tool config를 쓰지 못해 Client 설정과 Version State는 바꾸지 않았습니다"] });
    }
  }

  const configSteps = plan.steps.filter((s): s is ConfigReplaceStep => s.kind === "config-replace");
  if (configSteps.length > 0) trace("config-replace");
  for (const step of configSteps) {
    const target = plan.targets.find((t) => "config-" + t.client + "-" + t.scope === step.id)!;
    const source = states.get(target.entryKey) ?? (target.relocatedFrom === undefined ? undefined : stateRead.state.entries[target.relocatedFrom]);
    // repair(v0.2.0): Plan이 "OpenHub 관리 경로만 다르다"고 판정한 항목은 기록된 block이 아니라 지금 파일의 실제 block을 교체한다.
    // 지금 항목이 승인 때 확인한 digest(precondition)와 같을 때만이다. 다르면(승인 뒤 변경) 교체하지 않는다(CONFIG_DRIFT).
    let expectedBlockDigest = source?.config.tomlBlockDigest ?? null;
    if (plan.operation === "repair" && target.client === "codex" && source !== undefined && target.precondition.entryDigest !== source.config.entryDigest) {
      const current = await readConfiguredEntry(target.client, target.scope, target.serverName, roots).catch(() => undefined);
      expectedBlockDigest = current !== undefined && configEntryDigest(current) === target.precondition.entryDigest ? tomlBlockDigest(target.serverName, current as ServerEntry) : null;
    }
    let r: Awaited<ReturnType<typeof replaceConfigEntry>>;
    try {
      const m = usesToolConfig ? materialize(step.scope) : undefined;
      if (m !== undefined) written.set(step.id, m(step.value));
      r = await replaceConfigEntry(step, { ...roots, acknowledgements: verified.acknowledgements, expectedBlockDigest, ...(m === undefined ? {} : { materialize: m }) });
    } catch (error) {
      r = { ok: false, code: "MANUAL_SETUP_REQUIRED", message: (error as Error).message };
    }
    if (!r.ok) {
      outcome(step.id, { status: "failed", code: r.code, excerpt: r.message });
      skipRest(0);
      if (!(await compensate())) return failedRestore();
      return finalize({ planned: verified, status: "config-failed", code: r.code, steps, applied, restored, compensated: receipts.length > 0, retryable: r.code === "CONFIG_WRITE_FAILED", nextActions: [receipts.length > 0 ? "설정 교체가 중간에 실패해 이미 바꾼 설정 파일을 원래 내용으로 되돌렸습니다" : "설정 파일을 바꾸지 못했습니다", "Version State는 바꾸지 않았습니다"] });
    }
    receipts.push({ entryKey: target.entryKey, receipt: r.receipt });
    applied.add(target.entryKey);
    outcome(step.id, { status: "done" });
  }

  // Health(기본 REQUIRED). 실행 후 실패는 우회할 수 없다.
  let health: LifecycleResultV1["health"] = null;
  const healthStep = plan.steps.find((s) => s.kind === "health");
  if (healthStep !== undefined) {
    trace("health");
    const manifest = (await env.loadEntries()).find((e) => e.manifest.name === plan.toolId)?.manifest;
    const run = env.runHealth ?? runHealthCheck;
    // tool config Tool: Client와 같은 파일로 실행한다. 실행 직전 파일이 승인·기록된 내용과 같은지 다시 확인한다.
    let toolConfigFile: string | undefined;
    if (usesToolConfig) {
      const scope = plan.targets[0]!.scope;
      const loc = locations.get(scope)!;
      const expected = toolUndos.find((t) => t.step.scope === scope)?.step.contentDigest ?? states.get(plan.targets[0]!.entryKey)?.toolConfig?.digest;
      const now = await inspectToolConfig(loc, env.toolConfigFs).catch(() => null);
      if (expected === undefined || now === null || now.state !== "present" || now.digest !== expected) {
        outcome(healthStep.id, { status: "failed", code: "TOOL_CONFIG_DRIFT", excerpt: "Health 직전 tool config가 승인한 내용과 달라 실행하지 않았습니다" });
        skipRest(0);
        if (plan.operation === "health") return finalize({ planned: verified, status: "health-failed", code: "TOOL_CONFIG_DRIFT", steps, retryable: true, nextActions: ["tool config가 바뀌었습니다. openhub lifecycle repair로 다시 만드세요"] });
        if (!(await compensate())) return failedRestore();
        return finalize({ planned: verified, status: "health-failed", code: "TOOL_CONFIG_DRIFT", steps, applied, restored, compensated: true, retryable: true, nextActions: ["Health 직전 tool config가 바뀌어 설정을 원래 내용으로 되돌렸습니다"] });
      }
      toolConfigFile = loc.file;
    }
    const report = await run(verified, {
      healthCheckType: manifest?.healthCheck?.type,
      windowsNpx,
      tempBase: env.tempBase,
      ...(toolConfigFile === undefined ? {} : { toolConfigFile }),
      ...(env.healthSpawner === undefined ? {} : { spawner: env.healthSpawner }),
      ...(env.killTree === undefined ? {} : { killTree: env.killTree }),
    });
    const result: HealthCheckResult = report.ok ? report.result : { status: "launch-failed", reason: "spawn-failed", toolCount: null, environmentUnverified: false, terminated: true, excerpt: report.message };
    health = healthOf(result, env.now());
    if (result.status !== "healthy") {
      outcome(healthStep.id, { status: "failed", code: result.reason ?? result.status, ...(result.excerpt === null ? {} : { excerpt: result.excerpt }) });
      skipRest(0);
      if (plan.operation === "health") {
        // 단독 Health: config는 바꾸지 않았다. 실패 상태도 lastHealth로 기록한다.
        const committed = await commitHealthOnly(plan, states, stateRead.state, stateRead.digest, health, request, fs, steps);
        return finalize({ planned: verified, status: committed ? "health-failed" : "state-commit-failed", code: result.reason ?? result.status, steps, health, stateCommitted: committed, retryable: true, nextActions: ["MCP 서버가 정상 응답하지 않았습니다(" + result.status + "). 설정은 바꾸지 않았습니다"] });
      }
      if (!(await compensate())) return failedRestore();
      return finalize({
        planned: verified,
        status: "health-failed",
        code: result.reason ?? result.status,
        steps,
        applied,
        restored,
        health,
        compensated: true,
        retryable: true,
        nextActions: ["Health Check가 실패해(" + result.status + ") 설정 파일을 원래 내용으로 되돌렸고 Version State는 바꾸지 않았습니다. 다시 시도하려면 새 계획을 승인하세요"],
      });
    }
    outcome(healthStep.id, { status: "done" });
  } else {
    health = { status: "skipped", reason: null, toolCount: null, environmentUnverified: true, checkedAt: null };
  }

  // Version State commit(Health 성공 또는 승인된 skip 뒤에만).
  trace("state-commit");
  const now = env.now();
  if (plan.operation === "health") {
    const committed = await commitHealthOnly(plan, states, stateRead.state, stateRead.digest, health, request, fs, steps);
    return finalize({ planned: verified, status: committed ? "health-checked" : "state-commit-failed", steps, health, stateCommitted: committed, retryable: !committed });
  }
  const lastHealth: LastHealth =
    health.status === "skipped" ? { status: "skipped", environmentUnverified: true, checkedAt: null } : { status: "healthy", environmentUnverified: health.environmentUnverified, checkedAt: now.toISOString() };
  const entries = { ...stateRead.state.entries };
  const revisions = new Map<string, { before: number | null; after: number | null }>();
  const currentProjectKey = plan.targets.some((t) => t.relocatedFrom !== undefined) ? await projectKeyFor(request.projectRoot, fs) : null;
  for (const step of configSteps) {
    const t = plan.targets.find((x) => "config-" + x.client + "-" + x.scope === step.id)!;
    const value = written.get(step.id) ?? step.value;
    const toolConfigStep = toolUndos.find((u) => u.step.scope === t.scope)?.step;
    // repair로 옮긴 기록: 원래 기록을 바탕으로 이 프로젝트의 새 기록(revision 1)을 만든다. 원래 기록은 그대로 둔다(복사 시나리오).
    const moved = t.relocatedFrom === undefined ? undefined : stateRead.state.entries[t.relocatedFrom];
    const old = moved === undefined ? states.get(t.entryKey)! : { ...moved, target: { ...moved.target, projectKey: currentProjectKey, projectName: path.basename(path.resolve(request.projectRoot)) } };
    const next: ToolState = {
      ...coreOf(old),
      revision: moved === undefined ? old.revision + 1 : 1,
      artifact: { requested: plan.target.requested, resolved: plan.target.identity },
      launch: { platform: plan.platform, clientSpec: { command: plan.target.clientSpec.command, args: [...plan.target.clientSpec.args] } },
      config: { entryDigest: configEntryDigest(value), tomlBlockDigest: t.client === "codex" ? tomlBlockDigest(t.serverName, value) : null },
      ...(toolConfigStep === undefined ? {} : { toolConfig: { fileId: toolConfigStep.fileId, scope: toolConfigStep.scope, digest: toolConfigStep.contentDigest } }),
      appliedPlanDigest: verified.planDigest,
      committedAt: now.toISOString(),
      lastHealth,
      previous: moved === undefined ? (plan.operation === "repair" ? old.previous : coreOf(old)) : null,
    };
    entries[entryKeyOf(next.target)] = next;
    revisions.set(t.entryKey, { before: moved === undefined ? old.revision : null, after: next.revision });
  }
  const commit = await commitLifecycleState({ ...stateRead.state, entries }, stateRead.digest, { homeDir: request.homeDir, ...(fs === undefined ? {} : { fs }) });
  const commitStep = plan.steps.find((s) => s.kind === "state-commit")!;
  if (!commit.ok) {
    outcome(commitStep.id, { status: "failed", code: commit.code });
    if (!(await compensate())) return failedRestore();
    return finalize({ planned: verified, status: "state-commit-failed", code: commit.code, steps, applied, restored, health, compensated: true, retryable: commit.code !== "STATE_INVALID", nextActions: ["Version State를 쓰지 못해 설정 파일을 원래 내용으로 되돌렸습니다. 다시 시도하려면 새 계획을 승인하세요"] });
  }
  outcome(commitStep.id, { status: "done" });
  return finalize({
    planned: verified,
    status: succeeded(plan.operation),
    steps,
    applied,
    revisions,
    health,
    stateCommitted: true,
    retryable: false,
    warnings: [
      ...(health.status === "skipped" ? [{ code: "health-not-verified", message: "Health: Not verified / Reason: Required environment is unchecked" }] : []),
      ...(plan.operation === "rollback" && plan.target.identity === null ? [{ code: "rollback-artifact-unlocked", message: ROLLBACK_UNLOCKED_NOTICE }] : []),
    ],
    nextActions: ["Client를 다시 시작하거나 MCP 서버 목록을 새로 고치세요"],
  });
}

/** 단독 Health 결과를 lastHealth로만 기록한다(artifact·config·revision은 그대로). */
async function commitHealthOnly(
  plan: VerifiedLifecyclePlan["plan"],
  states: ReadonlyMap<string, ToolState | undefined>,
  state: LifecycleStateFile,
  digest: string | null,
  health: NonNullable<LifecycleResultV1["health"]>,
  request: LifecycleRequest,
  fs: ConfigFs | undefined,
  steps: ResultStep[],
): Promise<boolean> {
  const entries = { ...state.entries };
  for (const t of plan.targets) {
    const old = states.get(t.entryKey);
    if (old !== undefined) entries[t.entryKey] = { ...old, lastHealth: { status: health.status, environmentUnverified: health.environmentUnverified, checkedAt: health.checkedAt } };
  }
  const commit = await commitLifecycleState({ ...state, entries }, digest, { homeDir: request.homeDir, ...(fs === undefined ? {} : { fs }) });
  const record = plan.steps.find((s) => s.kind === "health-record");
  if (record !== undefined) {
    const existing = steps.find((s) => s.id === record.id);
    const status = commit.ok ? "done" : "failed";
    if (existing !== undefined) Object.assign(existing, { status, ...(commit.ok ? {} : { code: commit.code }) });
    else steps.push({ id: record.id, status, ...(commit.ok ? {} : { code: commit.code }) });
  }
  return commit.ok;
}

