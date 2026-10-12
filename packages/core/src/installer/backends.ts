import type { InstallStep, Manifest } from "../manifest/index";
import type { RecommendPlatform } from "../recommendation/index";
import type { HealthResult, InstallContext, InstallPlan, InstallResult, InstallTarget, InstallerAdapter, Operation, UpdateResult, ValidationResult } from "./adapter";
import { isPinnedArtifact, isPinnedPythonSpec, isValidDockerImage, npxArtifact, tokenizeManifestCommand, uvxArtifact } from "./command";
import type { InstallBackend, InstallPlanV1, RunStep } from "./plan";
import { NPX_PREPARE_STEP_ID, NPX_PREPARE_TIMEOUT_MS, npxPrepareArgs } from "../process/npx-prepare";
import { UVX_PREPARE_STEP_ID, UVX_PREPARE_TIMEOUT_MS, normalizePyName, uvxPrepareArgs, uvxPrepareTarget, type UvxBuildPolicy, type UvxSourceBuildEntry } from "../process/uvx-prepare";
import { NPX_CLI_PLACEHOLDER, TOOL_CONFIG_PLACEHOLDER, toolConfigIssues } from "../tool-config/index";

/**
 * npx·uvx·docker Adapter(TASK-031, D-012·D-015). Adapter는 Plan 단계만 만들고 프로세스를 실행하지 않는다.
 * - npx·uvx: launch-on-demand. 준비 단계 0개, Client launch spec만 기록한다(persistent install 없음).
 *   단, 정확한 버전으로 고정된 npx 패키지는 npx Prepare 단계 1개(npm-cache)를 둔다(v0.2.0, docs/specs/npx-prepare.md).
 *   정확한 버전(--from·--with 모두)으로 고정된 uvx 도구는 uvx Prepare 단계 1개(uv-cache)를 둔다(v0.2.1, docs/specs/uvx-prepare.md).
 * - docker: 준비 단계 docker pull <image> 1개, launch는 docker run -i --rm [-e NAME…] <image>(-e에는 이름만).
 * - 실제 실행은 VerifiedPlan을 받는 공통 Executor(src/process/executor.ts)만 한다.
 * - M1 InstallerAdapter 계약을 따르되 M1 승인·run-command 경로(plan·install)와 update·uninstall·healthCheck는 M4에서 실행하지 않는다.
 */

export const DOCKER_PULL_TIMEOUT_MS = 600_000;

/**
 * D-016 Windows npx Client launch spec. 두 경계를 구분한다.
 * - A. OpenHub internal execution(Probe·Executor): shell:false, cmd/cmd.exe 실행 금지(D-011·D-012 유지). 이 값은 거기에 쓰이지 않는다.
 * - B. Agent Client launch configuration: native Windows + npx + stdio + D-013 allowlist config일 때만
 *   Client가 나중에 서버를 실행할 command를 "cmd", args를 ["/d", "/c", "npx", ...검증된 인자]로 기록한다.
 *   prefix는 OpenHub가 고정한다. 절대 경로 cmd.exe·npx.cmd는 기록하지 않는다.
 */
export const WINDOWS_NPX_CLIENT_PREFIX = Object.freeze(["/d", "/c", "npx"] as const);

/**
 * v0.2.0 tool config Tool(인자에 {toolConfig}): Windows에서는 cmd 래퍼 대신 Client가 node.exe + npm npx-cli.js를 직접 실행한다
 * (공백·괄호·&·한글이 있는 home 경로를 재해석 없이 넘기기 위해). Plan·State에는 command "node", 첫 인자 {npxCli}만 남기고
 * 실제 절대 경로는 Client 설정을 쓰는 순간 검증한 값으로 바꾼다(tool-config/index.ts materializeClientArgs).
 * 그 밖의 npx Tool의 Windows 계약(D-016 cmd 래퍼)은 그대로다.
 */
export function clientLaunchSpec(platform: RecommendPlatform, backend: InstallBackend, args: readonly string[]): { command: "npx" | "uvx" | "docker" | "cmd" | "node"; args: string[] } {
  if (platform === "windows" && backend === "npx" && args.includes(TOOL_CONFIG_PLACEHOLDER)) return { command: "node", args: [NPX_CLI_PLACEHOLDER, ...args] };
  if (platform === "windows" && backend === "npx") return { command: "cmd", args: [...WINDOWS_NPX_CLIENT_PREFIX, ...args] };
  return { command: backend, args: [...args] };
}

export class InstallerOperationError extends Error {
  constructor(
    readonly code: "UNSUPPORTED_IN_M4" | "INSTALL_PLAN_V1_REQUIRED",
    message: string,
  ) {
    super(message);
    this.name = "InstallerOperationError";
  }
}

export interface BackendLaunch {
  backend: InstallBackend;
  artifact: NonNullable<InstallPlanV1["artifact"]>;
  launch: NonNullable<InstallPlanV1["launch"]>;
  preparation: RunStep[];
}
export type BackendPlanResult = { ok: true; value: BackendLaunch } | { ok: false; kind: "rejected" | "missing"; reason: string };

function stringOption(step: InstallStep, key: "command" | "image" | "package" | "version"): string | undefined {
  const direct = step[key];
  if (typeof direct === "string") return direct;
  const nested = step.options?.[key];
  return typeof nested === "string" ? nested : undefined;
}

const requiredEnvNames = (manifest: Manifest) => manifest.env.filter((e) => e.required).map((e) => e.name).sort();

function planDocker(manifest: Manifest, step: InstallStep, platform: RecommendPlatform): BackendPlanResult {
  const image = stringOption(step, "image");
  if (image === undefined) return { ok: false, kind: "missing", reason: "docker image가 없습니다" };
  if (!isValidDockerImage(image)) return { ok: false, kind: "rejected", reason: "docker image 형식이 올바르지 않습니다" };
  const names = requiredEnvNames(manifest);
  const args = ["run", "-i", "--rm", ...names.flatMap((n) => ["-e", n]), image];
  return {
    ok: true,
    value: {
      backend: "docker",
      artifact: { kind: "container-image", spec: image, pinned: isPinnedArtifact("docker", { spec: image, unambiguous: true }), preparation: "pull" },
      launch: { platform, executable: "docker", args, envNames: names, clientSpec: clientLaunchSpec(platform, "docker", args) },
      preparation: [{ id: "docker-pull", kind: "run", executable: "docker", args: ["pull", image], cwd: "isolated", network: true, timeoutMs: DOCKER_PULL_TIMEOUT_MS }],
    },
  };
}

function planLaunchOnDemand(manifest: Manifest, step: InstallStep, backend: "npx" | "uvx", platform: RecommendPlatform): BackendPlanResult {
  const rawCommand = stringOption(step, "command");
  // tool config placeholder는 검토된 정책을 통과한 허용 목록 Tool에서만, 정확히 한 token으로만 받는다.
  const usesToolConfig = rawCommand !== undefined && rawCommand.includes(TOOL_CONFIG_PLACEHOLDER);
  if (usesToolConfig) {
    const issues = toolConfigIssues(manifest);
    if (backend !== "npx" || issues.length > 0) return { ok: false, kind: "rejected", reason: issues[0]?.message ?? "tool config는 npx backend에서만 씁니다" };
  }
  const tokenizeOptions = { windowsCmdWrapper: platform === "windows" && backend === "npx" && !usesToolConfig };
  const command = usesToolConfig ? rawCommand.split(/\s+/u).map((t) => (t === TOOL_CONFIG_PLACEHOLDER ? TOOL_CONFIG_SENTINEL : t)).join(" ") : rawCommand;
  let args: string[];
  if (command !== undefined) {
    const tokens = tokenizeManifestCommand(command, backend, tokenizeOptions);
    if (!tokens.ok) return { ok: false, kind: "rejected", reason: tokens.reason };
    args = tokens.tokens.slice(1).map((t) => (t === TOOL_CONFIG_SENTINEL ? TOOL_CONFIG_PLACEHOLDER : t));
  } else {
    const pkg = stringOption(step, "package");
    if (pkg === undefined) return { ok: false, kind: "missing", reason: "실행 명령이나 패키지가 없습니다" };
    const version = stringOption(step, "version");
    const spec = version === undefined ? pkg : backend === "npx" ? pkg + "@" + version : pkg + "==" + version;
    const tokens = tokenizeManifestCommand(backend + " " + spec, backend, tokenizeOptions);
    if (!tokens.ok) return { ok: false, kind: "rejected", reason: tokens.reason };
    args = backend === "npx" ? ["-y", spec] : [spec];
  }
  const ref = backend === "npx" ? npxArtifact(args) : uvxArtifact(args);
  if (ref === null) return { ok: false, kind: "missing", reason: "패키지 token을 찾지 못했습니다" };
  // uvx: --with 의존성도 정확한 버전이어야 환경이 고정된다(v0.2.1). 하나라도 떠 있으면 floating이다.
  const pinned = isPinnedArtifact(backend, ref) && (backend !== "uvx" || uvxWithPinsExact(args));
  const policy = uvxBuildPolicyOf(step, backend);
  if (!policy.ok) return { ok: false, kind: "rejected", reason: policy.reason };
  const prepare = backend === "npx" ? npxPrepareStepFor(backend, ref.spec, pinned) : uvxPrepareStepFor(args, policy.policy, policy.sourceBuild);
  if (policy.policy === "source-build-reviewed" && prepare === null) return { ok: false, kind: "rejected", reason: "source-build-reviewed는 정확한 버전(--from pkg==X.Y.Z, --with dep==A.B.C)으로 고정된 uvx 명령에서만 씁니다" };
  return {
    ok: true,
    value: {
      backend,
      artifact: { kind: backend === "npx" ? "npm-package" : "python-package", spec: ref.spec, pinned, preparation: prepare === null ? "launch-on-demand" : backend === "npx" ? "npm-cache" : "uv-cache" },
      launch: { platform, executable: backend, args, envNames: requiredEnvNames(manifest), clientSpec: clientLaunchSpec(platform, backend, args) },
      preparation: prepare === null ? [] : [prepare],
    },
  };
}

export type UvxBuildPolicyResult = { ok: true; policy: UvxBuildPolicy; sourceBuild: UvxSourceBuildEntry[] } | { ok: false; reason: string };

const PY_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/u;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
const SHA256_HEX = /^[0-9a-f]{64}$/u;

/**
 * install.options.prepare(v0.2.1, D3). 기본 wheels-only. source-build-reviewed는 소스 빌드할 패키지 목록(이름·정확한 버전·출처)이
 * 반드시 있어야 하고, wheels-only에는 목록이 없어야 한다. 알 수 없는 key·uvx가 아닌 backend의 prepare는 거부한다.
 * 각 항목은 PyPI sdist 파일의 sha256을 가져야 하고 같은 패키지는 한 번만 쓴다. v0.2.1: 형식 검사만 하고 이 정책의 Plan은 차단한다
 * (UVX_SOURCE_BUILD_DISABLED). 형식을 남기는 이유는 이후 정책 결정 때 schema를 바꾸지 않기 위해서다.
 */
export function uvxBuildPolicyOf(step: InstallStep, backend: InstallBackend): UvxBuildPolicyResult {
  const raw = step.options?.["prepare"];
  if (raw === undefined) return { ok: true, policy: "wheels-only", sourceBuild: [] };
  if (backend !== "uvx") return { ok: false, reason: "install.options.prepare는 uvx backend에서만 씁니다" };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, reason: "install.options.prepare 형식이 올바르지 않습니다" };
  const doc = raw as Record<string, unknown>;
  const unknown = Object.keys(doc).find((k) => k !== "build" && k !== "sourceBuild");
  if (unknown !== undefined) return { ok: false, reason: "install.options.prepare에 알 수 없는 key(" + unknown + ")가 있습니다" };
  const build = doc["build"] ?? "wheels-only";
  if (build !== "wheels-only" && build !== "source-build-reviewed") return { ok: false, reason: "install.options.prepare.build는 wheels-only 또는 source-build-reviewed입니다" };
  const list = doc["sourceBuild"];
  if (build === "wheels-only") return list === undefined ? { ok: true, policy: "wheels-only", sourceBuild: [] } : { ok: false, reason: "wheels-only에는 sourceBuild 목록을 쓰지 않습니다" };
  if (!Array.isArray(list) || list.length === 0) return { ok: false, reason: "source-build-reviewed에는 소스 빌드할 패키지 목록(sourceBuild)이 필요합니다" };
  const entries: UvxSourceBuildEntry[] = [];
  for (const item of list) {
    const e = item as Record<string, unknown>;
    if (typeof item !== "object" || item === null || Object.keys(e).some((k) => !["package", "version", "source", "sha256"].includes(k))) return { ok: false, reason: "sourceBuild 항목 형식이 올바르지 않습니다" };
    if (typeof e["package"] !== "string" || !PY_NAME.test(e["package"])) return { ok: false, reason: "sourceBuild 패키지 이름이 올바르지 않습니다" };
    if (typeof e["version"] !== "string" || !EXACT_VERSION.test(e["version"])) return { ok: false, reason: "sourceBuild 버전은 정확한 버전(X.Y.Z)이어야 합니다" };
    if (e["source"] !== "pypi-sdist") return { ok: false, reason: "sourceBuild 출처는 pypi-sdist만 지원합니다" };
    if (typeof e["sha256"] !== "string" || !SHA256_HEX.test(e["sha256"])) return { ok: false, reason: "sourceBuild 항목에는 PyPI sdist 파일의 sha256(64자리 소문자 hex)이 필요합니다" };
    if (entries.some((x) => normalizePyName(x.package) === normalizePyName(e["package"] as string))) return { ok: false, reason: "sourceBuild에 같은 패키지가 두 번 있습니다" };
    entries.push({ package: normalizePyName(e["package"]), version: e["version"], sha256: e["sha256"] });
  }
  return { ok: true, policy: "source-build-reviewed", sourceBuild: entries.sort((a, b) => (a.package < b.package ? -1 : a.package > b.package ? 1 : 0)) };
}

/** 정확한 버전 환경의 uvx Prepare 단계(v0.2.1). 준비할 수 없는 형식이면 null(launch-on-demand 유지). */
function uvxWithPinsExact(args: readonly string[]): boolean {
  return args.every((a, i) => i === 0 || args[i - 1] !== "--with" || isPinnedPythonSpec(a));
}

export function uvxPrepareStepFor(launchArgs: readonly string[], policy: UvxBuildPolicy, sourceBuild: readonly UvxSourceBuildEntry[] = []): RunStep | null {
  const target = uvxPrepareTarget(launchArgs);
  if (target === null) return null;
  const step: RunStep = { id: UVX_PREPARE_STEP_ID, kind: "run", executable: "uvx", args: uvxPrepareArgs(target, policy), cwd: "isolated", network: true, timeoutMs: UVX_PREPARE_TIMEOUT_MS };
  // 검토 목록은 Plan digest에 들어간다(승인 뒤 목록·sha256이 바뀌면 PLAN_STALE).
  return policy === "source-build-reviewed" ? { ...step, sourceBuild: sourceBuild.map((e) => ({ ...e })) } : step;
}

/** 정확한 버전으로 고정된 npx 패키지의 Prepare 단계. 고정되지 않았거나 npx가 아니면 null(launch-on-demand 유지). */
const TOOL_CONFIG_SENTINEL = "openhub-tool-config-placeholder";

export function npxPrepareStepFor(backend: InstallBackend, spec: string, pinned: boolean): RunStep | null {
  if (backend !== "npx" || !pinned) return null;
  return { id: NPX_PREPARE_STEP_ID, kind: "run", executable: "npx", args: npxPrepareArgs(spec), cwd: "isolated", network: true, timeoutMs: NPX_PREPARE_TIMEOUT_MS };
}

export interface BackendAdapterV1 extends InstallerAdapter {
  readonly id: InstallBackend;
  /** Manifest 설치 단계 → launch spec(플랫폼 변환 포함)·artifact·준비 단계. 실행하지 않는다. */
  planLaunch(manifest: Manifest, step: InstallStep, platform: RecommendPlatform): BackendPlanResult;
}

const unsupported = (id: InstallBackend, what: string) =>
  Promise.reject(new InstallerOperationError("UNSUPPORTED_IN_M4", id + " Adapter의 " + what + "은(는) M4에서 지원하지 않습니다"));

function createBackendAdapter(id: InstallBackend): BackendAdapterV1 {
  const planLaunch = (manifest: Manifest, step: InstallStep, platform: RecommendPlatform) =>
    id === "docker" ? planDocker(manifest, step, platform) : planLaunchOnDemand(manifest, step, id, platform);
  return Object.freeze({
    id,
    planLaunch,
    canHandle(target: InstallTarget, ctx: InstallContext): boolean {
      return target.step.adapter === id && planLaunch(target.manifest, target.step, ctx.platform).ok;
    },
    async validate(target: InstallTarget, ctx: InstallContext): Promise<ValidationResult> {
      if (target.step.adapter !== id) return { ok: false, problems: ["Adapter가 다릅니다"] };
      const result = planLaunch(target.manifest, target.step, ctx.platform);
      return result.ok ? { ok: true, problems: [] } : { ok: false, problems: [result.reason] };
    },
    plan(_target: InstallTarget, operation: Operation, _ctx: InstallContext): Promise<InstallPlan> {
      if (operation !== "install") return unsupported(id, operation);
      return Promise.reject(new InstallerOperationError("INSTALL_PLAN_V1_REQUIRED", "M4 설치는 InstallPlan v1(buildInstallPlan)로만 계획합니다"));
    },
    install(): Promise<InstallResult> {
      return Promise.reject(new InstallerOperationError("INSTALL_PLAN_V1_REQUIRED", "M4 설치는 VerifiedPlan을 받는 Executor로만 실행합니다"));
    },
    update(): Promise<UpdateResult> {
      return unsupported(id, "update");
    },
    healthCheck(): Promise<HealthResult> {
      return unsupported(id, "healthCheck");
    },
    uninstall(): Promise<void> {
      return unsupported(id, "uninstall");
    },
  });
}

export const npxAdapter = createBackendAdapter("npx");
export const uvxAdapter = createBackendAdapter("uvx");
export const dockerAdapter = createBackendAdapter("docker");
export const BACKEND_ADAPTERS: Readonly<Record<InstallBackend, BackendAdapterV1>> = Object.freeze({ npx: npxAdapter, uvx: uvxAdapter, docker: dockerAdapter });
