import { loadRegistry, readMetadataCache, formatRegistryIssue } from "@openhub/core";

/** Desktop 화면이 받는 Tool 한 줄. Core의 Manifest·메타데이터를 화면용으로 줄인 것이다. */
export interface ToolView {
  name: string;
  displayName: string;
  summary: string;
  categories: string[];
  targets: string[];
  repository: string;
  stars: number | null;
  latestRelease: string | null;
  archived: boolean;
}

export interface RegistryView {
  tools: ToolView[];
  issues: string[];
  metadataCollectedAt: string | null;
}

/**
 * Core Registry와 메타데이터 캐시로 화면 데이터를 만든다(Electron에 의존하지 않아 테스트 가능).
 * 정렬은 Star 내림차순이며, 이는 TRENDING/목록용이고 추천 순서가 아니다(CON-004, 추천은 M3).
 */
export async function buildRegistryView(registryDir: string, metadataFile: string): Promise<RegistryView> {
  const [{ entries, issues }, cache] = await Promise.all([loadRegistry(registryDir), readMetadataCache(metadataFile)]);
  const tools = entries.map(({ manifest: m }): ToolView => {
    const meta = cache?.repositories[m.repository.github];
    return {
      name: m.name,
      displayName: m.displayName ?? m.name,
      summary: m.summary ?? meta?.description ?? "",
      categories: m.category,
      targets: m.targets,
      repository: m.repository.github,
      stars: meta?.stars ?? null,
      latestRelease: meta?.latestRelease?.tag ?? null,
      archived: meta?.archived ?? false,
    };
  });
  tools.sort((a, b) => (b.stars ?? -1) - (a.stars ?? -1) || a.name.localeCompare(b.name));
  return { tools, issues: issues.map(formatRegistryIssue), metadataCollectedAt: cache?.collectedAt ?? null };
}
