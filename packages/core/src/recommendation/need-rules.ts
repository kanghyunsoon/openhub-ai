import type { TechCategory } from "./taxonomy";

/**
 * Need Rules (D-010, taxonomyVersion 1): M2 tech ID → 필요한 Capability와 priority.
 * 고정 표만 쓰며 LLM·확률 모델로 필요를 추론하지 않는다. `git`만으로는 GitHub need를 만들지 않는다
 * (M2 Profile에는 원격 저장소가 GitHub라는 근거가 없다).
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
]);

const RANK: Readonly<Record<Priority, number>> = { high: 3, medium: 2, low: 1 };

export function priorityRank(p: Priority): number {
  return RANK[p];
}
