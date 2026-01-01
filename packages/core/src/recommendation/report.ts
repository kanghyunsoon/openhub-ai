import { z } from "zod";
import { AI_CLIENT_IDS, DETECTOR_STATUSES, EVIDENCE_TYPES, SCOPES, containsAbsolutePath } from "../analyzer/index";
import { CANDIDATE_STATUSES } from "./candidates";
import { COMPATIBILITY_STATUSES, EXCLUSION_CODES, RECOMMEND_PLATFORMS } from "./compatibility";
import { GAP_STATES, STATE_REASONS } from "./gaps";
import { INSTALLATION_STATUSES, installedToolSchema } from "./installed";
import { PRIORITIES } from "./need-rules";
import { STRENGTHS } from "./needs";
import { REASON_CODES } from "./explain";
import { openScoreSchema } from "./open-score";
import { TAXONOMY_VERSION } from "./taxonomy";

/**
 * RecommendationReport v1(§ schema). M3의 외부 계약이며 M4 Installer·Desktop이 이 형식만 읽는다.
 * - 점수는 0.00~1.00(내부 0~100 정수 ÷ 100). Project Fit과 OpenScore를 합친 필드는 없다.
 * - 생성 시각이 없고 같은 입력은 바이트 단위로 같다.
 * - 절대 경로·URL credential·token 형태 문자열을 담을 수 없다(M2 보안 계약).
 */

export const REPORT_SCHEMA_VERSION = 1;

const ratio = z.number().min(0).max(1);
const id = z.string().min(1).max(100);
const scope = z.enum(SCOPES);

export const reasonSchema = z.strictObject({
  code: z.enum(REASON_CODES),
  message: z.string().min(1).max(600),
  refs: z.array(z.string().min(1).max(300)).min(1),
});

const status = z.enum(COMPATIBILITY_STATUSES);

export const recommendationSchema = z.strictObject({
  rank: z.number().int().min(1),
  toolId: id,
  displayName: z.string().min(1).max(200),
  primaryCapability: id,
  covers: z.array(z.strictObject({ capability: id, state: z.enum(GAP_STATES), priority: z.enum(PRIORITIES), fitContribution: ratio })).min(1),
  projectFit: z.strictObject({
    score: ratio,
    components: z.strictObject({ needCoverage: ratio, evidenceStrength: ratio, stackMatch: ratio, clientSupport: ratio, environment: ratio }),
  }),
  openScore: openScoreSchema,
  compatibility: z.strictObject({
    overall: z.enum(["compatible", "unverified"]),
    clients: z.strictObject({ status, detected: z.array(z.enum(AI_CLIENT_IDS)), supported: z.array(z.enum(AI_CLIENT_IDS)) }),
    platform: z.strictObject({ status, value: z.enum(RECOMMEND_PLATFORMS).nullable() }),
    runtime: z.strictObject({ status, requirements: z.strictObject({ node: z.string().optional(), python: z.string().optional() }) }),
    backend: z.strictObject({ status, options: z.array(z.string().min(1).max(40)) }),
  }),
  installation: z.strictObject({ status: z.enum(INSTALLATION_STATUSES), inspectedScopes: z.array(scope).min(1) }),
  conflicts: z.array(z.strictObject({ type: z.literal("capability-overlap"), capability: id, with: z.strictObject({ toolId: id.nullable(), serverName: id, scope }) })),
  setup: z.strictObject({ requiredEnv: z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/u)) }),
  reasons: z.array(reasonSchema).min(1),
  evidence: z.array(
    z.strictObject({ category: id, itemId: id, scope, file: z.string().min(1).max(300), type: z.enum(EVIDENCE_TYPES), value: z.string().min(1).max(200) }),
  ),
});

export const needReportSchema = z.strictObject({
  capability: id,
  label: z.string().min(1).max(100),
  priority: z.enum(PRIORITIES),
  state: z.enum(GAP_STATES),
  stateReasons: z.array(z.enum(STATE_REASONS)),
  sources: z.array(z.strictObject({ category: id, itemId: id, scope, confidence: z.number().min(0).max(1), strength: z.enum(STRENGTHS) })),
  satisfiedBy: z.array(z.strictObject({ toolId: id, serverName: id, scope })),
  candidates: z.array(z.strictObject({ toolId: id, status: z.enum(CANDIDATE_STATUSES), excludedBy: z.array(z.enum(EXCLUSION_CODES)).optional() })),
  reasons: z.array(reasonSchema),
});

/** URL에 담긴 계정·비밀번호, 대표적인 token 형태. 보고서 문자열에 있으면 안 된다. */
export const URL_CREDENTIAL_PATTERN = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/u;
export const TOKEN_PATTERN = /\b(?:ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|xox[abpr]-[A-Za-z0-9-]{10,})\b/u;

function strings(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: string }[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...path, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...path, k]));
  return [];
}

export const recommendationReportSchema = z
  .strictObject({
    schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
    generatedFrom: z.strictObject({
      profileSchemaVersion: z.literal(1),
      taxonomyVersion: z.literal(TAXONOMY_VERSION),
      registryDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
      metadataCollectedAt: z.string().nullable(),
    }),
    project: z.strictObject({ name: z.string().min(1).max(255) }),
    assessment: z.strictObject({
      inspectedScopes: z.array(scope).min(1),
      coverage: z.array(z.strictObject({ detector: id, status: z.enum(DETECTOR_STATUSES) })),
      unresolvedInstalledTools: z.number().int().min(0),
      warnings: z.array(z.strictObject({ code: id, message: z.string().min(1).max(300) })),
    }),
    installedTools: z.array(installedToolSchema),
    needs: z.array(needReportSchema),
    recommendations: z.array(recommendationSchema),
  })
  .superRefine((report, ctx) => {
    for (const found of strings(report)) {
      const problem = containsAbsolutePath(found.value)
        ? "절대 경로"
        : URL_CREDENTIAL_PATTERN.test(found.value)
          ? "URL credential"
          : TOKEN_PATTERN.test(found.value)
            ? "token"
            : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: `보고서에 ${problem}이(가) 포함될 수 없습니다` });
    }
  });

export type RecommendationReport = z.output<typeof recommendationReportSchema>;
export type Recommendation = z.output<typeof recommendationSchema>;
export type NeedReport = z.output<typeof needReportSchema>;

/** 보고서 문자열에서 URL credential·token을 가린다(방어적 처리). 절대 경로가 든 문자열은 통째로 가린다. */
export function redactSensitive(text: string): string {
  if (containsAbsolutePath(text)) return "[redacted]";
  return text
    .replace(new RegExp(URL_CREDENTIAL_PATTERN.source, "gu"), (m) => m.slice(0, m.indexOf("://") + 3) + "[redacted]@")
    .replace(new RegExp(TOKEN_PATTERN.source, "gu"), "[redacted]");
}

/** 검증 후 안정 직렬화(2칸 들여쓰기 + 개행). 키 순서는 보고서 생성 순서(스키마 순서)를 따른다. */
export function serializeRecommendationReport(report: RecommendationReport): string {
  recommendationReportSchema.parse(report);
  return JSON.stringify(report, null, 2) + "\n";
}
