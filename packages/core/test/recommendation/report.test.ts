import { afterEach, describe, expect, it, vi } from "vitest";
import {
  compareRankCandidates,
  containsAbsolutePath,
  rankRecommendations,
  recommend,
  recommendationReportSchema,
  selectPrimaryCapability,
  serializeRecommendationReport,
  type GapAssessment,
  type ProjectProfile,
  type RankCandidate,
  type RegistryEntry,
} from "../../src/index";
import { fixtureProfile, item, profile, seedEntries, shuffleProfile, shuffled, syntheticEntries, syntheticSnapshot, tool } from "./helpers";

const seed = await seedEntries();
const synthetic = await syntheticEntries();
const snapshot = await syntheticSnapshot();
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

const clients = [item("claude-code", "Claude Code", "config", { file: ".mcp.json" }), item("codex", "Codex", "config", { file: ".codex/config.toml" })];
const full = (extra: Parameters<typeof profile>[0] = {}) =>
  profile({
    frameworks: [item("react", "React"), item("fastapi", "FastAPI", "dependency", { file: "pyproject.toml" })],
    databases: [item("postgresql", "PostgreSQL", "dependency", { file: "pyproject.toml" })],
    aiClients: clients,
    detectors: { "host-probe": "ok" },
    ...extra,
  });
const springMysql = profile({ frameworks: [item("spring-boot", "Spring Boot", "dependency", { file: "pom.xml" })], databases: [item("mysql", "MySQL", "dependency", { file: "pom.xml" })], aiClients: clients });

function gap(capability: string, over: Partial<GapAssessment> = {}): GapAssessment {
  return { capability, label: capability, priority: "high", strength: "strong", sources: [], state: "likely-gap", stateReasons: [], satisfiedBy: [], partial: false, ...over };
}
function candidate(toolId: string, over: { state?: GapAssessment["state"]; priority?: GapAssessment["priority"]; fit?: number; open?: number | null } = {}): RankCandidate {
  return {
    evaluation: { entry: { manifest: { name: toolId } } } as unknown as RankCandidate["evaluation"],
    primary: gap("x", { state: over.state ?? "likely-gap", priority: over.priority ?? "high" }),
    fit: { score: over.fit ?? 80, components: { needCoverage: 0, evidenceStrength: 0, stackMatch: 0, clientSupport: 0, environment: 0 } },
    openScore: { kind: "repository-health-heuristic", score: over.open === undefined ? 50 : over.open, status: over.open === null ? "unavailable" : "ok", components: null, flags: [] },
  };
}
const order = (...cs: RankCandidate[]) => rankRecommendations(cs).map((c) => c.evaluation.entry.manifest.name);

describe("REQ-022 Recommendation Ranker와 Report 계약", () => {
  it("AC-024-01 RecommendationReport는 schemaVersion 1 zod schema를 통과하고 모르는 key는 거부된다", () => {
    const report = recommend(full(), synthetic, snapshot, { platform: "linux" });
    expect(recommendationReportSchema.parse(report)).toEqual(report);
    expect(report.schemaVersion).toBe(1);
    expect(recommendationReportSchema.safeParse({ ...report, score: 1 }).success).toBe(false);
    const first = report.recommendations[0];
    expect(recommendationReportSchema.safeParse({ ...report, recommendations: [{ ...first, combinedScore: 0.5 }] }).success).toBe(false);
  });

  it("AC-024-01 M2 fixture 6개의 실제 report가 schema를 통과한다", async () => {
    for (const name of ["react-pnpm", "python-fastapi", "react-spring-monorepo", "claude-mcp", "malformed-config", "docker-project"]) {
      const report = recommend(await fixtureProfile(name), seed, undefined, { platform: "windows" });
      expect(recommendationReportSchema.safeParse(report).success, name).toBe(true);
    }
  });

  it("AC-024-02 정렬 키: 실행 가능 여부 → Gap priority → Gap state", () => {
    expect(order(candidate("a", { state: "unknown", fit: 99, open: 99 }), candidate("b", { state: "likely-gap", priority: "low", fit: 10, open: 1 }))).toEqual(["b", "a"]);
    expect(order(candidate("a", { priority: "medium", fit: 99 }), candidate("b", { priority: "high", fit: 10 }))).toEqual(["b", "a"]);
    expect(order(candidate("a", { state: "likely-gap", fit: 99 }), candidate("b", { state: "confirmed-gap", fit: 10 }))).toEqual(["b", "a"]);
  });

  it("AC-024-02 정렬 키: Project Fit → OpenScore(null 맨 뒤) → toolId", () => {
    expect(order(candidate("a", { fit: 70, open: 99 }), candidate("b", { fit: 71, open: 0 }))).toEqual(["b", "a"]);
    expect(order(candidate("a", { open: 40 }), candidate("b", { open: 41 }))).toEqual(["b", "a"]);
    expect(order(candidate("a", { open: null }), candidate("b", { open: 0 }))).toEqual(["b", "a"]);
    expect(order(candidate("b"), candidate("a"))).toEqual(["a", "b"]);
    expect(compareRankCandidates(candidate("a"), candidate("a"))).toBe(0);
  });

  it("AC-024-03 incompatible·resolved 설치 tool은 recommendations에 없고 needs[].candidates에 excludedBy와 함께 남는다", async () => {
    const claude = recommend(await fixtureProfile("claude-mcp"), seed, undefined);
    expect(claude.recommendations.map((r) => r.toolId)).not.toContain("playwright-mcp");
    expect(claude.needs.find((n) => n.capability === "browser-automation")?.candidates).toEqual([{ toolId: "playwright-mcp", status: "installed", excludedBy: ["installed"] }]);
    const mysql = recommend(springMysql, seed, undefined);
    expect(mysql.recommendations.map((r) => r.toolId)).not.toContain("postgres-mcp");
    expect(mysql.needs.find((n) => n.capability === "sql-query")?.candidates).toEqual([{ toolId: "postgres-mcp", status: "incompatible", excludedBy: ["stack-mismatch"] }]);
  });

  it("AC-024-04 같은 tier에서 Fit이 낮은 tool은 OpenScore가 높아도 Fit이 높은 tool보다 앞에 오지 않는다(시나리오 12·13)", () => {
    const grid: RankCandidate[] = [];
    let n = 0;
    for (const fit of [40, 55, 70, 85, 100]) for (const open of [null, 0, 30, 60, 99]) grid.push(candidate(`t${String(n++).padStart(2, "0")}`, { fit, open }));
    const ranked = rankRecommendations(shuffled(grid));
    for (let i = 1; i < ranked.length; i++) expect((ranked[i - 1] as RankCandidate).fit.score).toBeGreaterThanOrEqual((ranked[i] as RankCandidate).fit.score);
    const report = recommend(full(), synthetic, snapshot);
    const rank = (id: string) => report.recommendations.find((r) => r.toolId === id);
    expect(rank("tool-a")?.openScore.score).toBeGreaterThan(rank("tool-b")?.openScore.score ?? 1);
    expect(rank("tool-b")?.projectFit.score).toBeGreaterThan(rank("tool-a")?.projectFit.score ?? 1);
    expect((rank("tool-b")?.rank ?? 99) < (rank("tool-a")?.rank ?? 0)).toBe(true);
  });

  it("AC-024-05 tool 하나에 recommendation 하나이며 covers에 그 tool이 덮는 Gap이 모두 있다", () => {
    const report = recommend(full({ detectors: {} }), synthetic, snapshot);
    const ids = report.recommendations.map((r) => r.toolId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const rec of report.recommendations) {
      const expected = report.needs.filter((n) => n.candidates.some((c) => c.toolId === rec.toolId && c.status === "recommended")).map((n) => n.capability);
      expect(rec.covers.map((c) => c.capability), rec.toolId).toEqual(expected);
      expect(rec.covers.map((c) => c.capability)).toContain(rec.primaryCapability);
    }
  });

  it("AC-024-06 같은 입력은 두 번 직렬화해도 바이트 단위로 같다(시나리오 15)", async () => {
    const p = await fixtureProfile("react-spring-monorepo");
    const a = serializeRecommendationReport(recommend(p, seed, snapshot, { platform: "linux" }));
    const b = serializeRecommendationReport(recommend(p, seed, snapshot, { platform: "linux" }));
    expect(a).toBe(b);
  });

  it("AC-024-06 profile 배열·registry 순서를 섞어도 바이트 단위로 같다", async () => {
    for (const [p, entries] of [[await fixtureProfile("claude-mcp"), seed], [full({ aiTools: [tool("my-github"), tool("tool-c")] }), synthetic]] as [ProjectProfile, RegistryEntry[]][]) {
      const a = serializeRecommendationReport(recommend(p, entries, snapshot));
      const b = serializeRecommendationReport(recommend(shuffleProfile(p), shuffled(entries), snapshot));
      expect(b).toBe(a);
    }
  });

  it("AC-024-07 secret·token·env 값·URL credential·절대 경로가 report에 남지 않는다", () => {
    vi.stubEnv("OPENHUB_TEST_SECRET", "very-secret-env-value-123");
    const leaky = profile({
      frameworks: [item("react", "React", "dependency", { value: "react ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345" })],
      databases: [item("postgresql", "PostgreSQL", "config", { file: "src/application.yml", value: "postgresql://admin:hunter2@db.internal:5432/app" })],
      aiClients: clients,
      aiTools: [tool("my-mcp", { value: "my-mcp sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ" })],
    });
    const entries = synthetic.map((e) => (e.manifest.name === "tool-b" ? { ...e, manifest: { ...e.manifest, displayName: "Tool B github_pat_ABCDEFGHIJKLMNOPQRSTUVWX" } } : e));
    const text = serializeRecommendationReport(recommend(leaky, entries, snapshot));
    for (const secret of ["ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345", "hunter2", "sk-ABCDEFGHIJKLMNOPQRSTUVWXYZ", "github_pat_ABCDEFGHIJKLMNOPQRSTUVWX", "secret-password", "very-secret-env-value-123"]) {
      expect(text).not.toContain(secret);
    }
    for (const line of text.split("\n")) expect(containsAbsolutePath(line), line).toBe(false);
    expect(text).toContain("[redacted]");
  });

  it("AC-024-08 compatible 후보가 없는 Gap은 상태를 유지하고 needs[].reasons에 no-candidate가 있다(시나리오 10)", () => {
    const report = recommend(springMysql, seed, undefined);
    for (const cap of ["db-schema-access", "sql-query", "query-tuning"]) {
      const need = report.needs.find((n) => n.capability === cap);
      expect(need?.state).toBe("likely-gap");
      expect(need?.reasons.map((r) => r.code)).toEqual(["no-candidate"]);
      expect(need?.reasons[0]?.message).toContain("등록된 도구 없음");
    }
  });

  it("AC-024-09 report에 생성 시각이 없고 generatedFrom은 네 필드만 가진다", () => {
    const a = serializeRecommendationReport(recommend(full(), synthetic, snapshot));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-02-03T04:05:06Z"));
    const b = serializeRecommendationReport(recommend(full(), synthetic, snapshot));
    expect(b).toBe(a);
    const report = JSON.parse(a) as { generatedFrom: Record<string, unknown> };
    expect(Object.keys(report.generatedFrom)).toEqual(["profileSchemaVersion", "taxonomyVersion", "registryDigest", "metadataCollectedAt"]);
    expect(report.generatedFrom["metadataCollectedAt"]).toBe("2026-01-01T00:00:00Z");
    expect(a.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/gu)).toEqual(["2026-01-01T00:00"]);
  });

  it("AC-024-10 primaryCapability 1·2단계: Gap state → Gap priority", () => {
    expect(selectPrimaryCapability([gap("a-cap", { state: "likely-gap" }), gap("z-cap", { state: "confirmed-gap", priority: "low" })], 50).capability).toBe("z-cap");
    expect(selectPrimaryCapability([gap("a-cap", { state: "unknown" }), gap("z-cap", { state: "likely-gap", priority: "low" })], 50).capability).toBe("z-cap");
    expect(selectPrimaryCapability([gap("a-cap", { priority: "medium" }), gap("z-cap", { priority: "high" })], 50).capability).toBe("z-cap");
  });

  it("AC-024-10 primaryCapability 3·4단계: fitContribution → capability ID 오름차순, 입력 순서 무관", async () => {
    expect(selectPrimaryCapability([gap("a-cap", { strength: "weak" }), gap("z-cap", { strength: "strong" })], 50).capability).toBe("z-cap");
    expect(selectPrimaryCapability([gap("a-cap", { partial: true }), gap("z-cap")], 50).capability).toBe("z-cap");
    expect(selectPrimaryCapability([gap("z-cap"), gap("b-cap"), gap("m-cap")], 50).capability).toBe("b-cap");
    const p = await fixtureProfile("react-pnpm");
    const a = recommend(p, seed, undefined).recommendations.map((r) => [r.toolId, r.primaryCapability]);
    const b = recommend(shuffleProfile(p), shuffled(seed), undefined).recommendations.map((r) => [r.toolId, r.primaryCapability]);
    expect(b).toEqual(a);
    expect(Object.fromEntries(a)).toMatchObject({ "playwright-mcp": "browser-automation", "chrome-devtools-mcp": "browser-automation", serena: "semantic-code-navigation" });
  });
});
