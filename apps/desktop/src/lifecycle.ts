import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  defaultHostEnvironment,
  entryKeyOf,
  lifecycleStatus,
  loadRegistry,
  locateWindowsNpxLauncher,
  npmChildEnv,
  npxCacheKey,
  parseNpmSpec,
  planLifecycleRequest,
  probeBackends,
  projectKeyFor,
  readLifecycleState,
  requestLifecycleApproval,
  runLifecycleTransaction,
  toRecommendPlatform,
  type BackendProbeReport,
  type ClientLauncher,
  type ConfigFs,
  type ExecChild,
  type ExecSpawner,
  type FetchLike,
  type InstallClient,
  type IsolatedDir,
  type LauncherCheckFs,
  type LifecycleApprovalPrompter,
  type LifecycleApprovalRequirement,
  type LifecycleEnvironment,
  type LifecycleOperation,
  type LifecycleRequest,
  type LifecycleResultV1,
  type LifecycleToolStatus,
  type PlannedLifecycle,
} from "@openhub/core";
import type { NativeDialogLike } from "./install";
import { lifecycleApprovalText, lifecyclePreviewLines, lifecycleResultLines, healthTextLines, planWarningTexts, stateUnreadableText, statusItemLines } from "./i18n/core-text";
import { tr, type MessageKey } from "./i18n/index";

/**
 * Desktop Lifecycle(TASK-046, D-005·D-017~D-020). INSTALLED 카드 → 상태(drift·lock·Health) → [업데이트 확인]·[업데이트 계획]·
 * [Health Check]·[이전 버전으로 롤백] → Preview → 승인 항목 체크 → 네이티브 확인 → 진행 → 결과.
 * - IPC 인자는 state entry id("scope:client:serverName") 하나뿐이다. 경로·Plan·digest를 보내도 무시한다.
 * - 최종 Approval은 main 프로세스의 네이티브 확인 대화상자에서만 만들어진다(channel "desktop-native-dialog").
 * - timer·polling이 없다. resolver(network)는 [업데이트 확인]·[업데이트 계획]을 눌렀을 때만 호출한다.
 * - config-drift·untracked-foreign·state 손상은 경고만 보여 주고 실행 버튼을 만들지 않는다.
 * - repair(v0.2.0 P0-3): tool-config-missing·tool-config-drift·tool-config-relocated·client-launcher-invalid(와 Core가 받아 주는
 *   경로만 다른 config-drift)는 Core가 실제로 ready Repair Plan을 만들 때만 [복구 계획 확인] 버튼을 만든다. 복구 로직은 Core의
 *   planLifecycleRequest(repair)·requestLifecycleApproval·runLifecycleTransaction을 그대로 쓴다.
 * - Desktop은 사용자 범위 config를 읽지 않는다(D-003). project scope만 다룬다.
 * - Preview·결과·상태 문장은 CLI와 같은 Core 문장이다. skip된 Health는 Not verified로만 표시한다.
 */

export const LIFECYCLE_STATUS_CHANNEL = "lifecycle:status";
export const LIFECYCLE_CHECK_CHANNEL = "lifecycle:check";
export const LIFECYCLE_PLAN_CHANNELS = { update: "lifecycle:plan-update", rollback: "lifecycle:plan-rollback", health: "lifecycle:plan-health", repair: "lifecycle:plan-repair" } as const;
export const LIFECYCLE_RUN_CHANNEL = "lifecycle:run";

type Listener = (...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
}

export interface LifecycleDeps {
  registryDir: string;
  /** process.platform 형식 */
  platform: string;
  homeDir: string;
  dialog: NativeDialogLike;
  now?: () => Date;
  probe?: () => Promise<BackendProbeReport>;
  fetch?: FetchLike;
  spawner?: ExecSpawner;
  configFs?: ConfigFs;
  isolatedDir?: () => Promise<IsolatedDir>;
  runHealth?: LifecycleEnvironment["runHealth"];
  tempBase?: string;
  /** Windows Client 직접 실행 경로 탐색(테스트 주입용). 기본은 PATH 탐색(실행 없음). */
  windowsNpx?: () => Promise<ClientLauncher | null>;
  /** 실행 경로 검사용 fs(테스트 주입용). */
  launcherCheckFs?: LauncherCheckFs;
}

export interface LifecycleEntryView {
  id: string;
  toolId: string | null;
  title: string;
  lines: string[];
  state: LifecycleToolStatus["state"];
  managed: boolean;
  canUpdate: boolean;
  canRollback: boolean;
  canHealth: boolean;
  /** Core가 이 항목의 ready Repair Plan을 만들 수 있을 때만 true(오류 상태만 보고 켜지 않는다). */
  canRepair: boolean;
  warning: string | null;
}
export type LifecycleStatusResponse =
  | { status: "ok"; items: LifecycleEntryView[]; note: string }
  | { status: "no-project" }
  | { status: "state-unreadable"; code: string; message: string }
  | { status: "error"; code: string; message: string };

export interface LifecycleCheckView {
  id: string;
  result: "update-available" | "up-to-date" | "blocked" | "check-failed";
  from: string | null;
  to: string | null;
  message: string;
}
export type LifecycleCheckResponse = { status: "ok"; view: LifecycleCheckView } | { status: "no-project" | "not-managed" } | { status: "error"; code: string; message: string };

export interface LifecyclePlanView {
  id: string;
  operation: LifecycleOperation;
  displayName: string;
  status: string;
  previewLines: string[];
  requirements: { id: string; message: string }[];
  executable: boolean;
  upToDate: boolean;
}
export type LifecyclePlanResponse = { status: "ok"; view: LifecyclePlanView } | { status: "no-project" | "not-managed" } | { status: "error"; code: string; message: string };

export interface LifecycleResultView {
  status: LifecycleResultV1["status"];
  code: string | null;
  /** succeeded: 끝까지 성공, failed: 실패했고 이번 변경은 되돌림(또는 아무것도 안 바꿈), partial: 일부를 되돌리지 못함, not-run: 실행하지 않음. */
  outcome: "succeeded" | "failed" | "partial" | "not-run";
  /** 결과 한 줄 요약과 다음에 할 일(코드별 고정 문장). */
  summary: string;
  lines: string[];
  health: string[];
  changed: string[];
  /** PLAN_STALE이면 재승인 화면으로 돌아간다. */
  reapprove: boolean;
}
/** project-changed: 계획을 만든 뒤(또는 승인 대화상자가 열린 동안) 다른 프로젝트를 골라 계획과 승인을 버렸다. 실행·쓰기 0. */
export type LifecycleRunResponse =
  | { status: "done"; result: LifecycleResultView }
  | { status: "rejected" | "no-plan" }
  | { status: "project-changed"; message: string }
  | { status: "error"; code: string; message: string };
/** project-changed 안내(현재 Desktop 언어). */
export const projectChangedMessage = (): string => tr("life.projectChanged");

const STATE_CODES = new Set(["STATE_CORRUPT", "STATE_VERSION_UNSUPPORTED", "STATE_PATH_ESCAPE"]);
const OPERATION_KEY = { update: "lifecycle.op.update", rollback: "lifecycle.op.rollback", health: "lifecycle.op.health", repair: "lifecycle.op.repair" } as const;
const opTitle = (op: LifecycleOperation) => tr(OPERATION_KEY[op]);
/** Repair 대상 상태. config-drift는 Core가 "OpenHub 관리 경로만 다름"으로 받아 줄 때만 버튼이 생긴다. */
const REPAIR_STATES = new Set<LifecycleToolStatus["state"]>(["tool-config-missing", "tool-config-drift", "tool-config-relocated", "client-launcher-invalid", "config-drift"]);
const WARNING_KEY: Partial<Record<LifecycleToolStatus["state"], MessageKey>> = {
  "config-drift": "life.warn.configDrift",
  "missing-config": "life.warn.missingConfig",
  "tool-config-missing": "life.warn.toolConfigMissing",
  "tool-config-drift": "life.warn.toolConfigDrift",
  "tool-config-relocated": "life.warn.toolConfigRelocated",
  "client-launcher-invalid": "life.warn.clientLauncherInvalid",
  "untracked-foreign": "life.warn.untrackedForeign",
  "untracked-adoptable": "life.warn.untrackedAdoptable",
};
const warningFor = (state: LifecycleToolStatus["state"]) => (WARNING_KEY[state] === undefined ? null : tr(WARNING_KEY[state]!));

const CLIENT_NAME = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
const scopeName = (scope: "project" | "user") => tr(scope === "project" ? "scope.project" : "scope.user");
const TOOL_CONFIG_ACTION = { create: "dialog.toolConfig.create", replace: "dialog.toolConfig.replace", keep: "dialog.toolConfig.keep" } as const;

/**
 * 네이티브 확인 대화상자 본문. 화면 Preview와 같은 Plan에서 만든다(경로 없음): 도구·Client·scope·바뀔 설정·준비 명령·tool config·
 * Node.js 실행 경로·Health·주의·승인 항목·digest. 보여 주지 않은 변경을 승인 버튼 하나로 실행하지 않도록 Plan의 쓰기·실행을 모두 나열한다.
 * 승인 항목 문장은 요구 ID로 현재 언어 문장을 고른다(의미는 Core 승인 문구와 같다).
 */
export function lifecycleDialogDetail(planned: PlannedLifecycle, requirements: readonly { id: LifecycleApprovalRequirement }[]): string {
  const { plan, planDigest } = planned;
  const lines = [tr("dialog.tool", { name: plan.displayName, toolId: plan.toolId })];
  for (const t of plan.targets) {
    const action = plan.operation === "health" ? tr("dialog.target.noChange") : tr("dialog.target.replace", { server: t.serverName });
    lines.push(tr("dialog.target", { client: CLIENT_NAME[t.client], scope: scopeName(t.scope), file: t.file, action }));
    if (t.launcher !== undefined) {
      const recorded = tr(t.launcher.recorded === "invalid" ? "dialog.launcher.invalid" : "dialog.launcher.valid");
      lines.push("  " + recorded + (plan.operation === "health" ? "" : tr("dialog.launcher.rewrite")));
    }
  }
  const run = plan.steps.filter((s) => s.kind === "run");
  lines.push(tr("dialog.prepare", { commands: run.length === 0 ? tr("common.none") : run.map((s) => s.executable + " " + s.args.join(" ")).join(" / ") }));
  for (const s of plan.steps) if (s.kind === "tool-config") lines.push(tr("dialog.toolConfig", { scope: scopeName(s.scope), action: tr(TOOL_CONFIG_ACTION[s.action]) }));
  const health = plan.steps.some((s) => s.kind === "health");
  lines.push(tr(!health ? "dialog.health.skipped" : plan.operation === "health" ? "dialog.health.only" : "dialog.health.gate"));
  for (const w of planWarningTexts(plan, plan.warnings)) lines.push(tr("dialog.warning", { code: w.code, message: w.text }));
  lines.push("", tr("dialog.requirements"), ...requirements.map((r) => tr("dialog.requirement", { id: r.id, message: lifecycleApprovalText(r.id) })), "", tr("dialog.digest", { digest: planDigest }));
  return lines.join("\n");
}

/** entry id는 "scope:client:serverName"이다(현재 프로젝트 기준, 경로 없음). */
const idOf = (item: Pick<LifecycleToolStatus, "scope" | "client" | "serverName">) => item.scope + ":" + item.client + ":" + item.serverName;

/** 네이티브 확인 대화상자 prompter. 사람이 [승인]을 누르면 나열한 요구를 모두 확인한 것이다. */
export function nativeLifecycleDialogPrompter(dialog: NativeDialogLike): LifecycleApprovalPrompter {
  return {
    channel: "desktop-native-dialog",
    async confirm(request) {
      const { plan } = request.planned;
      const detail = lifecycleDialogDetail(request.planned, request.requirements);
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: tr("dialog.title", { operation: opTitle(plan.operation) }),
        message: tr("dialog.message", { name: plan.displayName, operation: opTitle(plan.operation) }),
        detail,
        buttons: [tr("dialog.cancel"), tr("dialog.approve")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return response === 1 ? request.requirements.map((r) => r.id) : "rejected";
    },
  };
}

/** 화면에 보여 준 Plan을 entry id로 기억한다. 프로젝트 폴더는 설치 흐름과 같은 선택 결과를 쓴다. */
export class LifecycleSession {
  readonly #pending = new Map<string, { planned: PlannedLifecycle; request: LifecycleRequest }>();
  constructor(readonly projectDir: () => string | undefined) {}
  remember(id: string, planned: PlannedLifecycle, request: LifecycleRequest): void {
    this.#pending.clear();
    this.#pending.set(id, { planned, request });
  }
  take(id: string): { planned: PlannedLifecycle; request: LifecycleRequest } | undefined {
    const found = this.#pending.get(id);
    this.#pending.delete(id);
    return found;
  }
}

function environment(deps: LifecycleDeps, entries: Awaited<ReturnType<typeof loadRegistry>>["entries"]): LifecycleEnvironment {
  return {
    loadEntries: async () => entries,
    probe: deps.probe ?? (() => probeBackends()),
    tempBase: deps.tempBase ?? os.tmpdir(),
    now: deps.now ?? (() => new Date()),
    // npx Prepare의 npm 자식 process에는 허용 목록 환경만 넘긴다(API key·token·클라우드 자격증명 제외).
    npmChildEnv: () => npmChildEnv(process.env),
    windowsNpx:
      deps.windowsNpx ??
      (async () => {
        const host = defaultHostEnvironment();
        return locateWindowsNpxLauncher({ pathEnv: host.pathEnv, fs: host.fs });
      }),
    ...(deps.launcherCheckFs === undefined ? {} : { launcherCheckFs: deps.launcherCheckFs }),
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.spawner === undefined ? {} : { spawner: deps.spawner }),
    ...(deps.configFs === undefined ? {} : { configFs: deps.configFs }),
    ...(deps.isolatedDir === undefined ? {} : { isolatedDir: deps.isolatedDir }),
    ...(deps.runHealth === undefined ? {} : { runHealth: deps.runHealth }),
  };
}

interface Snapshot {
  dir: string;
  entries: Awaited<ReturnType<typeof loadRegistry>>["entries"];
  items: LifecycleEntryView[];
  raw: Map<string, LifecycleToolStatus>;
}

async function snapshot(session: LifecycleSession, deps: LifecycleDeps): Promise<Snapshot | LifecycleStatusResponse> {
  const dir = session.projectDir();
  if (dir === undefined) return { status: "no-project" };
  const platform = toRecommendPlatform(deps.platform);
  if (platform === undefined) return { status: "error", code: "platform-unsupported", message: tr("life.platformUnsupported") };
  const { entries } = await loadRegistry(deps.registryDir);
  const fs = deps.configFs === undefined ? {} : { fs: deps.configFs };
  const status = await lifecycleStatus({ projectRoot: dir, homeDir: deps.homeDir, entries, platform, includeUser: false, ...fs, ...(deps.launcherCheckFs === undefined ? {} : { launcherCheckFs: deps.launcherCheckFs }) });
  if (!status.ok) return STATE_CODES.has(status.code) ? { status: "state-unreadable", code: status.code, message: stateUnreadableText(status.code) } : { status: "error", code: status.code, message: tr("life.stateUnreadable") };
  const state = await readLifecycleState({ homeDir: deps.homeDir, ...fs });
  const projectKey = await projectKeyFor(dir, deps.configFs);
  const raw = new Map<string, LifecycleToolStatus>();
  const env = environment(deps, entries);
  const items: LifecycleEntryView[] = [];
  for (const item of status.items) {
    const id = idOf(item);
    raw.set(id, item);
    const managed = item.toolId !== null && item.revision !== null;
    const consistent = managed && item.state === "state-consistent";
    const key = entryKeyOf({ client: item.client as InstallClient, scope: item.scope, file: item.file, serverName: item.serverName, projectName: null, projectKey: item.scope === "project" ? projectKey : null });
    const hasPrevious = state.ok && (state.state.entries[key]?.previous ?? null) !== null;
    const [title, ...lines] = statusItemLines(item);
    // Repair 버튼: 오류 상태만 보고 켜지 않는다. Core가 지금 ready Repair Plan을 만들 수 있을 때만(파일 읽기·PATH 탐색만, 실행·쓰기·network 0).
    let canRepair = false;
    let warning = warningFor(item.state);
    if (REPAIR_STATES.has(item.state) && item.toolId !== null && item.scope === "project") {
      const request = repairRequest(item.toolId, item, dir, deps, platform);
      const built = await planLifecycleRequest(request, env).catch(() => null);
      canRepair = built !== null && built.ok && built.planned.plan.status === "ready";
      const reason = built === null ? "plan-failed" : !built.ok ? built.code : built.planned.plan.warnings.filter((w) => w.code === w.code.toUpperCase()).map((w) => w.code).join(", ") || built.planned.plan.status;
      // 일반 config-drift(Core가 repair를 받지 않음)는 기존 경고 그대로다.
      if (canRepair) warning = (warning ?? "") + tr("life.warn.repairAvailable");
      else if (item.state !== "config-drift") warning = (warning ?? "") + tr("life.warn.repairUnavailable", { reason });
    }
    items.push({ id, toolId: item.toolId, title: title!, lines, state: item.state, managed, canUpdate: consistent, canRollback: consistent && hasPrevious, canHealth: consistent, canRepair, warning });
  }
  return { dir, entries, items, raw };
}

function repairRequest(toolId: string, item: LifecycleToolStatus, dir: string, deps: LifecycleDeps, platform: NonNullable<ReturnType<typeof toRecommendPlatform>>): LifecycleRequest {
  return { operation: "repair", toolId, projectRoot: dir, homeDir: deps.homeDir, platform, includeUser: false, targets: [{ client: item.client as InstallClient, scope: item.scope }] };
}

/** lifecycle:status — 인자 없음. network·spawn·write 0회. */
export async function statusForRenderer(session: LifecycleSession, deps: LifecycleDeps): Promise<LifecycleStatusResponse> {
  try {
    const snap = await snapshot(session, deps);
    if (!("raw" in snap)) return snap;
    return { status: "ok", items: snap.items, note: tr("life.note") };
  } catch {
    return { status: "error", code: "status-failed", message: tr("life.statusFailed") };
  }
}

async function requestFor(operation: LifecycleOperation, session: LifecycleSession, deps: LifecycleDeps, id: unknown) {
  const snap = await snapshot(session, deps);
  if (!("raw" in snap)) return { error: snap.status === "no-project" ? ({ status: "no-project" } as const) : ({ status: "not-managed" } as const) };
  if (typeof id !== "string") return { error: { status: "not-managed" } as const };
  const view = snap.items.find((i) => i.id === id);
  const item = snap.raw.get(id);
  const allowed = operation === "rollback" ? view?.canRollback : operation === "health" ? view?.canHealth : operation === "repair" ? view?.canRepair : view?.canUpdate;
  if (view === undefined || item === undefined || item.toolId === null || allowed !== true) return { error: { status: "not-managed" } as const };
  const request: LifecycleRequest = {
    operation,
    toolId: item.toolId,
    projectRoot: snap.dir,
    homeDir: deps.homeDir,
    platform: toRecommendPlatform(deps.platform)!,
    includeUser: false,
    targets: [{ client: item.client as InstallClient, scope: item.scope }],
  };
  return { request, env: environment(deps, snap.entries) };
}

/** lifecycle:check — entry id 하나. 버튼을 눌렀을 때만 resolver를 호출한다(spawn·write 0회). */
export async function checkForRenderer(session: LifecycleSession, deps: LifecycleDeps, id: unknown): Promise<LifecycleCheckResponse> {
  try {
    const r = await requestFor("update", session, deps, id);
    if ("error" in r) return r.error;
    const built = await planLifecycleRequest(r.request, r.env);
    if (!built.ok) return { status: "ok", view: { id: id as string, result: "check-failed", from: null, to: null, message: tr("life.check.failedCode", { code: built.code }) } };
    const p = built.planned.plan;
    const from = p.current.identity?.spec ?? p.current.requested;
    const to = p.target.identity?.spec ?? null;
    const result = p.status === "ready" ? "update-available" : p.status === "up-to-date" ? "up-to-date" : "blocked";
    const message = result === "update-available" ? tr("life.check.available", { from, to: to ?? "" }) : result === "up-to-date" ? tr("life.check.upToDate") : tr("life.check.blocked", { codes: p.warnings.map((w) => w.code).join(", ") });
    return { status: "ok", view: { id: id as string, result, from, to, message } };
  } catch {
    return { status: "error", code: "check-failed", message: tr("life.check.failed") };
  }
}

/** lifecycle:plan-* — entry id 하나. Plan을 만들어 기억하고 Core Preview 문장을 돌려준다. */
export async function planForRenderer(operation: LifecycleOperation, session: LifecycleSession, deps: LifecycleDeps, id: unknown): Promise<LifecyclePlanResponse> {
  try {
    const r = await requestFor(operation, session, deps, id);
    if ("error" in r) return r.error;
    const built = await planLifecycleRequest(r.request, r.env);
    if (!built.ok) return { status: "error", code: built.code, message: built.message };
    session.remember(id as string, built.planned, r.request);
    const plan = built.planned.plan;
    return {
      status: "ok",
      view: {
        id: id as string,
        operation,
        displayName: plan.displayName,
        status: plan.status,
        previewLines: lifecyclePreviewLines(built.planned),
        requirements: plan.approvalRequirements.map((rid) => ({ id: rid, message: lifecycleApprovalText(rid) })),
        executable: plan.status === "ready",
        upToDate: plan.status === "up-to-date",
      },
    };
  } catch {
    return { status: "error", code: "plan-failed", message: tr("life.planFailed") };
  }
}

/** 실패 코드별 다음 행동(고정 문장, 카탈로그 guide.<CODE>). 코드는 Core LifecycleResult 계약 그대로다. */
const GUIDED_CODES = ["PLAN_STALE", "CLIENT_LAUNCHER_UNAVAILABLE", "TOOL_CONFIG_DRIFT", "TOOL_CONFIG_STALE", "CONFIG_DRIFT", "CONFIG_RESTORE_FAILED", "COMPENSATION_INCOMPLETE", "MANUAL_SETUP_REQUIRED"] as const;
const guidance = (code: string | undefined): string | undefined => ((GUIDED_CODES as readonly string[]).includes(code ?? "") ? tr(("guide." + code) as MessageKey) : undefined);
const SUCCEEDED = new Set<LifecycleResultV1["status"]>(["updated", "rolled-back", "health-checked", "repaired", "up-to-date"]);

function outcomeOf(result: LifecycleResultV1): Pick<LifecycleResultView, "outcome" | "summary"> {
  const operation = opTitle(result.operation);
  const guide = guidance(result.code);
  const code = result.code ?? result.status;
  if (SUCCEEDED.has(result.status)) return { outcome: "succeeded", summary: tr("outcome.succeeded", { operation, status: result.status }) };
  if (result.status === "rollback-failed") return { outcome: "partial", summary: tr("outcome.partial", { operation, code, guide: guide ?? tr("guide.CONFIG_RESTORE_FAILED") }) };
  if (result.status === "stale" || result.status === "approval-required") return { outcome: "not-run", summary: tr("outcome.notRun", { operation, code, guide: guide ?? tr("outcome.notRunDefault") }) };
  if (result.status === "health-failed") {
    const reverted = result.compensated ? tr("outcome.healthReverted") : "";
    return { outcome: "failed", summary: tr("outcome.healthFailed", { operation, code: result.code === undefined ? "" : ": " + result.code, reverted, guide: guide === undefined ? "" : " " + guide }) };
  }
  const reverted = result.compensated ? tr("outcome.reverted") : "";
  return { outcome: "failed", summary: tr("outcome.failed", { operation, code, reverted, guide: guide ?? tr("outcome.failedDefault") }) };
}

export function buildLifecycleResultView(result: LifecycleResultV1): LifecycleResultView {
  return {
    status: result.status,
    code: result.code ?? null,
    ...outcomeOf(result),
    lines: lifecycleResultLines(result, guidance(result.code) ?? null).filter((l) => l !== ""),
    health: result.health === null ? [] : healthTextLines(result.health),
    changed: [...(result.changed ?? [])],
    reapprove: result.status === "stale",
  };
}

/** lifecycle:run — entry id 하나. 화면에 보여 준 Plan을 네이티브 대화상자로 승인받아 실행한다. */
export async function runForRenderer(session: LifecycleSession, deps: LifecycleDeps, id: unknown): Promise<LifecycleRunResponse> {
  if (typeof id !== "string") return { status: "no-plan" };
  const pending = session.take(id);
  if (pending === undefined) return { status: "no-plan" };
  // 계획을 만든 뒤 다른 프로젝트를 선택했으면 이전 계획을 실행하지 않는다(계획은 이미 버렸다). 대화상자도 열지 않는다.
  const sameProject = () => session.projectDir() === pending.request.projectRoot;
  if (!sameProject()) return { status: "project-changed", message: projectChangedMessage() };
  try {
    const { entries } = await loadRegistry(deps.registryDir);
    const env = environment(deps, entries);
    if (pending.planned.plan.status === "up-to-date") return { status: "done", result: buildLifecycleResultView(await runLifecycleTransaction(pending.planned, undefined, pending.request, env)) };
    const outcome = await requestLifecycleApproval(pending.planned, nativeLifecycleDialogPrompter(deps.dialog));
    if (outcome.status !== "approved") return { status: "rejected" };
    // 대화상자가 열린 동안 다른 프로젝트를 골랐으면 방금 받은 승인도 쓰지 않는다(승인·계획 폐기, 실행·쓰기 0).
    if (!sameProject()) return { status: "project-changed", message: projectChangedMessage() };
    return { status: "done", result: buildLifecycleResultView(await runLifecycleTransaction(pending.planned, outcome.approval, pending.request, env)) };
  } catch {
    return { status: "error", code: "run-failed", message: tr("life.runFailed") };
  }
}

/** IPC 핸들러 등록. 첫 번째 인자(entry id)만 쓰고 나머지는 무시한다. */
export function registerLifecycle(ipc: IpcMainLike, session: LifecycleSession, deps: LifecycleDeps): void {
  ipc.handle(LIFECYCLE_STATUS_CHANNEL, () => statusForRenderer(session, deps));
  ipc.handle(LIFECYCLE_CHECK_CHANNEL, (_event: unknown, id: unknown) => checkForRenderer(session, deps, id));
  for (const operation of ["update", "rollback", "health", "repair"] as const) {
    ipc.handle(LIFECYCLE_PLAN_CHANNELS[operation], (_event: unknown, id: unknown) => planForRenderer(operation, session, deps, id));
  }
  ipc.handle(LIFECYCLE_RUN_CHANNEL, (_event: unknown, id: unknown) => runForRenderer(session, deps, id));
}

/**
 * 스모크 전용(AC-046-08, --smoke + OPENHUB_SMOKE_UPDATE일 때만 main이 사용).
 * fake resolver(네트워크 없음)·fake Health(프로세스 없음)·fake executor·자동 확인 대화상자. 호출 기록을 남긴다.
 */
export function smokeLifecycleDeps(): Required<Pick<LifecycleDeps, "fetch" | "runHealth" | "spawner" | "dialog">> & { fetched: string[]; healthRuns: number; spawned: string[][]; dialogs: number } {
  const record = { fetched: [] as string[], healthRuns: 0, spawned: [] as string[][], dialogs: 0 };
  const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
  return Object.assign(record, {
    fetch: (async (url: string) => {
      record.fetched.push(url);
      const npm = /^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/u.exec(url);
      if (npm !== null) return json({ name: decodeURIComponent(npm[1]!), version: "9.9.9" });
      const pypi = /^https:\/\/pypi\.org\/pypi\/([^/]+)\/json$/u.exec(url);
      if (pypi !== null) return json({ info: { name: pypi[1], version: "9.9.9" } });
      if (url.includes("/token")) return json({ token: "smoke" });
      if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "9".repeat(64) } });
      return new Response("missing", { status: 404 });
    }) as FetchLike,
    runHealth: (async (verified) => {
      record.healthRuns += 1;
      return { ok: true, result: { status: "healthy", reason: null, toolCount: 1, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null } };
    }) as NonNullable<LifecycleEnvironment["runHealth"]>,
    spawner: ((executable: string, args: readonly string[]) => {
      record.spawned.push([executable, ...args]);
      const events = new EventEmitter();
      queueMicrotask(() => events.emit("close", 0, null));
      return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
    }) as ExecSpawner,
    dialog: {
      showMessageBox: async () => {
        record.dialogs += 1;
        return { response: 1 };
      },
    } satisfies NativeDialogLike,
  });
}

/**
 * 스모크 전용 Repair(v0.2.0 P0-3, --smoke + OPENHUB_SMOKE_REPAIR일 때만 main이 사용). 실제 Electron 창에서 renderer의
 * [복구 계획 확인] → 승인 → 실행 경로를 통과시키기 위한 가짜 npm(npx Prepare 흉내: cacheRoot 아래에 cache 항목만 만든다, network 0)·
 * 가짜 Health(프로세스 없음)·자동 확인 대화상자. 호출 기록을 남긴다.
 */
export function smokeRepairDeps(cacheRoot: string): Required<Pick<LifecycleDeps, "runHealth" | "spawner" | "dialog">> & { npmCalls: string[][]; healthRuns: number; dialogs: string[] } {
  const record = { npmCalls: [] as string[][], healthRuns: 0, dialogs: [] as string[] };
  const spawner = ((executable: string, args: readonly string[]) => {
    record.npmCalls.push([executable, ...args]);
    const stdout = new EventEmitter();
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new EventEmitter(), pid: 4242, kill: () => true });
    const pkg = args.find((a) => a.startsWith("--package="));
    queueMicrotask(() => {
      if (args.slice(-3).join(" ") === "config get cache") {
        stdout.emit("data", Buffer.from(cacheRoot + "\n"));
        return void child.emit("close", 0, null);
      }
      const parsed = pkg === undefined ? null : parseNpmSpec(pkg.slice("--package=".length));
      if (pkg !== undefined && parsed !== null) {
        const spec = pkg.slice("--package=".length);
        const dir = path.join(cacheRoot, "_npx", npxCacheKey(spec));
        mkdirSync(path.join(dir, "node_modules", ...parsed.name.split("/")), { recursive: true });
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { [parsed.name]: parsed.version }, _npx: { packages: [spec] } }));
        writeFileSync(path.join(dir, "node_modules", ...parsed.name.split("/"), "package.json"), JSON.stringify({ name: parsed.name, version: parsed.version }));
        writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), "{}");
      }
      child.emit("close", 0, null);
    });
    return child as never;
  }) as ExecSpawner;
  return Object.assign(record, {
    spawner,
    runHealth: (async () => {
      record.healthRuns += 1;
      return { ok: true, result: { status: "healthy", reason: null, toolCount: 13, environmentUnverified: false, terminated: true, excerpt: null } };
    }) as NonNullable<LifecycleEnvironment["runHealth"]>,
    dialog: {
      showMessageBox: async (options: Parameters<NativeDialogLike["showMessageBox"]>[0]) => {
        record.dialogs.push(options.title ?? "");
        return { response: 1 };
      },
    } satisfies NativeDialogLike,
  });
}

