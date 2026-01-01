import { APPROVAL_REQUIREMENTS, installPlanDigest, installPlanSchema, type ApprovalRequirement, type InstallPlanV1, type PlannedInstall } from "./plan";
import { diffInstallPlans, type PlanChange } from "./stale";

/**
 * Human Approval과 실행 직전 검증(TASK-028, D-012). §5 state model:
 *   generated → presented → rejected
 *                         → approved → verifying → stale(PLAN_STALE → 재승인)
 *                                                → executing(VerifiedPlan)
 * - Approval은 requestApproval()로만 생긴다. 사람에게 묻는 일은 앱이 구현한 ApprovalPrompter
 *   (CLI TTY, Desktop main process native dialog)가 한다. Core에는 사람 확인 없이 Approval을 만드는 API가 없고
 *   환경변수·설정 파일로 acknowledgement를 채우지 않는다(auto approve, --yes, --approve <digest> 금지).
 * - 객체 리터럴로 만든 Approval은 Core가 발급한 것이 아니므로 APPROVAL_REQUIRED다.
 * - Approval은 실행 시도 1회에 소모된다(PLAN_STALE이어도 소모, 재사용은 APPROVAL_CONSUMED).
 * - TASK-040(D-020): 승인·검증은 Plan 종류(schema·digest·승인 요구·diff)를 주입받는 공통 kernel이다.
 *   InstallPlan 경로는 이 kernel 위의 install 종류이며 동작·문구는 M4와 같다. 종류가 다른 Approval·VerifiedPlan은 서로의 gate를 통과하지 못한다.
 */

export const APPROVAL_CHANNELS = ["cli-tty", "desktop-native-dialog"] as const;
export type ApprovalChannel = (typeof APPROVAL_CHANNELS)[number];

/** CLI·Desktop이 함께 쓰는 추가 승인 문구. */
export const APPROVAL_REQUIREMENT_MESSAGES: Readonly<Record<ApprovalRequirement, string>> = {
  base: "위 설치 계획(실행 명령, 쓰는 설정 파일, 네트워크 사용)을 확인했고 이대로 실행하는 데 동의합니다.",
  "installation-unknown": "OpenHub가 이 도구의 설치 여부를 확인하지 못했습니다. 이미 설치되어 있을 수 있음을 알고 진행합니다.",
  "unidentified-present": "식별하지 못한 MCP 서버가 이미 설정되어 있습니다. 같은 도구가 중복 설정될 수 있음을 알고 진행합니다.",
  "user-scope-config": "프로젝트 밖의 사용자 설정 파일(홈 디렉터리)을 수정합니다. 다른 프로젝트에도 영향을 줍니다.",
  "fallback-backend": "Manifest가 우선 지정한 방식 대신 대체 backend로 설치합니다.",
  "floating-artifact": "원격 패키지 버전이 고정되어 있지 않습니다. 나중에 실행하면 다른 artifact가 내려올 수 있습니다.",
  "client-env-parse-risk": "Claude Code가 실행되는 환경에 필요한 환경변수를 직접 준비해야 합니다. OpenHub는 값이나 존재 여부를 확인하지 않습니다.",
};

// ---------------------------------------------------------------- 공통 kernel

/** kernel이 다루는 Plan 종류. Plan 내용·digest·승인 요구·변경 비교를 종류별로 주입한다. */
export interface ApprovalPlanKind<P, R extends string, C extends string> {
  readonly kind: string;
  readonly parse: (plan: unknown) => P | null;
  readonly digest: (plan: P) => string;
  readonly status: (plan: P) => string;
  readonly executableStatus: string;
  readonly requirements: (plan: P) => readonly R[];
  readonly knownRequirements: readonly R[];
  readonly messages: Readonly<Record<R, string>>;
  readonly diff: (approved: P, current: P) => C[];
  readonly fallbackChange: C;
  readonly staleMessage: string;
}

export interface KernelPlanned<P> {
  readonly plan: P;
  readonly planDigest: string;
}
export interface KernelApprovalRequest<P, R extends string> {
  readonly planned: KernelPlanned<P>;
  readonly requirements: readonly { readonly id: R; readonly message: string }[];
}
export interface KernelPrompter<P, R extends string> {
  readonly channel: ApprovalChannel;
  confirm(request: KernelApprovalRequest<P, R>): Promise<readonly R[] | "rejected">;
}
export interface KernelApproval<R extends string> {
  readonly planDigest: string;
  readonly acknowledgements: readonly R[];
  readonly channel: ApprovalChannel;
}
export type KernelApprovalOutcome<R extends string> =
  | { status: "approved"; approval: KernelApproval<R> }
  | { status: "rejected" }
  | { status: "not-approvable"; code: "PLAN_NOT_EXECUTABLE" | "PLAN_INVALID"; message: string };
export interface KernelVerified<P, R extends string> {
  readonly plan: P;
  readonly planDigest: string;
  readonly acknowledgements: readonly R[];
  readonly channel: ApprovalChannel;
}

export type ExecutionGateCode = "APPROVAL_REQUIRED" | "APPROVAL_INCOMPLETE" | "APPROVAL_CONSUMED" | "PLAN_STALE" | "PLAN_NOT_EXECUTABLE" | "PLAN_REGENERATION_FAILED";
export interface KernelGateFailure<R extends string, C extends string> {
  ok: false;
  code: ExecutionGateCode;
  message: string;
  changed?: C[];
  missing?: R[];
}

interface IssuedApproval {
  kind: string;
  plan: unknown;
  consumed: boolean;
}
const issued = new WeakMap<object, IssuedApproval>();
const verifiedKinds = new WeakMap<object, string>();

/** kernel이 발급한 VerifiedPlan인지(종류까지) 확인한다. */
export function isKernelVerified(value: unknown, kind: string): boolean {
  return typeof value === "object" && value !== null && verifiedKinds.get(value) === kind;
}

/** Plan을 사람에게 보여 주고 Approval을 받는다. 실행 가능한 status의 Plan만 승인할 수 있다. */
export async function requestKernelApproval<P, R extends string, C extends string>(
  kind: ApprovalPlanKind<P, R, C>,
  planned: KernelPlanned<P>,
  prompter: KernelPrompter<P, R>,
): Promise<KernelApprovalOutcome<R>> {
  const parsed = kind.parse(planned.plan);
  if (parsed === null || kind.digest(parsed) !== planned.planDigest) {
    return { status: "not-approvable", code: "PLAN_INVALID", message: "Plan과 planDigest가 일치하지 않습니다" };
  }
  if (kind.status(parsed) !== kind.executableStatus) {
    return { status: "not-approvable", code: "PLAN_NOT_EXECUTABLE", message: "실행할 수 없는 Plan입니다(" + kind.status(parsed) + ")" };
  }
  if (!(APPROVAL_CHANNELS as readonly string[]).includes(prompter.channel)) {
    return { status: "not-approvable", code: "PLAN_INVALID", message: "지원하지 않는 승인 채널입니다" };
  }
  const requirements = kind.requirements(parsed).map((id) => Object.freeze({ id, message: kind.messages[id] }));
  const answer = await prompter.confirm(Object.freeze({ planned: { plan: structuredClone(parsed), planDigest: planned.planDigest }, requirements: Object.freeze(requirements) }));
  if (answer === "rejected" || !Array.isArray(answer)) return { status: "rejected" };
  const answered = new Set(answer.filter((a): a is R => (kind.knownRequirements as readonly string[]).includes(a)));
  const acknowledged = kind.knownRequirements.filter((r) => answered.has(r));
  if (!acknowledged.includes("base" as R)) return { status: "rejected" };
  const approval: KernelApproval<R> = Object.freeze({ planDigest: planned.planDigest, acknowledgements: Object.freeze(acknowledged), channel: prompter.channel });
  issued.set(approval, { kind: kind.kind, plan: structuredClone(parsed), consumed: false });
  return { status: "approved", approval };
}

/**
 * 실행 직전 검증. Approval 확인(종류 포함) → 소모 → 같은 입력으로 Plan 재생성 → digest 비교.
 * regenerate는 Plan의 모든 입력을 다시 읽어 Plan을 만든다.
 */
export async function verifyKernelApproval<P, R extends string, C extends string>(
  kind: ApprovalPlanKind<P, R, C>,
  approval: KernelApproval<R> | undefined,
  regenerate: () => KernelPlanned<P> | Promise<KernelPlanned<P>>,
): Promise<{ ok: true; verified: KernelVerified<P, R> } | KernelGateFailure<R, C>> {
  const state = approval === undefined ? undefined : issued.get(approval);
  if (approval === undefined || state === undefined || state.kind !== kind.kind) return { ok: false, code: "APPROVAL_REQUIRED", message: "사람이 승인한 Approval이 없습니다" };
  if (state.consumed) return { ok: false, code: "APPROVAL_CONSUMED", message: "이미 사용한 Approval입니다. 다시 승인하세요" };
  state.consumed = true;

  const approved = state.plan as P;
  const required = kind.requirements(approved);
  const missing = required.filter((r) => !approval.acknowledgements.includes(r));
  const extra = approval.acknowledgements.filter((a) => !required.includes(a));
  if (missing.length > 0 || extra.length > 0) {
    return { ok: false, code: "APPROVAL_INCOMPLETE", message: "추가 승인 요구를 모두 확인하지 않았습니다", missing: [...missing] };
  }

  let current: KernelPlanned<P>;
  try {
    current = await regenerate();
  } catch {
    return { ok: false, code: "PLAN_REGENERATION_FAILED", message: "실행 직전 Plan을 다시 만들지 못했습니다" };
  }
  const reparsed = kind.parse(current.plan);
  const currentDigest = reparsed === null ? "" : kind.digest(reparsed);
  if (reparsed === null || currentDigest !== approval.planDigest || current.planDigest !== approval.planDigest) {
    const changed = reparsed === null ? [] : kind.diff(approved, reparsed);
    return { ok: false, code: "PLAN_STALE", message: kind.staleMessage, changed: changed.length > 0 ? changed : [kind.fallbackChange] };
  }
  if (kind.status(reparsed) !== kind.executableStatus) return { ok: false, code: "PLAN_NOT_EXECUTABLE", message: "실행할 수 없는 Plan입니다" };

  const verified: KernelVerified<P, R> = Object.freeze({ plan: reparsed, planDigest: currentDigest, acknowledgements: approval.acknowledgements, channel: approval.channel });
  verifiedKinds.set(verified, kind.kind);
  return { ok: true, verified };
}

// ---------------------------------------------------------------- InstallPlan 종류(M4 계약 유지)

const INSTALL_PLAN_KIND: ApprovalPlanKind<InstallPlanV1, ApprovalRequirement, PlanChange> = {
  kind: "install-plan-v1",
  parse: (plan) => {
    const parsed = installPlanSchema.safeParse(plan);
    return parsed.success ? parsed.data : null;
  },
  digest: installPlanDigest,
  status: (plan) => plan.status,
  executableStatus: "installable",
  requirements: (plan) => plan.approvalRequirements,
  knownRequirements: APPROVAL_REQUIREMENTS,
  messages: APPROVAL_REQUIREMENT_MESSAGES,
  diff: diffInstallPlans,
  fallbackChange: "steps",
  staleMessage: "승인 후 설치 계획이 바뀌었습니다. 다시 확인하고 승인하세요",
};

export type ApprovalRequest = KernelApprovalRequest<InstallPlanV1, ApprovalRequirement> & { readonly planned: PlannedInstall };

/** 사람에게 Plan을 보여 주고 각 요구를 확인받는 앱 쪽 구현. 반환값은 사람이 직접 확인한 요구 목록이다. */
export interface ApprovalPrompter {
  readonly channel: ApprovalChannel;
  confirm(request: ApprovalRequest): Promise<readonly ApprovalRequirement[] | "rejected">;
}

export type InstallApproval = KernelApproval<ApprovalRequirement>;
export type ApprovalOutcome = KernelApprovalOutcome<ApprovalRequirement>;

/** 실행 직전 검증을 통과한 Plan. Executor는 이 객체만 받는다(TASK-031). */
export type VerifiedPlan = KernelVerified<InstallPlanV1, ApprovalRequirement>;

export function isVerifiedPlan(value: unknown): value is VerifiedPlan {
  return isKernelVerified(value, INSTALL_PLAN_KIND.kind);
}

/** Plan을 사람에게 보여 주고 Approval을 받는다. installable Plan만 승인할 수 있다. */
export function requestApproval(planned: PlannedInstall, prompter: ApprovalPrompter): Promise<ApprovalOutcome> {
  return requestKernelApproval(INSTALL_PLAN_KIND, planned, prompter as KernelPrompter<InstallPlanV1, ApprovalRequirement>);
}

export type ExecutionGateFailure = KernelGateFailure<ApprovalRequirement, PlanChange>;

/**
 * 실행 직전 검증. Approval 확인 → 소모 → 같은 입력으로 Plan 재생성 → digest 비교.
 * regenerate는 Registry·Manifest·analyzeProject·recommend·probe·대상 config digest를 다시 읽어 Plan을 만든다.
 */
export function verifyApprovedPlan(
  approval: InstallApproval | undefined,
  regenerate: () => PlannedInstall | Promise<PlannedInstall>,
): Promise<{ ok: true; verified: VerifiedPlan } | ExecutionGateFailure> {
  return verifyKernelApproval(INSTALL_PLAN_KIND, approval, regenerate);
}

/** 검증을 통과했을 때만 effect(spawn·파일 쓰기)를 실행한다. 실패하면 effect는 한 번도 호출되지 않는다. */
export async function executeWithApproval<T>(
  approval: InstallApproval | undefined,
  regenerate: () => PlannedInstall | Promise<PlannedInstall>,
  effect: (verified: VerifiedPlan) => Promise<T>,
): Promise<{ ok: true; value: T } | ExecutionGateFailure> {
  const gate = await verifyApprovedPlan(approval, regenerate);
  if (!gate.ok) return gate;
  return { ok: true, value: await effect(gate.verified) };
}

