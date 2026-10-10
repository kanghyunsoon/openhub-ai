import { createHash } from "node:crypto";
import path from "node:path";
import { BACKEND_ADAPTERS } from "../installer/backends";
import { parseNpmSpec } from "../installer/command";
import { CONFIG_WRITE_ALLOWLIST, codexBlock, nodeConfigFs, readConfiguredEntry, type ConfigFs } from "../installer/config-writer";
import { INSTALL_BACKENDS, canonicalize, serverEntry, type ConfigPatchStep, type InstallBackend, type InstallPlanV1, type PlannedInstall, type ServerEntry } from "../installer/plan";
import type { InstallResultV1 } from "../installer/result";
import { installCandidates } from "../installer/router";
import { artifactKeyFromEntry, buildFingerprintIndex, gradeServer, type FingerprintGrade } from "../identity/fingerprint";
import type { RecommendPlatform } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { entryKeyOf, type ArtifactIdentity, type LastHealth, type ToolState } from "./state";
import { commitLifecycleState, projectKeyFor, readLifecycleState, type StateErrorCode } from "./store";
import { inspectRecordedLauncher, inspectToolConfig, planFormOfEntry, toolConfigLocation, type LauncherCheckFs, type ToolConfigFs } from "../tool-config/index";

/**
 * Install 연계·Lifecycle Status·Drift(TASK-038, D-017).
 * - M4 설치가 succeeded이면 target마다 Version State entry를 남긴다(이미 정확히 고정된 spec은 locked, 아니면 unlocked).
 * - status는 Version State와 config 재읽기만 쓴다. network·spawn·write가 없다.
 * - 확인할 수 없는 것(docker 로컬 이미지 존재, 외부 패키지 변경)을 "drift 없음"으로 단정하지 않는다.
 * - user scope config는 명시적으로 켰을 때만 읽는다(D-003). 표준 항목과 다른 미추적 항목은 자동 편입하지 않는다.
 */

/**
 * tool-config-*(v0.2.0, tool config Tool만): missing은 OpenHub 관리 파일이 없음, drift는 내용이 기록과 다름(또는 확인 불가),
 * relocated는 옮기거나 복사한 프로젝트에 다른 프로젝트 기록과 같은 항목이 있음. 셋 다 openhub lifecycle repair(승인 필요)로 고친다.
 * client-launcher-invalid(v0.2.0, Windows 직접 실행 항목만): Client 설정은 기록과 같지만 그 안의 node.exe·npx-cli.js 경로가
 * 지금은 유효하지 않음(Node.js 재설치·이동 등). 실행하지 않고 파일만 검사한다. openhub lifecycle repair(승인 필요)로 고친다.
 *
 * 한 항목에 문제가 여러 개면 state는 가장 중대한 것 하나다:
 * missing-config > config-drift > tool-config-missing > tool-config-drift > client-launcher-invalid.
 * 실행 경로 문제가 설정·보안 정책 변경을 가리지 않는다. 둘 이상이면 diagnostics에 전부(같은 순서로) 남긴다.
 */
export const LIFECYCLE_ENTRY_STATES = [
  "state-consistent",
  "config-drift",
  "missing-config",
  "tool-config-missing",
  "tool-config-drift",
  "tool-config-relocated",
  "client-launcher-invalid",
  "untracked-adoptable",
  "untracked-foreign",
  "not-inspected",
] as const;
export type LifecycleEntryState = (typeof LIFECYCLE_ENTRY_STATES)[number];
export type ArtifactLockStatus = "artifact-locked" | "artifact-unlocked";
export type ArtifactPresence = "launch-on-demand" | "artifact-unknown";
export type HealthLabel = "healthy" | "not-verified" | "unknown" | "unhealthy" | "timeout" | "launch-failed" | "handshake-failed" | "unsupported";

export interface LifecycleToolStatus {
  toolId: string | null;
  scope: "project" | "user";
  client: string;
  file: string;
  serverName: string;
  state: LifecycleEntryState;
  artifact: { lock: ArtifactLockStatus; presence: ArtifactPresence; requested: string; resolved: string | null } | null;
  revision: number | null;
  health: HealthLabel;
  environmentUnverified: boolean;
  /** 미추적 항목의 Identity Fingerprint 등급(D-026). 추적 항목은 없다. weak는 편입·adoptable이 되지 않는다. */
  identity?: FingerprintGrade;
  /** 감지한 문제가 둘 이상일 때만: 중대한 순서의 전체 목록(첫 항목이 state). v0.2.0 추가 필드. */
  diagnostics?: LifecycleEntryState[];
  /** Windows 직접 실행 경로가 유효하지 않을 때만: 이유(경로 없음). v0.2.0 추가 필드. */
  launcher?: { status: "invalid"; reason: string };
}

/** config 항목의 canonical sha256. */
export function configEntryDigest(value: unknown): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

/** OpenHub가 쓴 Codex block(LF 기준)의 sha256. 교체 단계는 파일의 줄바꿈으로 같은 block을 찾는다. */
export function tomlBlockDigest(serverName: string, value: ServerEntry): string {
  return "sha256:" + createHash("sha256").update(codexBlock(serverName, value, "\n")).digest("hex");
}

/** 이미 정확히 고정된 M4 artifact(spec pinned)는 network 없이 identity로 쓴다. */
export function identityFromPinnedArtifact(backend: InstallBackend, artifact: NonNullable<InstallPlanV1["artifact"]>): ArtifactIdentity | null {
  if (!artifact.pinned) return null;
  if (backend === "npx") {
    const parsed = parseNpmSpec(artifact.spec);
    return parsed === null || parsed.version === null ? null : { kind: "npm-package", spec: artifact.spec, version: parsed.version, digest: null, integrity: null, source: "npm-registry" };
  }
  if (backend === "uvx") {
    const version = artifact.spec.split("==")[1] ?? null;
    return version === null ? null : { kind: "python-package", spec: artifact.spec, version, digest: null, integrity: null, source: "pypi" };
  }
  const digest = /@(sha256:[0-9a-f]{64})$/u.exec(artifact.spec)?.[1] ?? null;
  return digest === null ? null : { kind: "container-image", spec: artifact.spec, version: null, digest, integrity: null, source: "docker-registry" };
}

export interface InstallRecordContext {
  projectRoot: string;
  homeDir: string;
  fs?: ConfigFs;
  now: () => Date;
}

/**
 * succeeded InstallResult → ToolState 목록(target마다 1개). 그 밖의 결과는 빈 목록이다.
 * written: tool config Tool이면 Client 설정에 실제로 쓴 항목(절대 경로 포함). digest는 그 값으로 계산하고 값 자체는 저장하지 않는다.
 */
export function toolStatesFromInstall(planned: PlannedInstall, result: InstallResultV1, projectKey: string, projectName: string, now: Date, written?: ReadonlyMap<string, ServerEntry>): ToolState[] {
  const { plan } = planned;
  if (result.status !== "succeeded" || plan.backend === null || plan.launch === null || plan.artifact === null) return [];
  const applied = new Set(result.configChanges.filter((c) => c.applied && !c.restored).map((c) => c.client + ":" + c.scope));
  const resolved = identityFromPinnedArtifact(plan.backend.adapter, plan.artifact);
  const toolConfigOf = (scope: "project" | "user") => {
    const step = plan.steps.find((x) => x.kind === "tool-config" && x.scope === scope);
    return step?.kind === "tool-config" ? { toolConfig: { fileId: step.fileId, scope: step.scope, digest: step.contentDigest } } : {};
  };
  return plan.steps
    .filter((s): s is ConfigPatchStep => s.kind === "config-patch" && applied.has(s.client + ":" + s.scope))
    .map((s) => {
      const value = written?.get(s.client + ":" + s.scope) ?? s.value;
      return {
      toolId: plan.toolId,
      backend: plan.backend!.adapter,
      revision: 1,
      target: { client: s.client, scope: s.scope, file: s.file, serverName: s.path[1]!, projectName: s.scope === "project" ? projectName : null, projectKey: s.scope === "project" ? projectKey : null },
      artifact: { requested: plan.artifact!.spec, resolved },
      launch: { platform: plan.launch!.platform, clientSpec: { command: plan.launch!.clientSpec.command, args: [...plan.launch!.clientSpec.args] } },
      config: { entryDigest: configEntryDigest(value), tomlBlockDigest: s.client === "codex" ? tomlBlockDigest(s.path[1]!, value) : null },
      ...toolConfigOf(s.scope),
      appliedPlanDigest: planned.planDigest,
      committedAt: now.toISOString(),
      lastHealth: null,
      previous: null,
      };
    });
}

export type InstallRecordResult = { ok: true; recorded: number } | { ok: false; code: StateErrorCode; message: string };

/** M4 설치 성공을 Version State에 기록한다. 같은 EntryKey는 새 설치 기록으로 바꾼다. */
export async function recordInstallInState(planned: PlannedInstall, result: InstallResultV1, ctx: InstallRecordContext): Promise<InstallRecordResult> {
  if (result.status !== "succeeded") return { ok: true, recorded: 0 };
  const fs = ctx.fs ?? nodeConfigFs;
  const projectKey = await projectKeyFor(ctx.projectRoot, fs);
  // tool config Tool: Client 설정에 실제로 쓴 항목을 다시 읽어 Plan 형태로 되돌렸을 때 Plan 값과 같아야 기록한다.
  let written: Map<string, ServerEntry> | undefined;
  if (planned.plan.steps.some((s) => s.kind === "tool-config")) {
    written = new Map();
    const roots = { projectRoot: ctx.projectRoot, homeDir: ctx.homeDir, fs };
    for (const s of planned.plan.steps.filter((x): x is ConfigPatchStep => x.kind === "config-patch")) {
      const entry = (await readConfiguredEntry(s.client, s.scope, s.path[1]!, roots).catch(() => undefined)) as ServerEntry | undefined;
      if (entry === undefined || JSON.stringify(canonicalize(planFormOfEntry(entry))) !== JSON.stringify(canonicalize(s.value))) {
        return { ok: false, code: "STATE_INVALID", message: s.file + "의 항목이 설치 계획과 달라 Version State에 기록하지 않았습니다" };
      }
      written.set(s.client + ":" + s.scope, entry);
    }
  }
  const states = toolStatesFromInstall(planned, result, projectKey, path.basename(path.resolve(ctx.projectRoot)), ctx.now(), written);
  if (states.length === 0) return { ok: true, recorded: 0 };
  const read = await readLifecycleState({ homeDir: ctx.homeDir, fs });
  if (!read.ok) return read;
  const entries = { ...read.state.entries };
  for (const s of states) entries[entryKeyOf(s.target)] = s;
  const committed = await commitLifecycleState({ ...read.state, entries }, read.digest, { homeDir: ctx.homeDir, fs });
  return committed.ok ? { ok: true, recorded: states.length } : committed;
}

const healthLabel = (h: LastHealth | null): HealthLabel => (h === null ? "unknown" : h.status === "skipped" ? "not-verified" : h.status);

/** Manifest 후보(M4 지원 backend)마다 만들 수 있는 표준 항목. */
export function standardEntries(manifest: RegistryEntry["manifest"], client: "claude-code" | "codex" | "cursor", platform: RecommendPlatform): ServerEntry[] {
  const required = manifest.env.filter((e) => e.required).map((e) => e.name).sort();
  const out: ServerEntry[] = [];
  for (const { step } of installCandidates(manifest)) {
    if (!(INSTALL_BACKENDS as readonly string[]).includes(step.adapter)) continue;
    const planned = BACKEND_ADAPTERS[step.adapter as InstallBackend].planLaunch(manifest, step, platform);
    if (planned.ok) out.push(serverEntry(client, { ...planned.value.launch, envNames: required }, required));
  }
  return out;
}

export interface LifecycleStatusOptions {
  projectRoot: string;
  homeDir: string;
  entries: readonly RegistryEntry[];
  platform: RecommendPlatform;
  /** user scope config를 읽을지(D-003, 기본 false). */
  includeUser: boolean;
  fs?: ConfigFs;
  /** OpenHub 관리 tool config 파일 접근(v0.2.0, 테스트 주입용). */
  toolConfigFs?: ToolConfigFs;
  /** Windows Client 직접 실행 경로 검사용 fs(v0.2.0, 테스트 주입용). 읽기(lstat·readFile)만 한다. */
  launcherCheckFs?: LauncherCheckFs;
}

export type LifecycleStatusResult = { ok: true; items: LifecycleToolStatus[] } | { ok: false; code: StateErrorCode; message: string };

const order = (a: LifecycleToolStatus, b: LifecycleToolStatus) =>
  (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) || (a.serverName < b.serverName ? -1 : a.serverName > b.serverName ? 1 : 0) || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0);

/** Version State + config 재읽기로 상태를 판정한다. network·spawn·write 0회. */
export async function lifecycleStatus(options: LifecycleStatusOptions): Promise<LifecycleStatusResult> {
  const fs = options.fs ?? nodeConfigFs;
  const read = await readLifecycleState({ homeDir: options.homeDir, fs });
  if (!read.ok) return read;
  const projectKey = await projectKeyFor(options.projectRoot, fs);
  const roots = { projectRoot: options.projectRoot, homeDir: options.homeDir, fs };
  const items: LifecycleToolStatus[] = [];
  const tracked = new Set<string>();

  for (const state of Object.values(read.state.entries)) {
    const t = state.target;
    if (t.scope === "project" && t.projectKey !== projectKey) continue;
    tracked.add(t.scope + ":" + t.client + ":" + t.serverName);
    const lock: ArtifactLockStatus = state.artifact.resolved === null ? "artifact-unlocked" : "artifact-locked";
    const presence: ArtifactPresence = state.backend === "docker" ? "artifact-unknown" : "launch-on-demand";
    let entryState: LifecycleEntryState = "not-inspected";
    const issues: LifecycleEntryState[] = [];
    let launcherIssue: string | undefined;
    if (t.scope === "project" || options.includeUser) {
      const entry = await readConfiguredEntry(t.client, t.scope, t.serverName, roots).catch(() => undefined);
      if (entry === undefined) issues.push("missing-config");
      else {
        if (configEntryDigest(entry) !== state.config.entryDigest) issues.push("config-drift");
        if (state.toolConfig !== undefined) {
          const loc = toolConfigLocation({ homeDir: options.homeDir, scope: t.scope, toolId: state.toolId, ...(t.scope === "project" ? { projectKey } : {}) });
          const now = loc === null ? null : await inspectToolConfig(loc, options.toolConfigFs).catch(() => null);
          if (now !== null && now.state === "absent") issues.push("tool-config-missing");
          else if (now === null || now.digest !== state.toolConfig.digest) issues.push("tool-config-drift");
        }
        // Windows 직접 실행(node.exe + npx-cli.js) 항목: byte가 같아도 Node.js가 옮겨지면 실행할 수 없다. 실행 없이 파일만 본다.
        if (options.platform === "windows" && state.launch.platform === "windows" && state.launch.clientSpec.command === "node") {
          const checked = await inspectRecordedLauncher(entry as { command: string; args: string[] }, options.launcherCheckFs).catch(() => ({ ok: false as const, reason: "실행 경로를 확인하지 못했습니다" }));
          if (!checked.ok) {
            issues.push("client-launcher-invalid");
            launcherIssue = checked.reason;
          }
        }
      }
      entryState = issues[0] ?? "state-consistent";
    }
    items.push({
      toolId: state.toolId,
      scope: t.scope,
      client: t.client,
      file: t.file,
      serverName: t.serverName,
      state: entryState,
      artifact: { lock, presence, requested: state.artifact.requested, resolved: state.artifact.resolved?.spec ?? null },
      revision: state.revision,
      health: healthLabel(state.lastHealth),
      environmentUnverified: state.lastHealth?.environmentUnverified ?? false,
      ...(issues.length > 1 ? { diagnostics: [...issues] } : {}),
      ...(launcherIssue === undefined ? {} : { launcher: { status: "invalid" as const, reason: launcherIssue } }),
    });
  }

  // 미추적 항목: Registry canonical alias로 찾고, Identity Fingerprint가 exact(alias·artifact 일치)이면서 M4 표준 항목과 같을 때만
  // untracked-adoptable이다(D-026). 그 밖의 서버는 OpenHub가 판단하지 않는다.
  const fingerprints = buildFingerprintIndex(options.entries);
  for (const target of CONFIG_WRITE_ALLOWLIST) {
    if (target.scope === "user" && !options.includeUser) continue;
    for (const reg of options.entries) {
      const alias = reg.manifest.recommendation?.identity?.mcpServerNames?.[0];
      if (alias === undefined || tracked.has(target.scope + ":" + target.client + ":" + alias)) continue;
      const entry = await readConfiguredEntry(target.client, target.scope, alias, roots).catch(() => undefined);
      if (entry === undefined) continue;
      const digest = configEntryDigest(entry);
      // 옮기거나 복사한 프로젝트: 다른 프로젝트 기록과 byte 단위로 같은 tool config 항목(repair로 이 프로젝트 기록을 만든다).
      const relocated =
        reg.manifest.toolConfig !== undefined &&
        target.scope === "project" &&
        Object.values(read.state.entries).some((s) => s.toolId === reg.manifest.name && s.target.scope === "project" && s.target.projectKey !== projectKey && s.target.client === target.client && s.config.entryDigest === digest);
      if (relocated) {
        items.push({ toolId: reg.manifest.name, scope: "project", client: target.client, file: target.logical, serverName: alias, state: "tool-config-relocated", artifact: null, revision: null, health: "unknown", environmentUnverified: false });
        continue;
      }
      const identity = gradeServer({ client: target.client, scope: target.scope, file: target.logical, serverName: alias, artifact: artifactKeyFromEntry(entry) }, fingerprints).grade;
      const adoptable = identity === "exact" && standardEntries(reg.manifest, target.client, options.platform).some((s) => configEntryDigest(s) === digest);
      items.push({
        toolId: adoptable ? reg.manifest.name : null,
        scope: target.scope,
        client: target.client,
        file: target.logical,
        serverName: alias,
        state: adoptable ? "untracked-adoptable" : "untracked-foreign",
        artifact: null,
        revision: null,
        health: "unknown",
        environmentUnverified: false,
        identity,
      });
    }
  }
  return { ok: true, items: items.sort(order) };
}
