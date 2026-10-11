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
  type KernelPrompter,
  type KernelVerified,
} from "../installer/approval-v1";
import { configTargetFor, nodeConfigFs, readConfiguredEntry, type ConfigFs } from "../installer/config-writer";
import { CONFIG_SCOPES, INSTALL_CLIENTS, canonicalize, sha256Digest } from "../installer/plan";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";
import { replaceConfigEntry } from "./config-replace";
import { JOURNAL_OPERATIONS, claimJournal, claimedByLiveRecovery, damagedJournalMessage, journalDigest, readJournals, releaseJournalClaim, removeJournal, type JournalV1 } from "./journal";
import { configEntryDigest } from "./status";
import { projectKeyFor, readLifecycleState, withOperationLock } from "./store";

/**
 * (v0.2.1 P0-3) 중간에 끝난 Lifecycle 작업(Journal)의 승인 기반 복구. RecoveryPlan v1은 LifecyclePlan v1과 별개이고 승인은 공통 kernel의
 * 새 종류 recovery-plan-v1이다. 자동 복구는 없다.
 * - undo: 대상 항목이 Journal의 "변경 후" digest와 정확히 같을 때만 "변경 전" 항목으로 되돌린다(항목 하나만 교체, 나머지 byte 유지).
 *   Version State는 바꾸지 않는다(작업이 commit하지 못했으므로 기록은 이미 변경 전이다). 끝나면 Journal을 지운다.
 * - discard: 모든 대상이 이미 "변경 전"과 같거나(설정을 바꾸기 전에 끝남·이미 되돌림), 작업이 끝까지 완료되어(설정과 Version State가
 *   모두 "변경 후") Journal 정리만 못 했을 때 Journal만 지운다.
 * - 그 밖(외부 변경·항목 없음·Version State가 그 사이 바뀜·되돌릴 자료 없음·tool config 작업)은 blocked이고 아무것도 쓰지 않는다.
 * - 읽을 수 없는(손상된) Journal이 하나라도 있으면 계획하지 않는다(JOURNAL_DAMAGED). 손상 파일은 지우지 않는다.
 * - 실행은 작업 잠금(operation.lock) 안에서 한다. 다른 OpenHub 작업이 진행 중이면 OPERATION_IN_PROGRESS이고 아무것도 바꾸지 않는다.
 * - 계획은 network·spawn·write 0회. Plan에 절대 경로·token·env 값이 없다.
 */

export const RECOVERY_PLAN_KIND = "openhub-recovery-plan";
export const RECOVERY_MODES = ["undo", "discard"] as const;
export type RecoveryMode = (typeof RECOVERY_MODES)[number];
export const RECOVERY_APPROVAL_REQUIREMENTS = ["base", "user-scope-config"] as const;
export type RecoveryApprovalRequirement = (typeof RECOVERY_APPROVAL_REQUIREMENTS)[number];
export const RECOVERY_CHANGE_KINDS = ["journal", "config", "state"] as const;
export type RecoveryChange = (typeof RECOVERY_CHANGE_KINDS)[number];
export const RECOVERY_TARGET_STATES = ["after", "before", "other", "missing"] as const;

export const RECOVERY_APPROVAL_MESSAGES: Readonly<Record<RecoveryApprovalRequirement, string>> = {
  base: "위 복구 계획(중간에 끝난 작업의 설정 항목을 변경 전으로 되돌리거나 작업 기록만 지움)을 확인했고 실행하는 데 동의합니다. 지금 항목이 OpenHub가 쓰다 만 내용과 정확히 같을 때만 바꿉니다.",
  "user-scope-config": "사용자 범위(홈 폴더) 설정 파일의 항목을 되돌립니다. 이 Client를 쓰는 다른 프로젝트에도 영향을 줍니다.",
};

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const text = z.string().min(1).max(400);
const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : [];

export const recoveryPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal(RECOVERY_PLAN_KIND),
    status: z.enum(["ready", "blocked"]),
    mode: z.enum(RECOVERY_MODES),
    toolId: text,
    transactionId: z.string().regex(/^[0-9a-f]{32}$/u),
    operation: z.enum(JOURNAL_OPERATIONS),
    phase: text,
    journalDigest: sha256,
    targets: z.array(
      z.strictObject({ entryKey: text, client: z.enum(INSTALL_CLIENTS), scope: z.enum(CONFIG_SCOPES), file: text, serverName: text, current: z.enum(RECOVERY_TARGET_STATES), currentDigest: sha256.nullable() }),
    ),
    approvalRequirements: z.array(z.enum(RECOVERY_APPROVAL_REQUIREMENTS)).min(1),
    blockers: z.array(z.strictObject({ code: text, message: text })),
    effects: z.strictObject({ configWrites: z.number().int().min(0), stateWrite: z.literal(0), journalRemove: z.literal(1), spawn: z.literal(0), network: z.literal(0) }),
  })
  .superRefine((p, ctx) => {
    if (p.status === "ready" && p.blockers.length > 0) ctx.addIssue({ code: "custom", path: ["blockers"], message: "ready Plan에는 blocker가 없다" });
    if (p.status === "blocked" && p.blockers.length === 0) ctx.addIssue({ code: "custom", path: ["blockers"], message: "blocked Plan에는 blocker가 있다" });
    if (stringsOf(p).some((s) => containsAbsolutePath(s) || TOKEN_PATTERN.test(s) || URL_CREDENTIAL_PATTERN.test(s))) ctx.addIssue({ code: "custom", path: [], message: "절대 경로·token이 있다" });
  });
export type RecoveryPlanV1 = z.output<typeof recoveryPlanSchema>;
export interface PlannedRecovery {
  readonly plan: RecoveryPlanV1;
  readonly planDigest: string;
}
export const recoveryPlanDigest = (plan: RecoveryPlanV1) => sha256Digest(JSON.stringify(canonicalize(plan)));

export interface RecoveryPlanOptions {
  toolId: string;
  projectRoot: string;
  homeDir: string;
  mode: RecoveryMode;
  fs?: ConfigFs;
}
export type RecoveryPlanErrorCode = "NO_INTERRUPTED_OPERATION" | "JOURNAL_UNREADABLE" | "JOURNAL_DAMAGED" | "STATE_UNREADABLE";
export type RecoveryPlanResult = { ok: true; planned: PlannedRecovery } | { ok: false; code: RecoveryPlanErrorCode; message: string };

/** 이 프로젝트(또는 사용자 범위)에서 이 Tool의 가장 오래된 미완료 Journal로 복구 계획을 만든다. */
export async function planRecovery(options: RecoveryPlanOptions): Promise<RecoveryPlanResult> {
  const fs = options.fs ?? nodeConfigFs;
  const read = await readJournals(options.homeDir);
  if (!read.ok) return { ok: false, code: "JOURNAL_UNREADABLE", message: read.message };
  // 손상된 Journal은 어느 도구·어느 대상의 것인지 알 수 없다. 보수적으로 막고 안내한다(자동 삭제 없음).
  if (read.unreadable > 0) return { ok: false, code: "JOURNAL_DAMAGED", message: damagedJournalMessage(read.unreadable) };
  const projectKey = await projectKeyFor(options.projectRoot, fs);
  const journal = read.journals.find((j) => j.toolId === options.toolId && j.targets.every((t) => t.scope === "user" || t.projectKey === projectKey));
  if (journal === undefined) return { ok: false, code: "NO_INTERRUPTED_OPERATION", message: "이 프로젝트에서 " + options.toolId + "의 중간에 끝난 작업 기록이 없습니다" };
  const state = await readLifecycleState({ homeDir: options.homeDir, fs });
  if (!state.ok) return { ok: false, code: "STATE_UNREADABLE", message: state.message };

  const roots = { projectRoot: options.projectRoot, homeDir: options.homeDir, fs };
  const blockers: { code: string; message: string }[] = [];
  const fileName = read.files.get(journal.transactionId);
  if (fileName !== undefined && claimedByLiveRecovery(fileName)) blockers.push({ code: "RECOVERY_IN_PROGRESS", message: "다른 복구가 이 작업 기록을 처리하고 있습니다. 끝난 뒤 다시 확인하세요" });
  const targets: RecoveryPlanV1["targets"] = [];
  // 작업이 끝까지 완료됐는가(설정·Version State 모두 "변경 후"): Journal 정리만 못 하고 끝난 경우다.
  let completed = true;
  const stateNotBefore: string[] = [];
  for (const t of journal.targets) {
    const entry = await readConfiguredEntry(t.client, t.scope, t.serverName, roots).catch(() => undefined);
    const digest = entry === undefined ? null : configEntryDigest(entry);
    const current = digest === null ? "missing" : digest === t.afterEntryDigest ? "after" : digest === t.beforeEntryDigest ? "before" : "other";
    targets.push({ entryKey: t.entryKey, client: t.client, scope: t.scope, file: t.file, serverName: t.serverName, current, currentDigest: digest });
    const recorded = state.state.entries[t.entryKey];
    if (recorded === undefined || recorded.config.entryDigest !== t.beforeEntryDigest) stateNotBefore.push(t.file + "의 " + t.serverName);
    if (!(current === "after" && recorded !== undefined && recorded.config.entryDigest === t.afterEntryDigest)) completed = false;
    if (current === "other" || current === "missing") {
      blockers.push({ code: "EXTERNAL_CHANGE", message: t.file + "의 " + t.serverName + " 항목이 OpenHub가 쓰던 내용과도, 변경 전 내용과도 다릅니다(외부 변경" + (current === "missing" ? "·항목 없음" : "") + "). 덮어쓰지 않습니다. 파일을 직접 확인하세요" });
    }
  }
  if (completed) {
    if (options.mode === "undo") blockers.push({ code: "OPERATION_COMPLETED", message: "이 작업은 끝까지 완료됐고(설정·Version State 모두 반영) 작업 기록 정리만 남았습니다. 되돌리지 않습니다. --discard로 기록만 지우세요" });
  } else if (stateNotBefore.length > 0) {
    for (const s of stateNotBefore) blockers.push({ code: "STATE_CHANGED", message: s + " 기록(Version State)이 작업 시작 때와 다릅니다. 자동으로 판단하지 않습니다" });
  } else if (options.mode === "undo") {
    if (journal.toolConfig) blockers.push({ code: "TOOL_CONFIG_RECOVERY", message: "tool config를 쓰는 도구는 openhub lifecycle repair " + options.toolId + "로 복구하세요" });
    for (const [i, t] of journal.targets.entries()) {
      if (targets[i]!.current === "after" && t.before === null) blockers.push({ code: "UNDO_UNAVAILABLE", message: t.file + "의 " + t.serverName + " 변경 전 항목을 기록하지 못해 되돌릴 수 없습니다. 파일을 직접 확인하세요" });
    }
    if (blockers.length === 0 && !targets.some((t) => t.current === "after")) blockers.push({ code: "NOTHING_TO_UNDO", message: "바뀐 항목이 없습니다. --discard로 작업 기록만 지우세요" });
  } else if (targets.some((t) => t.current !== "before")) {
    blockers.push({ code: "NOT_RESTORED", message: "아직 변경 전 내용과 다른 항목이 있어 기록만 지울 수 없습니다" });
  }
  const writes = options.mode === "undo" ? targets.filter((t) => t.current === "after") : [];
  const requirements: RecoveryApprovalRequirement[] = ["base"];
  if (writes.some((t) => t.scope === "user")) requirements.push("user-scope-config");
  const unique = blockers.filter((b, i) => blockers.findIndex((x) => x.code === b.code && x.message === b.message) === i);
  const plan = recoveryPlanSchema.parse({
    schemaVersion: 1,
    kind: RECOVERY_PLAN_KIND,
    status: unique.length === 0 ? "ready" : "blocked",
    mode: options.mode,
    toolId: options.toolId,
    transactionId: journal.transactionId,
    operation: journal.operation,
    phase: journal.phase,
    journalDigest: journalDigest(journal),
    targets,
    approvalRequirements: requirements,
    blockers: unique,
    effects: { configWrites: writes.length, stateWrite: 0, journalRemove: 1, spawn: 0, network: 0 },
  });
  return { ok: true, planned: { plan, planDigest: recoveryPlanDigest(plan) } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
export function diffRecoveryPlans(approved: RecoveryPlanV1, current: RecoveryPlanV1): RecoveryChange[] {
  const out = new Set<RecoveryChange>();
  if (approved.journalDigest !== current.journalDigest || approved.transactionId !== current.transactionId) out.add("journal");
  if (!same(approved.targets, current.targets)) out.add("config");
  if (!same(approved.blockers, current.blockers)) out.add("state");
  return RECOVERY_CHANGE_KINDS.filter((k) => out.has(k));
}

const RECOVERY_KIND: ApprovalPlanKind<RecoveryPlanV1, RecoveryApprovalRequirement, RecoveryChange> = {
  kind: "recovery-plan-v1",
  parse: (plan) => {
    const parsed = recoveryPlanSchema.safeParse(plan);
    return parsed.success ? parsed.data : null;
  },
  digest: recoveryPlanDigest,
  status: (plan) => plan.status,
  executableStatus: "ready",
  requirements: (plan) => plan.approvalRequirements,
  knownRequirements: RECOVERY_APPROVAL_REQUIREMENTS,
  messages: RECOVERY_APPROVAL_MESSAGES,
  diff: diffRecoveryPlans,
  fallbackChange: "config",
  staleMessage: "승인 후 작업 기록이나 설정이 바뀌었습니다(다른 복구가 먼저 끝났을 수 있습니다). 다시 확인하고 승인하세요",
};

export type RecoveryApproval = KernelApproval<RecoveryApprovalRequirement>;
export type RecoveryApprovalOutcome = KernelApprovalOutcome<RecoveryApprovalRequirement>;
export type VerifiedRecoveryPlan = KernelVerified<RecoveryPlanV1, RecoveryApprovalRequirement>;
export interface RecoveryApprovalPrompter {
  readonly channel: ApprovalChannel;
  confirm(request: KernelApprovalRequest<RecoveryPlanV1, RecoveryApprovalRequirement>): Promise<readonly RecoveryApprovalRequirement[] | "rejected">;
}
export const isVerifiedRecoveryPlan = (value: unknown): value is VerifiedRecoveryPlan => isKernelVerified(value, RECOVERY_KIND.kind);
export function requestRecoveryApproval(planned: PlannedRecovery, prompter: RecoveryApprovalPrompter): Promise<RecoveryApprovalOutcome> {
  return requestKernelApproval(RECOVERY_KIND, planned, prompter as KernelPrompter<RecoveryPlanV1, RecoveryApprovalRequirement>);
}

export const RECOVERY_RESULT_STATUSES = ["recovered", "discarded", "cleanup-failed", "partial", "stale", "blocked", "failed"] as const;
export interface RecoveryResultV1 {
  schemaVersion: 1;
  kind: "openhub-recovery-result";
  status: (typeof RECOVERY_RESULT_STATUSES)[number];
  toolId: string;
  transactionId: string | null;
  targets: { entryKey: string; file: string; serverName: string; restored: boolean }[];
  error: { code: string; message: string } | null;
  nextActions: string[];
}

export interface ExecuteRecoveryOptions {
  toolId: string;
  projectRoot: string;
  homeDir: string;
  /** planRecovery를 승인 때와 같은 옵션으로 다시 부른다. */
  regenerate: () => Promise<RecoveryPlanResult>;
  fs?: ConfigFs;
  /** 테스트용 단계 표시(설정을 되돌리기 직전·Journal 정리 직전). */
  trace?: (phase: "recover-write" | "recover-cleanup") => void | Promise<void>;
}

const result = (toolId: string, over: Partial<RecoveryResultV1>): RecoveryResultV1 => ({ schemaVersion: 1, kind: "openhub-recovery-result", status: "failed", toolId, transactionId: null, targets: [], error: null, nextActions: [], ...over });

/**
 * 승인 검증(실행 직전 재계획·digest 비교) → undo는 대상 항목 교체(지금 항목이 "변경 후" digest와 같을 때만), discard는 Journal 삭제.
 * 같은 승인은 한 번만 쓴다. 이미 다른 복구가 끝났으면 Journal이 없어 stale이다. 실패를 recovered로 표시하지 않는다.
 * (v0.2.1) 재계획부터 Journal 정리까지 작업 잠금 안에서 한다. Journal을 지우지 못하면 cleanup-failed다(recovered·discarded가 아니다).
 */
export async function executeRecovery(approval: RecoveryApproval | undefined, options: ExecuteRecoveryOptions): Promise<RecoveryResultV1> {
  const locked = await withOperationLock({ homeDir: options.homeDir, purpose: "recover", ...(options.fs === undefined ? {} : { fs: options.fs }) }, () => executeRecoveryLocked(approval, options));
  if (locked.ok) return locked.value;
  return result(options.toolId, { status: "failed", error: { code: locked.code, message: locked.message }, nextActions: ["아무것도 바꾸지 않았습니다. 진행 중인 작업이 끝난 뒤 다시 복구하세요"] });
}

async function executeRecoveryLocked(approval: RecoveryApproval | undefined, options: ExecuteRecoveryOptions): Promise<RecoveryResultV1> {
  let cause: { code: string; message: string } | undefined;
  const gate = await verifyKernelApproval(RECOVERY_KIND, approval, async () => {
    const r = await options.regenerate();
    if (!r.ok) {
      cause = { code: r.code, message: r.message };
      throw new Error(r.code);
    }
    return r.planned;
  });
  if (!gate.ok) {
    const error = cause ?? { code: gate.code, message: gate.message };
    const stale = gate.code === "PLAN_STALE" || cause?.code === "NO_INTERRUPTED_OPERATION";
    return result(options.toolId, { status: stale ? "stale" : gate.code === "PLAN_NOT_EXECUTABLE" ? "blocked" : "failed", error, nextActions: ["아무것도 바꾸지 않았습니다. openhub lifecycle status로 상태를 확인하세요"] });
  }
  const plan = gate.verified.plan;
  const journals = await readJournals(options.homeDir);
  const journal: JournalV1 | undefined = journals.ok ? journals.journals.find((j) => j.transactionId === plan.transactionId) : undefined;
  if (journal === undefined || journalDigest(journal) !== plan.journalDigest) {
    return result(options.toolId, { status: "stale", transactionId: plan.transactionId, error: { code: "PLAN_STALE", message: "작업 기록이 바뀌었거나 이미 처리됐습니다" } });
  }
  // 같은 Journal을 두 복구가 동시에 처리하지 않도록 선점한다(rename은 하나만 성공).
  const claimed = journals.ok ? await claimJournal(options.homeDir, plan.transactionId, journals.files.get(plan.transactionId)!) : null;
  if (claimed === null) {
    return result(options.toolId, { status: "stale", transactionId: plan.transactionId, error: { code: "RECOVERY_IN_PROGRESS", message: "다른 복구가 이 작업 기록을 이미 처리하고 있거나 끝냈습니다" }, nextActions: ["아무것도 바꾸지 않았습니다. openhub lifecycle status로 상태를 확인하세요"] });
  }
  const fs = options.fs ?? nodeConfigFs;
  const trace = options.trace ?? (() => undefined);
  const targets: RecoveryResultV1["targets"] = plan.targets.map((t) => ({ entryKey: t.entryKey, file: t.file, serverName: t.serverName, restored: false }));
  if (plan.mode === "undo") {
    for (const [i, t] of plan.targets.entries()) {
      if (t.current !== "after") continue;
      await trace("recover-write");
      const jt = journal.targets.find((x) => x.entryKey === t.entryKey)!;
      const target = configTargetFor(t.client, t.scope);
      const replaced = await replaceConfigEntry(
        { id: "recover-" + t.client + "-" + t.scope, kind: "config-replace", client: t.client, scope: t.scope, file: t.file, path: [t.client === "codex" ? "mcp_servers" : "mcpServers", t.serverName], expectedEntryDigest: jt.afterEntryDigest, value: jt.before! },
        { projectRoot: options.projectRoot, homeDir: options.homeDir, fs, acknowledgements: gate.verified.acknowledgements, expectedBlockDigest: jt.afterTomlBlockDigest },
      );
      if (!replaced.ok) {
        await releaseJournalClaim(options.homeDir, plan.transactionId, claimed);
        const done = targets.some((x) => x.restored);
        return result(options.toolId, {
          status: done ? "partial" : "failed",
          transactionId: plan.transactionId,
          targets,
          error: { code: replaced.code, message: replaced.message },
          nextActions: [target.logical + "의 " + t.serverName + " 항목을 되돌리지 못했습니다(덮어쓰지 않았습니다). 작업 기록은 남겨 두었습니다. 파일을 확인한 뒤 다시 recover하세요"],
        });
      }
      targets[i]!.restored = true;
    }
  }
  await trace("recover-cleanup");
  if (!(await removeJournal(options.homeDir, plan.transactionId))) {
    // 정리 실패: 선점을 풀어 다음 복구(같은 Desktop 프로세스 포함)가 다시 다룰 수 있게 한다. 설정은 위 결과 그대로다.
    await releaseJournalClaim(options.homeDir, plan.transactionId, claimed);
    const restoredAny = targets.some((x) => x.restored);
    return result(options.toolId, {
      status: "cleanup-failed",
      transactionId: plan.transactionId,
      targets,
      error: { code: "JOURNAL_CLEANUP_FAILED", message: "작업 기록(Journal)을 지우지 못했습니다" },
      nextActions: [
        restoredAny ? "설정 항목은 변경 전으로 되돌렸습니다(현재 설정은 변경 전 상태입니다). Version State는 그대로이며 일치합니다" : "설정은 바꾸지 않았습니다",
        "작업 기록이 ~/.openhub/state/journal에 남아 있어 이 도구는 계속 interrupted-update로 보입니다",
        "~/.openhub/state 쓰기 권한을 확인한 뒤 openhub lifecycle recover " + options.toolId + " --discard로 기록만 지우세요",
      ],
    });
  }
  return result(options.toolId, {
    status: plan.mode === "undo" ? "recovered" : "discarded",
    transactionId: plan.transactionId,
    targets,
    nextActions: plan.mode === "undo" ? ["변경 전 항목으로 되돌렸습니다. Version State는 그대로이며 일치합니다. 필요하면 update를 다시 계획하세요"] : ["작업 기록을 지웠습니다"],
  });
}
