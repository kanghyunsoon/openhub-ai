import type { ToolEvaluation } from "./candidates";
import { gapStateRank, type ProjectFit } from "./fit";
import type { GapAssessment } from "./gaps";
import { priorityRank } from "./need-rules";
import type { OpenScoreResult } from "./open-score";

/**
 * Ranking(§7, D-009) — lexicographic, 단일 통합 점수 없음.
 *   (1) compatibility 필터·resolved 설치 제외는 후보 단계에서 끝난다(이 함수는 추천 대상만 받는다)
 *   (2) 실행 가능 여부: primary state가 confirmed·likely인 tool이 unknown보다 앞
 *   (3) primary Gap priority: high > medium > low
 *   (4) primary Gap state: confirmed > likely
 *   (5) Project Fit 높은 순
 *   (6) OpenScore 높은 순(null은 맨 뒤)
 *   (7) toolId 오름차순
 * Fit × OpenScore 같은 곱·합 점수를 만들지 않는다.
 */

export interface RankCandidate {
  evaluation: ToolEvaluation;
  primary: GapAssessment;
  fit: ProjectFit;
  openScore: OpenScoreResult;
}

const actionable = (g: GapAssessment) => (g.state === "confirmed-gap" || g.state === "likely-gap" ? 1 : 0);

export function compareRankCandidates(a: RankCandidate, b: RankCandidate): number {
  const ida = a.evaluation.entry.manifest.name;
  const idb = b.evaluation.entry.manifest.name;
  return (
    actionable(b.primary) - actionable(a.primary) ||
    priorityRank(b.primary.priority) - priorityRank(a.primary.priority) ||
    gapStateRank(b.primary.state) - gapStateRank(a.primary.state) ||
    b.fit.score - a.fit.score ||
    (b.openScore.score ?? -1) - (a.openScore.score ?? -1) ||
    (ida < idb ? -1 : ida > idb ? 1 : 0)
  );
}

export function rankRecommendations<T extends RankCandidate>(candidates: readonly T[]): T[] {
  return [...candidates].sort(compareRankCandidates);
}
