import { createHash } from "node:crypto";
import { PROFILE_CATEGORIES, type ProjectProfile } from "../analyzer/index";
import type { RegistryEntry } from "../registry/index";
import { matchCandidates, type ToolEvaluation } from "./candidates";
import type { RecommendContext } from "./compatibility";
import { explainNeed, explainRecommendation } from "./explain";
import { computeProjectFit, fitContribution, stackScore } from "./fit";
import { assessProfile, classifyGaps, type GapAssessment } from "./gaps";
import { resolveInstalledTools, strongIdentityNotes, type IdentityHint } from "./installed";
import type { MetadataSnapshot } from "./metadata-snapshot";
import { deriveNeeds } from "./needs";
import { computeOpenScore } from "./open-score";
import { rankRecommendations } from "./rank";
import { REPORT_SCHEMA_VERSION, recommendationReportSchema, redactSensitive, type Recommendation, type RecommendationReport } from "./report";
import { TAXONOMY_VERSION } from "./taxonomy";

/**
 * M3 Recommendation Engine 진입점. 순수 함수이며 설치·네트워크·process.env 접근이 없다.
 * ProjectProfile + curated Registry + metadata snapshot + RecommendContext(plain data) → RecommendationReport v1.
 */

const ratio = (n: number) => n / 100;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Registry 내용의 digest(파일 위치·순서와 무관). */
export function registryDigest(entries: readonly RegistryEntry[]): string {
  const manifests = [...entries].sort((a, b) => cmp(a.manifest.name, b.manifest.name)).map((e) => e.manifest);
  return `sha256:${createHash("sha256").update(JSON.stringify(manifests)).digest("hex")}`;
}

function deepRedact<T>(value: T): T {
  if (typeof value === "string") return redactSensitive(value) as T;
  if (Array.isArray(value)) return value.map(deepRedact) as T;
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, deepRedact(v)])) as T;
  return value;
}

const CATEGORY_ORDER: readonly string[] = PROFILE_CATEGORIES;

function withIdentityNotes<T extends { warnings: { code: string; message: string }[] }>(assessment: T, notes: readonly { code: string; message: string }[]): T {
  if (notes.length === 0) return assessment;
  return { ...assessment, warnings: [...assessment.warnings, ...notes].sort((a, b) => cmp(a.code, b.code) || cmp(a.message, b.message)) };
}

function evidenceOf(profile: ProjectProfile, covers: readonly GapAssessment[]): Recommendation["evidence"] {
  const out = new Map<string, Recommendation["evidence"][number]>();
  for (const gap of covers) {
    for (const s of gap.sources) {
      const item = profile[s.category].find((i) => i.id === s.itemId && i.scope === s.scope);
      for (const e of item?.evidence ?? []) {
        const row = { category: s.category, itemId: s.itemId, scope: s.scope, file: e.file, type: e.type, value: e.value };
        out.set(JSON.stringify(row), row);
      }
    }
  }
  return [...out.values()].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category) || cmp(a.itemId, b.itemId) || cmp(a.scope, b.scope) || cmp(a.file, b.file) || cmp(a.type, b.type) || cmp(a.value, b.value),
  );
}

function compatibilityOf(e: ToolEvaluation): Recommendation["compatibility"] {
  const c = e.compatibility;
  return {
    overall: c.overall === "compatible" ? "compatible" : "unverified",
    clients: { status: c.clients.status, detected: c.clients.detected as Recommendation["compatibility"]["clients"]["detected"], supported: c.clients.supported as Recommendation["compatibility"]["clients"]["supported"] },
    platform: { status: c.platform.status, value: c.platform.value },
    runtime: { status: c.runtime.status, requirements: { ...c.runtime.requirements } },
    backend: { status: c.backend.status, options: [...c.backend.options] },
  };
}

export interface RecommendOptions {
  /** Identity Fingerprint 결과(D-026, 선택). exact·strong만 쓴다. 없으면 M3와 같다. */
  identityHints?: readonly IdentityHint[];
}

export function recommend(profile: ProjectProfile, entries: readonly RegistryEntry[], snapshot: MetadataSnapshot | undefined, context: RecommendContext = {}, options: RecommendOptions = {}): RecommendationReport {
  const hints = options.identityHints ?? [];
  const installed = resolveInstalledTools(profile, entries, hints);
  const gaps = classifyGaps(profile, deriveNeeds(profile), installed);
  const match = matchCandidates(profile, gaps, installed, entries, context);

  const ranked = rankRecommendations(
    match.tools.map((evaluation) => {
      const result = computeProjectFit(evaluation);
      if (result === undefined) throw new Error("추천 대상의 Project Fit을 계산할 수 없습니다");
      const open = computeOpenScore(evaluation.entry.manifest, snapshot);
      return { evaluation, primary: result.primary, fit: result.fit, openScore: open.openScore, signals: open.signals };
    }),
  );

  const recommendations: Recommendation[] = ranked.map((r, i) => {
    const { manifest } = r.evaluation.entry;
    const S = stackScore(r.evaluation);
    const comps = r.fit.components;
    const o = r.openScore;
    return {
      rank: i + 1,
      toolId: manifest.name,
      displayName: manifest.displayName ?? manifest.name,
      primaryCapability: r.primary.capability,
      covers: [...r.evaluation.covers]
        .sort((a, b) => cmp(a.capability, b.capability))
        .map((g) => ({ capability: g.capability, state: g.state, priority: g.priority, fitContribution: ratio(fitContribution(g, S)) })),
      projectFit: {
        score: ratio(r.fit.score),
        components: {
          needCoverage: ratio(comps.needCoverage),
          evidenceStrength: ratio(comps.evidenceStrength),
          stackMatch: ratio(comps.stackMatch),
          clientSupport: ratio(comps.clientSupport),
          environment: ratio(comps.environment),
        },
      },
      openScore: {
        kind: o.kind,
        score: o.score === null ? null : ratio(o.score),
        status: o.status,
        components:
          o.components === null
            ? null
            : { maintenance: ratio(o.components.maintenance), release: ratio(o.components.release), community: ratio(o.components.community), license: ratio(o.components.license) },
        flags: [...o.flags],
      },
      compatibility: compatibilityOf(r.evaluation),
      installation: { status: r.evaluation.installation.status, inspectedScopes: [...r.evaluation.installation.inspectedScopes] },
      conflicts: r.evaluation.conflicts.map((c) => ({ type: c.type, capability: c.capability, with: { toolId: c.with.toolId, serverName: c.with.serverName, scope: c.with.scope } })),
      setup: { requiredEnv: [...r.evaluation.requiredEnv] },
      reasons: explainRecommendation({ profile, evaluation: r.evaluation, primary: r.primary, installed, openScore: r.openScore, signals: r.signals }),
      evidence: evidenceOf(profile, r.evaluation.covers),
    };
  });

  const report: RecommendationReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    generatedFrom: {
      profileSchemaVersion: 1,
      taxonomyVersion: TAXONOMY_VERSION,
      registryDigest: registryDigest(entries),
      metadataCollectedAt: snapshot?.collectedAt ?? null,
    },
    project: { name: profile.project.name },
    assessment: withIdentityNotes(assessProfile(profile, installed), strongIdentityNotes(profile, entries, hints)),
    installedTools: installed,
    needs: gaps.map((g) => {
      const candidates = match.candidates.get(g.capability) ?? [];
      return {
        capability: g.capability,
        label: g.label,
        priority: g.priority,
        state: g.state,
        stateReasons: [...g.stateReasons],
        sources: g.sources.map((s) => ({ category: s.category, itemId: s.itemId, scope: s.scope, confidence: s.confidence, strength: s.strength })),
        satisfiedBy: g.satisfiedBy.map((s) => ({ toolId: s.toolId, serverName: s.serverName, scope: s.scope })),
        candidates: candidates.map((c) => (c.excludedBy === undefined ? { toolId: c.toolId, status: c.status } : { toolId: c.toolId, status: c.status, excludedBy: [...c.excludedBy] })),
        reasons: explainNeed(g, candidates),
      };
    }),
    recommendations,
  };
  const safe = deepRedact(report);
  recommendationReportSchema.parse(safe);
  return safe;
}
