/**
 * Capability Taxonomy (D-010, taxonomyVersion 2).
 *
 * Registry Manifest의 capabilities와 Gap 판정이 같은 기준 ID를 쓰도록 하는 코드 표다.
 * 현재 seed가 쓰는 capability ID 14개를 이름 변경 없이 표준 ID로 채택했다.
 * 표를 바꾸면 TAXONOMY_VERSION을 올리고 golden을 갱신한다.
 * 이 파일은 다른 recommendation·registry 모듈을 import하지 않는다(registry 검증이 이 표를 쓴다).
 *
 * taxonomyVersion 2(v0.2.0, docs/specs/stack-coverage.md): v1의 capability 14개·tech ID는 ID와 의미를 그대로 두고
 * 뒤에 추가만 했다. capability 2개(game-engine-editor, kubernetes-operations), tech ID 10개(go, express, nestjs,
 * jest, vitest, pytest, playwright, unity, unreal-engine, kubernetes). taxonomyVersion 1 보고서는 schema에서 거부한다.
 */

export const TAXONOMY_VERSION = 2;

export const CAPABILITY_DOMAINS = ["browser", "testing", "docs", "vcs-collab", "memory", "database", "code-intelligence", "game-dev", "infrastructure"] as const;
export type CapabilityDomain = (typeof CAPABILITY_DOMAINS)[number];

export interface CapabilityDefinition {
  id: string;
  label: string;
  domain: CapabilityDomain;
}

export const CAPABILITIES: readonly CapabilityDefinition[] = Object.freeze([
  { id: "browser-automation", label: "브라우저 자동화", domain: "browser" },
  { id: "performance-tracing", label: "성능 추적", domain: "browser" },
  { id: "network-inspection", label: "네트워크 검사", domain: "browser" },
  { id: "e2e-testing", label: "E2E 테스트", domain: "testing" },
  { id: "library-docs", label: "라이브러리 문서 조회", domain: "docs" },
  { id: "github-api", label: "GitHub API", domain: "vcs-collab" },
  { id: "issue-tracking", label: "이슈 관리", domain: "vcs-collab" },
  { id: "pull-request-review", label: "PR 리뷰", domain: "vcs-collab" },
  { id: "knowledge-graph-memory", label: "지식 그래프 메모리", domain: "memory" },
  { id: "db-schema-access", label: "DB 스키마 조회", domain: "database" },
  { id: "sql-query", label: "SQL 질의", domain: "database" },
  { id: "query-tuning", label: "쿼리 튜닝", domain: "database" },
  { id: "semantic-code-navigation", label: "의미 기반 코드 탐색", domain: "code-intelligence" },
  { id: "code-editing", label: "코드 편집", domain: "code-intelligence" },
  // taxonomyVersion 2
  { id: "game-engine-editor", label: "게임 엔진 에디터 연동", domain: "game-dev" },
  { id: "kubernetes-operations", label: "Kubernetes 클러스터 조작", domain: "infrastructure" },
]);

const BY_ID: ReadonlyMap<string, CapabilityDefinition> = new Map(CAPABILITIES.map((c) => [c.id, c]));

export function isCapabilityId(id: string): boolean {
  return BY_ID.has(id);
}

/** taxonomy에 없는 ID는 ID 그대로 돌려준다. */
export function capabilityLabel(id: string): string {
  return BY_ID.get(id)?.label ?? id;
}

/**
 * M2 Detector가 만들 수 있는 tech ID(ProjectProfile 카테고리별).
 * Need Rule trigger와 Manifest `recommendation.appliesTo.stacks`는 이 집합 안의 값만 쓸 수 있다.
 */
export const KNOWN_TECH_IDS = Object.freeze({
  languages: Object.freeze(["typescript", "javascript", "python", "java", "csharp", "rust", "cpp", "go"]),
  // 테스트 프레임워크·게임 엔진도 ProjectProfile의 frameworks 카테고리에 둔다(Profile 필드를 늘리지 않는다).
  frameworks: Object.freeze(["react", "nextjs", "vue", "spring-boot", "fastapi", "express", "nestjs", "jest", "vitest", "pytest", "playwright", "unity", "unreal-engine"]),
  databases: Object.freeze(["postgresql", "mysql", "sqlite", "mongodb"]),
  packageManagers: Object.freeze(["pnpm", "npm", "yarn", "bun", "pip", "uv", "maven", "gradle", "cargo"]),
  infrastructure: Object.freeze(["docker", "docker-compose", "github-actions", "git", "kubernetes"]),
  aiClients: Object.freeze(["claude-code", "codex", "cursor"]),
} as const);
export type TechCategory = keyof typeof KNOWN_TECH_IDS;

/** Manifest `appliesTo.stacks`에 쓸 수 있는 tech ID(AI Client 제외). */
export const STACK_CATEGORIES: readonly TechCategory[] = Object.freeze(["languages", "frameworks", "databases", "packageManagers", "infrastructure"]);

export function isStackTechId(id: string): boolean {
  return STACK_CATEGORIES.some((c) => (KNOWN_TECH_IDS[c] as readonly string[]).includes(id));
}
