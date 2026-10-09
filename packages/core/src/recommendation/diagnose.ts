import type { ProjectProfile } from "../analyzer/index";
import { NEED_RULES, type NeedRule } from "./need-rules";
import type { RecommendationReport } from "./report";
import type { TechCategory } from "./taxonomy";

/**
 * 추천 결과 진단(v0.2.0 P0-1). RecommendationReport v1을 바꾸지 않고, 결과가 왜 비었거나 일부 기술이
 * 추천으로 이어지지 않았는지를 사용자에게 설명하기 위한 파생 정보다. 보고서에 저장하지 않는다.
 *
 * - emptyReason: 추천이 0개일 때만 값이 있다.
 *   - no-stack-detected: 언어·프레임워크·DB·인프라를 하나도 인식하지 못했다.
 *   - no-mapped-need: 기술은 인식했지만 어떤 Need Rule에도 연결되지 않았다.
 *   - no-verified-tool: 충족되지 않은 need 모두에 대해 Verified Registry 후보 도구가 없다.
 *   - all-satisfied: 모든 need가 이미 설치된 도구로 충족됐다.
 *   - candidates-excluded: 후보는 있지만 호환성·설치 상태로 모두 제외됐다.
 * - unmappedTechs: 인식했지만 Need Rule이 없는 기술 ID(오름차순). 패키지 관리자, 의도적으로 need를 만들지 않는 git,
 *   실행 환경 정보인 Docker·Docker Compose는 제외한다. 이것들만 있고 추천이 비면 emptyReason(no-mapped-need)은 그대로 보인다.
 * - needsWithoutVerifiedTool: 충족되지 않았고 Registry 후보가 0개인 capability(오름차순).
 */
export const EMPTY_REASONS = ["no-stack-detected", "no-mapped-need", "no-verified-tool", "all-satisfied", "candidates-excluded"] as const;
export type EmptyReason = (typeof EMPTY_REASONS)[number];

export interface RecommendationDiagnosis {
  emptyReason: EmptyReason | null;
  unmappedTechs: string[];
  needsWithoutVerifiedTool: string[];
}

const STACK_CATEGORIES: readonly TechCategory[] = ["languages", "frameworks", "databases", "infrastructure"];
const DIAGNOSED_CATEGORIES: readonly TechCategory[] = [...STACK_CATEGORIES, "aiClients"];
/**
 * 연결 규칙이 없는 것이 정상인 기술. 진단 목록에서 뺀다.
 * - git: D-010, git만으로 GitHub need를 만들지 않는다.
 * - docker, docker-compose: 실행 환경 정보다. 컨테이너 조작 capability가 taxonomy에 생기면 다시 본다.
 */
const INTENTIONALLY_UNMAPPED: ReadonlySet<string> = new Set(["git", "docker", "docker-compose"]);

const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function diagnoseRecommendation(profile: ProjectProfile, report: RecommendationReport, rules: readonly NeedRule[] = NEED_RULES): RecommendationDiagnosis {
  const mapped = new Set(rules.flatMap((r) => r.triggers.map((t) => r.category + "\u0000" + t)));
  const unmapped = new Set<string>();
  for (const category of DIAGNOSED_CATEGORIES) {
    for (const item of profile[category]) {
      if (INTENTIONALLY_UNMAPPED.has(item.id) || mapped.has(category + "\u0000" + item.id)) continue;
      unmapped.add(item.id);
    }
  }
  const open = report.needs.filter((n) => n.state !== "satisfied");
  const needsWithoutVerifiedTool = open.filter((n) => n.candidates.length === 0).map((n) => n.capability).sort(byCode);

  let emptyReason: EmptyReason | null = null;
  if (report.recommendations.length === 0) {
    const stackCount = STACK_CATEGORIES.reduce((sum, c) => sum + profile[c].length, 0);
    if (report.needs.length === 0) emptyReason = stackCount === 0 ? "no-stack-detected" : "no-mapped-need";
    else if (open.length === 0) emptyReason = "all-satisfied";
    else if (needsWithoutVerifiedTool.length === open.length) emptyReason = "no-verified-tool";
    else emptyReason = "candidates-excluded";
  }
  return { emptyReason, unmappedTechs: [...unmapped].sort(byCode), needsWithoutVerifiedTool };
}
