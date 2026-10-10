import type { InstallStep, Manifest } from "../manifest/index";
import type { RecommendPlatform } from "../recommendation/index";
import type { HealthResult, InstallContext, InstallPlan, InstallResult, InstallTarget, InstallerAdapter, Operation, UpdateResult, ValidationResult } from "./adapter";
import { isPinnedArtifact, isValidDockerImage, npxArtifact, tokenizeManifestCommand, uvxArtifact } from "./command";
import type { InstallBackend, InstallPlanV1, RunStep } from "./plan";
import { NPX_PREPARE_STEP_ID, NPX_PREPARE_TIMEOUT_MS, npxPrepareArgs } from "../process/npx-prepare";
import { NPX_CLI_PLACEHOLDER, TOOL_CONFIG_PLACEHOLDER, toolConfigIssues } from "../tool-config/index";

/**
 * npx·uvx·docker Adapter(TASK-031, D-012·D-015). Adapter는 Plan 단계만 만들고 프로세스를 실행하지 않는다.
 * - npx·uvx: launch-on-demand. 준비 단계 0개, Client launch spec만 기록한다(persistent install 없음).
 *   단, 정확한 버전으로 고정된 npx 패키지는 npx Prepare 단계 1개(npm-cache)를 둔다(v0.2.0, docs/specs/npx-prepare.md).
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
  const pinned = isPinnedArtifact(backend, ref);
  const prepare = npxPrepareStepFor(backend, ref.spec, pinned);
  return {
    ok: true,
    value: {
      backend,
      artifact: { kind: backend === "npx" ? "npm-package" : "python-package", spec: ref.spec, pinned, preparation: prepare === null ? "launch-on-demand" : "npm-cache" },
      launch: { platform, executable: backend, args, envNames: requiredEnvNames(manifest), clientSpec: clientLaunchSpec(platform, backend, args) },
      preparation: prepare === null ? [] : [prepare],
    },
  };
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
