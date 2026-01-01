import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  NOT_MEASURED,
  breakingMetrics,
  buildMetricsReport,
  discoveryMetrics,
  formatMetricsMarkdown,
  gapAccuracy,
  lifecycleSuccessRates,
  loadMetadataSnapshot,
  metricsInputFromLabels,
  sandboxReportFromVitest,
  sandboxReportSchema,
  type DiscoveryReport,
} from "../../src/index";
import { FIXTURES_DIR, REPO_ROOT, seedEntries, snapshotPath } from "../recommendation/helpers";

/** TASK-067 REQ-061 Metrics. 라벨된 fixture와 가짜 sandbox·discovery report만 쓴다(network·사용자 state 0). */
const seed = await seedEntries();
const snapshot = await loadMetadataSnapshot(snapshotPath("metadata.seed-synthetic.json"));
const LABELS = path.join(FIXTURES_DIR, "metrics", "labels.yaml");
const labelsText = await readFile(LABELS, "utf8");
const input = await metricsInputFromLabels(labelsText, path.dirname(LABELS), seed, snapshot);
const SECRET = "ghp_" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji";

describe("REQ-061 Metrics", () => {
  it("AC-067-01 라벨된 fixture로 추천 top-3 Precision을 결정론으로 계산하고 JSON·Markdown 보고서를 만든다", async () => {
    const a = buildMetricsReport(input);
    const b = buildMetricsReport(await metricsInputFromLabels(labelsText, path.dirname(LABELS), [...seed].reverse(), snapshot));
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    const manual = input.recommendation.reduce((acc, c) => {
      const top = c.report.recommendations.slice(0, 3).map((r) => r.toolId);
      return { hits: acc.hits + top.filter((t) => c.relevant.includes(t)).length, shown: acc.shown + top.length };
    }, { hits: 0, shown: 0 });
    expect(a.recommendation).toMatchObject({ topK: 3, hits: manual.hits, shown: manual.shown, precision: Math.round((manual.hits / manual.shown) * 1000) / 1000 });
    expect(a.recommendation.perProject.map((p) => p.project)).toEqual(["claude-mcp", "python-fastapi", "react-pnpm", "react-spring-monorepo", "spring-postgres"]);
    expect(formatMetricsMarkdown(a)).toContain("| Recommendation top-3 precision | " + String(a.recommendation.precision));
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["metrics"]).toBe("tsx scripts/metrics.ts");
    const script = readFileSync(path.join(REPO_ROOT, "scripts/metrics.ts"), "utf8");
    expect(script).toContain('"metrics-report.json"');
    expect(script).toContain('"metrics-report.md"');
  });

  it("AC-067-02 Gap 탐지 정확도를 라벨된 기대 상태와 비교해 계산하고 불일치를 보고한다", () => {
    const g = gapAccuracy(input.recommendation);
    expect(g.labeled).toBe(11);
    expect(g.accuracy).toBe(Math.round((g.correct / g.labeled) * 1000) / 1000);
    const wrong = gapAccuracy([{ ...input.recommendation[0]!, gaps: { "e2e-testing": "confirmed-gap" } }]);
    expect(wrong).toMatchObject({ correct: 0, labeled: 1, accuracy: 0 });
    expect(wrong.mismatches[0]).toMatchObject({ capability: "e2e-testing", expected: "confirmed-gap" });
  });

  it("AC-067-03 라벨된 release note로 Breaking change Precision·False Warning Rate를 계산한다", () => {
    const b = breakingMetrics(input.releases);
    expect(b.counts).toEqual({ truePositive: 3, falsePositive: 1, trueNegative: 4, falseNegative: 1 });
    expect([b.precision, b.falseWarningRate]).toEqual([0.75, 0.2]);
  });

  it("AC-067-04 sandbox·Discovery report에서 성공률·탐지 지연·coverage를 계산하고 report가 없으면 not measured다", () => {
    const sandbox = sandboxReportSchema.parse({
      schemaVersion: 1,
      kind: "openhub-sandbox-report",
      generatedAt: "2026-10-08T00:00:00.000Z",
      results: [
        { suite: "install", id: "AC-031-09", status: "passed", durationMs: 100 },
        { suite: "install-health", id: "AC-054-08", status: "passed", durationMs: 200 },
        { suite: "install-health", id: "AC-054-09", status: "failed", durationMs: 300 },
        { suite: "install", id: "unlabeled", status: "skipped", durationMs: 0 },
      ],
    });
    expect(lifecycleSuccessRates(sandbox)).toEqual({ install: { rate: 0.667, runs: 3 }, health: { rate: 0.5, runs: 2 }, update: NOT_MEASURED, rollback: NOT_MEASURED });
    expect(lifecycleSuccessRates(undefined)).toEqual({ install: NOT_MEASURED, health: NOT_MEASURED, update: NOT_MEASURED, rollback: NOT_MEASURED });
    const discovery: DiscoveryReport = {
      schemaVersion: 1,
      kind: "openhub-discovery-report",
      registryTools: 7,
      candidates: [
        { id: "a", confidence: "high", publishedAt: "2026-10-01T00:00:00.000Z", discoveredAt: "2026-10-05T00:00:00.000Z" },
        { id: "b", confidence: "medium", publishedAt: null, discoveredAt: "2026-10-05T00:00:00.000Z" },
        { id: "c", confidence: "high", publishedAt: "2026-09-01T00:00:00.000Z", discoveredAt: "2026-10-05T00:00:00.000Z" },
      ],
    };
    expect(discoveryMetrics(discovery)).toEqual({ detectionDelayDays: { median: 4, samples: 2 }, registryCoverage: { ratio: 0.778, registryTools: 7, highConfidenceCandidates: 2 } });
    expect(discoveryMetrics(undefined)).toEqual({ detectionDelayDays: NOT_MEASURED, registryCoverage: NOT_MEASURED });
    const md = formatMetricsMarkdown(buildMetricsReport(input));
    expect(md).toContain("| Install success rate | not measured |");
  });

  it("AC-067-05 metrics 코드는 network 0·사용자 state 읽기 0이며 User Acceptance Rate는 제외 사유와 함께만 있다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const report = buildMetricsReport(await metricsInputFromLabels(labelsText, path.dirname(LABELS), seed, snapshot));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    for (const f of ["packages/core/src/metrics/metrics.ts", "scripts/metrics.ts"]) {
      const src = readFileSync(path.join(REPO_ROOT, f), "utf8");
      expect(src, f).not.toMatch(/readLifecycleState|\.openhub[\\/]|includeHost: true|os\.homedir|process\.env[.[]|\bfetch\(/u);
    }
    expect(report.excluded).toEqual([{ metric: "User Acceptance Rate", reason: expect.stringContaining("telemetry") }]);
    expect(JSON.stringify({ ...report, excluded: [] })).not.toContain("Acceptance");
  });

  it("AC-067-06 sandbox job은 개수·상태·소요 시간만 담은 정제 report를 artifact로 올리고 secret·경로가 없다", () => {
    const vitestJson = {
      testResults: [
        {
          name: "/home/runner/work/openhub-ai/packages/core/test/registry/sandbox.e2e.test.ts",
          assertionResults: [
            { title: "AC-054-08 memory-mcp 설치 + Health token " + SECRET, fullName: "x " + SECRET, status: "passed", duration: 1234.6, failureMessages: [] },
            { title: "unnamed", status: "failed", duration: 5, failureMessages: ["Error at C:\\Users\\alice\\x " + SECRET] },
          ],
        },
        { name: "/home/runner/work/x/executor.e2e.test.ts", assertionResults: [{ title: "AC-031-09 docker", status: "skipped", duration: null }] },
        { name: "/home/runner/work/x/other.test.ts", assertionResults: [{ title: "AC-001-01 ignored", status: "passed", duration: 1 }] },
      ],
    };
    const r = sandboxReportFromVitest(vitestJson, new Date("2026-10-08T00:00:00.000Z"));
    expect(r.results).toEqual([
      { suite: "install", id: "AC-031-09", status: "skipped", durationMs: 0 },
      { suite: "install-health", id: "AC-054-08", status: "passed", durationMs: 1235 },
      { suite: "install-health", id: "unlabeled", status: "failed", durationMs: 5 },
    ]);
    const bytes = JSON.stringify(r);
    for (const banned of [SECRET, "alice", "/home/runner", "memory-mcp"]) expect(bytes).not.toContain(banned);
    expect(sandboxReportSchema.safeParse({ ...r, results: [{ ...r.results[0], title: "x" }] }).success).toBe(false);
    const yml = readFileSync(path.join(REPO_ROOT, ".github/workflows/registry-remote.yml"), "utf8");
    expect(yml).toContain("scripts/sandbox-report.ts sandbox-vitest.json sandbox-report.json");
    expect(yml).toContain("name: sandbox-report");
    expect(yml).toMatch(/permissions:\n {2}contents: read/u);
  });
});

