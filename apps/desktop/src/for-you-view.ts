import type { RecommendationReport } from "@openhub/core";

/**
 * FOR YOU 카드 화면 데이터(TASK-026). Core RecommendationReport를 화면용으로 줄인다(Electron에 의존하지 않아 테스트 가능).
 * Project Fit과 OpenScore는 따로 표시하고 합치지 않는다. 설치 동작은 없다(M4).
 */

export const OPEN_SCORE_NOTICE = "OpenScore는 저장소 유지관리·활동성·커뮤니티 신호이며 보안·코드 품질 평가가 아닙니다";
export const MAX_REASONS = 3;

export type BadgeKind = "confirmed" | "likely" | "unknown" | "host-unchecked" | "unidentified";

export interface ForYouItem {
  rank: number;
  toolId: string;
  name: string;
  capability: string;
  projectFit: string;
  openScore: string;
  badges: { kind: BadgeKind; label: string }[];
  reasons: string[];
  moreReasons: number;
}

export interface ForYouView {
  projectName: string;
  scope: string;
  items: ForYouItem[];
  noCandidate: { capability: string; label: string; message: string }[];
  notice: string;
  /** metadata cache가 없을 때 한 줄 안내 */
  openScoreUnavailable: string | null;
}

const score = (n: number | null) => (n === null ? "—" : n.toFixed(2));

export function buildForYouView(report: RecommendationReport): ForYouView {
  const needs = new Map(report.needs.map((n) => [n.capability, n]));
  const items = report.recommendations.map((r): ForYouItem => {
    const primary = needs.get(r.primaryCapability);
    const badges: ForYouItem["badges"] = [];
    const add = (kind: BadgeKind, label: string) => {
      if (!badges.some((b) => b.label === label)) badges.push({ kind, label });
    };
    if (primary?.state === "confirmed-gap") add("confirmed", "Gap 확인");
    if (primary?.state === "likely-gap") add("likely", "Gap 가능성");
    if (primary?.state === "unknown" || r.installation.status === "unknown") add("unknown", "판단 보류");
    if (primary?.stateReasons.includes("host-unchecked")) add("host-unchecked", "사용자 범위 미검사");
    if (r.installation.status === "unidentified-present") add("unidentified", "식별되지 않은 MCP 있음");
    return {
      rank: r.rank,
      toolId: r.toolId,
      name: r.displayName,
      capability: primary?.label ?? r.primaryCapability,
      projectFit: score(r.projectFit.score),
      openScore: score(r.openScore.score),
      badges,
      reasons: r.reasons.slice(0, MAX_REASONS).map((x) => x.message),
      moreReasons: Math.max(0, r.reasons.length - MAX_REASONS),
    };
  });
  return {
    projectName: report.project.name,
    scope: report.assessment.inspectedScopes.includes("user") ? "프로젝트 + 사용자 범위" : "프로젝트 범위(사용자 범위 미검사)",
    items,
    noCandidate: report.needs
      .filter((n) => n.reasons.some((x) => x.code === "no-candidate"))
      .map((n) => ({ capability: n.capability, label: n.label, message: "등록된 도구 없음" })),
    notice: OPEN_SCORE_NOTICE,
    openScoreUnavailable: report.generatedFrom.metadataCollectedAt === null ? "metadata cache가 없어 OpenScore를 계산하지 않았습니다(openhub collect로 수집)" : null,
  };
}
