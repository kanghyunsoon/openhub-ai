import type { ProjectProfile } from "../analyzer/index";
import type { BackendProbeReport } from "../process/probe";
import { probeToRecommendContext } from "../process/probe";
import { executeVerifiedPlan, type ExecSpawner, type IsolatedDir, type StepOutcome } from "../process/executor";
import { recommend, type MetadataSnapshot, type RecommendPlatform, type RecommendationReport } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { verifyApprovedPlan, type InstallApproval, type VerifiedPlan } from "./approval-v1";
import { ConfigWriteError, applyConfigPatch, inspectConfigTarget, readConfiguredEntry, restoreConfig, type ConfigFs, type ConfigWriteReceipt } from "./config-writer";
import { canonicalize, type ConfigPatchStep, type ConfigScope, type InstallClient, type PlannedInstall } from "./plan";
import { buildInstallPlan, type PlanBuildResult } from "./plan-builder";
import { installResultSchema, type InstallResultV1, type InstallVerification } from "./result";

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
  /** 확인 단계(TASK-034). 없으면 Prepared·Configured만 확인하고 Detected는 skipped다. */
  verify?: InstallVerifier;
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
  const result = buildInstallPlan({ toolId: request.toolId, entries, report, probes, targets, platform: request.platform });
  return { result, report, profile };
}

const configChangesOf = (plan: VerifiedPlan["plan"], receipts: readonly ConfigWriteReceipt[], restored: ReadonlySet<ConfigWriteReceipt>) =>
  plan.steps
    .filter((s): s is ConfigPatchStep => s.kind === "config-patch")
    .map((s) => {
      const receipt = receipts.find((r) => r.client === s.client && r.scope === s.scope);
      return { client: s.client, scope: s.scope, file: s.file, serverName: s.path[1]!, applied: receipt !== undefined, restored: receipt !== undefined && restored.has(receipt) };
    });

const requiredEnvOf = (plan: PlannedInstall["plan"]) => plan.requiredEnv.filter((e) => e.required).map((e) => ({ name: e.name, status: "unchecked" as const }));

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
export const basicVerifier: InstallVerifier = async ({ verified, request, steps, env }) => {
  const runSteps = verified.plan.steps.filter((s) => s.kind === "run");
  const prepared = runSteps.every((s) => steps.find((o) => o.id === s.id)?.status === "done") ? (verified.plan.artifact?.preparation === "pull" ? "pulled" : "launch-on-demand") : "failed";
  let configured = prepared !== "failed";
  for (const step of verified.plan.steps.filter((s): s is ConfigPatchStep => s.kind === "config-patch")) {
    const entry = await readConfiguredEntry(step.client, step.scope, step.path[1]!, { projectRoot: request.projectRoot, homeDir: request.homeDir, ...(env.configFs === undefined ? {} : { fs: env.configFs }) });
    if (JSON.stringify(canonicalize(entry)) !== JSON.stringify(canonicalize(step.value))) configured = false;
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
  const report = await executeVerifiedPlan(verified, {
    projectRoot: request.projectRoot,
    ...(env.spawner === undefined ? {} : { spawner: env.spawner }),
    ...(env.isolatedDir === undefined ? {} : { isolatedDir: env.isolatedDir }),
    onConfigStep: async (step) => {
      if (!configTraced) {
        trace("config-write");
        configTraced = true;
      }
      try {
        receipts.push(await applyConfigPatch(step, { ...roots, acknowledgements: verified.acknowledgements }));
        return { id: step.id, status: "done" };
      } catch (error) {
        configError = error instanceof ConfigWriteError ? error.code : "CONFIG_WRITE_FAILED";
        return { id: step.id, status: "failed", code: configError, ...(error instanceof ConfigWriteError ? { excerpt: error.message } : {}) };
      }
    },
  });
  if (!report.ok) return notExecuted(planned, "approval-required", report.code, true);

  const restored = new Set<ConfigWriteReceipt>();
  const compensate = async () => {
    for (const receipt of [...receipts].reverse()) if (await restoreConfig(receipt, env.configFs)) restored.add(receipt);
  };
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
    return finalize({
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
    });
  }

  if (configError !== undefined) {
    await compensate();
    const compensatedIds = new Set([...restored].map((r) => "config-" + r.client + "-" + r.scope));
    steps = steps.map((s) => (s.status === "done" && compensatedIds.has(s.id) ? { ...s, status: "compensated" as const } : s));
    return finalize({
      ...base,
      status: receipts.length > 0 ? "partial-compensated" : "failed",
      code: configError,
      steps,
      ...(report.failedStep === undefined ? {} : { failedStep: report.failedStep }),
      retryable: CONFIG_RETRYABLE[configError] ?? false,
      configChanges: configChangesOf(verified.plan, receipts, restored),
      verification: { prepared: verified.plan.artifact?.preparation === "pull" ? "pulled" : "launch-on-demand", configured: false, detected: "skipped" },
      warnings: [],
      nextActions: receipts.length > 0 ? ["설정 쓰기가 중간에 실패해 이미 쓴 설정 파일을 원래 내용으로 되돌렸습니다"] : ["설정 파일을 쓰지 못했습니다"],
    });
  }

  trace("verify");
  const verifier = env.verify ?? basicVerifier;
  const checked = await verifier({ verified, request, steps: report.steps, receipts, env });
  if (!checked.verification.configured) {
    await compensate();
    return finalize({
      ...base,
      status: receipts.length > 0 ? "partial-compensated" : "failed",
      code: "CONFIGURED_MISMATCH",
      steps,
      retryable: false,
      configChanges: configChangesOf(verified.plan, receipts, restored),
      verification: checked.verification,
      warnings: checked.warnings,
      nextActions: ["다시 읽은 설정이 계획과 달라 원래 내용으로 되돌렸습니다", ...checked.nextActions],
    });
  }
  return finalize({
    ...base,
    status: "succeeded",
    steps,
    retryable: false,
    configChanges: configChangesOf(verified.plan, receipts, restored),
    verification: checked.verification,
    warnings: checked.warnings,
    nextActions: checked.nextActions,
  });
}
