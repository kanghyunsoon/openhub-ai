import { z } from "zod";
import { nodeConfigFs, type ConfigFs } from "../installer/config-writer";
import { entryKeyOf, serializeLifecycleState, toolStateSchema, type ToolState } from "../lifecycle/state";
import { commitLifecycleState, readLifecycleState } from "../lifecycle/store";
import { ADOPT_PLAN_CHANGE_KINDS, verifyApprovedAdoptPlan, type AdoptApproval, type AdoptPlanResult, type VerifiedAdoptPlan } from "./plan";

/**
 * Adopt 실행(TASK-060, D-029). 승인된 AdoptPlan을 실행 직전 재생성·digest 비교로 확인한 뒤 Version State에 entry 1개를 쓴다.
 * - config write·spawn·network 0회. 쓰기는 M5 store의 CAS(읽은 digest와 현재 파일이 같을 때만)다.
 * - 새 entry: revision 1, previous null, lastHealth null(아직 확인하지 않음), appliedPlanDigest = AdoptPlan digest.
 * - 고정되지 않은 artifact는 resolved null(artifact-unlocked)로 남긴다.
 * - 실패하면 Version State·config를 바꾸지 않는다(부분 쓰기 없음).
 */

export const ADOPT_RESULT_SCHEMA_VERSION = 1;
export const ADOPT_RESULT_KIND = "openhub-adopt-result";
export const ADOPT_RESULT_STATUSES = ["adopted", "blocked", "stale", "failed"] as const;

export const adoptResultSchema = z.strictObject({
  schemaVersion: z.literal(ADOPT_RESULT_SCHEMA_VERSION),
  kind: z.literal(ADOPT_RESULT_KIND),
  status: z.enum(ADOPT_RESULT_STATUSES),
  toolId: z.string().min(1).max(300),
  planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u).nullable(),
  entryKey: z.string().min(1).max(400).nullable(),
  revision: z.literal(1).nullable(),
  changed: z.array(z.enum(ADOPT_PLAN_CHANGE_KINDS)),
  error: z.strictObject({ code: z.string().min(1).max(80), message: z.string().min(1).max(400) }).nullable(),
});
export type AdoptResultV1 = z.output<typeof adoptResultSchema>;

export interface ExecuteAdoptOptions {
  toolId: string;
  homeDir: string;
  /** planAdopt를 승인 때와 같은 옵션으로 다시 부른다. */
  regenerate: () => Promise<AdoptPlanResult>;
  now: () => Date;
  fs?: ConfigFs;
}

/** 검증된 AdoptPlan → Version State entry. */
export function adoptedToolState(verified: VerifiedAdoptPlan, now: Date): ToolState {
  const p = verified.plan;
  if (p.backend === null || p.launch === null || p.artifact === null || p.precondition.entryDigest === null) throw new Error("ready AdoptPlan이 아닙니다");
  const { entryKey: _ignored, ...target } = p.target;
  return toolStateSchema.parse({
    toolId: p.toolId,
    backend: p.backend,
    revision: 1,
    target,
    artifact: { requested: p.artifact.requested, resolved: p.artifact.resolved },
    launch: { platform: p.launch.platform, clientSpec: { command: p.launch.clientSpec.command, args: [...p.launch.clientSpec.args] } },
    config: { entryDigest: p.precondition.entryDigest, tomlBlockDigest: p.precondition.tomlBlockDigest },
    appliedPlanDigest: verified.planDigest,
    committedAt: now.toISOString(),
    lastHealth: null,
    previous: null,
  });
}

const result = (toolId: string, over: Partial<AdoptResultV1>): AdoptResultV1 =>
  adoptResultSchema.parse({ schemaVersion: ADOPT_RESULT_SCHEMA_VERSION, kind: ADOPT_RESULT_KIND, status: "failed", toolId, planDigest: null, entryKey: null, revision: null, changed: [], error: null, ...over });

/** 승인 검증 → Version State write 1회. 승인 Approval은 이 호출에서 소모된다(1회용). */
export async function executeAdopt(approval: AdoptApproval | undefined, options: ExecuteAdoptOptions): Promise<AdoptResultV1> {
  const fs = options.fs ?? nodeConfigFs;
  const gate = await verifyApprovedAdoptPlan(approval, options.regenerate);
  if (!gate.ok) {
    const error = { code: gate.cause ?? gate.code, message: gate.message };
    if (gate.code === "PLAN_STALE") return result(options.toolId, { status: "stale", planDigest: approval?.planDigest ?? null, changed: [...(gate.changed ?? [])], error });
    if (gate.code === "PLAN_REGENERATION_FAILED") return result(options.toolId, { status: "failed", planDigest: approval?.planDigest ?? null, error });
    return result(options.toolId, { status: "blocked", planDigest: approval?.planDigest ?? null, error });
  }
  const verified = gate.verified;
  const key = verified.plan.target.entryKey;
  const read = await readLifecycleState({ homeDir: options.homeDir, fs });
  if (!read.ok) return result(options.toolId, { status: "failed", planDigest: verified.planDigest, error: { code: read.code, message: read.message } });
  if (read.state.entries[key] !== undefined) {
    return result(options.toolId, { status: "stale", planDigest: verified.planDigest, changed: ["state-present"], error: { code: "PLAN_STALE", message: "승인 후 같은 항목이 Version State에 기록됐습니다" } });
  }
  let state: ToolState;
  try {
    state = adoptedToolState(verified, options.now());
    if (entryKeyOf(state.target) !== key) throw new Error("entryKey");
    serializeLifecycleState({ ...read.state, entries: { ...read.state.entries, [key]: state } });
  } catch {
    return result(options.toolId, { status: "failed", planDigest: verified.planDigest, error: { code: "STATE_INVALID", message: "Version State에 기록할 수 없는 항목입니다" } });
  }
  const committed = await commitLifecycleState({ ...read.state, entries: { ...read.state.entries, [key]: state } }, read.digest, { homeDir: options.homeDir, fs });
  if (!committed.ok) return result(options.toolId, { status: "failed", planDigest: verified.planDigest, error: { code: committed.code, message: committed.message } });
  return result(options.toolId, { status: "adopted", planDigest: verified.planDigest, entryKey: key, revision: 1 });
}

/** CLI·Desktop 공용 결과 줄. */
export function formatAdoptResult(r: AdoptResultV1): string[] {
  if (r.status === "adopted") return ["Adopt 완료: " + r.toolId + " (Version State revision 1). 설정 파일은 바뀌지 않았습니다.", "Health: Not verified (lifecycle health로 확인할 수 있습니다)"];
  const lines = ["Adopt " + r.status + ": " + r.toolId + (r.error === null ? "" : " — " + r.error.code + ": " + r.error.message)];
  if (r.changed.length > 0) lines.push("바뀐 항목: " + r.changed.join(", "));
  lines.push("Version State와 설정 파일은 바뀌지 않았습니다.");
  return lines;
}

