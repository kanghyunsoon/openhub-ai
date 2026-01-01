import { ADOPT_APPROVAL_MESSAGES, type PlannedAdopt } from "./plan";

/**
 * AdoptPlan Preview(TASK-059, D-029). CLI·Desktop이 같은 줄을 쓴다.
 * - strong이면 판정 이유·일치 artifact·현재 서버 이름·canonical Registry 이름을 반드시 보여 준다.
 * - unlocked artifact를 locked·pinned로 표현하지 않는다. 정확한 버전이 고정됐다고 말하지 않는다.
 */

const GRADE_TEXT: Record<string, string> = {
  exact: "exact — 서버 이름과 package·image가 모두 Registry와 일치",
  strong: "strong — 서버 이름은 다르지만 package·image가 정확히 일치하고 후보가 하나",
  weak: "weak — 이름만 비슷함(adopt 불가)",
  unresolved: "unresolved — 식별 근거 없음(adopt 불가)",
};

export function formatAdoptPlanPreview(planned: PlannedAdopt): string[] {
  const p = planned.plan;
  const lines: string[] = [];
  lines.push("Adopt 계획: " + p.toolId + " (" + p.status + ")");
  lines.push("대상: " + p.target.client + " · " + p.target.scope + " · " + p.target.file + " · 서버 " + p.target.serverName);
  lines.push("식별: " + (GRADE_TEXT[p.identity.grade] ?? p.identity.grade) + " [" + p.identity.reason + "]");
  lines.push("  일치한 artifact: " + (p.identity.artifactKey ?? "(없음)"));
  lines.push("  현재 서버 이름: " + p.identity.serverName);
  lines.push("  Registry 이름: " + p.toolId + (p.identity.canonicalAlias === null ? "" : " (canonical alias " + p.identity.canonicalAlias + ")"));
  if (p.launch !== null && p.backend !== null) lines.push("실행 방식(기존 설정 그대로): " + p.backend + " · " + [p.launch.clientSpec.command, ...p.launch.clientSpec.args].join(" "));
  if (p.artifact !== null) {
    lines.push(
      p.artifact.lock === "locked"
        ? "artifact: " + p.artifact.requested + " (설정에 고정된 spec을 기록합니다)"
        : "artifact: " + p.artifact.requested + " (artifact-unlocked: 버전이 고정되어 있지 않아 정확한 artifact를 기록하지 않습니다)",
    );
  }
  lines.push("효과: Version State 기록 1회 · 설정 파일 변경 0 · 실행 0 · 네트워크 0");
  lines.push("Health: Not verified (adopt는 MCP 서버를 실행하지 않습니다)");
  for (const b of p.blockers) lines.push("차단: " + b.code + " — " + b.message);
  if (p.status === "ready") {
    lines.push("승인 요구:");
    for (const r of p.approvalRequirements) lines.push("  [" + r + "] " + ADOPT_APPROVAL_MESSAGES[r]);
  }
  lines.push("plan digest: " + planned.planDigest);
  return lines;
}

