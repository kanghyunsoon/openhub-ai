import { z } from "zod";
import type { Manifest } from "../manifest/index";
import type { MetadataSnapshot } from "./metadata-snapshot";

/**
 * OpenScore(§6, D-009) — Repository Health Heuristic.
 * "Open-source repository의 유지관리 상태, 활동성, 커뮤니티 신호를 나타내는 deterministic heuristic"이다.
 * 보안성·악성 여부·코드 품질·기능 정확성·공급망 안전성·실제 사용 안정성을 의미하지 않는다.
 *
 *   OpenScore = floor((35·M + 20·R + 30·Cm + 15·L + 50) / 100)   archived이면 0, metadata 없으면 null
 *
 * 입력은 collector 필드(pushedAt, latestRelease.publishedAt, stars, forks, license, archived)와 Manifest의
 * shared-repo 여부뿐이며 Project Profile을 받지 않는다. 기준 시각은 snapshot collectedAt이다.
 */

export const OPEN_SCORE_KIND = "repository-health-heuristic" as const;
export const OPEN_SCORE_WEIGHTS = Object.freeze({ maintenance: 35, release: 20, community: 30, license: 15 });
export const OPEN_SCORE_FLAGS = ["shared-repository", "archived", "stale-release", "no-release", "license-unknown"] as const;
export type OpenScoreFlag = (typeof OPEN_SCORE_FLAGS)[number];

export const openScoreSchema = z.strictObject({
  kind: z.literal(OPEN_SCORE_KIND),
  score: z.number().min(0).max(1).nullable(),
  status: z.enum(["ok", "unavailable"]),
  components: z
    .strictObject({ maintenance: z.number().min(0).max(1), release: z.number().min(0).max(1), community: z.number().min(0).max(1), license: z.number().min(0).max(1) })
    .nullable(),
  flags: z.array(z.enum(OPEN_SCORE_FLAGS)),
});

export interface OpenScoreComponents {
  maintenance: number;
  release: number;
  community: number;
  license: number;
}

/** 0~100 정수 결과. 보고서에는 0.00~1.00으로 바꿔 담는다. */
export interface OpenScoreResult {
  kind: typeof OPEN_SCORE_KIND;
  score: number | null;
  status: "ok" | "unavailable";
  components: OpenScoreComponents | null;
  flags: OpenScoreFlag[];
}

/** 추천 이유(TASK-023)에 쓰는 원신호. 보고서에는 그대로 담지 않는다. */
export interface RepositorySignals {
  repository: string;
  pushedDays: number | null;
  releaseDays: number | null;
  stars: number;
  forks: number;
  license: string | null;
  archived: boolean;
  sharedRepository: boolean;
}

const DAY_MS = 86_400_000;

export function elapsedDays(referenceMs: number, iso: string | null): number | null {
  if (iso === null) return null;
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return null;
  return Math.max(0, Math.floor((referenceMs - at) / DAY_MS));
}

export function maintenanceStep(days: number | null): number {
  if (days === null) return 0;
  return days <= 30 ? 100 : days <= 90 ? 80 : days <= 180 ? 50 : days <= 365 ? 25 : 0;
}

export function releaseStep(days: number | null): number {
  if (days === null) return 10;
  return days <= 90 ? 100 : days <= 180 ? 70 : days <= 365 ? 40 : 20;
}

/** stars는 선형으로 쓰지 않고 로그 성격의 단계표로 바꾼다. */
export function starsStep(stars: number): number {
  return stars >= 50_000 ? 100 : stars >= 20_000 ? 90 : stars >= 10_000 ? 80 : stars >= 5_000 ? 70 : stars >= 1_000 ? 55 : stars >= 100 ? 35 : 15;
}

export function forksStep(forks: number): number {
  return forks >= 5_000 ? 100 : forks >= 1_000 ? 80 : forks >= 100 ? 50 : 20;
}

const UNAVAILABLE: OpenScoreResult = Object.freeze({ kind: OPEN_SCORE_KIND, score: null, status: "unavailable", components: null, flags: [] }) as OpenScoreResult;

export function computeOpenScore(manifest: Manifest, snapshot: MetadataSnapshot | undefined): { openScore: OpenScoreResult; signals: RepositorySignals | null } {
  const repository = manifest.repository.github;
  const meta = snapshot?.repositories[repository];
  const reference = snapshot === undefined ? Number.NaN : Date.parse(snapshot.collectedAt);
  if (meta === undefined || Number.isNaN(reference)) return { openScore: { ...UNAVAILABLE, flags: [] }, signals: null };

  const shared = manifest.recommendation?.source?.type === "shared-repo";
  const pushedDays = elapsedDays(reference, meta.pushedAt);
  const releaseDays = meta.latestRelease === null ? null : elapsedDays(reference, meta.latestRelease.publishedAt);
  const fullCommunity = Math.floor((4 * starsStep(meta.stars) + forksStep(meta.forks)) / 5);
  const components: OpenScoreComponents = {
    maintenance: maintenanceStep(pushedDays),
    release: releaseStep(releaseDays),
    community: shared ? Math.floor(fullCommunity / 2) : fullCommunity,
    license: meta.license === null ? 30 : 100,
  };
  const flags: OpenScoreFlag[] = [];
  if (shared) flags.push("shared-repository");
  if (meta.archived) flags.push("archived");
  if (releaseDays !== null && releaseDays > 365) flags.push("stale-release");
  if (meta.latestRelease === null) flags.push("no-release");
  if (meta.license === null) flags.push("license-unknown");
  const w = OPEN_SCORE_WEIGHTS;
  const score = meta.archived
    ? 0
    : Math.floor((w.maintenance * components.maintenance + w.release * components.release + w.community * components.community + w.license * components.license + 50) / 100);
  return {
    openScore: { kind: OPEN_SCORE_KIND, score, status: "ok", components, flags },
    signals: { repository, pushedDays, releaseDays, stars: meta.stars, forks: meta.forks, license: meta.license, archived: meta.archived, sharedRepository: shared },
  };
}
