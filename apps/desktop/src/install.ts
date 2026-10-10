import { EventEmitter } from "node:events";
import {
  INSTALL_CLIENTS,
  analyzeProject,
  clientVerificationLevel,
  configTargetFor,
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
import { smokeNpmSpawner } from "./lifecycle";

/**
 * Desktop 설치 흐름(TASK-036, D-005·D-012). FOR YOU 카드 → Plan Preview → 추가 승인 체크 → 네이티브 확인 → 실행 → 결과.
 * - IPC 인자는 현재 추천 목록에 있는 toolId 하나뿐이다. 경로·Plan·digest를 보내도 무시한다.
 * - 최종 Approval은 main 프로세스의 네이티브 확인 대화상자에서만 만들어진다(channel "desktop-native-dialog").
 *   renderer 체크박스는 확인 버튼을 켜는 화면 단계일 뿐 Approval을 만들지 않는다.
 * - Desktop은 Host Probe를 실행하지 않으므로(D-003·TASK-015) project scope만 계획한다. user scope 설치는 CLI --scope user다.
 * - Preview 문장은 CLI와 같은 Core formatInstallPlanPreview를 쓴다.
 * - Client 선택(v0.2.0 P0-3 PR C): install:options가 Client별 지원·탐지·검증 수준을 보여 주고, install:plan은 사용자가 고른 Client만
 *   계획한다. 고른 목록은 INSTALL_CLIENTS와 Manifest targets로 엄격히 검증한다(그 밖의 값이 하나라도 있으면 계획하지 않는다).
 */

export const INSTALL_PLAN_CHANNEL = "install:plan";
export const INSTALL_RUN_CHANNEL = "install:run";
export const INSTALL_OPTIONS_CHANNEL = "install:options";
/** Client 선택을 바꾸는 즉시 renderer가 알린다. 그 toolId의 Pending Plan을 버린다(승인 가능 상태 해제). */
export const INSTALL_DISCARD_CHANNEL = "install:discard";

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
  | { status: "no-project" | "not-recommended" | "no-client" | "superseded" }
  | { status: "error"; code: string; message: string };

export type ClientVerificationView = "launch-verified" | "spec-launch-verified" | "config-recognized" | "not-verified" | "platform-unverified" | "not-recorded";

/** 설치 Client 선택 화면 데이터(v0.2.0 P0-3 PR C). 문자열은 renderer가 textContent로만 넣는다. */
export interface InstallOptionsView {
  toolId: string;
  displayName: string;
  platform: "windows" | "macos" | "linux";
  /** Manifest platform에 지금 OS가 있는가. */
  platformSupported: boolean;
  /** Manifest가 지원한다고 적은 OS. */
  platforms: ("windows" | "macos" | "linux")[];
  /** 설치 범위. 기본은 project이고 user는 사용자가 고를 때만(v0.2.0 P0-3 C2). */
  defaultScope: "project";
  clients: {
    client: InstallClient;
    label: string;
    /** Manifest targets에 있는가(없으면 고를 수 없다). */
    supported: boolean;
    /** 이 프로젝트에서 탐지된 Client인가. */
    detected: boolean;
    /** 기본 선택(지원 + 탐지). */
    selected: boolean;
    /** 이 OS에서 OpenHub의 실제 실행 검증 수준. 기록이 없으면 not-recorded. */
    verification: ClientVerificationView;
    note: string;
    /** 범위별로 OpenHub가 쓰는 설정 파일(논리 경로). user가 null이면 OpenHub가 그 사용자 설정을 쓰지 않는다(예: Claude Code ~/.claude.json). */
    files: { project: string; user: string | null };
    /** user 범위를 고를 수 없을 때의 이유(고를 수 있으면 null). */
    userNote: string | null;
  }[];
}

export type InstallOptionsResponse = { status: "ok"; view: InstallOptionsView } | { status: "no-project" | "not-recommended" } | { status: "error"; code: string; message: string };

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
  | { status: "project-changed" | "plan-changed"; message: string }
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
      // 바뀔 설정 파일(범위·Client)을 승인 화면에 그대로 나열한다. user 범위가 있으면 더 넓은 영향을 따로 경고한다.
      const written = plan.targets.filter((t) => t.envReference !== "manual");
      const targetLines = written.map((t) => tr("install.dialog.target", { client: CLIENT_LABEL[t.client], scope: tr(t.scope === "user" ? "install.target.userScope" : "install.target.projectScope"), file: t.file }));
      const userWarning = written.some((t) => t.scope === "user") ? [tr("install.dialog.userScopeWarning")] : [];
      const detail = [...targetLines, ...userWarning, "", ...request.requirements.map((r) => tr("dialog.requirement", { id: r.id, message: installApprovalText(r.id) })), "", tr("dialog.digest", { digest: planDigest })].join("\n");
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

/** 계획 요청 하나의 표(세대 번호 + 프로젝트 epoch). 이 표가 지금도 최신일 때만 Plan을 기억·실행한다. */
export interface PlanTicket {
  readonly generation: number;
  readonly epoch: number;
}

/**
 * 마지막으로 고른 프로젝트 폴더와 화면에 보여 준 Plan을 기억한다(v0.2.0 P0-3 PR C 보완: 계획 일관성).
 * - toolId마다 세대 번호를 둔다. 새 계획 요청·선택 화면 열기·선택 변경(install:discard)은 이전 Pending Plan을 지우고 세대를 올린다.
 *   잘못된 선택·계획 실패·선택 해제도 먼저 세대를 올리므로 이전 Plan이 남지 않는다(자동 복귀 없음).
 * - 프로젝트를 다시 고르면 epoch를 올리고 모든 Pending Plan을 지운다.
 * - 비동기 계획이 끝났을 때 세대·epoch·프로젝트가 그대로일 때만 기억한다(늦게 온 이전 요청은 기억하지 않는다).
 */
export class InstallSession {
  #dir: string | undefined;
  #epoch = 0;
  readonly #pending = new Map<string, { planned: PlannedInstall; request: InstallRequest; ticket: PlanTicket }>();
  readonly #generation = new Map<string, number>();

  /** [프로젝트 선택] picker를 감싸 고른 폴더를 기억한다(결과는 바꾸지 않는다). */
  trackPicker(pick: DirectoryPicker): DirectoryPicker {
    return async () => {
      const dir = await pick();
      this.#dir = dir;
      this.#epoch += 1;
      this.#pending.clear();
      return dir;
    };
  }

  get projectDir(): string | undefined {
    return this.#dir;
  }
  /** 새 계획 요청(또는 선택 변경): 이전 Pending Plan을 버리고 새 표를 준다. */
  begin(toolId: string): PlanTicket {
    const generation = (this.#generation.get(toolId) ?? 0) + 1;
    this.#generation.set(toolId, generation);
    this.#pending.delete(toolId);
    return { generation, epoch: this.#epoch };
  }
  /** 이 표가 아직 이 toolId의 최신 요청이고 프로젝트가 바뀌지 않았는가. */
  isCurrent(toolId: string, ticket: PlanTicket): boolean {
    return this.#generation.get(toolId) === ticket.generation && this.#epoch === ticket.epoch;
  }
  /** 최신 표이고 같은 프로젝트일 때만 기억한다. 아니면 false(이전 요청의 늦은 응답). */
  remember(toolId: string, ticket: PlanTicket, planned: PlannedInstall, request: InstallRequest): boolean {
    if (!this.isCurrent(toolId, ticket) || request.projectRoot !== this.#dir) return false;
    this.#pending.set(toolId, { planned, request, ticket });
    return true;
  }
  take(toolId: string): { planned: PlannedInstall; request: InstallRequest; ticket: PlanTicket } | undefined {
    const found = this.#pending.get(toolId);
    this.#pending.delete(toolId);
    return found !== undefined && this.isCurrent(toolId, found.ticket) ? found : undefined;
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

const CLIENT_LABEL: Readonly<Record<InstallClient, string>> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };
const PLATFORM_KEYS = ["windows", "macos", "linux"] as const;

/** 추천 목록에 있는 toolId인지 확인하고 Manifest·탐지된 Client를 돌려준다(install:options·install:plan 공통). */
async function recommendedTool(session: InstallSession, deps: InstallDeps, toolId: unknown) {
  const profile = deps.recommend.profile;
  const dir = session.projectDir;
  if (profile === undefined || dir === undefined) return { status: "no-project" as const };
  if (typeof toolId !== "string") return { status: "not-recommended" as const };
  const recommended = await recommendCurrentProject(deps.recommend, { registryDir: deps.registryDir, metadataFile: deps.metadataFile, platform: deps.platform });
  if (recommended.status !== "ok" || !recommended.view.items.some((i) => i.toolId === toolId)) return { status: "not-recommended" as const };
  const { entries } = await loadRegistry(deps.registryDir);
  const manifest = entries.find((e) => e.manifest.name === toolId)?.manifest;
  if (manifest === undefined) return { status: "not-recommended" as const };
  const supported = (c: InstallClient) => (manifest.targets as readonly string[]).includes(c);
  const detected = (c: InstallClient) => profile.aiClients.some((a) => a.id === c && a.scope === "project");
  return { status: "ok" as const, toolId, dir, entries, manifest, supported, detected };
}

/**
 * renderer가 보낸 Client·범위 선택을 검증한다. clients 속성이 있는 객체만 선택으로 본다. 그 밖의 값(경로 문자열, Plan 객체 등)은
 * AC-036-01처럼 무시하고 기존 기본값(지원 + 탐지, project)을 쓴다. clients가 있으면 배열이어야 하고 각 값은 INSTALL_CLIENTS이면서
 * Manifest가 지원해야 한다. scope가 있으면 "project" 또는 "user"뿐이고(없으면 project), user면 고른 Client마다 OpenHub가 쓰는
 * 사용자 설정 파일이 있어야 한다(D-013 허용 목록: Cursor·Codex). 하나라도 아니면 invalid(아무것도 계획하지 않는다). 경로는 받지 않는다.
 */
export function parseClientSelection(
  selection: unknown,
  supported: (c: InstallClient) => boolean,
  detected: (c: InstallClient) => boolean,
): { ok: true; clients: InstallClient[]; scope: "project" | "user" } | { ok: false } {
  const isSelection = selection !== null && typeof selection === "object" && !Array.isArray(selection) && Object.prototype.hasOwnProperty.call(selection, "clients");
  if (!isSelection) return { ok: true, clients: INSTALL_CLIENTS.filter((c) => supported(c) && detected(c)), scope: "project" };
  const raw = (selection as { clients?: unknown }).clients;
  if (!Array.isArray(raw) || raw.length > INSTALL_CLIENTS.length * 2) return { ok: false };
  const scopeValue = Object.prototype.hasOwnProperty.call(selection, "scope") ? (selection as { scope?: unknown }).scope : "project";
  if (scopeValue !== "project" && scopeValue !== "user") return { ok: false };
  const out: InstallClient[] = [];
  for (const value of raw) {
    if (typeof value !== "string" || !(INSTALL_CLIENTS as readonly string[]).includes(value) || !supported(value as InstallClient)) return { ok: false };
    if (scopeValue === "user" && !configTargetFor(value as InstallClient, "user").writable) return { ok: false };
    if (!out.includes(value as InstallClient)) out.push(value as InstallClient);
  }
  return { ok: true, clients: INSTALL_CLIENTS.filter((c) => out.includes(c)), scope: scopeValue };
}

/** install:options — 현재 추천 목록에 있는 toolId의 Client 선택 화면 데이터. 계획·쓰기·실행 0. */
export async function optionsForRenderer(session: InstallSession, deps: InstallDeps, toolId: unknown): Promise<InstallOptionsResponse> {
  try {
    // 선택 화면을 다시 열면 그 toolId의 이전 Pending Plan은 쓸 수 없다.
    if (typeof toolId === "string") session.begin(toolId);
    const found = await recommendedTool(session, deps, toolId);
    if (found.status !== "ok") return { status: found.status };
    const platform = toRecommendPlatform(deps.platform);
    if (platform === undefined) return { status: "error", code: "platform-unsupported", message: tr("install.platformUnsupported") };
    const platforms = PLATFORM_KEYS.filter((p) => found.manifest.platform[p] === true);
    const clients = INSTALL_CLIENTS.map((client) => {
      const supported = found.supported(client);
      const detected = found.detected(client);
      const verification: ClientVerificationView = clientVerificationLevel(found.toolId, client, platform) ?? "not-recorded";
      const user = configTargetFor(client, "user");
      return {
        client,
        label: CLIENT_LABEL[client],
        supported,
        detected,
        selected: supported && detected,
        verification,
        note: clientNote(supported, detected, verification, platform),
        files: { project: configTargetFor(client, "project").logical, user: user.writable ? user.logical : null },
        userNote: user.writable ? null : tr("install.client.userNotWritten", { file: user.logical }),
      };
    });
    return { status: "ok", view: { toolId: found.toolId, displayName: found.manifest.displayName ?? found.toolId, platform, platformSupported: platforms.includes(platform), platforms, defaultScope: "project", clients } };
  } catch {
    return { status: "error", code: "options-failed", message: tr("install.planFailedMain") };
  }
}

const OS_LABEL = { windows: "Windows", macos: "macOS", linux: "Linux" } as const;
const VERIFY_KEY = {
  "launch-verified": "install.verify.launchVerified",
  "spec-launch-verified": "install.verify.specLaunchVerified",
  "config-recognized": "install.verify.configRecognized",
  "not-verified": "install.verify.notVerified",
  "platform-unverified": "install.verify.platformUnverified",
  "not-recorded": "install.verify.notRecorded",
} as const;

function clientNote(supported: boolean, detected: boolean, verification: ClientVerificationView, platform: "windows" | "macos" | "linux"): string {
  if (!supported) return tr("install.client.unsupported");
  return [tr(detected ? "install.client.detected" : "install.client.notDetected"), tr(VERIFY_KEY[verification], { os: OS_LABEL[platform] })].join(" · ");
}

/** install:plan — 현재 추천 목록에 있는 toolId와 사용자가 고른 Client만 받는다. */
export async function planForRenderer(session: InstallSession, deps: InstallDeps, toolId: unknown, selection?: unknown): Promise<InstallPlanResponse> {
  if (typeof toolId !== "string") return { status: "not-recommended" };
  // 어떤 결과든(잘못된 선택·실패·선택 없음 포함) 이전 Pending Plan은 먼저 버린다.
  const ticket = session.begin(toolId);
  const profile = deps.recommend.profile;
  const dir = session.projectDir;
  if (profile === undefined || dir === undefined) return { status: "no-project" };
  const platform = toRecommendPlatform(deps.platform);
  if (platform === undefined) return { status: "error", code: "platform-unsupported", message: tr("install.platformUnsupported") };
  try {
    const found = await recommendedTool(session, deps, toolId);
    if (found.status !== "ok") return { status: found.status };
    const chosen = parseClientSelection(selection, found.supported, found.detected);
    if (!chosen.ok) return { status: "error", code: "invalid-selection", message: tr("install.invalidSelection") };
    if (chosen.clients.length === 0) return { status: "no-client" };
    const request: InstallRequest = { toolId, projectRoot: dir, homeDir: deps.homeDir, targets: chosen.clients.map((client: InstallClient) => ({ client, scope: chosen.scope })), includeHost: false, platform };
    const { result } = await planInstall(request, environment(deps, found.entries));
    // 계획하는 동안 더 새 요청이 왔거나 프로젝트가 바뀌었으면 이 결과는 버린다(화면에도 보이지 않는다).
    if (!session.isCurrent(toolId, ticket) || session.projectDir !== dir) return { status: "superseded" };
    if (!result.ok) return { status: "error", code: result.code, message: tr("install.manifestRejected") };
    if (!session.remember(toolId, ticket, result.planned, request)) return { status: "superseded" };
    return { status: "ok", view: buildInstallPlanView(result.planned) };
  } catch {
    return { status: "error", code: "plan-failed", message: tr("install.planFailedMain") };
  }
}

/** install:discard — Client 선택을 바꿨다. 그 toolId의 Pending Plan을 버린다(쓰기·실행 0). */
export function discardForRenderer(session: InstallSession, toolId: unknown): { status: "ok" } | { status: "invalid" } {
  if (typeof toolId !== "string") return { status: "invalid" };
  session.begin(toolId);
  return { status: "ok" };
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
    // 대화상자가 열린 동안 Client 선택을 바꾸거나 새 계획을 요청했으면 이 승인은 이전 Plan의 것이다. 실행하지 않는다.
    if (!session.isCurrent(toolId, pending.ticket)) return { status: "plan-changed", message: tr("install.planChanged") };
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

/** IPC 핸들러 등록. install:plan은 toolId와 Client 선택만, 나머지는 toolId만 쓴다(그 밖의 인자는 무시한다). */
export function registerInstall(ipc: IpcMainLike, session: InstallSession, deps: InstallDeps): void {
  ipc.handle(INSTALL_OPTIONS_CHANNEL, (_event: unknown, toolId: unknown) => optionsForRenderer(session, deps, toolId));
  ipc.handle(INSTALL_PLAN_CHANNEL, (_event: unknown, toolId: unknown, selection: unknown) => planForRenderer(session, deps, toolId, selection));
  ipc.handle(INSTALL_DISCARD_CHANNEL, (_event: unknown, toolId: unknown) => discardForRenderer(session, toolId));
  ipc.handle(INSTALL_RUN_CHANNEL, (_event: unknown, toolId: unknown) => runForRenderer(session, deps, toolId));
}

/**
 * 스모크 전용(AC-036-09, --smoke + OPENHUB_SMOKE_INSTALL일 때만 main이 사용).
 * fake probe·가짜 npm(실제 프로세스 없음, npx Prepare 캐시 계약을 지킨다: smokeNpmSpawner)·자동 확인 대화상자. 호출 기록을 남긴다.
 * cacheRoot: 가짜 npm 캐시 위치(스모크 임시 폴더). 정확한 버전 npx 설치의 Prepare가 이 아래에 캐시 항목을 만든다.
 */
export function smokeInstallDeps(cacheRoot?: string): { probe: () => Promise<BackendProbeReport>; spawner: ExecSpawner; dialog: NativeDialogLike; spawned: string[][]; dialogs: number } {
  const record = { spawned: [] as string[][], dialogs: 0 };
  const probes: BackendProbeReport = {
    node: { name: "node", available: true, version: "22.0.0", status: "ok" },
    npx: { name: "npx", available: true, version: "10.0.0", status: "ok" },
    uvx: { name: "uvx", available: true, version: "0.5.0", status: "ok" },
    docker: { name: "docker", available: true, version: "27.0.0", status: "ok" },
  };
  return Object.assign(record, {
    probe: async () => probes,
    spawner:
      cacheRoot === undefined
        ? (((executable: string, args: readonly string[]) => {
            record.spawned.push([executable, ...args]);
            const events = new EventEmitter();
            queueMicrotask(() => events.emit("close", 0, null));
            return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
          }) as ExecSpawner)
        : smokeNpmSpawner(cacheRoot, record.spawned),
    dialog: {
      showMessageBox: async () => {
        record.dialogs += 1;
        return { response: 1 };
      },
    } satisfies NativeDialogLike,
  });
}
