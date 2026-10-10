import { EventEmitter } from "node:events";
import {
  INSTALL_CLIENTS,
  analyzeProject,
  defaultHostEnvironment,
  loadRegistry,
  locateWindowsNpxLauncher,
  npmChildEnv,
  planInstall,
  probeBackends,
  recordInstallInState,
  requestApproval,
  runInstallTransaction,
  toRecommendPlatform,
  verifyInstallation,
  type ApprovalPrompter,
  type BackendProbeReport,
  type ConfigFs,
  type ExecChild,
  type ExecSpawner,
  type InstallClient,
  type InstallEnvironment,
  type InstallPlanV1,
  type InstallRequest,
  type InstallResultV1,
  type IsolatedDir,
  type PlannedInstall,
} from "@openhub/core";
import type { DirectoryPicker } from "./project-scan";
import { recommendCurrentProject, type RecommendSession } from "./recommend";
import { installApprovalText, installNextActionTexts, installPreviewLines, installWarningTexts, installationStatusText } from "./i18n/core-text";
import { tr } from "./i18n/index";

/**
 * Desktop 설치 흐름(TASK-036, D-005·D-012). FOR YOU 카드 → Plan Preview → 추가 승인 체크 → 네이티브 확인 → 실행 → 결과.
 * - IPC 인자는 현재 추천 목록에 있는 toolId 하나뿐이다. 경로·Plan·digest를 보내도 무시한다.
 * - 최종 Approval은 main 프로세스의 네이티브 확인 대화상자에서만 만들어진다(channel "desktop-native-dialog").
 *   renderer 체크박스는 확인 버튼을 켜는 화면 단계일 뿐 Approval을 만들지 않는다.
 * - Desktop은 Host Probe를 실행하지 않으므로(D-003·TASK-015) project scope만 계획한다. user scope 설치는 CLI --scope user다.
 * - Preview 문장은 CLI와 같은 Core formatInstallPlanPreview를 쓴다.
 */

export const INSTALL_PLAN_CHANNEL = "install:plan";
export const INSTALL_RUN_CHANNEL = "install:run";

type Listener = (...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
}

export interface NativeDialogLike {
  showMessageBox(options: {
    type: "warning";
    title: string;
    message: string;
    detail: string;
    buttons: string[];
    defaultId: number;
    cancelId: number;
    noLink: boolean;
  }): Promise<{ response: number }>;
}

export interface InstallDeps {
  registryDir: string;
  metadataFile: string;
  /** process.platform 형식 */
  platform: string;
  homeDir: string;
  /** 테스트용 시계(Version State committedAt). */
  now?: () => Date;
  recommend: RecommendSession;
  dialog: NativeDialogLike;
  probe?: () => Promise<BackendProbeReport>;
  spawner?: ExecSpawner;
  configFs?: ConfigFs;
  isolatedDir?: () => Promise<IsolatedDir>;
}

export interface InstallPlanView {
  toolId: string;
  displayName: string;
  status: string;
  installationStatus: string;
  previewLines: string[];
  targets: { file: string; client: string; scope: "project" | "user"; userScope: boolean; manual: boolean }[];
  requirements: { id: string; message: string; userScope: boolean }[];
  userScope: boolean;
  executable: boolean;
  alreadyInstalled: boolean;
}

export type InstallPlanResponse =
  | { status: "ok"; view: InstallPlanView }
  | { status: "no-project" | "not-recommended" | "no-client" }
  | { status: "error"; code: string; message: string };

export interface InstallResultView {
  status: InstallResultV1["status"];
  code: string | null;
  changed: string[];
  stages: { name: "Prepared" | "Configured" | "Detected"; value: string }[];
  configChanges: string[];
  warnings: string[];
  nextActions: string[];
  /** PLAN_STALE이면 재승인 화면으로 돌아간다. */
  reapprove: boolean;
}

/** project-changed: 승인 대화상자가 열린 동안 다른 프로젝트를 골라 계획과 승인을 버렸다(실행·쓰기 0). */
export type InstallRunResponse =
  | { status: "done"; result: InstallResultView }
  | { status: "rejected" | "no-plan" }
  | { status: "project-changed"; message: string }
  | { status: "error"; code: string; message: string };

/** Plan → 화면 데이터. 문자열은 renderer가 textContent로만 넣는다. */
export function buildInstallPlanView(planned: PlannedInstall): InstallPlanView {
  const { plan } = planned;
  const userScope = plan.targets.some((t) => t.scope === "user" && t.envReference !== "manual");
  return {
    toolId: plan.toolId,
    displayName: plan.displayName,
    status: plan.status,
    installationStatus: installationStatusText(plan),
    previewLines: installPreviewLines(planned),
    targets: plan.targets.map((t) => ({ file: t.file, client: t.client, scope: t.scope, userScope: t.scope === "user", manual: t.envReference === "manual" })),
    requirements: plan.approvalRequirements.map((id) => ({ id, message: installApprovalText(id), userScope: id === "user-scope-config" })),
    userScope,
    executable: plan.status === "installable",
    alreadyInstalled: plan.status === "already-installed",
  };
}

const preparedLabel = (value: string) => (value === "launch-on-demand" ? tr("install.prepared.launchOnDemand") : value === "cached" ? tr("install.prepared.cached") : value);

/** InstallResult → 화면 데이터. plan이 있으면 English 모드의 다음에 할 일·경고를 Plan 구조에서 만든다(한국어는 Core 문장 그대로). */
export function buildInstallResultView(result: InstallResultV1, plan?: InstallPlanV1): InstallResultView {
  const v = result.verification;
  return {
    status: result.status,
    code: result.code ?? null,
    changed: [...(result.changed ?? [])],
    stages:
      v === null
        ? []
        : [
            { name: "Prepared", value: preparedLabel(v.prepared) },
            { name: "Configured", value: tr(v.configured ? "common.yes" : "common.no") },
            { name: "Detected", value: v.detected === "skipped" ? tr("install.detected.skipped") : tr(v.detected ? "common.yes" : "common.no") },
          ],
    configChanges: result.configChanges.map((c) =>
      tr("install.configChange", { file: c.file, scope: tr(c.scope === "user" ? "scope.user" : "scope.project"), state: tr(c.restored ? "install.configChange.restored" : c.applied ? "install.configChange.applied" : "install.configChange.none") }),
    ),
    warnings: plan === undefined ? result.warnings.map((w) => "[" + w.code + "] " + w.message) : installWarningTexts(result, plan),
    nextActions: plan === undefined ? [...result.nextActions] : installNextActionTexts(result, plan),
    reapprove: result.status === "stale",
  };
}

/** 네이티브 확인 대화상자 prompter. 사람이 [설치 승인]을 누르면 나열한 요구를 모두 확인한 것이다. */
export function nativeDialogPrompter(dialog: NativeDialogLike): ApprovalPrompter {
  return {
    channel: "desktop-native-dialog",
    async confirm(request) {
      const { plan, planDigest } = request.planned;
      const detail = [...request.requirements.map((r) => tr("dialog.requirement", { id: r.id, message: installApprovalText(r.id) })), "", tr("dialog.digest", { digest: planDigest })].join("\n");
      const { response } = await dialog.showMessageBox({
        type: "warning",
        title: tr("install.dialog.title"),
        message: tr("install.dialog.message", { name: plan.displayName }),
        detail,
        buttons: [tr("dialog.cancel"), tr("install.dialog.approve")],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      });
      return response === 1 ? request.requirements.map((r) => r.id) : "rejected";
    },
  };
}

/** 마지막으로 고른 프로젝트 폴더와 화면에 보여 준 Plan을 기억한다. */
export class InstallSession {
  #dir: string | undefined;
  readonly #pending = new Map<string, { planned: PlannedInstall; request: InstallRequest }>();

  /** [프로젝트 선택] picker를 감싸 고른 폴더를 기억한다(결과는 바꾸지 않는다). */
  trackPicker(pick: DirectoryPicker): DirectoryPicker {
    return async () => {
      const dir = await pick();
      this.#dir = dir;
      this.#pending.clear();
      return dir;
    };
  }

  get projectDir(): string | undefined {
    return this.#dir;
  }
  remember(toolId: string, planned: PlannedInstall, request: InstallRequest): void {
    this.#pending.set(toolId, { planned, request });
  }
  take(toolId: string): { planned: PlannedInstall; request: InstallRequest } | undefined {
    const found = this.#pending.get(toolId);
    this.#pending.delete(toolId);
    return found;
  }
}

function environment(deps: InstallDeps, entries: Awaited<ReturnType<typeof loadRegistry>>["entries"]): InstallEnvironment {
  return {
    loadEntries: async () => entries,
    analyze: async (root) => {
      const result = await analyzeProject(root);
      if (!result.ok) throw new Error(result.error.code);
      return result.profile;
    },
    probe: deps.probe ?? (() => probeBackends()),
    verify: verifyInstallation,
    // npx Prepare(정확한 버전 npx 패키지)는 Windows에서 cmd 없이 node.exe + npx-cli.js로 실행한다.
    // npx Prepare의 npm 자식 process에는 허용 목록 환경만 넘긴다(API key·token·클라우드 자격증명 제외).
    npmChildEnv: () => npmChildEnv(process.env),
    windowsNpx: async () => {
      const host = defaultHostEnvironment();
      return locateWindowsNpxLauncher({ pathEnv: host.pathEnv, fs: host.fs });
    },
    ...(deps.spawner === undefined ? {} : { spawner: deps.spawner }),
    ...(deps.configFs === undefined ? {} : { configFs: deps.configFs }),
    ...(deps.isolatedDir === undefined ? {} : { isolatedDir: deps.isolatedDir }),
  };
}

/** install:plan — 현재 추천 목록에 있는 toolId만 받는다. */
export async function planForRenderer(session: InstallSession, deps: InstallDeps, toolId: unknown): Promise<InstallPlanResponse> {
  const profile = deps.recommend.profile;
  const dir = session.projectDir;
  if (profile === undefined || dir === undefined) return { status: "no-project" };
  if (typeof toolId !== "string") return { status: "not-recommended" };
  const recommended = await recommendCurrentProject(deps.recommend, { registryDir: deps.registryDir, metadataFile: deps.metadataFile, platform: deps.platform });
  if (recommended.status !== "ok" || !recommended.view.items.some((i) => i.toolId === toolId)) return { status: "not-recommended" };
  const platform = toRecommendPlatform(deps.platform);
  if (platform === undefined) return { status: "error", code: "platform-unsupported", message: tr("install.platformUnsupported") };
  try {
    const { entries } = await loadRegistry(deps.registryDir);
    const manifest = entries.find((e) => e.manifest.name === toolId)?.manifest;
    const clients = INSTALL_CLIENTS.filter((c) => profile.aiClients.some((a) => a.id === c && a.scope === "project") && (manifest?.targets as readonly string[] | undefined)?.includes(c));
    if (clients.length === 0) return { status: "no-client" };
    const request: InstallRequest = { toolId, projectRoot: dir, homeDir: deps.homeDir, targets: clients.map((client: InstallClient) => ({ client, scope: "project" as const })), includeHost: false, platform };
    const { result } = await planInstall(request, environment(deps, entries));
    if (!result.ok) return { status: "error", code: result.code, message: tr("install.manifestRejected") };
    session.remember(toolId, result.planned, request);
    return { status: "ok", view: buildInstallPlanView(result.planned) };
  } catch {
    return { status: "error", code: "plan-failed", message: tr("install.planFailedMain") };
  }
}

/** install:run — 화면에 보여 준 Plan을 네이티브 대화상자로 승인받아 실행한다. renderer가 보낸 digest·승인은 받지 않는다. */
export async function runForRenderer(session: InstallSession, deps: InstallDeps, toolId: unknown): Promise<InstallRunResponse> {
  if (typeof toolId !== "string") return { status: "no-plan" };
  const pending = session.take(toolId);
  if (pending === undefined) return { status: "no-plan" };
  const changed = { status: "project-changed" as const, message: tr("install.projectChanged") };
  if (session.projectDir !== pending.request.projectRoot) return changed;
  try {
    const { entries } = await loadRegistry(deps.registryDir);
    const env = environment(deps, entries);
    if (pending.planned.plan.status === "already-installed") {
      return { status: "done", result: buildInstallResultView(await runInstallTransaction(pending.planned, undefined, pending.request, env), pending.planned.plan) };
    }
    const outcome = await requestApproval(pending.planned, nativeDialogPrompter(deps.dialog));
    if (outcome.status !== "approved") return { status: "rejected" };
    // 대화상자가 열린 동안 다른 프로젝트를 골랐으면 방금 받은 승인도 쓰지 않는다.
    if (session.projectDir !== pending.request.projectRoot) return changed;
    const result = await runInstallTransaction(pending.planned, outcome.approval, pending.request, env);
    const view = buildInstallResultView(result, pending.planned.plan);
    await recordDesktopInstall(pending.planned, result, pending.request, deps, view);
    return { status: "done", result: view };
  } catch {
    return { status: "error", code: "install-failed", message: tr("install.runFailed") };
  }
}

/** 설치가 succeeded이면 Version State에 기록한다(TASK-038). 기록 실패는 결과 화면 경고로만 보여 준다. */
async function recordDesktopInstall(planned: PlannedInstall, result: InstallResultV1, request: InstallRequest, deps: InstallDeps, view: InstallResultView): Promise<void> {
  const recorded = await recordInstallInState(planned, result, {
    projectRoot: request.projectRoot,
    homeDir: request.homeDir,
    ...(deps.configFs === undefined ? {} : { fs: deps.configFs }),
    now: deps.now ?? (() => new Date()),
  });
  if (!recorded.ok) view.warnings.push(tr("install.stateRecordFailed", { code: recorded.code }));
}

/** IPC 핸들러 등록. 첫 번째 인자(toolId)만 쓰고 나머지는 무시한다. */
export function registerInstall(ipc: IpcMainLike, session: InstallSession, deps: InstallDeps): void {
  ipc.handle(INSTALL_PLAN_CHANNEL, (_event: unknown, toolId: unknown) => planForRenderer(session, deps, toolId));
  ipc.handle(INSTALL_RUN_CHANNEL, (_event: unknown, toolId: unknown) => runForRenderer(session, deps, toolId));
}

/**
 * 스모크 전용(AC-036-09, --smoke + OPENHUB_SMOKE_INSTALL일 때만 main이 사용).
 * fake probe·fake executor(실제 프로세스 없음)·자동 확인 대화상자. 호출 기록을 남긴다.
 */
export function smokeInstallDeps(): { probe: () => Promise<BackendProbeReport>; spawner: ExecSpawner; dialog: NativeDialogLike; spawned: string[][]; dialogs: number } {
  const record = { spawned: [] as string[][], dialogs: 0 };
  const probes: BackendProbeReport = {
    node: { name: "node", available: true, version: "22.0.0", status: "ok" },
    npx: { name: "npx", available: true, version: "10.0.0", status: "ok" },
    uvx: { name: "uvx", available: true, version: "0.5.0", status: "ok" },
    docker: { name: "docker", available: true, version: "27.0.0", status: "ok" },
  };
  return Object.assign(record, {
    probe: async () => probes,
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
