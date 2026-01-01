import { z } from "zod";

/**
 * Project Profile 계약(M2의 최종 산출물). M3 Recommendation은 이 결과만 입력으로 쓴다.
 *
 * - confidence는 확률이 아니라 Detection Confidence다: 현재 Evidence가 해당 기술의 존재를
 *   얼마나 강하게 지지하는지를 고정 가중치 표의 최댓값으로 나타낸 결정적 점수다.
 * - 모든 탐지 항목은 scope("project" | "user")를 가진다. 병합 키는 (카테고리, id, scope[, kind])다.
 * - 결과 어디에도 절대 경로를 담지 않는다.
 */

export const PROFILE_SCHEMA_VERSION = 1;

export const SCOPES = ["project", "user"] as const;
export type Scope = (typeof SCOPES)[number];

export const EVIDENCE_TYPES = [
  "dependency",
  "build-plugin",
  "config",
  "manifest",
  "docker-image",
  "lockfile",
  "executable",
  "file-presence",
  "extension-count",
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

/** Detection Confidence 가중치(명세 m2-project-analyzer.md 표). 이 표 외의 방법으로 confidence를 만들지 않는다. */
export const EVIDENCE_WEIGHTS: Readonly<Record<EvidenceType, number>> = Object.freeze({
  dependency: 1.0,
  "build-plugin": 1.0,
  config: 1.0,
  manifest: 1.0,
  "docker-image": 0.9,
  lockfile: 0.9,
  executable: 0.8,
  "file-presence": 0.6,
  "extension-count": 0.4,
});

export const PROFILE_CATEGORIES = [
  "languages",
  "frameworks",
  "databases",
  "packageManagers",
  "infrastructure",
  "aiClients",
  "aiTools",
] as const;
export type ProfileCategory = (typeof PROFILE_CATEGORIES)[number];

export const AI_TOOL_KINDS = ["mcp-server", "skill", "plugin"] as const;
export type AiToolKind = (typeof AI_TOOL_KINDS)[number];

export const AI_CLIENT_IDS = ["claude-code", "codex", "cursor"] as const;
export type AiClientId = (typeof AI_CLIENT_IDS)[number];

export const DETECTOR_STATUSES = ["ok", "partial", "failed"] as const;
export type DetectorStatus = (typeof DETECTOR_STATUSES)[number];

// ---------------------------------------------------------------- 경로 규칙

const ABSOLUTE_PATTERNS: readonly RegExp[] = [
  /(^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u, // C:\ 또는 C:/
  /\\\\[^\\\s]+\\/u, // \\server\share
  /(^|[\s"'(=,])\/(?:[^\s/]+\/)+[^\s/]*/u, // /home/user/x 같은 2단계 이상 POSIX 절대 경로
  /(^|[\s"'(=,])\/(?:Users|home|root|var|tmp|etc|opt|mnt|private)(\/|$)/u,
];

/** 문자열에 절대 경로처럼 보이는 부분이 있는지 검사한다. */
export function containsAbsolutePath(text: string): boolean {
  return ABSOLUTE_PATTERNS.some((p) => p.test(text));
}

/** project scope 경로: Root 기준 POSIX 상대 경로(`..`·백슬래시·선행 `/` 금지). */
export function isProjectRelativePath(file: string): boolean {
  if (file === "" || file.startsWith("/") || file.includes("\\") || /^[A-Za-z]:/u.test(file)) return false;
  return file.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/** user scope 경로: `~/`로 시작하는 논리 경로 또는 `PATH`(실행 파일 탐색). 실제 홈 경로는 쓰지 않는다. */
export function isUserLogicalPath(file: string): boolean {
  if (file === "PATH") return true;
  return file.startsWith("~/") && isProjectRelativePath(file.slice(2));
}

// ---------------------------------------------------------------- 스키마

const kebabId = z
  .string()
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u, "id는 kebab-case여야 합니다")
  .max(100);

export const evidenceSchema = z.strictObject({
  file: z.string().min(1).max(300),
  type: z.enum(EVIDENCE_TYPES),
  value: z.string().min(1).max(200),
});
export type Evidence = z.output<typeof evidenceSchema>;

const itemShape = {
  id: kebabId,
  name: z.string().min(1).max(100),
  scope: z.enum(SCOPES),
  confidence: z.number().min(0).max(1),
  evidence: z.array(evidenceSchema).min(1),
};

function checkItem(item: { scope: Scope; confidence: number; evidence: Evidence[] }, ctx: z.RefinementCtx): void {
  item.evidence.forEach((e, i) => {
    const ok = item.scope === "project" ? isProjectRelativePath(e.file) : isUserLogicalPath(e.file);
    if (!ok) {
      ctx.addIssue({
        code: "custom",
        path: ["evidence", i, "file"],
        message: item.scope === "project" ? "project scope Evidence는 Root 기준 POSIX 상대 경로여야 합니다" : "user scope Evidence는 ~/ 논리 경로 또는 PATH여야 합니다",
      });
    }
  });
  const expected = detectionConfidence(item.evidence);
  if (item.confidence !== expected) {
    ctx.addIssue({ code: "custom", path: ["confidence"], message: `confidence는 Evidence 가중치 최댓값(${expected})이어야 합니다` });
  }
}

export const detectionItemSchema = z.strictObject(itemShape).superRefine(checkItem);
export type DetectionItem = z.output<typeof detectionItemSchema>;

export const aiToolItemSchema = z
  .strictObject({
    ...itemShape,
    kind: z.enum(AI_TOOL_KINDS),
    clients: z.array(z.enum(AI_CLIENT_IDS)).min(1),
  })
  .superRefine(checkItem);
export type AiToolItem = z.output<typeof aiToolItemSchema>;

export const analysisWarningSchema = z.strictObject({
  code: kebabId,
  message: z.string().min(1).max(500),
  file: z.string().min(1).max(300).optional(),
  detector: z.string().min(1).max(100).optional(),
});
export type AnalysisWarning = z.output<typeof analysisWarningSchema>;

export const detectorReportSchema = z.strictObject({
  id: z.string().min(1).max(100),
  status: z.enum(DETECTOR_STATUSES),
});
export type DetectorReport = z.output<typeof detectorReportSchema>;

export const projectProfileSchema = z
  .strictObject({
    schemaVersion: z.literal(PROFILE_SCHEMA_VERSION),
    project: z.strictObject({ name: z.string().min(1).max(255) }),
    languages: z.array(detectionItemSchema),
    frameworks: z.array(detectionItemSchema),
    databases: z.array(detectionItemSchema),
    packageManagers: z.array(detectionItemSchema),
    infrastructure: z.array(detectionItemSchema),
    aiClients: z.array(detectionItemSchema),
    aiTools: z.array(aiToolItemSchema),
    detectors: z.array(detectorReportSchema),
    warnings: z.array(analysisWarningSchema),
  })
  .superRefine((profile, ctx) => {
    if (profile.project.name.includes("/") || profile.project.name.includes("\\")) {
      ctx.addIssue({ code: "custom", path: ["project", "name"], message: "project.name은 디렉터리 이름만 담아야 합니다" });
    }
    for (const found of findStrings(profile)) {
      if (containsAbsolutePath(found.value)) {
        ctx.addIssue({ code: "custom", path: found.path, message: "결과에 절대 경로가 포함될 수 없습니다" });
      }
    }
  });
export type ProjectProfile = z.output<typeof projectProfileSchema>;

function findStrings(value: unknown, path: (string | number)[] = []): { path: (string | number)[]; value: string }[] {
  if (typeof value === "string") return [{ path, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => findStrings(v, [...path, i]));
  if (value !== null && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => findStrings(v, [...path, k]));
  }
  return [];
}

// ---------------------------------------------------------------- Detection Confidence

/** 항목의 Detection Confidence = Evidence 가중치 최댓값. 확률 합성이나 학습 모델을 쓰지 않는다. */
export function detectionConfidence(evidence: readonly Pick<Evidence, "type">[]): number {
  return evidence.reduce((max, e) => Math.max(max, EVIDENCE_WEIGHTS[e.type]), 0);
}
