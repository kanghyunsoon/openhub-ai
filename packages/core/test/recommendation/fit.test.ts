import { describe, expect, it } from "vitest";
import {
  classifyGaps,
  clientScore,
  computeProjectFit,
  deriveNeeds,
  environmentScore,
  evidenceScore,
  fitContribution,
  matchCandidates,
  resolveInstalledTools,
  stackScore,
  type ProjectProfile,
  type RecommendContext,
  type RegistryEntry,
  type ToolEvaluation,
} from "../../src/index";
import { item, profile, seedEntries, syntheticEntries, tool } from "./helpers";

const seed = await seedEntries();
const synthetic = await syntheticEntries();
const evaluate = (p: ProjectProfile, entries: readonly RegistryEntry[], context: RecommendContext = {}) => {
  const installed = resolveInstalledTools(p, entries);
  return matchCandidates(p, classifyGaps(p, deriveNeeds(p), installed), installed, entries, context);
};
const fitOf = (p: ProjectProfile, entries: readonly RegistryEntry[], toolId: string, context: RecommendContext = {}) => {
  const e = evaluate(p, entries, context).tools.find((t) => t.entry.manifest.name === toolId);
  if (e === undefined) throw new Error(toolId);
  return computeProjectFit(e);
};
const clients = [item("claude-code", "Claude Code", "config", { file: ".mcp.json" }), item("codex", "Codex", "config", { file: ".codex/config.toml" })];
const reactTs = profile({ languages: [item("typescript", "TypeScript", "config", { file: "tsconfig.json" })], frameworks: [item("react", "React")], aiClients: clients });
const fastapiPg = profile({ frameworks: [item("fastapi", "FastAPI", "dependency", { file: "pyproject.toml" })], databases: [item("postgresql", "PostgreSQL", "dependency", { file: "pyproject.toml" })], aiClients: clients });
const fakeCompat = (over: Partial<ToolEvaluation["compatibility"]>) => ({ compatibility: { stack: { generic: true, status: "compatible", matched: [], strength: null }, clients: { status: "unknown", detected: [], supported: [] }, platform: { status: "unknown", value: null }, runtime: { status: "unknown", requirements: {} }, backend: { status: "unknown", options: [] }, overall: "unverified", excludedBy: [], ...over } }) as unknown as ToolEvaluation;

describe("REQ-022 Project Fit", () => {
  it("AC-021-01 Fit은 35·C+25·E+15·S+15·K+10·V 정수 연산이고 component가 노출된다", () => {
    const r = fitOf(reactTs, seed, "playwright-mcp", { platform: "windows" });
    expect(r?.fit.components).toEqual({ needCoverage: 100, evidenceStrength: 100, stackMatch: 100, clientSupport: 100, environment: 66 });
    expect(r?.fit.score).toBe(Math.floor((35 * 100 + 25 * 100 + 15 * 100 + 15 * 100 + 10 * 66 + 50) / 100));
    expect(r?.fit.score).toBe(97);
    expect(Number.isInteger(r?.fit.score)).toBe(true);
  });

  it("AC-021-01 C는 primary priority 가중치에 추가 커버 Gap당 10을 더하고 100에서 멈춘다", () => {
    expect(fitOf(fastapiPg, synthetic, "tool-a")?.fit.components.needCoverage).toBe(30); // low 1개
    expect(fitOf(fastapiPg, synthetic, "tool-f")?.fit.components.needCoverage).toBe(90); // high 1개
    expect(fitOf(fastapiPg, synthetic, "tool-b")?.fit.components.needCoverage).toBe(100); // high 2개 → 100
    expect(fitOf(reactTs, seed, "chrome-devtools-mcp")?.fit.components.needCoverage).toBe(100); // 90 + 20 → 100 상한
  });

  it("AC-021-02 E는 strong 100·environment 80·weak 40이며 관련 detector partial이면 ×75/100이다", () => {
    const e = (strength: "strong" | "environment" | "weak", partial: boolean) => evidenceScore({ strength, partial });
    expect([e("strong", false), e("environment", false), e("weak", false)]).toEqual([100, 80, 40]);
    expect([e("strong", true), e("environment", true), e("weak", true)]).toEqual([75, 60, 30]);
    const partial = profile({ frameworks: [item("react", "React")], aiClients: clients, detectors: { frameworks: "partial" } });
    expect(fitOf(partial, seed, "playwright-mcp")?.fit.components.evidenceStrength).toBe(75);
  });

  it("AC-021-02 S·K·V 경계값: 범용 50·stack 강도, client 비율·미탐지 50, platform·runtime·backend unknown 50", () => {
    expect(stackScore(fakeCompat({}))).toBe(50);
    expect(stackScore(fakeCompat({ stack: { generic: false, status: "compatible", matched: ["react"], strength: "weak" } }))).toBe(40);
    expect(stackScore(fakeCompat({ stack: { generic: false, status: "compatible", matched: ["react"], strength: "environment" } }))).toBe(80);
    expect(clientScore(fakeCompat({}))).toBe(50);
    expect(clientScore(fakeCompat({ clients: { status: "compatible", detected: ["claude-code", "codex", "cursor"], supported: ["claude-code"] } }))).toBe(33);
    expect(clientScore(fakeCompat({ clients: { status: "compatible", detected: ["claude-code", "codex"], supported: ["claude-code", "codex"] } }))).toBe(100);
    expect(environmentScore(fakeCompat({}))).toBe(50);
    expect(environmentScore(fakeCompat({ platform: { status: "compatible", value: "linux" } }))).toBe(66);
    expect(environmentScore(fakeCompat({ platform: { status: "compatible", value: "linux" }, runtime: { status: "compatible", requirements: {} }, backend: { status: "compatible", options: ["npx"] } }))).toBe(100);
  });

  it("AC-021-03 repository metadata 관련 값을 바꿔도 Fit은 변하지 않는다", () => {
    const base = fitOf(fastapiPg, synthetic, "tool-b");
    const altered = synthetic.map((e) =>
      e.manifest.name === "tool-b" ? { ...e, manifest: { ...e.manifest, repository: { github: "elsewhere/archived-repo" }, verification: "draft" as const, summary: "stars 1, archived" } } : e,
    );
    expect(fitOf(fastapiPg, altered, "tool-b")).toEqual(base);
    expect(computeProjectFit.length).toBe(1);
  });

  it("AC-021-04 incompatible이거나 resolved로 설치된 후보는 Fit을 계산하지 않는다", () => {
    const m = evaluate(profile({ frameworks: [item("react", "React")], aiClients: clients, aiTools: [tool("playwright")] }), seed);
    const installed = { ...(m.tools[0] as ToolEvaluation), status: "installed" as const };
    const incompatible = { ...(m.tools[0] as ToolEvaluation), status: "incompatible" as const };
    expect(computeProjectFit(installed)).toBeUndefined();
    expect(computeProjectFit(incompatible)).toBeUndefined();
    expect(m.tools.map((t) => t.entry.manifest.name)).not.toContain("playwright-mcp");
  });

  it("AC-021-05 FastAPI + PostgreSQL + Claude Code + Codex에서 tool-b의 Fit이 tool-a보다 높다(시나리오 13)", () => {
    const b = fitOf(fastapiPg, synthetic, "tool-b");
    const a = fitOf(fastapiPg, synthetic, "tool-a");
    expect(b?.fit.score).toBe(95);
    expect(a?.fit.components).toEqual({ needCoverage: 30, evidenceStrength: 100, stackMatch: 50, clientSupport: 100, environment: 66 });
    expect(a?.fit.score).toBe(65);
    expect((b?.fit.score ?? 0) > (a?.fit.score ?? 0)).toBe(true);
  });

  it("AC-021-06 같은 입력을 반복 계산하면 같은 정수 결과가 나온다", () => {
    const runs = Array.from({ length: 5 }, () => JSON.stringify(evaluate(reactTs, seed, { platform: "linux" }).tools.map((t) => computeProjectFit(t))));
    expect(new Set(runs).size).toBe(1);
  });

  it("AC-021-07 fitContribution은 floor((35·w+25·E+15·S+50)/100)이며 K·V가 빠져 있다", () => {
    expect(fitContribution({ priority: "high", strength: "strong", partial: false }, 100)).toBe(72);
    expect(fitContribution({ priority: "medium", strength: "strong", partial: false }, 100)).toBe(61);
    expect(fitContribution({ priority: "low", strength: "weak", partial: true }, 50)).toBe(Math.floor((35 * 30 + 25 * 30 + 15 * 50 + 50) / 100));
    const withClients = evaluate(reactTs, seed).tools.find((t) => t.entry.manifest.name === "playwright-mcp");
    const noClients = evaluate(profile({ frameworks: [item("react", "React")], languages: [item("typescript", "TypeScript", "config", { file: "tsconfig.json" })] }), seed).tools.find((t) => t.entry.manifest.name === "playwright-mcp");
    const contrib = (e: ToolEvaluation | undefined) => e?.covers.map((g) => fitContribution(g, stackScore(e)));
    expect(contrib(withClients)).toEqual(contrib(noClients));
    expect(computeProjectFit(withClients as ToolEvaluation)?.fit.score).not.toBe(computeProjectFit(noClients as ToolEvaluation)?.fit.score);
  });
});
