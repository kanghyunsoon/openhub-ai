import type { RecommendationReport } from "@openhub/core";
import { capabilityText, reasonText } from "./i18n/core-text";
import { tr } from "./i18n/index";

/**
 * FOR YOU 카드 화면 데이터(TASK-026). Core RecommendationReport를 화면용으로 줄인다(Electron에 의존하지 않아 테스트 가능).
 * Project Fit과 OpenScore는 따로 표시하고 합치지 않는다. 설치 동작은 없다(M4).
 */

/** OpenScore 의미 문구(현재 Desktop 언어). */
export const openScoreNotice = (): string => tr("forYou.openNotice");
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
    if (primary?.state === "confirmed-gap") add("confirmed", tr("forYou.badge.confirmed"));
    if (primary?.state === "likely-gap") add("likely", tr("forYou.badge.likely"));
    if (primary?.state === "unknown" || r.installation.status === "unknown") add("unknown", tr("forYou.badge.unknown"));
    if (primary?.stateReasons.includes("host-unchecked")) add("host-unchecked", tr("forYou.badge.hostUnchecked"));
    if (r.installation.status === "unidentified-present") add("unidentified", tr("forYou.badge.unidentified"));
    return {
      rank: r.rank,
      toolId: r.toolId,
      name: r.displayName,
      capability: capabilityText(r.primaryCapability, primary?.label ?? r.primaryCapability),
      projectFit: score(r.projectFit.score),
      openScore: score(r.openScore.score),
      badges,
      reasons: r.reasons.slice(0, MAX_REASONS).map((x) => reasonText(x)),
      moreReasons: Math.max(0, r.reasons.length - MAX_REASONS),
    };
  });
  return {
    projectName: report.project.name,
    scope: tr(report.assessment.inspectedScopes.includes("user") ? "forYou.scope.both" : "forYou.scope.project"),
    items,
    noCandidate: report.needs
      .filter((n) => n.reasons.some((x) => x.code === "no-candidate"))
      .map((n) => ({ capability: n.capability, label: capabilityText(n.capability, n.label), message: tr("forYou.noTool") })),
    notice: openScoreNotice(),
    openScoreUnavailable: report.generatedFrom.metadataCollectedAt === null ? tr("forYou.openUnavailable") : null,
  };
}
