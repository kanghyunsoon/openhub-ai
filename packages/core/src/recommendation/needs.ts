import type { ProjectProfile, Scope } from "../analyzer/index";
import { NEED_RULES, priorityRank, type NeedRule, type Priority } from "./need-rules";
import { capabilityLabel, type TechCategory } from "./taxonomy";

/**
 * ProjectProfile → Capability need (TASK-017).
 * "무슨 기술을 쓰는가"를 "어떤 AI Tool Capability가 필요한가"로 바꾼다. 설치 여부는 여기서 보지 않는다.
 */

export const STRENGTHS = ["strong", "environment", "weak"] as const;
/** Detection Confidence 해석: 1.0·0.9 strong, 0.8 environment(사용자 환경 존재), 0.6 이하 weak. */
export type Strength = (typeof STRENGTHS)[number];

export function strengthOf(confidence: number): Strength {
  if (confidence >= 0.9) return "strong";
  if (confidence >= 0.8) return "environment";
  return "weak";
}

const STRENGTH_RANK: Readonly<Record<Strength, number>> = { strong: 3, environment: 2, weak: 1 };
export function strengthRank(s: Strength): number {
  return STRENGTH_RANK[s];
}

export interface NeedSource {
  category: TechCategory;
  itemId: string;
  scope: Scope;
  confidence: number;
  strength: Strength;
}

export interface CapabilityNeed {
  capability: string;
  label: string;
  priority: Priority;
  /** sources 중 가장 강한 강도 */
  strength: Strength;
  /** 정렬: category 표 순서 → itemId → scope */
  sources: NeedSource[];
}

const CATEGORY_ORDER: readonly TechCategory[] = ["languages", "frameworks", "databases", "packageManagers", "infrastructure", "aiClients"];
const SCOPE_ORDER: Readonly<Record<Scope, number>> = { project: 0, user: 1 };

export function compareSources(a: NeedSource, b: NeedSource): number {
  return (
    CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) ||
    (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0) ||
    SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]
  );
}

/** Need Rules를 적용해 capability별 need를 만든다. 결과는 capability ID 오름차순이며 입력 배열 순서와 무관하다. */
export function deriveNeeds(profile: ProjectProfile, rules: readonly NeedRule[] = NEED_RULES): CapabilityNeed[] {
  const byCapability = new Map<string, { priority: Priority; sources: Map<string, NeedSource> }>();
  for (const rule of rules) {
    const items = profile[rule.category];
    for (const item of items) {
      if (!rule.triggers.includes(item.id)) continue;
      const source: NeedSource = { category: rule.category, itemId: item.id, scope: item.scope, confidence: item.confidence, strength: strengthOf(item.confidence) };
      for (const need of rule.needs) {
        const entry = byCapability.get(need.capability) ?? { priority: need.priority, sources: new Map<string, NeedSource>() };
        if (priorityRank(need.priority) > priorityRank(entry.priority)) entry.priority = need.priority;
        entry.sources.set(`${source.category}\u0000${source.itemId}\u0000${source.scope}`, source);
        byCapability.set(need.capability, entry);
      }
    }
  }
  return [...byCapability.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([capability, { priority, sources }]) => {
      const sorted = [...sources.values()].sort(compareSources);
      const strength = sorted.reduce<Strength>((best, s) => (strengthRank(s.strength) > strengthRank(best) ? s.strength : best), "weak");
      return { capability, label: capabilityLabel(capability), priority, strength, sources: sorted };
    });
}
