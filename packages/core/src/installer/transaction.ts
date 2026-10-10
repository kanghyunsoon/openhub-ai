import type { ProjectProfile } from "../analyzer/index";
import path from "node:path";
import type { BackendProbeReport } from "../process/probe";
import { probeToRecommendContext } from "../process/probe";
import { executeVerifiedPlan, type ExecSpawner, type IsolatedDir, type StepOutcome } from "../process/executor";
import { createTreeKiller, type TreeKiller, type WindowsNpxLauncher } from "../process/health";
import { recommend, type MetadataSnapshot, type RecommendPlatform, type RecommendationReport } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { verifyApprovedPlan, type InstallApproval, type VerifiedPlan } from "./approval-v1";
import { ConfigWriteError, applyConfigPatch, inspectConfigTarget, nodeConfigFs, readConfiguredEntry, restoreConfig, type ConfigFs, type ConfigWriteReceipt } from "./config-writer";
import { canonicalize, type ConfigPatchStep, type ConfigScope, type InstallClient, type PlannedInstall } from "./plan";
import { buildInstallPlan, type PlanBuildResult } from "./plan-builder";
import { installResultSchema, preparedStateOf, type InstallResultV1, type InstallVerification } from "./result";
import { projectKeyFromRealpath } from "../lifecycle/state";
import {
  ToolConfigError,
  inspectToolConfig,
  materializeClientArgs,
  restoreToolConfig,
  toolConfigLocation,
  verifyClientLauncher,
  writeToolConfig,
  type LauncherCheckFs,
  type ToolConfigFs,
  type ToolConfigLocation,
  type ToolConfigUndo,
} from "../tool-config/index";
import type { ConfigScope as Scope, ServerEntry, ToolConfigStep } from "./plan";

/**
 * Install Transaction(TASK-033). 순서: 승인 확인 → 실행 직전 Plan 재생성·digest 비교 → 선택 backend 재확인(probe)
 * → 준비 단계 → config write → 확인. 실패 안전성과 멱등성을 여기서 보장한다.
 * - 준비 단계 실패 → config 미수정. config write 실패 → 이미 쓴 파일을 원본 byte로 복구(partial-compensated). full rollback이 아니다.
 * - already-installed는 no-op(spawn 0, write 0). unidentified-present는 자동 no-op하지 않는다(추가 승인 필요).
 * - 대상 config 외 파일을 쓰지 않고 audit 파일을 만들지 않는다. 결과는 메모리 객체다.
 */

export type TransactionPhase = "approval-check" | "regenerate" | "digest-compare" | "probe" | "prepare" | "config-write" | "verify";

export interface InstallRequest {
  toolId: string;
  projectRoot: string;
  homeDir: string;
  targets: readonly { client: InstallClient; scope: ConfigScope }[];
  includeHost: boolean;
  /** Client가 실행될 플랫폼(D-016: Windows npx launch spec이 달라진다). */
  platform: RecommendPlatform;
}

export interface VerifierInput {
  verified: VerifiedPlan;
  request: InstallRequest;
  steps: readonly StepOutcome[];
  receipts: readonly ConfigWriteReceipt[];
  env: InstallEnvironment;
  /** 이 config-patch 단계가 파일에 실제로 쓴 값(tool config Tool은 placeholder를 바꾼 값). 없으면 step.value. */
  expectedEntry?: (step: ConfigPatchStep) => ServerEntry;
}
export interface VerifierOutput {
  verification: InstallVerification;
  warnings: { code: string; message: string }[];
  nextActions: string[];
}
export type InstallVerifier = (input: VerifierInput) => Promise<VerifierOutput>;

export interface InstallEnvironment {
  loadEntries(): Promise<readonly RegistryEntry[]>;
  analyze(projectRoot: string, includeHost: boolean): Promise<ProjectProfile>;
  probe(): Promise<BackendProbeReport>;
  snapshot?: MetadataSnapshot;
  configFs?: ConfigFs;
  spawner?: ExecSpawner;
  isolatedDir?: () => Promise<IsolatedDir>;
  /** Windows에서 npx Prepare 실행 경로(probe 단계처럼 PATH에서 찾는다). npx 준비 단계가 있을 때만 부른다. */
  windowsNpx?: () => Promise<WindowsNpxLauncher | null>;
  /** npx Prepare timeout 때 process tree를 끝낸다. 기본 createTreeKiller. */
  killTree?: TreeKiller;
  /** npx Prepare의 npm 자식 process 환경(보통 npmChildEnv(process.env), CLI·Desktop이 넘긴다). 없으면 OS 기본 상속. */
  npmChildEnv?: () => Record<string, string>;
  /** 확인 단계(TASK-034). 없으면 Prepared·Configured만 확인하고 Detected는 skipped다. */
  verify?: InstallVerifier;
  /** OpenHub 관리 tool config 파일 접근(v0.2.0, 테스트에서 실패를 주입한다). */
  toolConfigFs?: ToolConfigFs;
  /** Windows Client 직접 실행 경로 검증용 fs(v0.2.0). */
  launcherCheckFs?: LauncherCheckFs;
  trace?: (phase: TransactionPhase) => void;
}

export interface PlannedInstallWithReport {
  result: PlanBuildResult;
  report: RecommendationReport;
  profile: ProjectProfile;
}

/** 입력(Registry·analyzeProject·probe·recommend·대상 config)을 읽어 Plan을 만든다. 실행 직전 재생성에도 같은 함수를 쓴다. */
export async function planInstall(request: InstallRequest, env: InstallEnvironment): Promise<PlannedInstallWithReport> {
  const entries = await env.loadEntries();
  const profile = await env.analyze(request.projectRoot, request.includeHost);
  const probes = await env.probe();
  const report = recommend(profile, entries, env.snapshot, probeToRecommendContext(probes, request.platform));
  const entry = entries.find((e) => e.manifest.name === request.toolId);
  const alias = entry?.manifest.recommendation?.identity?.mcpServerNames?.[0] ?? request.toolId;
  const roots = { projectRoot: request.projectRoot, homeDir: request.homeDir, ...(env.configFs === undefined ? {} : { fs: env.configFs }) };
  const targets = await Promise.all(request.targets.map((t) => inspectConfigTarget(t.client, t.scope, alias, roots)));
  const toolConfigs = entry?.manifest.toolConfig === undefined ? undefined : await inspectToolConfigs(request, [...new Set(request.targets.map((t) => t.scope))], env);
  const result = buildInstallPlan({ toolId: request.toolId, entries, report, probes, targets, platform: request.platform, ...(toolConfigs === undefined ? {} : { toolConfigs }) });
  return { result, report, profile };
}

/** tool config 위치(scope별). project는 Version State와 같은 projectKey를 쓴다. 절대 경로는 이 함수 밖으로 결과에 남기지 않는다. */
export async function toolConfigLocationFor(request: Pick<InstallRequest, "toolId" | "projectRoot" | "homeDir">, scope: Scope, env: Pick<InstallEnvironment, "configFs">): Promise<ToolConfigLocation | null> {
  if (scope === "user") return toolConfigLocation({ homeDir: request.homeDir, scope, toolId: request.toolId });
  const real = await (env.configFs ?? nodeConfigFs).realpath(path.resolve(request.projectRoot)).catch(() => null);
  if (real === null) return null;
  return toolConfigLocation({ homeDir: request.homeDir, scope, toolId: request.toolId, projectKey: projectKeyFromRealpath(real) });
}

/** 승인 전 scope별 현재 상태. 확인하지 못한 scope(link·권한 등)는 빼서 Plan이 TOOL_CONFIG_UNKNOWN으로 막히게 한다. */
async function inspectToolConfigs(request: InstallRequest, scopes: readonly Scope[], env: InstallEnvironment) {
  const out: { scope: Scope; current: { state: "absent" } | { state: "present"; digest: string } }[] = [];
  for (const scope of scopes) {
    const loc = await toolConfigLocationFor(request, scope, env);
    if (loc === null) continue;
    try {
      out.push({ scope, current: await inspectToolConfig(loc, env.toolConfigFs) });
    } catch {
      // 확인할 수 없으면 Plan이 막는다.
    }
  }
  return out;
}

const configChangesOf = (plan: VerifiedPlan["plan"], receipts: readonly ConfigWriteReceipt[], restored: ReadonlySet<ConfigWriteReceipt>) =>
  plan.steps
    .filter((s): s is ConfigPatchStep => s.kind === "config-patch")
    .map((s) => {
      const receipt = receipts.find((r) => r.client === s.client && r.scope === s.scope);
      return { client: s.client, scope: s.scope, file: s.file, serverName: s.path[1]!, applied: receipt !== undefined, restored: receipt !== undefined && restored.has(receipt) };
    });

const requiredEnvOf = (plan: PlannedInstall["plan"]) => plan.requiredEnv.filter((e) => e.required).map((e) => ({ name: e.name, status: "unchecked" as const }));

/** npx 준비 단계가 있을 때만 npx Prepare 문맥(플랫폼·Windows 실행 경로·tree killer)을 만든다. */
async function npxContextFor(plan: VerifiedPlan["plan"], request: InstallRequest, env: InstallEnvironment) {
  if (!plan.steps.some((s) => s.kind === "run" && s.executable === "npx") || plan.launch === null) return {};
  const platform = plan.launch.platform;
  const windowsNpx = platform === "windows" && env.windowsNpx !== undefined ? await env.windowsNpx() : null;
  return { npx: { platform, windowsNpx, killTree: env.killTree ?? createTreeKiller({ cwd: request.projectRoot }), ...(env.npmChildEnv === undefined ? {} : { childEnv: env.npmChildEnv() }) } };
}

function finalize(result: InstallResultV1): InstallResultV1 {
  return installResultSchema.parse(result);
}

function notExecuted(planned: PlannedInstall, status: InstallResultV1["status"], code: string | undefined, retryable: boolean, extra: Partial<InstallResultV1> = {}): InstallResultV1 {
  return finalize({
    schemaVersion: 1,
    planDigest: planned.planDigest,
    toolId: planned.plan.toolId,
    backend: planned.plan.backend?.adapter ?? null,
    status,
    ...(code === undefined ? {} : { code }),
    steps: [],
    retryable,
    configChanges: [],
    verification: null,
    requiredEnv: requiredEnvOf(planned.plan),
    warnings: [],
    nextActions: [],
    ...extra,
  });
}

/** 기본 확인: Prepared(준비 단계 결과)·Configured(파일 재확인). Detected는 TASK-034 verifier가 채운다. */
export const basicVerifier: InstallVerifier = async ({ verified, request, steps, env, expectedEntry }) => {
  const runSteps = verified.plan.steps.filter((s) => s.kind === "run");
  const prepared = runSteps.every((s) => steps.find((o) => o.id === s.id)?.status === "done") ? preparedStateOf(verified.plan.artifact?.preparation) : "failed";
  let configured = prepared !== "failed";
  for (const step of verified.plan.steps.filter((s): s is ConfigPatchStep => s.kind === "config-patch")) {
    const entry = await readConfiguredEntry(step.client, step.scope, step.path[1]!, { projectRoot: request.projectRoot, homeDir: request.homeDir, ...(env.configFs === undefined ? {} : { fs: env.configFs }) });
    if (JSON.stringify(canonicalize(entry)) !== JSON.stringify(canonicalize(expectedEntry === undefined ? step.value : expectedEntry(step)))) configured = false;
  }
  return { verification: { prepared, configured, detected: "skipped" }, warnings: [], nextActions: [] };
};

const CONFIG_RETRYABLE: Readonly<Record<string, boolean>> = { CONFIG_WRITE_FAILED: true, CONFIG_KEY_EXISTS: false, CONFIG_PATH_ESCAPE: false, MANUAL_SETUP_REQUIRED: false, CONFIG_UNPARSEABLE: false, USER_SCOPE_NOT_APPROVED: false };

/** 승인된 Plan을 실행한다. 승인이 없거나 Plan이 바뀌었으면 아무것도 실행하지 않는다. */
export async function runInstallTransaction(planned: PlannedInstall, approval: InstallApproval | undefined, request: InstallRequest, env: InstallEnvironment): Promise<InstallResultV1> {
  const trace = env.trace ?? (() => undefined);
  trace("approval-check");
  if (planned.plan.status === "already-installed") {
    return notExecuted(planned, "no-op", "ALREADY_INSTALLED", false, { nextActions: ["이미 설정되어 있어 아무것도 바꾸지 않았습니다"] });
  }

  const gate = await verifyApprovedPlan(approval, async () => {
    trace("regenerate");
    const regenerated = await planInstall(request, env);
    trace("digest-compare");
    if (!regenerated.result.ok) throw new Error(regenerated.result.code);
    return regenerated.result.planned;
  });
  if (!gate.ok) {
    if (gate.code === "PLAN_STALE") return notExecuted(planned, "stale", gate.code, true, { changed: gate.changed ?? ["steps"], nextActions: ["설치 계획이 바뀌었습니다. 새 계획을 확인하고 다시 승인하세요"] });
    if (gate.code === "APPROVAL_REQUIRED" || gate.code === "APPROVAL_INCOMPLETE" || gate.code === "APPROVAL_CONSUMED") {
      return notExecuted(planned, "approval-required", gate.code, true, { nextActions: ["설치 계획을 확인하고 모든 승인 항목에 동의해야 실행합니다"] });
    }
    return notExecuted(planned, "failed", gate.code, gate.code === "PLAN_REGENERATION_FAILED");
  }
  const verified = gate.verified;

  trace("probe");
  const selected = verified.plan.backend;
  if (selected !== null) {
    const now = (await env.probe())[selected.adapter];
    if (JSON.stringify(canonicalize(now)) !== JSON.stringify(canonicalize(selected.probe))) {
      return notExecuted(planned, "stale", "PLAN_STALE", true, { changed: ["backend"], nextActions: ["설치 backend 상태가 바뀌었습니다. 새 계획을 확인하고 다시 승인하세요"] });
    }
  }

  trace("prepare");
  const receipts: ConfigWriteReceipt[] = [];
  let configTraced = false;
  let configError: string | undefined;
  const roots = { projectRoot: request.projectRoot, homeDir: request.homeDir, ...(env.configFs === undefined ? {} : { fs: env.configFs }) };

  // v0.2.0 tool config: 위치(scope별)와 Windows Client 직접 실행 경로를 실행 전에 확인한다. 확인하지 못하면 아무것도 쓰지 않는다.
  const toolConfigSteps = verified.plan.steps.filter((s): s is ToolConfigStep => s.kind === "tool-config");
  const locations = new Map<Scope, ToolConfigLocation>();
  let launcher: { node: string; npxCli: string } | null = null;
  if (toolConfigSteps.length > 0) {
    for (const s of toolConfigSteps) {
      const loc = await toolConfigLocationFor(request, s.scope, env);
      if (loc === null || loc.fileId !== s.fileId) return notExecuted(planned, "failed", "TOOL_CONFIG_REJECTED", false, { nextActions: ["tool config 위치를 확인하지 못해 아무것도 바꾸지 않았습니다"] });
      locations.set(s.scope, loc);
    }
    if (verified.plan.launch?.clientSpec.command === "node") {
      launcher = env.windowsNpx === undefined ? null : await env.windowsNpx();
      const checked = launcher === null ? { ok: false as const, reason: "Node.js 실행 경로를 찾지 못했습니다" } : await verifyClientLauncher(launcher, env.launcherCheckFs);
      if (!checked.ok) return notExecuted(planned, "failed", "MANUAL_SETUP_REQUIRED", false, { nextActions: ["Client 설정에 쓸 Node.js 실행 경로를 검증하지 못해 아무것도 바꾸지 않았습니다: " + checked.reason] });
    }
  }
  const platform = verified.plan.launch?.platform ?? request.platform;
  const materialize = (scope: Scope) => (value: ServerEntry): ServerEntry => {
    const loc = locations.get(scope);
    const m = materializeClientArgs(value, { platform, ...(loc === undefined ? {} : { toolConfigFile: loc.file }), launcher });
    if (!m.ok) throw new ConfigWriteError("MANUAL_SETUP_REQUIRED", m.message);
    return { ...value, command: m.command, args: m.args };
  };
  const needsMaterialize = toolConfigSteps.length > 0;
  const toolUndos: { step: ToolConfigStep; loc: ToolConfigLocation; undo: ToolConfigUndo }[] = [];
  let toolConfigError: string | undefined;

  const report = await executeVerifiedPlan(verified, {
    projectRoot: request.projectRoot,
    ...(env.spawner === undefined ? {} : { spawner: env.spawner }),
    ...(env.isolatedDir === undefined ? {} : { isolatedDir: env.isolatedDir }),
    ...(await npxContextFor(verified.plan, request, env)),
    onToolConfigStep: async (step) => {
      const loc = locations.get(step.scope)!;
      try {
        const expected = step.expected.state === "absent" ? ({ state: "absent" } as const) : ({ state: "present", digest: step.expected.digest! } as const);
        const undo = await writeToolConfig(loc, step.content, expected, env.toolConfigFs);
        if (undo.digest !== step.contentDigest) throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config 내용이 Plan과 다릅니다");
        toolUndos.push({ step, loc, undo });
        return { id: step.id, status: "done" };
      } catch (error) {
        toolConfigError = error instanceof ToolConfigError ? error.code : "TOOL_CONFIG_WRITE_FAILED";
        return { id: step.id, status: "failed", code: toolConfigError, ...(error instanceof ToolConfigError ? { excerpt: error.message } : {}) };
      }
    },
    onConfigStep: async (step) => {
      if (!configTraced) {
        trace("config-write");
        configTraced = true;
      }
      try {
        receipts.push(await applyConfigPatch(step, { ...roots, acknowledgements: verified.acknowledgements, ...(needsMaterialize ? { materialize: materialize(step.scope) } : {}) }));
        return { id: step.id, status: "done" };
      } catch (error) {
        configError = error instanceof ConfigWriteError ? error.code : "CONFIG_WRITE_FAILED";
        return { id: step.id, status: "failed", code: configError, ...(error instanceof ConfigWriteError ? { excerpt: error.message } : {}) };
      }
    },
  });
  if (!report.ok) return notExecuted(planned, "approval-required", report.code, true);

  const restored = new Set<ConfigWriteReceipt>();
  const restoredTool = new Set<ToolConfigStep>();
  let compensationFailed = false;
  // 보상: 이번에 쓴 Client 설정 → tool config 순으로 되돌린다. 그 사이 다른 프로세스가 바꾼 파일은 덮어쓰지 않고 실패로 남긴다.
  const compensate = async () => {
    for (const receipt of [...receipts].reverse()) {
      if (await restoreConfig(receipt, env.configFs)) restored.add(receipt);
      else compensationFailed = true;
    }
    for (const t of [...toolUndos].reverse()) {
      if (t.undo.kind === "unchanged") continue;
      try {
        await restoreToolConfig(t.loc, t.undo, env.toolConfigFs);
        restoredTool.add(t.step);
      } catch {
        compensationFailed = true;
      }
    }
  };
  const withToolConfig = (result: InstallResultV1): InstallResultV1 =>
    toolConfigSteps.length === 0
      ? result
      : {
          ...result,
          toolConfigChanges: toolConfigSteps.map((s) => {
            const written = toolUndos.find((x) => x.step === s);
            return { fileId: s.fileId, scope: s.scope, action: s.action, applied: written !== undefined && written.undo.kind !== "unchanged", restored: restoredTool.has(s) };
          }),
        };
  const compensationOutcome = (status: InstallResultV1["status"], code: string) =>
    compensationFailed ? { status: "failed" as const, code: "COMPENSATION_INCOMPLETE", retryable: false } : { status, code };
  const COMPENSATION_INCOMPLETE_ACTION = "일부 파일을 되돌리지 못했습니다(이번 실행 뒤 다른 곳에서 바뀌었거나 쓸 수 없음). 덮어쓰지 않았으니 lifecycle status로 확인하세요";
  let steps: InstallResultV1["steps"] = report.steps;
  const base = {
    schemaVersion: 1 as const,
    planDigest: verified.planDigest,
    toolId: verified.plan.toolId,
    backend: verified.plan.backend?.adapter ?? null,
    requiredEnv: requiredEnvOf(verified.plan),
  };

  if (!report.prepared) {
    const failed = steps.find((s) => s.status === "failed");
    return finalize(withToolConfig({
      ...base,
      status: "failed",
      code: failed?.code ?? "STEP_FAILED",
      steps,
      ...(report.failedStep === undefined ? {} : { failedStep: report.failedStep }),
      retryable: true,
      configChanges: configChangesOf(verified.plan, receipts, restored),
      verification: { prepared: "failed", configured: false, detected: "skipped" },
      warnings: [],
      nextActions: ["준비 단계가 실패해 설정 파일은 바꾸지 않았습니다. 네트워크·docker 데몬 상태를 확인한 뒤 다시 시도하세요"],
    }));
  }

  if (toolConfigError !== undefined) {
    await compensate();
    const applied = toolUndos.some((t) => t.undo.kind !== "unchanged");
    return finalize(withToolConfig({
      ...base,
      retryable: toolConfigError === "TOOL_CONFIG_WRITE_FAILED" || toolConfigError === "TOOL_CONFIG_STALE",
      ...compensationOutcome(applied ? "partial-compensated" : "failed", toolConfigError),
      steps,
      ...(report.failedStep === undefined ? {} : { failedStep: report.failedStep }),
      configChanges: configChangesOf(verified.plan, receipts, restored),
      verification: { prepared: preparedStateOf(verified.plan.artifact?.preparation), configured: false, detected: "skipped" },
      warnings: [],
      nextActions: compensationFailed ? [COMPENSATION_INCOMPLETE_ACTION] : toolConfigError === "TOOL_CONFIG_STALE" ? ["승인 뒤 tool config가 바뀌었습니다. 새 계획을 확인하고 다시 승인하세요"] : ["tool config를 쓰지 못해 Client 설정은 바꾸지 않았습니다"],
    }));
  }

  if (configError !== undefined) {
    await compensate();
    const compensatedIds = new Set([...restored].map((r) => "config-" + r.client + "-" + r.scope));
    steps = steps.map((s) => (s.status === "done" && compensatedIds.has(s.id) ? { ...s, status: "compensated" as const } : s));
    return finalize(withToolConfig({
      ...base,
      retryable: CONFIG_RETRYABLE[configError] ?? false,
      ...compensationOutcome(receipts.length > 0 || toolUndos.length > 0 ? "partial-compensated" : "failed", configError),
      steps,
      ...(report.failedStep === undefined ? {} : { failedStep: report.failedStep }),
      configChanges: configChangesOf(verified.plan, receipts, restored),
      verification: { prepared: preparedStateOf(verified.plan.artifact?.preparation), configured: false, detected: "skipped" },
      warnings: [],
      nextActions: compensationFailed ? [COMPENSATION_INCOMPLETE_ACTION] : receipts.length > 0 ? ["설정 쓰기가 중간에 실패해 이미 쓴 설정 파일을 원래 내용으로 되돌렸습니다"] : ["설정 파일을 쓰지 못했습니다"],
    }));
  }

  trace("verify");
  const verifier = env.verify ?? basicVerifier;
  const checked = await verifier({ verified, request, steps: report.steps, receipts, env, ...(needsMaterialize ? { expectedEntry: (s: ConfigPatchStep) => materialize(s.scope)(s.value) } : {}) });
  // tool config도 다시 읽어 승인한 digest와 같은지 확인한다(Configured의 일부).
  for (const t of toolUndos) {
    const now = await inspectToolConfig(t.loc, env.toolConfigFs).catch(() => null);
    if (now === null || now.state !== "present" || now.digest !== t.step.contentDigest) checked.verification = { ...checked.verification, configured: false };
  }
  if (!checked.verification.configured) {
    await compensate();
    return finalize(withToolConfig({
      ...base,
      ...compensationOutcome(receipts.length > 0 || toolUndos.length > 0 ? "partial-compensated" : "failed", "CONFIGURED_MISMATCH"),
      steps,
      retryable: false,
      configChanges: configChangesOf(verified.plan, receipts, restored),
      verification: checked.verification,
      warnings: checked.warnings,
      nextActions: [compensationFailed ? COMPENSATION_INCOMPLETE_ACTION : "다시 읽은 설정이 계획과 달라 원래 내용으로 되돌렸습니다", ...checked.nextActions],
    }));
  }
  return finalize(withToolConfig({
    ...base,
    status: "succeeded",
    steps,
    retryable: false,
    configChanges: configChangesOf(verified.plan, receipts, restored),
    verification: checked.verification,
    warnings: checked.warnings,
    nextActions: checked.nextActions,
  }));
}
