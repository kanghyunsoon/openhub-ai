import { createHash } from "node:crypto";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import type { Manifest } from "../manifest/index";
import type { RegistryEntry } from "../registry/index";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, type RecommendationReport } from "../recommendation/index";

/**
 * Immutable InstallPlan v1(TASK-027, D-012).
 * Recommendation은 승인이 아니다. 실행은 이 Plan의 canonical digest를 사람이 승인한 뒤,
 * 실행 직전 같은 입력으로 다시 만든 Plan의 digest가 같을 때만 허용된다.
 * - 같은 입력이면 byte가 같다(키 정렬, 시각 없음). 원격 artifact의 byte 동일성은 보장하지 않는다(floating-artifact).
 * - env는 이름만 있고 status는 항상 "unchecked"다(D-014). Plan을 만들 때 process.env를 읽지 않는다.
 * - 절대 경로·token·URL credential이 들어가면 schema가 거부한다. config 대상은 논리 경로(.mcp.json, ~/.cursor/mcp.json)다.
 */

export const INSTALL_PLAN_SCHEMA_VERSION = 1;
export const INSTALL_BACKENDS = ["npx", "uvx", "docker"] as const;
export type InstallBackend = (typeof INSTALL_BACKENDS)[number];
export const INSTALL_CLIENTS = ["claude-code", "codex", "cursor"] as const;
export type InstallClient = (typeof INSTALL_CLIENTS)[number];
export const CONFIG_SCOPES = ["project", "user"] as const;
export type ConfigScope = (typeof CONFIG_SCOPES)[number];
export const APPROVAL_REQUIREMENTS = [
  "base",
  "installation-unknown",
  "unidentified-present",
  "user-scope-config",
  "fallback-backend",
  "floating-artifact",
  "client-env-parse-risk",
] as const;
export type ApprovalRequirement = (typeof APPROVAL_REQUIREMENTS)[number];
export const PLAN_STATUSES = ["installable", "already-installed", "unsupported", "blocked"] as const;
export const ENV_REFERENCE_STYLES = ["claude-dollar-brace", "cursor-env", "codex-env-vars", "manual"] as const;
export type EnvReferenceStyle = (typeof ENV_REFERENCE_STYLES)[number];
export const PLAN_INSTALLATION_STATUSES = ["not-installed", "unidentified-present", "unknown", "installed"] as const;
export type PlanInstallationStatus = (typeof PLAN_INSTALLATION_STATUSES)[number];
export const PROBE_STATUSES = ["ok", "not-found", "timeout", "error", "shim-not-executed"] as const;

/** Plan Preview 고정 문구(§8, §9). */
export const FLOATING_ARTIFACT_NOTICE =
  "이 설치 계획은 실행 명령과 설정을 고정하지만, 원격 패키지 내용 자체는 고정하지 않습니다. 동일한 계획을 나중에 실행하면 다른 artifact가 내려올 수 있습니다.";
export function requiredEnvNotice(name: string): string {
  return `이 도구는 실행 시 ${name} 환경변수가 필요합니다. OpenHub는 값이나 설정 여부를 확인하거나 저장하지 않습니다.`;
}
export function clientEnvParseRiskNotice(names: readonly string[]): string {
  return `Claude Code가 실행되는 환경에 ${names.join(", ")} 환경변수를 준비해야 합니다. OpenHub는 값이나 존재 여부를 확인하지 않으며, 준비되지 않으면 .mcp.json 해석에 영향을 줄 수 있습니다.`;
}

const text = z.string().min(1).max(300);
const envName = z.string().regex(/^[A-Z][A-Z0-9_]*$/u);

export const serverEntrySchema = z.strictObject({
  command: z.string().min(1).max(40),
  args: z.array(text),
  env: z.record(envName, z.string().min(1).max(200)).optional(),
  env_vars: z.array(envName).optional(),
});
export type ServerEntry = z.output<typeof serverEntrySchema>;

export const runStepSchema = z.strictObject({
  id: text,
  kind: z.literal("run"),
  executable: z.literal("docker"),
  args: z.array(text).min(1),
  cwd: z.enum(["project", "isolated"]),
  network: z.boolean(),
  timeoutMs: z.number().int().positive(),
});
export type RunStep = z.output<typeof runStepSchema>;

export const configPatchStepSchema = z.strictObject({
  id: text,
  kind: z.literal("config-patch"),
  client: z.enum(INSTALL_CLIENTS),
  scope: z.enum(CONFIG_SCOPES),
  file: text,
  path: z.array(text).min(2),
  value: serverEntrySchema,
});
export type ConfigPatchStep = z.output<typeof configPatchStepSchema>;

export const probeSnapshotSchema = z.strictObject({
  name: text,
  available: z.union([z.boolean(), z.literal("unknown")]),
  version: z.string().max(40).nullable(),
  status: z.enum(PROBE_STATUSES),
});
export type ProbeSnapshot = z.output<typeof probeSnapshotSchema>;

const preconditionSchema = z.strictObject({
  exists: z.boolean(),
  fileDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u).nullable(),
  keyAbsent: z.boolean(),
});

const targetSchema = z.strictObject({
  client: z.enum(INSTALL_CLIENTS),
  scope: z.enum(CONFIG_SCOPES),
  file: text,
  serverName: text,
  precondition: preconditionSchema,
  envReference: z.enum(ENV_REFERENCE_STYLES),
});
export type PlanTarget = z.output<typeof targetSchema>;

const strings = (value: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
};

export const installPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(INSTALL_PLAN_SCHEMA_VERSION),
    operation: z.literal("install"),
    status: z.enum(PLAN_STATUSES),
    toolId: text,
    displayName: text,
    source: z.strictObject({
      registryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      manifestDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      recommendation: z.strictObject({
        installationStatus: z.enum(PLAN_INSTALLATION_STATUSES),
        inspectedScopes: z.array(z.enum(CONFIG_SCOPES)).min(1),
        primaryCapability: text.nullable(),
      }),
    }),
    backend: z
      .strictObject({
        adapter: z.enum(INSTALL_BACKENDS),
        selection: z.enum(["preferred", "fallback"]),
        skipped: z.array(z.strictObject({ adapter: text, reason: text })),
        probe: probeSnapshotSchema,
      })
      .nullable(),
    artifact: z
      .strictObject({
        kind: z.enum(["npm-package", "python-package", "container-image"]),
        spec: text,
        pinned: z.boolean(),
        preparation: z.enum(["launch-on-demand", "pull"]),
      })
      .nullable(),
    launch: z
      .strictObject({
        /** Client가 실행될 플랫폼(D-016). */
        platform: z.enum(["windows", "macos", "linux"]),
        /** backend 기준 실행 파일과 검증된 인자. */
        executable: z.enum(INSTALL_BACKENDS),
        args: z.array(text),
        envNames: z.array(envName),
        /** 플랫폼 변환 후 Client config에 실제로 기록될 command/args(Preview도 이 값을 보여 준다). */
        clientSpec: z.strictObject({ command: z.enum(["npx", "uvx", "docker", "cmd"]), args: z.array(text) }),
      })
      .nullable(),
    targets: z.array(targetSchema),
    steps: z.array(z.discriminatedUnion("kind", [runStepSchema, configPatchStepSchema])),
    requiredEnv: z.array(z.strictObject({ name: envName, required: z.boolean(), status: z.literal("unchecked") })),
    sideEffects: z.array(z.enum(["network", "download", "file-write"])),
    warnings: z.array(z.strictObject({ code: text, message: z.string().min(1).max(400) })),
    approvalRequirements: z.array(z.enum(APPROVAL_REQUIREMENTS)).min(1),
  })
  .superRefine((plan, ctx) => {
    const launch = plan.launch;
    if (launch !== null) {
      // D-016: cmd wrapper는 windows + npx에서 고정 prefix로만 생긴다. 그 밖에는 backend 그대로다.
      const expected =
        launch.platform === "windows" && launch.executable === "npx" ? ["cmd", "/d", "/c", "npx", ...launch.args] : [launch.executable, ...launch.args];
      if (JSON.stringify([launch.clientSpec.command, ...launch.clientSpec.args]) !== JSON.stringify(expected)) {
        ctx.addIssue({ code: "custom", path: ["launch", "clientSpec"], message: "clientSpec이 플랫폼별 launch 규칙(D-016)과 다릅니다" });
      }
    }
    for (const found of strings(plan)) {
      const problem = containsAbsolutePath(found.value)
        ? "절대 경로"
        : URL_CREDENTIAL_PATTERN.test(found.value)
          ? "URL credential"
          : TOKEN_PATTERN.test(found.value)
            ? "token"
            : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: `InstallPlan에 ${problem}이(가) 포함될 수 없습니다` });
    }
  });
export type InstallPlanV1 = z.output<typeof installPlanSchema>;

/** Plan과 그 canonical digest. digest는 Plan 내용만으로 계산하며 승인 시각 등은 포함하지 않는다. */
export interface PlannedInstall {
  plan: InstallPlanV1;
  planDigest: string;
}

// ---------------------------------------------------------------- canonical JSON

/** 키를 정렬하고 undefined를 제거한 사본. 배열 순서는 유지한다(배열은 만들 때 정렬한다). */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, v]) => [k, canonicalize(v)]),
    );
  }
  return value;
}

export function sha256Digest(text: string): string {
  return `sha256:${createHash("sha256").update(text).digest("hex")}`;
}

export function installPlanDigest(plan: InstallPlanV1): string {
  return sha256Digest(JSON.stringify(canonicalize(plan)));
}

/** 사람이 읽고 비교하는 안정 직렬화(키 정렬, 2칸 들여쓰기, 끝 개행). */
export function serializeInstallPlan(plan: InstallPlanV1): string {
  return JSON.stringify(canonicalize(installPlanSchema.parse(plan)), null, 2) + "\n";
}

export function manifestDigest(manifest: Manifest): string {
  return sha256Digest(JSON.stringify(canonicalize(manifest)));
}

/** 설치 대상 Tool을 제외한 Registry 나머지의 digest(대상 Manifest 변경은 manifestDigest가 잡는다). */
export function registryDigestExcluding(entries: readonly RegistryEntry[], toolId: string): string {
  const others = entries
    .filter((e) => e.manifest.name !== toolId)
    .map((e) => e.manifest)
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return sha256Digest(JSON.stringify(canonicalize(others)));
}

// ---------------------------------------------------------------- 조립

export interface PlanBlocker {
  code: string;
  message: string;
}

export interface PlanTargetInput {
  client: InstallClient;
  scope: ConfigScope;
  /** 논리 경로. 쓸 수 없는 대상(Claude Code user)은 envReference "manual"이다. */
  file: string;
  envReference: EnvReferenceStyle;
  precondition: { exists: boolean; fileDigest: string | null; keyAbsent: boolean };
}

export interface PlanAssemblyInput {
  toolId: string;
  manifest: Manifest;
  report: RecommendationReport;
  registryDigest: string;
  backend: InstallPlanV1["backend"];
  artifact: InstallPlanV1["artifact"];
  launch: InstallPlanV1["launch"];
  preparation: RunStep[];
  targets: PlanTargetInput[];
  blockers: PlanBlocker[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const CLIENT_ORDER: Readonly<Record<InstallClient, number>> = { "claude-code": 0, codex: 1, cursor: 2 };
const SCOPE_ORDER: Readonly<Record<ConfigScope, number>> = { project: 0, user: 1 };

/** RecommendationReport에서 이 Tool의 설치 상태를 읽는다(M3 규칙과 같다). */
export function installationStatusFromReport(report: RecommendationReport, toolId: string): PlanInstallationStatus {
  if (report.installedTools.some((t) => t.toolId === toolId && t.resolution === "resolved" && t.strength !== "weak")) return "installed";
  const rec = report.recommendations.find((r) => r.toolId === toolId);
  if (rec !== undefined) return rec.installation.status;
  const status = (id: string) => report.assessment.coverage.find((c) => c.detector === id)?.status;
  const weak = report.installedTools.some((t) => t.toolId === toolId && t.resolution === "resolved" && t.strength === "weak");
  if (status("ai-environment") !== "ok" || status("host-probe") === "partial" || weak) return "unknown";
  if (report.assessment.unresolvedInstalledTools > 0) return "unidentified-present";
  return "not-installed";
}

/** Client별 MCP 서버 항목(공식 env 참조만). M5 Version State·drift 판정도 같은 함수로 표준 항목을 계산한다. */
export function serverEntry(client: InstallClient, launch: NonNullable<InstallPlanV1["launch"]>, requiredNames: readonly string[]): ServerEntry {
  const base = { command: launch.clientSpec.command, args: [...launch.clientSpec.args] };
  if (requiredNames.length === 0) return base;
  if (client === "codex") return { ...base, env_vars: [...requiredNames] };
  const ref = (name: string) => (client === "cursor" ? `${"$"}{env:${name}}` : `${"$"}{${name}}`);
  return { ...base, env: Object.fromEntries(requiredNames.map((n) => [n, ref(n)])) };
}

/** Router 결과(backend 선택·fallback·불가 사유, REQ-030)를 InstallPlan v1 계약(REQ-034)으로 조립한다. */
export function assembleInstallPlan(input: PlanAssemblyInput): PlannedInstall {
  const { toolId, manifest, report } = input;
  const installationStatus = installationStatusFromReport(report, toolId);
  const rec = report.recommendations.find((r) => r.toolId === toolId);
  const alias = manifest.recommendation?.identity?.mcpServerNames?.[0];
  const requiredEnv = [...manifest.env]
    .map((e) => ({ name: e.name, required: e.required, status: "unchecked" as const }))
    .sort((a, b) => cmp(a.name, b.name));
  const requiredNames = requiredEnv.filter((e) => e.required).map((e) => e.name);

  const blockers = [...input.blockers];
  if (alias === undefined) blockers.push({ code: "NO_CANONICAL_ALIAS", message: "Registry에 canonical MCP alias가 없어 Client 설정을 만들 수 없습니다" });
  const targets: PlanTarget[] = [...input.targets]
    .sort((a, b) => CLIENT_ORDER[a.client] - CLIENT_ORDER[b.client] || SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope])
    .map((t) => ({ client: t.client, scope: t.scope, file: t.file, serverName: alias ?? toolId, precondition: { ...t.precondition }, envReference: t.envReference }));
  for (const t of targets) {
    if (t.envReference !== "manual" && !t.precondition.keyAbsent) {
      blockers.push({ code: "CONFIG_KEY_EXISTS", message: `${t.file}에 이미 ${t.serverName} 항목이 있습니다` });
    }
  }

  const installed = installationStatus === "installed";
  const status: InstallPlanV1["status"] = installed
    ? "already-installed"
    : blockers.some((b) => b.code === "UNSUPPORTED_BACKEND")
      ? "unsupported"
      : blockers.length > 0 || input.backend === null
        ? "blocked"
        : "installable";

  const steps: InstallPlanV1["steps"] = [];
  if (!installed && input.launch !== null) {
    steps.push(...input.preparation.map((s) => ({ ...s, args: [...s.args] })));
    for (const t of targets) {
      if (t.envReference === "manual") continue;
      steps.push({
        id: `config-${t.client}-${t.scope}`,
        kind: "config-patch",
        client: t.client,
        scope: t.scope,
        file: t.file,
        path: [t.client === "codex" ? "mcp_servers" : "mcpServers", t.serverName],
        value: serverEntry(t.client, input.launch, requiredNames),
      });
    }
  }

  const approvalRequirements = new Set<ApprovalRequirement>(["base"]);
  if (!installed) {
    if (installationStatus === "unknown") approvalRequirements.add("installation-unknown");
    if (installationStatus === "unidentified-present") approvalRequirements.add("unidentified-present");
    if (targets.some((t) => t.scope === "user" && t.envReference !== "manual")) approvalRequirements.add("user-scope-config");
    if (input.backend?.selection === "fallback") approvalRequirements.add("fallback-backend");
    if (input.artifact !== null && !input.artifact.pinned) approvalRequirements.add("floating-artifact");
    if (requiredNames.length > 0 && targets.some((t) => t.client === "claude-code" && t.envReference !== "manual")) approvalRequirements.add("client-env-parse-risk");
  }

  const warnings: InstallPlanV1["warnings"] = blockers.map((b) => ({ code: b.code, message: b.message }));
  if (!installed) {
    if (input.artifact !== null && !input.artifact.pinned) warnings.push({ code: "floating-artifact", message: FLOATING_ARTIFACT_NOTICE });
    if (input.backend?.adapter === "docker") warnings.push({ code: "docker-daemon-unchecked", message: "docker 데몬 연결 여부는 확인하지 않았습니다. 데몬이 꺼져 있으면 준비 단계가 실패합니다" });
    for (const name of requiredNames) warnings.push({ code: "required-env", message: requiredEnvNotice(name) });
    if (approvalRequirements.has("client-env-parse-risk")) warnings.push({ code: "client-env-parse-risk", message: clientEnvParseRiskNotice(requiredNames) });
    for (const t of targets.filter((x) => x.envReference === "manual")) {
      warnings.push({ code: "manual-setup-required", message: `${t.client} ${t.scope} 설정(${t.file})은 OpenHub가 쓰지 않습니다. 직접 설정해야 합니다` });
    }
  }
  warnings.sort((a, b) => cmp(a.code, b.code) || cmp(a.message, b.message));

  const sideEffects = new Set<"network" | "download" | "file-write">();
  for (const s of steps) {
    if (s.kind === "run") {
      sideEffects.add("network");
      sideEffects.add("download");
    } else sideEffects.add("file-write");
  }

  const plan: InstallPlanV1 = {
    schemaVersion: INSTALL_PLAN_SCHEMA_VERSION,
    operation: "install",
    status,
    toolId,
    displayName: manifest.displayName ?? manifest.name,
    source: {
      registryDigest: input.registryDigest,
      manifestDigest: manifestDigest(manifest),
      recommendation: {
        installationStatus,
        inspectedScopes: [...new Set(report.assessment.inspectedScopes)].sort((a, b) => SCOPE_ORDER[a] - SCOPE_ORDER[b]),
        primaryCapability: rec?.primaryCapability ?? null,
      },
    },
    backend: input.backend === null ? null : { ...input.backend, skipped: input.backend.skipped.map((s) => ({ ...s })), probe: { ...input.backend.probe } },
    artifact: installed || input.artifact === null ? null : { ...input.artifact },
    launch:
      installed || input.launch === null
        ? null
        : {
            platform: input.launch.platform,
            executable: input.launch.executable,
            args: [...input.launch.args],
            envNames: [...requiredNames],
            clientSpec: { command: input.launch.clientSpec.command, args: [...input.launch.clientSpec.args] },
          },
    targets,
    steps,
    requiredEnv,
    sideEffects: [...sideEffects].sort(cmp),
    warnings,
    approvalRequirements: APPROVAL_REQUIREMENTS.filter((r) => approvalRequirements.has(r)),
  };
  const parsed = installPlanSchema.parse(plan);
  return { plan: parsed, planDigest: installPlanDigest(parsed) };
}
