import type { DiscoveryCandidate } from "../discovery/candidates";
import { addedAtOf, isoDateOf, type RegistryCatalog } from "../catalog/catalog";
import type { MetadataSnapshot } from "../recommendation/metadata-snapshot";
import type { RecommendationReport } from "../recommendation/report";
import type { RegistryEntry } from "../registry/load";
import { TREND_SCORE_MEANING, TREND_SCORE_MEANING_EN, trendingTools, type TrendItem } from "./trend";

/**
 * DiscoverView v1(TASK-062, D-035). DISCOVER 화면·CLI가 쓰는 메모리 값이다(network·file write 0).
 * - 네 구역을 섞지 않는다: newForProject·trending·verified는 Registry Tool(kind "registry-tool")만, candidates는 kind "candidate"만.
 * - NEW FOR YOUR PROJECT = catalog addedAt이 asOf 기준 90일 이내(null 제외) + verification ≠ draft + 설치·Version State 관리 중 아님
 *   + M3 RecommendationReport v1에서 confirmed-gap·likely-gap을 채우는 추천. 순서는 M3 순위(동점이면 addedAt 최신 순).
 *   M3 보고서는 입력으로만 읽고 바꾸지 않는다.
 * - Candidate는 항상 UNVERIFIED·DRAFT이고 할 수 있는 일은 보기·근거 보기·기여 패키지 준비뿐이다(Install·Adopt·Update 없음).
 *   Candidate 문자열(설명·설치 문구)은 untrustedText로만 전달한다.
 * - 이 모듈은 설치·adopt·lifecycle·benchmark 모듈을 import하지 않고, 그 모듈들도 이 모듈과 Candidate 모듈을 import하지 않는다.
 */

export const DISCOVER_VIEW_SCHEMA_VERSION = 1;
export const NEW_FOR_PROJECT_DAYS = 90;
export const CANDIDATE_BADGES = ["UNVERIFIED", "DRAFT"] as const;
export const CANDIDATE_ACTIONS = ["view", "evidence", "prepare-contribution"] as const;
export const REGISTRY_TOOL_ACTIONS = ["view", "install"] as const;

export interface RegistryToolItem {
  kind: "registry-tool";
  toolId: string;
  displayName: string;
  summary: string | null;
  categories: string[];
  repository: string;
  verification: "community" | "verified";
  addedAt: string | null;
  actions: (typeof REGISTRY_TOOL_ACTIONS)[number][];
}
export interface NewForProjectItem extends RegistryToolItem {
  addedAt: string;
  rank: number;
  primaryCapability: string;
  gapStates: ("confirmed-gap" | "likely-gap")[];
}
export interface TrendingViewItem extends TrendItem {
  kind: "registry-tool";
}
export interface CandidateItem {
  kind: "candidate";
  id: string;
  badges: (typeof CANDIDATE_BADGES)[number][];
  repository: string | null;
  package: { kind: "npm" | "pypi" | "docker"; name: string } | null;
  sources: string[];
  confidence: "high" | "medium" | "low";
  signals: { stars: number | null; updatedAt: string | null; archived: boolean | null };
  evidence: { source: string; ref: string }[];
  /** 비신뢰 데이터(표시 전용, 실행·설정·Plan에 쓰지 않는다) */
  untrustedText: { description: string | null; installText: string | null };
  discoveredAt: string;
  actions: (typeof CANDIDATE_ACTIONS)[number][];
}
export interface DiscoverViewV1 {
  schemaVersion: 1;
  kind: "openhub-discover-view";
  asOf: string;
  trendMeaning: { ko: string; en: string };
  metadataCollectedAt: string | null;
  sections: { newForProject: NewForProjectItem[]; trending: TrendingViewItem[]; verified: RegistryToolItem[]; candidates: CandidateItem[] };
}

export interface DiscoverViewInput {
  entries: readonly RegistryEntry[];
  catalog: RegistryCatalog | undefined;
  snapshot: MetadataSnapshot | undefined;
  /** 프로젝트 맞춤 추천(M3). 프로젝트가 없으면 undefined이고 NEW 구역은 비어 있다. */
  report: RecommendationReport | undefined;
  /** 이 프로젝트(와 opt-in user)의 Version State 관리 Tool ID */
  managedToolIds: readonly string[];
  candidates: readonly DiscoveryCandidate[];
  /** NEW 판정 기준일(주입). */
  asOf: Date;
}

const DAY = 86_400_000;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function toolItem(entry: RegistryEntry, catalog: RegistryCatalog | undefined): RegistryToolItem | null {
  const m = entry.manifest;
  if (m.verification === "draft") return null;
  return {
    kind: "registry-tool",
    toolId: m.name,
    displayName: m.displayName ?? m.name,
    summary: m.summary ?? null,
    categories: [...m.category],
    repository: m.repository.github,
    verification: m.verification,
    addedAt: addedAtOf(catalog, m.name),
    actions: [...REGISTRY_TOOL_ACTIONS],
  };
}

/** addedAt이 asOf 기준 0~90일(포함)인지. null·미래·형식 오류는 false다. */
export function isNewWithin(addedAt: string | null, asOf: Date, days = NEW_FOR_PROJECT_DAYS): boolean {
  if (addedAt === null) return false;
  const added = Date.parse(addedAt + "T00:00:00.000Z");
  const today = Date.parse(isoDateOf(asOf) + "T00:00:00.000Z");
  if (Number.isNaN(added)) return false;
  const age = Math.round((today - added) / DAY);
  return age >= 0 && age <= days;
}

function candidateItem(c: DiscoveryCandidate): CandidateItem {
  return {
    kind: "candidate",
    id: c.id,
    badges: [...CANDIDATE_BADGES],
    repository: c.repository,
    package: c.package === null ? null : { kind: c.package.kind, name: c.package.name },
    sources: [...c.sources],
    confidence: c.confidence,
    signals: { stars: c.signals.stars, updatedAt: c.signals.updatedAt, archived: c.signals.archived },
    evidence: c.evidence.map((e) => ({ source: e.source, ref: e.ref })),
    untrustedText: { description: c.signals.description, installText: c.untrustedInstallText },
    discoveredAt: c.discoveredAt,
    actions: [...CANDIDATE_ACTIONS],
  };
}

/** DISCOVER 네 구역을 만든다. 같은 입력이면 같은 값이다. */
export function buildDiscoverView(input: DiscoverViewInput): DiscoverViewV1 {
  const verified = input.entries
    .map((e) => toolItem(e, input.catalog))
    .filter((x): x is RegistryToolItem => x !== null)
    .sort((a, b) => cmp(a.toolId, b.toolId));
  const byId = new Map(verified.map((v) => [v.toolId, v]));

  const managed = new Set(input.managedToolIds);
  const installed = new Set((input.report?.installedTools ?? []).map((t) => t.toolId).filter((id): id is string => id !== null));
  const newForProject: NewForProjectItem[] = [];
  for (const rec of input.report?.recommendations ?? []) {
    const item = byId.get(rec.toolId);
    if (item === undefined || item.addedAt === null || managed.has(rec.toolId) || installed.has(rec.toolId)) continue;
    if (!isNewWithin(item.addedAt, input.asOf)) continue;
    const gapStates = [...new Set(rec.covers.map((c) => c.state).filter((s): s is "confirmed-gap" | "likely-gap" => s === "confirmed-gap" || s === "likely-gap"))].sort(cmp);
    if (gapStates.length === 0) continue;
    newForProject.push({ ...item, addedAt: item.addedAt, rank: rec.rank, primaryCapability: rec.primaryCapability, gapStates });
  }
  newForProject.sort((a, b) => a.rank - b.rank || cmp(b.addedAt, a.addedAt) || cmp(a.toolId, b.toolId));

  const trending = trendingTools(
    input.entries.filter((e) => byId.has(e.manifest.name)),
    input.snapshot,
  ).map((t) => ({ kind: "registry-tool" as const, ...t }));
  const candidates = [...input.candidates].map(candidateItem).sort((a, b) => cmp(a.id, b.id));
  return {
    schemaVersion: DISCOVER_VIEW_SCHEMA_VERSION,
    kind: "openhub-discover-view",
    asOf: isoDateOf(input.asOf),
    trendMeaning: { ko: TREND_SCORE_MEANING, en: TREND_SCORE_MEANING_EN },
    metadataCollectedAt: input.snapshot?.collectedAt ?? null,
    sections: { newForProject, trending, verified, candidates },
  };
}

