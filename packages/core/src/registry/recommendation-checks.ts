import { TAXONOMY_VERSION, isCapabilityId, isStackTechId } from "../recommendation/taxonomy";
import type { RegistryEntry, RegistryIssue } from "./load";

/**
 * Manifest 단위 검증이 끝난 Registry 항목에 Recommendation 메타데이터 규칙을 적용한다(D-008·D-010).
 *
 * - capabilities는 Capability Taxonomy에 있어야 한다.
 * - recommendation.appliesTo.stacks는 M2 tech ID여야 한다.
 * - canonical alias(recommendation.identity.mcpServerNames)는 Registry 전체에서 대소문자 무시 기준으로 유일해야 한다.
 *   중복이면 이름순으로 뒤에 오는 Manifest를 제외하고 오류로 보고한다.
 * 규칙을 어긴 항목은 entries에서 빼고 issues로만 보고한다(예외를 던지지 않는다).
 */
export function checkRecommendationMetadata(entries: readonly RegistryEntry[]): { entries: RegistryEntry[]; issues: RegistryIssue[] } {
  const issues: RegistryIssue[] = [];
  const kept: RegistryEntry[] = [];
  const aliasOwner = new Map<string, string>();
  const sorted = [...entries].sort((a, b) => (a.manifest.name < b.manifest.name ? -1 : a.manifest.name > b.manifest.name ? 1 : 0));
  for (const entry of sorted) {
    const { manifest, file } = entry;
    const before = issues.length;
    manifest.capabilities.forEach((capability, i) => {
      if (!isCapabilityId(capability)) {
        issues.push({ file, path: `capabilities[${i}]`, message: `Capability Taxonomy(taxonomyVersion ${TAXONOMY_VERSION})에 없는 capability입니다: ${capability}` });
      }
    });
    (manifest.recommendation?.appliesTo?.stacks ?? []).forEach((stack, i) => {
      if (!isStackTechId(stack)) {
        issues.push({ file, path: `recommendation.appliesTo.stacks[${i}]`, message: `M2 tech ID가 아닌 stack입니다: ${stack}` });
      }
    });
    const claimed: string[] = [];
    (manifest.recommendation?.identity?.mcpServerNames ?? []).forEach((alias, i) => {
      const key = alias.toLowerCase();
      const owner = aliasOwner.get(key) ?? (claimed.includes(key) ? manifest.name : undefined);
      if (owner !== undefined) {
        issues.push({
          file,
          path: `recommendation.identity.mcpServerNames[${i}]`,
          message: `canonical alias '${alias}'가 ${owner}와 ${manifest.name}에 중복됩니다(대소문자 무시 기준으로 Registry 전체에서 유일해야 합니다)`,
        });
        return;
      }
      claimed.push(key);
    });
    if (issues.length > before) continue;
    for (const key of claimed) aliasOwner.set(key, manifest.name);
    kept.push(entry);
  }
  return { entries: kept, issues };
}
