import { APPROVAL_REQUIREMENT_MESSAGES } from "./approval-v1";
import { installTargetChange, requiredEnvNotice, type InstallPlanV1, type PlannedInstall } from "./plan";

/**
 * Plan Preview 공통 문장(TASK-035·036). CLI와 Desktop이 같은 문장을 쓴다(Desktop은 textContent로만 렌더링).
 * - 실제 Client config에 기록될 command/args(launch.clientSpec)를 그대로 보여 준다(D-016).
 * - Windows npx wrapper는 OpenHub Windows 호환 정책으로 설명하고, 각 Client의 공식 권장이라고 쓰지 않는다.
 * - 절대 경로·env 값을 넣지 않는다(Plan 자체에 없다).
 */

const SCOPE_LABEL = { project: "프로젝트", user: "사용자" } as const;
const CLIENT_LABEL = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;

export const WINDOWS_NPX_WRAPPER_NOTICE =
  "Windows 호환 정책(OpenHub): Client가 npx를 실행할 수 있도록 설정 파일에 cmd /d /c npx 형태로 기록합니다. OpenHub는 이 명령을 실행하지 않습니다.";

/** 설치 상태 표시. host 미검사 상태의 not-installed는 "프로젝트 범위 기준 미설치"로만 표시한다(AC-035-09). */
export function installationStatusLabel(plan: InstallPlanV1): string {
  const { installationStatus, inspectedScopes } = plan.source.recommendation;
  // v0.2.0: 설치 판정은 대상별이다. 도구가 다른 Client·범위에 있어도 고른 대상에 없으면 추가할 수 있다.
  if (installationStatus === "installed") return plan.status === "already-installed" ? "이미 설정됨" : "다른 Client·범위에 이미 설정됨(고른 대상별 변경은 아래 변경 파일 참고)";
  if (installationStatus === "unknown") return "설치 여부를 확인하지 못함";
  if (installationStatus === "unidentified-present") return "식별되지 않은 MCP 서버가 이미 있음";
  return inspectedScopes.includes("user") ? "미설치(프로젝트 + 사용자 범위 확인)" : "프로젝트 범위 기준 미설치(사용자 범위 미검사)";
}

export function formatInstallPlanPreview(planned: PlannedInstall): string[] {
  const { plan, planDigest } = planned;
  const lines = [plan.displayName + " (" + plan.toolId + ") 설치 계획", ""];
  lines.push("설치 상태    " + installationStatusLabel(plan));
  lines.push("검사 범위    " + (plan.source.recommendation.inspectedScopes.includes("user") ? "프로젝트 + 사용자" : "프로젝트"));
  if (plan.status !== "installable") lines.push("실행 가능    아니오 (" + plan.status + ")");

  const backend = plan.backend;
  if (backend !== null) {
    const skipped = backend.skipped.length === 0 ? "" : " · 건너뜀: " + backend.skipped.map((s) => s.adapter + "(" + s.reason + ")").join(", ");
    lines.push("Backend      " + backend.adapter + (backend.selection === "fallback" ? " (대체 backend)" : "") + skipped);
  }
  const runSteps = plan.steps.filter((s) => s.kind === "run");
  if (plan.artifact !== null) {
    lines.push(
      "준비 단계    " +
        (runSteps.length === 0
          ? "없음 — OpenHub는 아무것도 실행하지 않고, Client가 처음 실행할 때 패키지를 받습니다(launch-on-demand)"
          : runSteps.map((s) => s.executable + " " + s.args.join(" ")).join(", ") +
            (plan.artifact.preparation === "npm-cache"
              ? " — OpenHub가 설정을 쓰기 전에 이 버전을 npx cache에 받습니다(MCP 서버는 실행하지 않음, 네트워크·다운로드·의존성 설치 스크립트)"
              : " — OpenHub가 실행합니다(네트워크·다운로드)")),
    );
  }
  if (plan.launch !== null) {
    lines.push("Client 실행 명령  " + [plan.launch.clientSpec.command, ...plan.launch.clientSpec.args].join(" "));
    if (plan.launch.clientSpec.command === "cmd") lines.push("  " + WINDOWS_NPX_WRAPPER_NOTICE);
  }

  lines.push("", "변경 파일");
  if (plan.targets.length === 0) lines.push("  (없음)");
  for (const t of plan.targets) {
    const where = CLIENT_LABEL[t.client] + ", " + SCOPE_LABEL[t.scope] + " 범위";
    const key = (t.client === "codex" ? "mcp_servers." : "mcpServers.") + t.serverName;
    const change = installTargetChange(plan, t);
    if (change === "manual") lines.push("  - " + t.file + " (" + where + ") 쓰지 않음 — 직접 설정해야 합니다");
    else if (change === "unchanged") lines.push("  - " + t.file + " (" + where + ") " + key + " 변경 없음 — 같은 항목이 이미 있습니다");
    else if (change === "conflict") lines.push("  - " + t.file + " (" + where + ") " + key + " 쓰지 않음 — 다른 내용의 같은 이름 항목이 있습니다(충돌, 덮어쓰지 않음)");
    else lines.push("  - " + t.file + " (" + where + ") " + key + " 항목 추가 · " + (t.precondition.exists ? "기존 파일" : "새 파일"));
  }

  lines.push("", "환경변수");
  if (plan.requiredEnv.length === 0) lines.push("  (필요 없음)");
  for (const e of plan.requiredEnv) lines.push("  - " + (e.required ? requiredEnvNotice(e.name) : e.name + " (선택, 설정 파일에 참조를 쓰지 않습니다)"));

  const conflicts = plan.warnings.filter((w) => w.code === "CONFIG_KEY_EXISTS");
  lines.push("", "충돌         " + (conflicts.length === 0 ? "없음" : ""));
  for (const c of conflicts) lines.push("  - " + c.message);

  const shown = new Set(["CONFIG_KEY_EXISTS", "required-env"]);
  const warnings = plan.warnings.filter((w) => !shown.has(w.code));
  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const w of warnings) lines.push("  - [" + w.code + "] " + w.message);
  }

  lines.push("", "승인 항목");
  for (const r of plan.approvalRequirements) lines.push("  - [" + r + "] " + APPROVAL_REQUIREMENT_MESSAGES[r]);
  lines.push("", "Plan digest  " + planDigest);
  return lines;
}
