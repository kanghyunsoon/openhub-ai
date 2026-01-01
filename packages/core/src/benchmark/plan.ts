import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
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
import { nodeConfigFs, readConfiguredEntry, type ConfigFs } from "../installer/config-writer";
import { CONFIG_SCOPES, INSTALL_BACKENDS, INSTALL_CLIENTS, canonicalize, manifestDigest, registryDigestExcluding, sha256Digest, type ConfigScope, type InstallClient } from "../installer/plan";
import { RECOMMEND_PLATFORMS, TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, type RecommendPlatform } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { PROJECT_KEY_PATTERN, artifactIdentitySchema, entryKeyOf, type ToolState } from "../lifecycle/state";
import { configEntryDigest } from "../lifecycle/status";
import { projectKeyFor, readLifecycleState, type StateErrorCode } from "../lifecycle/store";

/**
 * BenchmarkPlan v1(TASK-065, D-032). 승인된 로컬 MCP Benchmark 계획. LifecyclePlan에 넣지 않고 공통 kernel의 종류 benchmark-plan-v1을 쓴다.
 * - 대상은 Version State로 관리되고 artifact.resolved가 있는 entry뿐이다. artifact-unlocked는 같은 artifact를 반복 실행한다는
 *   보장이 없어 blocker다. 미관리·config drift·mcp-handshake가 아닌 Health(Pinokio·HTTP 등)·launch와 artifact 불일치도 blocked다.
 * - launch는 Version State의 Client launch에서 M5 HealthStep 규칙(논리 executable + args, cmd wrapper 없음)으로 만든다.
 * - runs(warmup 1, measured 5)와 timeouts(startup 20s, handshake 10s, 회당 45s, Plan 300s)는 고정이며 옵션으로 바꿀 수 없다.
 * - 프로토콜은 initialize·notifications/initialized·tools/list뿐이다(tools/call 없음).
 * - network·spawn·write 0회(계획만). process.env를 읽지 않는다. Plan에 절대 경로·token이 없다.
 */

export const BENCHMARK_PLAN_SCHEMA_VERSION = 1;
export const BENCHMARK_PLAN_KIND = "openhub-benchmark-plan";
export const BENCHMARK_RUNS = Object.freeze({ warmup: 1, measured: 5 } as const);
export const BENCHMARK_TIMEOUTS = Object.freeze({ startupMs: 20_000, handshakeMs: 10_000, runTotalMs: 45_000, planTotalMs: 300_000 } as const);
export const BENCHMARK_METHODS = ["initialize", "notifications/initialized", "tools/list"] as const;
export const BENCHMARK_APPROVAL_REQUIREMENTS = ["base", "environment-unverified", "artifact-fetch"] as const;
export type BenchmarkApprovalRequirement = (typeof BENCHMARK_APPROVAL_REQUIREMENTS)[number];
export const BENCHMARK_BLOCKER_CODES = ["BENCHMARK_NOT_MANAGED", "BENCHMARK_ARTIFACT_UNLOCKED", "BENCHMARK_CONFIG_DRIFT", "BENCHMARK_UNSUPPORTED", "BENCHMARK_ARTIFACT_MISMATCH"] as const;
export type BenchmarkBlockerCode = (typeof BENCHMARK_BLOCKER_CODES)[number];
export const BENCHMARK_PLAN_CHANGE_KINDS = ["state", "artifact", "launch", "config", "registry", "manifest", "target"] as const;
export type BenchmarkPlanChange = (typeof BENCHMARK_PLAN_CHANGE_KINDS)[number];

export const BENCHMARK_NO_TOOL_CALL_NOTICE = "MCP 서버를 6번(준비 1 + 측정 5) 실행해 initialize·tools/list 응답 시간만 잽니다. MCP tool은 호출하지 않습니다(tools/call 0).";
export const BENCHMARK_APPROVAL_MESSAGES: Readonly<Record<BenchmarkApprovalRequirement, string>> = {
  base: "위 Benchmark 계획(MCP 서버를 격리된 임시 디렉터리에서 6번 실행, tool 호출 없음)을 확인했고 실행하는 데 동의합니다.",
  "environment-unverified": "이 도구는 실행에 환경변수가 필요하지만 OpenHub는 값이나 설정 여부를 확인하지 않습니다. 설정되지 않았다면 실행이 실패할 수 있습니다.",
  "artifact-fetch": "npx·uvx·docker가 고정된 artifact를 내려받을 수 있습니다(네트워크 사용).",
};

const text = z.string().min(1).max(300);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : [];

export const benchmarkPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(BENCHMARK_PLAN_SCHEMA_VERSION),
    kind: z.literal(BENCHMARK_PLAN_KIND),
    status: z.enum(["ready", "blocked"]),
    toolId: text,
    platform: z.enum(RECOMMEND_PLATFORMS),
    registryDigest: sha256,
    manifestDigest: sha256,
    target: z
      .strictObject({ client: z.enum(INSTALL_CLIENTS), scope: z.enum(CONFIG_SCOPES), file: text, serverName: text, projectKey: z.string().regex(PROJECT_KEY_PATTERN).nullable(), entryKey: z.string().min(1).max(400) })
      .nullable(),
    state: z.strictObject({ revision: z.number().int().min(1), entryDigest: sha256, appliedPlanDigest: sha256 }).nullable(),
    artifact: z.strictObject({ resolved: artifactIdentitySchema.nullable() }),
    launch: z.strictObject({ executable: z.enum(INSTALL_BACKENDS), args: z.array(text).min(1), envNames: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)), cwd: z.literal("isolated") }).nullable(),
    runs: z.strictObject({ warmup: z.literal(BENCHMARK_RUNS.warmup), measured: z.literal(BENCHMARK_RUNS.measured) }),
    timeouts: z.strictObject({
      startupMs: z.literal(BENCHMARK_TIMEOUTS.startupMs),
      handshakeMs: z.literal(BENCHMARK_TIMEOUTS.handshakeMs),
      runTotalMs: z.literal(BENCHMARK_TIMEOUTS.runTotalMs),
      planTotalMs: z.literal(BENCHMARK_TIMEOUTS.planTotalMs),
    }),
    protocol: z.strictObject({ methods: z.tuple([z.literal("initialize"), z.literal("notifications/initialized"), z.literal("tools/list")]) }),
    approvalRequirements: z.array(z.enum(BENCHMARK_APPROVAL_REQUIREMENTS)).min(1),
    blockers: z.array(z.strictObject({ code: z.enum(BENCHMARK_BLOCKER_CODES), message: z.string().min(1).max(400) })),
    effects: z.strictObject({ spawn: z.literal(6), configWrite: z.literal(0), stateWrite: z.literal(0), fileWrite: z.literal(0) }),
  })
  .superRefine((plan, ctx) => {
    if (plan.status === "ready" && (plan.blockers.length > 0 || plan.launch === null || plan.target === null || plan.state === null || plan.artifact.resolved === null)) {
      ctx.addIssue({ code: "custom", path: ["status"], message: "ready Plan은 blocker가 없고 target·state·고정 artifact·launch가 있어야 한다" });
    }
    if (plan.status === "blocked" && plan.blockers.length === 0) ctx.addIssue({ code: "custom", path: ["blockers"], message: "blocked Plan에는 blocker가 있다" });
    if (plan.launch !== null && plan.launch.args.some((a) => a === "/d" || a === "/c")) ctx.addIssue({ code: "custom", path: ["launch"], message: "cmd wrapper는 Benchmark launch에 쓰지 않는다" });
    for (const s of stringsOf(plan)) {
      if (containsAbsolutePath(s) || TOKEN_PATTERN.test(s) || URL_CREDENTIAL_PATTERN.test(s)) {
        ctx.addIssue({ code: "custom", path: [], message: "Plan에 절대 경로·token·credential URL이 있다" });
        break;
      }
    }
  });
export type BenchmarkPlanV1 = z.output<typeof benchmarkPlanSchema>;
export interface PlannedBenchmark {
  readonly plan: BenchmarkPlanV1;
  readonly planDigest: string;
}
export const benchmarkPlanDigest = (plan: BenchmarkPlanV1) => sha256Digest(JSON.stringify(canonicalize(plan)));
export const serializeBenchmarkPlan = (plan: BenchmarkPlanV1) => JSON.stringify(canonicalize(benchmarkPlanSchema.parse(plan)), null, 2) + "\n";

export interface BenchmarkPlanOptions {
  toolId: string;
  projectRoot: string;
  homeDir: string;
  entries: readonly RegistryEntry[];
  platform: RecommendPlatform;
  /** user scope Version State·config를 다룰지(D-003). */
  includeUser: boolean;
  client?: InstallClient;
  scope?: ConfigScope;
  fs?: ConfigFs;
}
export type BenchmarkPlanErrorCode = "TOOL_NOT_FOUND" | "BENCHMARK_TARGET_AMBIGUOUS" | StateErrorCode;
export type BenchmarkPlanResult = { ok: true; planned: PlannedBenchmark } | { ok: false; code: BenchmarkPlanErrorCode; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const argsOfClientSpec = (spec: { command: string; args: readonly string[] }) => (spec.command === "cmd" ? spec.args.slice(3) : [...spec.args]);

/** Version State·config·Registry를 읽어 BenchmarkPlan을 만든다. 실행 직전 재생성도 같은 함수를 쓴다(network·spawn·write 0). */
export async function planBenchmark(options: BenchmarkPlanOptions): Promise<BenchmarkPlanResult> {
  const fs = options.fs ?? nodeConfigFs;
  const registry = options.entries.filter((e): e is RegistryEntry => isRecord(e) && isRecord(e.manifest) && typeof e.manifest.name === "string" && isRecord(e.manifest.repository));
  const entry = registry.find((e) => e.manifest.name === options.toolId);
  if (entry === undefined) return { ok: false, code: "TOOL_NOT_FOUND", message: "Registry에 없는 Tool입니다" };
  const manifest = entry.manifest;
  const read = await readLifecycleState({ homeDir: options.homeDir, fs });
  if (!read.ok) return read;
  const projectKey = await projectKeyFor(options.projectRoot, fs);
  const userAllowed = options.includeUser || options.scope === "user";
  const managed = Object.values(read.state.entries)
    .filter((s) => s.toolId === options.toolId && (s.target.scope === "project" ? s.target.projectKey === projectKey : userAllowed))
    .filter((s) => (options.client === undefined || s.target.client === options.client) && (options.scope === undefined || s.target.scope === options.scope))
    .sort((a, b) => cmp(entryKeyOf(a.target), entryKeyOf(b.target)));
  if (managed.length > 1) return { ok: false, code: "BENCHMARK_TARGET_AMBIGUOUS", message: "관리 항목이 여러 개입니다. --client·--scope로 하나를 고르세요(" + managed.map((s) => s.target.client + ":" + s.target.scope).join(", ") + ")" };
  const state: ToolState | undefined = managed[0];

  const blockers: { code: BenchmarkBlockerCode; message: string }[] = [];
  if (manifest.healthCheck.type !== "mcp-handshake" || manifest.install.preferredAdapter === "pinokio") {
    blockers.push({ code: "BENCHMARK_UNSUPPORTED", message: "MCP stdio handshake로 확인하는 도구만 Benchmark할 수 있습니다(Pinokio·HTTP 등 제외)" });
  }
  let target: BenchmarkPlanV1["target"] = null;
  let stateOut: BenchmarkPlanV1["state"] = null;
  let launch: BenchmarkPlanV1["launch"] = null;
  if (state === undefined) {
    blockers.push({ code: "BENCHMARK_NOT_MANAGED", message: "Version State로 관리되는 항목이 없습니다(install 또는 adopt 후 Benchmark할 수 있습니다)" });
  } else {
    const t = state.target;
    target = { client: t.client, scope: t.scope, file: t.file, serverName: t.serverName, projectKey: t.projectKey, entryKey: entryKeyOf(t) };
    stateOut = { revision: state.revision, entryDigest: state.config.entryDigest, appliedPlanDigest: state.appliedPlanDigest };
    if (state.artifact.resolved === null) blockers.push({ code: "BENCHMARK_ARTIFACT_UNLOCKED", message: "artifact가 고정되어 있지 않아(artifact-unlocked) 같은 artifact를 반복 실행한다는 보장이 없습니다. 먼저 update로 고정하세요" });
    const current = await readConfiguredEntry(t.client, t.scope, t.serverName, { projectRoot: options.projectRoot, homeDir: options.homeDir, fs }).catch(() => undefined);
    if (current === undefined || configEntryDigest(current) !== state.config.entryDigest) {
      blockers.push({ code: "BENCHMARK_CONFIG_DRIFT", message: t.file + "의 " + t.serverName + " 항목이 Version State와 다릅니다(config-drift·missing-config)" });
    }
    const args = argsOfClientSpec(state.launch.clientSpec);
    if (state.artifact.resolved !== null && !args.includes(state.artifact.resolved.spec)) {
      blockers.push({ code: "BENCHMARK_ARTIFACT_MISMATCH", message: "실행 인자에 Version State의 고정 artifact가 없습니다" });
    }
    if (args.length > 0) launch = { executable: state.backend, args, envNames: manifest.env.filter((e) => e.required).map((e) => e.name).sort(), cwd: "isolated" };
  }
  const requirements: BenchmarkApprovalRequirement[] = ["base"];
  if (manifest.env.some((e) => e.required)) requirements.push("environment-unverified");
  if (state !== undefined) requirements.push("artifact-fetch");
  const plan = benchmarkPlanSchema.parse({
    schemaVersion: BENCHMARK_PLAN_SCHEMA_VERSION,
    kind: BENCHMARK_PLAN_KIND,
    status: blockers.length === 0 ? "ready" : "blocked",
    toolId: options.toolId,
    platform: options.platform,
    registryDigest: registryDigestExcluding(registry, options.toolId),
    manifestDigest: manifestDigest(manifest),
    target,
    state: stateOut,
    artifact: { resolved: state?.artifact.resolved ?? null },
    launch,
    runs: { ...BENCHMARK_RUNS },
    timeouts: { ...BENCHMARK_TIMEOUTS },
    protocol: { methods: [...BENCHMARK_METHODS] },
    approvalRequirements: requirements,
    blockers,
    effects: { spawn: 6, configWrite: 0, stateWrite: 0, fileWrite: 0 },
  });
  return { ok: true, planned: { plan, planDigest: benchmarkPlanDigest(plan) } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
export function diffBenchmarkPlans(approved: BenchmarkPlanV1, current: BenchmarkPlanV1): BenchmarkPlanChange[] {
  const changed = new Set<BenchmarkPlanChange>();
  if (!same(approved.state, current.state)) changed.add("state");
  if (!same(approved.artifact, current.artifact)) changed.add("artifact");
  if (!same(approved.launch, current.launch) || approved.platform !== current.platform) changed.add("launch");
  if (!same(approved.target, current.target)) changed.add("target");
  if (approved.registryDigest !== current.registryDigest) changed.add("registry");
  if (approved.manifestDigest !== current.manifestDigest) changed.add("manifest");
  if (!same(approved.blockers, current.blockers) && changed.size === 0) changed.add("config");
  if (changed.size === 0 && !same(approved, current)) changed.add("config");
  return BENCHMARK_PLAN_CHANGE_KINDS.filter((k) => changed.has(k));
}

const BENCHMARK_KIND: ApprovalPlanKind<BenchmarkPlanV1, BenchmarkApprovalRequirement, BenchmarkPlanChange> = {
  kind: "benchmark-plan-v1",
  parse: (plan) => {
    const parsed = benchmarkPlanSchema.safeParse(plan);
    return parsed.success ? parsed.data : null;
  },
  digest: benchmarkPlanDigest,
  status: (plan) => plan.status,
  executableStatus: "ready",
  requirements: (plan) => plan.approvalRequirements,
  knownRequirements: BENCHMARK_APPROVAL_REQUIREMENTS,
  messages: BENCHMARK_APPROVAL_MESSAGES,
  diff: diffBenchmarkPlans,
  fallbackChange: "config",
  staleMessage: "승인 후 Benchmark 계획이 바뀌었습니다(Version State·artifact·설정). 다시 확인하고 승인하세요",
};

export type BenchmarkApprovalRequest = KernelApprovalRequest<BenchmarkPlanV1, BenchmarkApprovalRequirement>;
export interface BenchmarkApprovalPrompter {
  readonly channel: ApprovalChannel;
  confirm(request: BenchmarkApprovalRequest): Promise<readonly BenchmarkApprovalRequirement[] | "rejected">;
}
export type BenchmarkApproval = KernelApproval<BenchmarkApprovalRequirement>;
export type BenchmarkApprovalOutcome = KernelApprovalOutcome<BenchmarkApprovalRequirement>;
export type VerifiedBenchmarkPlan = KernelVerified<BenchmarkPlanV1, BenchmarkApprovalRequirement>;
export type BenchmarkGateFailure = KernelGateFailure<BenchmarkApprovalRequirement, BenchmarkPlanChange> & { cause?: BenchmarkPlanErrorCode };

export function isVerifiedBenchmarkPlan(value: unknown): value is VerifiedBenchmarkPlan {
  return isKernelVerified(value, BENCHMARK_KIND.kind);
}
export function requestBenchmarkApproval(planned: PlannedBenchmark, prompter: BenchmarkApprovalPrompter): Promise<BenchmarkApprovalOutcome> {
  return requestKernelApproval(BENCHMARK_KIND, planned, prompter as KernelPrompter<BenchmarkPlanV1, BenchmarkApprovalRequirement>);
}
export async function verifyApprovedBenchmarkPlan(approval: BenchmarkApproval | undefined, regenerate: () => Promise<BenchmarkPlanResult>): Promise<{ ok: true; verified: VerifiedBenchmarkPlan } | BenchmarkGateFailure> {
  let cause: { code: BenchmarkPlanErrorCode; message: string } | undefined;
  const gate = await verifyKernelApproval(BENCHMARK_KIND, approval, async () => {
    const result = await regenerate();
    if (!result.ok) {
      cause = { code: result.code, message: result.message };
      throw new Error(result.code);
    }
    return result.planned;
  });
  if (!gate.ok && gate.code === "PLAN_REGENERATION_FAILED" && cause !== undefined) return { ...gate, message: "실행 직전 Benchmark 계획을 다시 만들지 못했습니다: " + cause.message, cause: cause.code };
  return gate;
}

/** Preview 줄(CLI·Desktop 공용). */
export function formatBenchmarkPlanPreview(planned: PlannedBenchmark): string[] {
  const p = planned.plan;
  const lines = ["Benchmark 계획: " + p.toolId + " (" + p.status + ")"];
  if (p.target !== null) lines.push("대상: " + p.target.client + " · " + p.target.scope + " · " + p.target.file + " · 서버 " + p.target.serverName);
  if (p.artifact.resolved !== null) lines.push("artifact(고정): " + p.artifact.resolved.spec);
  if (p.launch !== null) lines.push("실행: " + [p.launch.executable, ...p.launch.args].join(" ") + " (격리 임시 디렉터리, shell 없음)");
  lines.push("횟수: 준비 " + String(p.runs.warmup) + " + 측정 " + String(p.runs.measured) + " · 제한: 시작 20초 · handshake 10초 · 회당 45초 · 전체 300초");
  lines.push(BENCHMARK_NO_TOOL_CALL_NOTICE);
  lines.push("결과: median·min·max·실패 수(p95 없음, peak RSS 미측정). 이 PC에서만 의미가 있고 저장하지 않습니다.");
  for (const b of p.blockers) lines.push("차단: " + b.code + " — " + b.message);
  if (p.status === "ready") {
    lines.push("승인 요구:");
    for (const r of p.approvalRequirements) lines.push("  [" + r + "] " + BENCHMARK_APPROVAL_MESSAGES[r]);
  }
  lines.push("plan digest: " + planned.planDigest);
  return lines;
}

