import type { TechCategory } from "./taxonomy";

/**
 * Need Rules (D-010, taxonomyVersion 2): M2 tech ID → 필요한 Capability와 priority.
 * 고정 표만 쓰며 LLM·확률 모델로 필요를 추론하지 않는다. `git`만으로는 GitHub need를 만들지 않는다
 * (M2 Profile에는 원격 저장소가 GitHub라는 근거가 없다).
 * NR-01~08은 taxonomyVersion 1 그대로다. NR-09 이후는 v0.2.0 추가분이다(docs/specs/stack-coverage.md).
 * Jest·Vitest·Pytest는 이를 다루는 검증 도구가 Registry에 없어 규칙을 두지 않는다(결과 진단에 "연결 규칙 없음"으로 보인다).
 */

export const PRIORITIES = ["high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

export interface NeedRule {
  id: string;
  category: TechCategory;
  triggers: readonly string[];
  needs: readonly { capability: string; priority: Priority }[];
}

const WEB = ["react", "nextjs", "vue"] as const;

export const NEED_RULES: readonly NeedRule[] = Object.freeze([
  {
    id: "NR-01",
    category: "frameworks",
    triggers: WEB,
    needs: [
      { capability: "browser-automation", priority: "high" },
      { capability: "e2e-testing", priority: "high" },
      { capability: "performance-tracing", priority: "medium" },
      { capability: "network-inspection", priority: "medium" },
    ],
  },
  {
    id: "NR-02",
    category: "databases",
    triggers: ["postgresql", "mysql"],
    needs: [
      { capability: "db-schema-access", priority: "high" },
      { capability: "sql-query", priority: "high" },
      { capability: "query-tuning", priority: "medium" },
    ],
  },
  {
    id: "NR-03",
    category: "databases",
    triggers: ["sqlite"],
    needs: [
      { capability: "db-schema-access", priority: "high" },
      { capability: "sql-query", priority: "high" },
    ],
  },
  { id: "NR-04", category: "databases", triggers: ["mongodb"], needs: [{ capability: "db-schema-access", priority: "high" }] },
  {
    id: "NR-05",
    category: "infrastructure",
    triggers: ["github-actions"],
    needs: [
      { capability: "github-api", priority: "high" },
      { capability: "pull-request-review", priority: "medium" },
      { capability: "issue-tracking", priority: "medium" },
    ],
  },
  { id: "NR-06", category: "frameworks", triggers: [...WEB, "spring-boot", "fastapi"], needs: [{ capability: "library-docs", priority: "medium" }] },
  {
    id: "NR-07",
    category: "languages",
    triggers: ["typescript", "javascript", "python", "java", "csharp", "rust", "cpp"],
    needs: [
      { capability: "semantic-code-navigation", priority: "medium" },
      { capability: "code-editing", priority: "low" },
    ],
  },
  { id: "NR-08", category: "aiClients", triggers: ["claude-code", "codex", "cursor"], needs: [{ capability: "knowledge-graph-memory", priority: "low" }] },
  // taxonomyVersion 2
  {
    id: "NR-09",
    category: "languages",
    triggers: ["go"],
    needs: [
      { capability: "semantic-code-navigation", priority: "medium" },
      { capability: "code-editing", priority: "low" },
    ],
  },
  { id: "NR-10", category: "frameworks", triggers: ["express", "nestjs"], needs: [{ capability: "library-docs", priority: "medium" }] },
  {
    id: "NR-11",
    category: "frameworks",
    triggers: ["playwright"],
    needs: [
      { capability: "e2e-testing", priority: "high" },
      { capability: "browser-automation", priority: "medium" },
    ],
  },
  { id: "NR-12", category: "frameworks", triggers: ["unity", "unreal-engine"], needs: [{ capability: "game-engine-editor", priority: "high" }] },
  { id: "NR-13", category: "infrastructure", triggers: ["kubernetes"], needs: [{ capability: "kubernetes-operations", priority: "medium" }] },
]);

const RANK: Readonly<Record<Priority, number>> = { high: 3, medium: 2, low: 1 };

export function priorityRank(p: Priority): number {
  return RANK[p];
}
