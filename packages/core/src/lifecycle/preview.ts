import { WINDOWS_NPX_WRAPPER_NOTICE } from "../installer/preview";
import { requiredEnvNotice } from "../installer/plan";
import { LIFECYCLE_APPROVAL_MESSAGES, type LifecyclePlanV1, type PlannedLifecycle } from "./plan";
import type { LifecycleResultV1 } from "./result";
import type { LastHealth } from "./state";
import type { LifecycleToolStatus } from "./status";
import { LIFECYCLE_STATE_LOGICAL_PATH } from "./store";

/**
 * Lifecycle Preview·결과·상태 공통 문장(TASK-045·046). CLI와 Desktop이 같은 문장을 쓴다(Desktop은 textContent로만 렌더링).
 * - skip된 Health는 "Not verified"로만 표시하고 healthy로 쓰지 않는다(D-019).
 * - Plan·Result·State에 없는 절대 경로·env 값은 문장에도 없다.
 */

const SCOPE_LABEL = { project: "프로젝트", user: "사용자" } as const;
const CLIENT_LABEL = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
const OPERATION_LABEL = { update: "업데이트", rollback: "롤백", health: "Health Check" } as const;

export const HEALTH_NOT_VERIFIED_LINES = ["Health: Not verified", "Reason: Required environment is unchecked"] as const;

/** 손상·미지원 Version State 고정 문구(AC-045-10). OpenHub는 자동으로 고치거나 덮어쓰지 않는다. CLI·Desktop 공용. */
export function stateUnreadableMessage(code: string): string {
  return "Version State(" + LIFECYCLE_STATE_LOGICAL_PATH + ")를 읽을 수 없습니다 (" + code + "). OpenHub는 이 파일을 자동으로 고치거나 덮어쓰지 않습니다. 파일과 백업(lifecycle.json.bak)을 확인하세요.";
}

/** lastHealth 표시. skipped는 Not verified(healthy 아님). */
export function healthLines(health: Pick<LastHealth, "status" | "environmentUnverified" | "checkedAt"> | null): string[] {
  if (health === null) return ["Health: Unknown (아직 확인하지 않음)"];
  if (health.status === "skipped") return [...HEALTH_NOT_VERIFIED_LINES];
  const lines = ["Health: " + (health.status === "healthy" ? "Healthy" : health.status) + (health.checkedAt === null ? "" : " (" + health.checkedAt + ")")];
  if (health.environmentUnverified) lines.push("Note: Required environment is unchecked");
  return lines;
}

const spec = (s: { command: string; args: readonly string[] }) => [s.command, ...s.args].join(" ");

export function formatLifecyclePlanPreview(planned: PlannedLifecycle): string[] {
  const { plan, planDigest } = planned;
  const lines = [plan.displayName + " (" + plan.toolId + ") " + OPERATION_LABEL[plan.operation] + " 계획", ""];
  lines.push("상태         " + plan.status);
  lines.push("Backend      " + plan.backend);
  lines.push("현재 버전    " + (plan.current.identity?.spec ?? plan.current.requested + " (고정되지 않음)"));
  if (plan.operation !== "health") {
    lines.push((plan.operation === "rollback" ? "되돌릴 버전  " : "목표 버전    ") + (plan.target.identity?.spec ?? plan.target.requested + " (고정되지 않음)"));
    if (plan.operation === "update") lines.push("요청 spec    " + plan.target.requested);
  }
  const run = plan.steps.filter((s) => s.kind === "run");
  if (plan.operation !== "health") {
    lines.push(
      "준비 단계    " +
        (run.length === 0
          ? "없음 — 패키지 매니저 명령을 실행하지 않고 Client 설정의 패키지 인자만 바꿉니다"
          : run.map((s) => s.executable + " " + s.args.join(" ")).join(", ") + " — OpenHub가 실행합니다(네트워크·다운로드, 받은 image는 지우지 않습니다)"),
    );
    lines.push("Client 실행 명령");
    lines.push("  현재  " + spec(plan.current.clientSpec));
    lines.push("  변경  " + spec(plan.target.clientSpec));
    if (plan.target.clientSpec.command === "cmd") lines.push("  " + WINDOWS_NPX_WRAPPER_NOTICE);
  }

  lines.push("", "대상");
  for (const t of plan.targets) {
    const where = CLIENT_LABEL[t.client] + ", " + SCOPE_LABEL[t.scope] + " 범위";
    const action = plan.operation === "health" ? "확인만 합니다(설정 변경 없음)" : (t.client === "codex" ? "mcp_servers." : "mcpServers.") + t.serverName + " 항목 교체";
    lines.push("  - " + t.file + " (" + where + ") " + action + (t.stateRevision === null ? " · Version State 없음" : " · revision " + t.stateRevision));
  }

  lines.push("", "Health Check");
  if (plan.healthPolicy.gate === "required") {
    const t = plan.healthPolicy.timeouts;
    lines.push("  필수 — MCP 서버를 격리 임시 디렉터리에서 실행해 initialize·tools/list 응답을 확인합니다(Client 앱은 실행하지 않음)");
    lines.push("  제한 시간 startup " + t.startupMs / 1000 + "초 · handshake " + t.handshakeMs / 1000 + "초 · 전체 " + t.totalMs / 1000 + "초");
    if (plan.operation !== "health") lines.push("  Health가 실패하면 설정을 원래 내용으로 되돌리고 Version State를 바꾸지 않습니다");
  } else {
    lines.push("  생략(사전 승인) — 적용 후 " + HEALTH_NOT_VERIFIED_LINES.join(" / "));
  }

  lines.push("", "환경변수");
  if (plan.requiredEnv.length === 0) lines.push("  (필요 없음)");
  for (const e of plan.requiredEnv) lines.push("  - " + (e.required ? requiredEnvNotice(e.name) : e.name + " (선택)"));

  const shown = new Set(["environment-unverified"]);
  const warnings = plan.warnings.filter((w) => !shown.has(w.code));
  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const w of warnings) lines.push("  - [" + w.code + "] " + w.message);
  }
  lines.push("", "승인 항목");
  for (const r of plan.approvalRequirements) lines.push("  - [" + r + "] " + LIFECYCLE_APPROVAL_MESSAGES[r]);
  lines.push("", "Plan digest  " + planDigest);
  return lines;
}

export function formatLifecycleResult(result: LifecycleResultV1): string[] {
  const lines = ["", "결과  " + result.status + (result.code === undefined ? "" : " (" + result.code + ")")];
  if (result.changed !== undefined) lines.push("  바뀐 항목: " + result.changed.join(", "));
  if (result.operation !== "health" && result.artifact.to !== null) lines.push("  artifact  " + (result.artifact.from ?? "-") + " → " + result.artifact.to);
  for (const t of result.targets) {
    const config = t.configRestored ? "원래 내용으로 되돌림" : t.configApplied ? "교체함" : "바꾸지 않음";
    const revision = t.revisionAfter === null ? "" : " · revision " + (t.revisionBefore ?? "-") + " → " + t.revisionAfter;
    lines.push("  설정 " + t.file + " (" + t.scope + "): " + config + revision);
  }
  if (result.health !== null) for (const l of healthLines(result.health)) lines.push("  " + l);
  if (result.compensated) lines.push("  실패 후 설정 파일을 원래 내용으로 되돌렸습니다(compensated)");
  for (const s of result.steps.filter((x) => x.status === "failed")) lines.push("  실패 단계 " + s.id + (s.code === undefined ? "" : " (" + s.code + ")") + (s.excerpt === undefined ? "" : ": " + s.excerpt.split("\n").slice(-3).join(" / ")));
  for (const w of result.warnings) lines.push("  - [" + w.code + "] " + w.message);
  if (result.nextActions.length > 0) {
    lines.push("", "다음에 할 일");
    for (const a of result.nextActions) lines.push("  - " + a);
  }
  return lines;
}

const STATE_LABEL: Readonly<Record<LifecycleToolStatus["state"], string>> = {
  "state-consistent": "일치",
  "config-drift": "config-drift(설정이 Version State와 다름)",
  "missing-config": "missing-config(설정 항목 없음)",
  "untracked-adoptable": "untracked-adoptable(표준 항목, Version State 없음)",
  "untracked-foreign": "untracked-foreign(OpenHub가 관리하지 않는 설정)",
  "not-inspected": "not-inspected(사용자 범위 미검사)",
};

/** status 한 항목의 표시 줄. */
export function formatLifecycleStatusItem(item: LifecycleToolStatus): string[] {
  const head = item.serverName + " · " + CLIENT_LABEL[item.client as keyof typeof CLIENT_LABEL] + " · " + SCOPE_LABEL[item.scope] + " (" + item.file + ")";
  const lines = [head, "  Tool       " + (item.toolId ?? "(식별 안 됨)"), "  상태       " + STATE_LABEL[item.state]];
  if (item.artifact !== null) {
    lines.push("  artifact   " + (item.artifact.resolved ?? item.artifact.requested) + " · " + (item.artifact.lock === "artifact-locked" ? "locked" : "unlocked(버전 고정 안 됨)") + (item.artifact.presence === "artifact-unknown" ? " · 로컬 image 존재 여부 알 수 없음" : ""));
  }
  if (item.revision !== null) lines.push("  revision   " + item.revision);
  const health =
    item.health === "not-verified"
      ? [...HEALTH_NOT_VERIFIED_LINES]
      : ["Health: " + (item.health === "healthy" ? "Healthy" : item.health === "unknown" ? "Unknown (아직 확인하지 않음)" : item.health)];
  for (const l of health) lines.push("  " + l);
  return lines;
}

/** Plan status가 승인 가능한지(ready). */
export const isApprovableLifecyclePlan = (plan: LifecyclePlanV1) => plan.status === "ready";

