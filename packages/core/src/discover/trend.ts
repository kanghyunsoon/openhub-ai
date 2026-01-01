import type { MetadataSnapshot } from "../recommendation/metadata-snapshot";
import type { RegistryEntry } from "../registry/load";

/**
 * OpenHub Trend Score(TASK-061, D-035). 과거 star 증가율(star velocity)이 아니라 현재 popularity와 최근 release·repository activity를
 * 조합한 결정론 점수(정수 0~100)다. 보안·품질·신뢰 점수가 아니다.
 * - Popularity 최대 50 = min(50, floor(10 × log10(stars + 1))), shared-repo는 절반(내림)
 * - Release freshness 최대 25: 최신 release ≤30일 25, ≤90일 18, ≤180일 10, ≤365일 5, 그 외·없음 0
 * - Repository activity 최대 25: push ≤7일 25, ≤30일 18, ≤90일 10, ≤180일 5, 그 외 0
 * - 입력은 이미 수집한 metadata snapshot과 그 collectedAt(asOf)뿐이다. network·LLM·파일 쓰기 0, 결과는 메모리 값이다.
 * - archived는 제외, metadata가 없으면 score null(목록 끝). 정렬: score 내림차순 → stars 내림차순 → toolId 오름차순.
 */

export const TREND_SCORE_MEANING = "historical star growth가 아니라 현재 popularity와 최근 release/activity를 조합한 점수";
export const TREND_SCORE_MEANING_EN = "Not historical star growth: a deterministic score combining current popularity with recent release and repository activity. It does not rate security or code quality.";

export interface TrendComponents {
  popularity: number;
  releaseFreshness: number;
  repositoryActivity: number;
}
export interface TrendItem {
  toolId: string;
  repository: string;
  status: "scored" | "metadata-unavailable";
  score: number | null;
  components: TrendComponents | null;
  flags: "shared-repository"[];
  evidence: { stars: number; latestReleaseAt: string | null; pushedAt: string | null; asOf: string } | null;
}

const DAY = 86_400_000;
const ageDays = (iso: string | null, asOf: number): number | null => {
  if (iso === null) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((asOf - t) / DAY));
};
const step = (days: number | null, table: readonly (readonly [number, number])[]) => {
  if (days === null) return 0;
  for (const [limit, points] of table) if (days <= limit) return points;
  return 0;
};
export const RELEASE_FRESHNESS_TABLE = [[30, 25], [90, 18], [180, 10], [365, 5]] as const;
export const REPOSITORY_ACTIVITY_TABLE = [[7, 25], [30, 18], [90, 10], [180, 5]] as const;

export function popularityPoints(stars: number, sharedRepository: boolean): number {
  const full = Math.min(50, Math.floor(10 * Math.log10(Math.max(0, stars) + 1)));
  return sharedRepository ? Math.floor(full / 2) : full;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Registry Tool의 Trend 목록. draft·archived는 빠진다. */
export function trendingTools(entries: readonly RegistryEntry[], snapshot: MetadataSnapshot | undefined): TrendItem[] {
  const asOf = snapshot === undefined ? Number.NaN : Date.parse(snapshot.collectedAt);
  const items: (TrendItem & { stars: number })[] = [];
  for (const { manifest } of entries) {
    if (manifest.verification === "draft") continue;
    const repository = manifest.repository.github;
    const meta = snapshot?.repositories[repository];
    const shared = manifest.recommendation?.source?.type === "shared-repo";
    if (meta === undefined || Number.isNaN(asOf)) {
      items.push({ toolId: manifest.name, repository, status: "metadata-unavailable", score: null, components: null, flags: shared ? ["shared-repository"] : [], evidence: null, stars: -1 });
      continue;
    }
    if (meta.archived) continue;
    const latestReleaseAt = meta.latestRelease?.publishedAt ?? null;
    const components = {
      popularity: popularityPoints(meta.stars, shared),
      releaseFreshness: step(ageDays(latestReleaseAt, asOf), RELEASE_FRESHNESS_TABLE),
      repositoryActivity: step(ageDays(meta.pushedAt, asOf), REPOSITORY_ACTIVITY_TABLE),
    };
    items.push({
      toolId: manifest.name,
      repository,
      status: "scored",
      score: components.popularity + components.releaseFreshness + components.repositoryActivity,
      components,
      flags: shared ? ["shared-repository"] : [],
      evidence: { stars: meta.stars, latestReleaseAt, pushedAt: meta.pushedAt, asOf: snapshot!.collectedAt },
      stars: meta.stars,
    });
  }
  items.sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || b.stars - a.stars || cmp(a.toolId, b.toolId));
  return items.map(({ stars: _s, ...rest }) => rest);
}

/** 사람이 읽는 한 줄(근거 포함). */
export function formatTrendItem(item: TrendItem, rank: number): string {
  if (item.score === null || item.components === null || item.evidence === null) return String(rank) + ". " + item.toolId + " — metadata unavailable";
  const c = item.components;
  return (
    String(rank) + ". " + item.toolId + " — Trend " + String(item.score) +
    " (popularity " + String(c.popularity) + " · release " + String(c.releaseFreshness) + " · activity " + String(c.repositoryActivity) +
    "; stars " + String(item.evidence.stars) + ", release " + (item.evidence.latestReleaseAt?.slice(0, 10) ?? "없음") + ", push " + (item.evidence.pushedAt?.slice(0, 10) ?? "없음") +
    (item.flags.length > 0 ? ", shared-repository" : "") + ")"
  );
}

