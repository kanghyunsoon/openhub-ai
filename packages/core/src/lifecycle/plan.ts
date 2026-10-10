import { z } from "zod";
import path from "node:path";
import { containsAbsolutePath } from "../analyzer/index";
import type { FetchLike } from "../discovery/github";
import {
  isKernelVerified,
  requestKernelApproval,
  verifyKernelApproval,
  type ApprovalChannel,
  type ApprovalPlanKind,
  type KernelApproval,
  type KernelApprovalOutcome,
  type KernelApprovalRequest,
  type KernelGateFailure,
  type KernelPrompter,
  type KernelVerified,
} from "../installer/approval-v1";
import { BACKEND_ADAPTERS, DOCKER_PULL_TIMEOUT_MS, clientLaunchSpec, npxPrepareStepFor } from "../installer/backends";
import { isPinnedArtifact, isValidDockerImage, npxArtifact, parseNpmSpec, tokenizeManifestCommand } from "../installer/command";
import { parseNpxPrepareArgs } from "../process/npx-prepare";
import { configTargetFor, inspectConfigTarget, nodeConfigFs, readConfiguredEntry, type ConfigFs } from "../installer/config-writer";
import {
  CONFIG_SCOPES,
  INSTALL_BACKENDS,
  INSTALL_CLIENTS,
  NPX_PREPARE_NOTICE,
  canonicalize,
  manifestDigest,
  registryDigestExcluding,
  requiredEnvNotice,
  runStepSchema,
  serverEntry,
  serverEntrySchema,
  sha256Digest,
  toolConfigStepFor,
  toolConfigStepSchema,
  type ConfigScope,
  type InstallBackend,
  type InstallClient,
  type PlanBlocker,
  type ToolConfigStateInput,
} from "../installer/plan";
import { installCandidates } from "../installer/router";
import {
  NPX_CLI_PLACEHOLDER,
  REVIEWED_TOOL_CONFIGS,
  TOOL_CONFIG_PLACEHOLDER,
  clientLauncherDigest,
  inspectRecordedLauncher,
  inspectToolConfig,
  planFormOfEntry,
  toolConfigDigest,
  toolConfigLocation,
  verifyClientLauncher,
  type ClientLauncher,
  type LauncherCheckFs,
  type ToolConfigFs,
} from "../tool-config/index";
import { PLAN_CHANGE_KINDS } from "../installer/stale";
import type { Manifest } from "../manifest/index";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, type RecommendPlatform } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { resolveArtifact, type ResolverErrorCode } from "./resolver";
import { CLIENT_COMMANDS, artifactIdentitySchema, entryKeyOf, type ArtifactIdentity, type ToolState } from "./state";
import { configEntryDigest, standardEntries } from "./status";
import { projectKeyFor, readLifecycleState, type StateErrorCode } from "./store";

/**
 * LifecyclePlan v1·Approval·PLAN_STALE 확장(TASK-040, D-020).
 * - InstallPlan v1은 그대로 두고 update·rollback·health용 Plan을 따로 둔다. 승인·검증은 installer/approval-v1의 공통 kernel을 쓴다.
 * - Update Available ≠ Approval. 같은 identity면 up-to-date(승인 불가), config-drift·untracked-foreign이면 blocked(CONFIG_DRIFT)이다.
 * - digest에는 target resolved identity가 들어간다. 실행 직전 state·config·resolver를 다시 읽어 비교하고 다르면 PLAN_STALE이다.
 * - Health gate 기본값은 REQUIRED다. health-gate-skipped는 required env ≥ 1일 때만 고를 수 있다(D-019).
 * - process.env를 읽지 않고 절대 경로·token·URL credential을 Plan에 넣지 않는다.
 */

export const LIFECYCLE_PLAN_SCHEMA_VERSION = 1;
/** repair(v0.2.0): tool config Tool의 누락·변경된 OpenHub 관리 파일과 Client 설정 경로를 승인 뒤 다시 만든다(버전은 그대로). */
export const LIFECYCLE_OPERATIONS = ["update", "rollback", "health", "repair"] as const;
export type LifecycleOperation = (typeof LIFECYCLE_OPERATIONS)[number];
export const LIFECYCLE_PLAN_STATUSES = ["ready", "up-to-date", "blocked", "unsupported"] as const;
export const LIFECYCLE_APPROVAL_REQUIREMENTS = ["base", "health-execution", "user-scope-config", "environment-unverified", "health-gate-skipped", "rollback-to-previous", "tool-config"] as const;
export type LifecycleApprovalRequirement = (typeof LIFECYCLE_APPROVAL_REQUIREMENTS)[number];
export const LIFECYCLE_PLAN_CHANGE_KINDS = [...PLAN_CHANGE_KINDS, "state", "resolution", "health-policy", "rollback-snapshot"] as const;
export type LifecyclePlanChange = (typeof LIFECYCLE_PLAN_CHANGE_KINDS)[number];
export const HEALTH_GATES = ["required", "skipped-by-approval"] as const;
export type HealthGate = (typeof HEALTH_GATES)[number];
/** D-019 Health 한도. */
export const HEALTH_TIMEOUTS = Object.freeze({ startupMs: 20_000, handshakeMs: 10_000, totalMs: 45_000 });

export const HEALTH_GATE_SKIP_NOTICE =
  "이 도구는 실행에 환경변수가 필요하지만 OpenHub는 해당 값이나 설정 여부를 확인하지 않습니다. Health Check를 생략하면 업데이트 후 MCP가 실제로 동작하는지는 검증되지 않습니다.";
export const VERSION_LEVEL_LOCK_NOTICE = "npm·PyPI 패키지는 버전 수준으로 고정합니다. 같은 버전의 tarball 내용까지 고정하지는 않습니다.";
export const HEALTH_EXECUTION_NOTICE = "Health Check는 MCP 서버(제3자 코드)를 격리된 임시 디렉터리에서 실행하며 패키지나 이미지를 내려받을 수 있습니다.";
export const CLIENT_WRAPPER_NOTICE = "Health Check는 artifact를 검증합니다. Client 설정의 cmd /d /c npx wrapper 자체는 검증하지 않습니다.";
/** 직전 버전이 unlocked(resolved null)였던 rollback 고지. 정확한 artifact 복구를 약속하지 않는다. */
export const ROLLBACK_UNLOCKED_NOTICE =
  "직전 버전은 artifact가 고정되지 않은(unlocked) 상태였습니다. 이전 설정·실행 명령·Version State는 되돌리지만 정확히 같은 패키지 버전이나 이미지로 복구된다고 보장하지 않습니다. 롤백 후에도 artifact는 unlocked입니다.";

export const LIFECYCLE_APPROVAL_MESSAGES: Readonly<Record<LifecycleApprovalRequirement, string>> = {
  base: "위 lifecycle 계획(바뀌는 artifact, 쓰는 설정 파일, 실행할 명령)을 확인했고 이대로 실행하는 데 동의합니다.",
  "health-execution": HEALTH_EXECUTION_NOTICE,
  "user-scope-config": "프로젝트 밖의 사용자 설정 파일(홈 디렉터리)을 수정합니다. 다른 프로젝트에도 영향을 줍니다.",
  "environment-unverified": "이 도구는 실행에 환경변수가 필요하지만 OpenHub는 해당 값이나 설정 여부를 확인하지 않습니다.",
  "health-gate-skipped": HEALTH_GATE_SKIP_NOTICE,
  "rollback-to-previous": "Version State에 남은 직전 버전으로 되돌립니다. 현재 버전 설정은 바뀝니다.",
  "tool-config": "OpenHub가 ~/.openhub/tool-config 아래에 검토된 서버 정책 파일을 만들거나 바꾸고, Client 설정이 그 파일을 쓰게 합니다.",
};

const text = z.string().min(1).max(300);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);
const clientSpecSchema = z.strictObject({ command: z.enum(CLIENT_COMMANDS), args: z.array(text) });
const timeoutsSchema = z.strictObject({ startupMs: z.number().int().positive(), handshakeMs: z.number().int().positive(), totalMs: z.number().int().positive() });

export const configReplaceStepSchema = z.strictObject({
  id: text,
  kind: z.literal("config-replace"),
  client: z.enum(INSTALL_CLIENTS),
  scope: z.enum(CONFIG_SCOPES),
  file: text,
  path: z.array(text).min(2),
  /** 교체 직전 항목이 이 digest와 같아야 한다(Version State 기록값). */
  expectedEntryDigest: sha256,
  value: serverEntrySchema,
});
export type ConfigReplaceStep = z.output<typeof configReplaceStepSchema>;

export const healthStepSchema = z.strictObject({
  id: text,
  kind: z.literal("health"),
  /** backend 기준 논리 실행 파일과 인자(플랫폼별 실제 argv는 Health 실행 계층이 만든다. cmd wrapper는 쓰지 않는다). */
  executable: z.enum(INSTALL_BACKENDS),
  args: z.array(text).min(1),
  envNames: z.array(envName),
  cwd: z.literal("isolated"),
  timeouts: timeoutsSchema,
});
export type HealthStep = z.output<typeof healthStepSchema>;

export const stateCommitStepSchema = z.strictObject({ id: text, kind: z.literal("state-commit"), entries: z.array(text).min(1) });
export const healthRecordStepSchema = z.strictObject({ id: text, kind: z.literal("health-record"), entries: z.array(text).min(1) });

const lifecycleTargetSchema = z.strictObject({
  client: z.enum(INSTALL_CLIENTS),
  scope: z.enum(CONFIG_SCOPES),
  file: text,
  serverName: text,
  entryKey: text,
  /** Version State revision(미추적 대상은 null). */
  stateRevision: z.number().int().min(1).nullable(),
  precondition: z.strictObject({ fileDigest: sha256.nullable(), entryDigest: sha256.nullable() }),
  /** repair: 옮기거나 복사한 프로젝트에서 이 기록(EntryKey)을 새 위치로 가져온다(v0.2.0). */
  relocatedFrom: text.optional(),
  /**
   * Windows 직접 실행 항목(v0.2.0, tool config Tool): 지금 Client 설정에 있는 node.exe·npx-cli.js가 유효한지(recorded)와
   * 이번 실행이 새로 쓸 검증된 실행 경로의 digest(replacementDigest, 경로 없음). 승인 뒤 어느 쪽이든 바뀌면 PLAN_STALE이다.
   */
  launcher: z.strictObject({ recorded: z.enum(["valid", "invalid"]), replacementDigest: sha256.nullable() }).optional(),
});
export type LifecyclePlanTarget = z.output<typeof lifecycleTargetSchema>;

const strings = (value: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
};

export const lifecyclePlanSchema = z
  .strictObject({
    schemaVersion: z.literal(LIFECYCLE_PLAN_SCHEMA_VERSION),
    operation: z.enum(LIFECYCLE_OPERATIONS),
    status: z.enum(LIFECYCLE_PLAN_STATUSES),
    toolId: text,
    displayName: text,
    backend: z.enum(INSTALL_BACKENDS),
    platform: z.enum(["windows", "macos", "linux"]),
    source: z.strictObject({ registryDigest: sha256, manifestDigest: sha256, stateDigest: sha256 }),
    current: z.strictObject({ requested: text, identity: artifactIdentitySchema.nullable(), clientSpec: clientSpecSchema }),
    target: z.strictObject({ requested: text, identity: artifactIdentitySchema.nullable(), clientSpec: clientSpecSchema }),
    targets: z.array(lifecycleTargetSchema).min(1),
    steps: z.array(z.discriminatedUnion("kind", [runStepSchema, toolConfigStepSchema, configReplaceStepSchema, healthStepSchema, stateCommitStepSchema, healthRecordStepSchema])),
    healthPolicy: z.strictObject({ gate: z.enum(HEALTH_GATES), timeouts: timeoutsSchema }),
    requiredEnv: z.array(z.strictObject({ name: envName, required: z.boolean(), status: z.literal("unchecked") })),
    sideEffects: z.array(z.enum(["network", "download", "file-write", "process-launch"])),
    warnings: z.array(z.strictObject({ code: text, message: z.string().min(1).max(400) })),
    approvalRequirements: z.array(z.enum(LIFECYCLE_APPROVAL_REQUIREMENTS)).min(1),
  })
  .superRefine((plan, ctx) => {
    if (plan.status === "ready" && plan.operation === "update" && plan.target.identity === null) {
      ctx.addIssue({ code: "custom", path: ["target", "identity"], message: "update Plan은 resolved identity가 있어야 한다" });
    }
    const spec = plan.target.clientSpec;
    const direct = plan.platform === "windows" && plan.backend === "npx" && spec.args.includes(TOOL_CONFIG_PLACEHOLDER);
    const wrapped = plan.platform === "windows" && plan.backend === "npx" && !direct;
    if (direct ? spec.command !== "node" || spec.args[0] !== NPX_CLI_PLACEHOLDER : wrapped ? spec.command !== "cmd" || JSON.stringify(spec.args.slice(0, 3)) !== JSON.stringify(["/d", "/c", "npx"]) : spec.command !== plan.backend) {
      ctx.addIssue({ code: "custom", path: ["target", "clientSpec"], message: "clientSpec이 플랫폼별 launch 규칙(D-016)과 다릅니다" });
    }
    const hasHealth = plan.steps.some((s) => s.kind === "health");
    if (plan.status === "ready" && hasHealth !== (plan.healthPolicy.gate === "required")) {
      ctx.addIssue({ code: "custom", path: ["steps"], message: "Health 단계는 gate가 required일 때만 있다" });
    }
    plan.steps.forEach((step, i) => {
      if (step.kind === "run" && step.executable === "npx" && (plan.backend !== "npx" || parseNpxPrepareArgs(step.args) === null)) {
        ctx.addIssue({ code: "custom", path: ["steps", i], message: "npx 준비 단계는 npx backend의 정확한 버전 spec만 받을 수 있습니다" });
      }
    });
    for (const found of strings(plan)) {
      const problem = containsAbsolutePath(found.value) ? "절대 경로" : URL_CREDENTIAL_PATTERN.test(found.value) ? "URL credential" : TOKEN_PATTERN.test(found.value) ? "token" : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: "LifecyclePlan에 " + problem + "이(가) 포함될 수 없습니다" });
    }
  });
export type LifecyclePlanV1 = z.output<typeof lifecyclePlanSchema>;

export interface PlannedLifecycle {
  plan: LifecyclePlanV1;
  planDigest: string;
}

export function lifecyclePlanDigest(plan: LifecyclePlanV1): string {
  return sha256Digest(JSON.stringify(canonicalize(plan)));
}

/** 사람이 읽고 비교하는 안정 직렬화(키 정렬, 2칸 들여쓰기, 끝 개행). */
export function serializeLifecyclePlan(plan: LifecyclePlanV1): string {
  return JSON.stringify(canonicalize(lifecyclePlanSchema.parse(plan)), null, 2) + "\n";
}

// ---------------------------------------------------------------- 조립(순수 함수)

export interface LifecycleTargetInput {
  client: InstallClient;
  scope: ConfigScope;
  file: string;
  serverName: string;
  entryKey: string;
  stateRevision: number | null;
  precondition: { fileDigest: string | null; entryDigest: string | null };
  relocatedFrom?: string;
  launcher?: { recorded: "valid" | "invalid"; replacementDigest: string | null };
}

export interface LifecyclePlanAssemblyInput {
  operation: LifecycleOperation;
  toolId: string;
  manifest: Manifest;
  registryDigest: string;
  stateDigest: string;
  backend: InstallBackend;
  platform: RecommendPlatform;
  current: { requested: string; identity: ArtifactIdentity | null; clientSpec: { command: (typeof CLIENT_COMMANDS)[number]; args: string[] } };
  /** launchArgs는 backend 기준 인자(cmd wrapper 없음). clientSpec은 플랫폼 규칙(D-016)으로 만든다. */
  target: { requested: string; identity: ArtifactIdentity | null; launchArgs: string[] };
  targets: LifecycleTargetInput[];
  healthGate: HealthGate;
  blockers: PlanBlocker[];
  /** tool config Tool(v0.2.0): 검토된 내용과 scope별 현재 상태. 있으면 update·rollback·repair가 tool-config 단계를 갖는다. */
  toolConfig?: { content: string; current: readonly { scope: ConfigScope; current: ToolConfigStateInput }[] };
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const CLIENT_ORDER: Readonly<Record<InstallClient, number>> = { "claude-code": 0, codex: 1, cursor: 2 };
const SCOPE_ORDER: Readonly<Record<ConfigScope, number>> = { project: 0, user: 1 };
const UNSUPPORTED_CODES = new Set(["PLATFORM_UNSUPPORTED", "BACKEND_NOT_IN_MANIFEST", "ROLLBACK_UNSUPPORTED"]);

/** update·rollback·health Plan을 같은 규칙으로 조립한다(rollback 전용 차단 사유·고지 포함). */
export function assembleLifecyclePlan(input: LifecyclePlanAssemblyInput): PlannedLifecycle {
  const { manifest, operation, backend } = input;
  const requiredEnv = [...manifest.env].map((e) => ({ name: e.name, required: e.required, status: "unchecked" as const })).sort((a, b) => cmp(a.name, b.name));
  const requiredNames = requiredEnv.filter((e) => e.required).map((e) => e.name);
  const targets = [...input.targets]
    .sort((a, b) => CLIENT_ORDER[a.client] - CLIENT_ORDER[b.client] || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
    .map((t) => ({ ...t, precondition: { ...t.precondition }, ...(t.launcher === undefined ? {} : { launcher: { ...t.launcher } }) }));
  const clientSpec = clientLaunchSpec(input.platform, backend, input.target.launchArgs);
  const blockers = [...input.blockers].sort((a, b) => cmp(a.code, b.code) || cmp(a.message, b.message));
  const sameIdentity = input.current.identity !== null && input.target.identity !== null && input.current.identity.spec === input.target.identity.spec;
  const status: LifecyclePlanV1["status"] = blockers.some((b) => UNSUPPORTED_CODES.has(b.code))
    ? "unsupported"
    : blockers.length > 0
      ? "blocked"
      : operation !== "health" && operation !== "repair" && sameIdentity
        ? "up-to-date"
        : "ready";
  const ready = status === "ready";
  const healthRequired = input.healthGate === "required";
  const entryKeys = targets.map((t) => t.entryKey).sort(cmp);

  const steps: LifecyclePlanV1["steps"] = [];
  const healthStep: HealthStep = {
    id: "health",
    kind: "health",
    executable: backend,
    args: [...input.target.launchArgs],
    envNames: [...requiredNames],
    cwd: "isolated",
    timeouts: { ...HEALTH_TIMEOUTS },
  };
  if (ready && operation === "health") {
    steps.push(healthStep, { id: "health-record", kind: "health-record", entries: entryKeys });
  } else if (ready) {
    // npx Prepare: 정확한 버전으로 고정된 대상이면 설정을 바꾸기 전에 npx cache를 채운다(Health 20 s 안에 시작하도록).
    if (backend === "npx") {
      const ref = npxArtifact(input.target.launchArgs);
      const prepare = ref === null ? null : npxPrepareStepFor(backend, ref.spec, isPinnedArtifact("npx", ref));
      if (prepare !== null) steps.push(prepare);
    }
    if (backend === "docker") {
      // update는 resolved digest, rollback은 직전 identity(없으면 직전 launch 인자의 image)를 받는다.
      const image = input.target.identity?.spec ?? input.target.launchArgs[input.target.launchArgs.length - 1]!;
      steps.push({ id: "docker-pull", kind: "run", executable: "docker", args: ["pull", image], cwd: "isolated", network: true, timeoutMs: DOCKER_PULL_TIMEOUT_MS });
    }
    // tool config: Client 설정을 바꾸기 전에 scope별 OpenHub 관리 파일을 검토된 내용으로 맞춘다.
    if (input.toolConfig !== undefined) {
      for (const scope of [...new Set(targets.map((t) => t.scope))].sort((a, b) => SCOPE_ORDER[a] - SCOPE_ORDER[b])) {
        const found = input.toolConfig.current.find((c) => c.scope === scope);
        if (found !== undefined) steps.push(toolConfigStepFor(input.toolId, input.toolConfig.content, scope, found.current));
      }
    }
    const launch = { platform: input.platform, executable: backend, args: [...input.target.launchArgs], envNames: [...requiredNames], clientSpec };
    for (const t of targets) {
      steps.push({
        id: "config-" + t.client + "-" + t.scope,
        kind: "config-replace",
        client: t.client,
        scope: t.scope,
        file: t.file,
        path: [t.client === "codex" ? "mcp_servers" : "mcpServers", t.serverName],
        expectedEntryDigest: t.precondition.entryDigest!,
        value: serverEntry(t.client, launch, requiredNames),
      });
    }
    if (healthRequired) steps.push(healthStep);
    steps.push({ id: "state-commit", kind: "state-commit", entries: entryKeys });
  }

  const approvalRequirements = new Set<LifecycleApprovalRequirement>(["base"]);
  if (ready) {
    if (steps.some((s) => s.kind === "health")) approvalRequirements.add("health-execution");
    if (operation !== "health" && targets.some((t) => t.scope === "user")) approvalRequirements.add("user-scope-config");
    if (requiredNames.length > 0) approvalRequirements.add("environment-unverified");
    if (!healthRequired) approvalRequirements.add("health-gate-skipped");
    if (operation === "rollback") approvalRequirements.add("rollback-to-previous");
    if (steps.some((s) => s.kind === "tool-config")) approvalRequirements.add("tool-config");
  }

  const warnings: LifecyclePlanV1["warnings"] = blockers.map((b) => ({ code: b.code, message: b.message }));
  if (ready) {
    if (operation !== "health" && backend !== "docker") warnings.push({ code: "version-level-lock", message: VERSION_LEVEL_LOCK_NOTICE });
    if (operation === "rollback" && input.target.identity === null) warnings.push({ code: "rollback-artifact-unlocked", message: ROLLBACK_UNLOCKED_NOTICE });
    if (steps.some((s) => s.kind === "run" && s.executable === "npx")) warnings.push({ code: "npx-prepare", message: NPX_PREPARE_NOTICE });
    if (backend === "docker") warnings.push({ code: "docker-daemon-unchecked", message: "docker 데몬 연결 여부는 확인하지 않았습니다. 데몬이 꺼져 있으면 준비·Health 단계가 실패합니다" });
    if (steps.some((s) => s.kind === "health")) {
      warnings.push({ code: "health-execution", message: HEALTH_EXECUTION_NOTICE });
      if (input.platform === "windows" && backend === "npx") warnings.push({ code: "client-wrapper-not-verified", message: CLIENT_WRAPPER_NOTICE });
    }
    for (const name of requiredNames) warnings.push({ code: "environment-unverified", message: requiredEnvNotice(name) });
    if (!healthRequired) warnings.push({ code: "health-gate-skipped", message: HEALTH_GATE_SKIP_NOTICE });
    const reviewed = REVIEWED_TOOL_CONFIGS[input.toolId];
    if (steps.some((s) => s.kind === "tool-config") && reviewed !== undefined) warnings.push({ code: "tool-config", message: reviewed.notice });
  }
  warnings.sort((a, b) => cmp(a.code, b.code) || cmp(a.message, b.message));

  const sideEffects = new Set<LifecyclePlanV1["sideEffects"][number]>();
  for (const s of steps) {
    if (s.kind === "run" || s.kind === "health") {
      sideEffects.add("network");
      sideEffects.add("download");
    }
    if (s.kind === "health") sideEffects.add("process-launch");
    if (s.kind === "config-replace" || s.kind === "state-commit" || s.kind === "health-record" || s.kind === "tool-config") sideEffects.add("file-write");
  }

  const plan: LifecyclePlanV1 = {
    schemaVersion: LIFECYCLE_PLAN_SCHEMA_VERSION,
    operation,
    status,
    toolId: input.toolId,
    displayName: manifest.displayName ?? manifest.name,
    backend,
    platform: input.platform,
    source: { registryDigest: input.registryDigest, manifestDigest: manifestDigest(manifest), stateDigest: input.stateDigest },
    current: { requested: input.current.requested, identity: input.current.identity === null ? null : { ...input.current.identity }, clientSpec: { command: input.current.clientSpec.command, args: [...input.current.clientSpec.args] } },
    target: { requested: input.target.requested, identity: input.target.identity === null ? null : { ...input.target.identity }, clientSpec },
    targets,
    steps,
    healthPolicy: { gate: input.healthGate, timeouts: { ...HEALTH_TIMEOUTS } },
    requiredEnv,
    sideEffects: [...sideEffects].sort(cmp),
    warnings,
    approvalRequirements: LIFECYCLE_APPROVAL_REQUIREMENTS.filter((r) => approvalRequirements.has(r)),
  };
  const parsed = lifecyclePlanSchema.parse(plan);
  return { plan: parsed, planDigest: lifecyclePlanDigest(parsed) };
}

// ---------------------------------------------------------------- 입력 수집(state·config·resolver)

export interface LifecyclePlanOptions {
  operation: LifecycleOperation;
  toolId: string;
  projectRoot: string;
  /** OpenHub 관리 tool config 파일 접근(v0.2.0, 테스트 주입용). */
  toolConfigFs?: ToolConfigFs;
  homeDir: string;
  entries: readonly RegistryEntry[];
  platform: RecommendPlatform;
  /** user scope Version State·config를 다룰지(D-003). 명시한 user 대상도 opt-in으로 본다. */
  includeUser: boolean;
  /** 대상(client, scope). 없으면 이 프로젝트(와 includeUser면 user)의 관리 항목 전부. */
  targets?: readonly { client: InstallClient; scope: ConfigScope }[];
  /** update 목표 버전(dist-tag 또는 정확한 버전). 없으면 Manifest 기본 spec. */
  to?: string;
  /** health-gate-skipped 요청. required env ≥ 1인 update·rollback에서만 허용한다. */
  skipHealth?: boolean;
  fetch?: FetchLike;
  timeoutMs?: number;
  fs?: ConfigFs;
  /**
   * Windows 직접 실행 항목에 새로 쓸 Node.js 실행 경로(v0.2.0). 보통 CLI·Desktop의 windowsNpx(PATH 탐색, 실행 없음).
   * update·rollback·repair Plan이 검증된 경로의 digest를 갖는다. Windows 직접 실행 대상에서 이 함수가 없거나 검증에 실패하면
   * Plan을 막는다(CLIENT_LAUNCHER_UNAVAILABLE): 승인하지 않은 실행 경로로 Client 설정을 바꾸지 않는다. Health는 설정을 쓰지 않아 필요 없다.
   */
  clientLauncher?: () => Promise<ClientLauncher | null>;
  /** 실행 경로 검사용 fs(v0.2.0, 테스트 주입용). */
  launcherCheckFs?: LauncherCheckFs;
}

export type LifecyclePlanErrorCode =
  | "TOOL_NOT_FOUND"
  | "REPAIR_UNSUPPORTED"
  | "NOT_MANAGED"
  | "NO_ROLLBACK_TARGET"
  | "HEALTH_SKIP_NOT_ALLOWED"
  | "INVALID_TARGET_VERSION"
  | "MANIFEST_COMMAND_REJECTED"
  | StateErrorCode
  | ResolverErrorCode;
export type LifecyclePlanResult = { ok: true; planned: PlannedLifecycle } | { ok: false; code: LifecyclePlanErrorCode; message: string };

const TARGET_VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/u;

/** Manifest artifact spec에 목표 버전을 붙인다(--to). */
function withVersion(backend: InstallBackend, spec: string, to: string): string | null {
  if (!TARGET_VERSION.test(to)) return null;
  if (backend === "npx") {
    const parsed = parseNpmSpec(spec);
    return parsed === null ? null : parsed.name + "@" + to;
  }
  if (backend === "uvx") {
    const name = /^[A-Za-z0-9][A-Za-z0-9._-]*/u.exec(spec)?.[0];
    return name === undefined ? null : name + "==" + to;
  }
  const bare = spec.replace(/@sha256:[0-9a-f]{64}$/u, "");
  const slash = bare.lastIndexOf("/");
  const colon = bare.lastIndexOf(":");
  return (colon > slash ? bare.slice(0, colon) : bare) + ":" + to;
}

/** backend 인자에서 artifact token 하나를 resolved spec으로 바꾼다. */
function substituteArtifact(backend: InstallBackend, args: readonly string[], from: string, to: string): string[] | null {
  const index = backend === "docker" ? args.lastIndexOf(from) : args.indexOf(from);
  if (index === -1) return null;
  const out = [...args];
  out[index] = to;
  return out;
}

const argsOfClientSpec = (spec: { command: string; args: readonly string[] }) => (spec.command === "cmd" ? spec.args.slice(3) : spec.command === "node" ? spec.args.slice(1) : [...spec.args]);
/** tool config Tool의 launch 인자가 검토된 명령(버전·플래그) 중 하나인가. */
const reviewedLaunch = (toolId: string, args: readonly string[]) => REVIEWED_TOOL_CONFIGS[toolId]?.commands.includes(["npx", ...args].join(" ")) === true;
/** launch 인자 검사. {toolConfig} token은 검토된 placeholder로 보고, 그 Tool은 Windows cmd 래퍼 규칙을 쓰지 않는다(직접 실행). */
const launchTokensOk = (backend: "npx" | "uvx", args: readonly string[], platform: RecommendPlatform) => {
  const usesToolConfig = args.includes(TOOL_CONFIG_PLACEHOLDER);
  const tokens = args.map((a) => (a === TOOL_CONFIG_PLACEHOLDER ? "openhub-tool-config-placeholder" : a));
  return tokenizeManifestCommand(backend + " " + tokens.join(" "), backend, { windowsCmdWrapper: platform === "windows" && backend === "npx" && !usesToolConfig }).ok;
};
const stateDigestOf = (states: readonly ToolState[]) =>
  sha256Digest(JSON.stringify(canonicalize([...states].sort((a, b) => cmp(entryKeyOf(a.target), entryKeyOf(b.target))).map(({ lastHealth: _ignored, ...rest }) => rest))));

/**
 * Version State·config·Manifest·resolver를 읽어 LifecyclePlan을 만든다. 실행 직전 재생성도 같은 함수를 쓴다.
 * blocked·unsupported Plan은 resolver를 호출하지 않는다. resolver가 실패하면 Plan을 만들지 않는다.
 * rollback(TASK-044)은 state.previous로 target을 만들고 resolver를 호출하지 않는다. previous가 없으면 NO_ROLLBACK_TARGET이다.
 */
export async function planLifecycle(options: LifecyclePlanOptions): Promise<LifecyclePlanResult> {
  const fs = options.fs ?? nodeConfigFs;
  const entry = options.entries.find((e) => e.manifest.name === options.toolId);
  if (entry === undefined) return { ok: false, code: "TOOL_NOT_FOUND", message: "Registry에 없는 Tool입니다" };
  const manifest = entry.manifest;
  const requiredNames = manifest.env.filter((e) => e.required).map((e) => e.name);
  if (options.skipHealth === true && (options.operation === "health" || requiredNames.length === 0)) {
    return { ok: false, code: "HEALTH_SKIP_NOT_ALLOWED", message: "Health 생략은 필요한 환경변수가 있는 도구의 update·rollback에서만 사전 승인으로 고를 수 있습니다" };
  }

  const read = await readLifecycleState({ homeDir: options.homeDir, fs });
  if (!read.ok) return read;
  const projectKey = await projectKeyFor(options.projectRoot, fs);
  const userAllowed = options.includeUser || (options.targets ?? []).some((t) => t.scope === "user");
  const managed = Object.values(read.state.entries).filter(
    (s) => s.toolId === options.toolId && (s.target.scope === "project" ? s.target.projectKey === projectKey : userAllowed),
  );
  const wanted = options.targets === undefined ? undefined : new Set(options.targets.map((t) => t.client + ":" + t.scope));
  let selected = managed.filter((s) => wanted === undefined || wanted.has(s.target.client + ":" + s.target.scope));
  const roots = { projectRoot: options.projectRoot, homeDir: options.homeDir, fs };
  // repair(v0.2.0): 옮기거나 복사한 프로젝트. 이 프로젝트의 Client 항목이 다른 projectKey 기록의 항목과 byte 단위로 같으면 그 기록을 가져온다.
  const relocatedFrom = new Map<string, string>();
  if (selected.length === 0 && options.operation === "repair" && manifest.toolConfig !== undefined) {
    const candidates = Object.values(read.state.entries).filter(
      (s) => s.toolId === options.toolId && s.target.scope === "project" && s.target.projectKey !== projectKey && s.toolConfig !== undefined && (wanted === undefined || wanted.has(s.target.client + ":project")),
    );
    const byClient = new Map<string, ToolState[]>();
    for (const s of candidates) {
      const value = await readConfiguredEntry(s.target.client, "project", s.target.serverName, roots).catch(() => undefined);
      if (value === undefined || configEntryDigest(value) !== s.config.entryDigest) continue;
      byClient.set(s.target.client, [...(byClient.get(s.target.client) ?? []), s]);
    }
    for (const [, list] of byClient) {
      if (list.length !== 1) return { ok: false, code: "NOT_MANAGED", message: "같은 설정을 가진 기록이 여러 개라 어느 프로젝트에서 옮겨 왔는지 정할 수 없습니다" };
      const s = list[0]!;
      const moved: ToolState = { ...s, target: { ...s.target, projectKey, projectName: path.basename(path.resolve(options.projectRoot)) } };
      relocatedFrom.set(entryKeyOf(moved.target), entryKeyOf(s.target));
      selected.push(moved);
    }
  }
  if (selected.length === 0) return { ok: false, code: "NOT_MANAGED", message: "Version State에 이 프로젝트의 " + options.toolId + " 기록이 없습니다" };
  selected.sort((a, b) => cmp(entryKeyOf(a.target), entryKeyOf(b.target)));

  const blockers: PlanBlocker[] = [];
  const targets: LifecycleTargetInput[] = [];
  const inspect = async (client: InstallClient, scope: ConfigScope, serverName: string) => {
    try {
      const target = await inspectConfigTarget(client, scope, serverName, roots);
      const value = await readConfiguredEntry(client, scope, serverName, roots);
      return { fileDigest: target.precondition.fileDigest, value, readable: true };
    } catch {
      return { fileDigest: null, value: undefined, readable: false };
    }
  };

  const requiredSorted = [...requiredNames].sort(cmp);
  let repairNeeded = relocatedFrom.size > 0;
  // Windows 직접 실행(v0.2.0, tool config Tool): Client 설정의 node.exe·npx-cli.js 절대 경로. byte가 같아도 Node.js가 옮겨지면 무효다.
  // update·rollback·repair는 이번에 새로 쓸 실행 경로를 지금 검증하고 그 digest만 Plan에 넣는다(Health는 Client 설정을 쓰지 않는다).
  const directWindows = (s: ToolState) => options.platform === "windows" && s.launch.platform === "windows" && s.launch.clientSpec.command === "node";
  let replacementDigest: string | null = null;
  if (options.operation !== "health" && selected.some(directWindows)) {
    // 실행 경로 탐색기가 없으면 승인할 경로가 없다. digest 없는 Plan은 실행 단계의 일치 검사를 건너뛸 수 있으므로 막는다.
    const located = options.clientLauncher === undefined ? null : await options.clientLauncher().catch(() => null);
    const checked = located === null ? null : await verifyClientLauncher(located, options.launcherCheckFs).catch(() => null);
    if (located !== null && checked?.ok === true) replacementDigest = clientLauncherDigest(located);
    else blockers.push({ code: "CLIENT_LAUNCHER_UNAVAILABLE", message: "지금 Node.js 설치(node.exe·npm의 npx-cli.js)를 검증하지 못해 Client 설정을 바꾸지 않습니다" + (checked?.ok === false ? ": " + checked.reason : "") + ". Node.js 설치를 확인한 뒤 다시 계획하세요" });
  }
  for (const s of selected) {
    const t = s.target;
    const found = await inspect(t.client, t.scope, t.serverName);
    const entryDigest = found.value === undefined ? null : configEntryDigest(found.value);
    // repair: 경로만 다른(Plan 형태가 기록과 같은) OpenHub 항목은 복구 대상이다. 그 밖의 다른 내용은 여전히 config-drift다.
    const repairable =
      options.operation === "repair" &&
      found.value !== undefined &&
      same(planFormOfEntry(found.value as { command: string; args: string[] }), serverEntry(t.client, { platform: s.launch.platform, executable: s.backend, args: [], envNames: requiredSorted, clientSpec: s.launch.clientSpec }, requiredSorted));
    if (!found.readable) blockers.push({ code: "CONFIG_UNREADABLE", message: t.file + "을(를) 안전하게 읽지 못했습니다" });
    else if (entryDigest === null) blockers.push({ code: "MISSING_CONFIG", message: t.file + "에 " + t.serverName + " 항목이 없습니다(Version State와 다릅니다)" });
    else if (entryDigest !== s.config.entryDigest && !repairable) blockers.push({ code: "CONFIG_DRIFT", message: t.file + "의 " + t.serverName + " 항목이 OpenHub가 기록한 내용과 다릅니다(config-drift)" });
    else if (entryDigest !== s.config.entryDigest) repairNeeded = true;
    let launcher: LifecycleTargetInput["launcher"];
    if (directWindows(s) && found.value !== undefined) {
      const checked = await inspectRecordedLauncher(found.value as { command: string; args: string[] }, options.launcherCheckFs).catch(() => ({ ok: false as const, reason: "실행 경로를 확인하지 못했습니다" }));
      launcher = { recorded: checked.ok ? "valid" : "invalid", replacementDigest };
      if (!checked.ok && options.operation === "repair") repairNeeded = true;
      if (!checked.ok && options.operation === "health") {
        blockers.push({ code: "CLIENT_LAUNCHER_INVALID", message: t.file + "의 " + t.serverName + " 항목에 기록된 Node.js 실행 경로가 유효하지 않습니다(client-launcher-invalid: " + checked.reason + "). openhub lifecycle repair로 고치세요" });
      }
    }
    const from = relocatedFrom.get(entryKeyOf(t));
    targets.push({
      client: t.client,
      scope: t.scope,
      file: t.file,
      serverName: t.serverName,
      entryKey: entryKeyOf(t),
      stateRevision: from === undefined ? s.revision : null,
      precondition: { fileDigest: found.fileDigest, entryDigest },
      ...(from === undefined ? {} : { relocatedFrom: from }),
      ...(launcher === undefined ? {} : { launcher }),
    });
  }

  // tool config(v0.2.0): scope별 OpenHub 관리 파일을 확인한다. update·rollback·health는 기록과 같아야 진행하고, repair는 다시 만든다.
  const toolConfigCurrent: { scope: ConfigScope; current: ToolConfigStateInput }[] = [];
  const usesToolConfig = manifest.toolConfig !== undefined && selected.some((s) => s.toolConfig !== undefined);
  if (usesToolConfig) {
    for (const scope of [...new Set(selected.map((s) => s.target.scope))]) {
      const loc = toolConfigLocation({ homeDir: options.homeDir, scope, toolId: options.toolId, ...(scope === "project" ? { projectKey } : {}) });
      const recorded = selected.find((s) => s.target.scope === scope)?.toolConfig;
      let current: ToolConfigStateInput | null = null;
      if (loc !== null) current = await inspectToolConfig(loc, options.toolConfigFs).catch(() => null);
      if (current === null) {
        blockers.push({ code: "TOOL_CONFIG_UNREADABLE", message: scope + " 범위 tool config를 안전하게 확인하지 못했습니다(symlink·junction·권한)" });
        continue;
      }
      toolConfigCurrent.push({ scope, current });
      const consistent = current.state === "present" && recorded !== undefined && current.digest === recorded.digest;
      if (options.operation === "repair") {
        if (!consistent) repairNeeded = true;
      } else if (current.state === "absent") blockers.push({ code: "TOOL_CONFIG_MISSING", message: scope + " 범위 tool config가 없습니다(tool-config-missing). openhub lifecycle repair로 다시 만드세요" });
      else if (!consistent) blockers.push({ code: "TOOL_CONFIG_DRIFT", message: scope + " 범위 tool config가 OpenHub가 기록한 내용과 다릅니다(tool-config-drift). openhub lifecycle repair로 다시 만드세요" });
    }
  }
  if (options.operation === "repair") {
    if (!usesToolConfig) return { ok: false, code: "REPAIR_UNSUPPORTED", message: "repair는 OpenHub 관리 tool config를 쓰는 도구에만 씁니다" };
    if (!repairNeeded && blockers.length === 0) blockers.push({ code: "NOTHING_TO_REPAIR", message: "tool config와 Client 설정이 Version State와 같아 복구할 것이 없습니다" });
  }

  // 명시한 대상 중 Version State가 없는 곳: 표준 항목이면 미관리, 다른 내용이면 untracked-foreign(자동 편입하지 않는다).
  const alias = manifest.recommendation?.identity?.mcpServerNames?.[0] ?? selected[0]!.target.serverName;
  for (const want of options.targets ?? []) {
    if (selected.some((s) => s.target.client === want.client && s.target.scope === want.scope)) continue;
    const writable = configTargetFor(want.client, want.scope);
    const target = { client: want.client, scope: want.scope, projectName: null, file: writable.logical, serverName: alias, projectKey: want.scope === "project" ? projectKey : null };
    const found = writable.writable ? await inspect(want.client, want.scope, alias) : { fileDigest: null, value: undefined, readable: true };
    const entryDigest = found.value === undefined ? null : configEntryDigest(found.value);
    if (!writable.writable) blockers.push({ code: "MANUAL_SETUP_REQUIRED", message: writable.logical + "은(는) OpenHub가 쓰지 않는 설정 파일입니다" });
    else if (entryDigest === null) blockers.push({ code: "NOT_MANAGED", message: writable.logical + "에는 OpenHub가 관리하는 " + alias + " 항목이 없습니다" });
    else if (standardEntries(manifest, want.client, options.platform).some((v) => configEntryDigest(v) === entryDigest)) {
      blockers.push({ code: "NOT_MANAGED", message: writable.logical + "의 " + alias + " 항목은 표준 항목과 같지만 Version State에 없습니다(untracked-adoptable)" });
    } else blockers.push({ code: "CONFIG_DRIFT", message: writable.logical + "의 " + alias + " 항목은 OpenHub가 관리하지 않는 다른 설정입니다(untracked-foreign)" });
    targets.push({ client: want.client, scope: want.scope, file: writable.logical, serverName: alias, entryKey: entryKeyOf(target), stateRevision: null, precondition: { fileDigest: found.fileDigest, entryDigest } });
  }

  const head = selected[0]!;
  const backend = head.backend;
  const fingerprint = (s: ToolState) => JSON.stringify(canonicalize([s.backend, s.artifact, s.launch.clientSpec]));
  if (selected.some((s) => fingerprint(s) !== fingerprint(head))) {
    blockers.push({ code: "STATE_DIVERGED", message: "선택한 대상들의 현재 버전이 서로 다릅니다. Client·scope별로 나눠 진행하세요" });
  }
  if (!manifest.platform[options.platform]) blockers.push({ code: "PLATFORM_UNSUPPORTED", message: options.platform + " 플랫폼을 지원하지 않습니다" });

  const current = { requested: head.artifact.requested, identity: head.artifact.resolved, clientSpec: { command: head.launch.clientSpec.command, args: [...head.launch.clientSpec.args] } };
  let target = { requested: current.requested, identity: current.identity, launchArgs: argsOfClientSpec(current.clientSpec) };

  if (options.operation === "update") {
    const candidate = installCandidates(manifest).find((c) => c.step.adapter === backend);
    const launched = candidate === undefined ? undefined : BACKEND_ADAPTERS[backend].planLaunch(manifest, candidate.step, options.platform);
    if (launched !== undefined && !launched.ok && launched.kind === "rejected") return { ok: false, code: "MANIFEST_COMMAND_REJECTED", message: launched.reason };
    if (launched === undefined || !launched.ok) {
      blockers.push({ code: "BACKEND_NOT_IN_MANIFEST", message: "현재 Manifest에 " + backend + " 설치 방식이 없습니다" });
    } else {
      const requested = options.to === undefined ? launched.value.artifact.spec : withVersion(backend, launched.value.artifact.spec, options.to);
      if (requested === null) return { ok: false, code: "INVALID_TARGET_VERSION", message: "목표 버전 형식이 올바르지 않습니다" };
      target = { requested, identity: null, launchArgs: argsOfClientSpec(current.clientSpec) };
      if (blockers.length === 0) {
        const resolved = await resolveArtifact(backend, requested, { ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
        if (!resolved.ok) return { ok: false, code: resolved.code, message: resolved.message };
        const args = substituteArtifact(backend, launched.value.launch.args, launched.value.artifact.spec, resolved.identity.spec);
        if (args === null) return { ok: false, code: "MANIFEST_COMMAND_REJECTED", message: "launch 인자에서 artifact 위치를 찾지 못했습니다" };
        if (backend === "docker" ? !isValidDockerImage(resolved.identity.spec) : !launchTokensOk(backend, args, options.platform)) {
          return { ok: false, code: "MANIFEST_COMMAND_REJECTED", message: "resolved artifact를 launch 인자로 안전하게 표현할 수 없습니다" };
        }
        target = { requested, identity: resolved.identity, launchArgs: args };
        if (usesToolConfig && !reviewedLaunch(options.toolId, args)) {
          blockers.push({ code: "TOOL_CONFIG_VERSION_UNREVIEWED", message: resolved.identity.spec + "은(는) OpenHub가 tool config 정책을 검토한 버전이 아닙니다. 검토된 버전으로만 바꿀 수 있습니다" });
        }
      }
    }
  } else if (options.operation === "rollback") {
    if (selected.some((s) => s.previous === null)) return { ok: false, code: "NO_ROLLBACK_TARGET", message: "되돌릴 직전 버전(previous snapshot)이 없습니다" };
    const prev = head.previous!;
    const previousPrint = (s: ToolState) => JSON.stringify(canonicalize([s.previous!.backend, s.previous!.artifact, s.previous!.launch.clientSpec]));
    if (selected.some((s) => previousPrint(s) !== previousPrint(head)) || prev.backend !== backend) {
      blockers.push({ code: "STATE_DIVERGED", message: "선택한 대상들의 직전 버전이 서로 다르거나 설치 방식이 바뀌었습니다. Client·scope별로 나눠 진행하세요" });
    }
    if (!manifest.rollback.supported) blockers.push({ code: "ROLLBACK_UNSUPPORTED", message: "이 도구의 Manifest는 rollback을 지원하지 않습니다(rollback.supported: false)" });
    const args = argsOfClientSpec(prev.launch.clientSpec);
    const safe =
      backend === "docker"
        ? isValidDockerImage(prev.artifact.resolved?.spec ?? args[args.length - 1] ?? "")
        : launchTokensOk(backend, args, options.platform);
    if (!safe) blockers.push({ code: "ROLLBACK_TARGET_INVALID", message: "직전 버전의 실행 인자를 안전하게 표현할 수 없습니다" });
    if (usesToolConfig && prev.toolConfig !== undefined && toolConfigDigest(manifest.toolConfig!.content) !== prev.toolConfig.digest) {
      blockers.push({ code: "ROLLBACK_TARGET_INVALID", message: "직전 버전의 tool config 내용을 현재 검토된 정책으로 복원할 수 없습니다" });
    }
    if (usesToolConfig && !reviewedLaunch(options.toolId, args)) blockers.push({ code: "TOOL_CONFIG_VERSION_UNREVIEWED", message: "직전 버전은 OpenHub가 tool config 정책을 검토한 실행 명령이 아닙니다" });
    target = { requested: prev.artifact.requested, identity: prev.artifact.resolved, launchArgs: args };
  }

  return {
    ok: true,
    planned: assembleLifecyclePlan({
      operation: options.operation,
      toolId: options.toolId,
      manifest,
      registryDigest: registryDigestExcluding(options.entries, options.toolId),
      stateDigest: stateDigestOf(selected),
      backend,
      platform: options.platform,
      ...(usesToolConfig && options.operation !== "health" ? { toolConfig: { content: manifest.toolConfig!.content, current: toolConfigCurrent } } : {}),
      current,
      target,
      targets,
      healthGate: options.skipHealth === true ? "skipped-by-approval" : "required",
      blockers,
    }),
  };
}

// ---------------------------------------------------------------- PLAN_STALE 확장

const same = (a: unknown, b: unknown) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

/** 승인한 LifecyclePlan과 실행 직전 Plan을 비교한다. InstallPlan 8종에 state·resolution·health-policy·rollback-snapshot을 더한다. */
export function diffLifecyclePlans(approved: LifecyclePlanV1, current: LifecyclePlanV1): LifecyclePlanChange[] {
  const changed = new Set<LifecyclePlanChange>();
  if (approved.source.manifestDigest !== current.source.manifestDigest) changed.add("manifest");
  if (approved.source.registryDigest !== current.source.registryDigest) changed.add("registry");
  if (approved.backend !== current.backend) changed.add("backend");
  const revisions = (p: LifecyclePlanV1) => p.targets.map((t) => [t.entryKey, t.stateRevision]);
  if (approved.source.stateDigest !== current.source.stateDigest || !same(revisions(approved), revisions(current)) || !same(approved.current, current.current)) changed.add("state");
  if (approved.target.requested !== current.target.requested || !same(approved.target.identity, current.target.identity)) {
    changed.add(approved.operation === "rollback" ? "rollback-snapshot" : "resolution");
  }
  const identityOf = (p: LifecyclePlanV1) => p.targets.map(({ precondition: _p, stateRevision: _r, ...rest }) => rest);
  if (!same(identityOf(approved), identityOf(current))) changed.add("target");
  const preconditions = (p: LifecyclePlanV1) => p.targets.map((t) => [t.entryKey, t.precondition]);
  if (!same(preconditions(approved), preconditions(current))) changed.add("config-precondition");
  if (!same(approved.requiredEnv, current.requiredEnv)) changed.add("env-names");
  if (!same(approved.healthPolicy, current.healthPolicy)) changed.add("health-policy");
  if (!same(approved.steps, current.steps) || !same(approved.target.clientSpec, current.target.clientSpec) || approved.platform !== current.platform) changed.add("steps");
  if (changed.size === 0 && !same(approved, current)) changed.add("steps");
  return LIFECYCLE_PLAN_CHANGE_KINDS.filter((k) => changed.has(k));
}

// ---------------------------------------------------------------- Approval(공통 kernel)

const LIFECYCLE_PLAN_KIND: ApprovalPlanKind<LifecyclePlanV1, LifecycleApprovalRequirement, LifecyclePlanChange> = {
  kind: "lifecycle-plan-v1",
  parse: (plan) => {
    const parsed = lifecyclePlanSchema.safeParse(plan);
    return parsed.success ? parsed.data : null;
  },
  digest: lifecyclePlanDigest,
  status: (plan) => plan.status,
  executableStatus: "ready",
  requirements: (plan) => plan.approvalRequirements,
  knownRequirements: LIFECYCLE_APPROVAL_REQUIREMENTS,
  messages: LIFECYCLE_APPROVAL_MESSAGES,
  diff: diffLifecyclePlans,
  fallbackChange: "steps",
  staleMessage: "승인 후 lifecycle 계획이 바뀌었습니다. 다시 확인하고 승인하세요",
};

export type LifecycleApprovalRequest = KernelApprovalRequest<LifecyclePlanV1, LifecycleApprovalRequirement>;
export interface LifecycleApprovalPrompter {
  readonly channel: ApprovalChannel;
  confirm(request: LifecycleApprovalRequest): Promise<readonly LifecycleApprovalRequirement[] | "rejected">;
}
export type LifecycleApproval = KernelApproval<LifecycleApprovalRequirement>;
export type LifecycleApprovalOutcome = KernelApprovalOutcome<LifecycleApprovalRequirement>;
export type VerifiedLifecyclePlan = KernelVerified<LifecyclePlanV1, LifecycleApprovalRequirement>;
export type LifecycleGateFailure = KernelGateFailure<LifecycleApprovalRequirement, LifecyclePlanChange> & { cause?: LifecyclePlanErrorCode };

export function isVerifiedLifecyclePlan(value: unknown): value is VerifiedLifecyclePlan {
  return isKernelVerified(value, LIFECYCLE_PLAN_KIND.kind);
}

/** LifecyclePlan을 사람에게 보여 주고 Approval을 받는다. ready Plan만 승인할 수 있다(up-to-date·blocked·unsupported는 불가). */
export function requestLifecycleApproval(planned: PlannedLifecycle, prompter: LifecycleApprovalPrompter): Promise<LifecycleApprovalOutcome> {
  return requestKernelApproval(LIFECYCLE_PLAN_KIND, planned, prompter as KernelPrompter<LifecyclePlanV1, LifecycleApprovalRequirement>);
}

/** 실행 직전 검증. regenerate는 planLifecycle을 같은 옵션으로 다시 부른다(state·config·resolver 재조회). */
export async function verifyApprovedLifecyclePlan(
  approval: LifecycleApproval | undefined,
  regenerate: () => Promise<LifecyclePlanResult>,
): Promise<{ ok: true; verified: VerifiedLifecyclePlan } | LifecycleGateFailure> {
  let cause: { code: LifecyclePlanErrorCode; message: string } | undefined;
  const gate = await verifyKernelApproval(LIFECYCLE_PLAN_KIND, approval, async () => {
    const result = await regenerate();
    if (!result.ok) {
      cause = { code: result.code, message: result.message };
      throw new Error(result.code);
    }
    return result.planned;
  });
  if (!gate.ok && gate.code === "PLAN_REGENERATION_FAILED" && cause !== undefined) {
    return { ...gate, message: "실행 직전 Plan을 다시 만들지 못했습니다: " + cause.message, cause: cause.code };
  }
  return gate;
}

/** 검증을 통과했을 때만 effect(spawn·파일 쓰기)를 실행한다. 실패하면 effect는 한 번도 호출되지 않는다. */
export async function executeWithLifecycleApproval<T>(
  approval: LifecycleApproval | undefined,
  regenerate: () => Promise<LifecyclePlanResult>,
  effect: (verified: VerifiedLifecyclePlan) => Promise<T>,
): Promise<{ ok: true; value: T } | LifecycleGateFailure> {
  const gate = await verifyApprovedLifecyclePlan(approval, regenerate);
  if (!gate.ok) return gate;
  return { ok: true, value: await effect(gate.verified) };
}

