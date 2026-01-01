import { EventEmitter } from "node:events";
import os from "node:os";
import {
  LIFECYCLE_APPROVAL_MESSAGES,
  defaultHostEnvironment,
  entryKeyOf,
  formatLifecyclePlanPreview,
  formatLifecycleResult,
  formatLifecycleStatusItem,
  healthLines,
  lifecycleStatus,
  loadRegistry,
  locateWindowsNpxLauncher,
  planLifecycleRequest,
  probeBackends,
  projectKeyFor,
  readLifecycleState,
  requestLifecycleApproval,
  runLifecycleTransaction,
  stateUnreadableMessage,
  toRecommendPlatform,
  type BackendProbeReport,
  type ConfigFs,
  type ExecChild,
  type ExecSpawner,
  type FetchLike,
  type InstallClient,
  type IsolatedDir,
  type LifecycleApprovalPrompter,
  type LifecycleEnvironment,
  type LifecycleOperation,
  type LifecycleRequest,
  type LifecycleResultV1,
  type LifecycleToolStatus,
  type PlannedLifecycle,
} from "@openhub/core";
import type { NativeDialogLike } from "./install";

/**
 * Desktop Lifecycle(TASK-046, D-005·D-017~D-020). INSTALLED 카드 → 상태(drift·lock·Health) → [업데이트 확인]·[업데이트 계획]·
 * [Health Check]·[이전 버전으로 롤백] → Preview → 승인 항목 체크 → 네이티브 확인 → 진행 → 결과.
 * - IPC 인자는 state entry id("scope:client:serverName") 하나뿐이다. 경로·Plan·digest를 보내도 무시한다.
 * - 최종 Approval은 main 프로세스의 네이티브 확인 대화상자에서만 만들어진다(channel "desktop-native-dialog").
 * - timer·polling이 없다. resolver(network)는 [업데이트 확인]·[업데이트 계획]을 눌렀을 때만 호출한다.
 * - config-drift·untracked-foreign·state 손상은 경고만 보여 주고 실행 버튼을 만들지 않는다.
 * - Desktop은 사용자 범위 config를 읽지 않는다(D-003). project scope만 다룬다.
 * - Preview·결과·상태 문장은 CLI와 같은 Core 문장이다. skip된 Health는 Not verified로만 표시한다.
 */

export const LIFECYCLE_STATUS_CHANNEL = "lifecycle:status";
export const LIFECYCLE_CHECK_CHANNEL = "lifecycle:check";
export const LIFECYCLE_PLAN_CHANNELS = { update: "lifecycle:plan-update", rollback: "lifecycle:plan-rollback", health: "lifecycle:plan-health" } as const;
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
  lines: string[];
  health: string[];
  changed: string[];
  /** PLAN_STALE이면 재승인 화면으로 돌아간다. */
  reapprove: boolean;
}
export type LifecycleRunResponse = { status: "done"; result: LifecycleResultView } | { status: "rejected" | "no-plan" } | { status: "error"; code: string; message: string };

const STATE_CODES = new Set(["STATE_CORRUPT", "STATE_VERSION_UNSUPPORTED", "STATE_PATH_ESCAPE"]);
const OPERATION_TITLE = { update: "업데이트", rollback: "롤백", health: "Health Check" } as const;
const WARNINGS: Partial<Record<LifecycleToolStatus["state"], string>> = {
  "config-drift": "설정이 OpenHub가 기록한 내용과 달라 업데이트·롤백을 막았습니다. 설정 파일을 직접 확인하세요.",
  "missing-config": "설정 항목이 없어 업데이트·롤백을 막았습니다.",
  "untracked-foreign": "OpenHub가 관리하지 않는 설정입니다. 자동으로 편입하지 않습니다.",
  "untracked-adoptable": "OpenHub 표준 항목과 같지만 Version State에 없습니다. 업데이트·롤백 대상이 아닙니다.",
};

/** entry id는 "scope:client:serverName"이다(현재 프로젝트 기준, 경로 없음). */
const idOf = (item: Pick<LifecycleToolStatus, "scope" | "client" | "serverName">) => item.scope + ":" + item.client + ":" + item.serverName;

/** 네이티브 확인 대화상자 prompter. 사람이 [승인]을 누르면 나열한 요구를 모두 확인한 것이다. */
export function nativeLifecycleDialogPrompter(dialog: NativeDialogLike): LifecycleApprovalPrompter {
  return {
    channel: "desktop-native-dialog",
    async confirm(request) {
      const { plan, planDigest } = request.planned;
      const detail = [...request.requirements.map((r) => "• [" + r.id + "] " + r.message), "", "Plan digest " + planDigest].join("\n");
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: "OpenHub " + OPERATION_TITLE[plan.operation] + " 승인",
        message: plan.displayName + " " + OPERATION_TITLE[plan.operation] + " 계획을 승인합니까?",
        detail,
        buttons: ["취소", "승인"],
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
    windowsNpx: async () => {
      const host = defaultHostEnvironment();
      return locateWindowsNpxLauncher({ pathEnv: host.pathEnv, fs: host.fs });
    },
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
  if (platform === undefined) return { status: "error", code: "platform-unsupported", message: "이 운영체제에서는 lifecycle을 지원하지 않습니다" };
  const { entries } = await loadRegistry(deps.registryDir);
  const fs = deps.configFs === undefined ? {} : { fs: deps.configFs };
  const status = await lifecycleStatus({ projectRoot: dir, homeDir: deps.homeDir, entries, platform, includeUser: false, ...fs });
  if (!status.ok) return STATE_CODES.has(status.code) ? { status: "state-unreadable", code: status.code, message: stateUnreadableMessage(status.code) } : { status: "error", code: status.code, message: "Version State를 읽지 못했습니다" };
  const state = await readLifecycleState({ homeDir: deps.homeDir, ...fs });
  const projectKey = await projectKeyFor(dir, deps.configFs);
  const raw = new Map<string, LifecycleToolStatus>();
  const items = status.items.map((item): LifecycleEntryView => {
    const id = idOf(item);
    raw.set(id, item);
    const managed = item.toolId !== null && item.revision !== null;
    const consistent = managed && item.state === "state-consistent";
    const key = entryKeyOf({ client: item.client as InstallClient, scope: item.scope, file: item.file, serverName: item.serverName, projectName: null, projectKey: item.scope === "project" ? projectKey : null });
    const hasPrevious = state.ok && (state.state.entries[key]?.previous ?? null) !== null;
    const [title, ...lines] = formatLifecycleStatusItem(item);
    return { id, toolId: item.toolId, title: title!, lines, state: item.state, managed, canUpdate: consistent, canRollback: consistent && hasPrevious, canHealth: consistent, warning: WARNINGS[item.state] ?? null };
  });
  return { dir, entries, items, raw };
}

/** lifecycle:status — 인자 없음. network·spawn·write 0회. */
export async function statusForRenderer(session: LifecycleSession, deps: LifecycleDeps): Promise<LifecycleStatusResponse> {
  try {
    const snap = await snapshot(session, deps);
    if (!("raw" in snap)) return snap;
    return { status: "ok", items: snap.items, note: "사용자 범위 설정은 Desktop에서 확인하지 않습니다(CLI --include-host)." };
  } catch {
    return { status: "error", code: "status-failed", message: "상태를 읽지 못했습니다" };
  }
}

async function requestFor(operation: LifecycleOperation, session: LifecycleSession, deps: LifecycleDeps, id: unknown) {
  const snap = await snapshot(session, deps);
  if (!("raw" in snap)) return { error: snap.status === "no-project" ? ({ status: "no-project" } as const) : ({ status: "not-managed" } as const) };
  if (typeof id !== "string") return { error: { status: "not-managed" } as const };
  const view = snap.items.find((i) => i.id === id);
  const item = snap.raw.get(id);
  const allowed = operation === "rollback" ? view?.canRollback : operation === "health" ? view?.canHealth : view?.canUpdate;
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
    if (!built.ok) return { status: "ok", view: { id: id as string, result: "check-failed", from: null, to: null, message: "확인하지 못했습니다 (" + built.code + ")" } };
    const p = built.planned.plan;
    const from = p.current.identity?.spec ?? p.current.requested;
    const to = p.target.identity?.spec ?? null;
    const result = p.status === "ready" ? "update-available" : p.status === "up-to-date" ? "up-to-date" : "blocked";
    const message = result === "update-available" ? "업데이트 있음 " + from + " → " + to : result === "up-to-date" ? "최신 버전입니다" : "확인할 수 없습니다 (" + p.warnings.map((w) => w.code).join(", ") + ")";
    return { status: "ok", view: { id: id as string, result, from, to, message } };
  } catch {
    return { status: "error", code: "check-failed", message: "업데이트를 확인하지 못했습니다" };
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
        previewLines: formatLifecyclePlanPreview(built.planned),
        requirements: plan.approvalRequirements.map((rid) => ({ id: rid, message: LIFECYCLE_APPROVAL_MESSAGES[rid] })),
        executable: plan.status === "ready",
        upToDate: plan.status === "up-to-date",
      },
    };
  } catch {
    return { status: "error", code: "plan-failed", message: "계획을 만들지 못했습니다" };
  }
}

export function buildLifecycleResultView(result: LifecycleResultV1): LifecycleResultView {
  return {
    status: result.status,
    code: result.code ?? null,
    lines: formatLifecycleResult(result).filter((l) => l !== ""),
    health: result.health === null ? [] : healthLines(result.health),
    changed: [...(result.changed ?? [])],
    reapprove: result.status === "stale",
  };
}

/** lifecycle:run — entry id 하나. 화면에 보여 준 Plan을 네이티브 대화상자로 승인받아 실행한다. */
export async function runForRenderer(session: LifecycleSession, deps: LifecycleDeps, id: unknown): Promise<LifecycleRunResponse> {
  if (typeof id !== "string") return { status: "no-plan" };
  const pending = session.take(id);
  if (pending === undefined) return { status: "no-plan" };
  try {
    const { entries } = await loadRegistry(deps.registryDir);
    const env = environment(deps, entries);
    if (pending.planned.plan.status === "up-to-date") return { status: "done", result: buildLifecycleResultView(await runLifecycleTransaction(pending.planned, undefined, pending.request, env)) };
    const outcome = await requestLifecycleApproval(pending.planned, nativeLifecycleDialogPrompter(deps.dialog));
    if (outcome.status !== "approved") return { status: "rejected" };
    return { status: "done", result: buildLifecycleResultView(await runLifecycleTransaction(pending.planned, outcome.approval, pending.request, env)) };
  } catch {
    return { status: "error", code: "run-failed", message: "실행하지 못했습니다" };
  }
}

/** IPC 핸들러 등록. 첫 번째 인자(entry id)만 쓰고 나머지는 무시한다. */
export function registerLifecycle(ipc: IpcMainLike, session: LifecycleSession, deps: LifecycleDeps): void {
  ipc.handle(LIFECYCLE_STATUS_CHANNEL, () => statusForRenderer(session, deps));
  ipc.handle(LIFECYCLE_CHECK_CHANNEL, (_event: unknown, id: unknown) => checkForRenderer(session, deps, id));
  for (const operation of ["update", "rollback", "health"] as const) {
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

