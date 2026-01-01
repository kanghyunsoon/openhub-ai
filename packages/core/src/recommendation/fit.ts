import type { ToolEvaluation } from "./candidates";
import type { GapAssessment, GapState } from "./gaps";
import { priorityRank, type Priority } from "./need-rules";
import type { Strength } from "./needs";

/**
 * Project Fit(§5, D-009): "이 프로젝트에 얼마나 잘 맞는가"만 평가하는 0~100 정수.
 *   Fit = floor((35·C + 25·E + 15·S + 15·K + 10·V + 50) / 100)
 * repository metadata(stars·forks·pushedAt·release·license·archived)는 입력으로 받지 않으며
 * OpenScore와 곱하거나 합치지 않는다. 모든 연산은 정수다.
 */

export const FIT_WEIGHTS = Object.freeze({ needCoverage: 35, evidenceStrength: 25, stackMatch: 15, clientSupport: 15, environment: 10 });
export const PRIORITY_WEIGHT: Readonly<Record<Priority, number>> = Object.freeze({ high: 90, medium: 60, low: 30 });
export const STRENGTH_SCORE: Readonly<Record<Strength, number>> = Object.freeze({ strong: 100, environment: 80, weak: 40 });
const PARTIAL_FACTOR = 75;

export interface FitComponents {
  needCoverage: number;
  evidenceStrength: number;
  stackMatch: number;
  clientSupport: number;
  environment: number;
}

export interface ProjectFit {
  /** 0~100 정수 */
  score: number;
  components: FitComponents;
}

/** E: need source 강도. 관련 Detector(source·ai-environment·host-probe)가 partial이면 ×75/100. */
export function evidenceScore(gap: Pick<GapAssessment, "strength" | "partial">): number {
  const base = STRENGTH_SCORE[gap.strength];
  return gap.partial ? Math.floor((base * PARTIAL_FACTOR) / 100) : base;
}

/** S: appliesTo.stacks 일치 항목의 최강 강도. 범용 tool은 50. */
export function stackScore(evaluation: Pick<ToolEvaluation, "compatibility">): number {
  const { stack } = evaluation.compatibility;
  if (stack.generic || stack.strength === null) return 50;
  return STRENGTH_SCORE[stack.strength];
}

/** K: 탐지된 AI Client 중 지원 비율. Client를 탐지하지 못했으면 50. */
export function clientScore(evaluation: Pick<ToolEvaluation, "compatibility">): number {
  const { detected, supported } = evaluation.compatibility.clients;
  if (detected.length === 0) return 50;
  return Math.floor((100 * supported.length) / detected.length);
}

/** V: platform·runtime·backend 각각 compatible 100 / unknown 50의 평균(내림). */
export function environmentScore(evaluation: Pick<ToolEvaluation, "compatibility">): number {
  const { platform, runtime, backend } = evaluation.compatibility;
  const one = (s: string) => (s === "compatible" ? 100 : 50);
  return Math.floor((one(platform.status) + one(runtime.status) + one(backend.status)) / 3);
}

/** capability별 Fit 기여도(0~75). K·V는 tool 단위 값이라 capability 비교에서 뺀다. */
export function fitContribution(gap: Pick<GapAssessment, "priority" | "strength" | "partial">, stack: number): number {
  return Math.floor((35 * PRIORITY_WEIGHT[gap.priority] + 25 * evidenceScore(gap) + 15 * stack + 50) / 100);
}

const STATE_RANK: Readonly<Record<GapState, number>> = { "confirmed-gap": 3, "likely-gap": 2, unknown: 1, satisfied: 0 };
export function gapStateRank(state: GapState): number {
  return STATE_RANK[state];
}

/**
 * primaryCapability(§7): Gap state → Gap priority → fitContribution → capability ID 오름차순.
 * 입력 순서와 무관하게 하나로 정해진다.
 */
export function selectPrimaryCapability(covers: readonly GapAssessment[], stack: number): GapAssessment {
  const ranked = [...covers].sort(
    (a, b) =>
      gapStateRank(b.state) - gapStateRank(a.state) ||
      priorityRank(b.priority) - priorityRank(a.priority) ||
      fitContribution(b, stack) - fitContribution(a, stack) ||
      (a.capability < b.capability ? -1 : a.capability > b.capability ? 1 : 0),
  );
  const first = ranked[0];
  if (first === undefined) throw new Error("covers가 비어 있는 tool은 추천 대상이 아닙니다");
  return first;
}

/** 추천 대상(recommended, covers 있음)의 Project Fit. incompatible·installed tool은 계산하지 않는다(undefined). */
export function computeProjectFit(evaluation: ToolEvaluation): { fit: ProjectFit; primary: GapAssessment } | undefined {
  if (evaluation.status !== "recommended" || evaluation.covers.length === 0) return undefined;
  const S = stackScore(evaluation);
  const primary = selectPrimaryCapability(evaluation.covers, S);
  const components: FitComponents = {
    needCoverage: Math.min(100, PRIORITY_WEIGHT[primary.priority] + 10 * (evaluation.covers.length - 1)),
    evidenceStrength: evidenceScore(primary),
    stackMatch: S,
    clientSupport: clientScore(evaluation),
    environment: environmentScore(evaluation),
  };
  const w = FIT_WEIGHTS;
  const score = Math.floor(
    (w.needCoverage * components.needCoverage +
      w.evidenceStrength * components.evidenceStrength +
      w.stackMatch * components.stackMatch +
      w.clientSupport * components.clientSupport +
      w.environment * components.environment +
      50) /
      100,
  );
  return { fit: { score, components }, primary };
}
