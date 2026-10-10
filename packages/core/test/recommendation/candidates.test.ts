import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyGaps,
  deriveNeeds,
  evaluateCompatibility,
  matchCandidates,
  resolveInstalledTools,
  satisfiesRange,
  type ProjectProfile,
  type RecommendContext,
  type RegistryEntry,
} from "../../src/index";
import { REPO_ROOT, fixtureProfile, item, profile, seedEntries, shuffled, syntheticEntries, tool } from "./helpers";

const seed = await seedEntries();
const synthetic = await syntheticEntries();
const match = (p: ProjectProfile, entries: readonly RegistryEntry[], context: RecommendContext = {}) => {
  const installed = resolveInstalledTools(p, entries);
  return matchCandidates(p, classifyGaps(p, deriveNeeds(p), installed), installed, entries, context);
};
const manifestOf = (entries: readonly RegistryEntry[], name: string) => {
  const m = entries.find((e) => e.manifest.name === name)?.manifest;
  if (m === undefined) throw new Error(name);
  return m;
};
const claude = item("claude-code", "Claude Code", "config", { file: ".mcp.json" });
const postgresProject = profile({ frameworks: [item("fastapi", "FastAPI")], databases: [item("postgresql", "PostgreSQL")], aiClients: [claude] });
const springMysql = profile({ languages: [item("java", "Java", "manifest", { file: "pom.xml" })], frameworks: [item("spring-boot", "Spring Boot", "dependency", { file: "pom.xml" })], databases: [item("mysql", "MySQL", "dependency", { file: "pom.xml" })], aiClients: [claude] });

describe("REQ-021 Candidate Matcher와 Compatibility", () => {
  it("AC-020-01 미충족 need의 후보는 그 capability를 선언한 Manifest 전체이며 toolId 오름차순으로 결정적이다", () => {
    const a = match(postgresProject, synthetic);
    expect(a.candidates.get("sql-query")?.map((c) => c.toolId)).toEqual(["tool-b", "tool-f"]);
    expect(a.candidates.get("db-schema-access")?.map((c) => c.toolId)).toEqual(["tool-b"]);
    const b = match(postgresProject, shuffled(synthetic));
    expect(JSON.stringify([...b.candidates])).toBe(JSON.stringify([...a.candidates]));
    expect(match(postgresProject, seed).candidates.get("sql-query")?.map((c) => c.toolId)).toEqual(["postgres-mcp"]);
  });

  it("AC-020-02 stacks가 맞지 않으면 stack-mismatch로 제외되고 Spring Boot + MySQL의 DB Gap 추천 후보는 0개다(시나리오 3, 10)", async () => {
    for (const p of [springMysql, await fixtureProfile("react-spring-monorepo")]) {
      const m = match(p, seed);
      // v0.2.0 P0-2: mongodb-mcp-server(appliesTo mongodb)도 MySQL 프로젝트에서는 stack-mismatch다. sql-query는 제공하지 않는다.
      for (const cap of ["db-schema-access", "query-tuning"]) {
        expect(m.candidates.get(cap)).toEqual([
          { toolId: "mongodb-mcp-server", status: "incompatible", excludedBy: ["stack-mismatch"] },
          { toolId: "postgres-mcp", status: "incompatible", excludedBy: ["stack-mismatch"] },
        ]);
      }
      expect(m.candidates.get("sql-query")).toEqual([{ toolId: "postgres-mcp", status: "incompatible", excludedBy: ["stack-mismatch"] }]);
      expect(m.tools.map((t) => t.entry.manifest.name)).not.toContain("postgres-mcp");
      expect(m.tools.map((t) => t.entry.manifest.name)).not.toContain("mongodb-mcp-server");
    }
  });

  it("AC-020-03 targets와 탐지된 aiClients의 교집합이 없으면 client-unsupported다", () => {
    const c = evaluateCompatibility(manifestOf(synthetic, "tool-g"), profile({ frameworks: [item("react", "React")], aiClients: [claude] }));
    expect(c.clients).toEqual({ status: "incompatible", detected: ["claude-code"], supported: [] });
    expect(c.excludedBy).toContain("client-unsupported");
    expect(c.overall).toBe("incompatible");
  });

  it("AC-020-03 aiClients가 탐지되지 않으면 client 호환성은 unknown이다", () => {
    const c = evaluateCompatibility(manifestOf(seed, "playwright-mcp"), profile({ frameworks: [item("react", "React")] }));
    expect(c.clients).toEqual({ status: "unknown", detected: [], supported: [] });
    expect(c.overall).toBe("unverified");
  });

  it("AC-020-04 지원하지 않는 platform은 incompatible, platform이 없으면 unknown이다(tool-g)", () => {
    const g = manifestOf(synthetic, "tool-g");
    const p = profile({ frameworks: [item("react", "React")] });
    expect(evaluateCompatibility(g, p, { platform: "windows" }).platform).toEqual({ status: "incompatible", value: "windows" });
    expect(evaluateCompatibility(g, p, { platform: "windows" }).excludedBy).toContain("platform-unsupported");
    expect(evaluateCompatibility(g, p, { platform: "macos" }).platform.status).toBe("compatible");
    expect(evaluateCompatibility(g, p).platform).toEqual({ status: "unknown", value: null });
  });

  it("AC-020-05 runtime 버전이 주어지고 range를 만족하지 않으면 incompatible, 없으면 unknown이다", () => {
    const g = manifestOf(synthetic, "tool-g");
    const b = manifestOf(synthetic, "tool-b");
    expect(evaluateCompatibility(g, postgresProject, { runtimes: { node: "24.18.0" } }).runtime).toEqual({ status: "incompatible", requirements: { node: ">=99" } });
    expect(evaluateCompatibility(g, postgresProject).runtime.status).toBe("unknown");
    expect(evaluateCompatibility(b, postgresProject, { runtimes: { python: "3.12.1" } }).runtime.status).toBe("compatible");
    expect(evaluateCompatibility(b, postgresProject, { runtimes: { python: "3.11.9" } }).excludedBy).toContain("runtime-unsatisfied");
  });

  it("AC-020-05 range 해석은 >=·<·콤마 결합을 지원하고 해석할 수 없으면 unknown이다", () => {
    expect(satisfiesRange("20.19.0", ">=20.19")).toBe(true);
    expect(satisfiesRange("20.18.9", ">=20.19")).toBe(false);
    expect(satisfiesRange("3.14.0", ">=3.11,<3.15")).toBe(true);
    expect(satisfiesRange("3.15.0", ">=3.11,<3.15")).toBe(false);
    expect(satisfiesRange("v18.0.0", ">=18")).toBe(true);
    expect(satisfiesRange("24.0.0", "^24")).toBeUndefined();
    expect(satisfiesRange("latest", ">=18")).toBeUndefined();
  });

  it("AC-020-06 availableBackends가 install 옵션과 겹치지 않으면 incompatible, 넘기지 않으면 unknown이다", () => {
    const g = manifestOf(synthetic, "tool-g");
    const b = manifestOf(synthetic, "tool-b");
    expect(evaluateCompatibility(g, postgresProject, { availableBackends: ["npx", "uvx"] }).backend).toEqual({ status: "incompatible", options: ["docker"] });
    expect(evaluateCompatibility(g, postgresProject, { availableBackends: ["npx", "uvx"] }).excludedBy).toContain("backend-unavailable");
    expect(evaluateCompatibility(b, postgresProject, { availableBackends: ["docker"] }).backend).toEqual({ status: "compatible", options: ["uvx", "docker"] });
    expect(evaluateCompatibility(b, postgresProject).backend.status).toBe("unknown");
  });

  it("AC-020-07 resolved 설치 tool은 installed로 제외되고 겹치는 capability를 제공하는 후보에는 capability-overlap이 기록된다", () => {
    const p = profile({ frameworks: [item("react", "React")], aiClients: [claude], aiTools: [tool("playwright")], detectors: { "host-probe": "ok" } });
    const m = match(p, seed);
    expect(m.candidates.get("browser-automation")).toEqual([{ toolId: "playwright-mcp", status: "installed", excludedBy: ["installed"] }]);
    expect(m.tools.map((t) => t.entry.manifest.name)).not.toContain("playwright-mcp");
    const chrome = m.tools.find((t) => t.entry.manifest.name === "chrome-devtools-mcp");
    expect(chrome?.covers.map((g) => g.capability)).toEqual(["network-inspection", "performance-tracing"]);
    expect(chrome?.conflicts).toEqual([{ type: "capability-overlap", capability: "browser-automation", with: { toolId: "playwright-mcp", serverName: "playwright", scope: "project" } }]);
  });

  it("AC-020-08 required env는 이름만 기록하고 process.env를 읽지 않으며 installer를 import하지 않는다", async () => {
    const original = process.env;
    const touched: PropertyKey[] = [];
    process.env = new Proxy(original, { get: (t, k) => (touched.push(k), Reflect.get(t, k)) });
    let m;
    try {
      m = match(postgresProject, synthetic, { platform: "linux" });
    } finally {
      process.env = original;
    }
    expect(touched).toEqual([]);
    expect(m.tools.find((t) => t.entry.manifest.name === "tool-b")?.requiredEnv).toEqual(["DATABASE_URI"]);
    expect(JSON.stringify(m.tools.map((t) => [t.requiredEnv, t.compatibility]))).not.toContain("secret-password");
    const dir = path.join(REPO_ROOT, "packages/core/src/recommendation");
    for (const file of await readdir(dir)) {
      const text = await readFile(path.join(dir, file), "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*installer/u);
      expect(text, file).not.toMatch(/process\.env\s*[.[]|=\s*process\.env\b|\{[^}]*\}\s*=\s*process\.env/u);
    }
  });

  it("AC-020-09 같은 capability의 후보 여러 개(tool-b·tool-f의 sql-query)가 모두 유지된다(시나리오 11)", () => {
    const m = match(postgresProject, synthetic);
    expect(m.candidates.get("sql-query")).toEqual([
      { toolId: "tool-b", status: "recommended" },
      { toolId: "tool-f", status: "recommended" },
    ]);
    expect(m.tools.filter((t) => t.covers.some((g) => g.capability === "sql-query")).map((t) => t.entry.manifest.name)).toEqual(["tool-b", "tool-f"]);
  });
});
