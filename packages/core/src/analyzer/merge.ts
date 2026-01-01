import type { DetectionResult, Finding } from "./detector";
import {
  PROFILE_CATEGORIES,
  PROFILE_SCHEMA_VERSION,
  aiToolItemSchema,
  detectionConfidence,
  detectionItemSchema,
  projectProfileSchema,
  type AnalysisWarning,
  type DetectorReport,
  type DetectorStatus,
  type Evidence,
  type ProjectProfile,
} from "./profile";

/** Detector 한 개의 실행 결과(TASK-014 Orchestrator가 만든다). */
export interface DetectorRun {
  id: string;
  status: DetectorStatus;
  findings: Finding[];
  warnings: AnalysisWarning[];
}

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const evidenceKey = (e: Evidence): string => `${e.file}\u0000${e.type}\u0000${e.value}`;

/** kebab-case id로 정규화한다(예: "My_Server" → "my-server"). */
export function toKebabId(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 100);
}

export function sortEvidence(evidence: readonly Evidence[]): Evidence[] {
  const unique = new Map<string, Evidence>();
  for (const e of evidence) unique.set(evidenceKey(e), { file: e.file, type: e.type, value: e.value });
  return [...unique.values()].sort((a, b) => cmp(a.file, b.file) || cmp(a.type, b.type) || cmp(a.value, b.value));
}

function sortWarnings(warnings: readonly AnalysisWarning[]): AnalysisWarning[] {
  const unique = new Map<string, AnalysisWarning>();
  for (const w of warnings) {
    const clean: AnalysisWarning = {
      code: w.code,
      message: w.message,
      ...(w.file === undefined ? {} : { file: w.file }),
      ...(w.detector === undefined ? {} : { detector: w.detector }),
    };
    unique.set(JSON.stringify([clean.code, clean.file ?? "", clean.detector ?? "", clean.message]), clean);
  }
  return [...unique.values()].sort(
    (a, b) => cmp(a.code, b.code) || cmp(a.file ?? "", b.file ?? "") || cmp(a.detector ?? "", b.detector ?? "") || cmp(a.message, b.message),
  );
}

/** Finding 하나가 계약에 맞는지 검사한다. 맞지 않으면 사람이 읽는 사유를 돌려준다. */
export function validateFinding(f: Finding): string | undefined {
  const item = {
    id: f.id,
    name: f.name,
    scope: f.scope,
    confidence: detectionConfidence(f.evidence),
    evidence: f.evidence,
    ...(f.category === "aiTools" ? { kind: f.kind, clients: f.clients } : {}),
  };
  if (f.category !== "aiTools" && (f.kind !== undefined || f.clients !== undefined)) return "kind·clients는 aiTools 항목에만 쓸 수 있습니다";
  if (!(PROFILE_CATEGORIES as readonly string[]).includes(f.category)) return `알 수 없는 카테고리: ${String(f.category)}`;
  const schema = f.category === "aiTools" ? aiToolItemSchema : detectionItemSchema;
  const r = schema.safeParse(item);
  if (r.success) return undefined;
  return r.error.issues.map((i) => `${i.path.join(".") || "(item)"}: ${i.message}`).join("; ");
}

/**
 * Detector 실행 결과들을 하나의 Profile로 합친다.
 * - Evidence는 (file, type, value)로 중복 제거
 * - 항목은 (카테고리, id, scope[, kind])로 병합, confidence는 병합된 Evidence에서 다시 계산
 * - 모든 배열을 정렬해 같은 입력이면 같은 JSON이 된다
 */
export function buildProfile(projectName: string, runs: readonly DetectorRun[], extraWarnings: readonly AnalysisWarning[] = []): ProjectProfile {
  const groups = new Map<string, { category: Finding["category"]; items: Finding[] }>();
  for (const run of runs) {
    for (const f of run.findings) {
      const key = [f.category, f.id, f.scope, f.category === "aiTools" ? (f.kind ?? "") : ""].join("\u0000");
      const g = groups.get(key);
      if (g) g.items.push(f);
      else groups.set(key, { category: f.category, items: [f] });
    }
  }

  const profile: Record<string, unknown> = {
    schemaVersion: PROFILE_SCHEMA_VERSION,
    project: { name: projectName },
  };
  for (const category of PROFILE_CATEGORIES) profile[category] = [];

  for (const { category, items } of groups.values()) {
    const first = items[0] as Finding;
    const evidence = sortEvidence(items.flatMap((f) => f.evidence));
    const name = items.map((f) => f.name).sort(cmp)[0] as string;
    const base = { id: first.id, name, scope: first.scope, confidence: detectionConfidence(evidence), evidence };
    const item =
      category === "aiTools"
        ? { ...base, kind: first.kind, clients: [...new Set(items.flatMap((f) => f.clients ?? []))].sort(cmp) }
        : base;
    (profile[category] as unknown[]).push(item);
  }
  for (const category of PROFILE_CATEGORIES) {
    (profile[category] as { id: string; scope: string; kind?: string }[]).sort(
      (a, b) => cmp(a.id, b.id) || cmp(a.scope, b.scope) || cmp(a.kind ?? "", b.kind ?? ""),
    );
  }

  const reports: DetectorReport[] = runs.map((r) => ({ id: r.id, status: r.status })).sort((a, b) => cmp(a.id, b.id));
  profile["detectors"] = reports;
  profile["warnings"] = sortWarnings([...runs.flatMap((r) => r.warnings), ...extraWarnings]);
  return projectProfileSchema.parse(profile);
}

/** 테스트·CLI용 결정적 직렬화. */
export function serializeProfile(profile: ProjectProfile): string {
  return JSON.stringify(profile, null, 2) + "\n";
}

export type { DetectionResult };
