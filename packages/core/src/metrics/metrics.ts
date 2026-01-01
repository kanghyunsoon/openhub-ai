import { z } from "zod";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { analyzeProject } from "../analyzer/analyze";
import type { MetadataSnapshot } from "../recommendation/metadata-snapshot";
import { recommend } from "../recommendation/recommend";
import type { RecommendationReport } from "../recommendation/report";
import type { RegistryEntry } from "../registry/load";
import { releaseSnapshotSchema, type ReleaseSnapshotV1 } from "../release/snapshot";
import { summarizeReleases } from "../release/summary";

/**
 * REQ-061 성공 지표(TASK-067, D-032). telemetry 없이 측정 가능한 지표만 계산한다.
 * - fixture 정답 라벨(사람이 적은 기대 도구·기대 Gap·Breaking 여부)로 추천 top-K Precision·Gap 탐지 정확도·
 *   Breaking change 탐지 Precision·False Warning Rate를 결정론으로 계산한다.
 * - 설치·Health·업데이트·Rollback 성공률은 수동 sandbox workflow가 올린 정제 report에서만 계산한다. report가 없으면
 *   "not measured"이며 숫자를 만들지 않는다. 신규 프로젝트 탐지 지연·Registry coverage는 Discovery report에서 같은 방식이다.
 * - User Acceptance Rate는 사용자 행동 수집(telemetry)이 필요해 제외한다.
 * - network·사용자 state 읽기 0. 입력은 호출 측이 넘긴 값뿐이다.
 */

export const NOT_MEASURED = "not measured" as const;
export const EXCLUDED_METRICS = [{ metric: "User Acceptance Rate", reason: "사용자 행동 수집(telemetry)이 필요해 측정하지 않는다" }] as const;
const ratio = (num: number, den: number) => (den === 0 ? null : Math.round((num / den) * 1000) / 1000);

export interface RecommendationCase {
  project: string;
  report: RecommendationReport;
  /** 사람이 이 프로젝트에 적절하다고 라벨한 Registry Tool */
  relevant: readonly string[];
  /** capability → 기대 Gap 상태 */
  gaps: Readonly<Record<string, string>>;
}

export function recommendationPrecision(cases: readonly RecommendationCase[], k = 3) {
  let hits = 0;
  let shown = 0;
  const perProject = cases.map((c) => {
    const top = c.report.recommendations.slice(0, k).map((r) => r.toolId);
    const h = top.filter((t) => c.relevant.includes(t)).length;
    hits += h;
    shown += top.length;
    return { project: c.project, top, hits: h, precision: ratio(h, top.length) };
  });
  return { k, precision: ratio(hits, shown), hits, shown, perProject };
}

export function gapAccuracy(cases: readonly RecommendationCase[]) {
  let correct = 0;
  let labeled = 0;
  const mismatches: { project: string; capability: string; expected: string; actual: string }[] = [];
  for (const c of cases) {
    for (const [capability, expected] of Object.entries(c.gaps).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
      labeled += 1;
      const actual = c.report.needs.find((n) => n.capability === capability)?.state ?? "not-needed";
      if (actual === expected) correct += 1;
      else mismatches.push({ project: c.project, capability, expected, actual });
    }
  }
  return { accuracy: ratio(correct, labeled), correct, labeled, mismatches };
}

export interface ReleaseLabel {
  id: string;
  notes: string;
  breaking: boolean;
}

/** 라벨된 release note 하나를 결정론 Summary로 분류한다(Breaking 항목이 하나라도 있으면 Breaking 예측). */
export function predictedBreaking(notes: string): boolean {
  const entry = { version: "2.0.0", tag: "v2.0.0", publishedAt: "2026-01-01T00:00:00.000Z", prerelease: false, yanked: false, deprecated: null, title: null, notes: { text: notes, truncated: false, originalBytes: Buffer.byteLength(notes, "utf8") }, url: null, digest: null, runtime: { node: null, python: null } };
  const snapshot: ReleaseSnapshotV1 = releaseSnapshotSchema.parse({
    schemaVersion: 1,
    toolId: "metrics-fixture",
    versionSource: "npm",
    notesSource: "github-release",
    current: { spec: "metrics-fixture@1.0.0", version: "1.0.0", digest: null },
    target: entry,
    between: [entry],
    selection: { includePrerelease: false, comparable: true, skippedDrafts: 0, skippedPrereleases: 0, truncated: false },
    collectedAt: "2026-01-02T00:00:00.000Z",
    metadataDigest: "sha256:" + "0".repeat(64),
  });
  return summarizeReleases(snapshot).categories.breaking.length > 0;
}

export function breakingMetrics(labels: readonly ReleaseLabel[]) {
  let tp = 0;
  let fp = 0;
  let tn = 0;
  let fn = 0;
  for (const l of labels) {
    const p = predictedBreaking(l.notes);
    if (p && l.breaking) tp += 1;
    else if (p && !l.breaking) fp += 1;
    else if (!p && !l.breaking) tn += 1;
    else fn += 1;
  }
  return { precision: ratio(tp, tp + fp), falseWarningRate: ratio(fp, fp + tn), recall: ratio(tp, tp + fn), counts: { truePositive: tp, falsePositive: fp, trueNegative: tn, falseNegative: fn } };
}

// ---------------------------------------------------------------- sandbox·discovery report(수동 workflow 산출물)

export const SANDBOX_SUITES = ["install", "install-health", "update", "rollback"] as const;
/** sandbox workflow가 올리는 정제 report. 개수·상태·소요 시간만 있다(이름·출력·경로·secret 없음). */
export const sandboxReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("openhub-sandbox-report"),
  generatedAt: z.iso.datetime(),
  results: z.array(z.strictObject({ suite: z.enum(SANDBOX_SUITES), id: z.string().regex(/^(?:AC-\d{3}-\d{2}|unlabeled)$/u), status: z.enum(["passed", "failed", "skipped"]), durationMs: z.number().int().min(0) })),
});
export type SandboxReport = z.output<typeof sandboxReportSchema>;

const SUITE_OF_FILE: Readonly<Record<string, (typeof SANDBOX_SUITES)[number]>> = { "executor.e2e.test.ts": "install", "sandbox.e2e.test.ts": "install-health" };

/** vitest --reporter=json 출력 → 정제 sandbox report. 테스트 이름·실패 메시지·경로는 버리고 AC ID·상태·시간만 남긴다. */
export function sandboxReportFromVitest(json: unknown, generatedAt: Date): SandboxReport {
  const results: SandboxReport["results"] = [];
  const files = (json as { testResults?: unknown[] } | null)?.testResults ?? [];
  for (const file of Array.isArray(files) ? files : []) {
    const name = String((file as { name?: unknown }).name ?? "").replace(/\\/gu, "/").split("/").at(-1) ?? "";
    const suite = SUITE_OF_FILE[name];
    if (suite === undefined) continue;
    for (const a of ((file as { assertionResults?: unknown[] }).assertionResults ?? []) as Record<string, unknown>[]) {
      const id = /AC-\d{3}-\d{2}/u.exec(String(a["title"] ?? ""))?.[0] ?? "unlabeled";
      const status = a["status"] === "passed" ? "passed" : a["status"] === "failed" ? "failed" : "skipped";
      const d = typeof a["duration"] === "number" && Number.isFinite(a["duration"]) ? Math.max(0, Math.round(a["duration"])) : 0;
      results.push({ suite, id, status, durationMs: d });
    }
  }
  results.sort((x, y) => (x.suite < y.suite ? -1 : x.suite > y.suite ? 1 : x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return sandboxReportSchema.parse({ schemaVersion: 1, kind: "openhub-sandbox-report", generatedAt: generatedAt.toISOString(), results });
}

export function lifecycleSuccessRates(report: SandboxReport | undefined) {
  const rate = (suites: readonly string[]) => {
    if (report === undefined) return NOT_MEASURED;
    const rs = report.results.filter((r) => suites.includes(r.suite) && r.status !== "skipped");
    return rs.length === 0 ? NOT_MEASURED : { rate: ratio(rs.filter((r) => r.status === "passed").length, rs.length), runs: rs.length };
  };
  return { install: rate(["install", "install-health"]), health: rate(["install-health"]), update: rate(["update"]), rollback: rate(["rollback"]) };
}

export const discoveryReportSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("openhub-discovery-report"),
  registryTools: z.number().int().min(0),
  candidates: z.array(z.strictObject({ id: z.string().min(1).max(64), confidence: z.enum(["high", "medium", "low"]), publishedAt: z.iso.datetime().nullable(), discoveredAt: z.iso.datetime() })),
});
export type DiscoveryReport = z.output<typeof discoveryReportSchema>;

export function discoveryMetrics(report: DiscoveryReport | undefined) {
  if (report === undefined) return { detectionDelayDays: NOT_MEASURED, registryCoverage: NOT_MEASURED };
  const delays = report.candidates
    .filter((c) => c.publishedAt !== null)
    .map((c) => Math.max(0, Math.floor((Date.parse(c.discoveredAt) - Date.parse(c.publishedAt!)) / 86_400_000)))
    .sort((a, b) => a - b);
  const high = report.candidates.filter((c) => c.confidence === "high").length;
  return {
    detectionDelayDays: delays.length === 0 ? NOT_MEASURED : { median: delays[Math.floor((delays.length - 1) / 2)]!, samples: delays.length },
    registryCoverage: report.registryTools + high === 0 ? NOT_MEASURED : { ratio: ratio(report.registryTools, report.registryTools + high), registryTools: report.registryTools, highConfidenceCandidates: high },
  };
}

export interface MetricsInput {
  recommendation: readonly RecommendationCase[];
  releases: readonly ReleaseLabel[];
  sandbox?: SandboxReport;
  discovery?: DiscoveryReport;
}

export function buildMetricsReport(input: MetricsInput) {
  const precision = recommendationPrecision(input.recommendation, 3);
  return {
    schemaVersion: 1,
    kind: "openhub-metrics-report",
    recommendation: { topK: precision.k, precision: precision.precision, hits: precision.hits, shown: precision.shown, perProject: precision.perProject },
    gapDetection: gapAccuracy(input.recommendation),
    breakingChange: breakingMetrics(input.releases),
    lifecycle: lifecycleSuccessRates(input.sandbox),
    discovery: discoveryMetrics(input.discovery),
    excluded: EXCLUDED_METRICS.map((e) => ({ ...e })),
  };
}
export type MetricsReport = ReturnType<typeof buildMetricsReport>;

const v = (x: unknown) => (x === null ? "n/a" : typeof x === "object" ? JSON.stringify(x) : String(x));
export function formatMetricsMarkdown(r: MetricsReport): string {
  return [
    "# OpenHub metrics report",
    "",
    "Computed from labeled fixtures and optional sandbox/discovery reports. No telemetry is collected.",
    "",
    "| Metric | Value |",
    "| --- | --- |",
    "| Recommendation top-" + String(r.recommendation.topK) + " precision | " + v(r.recommendation.precision) + " (" + String(r.recommendation.hits) + "/" + String(r.recommendation.shown) + ") |",
    "| Gap detection accuracy | " + v(r.gapDetection.accuracy) + " (" + String(r.gapDetection.correct) + "/" + String(r.gapDetection.labeled) + ") |",
    "| Breaking change precision | " + v(r.breakingChange.precision) + " |",
    "| False warning rate | " + v(r.breakingChange.falseWarningRate) + " |",
    "| Install success rate | " + v(r.lifecycle.install) + " |",
    "| Health check success rate | " + v(r.lifecycle.health) + " |",
    "| Update success rate | " + v(r.lifecycle.update) + " |",
    "| Rollback success rate | " + v(r.lifecycle.rollback) + " |",
    "| New project detection delay (days) | " + v(r.discovery.detectionDelayDays) + " |",
    "| Registry coverage | " + v(r.discovery.registryCoverage) + " |",
    "",
    "Excluded: " + r.excluded.map((e) => e.metric + " — " + e.reason).join("; "),
    "",
  ].join("\n");
}

// ---------------------------------------------------------------- 라벨 파일(fixture·demo)

export const metricsLabelsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  kind: z.literal("openhub-metrics-labels"),
  projects: z.record(z.string().regex(/^[a-z0-9-]+$/u), z.strictObject({ dir: z.string().min(1).max(200), relevant: z.array(z.string().min(1)).min(1), gaps: z.record(z.string().min(1), z.string().min(1)) })),
  releases: z.array(z.strictObject({ id: z.string().min(1), breaking: z.boolean(), notes: z.string().min(1) })),
});
export type MetricsLabels = z.output<typeof metricsLabelsSchema>;

/** 라벨 파일의 프로젝트를 분석(host probe 없음)·추천해 지표 입력을 만든다. dir은 labels 파일 기준 상대 경로다. */
export async function metricsInputFromLabels(labelsText: string, labelsDir: string, entries: readonly RegistryEntry[], snapshot: MetadataSnapshot | undefined): Promise<MetricsInput> {
  const labels = metricsLabelsSchema.parse(parseYaml(labelsText));
  const recommendation: RecommendationCase[] = [];
  for (const [project, l] of Object.entries(labels.projects).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const analyzed = await analyzeProject(path.resolve(labelsDir, l.dir));
    if (!analyzed.ok) throw new Error("metrics fixture를 분석하지 못했습니다: " + project);
    recommendation.push({ project, report: recommend(analyzed.profile, entries, snapshot), relevant: l.relevant, gaps: l.gaps });
  }
  return { recommendation, releases: labels.releases };
}

