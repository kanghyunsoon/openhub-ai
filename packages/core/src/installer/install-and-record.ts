import type { InstallApproval } from "./approval-v1";
import type { PlannedInstall } from "./plan";
import type { InstallResultV1 } from "./result";
import { runInstallTransactionWith, type InstallEnvironment, type InstallRequest } from "./transaction";
import { recordInstallInState } from "../lifecycle/status";

/**
 * (v0.2.1 B) 설치 + Version State 기록을 하나의 작업 잠금 안에서 한다(CLI·Desktop 공통 진입점).
 * 설정 쓰기 → 확인 → 기록 사이에 다른 OpenHub 작업(update·Health·install)이 끼어들 수 없다(OPERATION_IN_PROGRESS).
 * 기록이 실패하면 이번에 쓴 설정을 되돌리고 STATE_RECORD_FAILED(되돌리지 못하면 COMPENSATION_INCOMPLETE)다.
 * 기록 단계는 commit 잠금(lifecycle.json.lock)만 잡으므로 작업 잠금과 중첩 교착이 없다.
 */
export interface InstallAndRecordResult {
  result: InstallResultV1;
  /** Version State에 기록한 항목 수(succeeded가 아니면 0). */
  recorded: number;
}

const RETRYABLE_STATE_CODES = new Set(["STATE_CONFLICT", "STATE_WRITE_FAILED"]);

export async function runInstallAndRecord(planned: PlannedInstall, approval: InstallApproval | undefined, request: InstallRequest, env: InstallEnvironment, options: { now: () => Date }): Promise<InstallAndRecordResult> {
  let recorded = 0;
  const result = await runInstallTransactionWith(planned, approval, request, env, async (succeeded) => {
    const r = await recordInstallInState(planned, succeeded, { projectRoot: request.projectRoot, homeDir: request.homeDir, now: options.now, ...(env.configFs === undefined ? {} : { fs: env.configFs }) });
    if (!r.ok) return { ok: false, code: r.code, retryable: RETRYABLE_STATE_CODES.has(r.code) };
    recorded = r.recorded;
    return { ok: true };
  });
  return { result, recorded: result.status === "succeeded" ? recorded : 0 };
}
