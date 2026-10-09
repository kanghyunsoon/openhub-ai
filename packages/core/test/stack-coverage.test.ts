import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  CAPABILITIES,
  KNOWN_TECH_IDS,
  NEED_RULES,
  TAXONOMY_VERSION,
  analyzeProject,
  diagnoseRecommendation,
  loadRegistry,
  recommend,
  recommendationReportSchema,
  type ProjectProfile,
  type RecommendationReport,
} from "../src/index";
import { REPO_ROOT, seedEntries } from "./recommendation/helpers";

/**
 * v0.2.0 P0-1 Stack Coverage. 네 층을 따로 본다.
 * A 스택 인식(근거·오탐) → B Need(규칙) → C Registry(검증 도구 유무) → D 추천(실제 결과·무관한 추천 없음).
 * 추천 결과는 Registry seed(7개)와 metadata 없음(OpenScore —)으로 결정론적이다.
 */
const FIXTURES = path.resolve(import.meta.dirname, "fixtures/projects");
const seed = await seedEntries();

async function analyze(name: string): Promise<{ profile: ProjectProfile; report: RecommendationReport }> {
  const r = await analyzeProject(path.join(FIXTURES, name));
  if (!r.ok) throw new Error(r.error.code);
  return { profile: r.profile, report: recommend(r.profile, seed, undefined, { platform: "linux" }) };
}
const ids = (items: readonly { id: string }[]) => items.map((i) => i.id).sort();
const ev = (items: readonly { id: string; evidence: readonly { file: string; type: string; value: string }[] }[], id: string) =>
  items.find((i) => i.id === id)?.evidence.map((e) => e.file + "|" + e.type + "|" + e.value) ?? [];
const needs = (r: RecommendationReport) => r.needs.map((n) => n.capability + ":" + n.priority).sort();
const recs = (r: RecommendationReport) => r.recommendations.map((x) => x.toolId).sort();
const needOf = (r: RecommendationReport, capability: string) => r.needs.find((n) => n.capability === capability);

describe("A. 스택 인식: 파일·의존성 근거로만 판정한다", () => {
  it("Go는 go.mod module 선언으로 인식한다", async () => {
    const { profile } = await analyze("go-service");
    expect(ids(profile.languages)).toEqual(["go"]);
    expect(ev(profile.languages, "go")).toContain("go.mod|manifest|module example.com/orders");
  });

  it("Express·Jest·PostgreSQL·TypeScript를 package.json 의존성과 설정 파일로 인식한다", async () => {
    const { profile } = await analyze("express-postgres-ts");
    expect(ids(profile.frameworks)).toEqual(["express", "jest"]);
    expect(ids(profile.databases)).toEqual(["postgresql"]);
    expect(ids(profile.languages)).toEqual(["javascript", "typescript"]);
    expect(ev(profile.frameworks, "express")).toEqual(["package.json|dependency|express"]);
    expect(ev(profile.frameworks, "jest")).toEqual(["jest.config.js|config|jest.config.js", "package.json|dependency|jest"]);
  });

  it("NestJS는 @nestjs/core로, Vitest는 의존성·설정 파일로 인식한다", async () => {
    const { profile } = await analyze("nestjs-app");
    expect(ids(profile.frameworks)).toEqual(["nestjs", "vitest"]);
    expect(ev(profile.frameworks, "nestjs")).toEqual(["package.json|dependency|@nestjs/core"]);
    expect(ev(profile.frameworks, "vitest")).toEqual(["package.json|dependency|vitest", "vitest.config.ts|config|vitest.config.ts"]);
  });

  it("Unity는 ProjectVersion.txt의 m_EditorVersion과 Packages/manifest.json의 com.unity 패키지로 인식한다", async () => {
    const { profile } = await analyze("unity-game");
    expect(ids(profile.frameworks)).toEqual(["unity"]);
    expect(ev(profile.frameworks, "unity")).toEqual(["Packages/manifest.json|manifest|com.unity packages: 3", "ProjectSettings/ProjectVersion.txt|config|m_EditorVersion: 2022.3.20f1"]);
    expect(profile.frameworks.find((f) => f.id === "unity")?.name).toBe("Unity");
  });

  it("Unreal Engine은 .uproject(EngineAssociation·Modules)와 .uplugin으로 인식한다", async () => {
    const { profile } = await analyze("unreal-game");
    expect(ids(profile.frameworks)).toEqual(["unreal-engine"]);
    expect(ev(profile.frameworks, "unreal-engine")).toEqual(["MyGame.uproject|config|EngineAssociation: 5.3", "Plugins/Inventory/Inventory.uplugin|config|plugin: Inventory"]);
  });

  it("Jest·Vitest·Playwright·Pytest를 각각의 의존성과 설정 파일로 인식한다", async () => {
    expect(ids((await analyze("jest-app")).profile.frameworks)).toEqual(["jest"]);
    const vite = (await analyze("vitest-app")).profile;
    expect(ids(vite.frameworks)).toEqual(["playwright", "react", "vitest"]);
    expect(ev(vite.frameworks, "playwright")).toEqual(["package.json|dependency|@playwright/test", "playwright.config.ts|config|playwright.config.ts"]);
    const py = (await analyze("pytest-app")).profile;
    expect(ids(py.frameworks)).toEqual(["pytest"]);
    expect(ev(py.frameworks, "pytest")).toEqual(["conftest.py|config|conftest.py", "pyproject.toml|dependency|pytest"]);
  });

  it("Kubernetes는 핵심 리소스 manifest·kustomization·Helm Chart로 인식하고 기존 Docker·Compose 인식은 그대로다", async () => {
    const { profile } = await analyze("k8s-deploy");
    expect(ids(profile.infrastructure)).toEqual(["docker", "docker-compose", "kubernetes"]);
    expect(ev(profile.infrastructure, "kubernetes")).toEqual([
      "charts/web/Chart.yaml|config|Helm chart: web",
      "deploy/k8s/app.yaml|config|Deployment, Service (apps/v1, v1)",
      "deploy/k8s/kustomization.yaml|config|kustomization",
    ]);
  });

  it("부정: 일반 C#·C++ 프로젝트를 Unity·Unreal로, README 언급을 기술로 오인하지 않는다", async () => {
    const cs = (await analyze("csharp-console")).profile;
    expect(ids(cs.frameworks)).toEqual([]);
    expect(ids(cs.languages)).toEqual(["csharp"]);
    const cpp = (await analyze("cpp-cmake")).profile;
    expect(ids(cpp.frameworks)).toEqual([]);
    expect(ids(cpp.languages)).toEqual(["cpp"]);
    const readme = (await analyze("readme-mentions")).profile;
    expect([...readme.languages, ...readme.frameworks, ...readme.databases, ...readme.infrastructure]).toEqual([]);
  });

  it("잘못된 manifest는 안전하게 처리한다: 근거가 없는 Unity·Kubernetes는 인식하지 않고 깨진 .uproject·go.mod는 낮은 신뢰도의 파일 존재 근거만 남긴다", async () => {
    const { profile } = await analyze("malformed-stack");
    expect(ids(profile.frameworks)).toEqual(["unreal-engine"]);
    expect(ev(profile.frameworks, "unreal-engine")).toEqual(["Broken.uproject|file-presence|Broken.uproject"]);
    expect(profile.frameworks[0]!.confidence).toBeLessThan(0.9);
    expect(ev(profile.languages, "go")).toEqual(["go.mod|file-presence|go.mod"]);
    expect(ids(profile.infrastructure)).toEqual([]);
  });

  it("모노레포: 하위 패키지의 기술을 모두 인식하고 같은 기술의 여러 근거는 항목 하나로 합친다", async () => {
    const { profile } = await analyze("polyglot-monorepo");
    expect(ids(profile.languages)).toEqual(["go", "javascript"]);
    expect(ids(profile.frameworks)).toEqual(["express", "jest", "react", "vitest"]);
    expect(ids(profile.infrastructure)).toEqual(["kubernetes"]);
    expect(ev(profile.frameworks, "express")).toEqual(["apps/web/package.json|dependency|express", "services/api/package.json|dependency|express"]);
  });
});

describe("B·C·D. Need·Registry·추천: 인식한 기술이 추천까지 이어지고 없는 도구를 만들지 않는다", () => {
  it("Go: 코드 탐색 need가 생기고 Serena만 추천한다(이전: 인식 0·추천 0)", async () => {
    const { report } = await analyze("go-service");
    expect(needs(report)).toEqual(["code-editing:low", "semantic-code-navigation:medium"]);
    expect(needOf(report, "semantic-code-navigation")?.sources.map((s) => s.itemId)).toEqual(["go"]);
    expect(recs(report)).toEqual(["serena"]);
  });

  it("Express: PostgreSQL·라이브러리 문서·코드 탐색을 추천하고 브라우저·E2E 도구는 추천하지 않는다", async () => {
    const { report } = await analyze("express-postgres-ts");
    expect(needOf(report, "library-docs")?.sources.map((s) => s.itemId)).toEqual(["express"]);
    expect(recs(report)).toEqual(["context7", "postgres-mcp", "serena"]);
  });

  it("NestJS: 라이브러리 문서와 코드 탐색을 추천한다", async () => {
    const { report } = await analyze("nestjs-app");
    expect(needOf(report, "library-docs")?.sources.map((s) => s.itemId)).toEqual(["nestjs"]);
    expect(recs(report)).toEqual(["context7", "serena"]);
  });

  it("Unity·Unreal: 게임 엔진 에디터 연동 need는 생기지만 Verified Registry에 도구가 없어 추천을 만들지 않고 이유를 남긴다", async () => {
    for (const name of ["unity-game", "unreal-game"]) {
      const { profile, report } = await analyze(name);
      const need = needOf(report, "game-engine-editor");
      expect(need?.priority, name).toBe("high");
      expect(need?.candidates, name).toEqual([]);
      expect(need?.reasons.map((r) => r.code), name).toContain("no-candidate");
      expect(recs(report), name).toEqual(["serena"]);
      expect(diagnoseRecommendation(profile, report).needsWithoutVerifiedTool, name).toContain("game-engine-editor");
    }
  });

  it("Playwright를 쓰는 프로젝트는 E2E need에 Playwright MCP를 추천하고, Kubernetes는 도구 없음으로 설명한다", async () => {
    const vite = (await analyze("vitest-app")).report;
    expect(needOf(vite, "e2e-testing")?.sources.map((s) => s.itemId).sort()).toEqual(["playwright", "react"]);
    expect(recs(vite)).toContain("playwright-mcp");
    const k8s = await analyze("k8s-deploy");
    expect(needOf(k8s.report, "kubernetes-operations")?.candidates).toEqual([]);
    expect(diagnoseRecommendation(k8s.profile, k8s.report)).toMatchObject({ emptyReason: "no-verified-tool", needsWithoutVerifiedTool: ["kubernetes-operations"] });
  });

  it("결과 진단: 스택 미인식·연결 규칙 없음·도구 없음을 구분한다", async () => {
    const readme = await analyze("readme-mentions");
    expect(recs(readme.report)).toEqual([]);
    expect(diagnoseRecommendation(readme.profile, readme.report).emptyReason).toBe("no-stack-detected");
    const jest = await analyze("jest-app");
    expect(diagnoseRecommendation(jest.profile, jest.report).unmappedTechs).toEqual(["jest"]);
    const py = await analyze("pytest-app");
    expect(diagnoseRecommendation(py.profile, py.report).unmappedTechs).toEqual(["pytest"]);
    const full = await analyze("express-postgres-ts");
    expect(diagnoseRecommendation(full.profile, full.report)).toMatchObject({ emptyReason: null, unmappedTechs: ["jest"], needsWithoutVerifiedTool: [] });
  });

  it("기존 React + Spring 모노레포의 추천은 바뀌지 않는다", async () => {
    const { report } = await analyze("react-spring-monorepo");
    expect(recs(report)).toEqual(["chrome-devtools-mcp", "context7", "github-mcp-server", "playwright-mcp", "serena"]);
  });
});

describe("Taxonomy v2 계약", () => {
  const V1_CAPABILITIES = [
    ["browser-automation", "브라우저 자동화"], ["performance-tracing", "성능 추적"], ["network-inspection", "네트워크 검사"], ["e2e-testing", "E2E 테스트"],
    ["library-docs", "라이브러리 문서 조회"], ["github-api", "GitHub API"], ["issue-tracking", "이슈 관리"], ["pull-request-review", "PR 리뷰"],
    ["knowledge-graph-memory", "지식 그래프 메모리"], ["db-schema-access", "DB 스키마 조회"], ["sql-query", "SQL 질의"], ["query-tuning", "쿼리 튜닝"],
    ["semantic-code-navigation", "의미 기반 코드 탐색"], ["code-editing", "코드 편집"],
  ];
  const V1_TECH = {
    languages: ["typescript", "javascript", "python", "java", "csharp", "rust", "cpp"],
    frameworks: ["react", "nextjs", "vue", "spring-boot", "fastapi"],
    databases: ["postgresql", "mysql", "sqlite", "mongodb"],
    packageManagers: ["pnpm", "npm", "yarn", "bun", "pip", "uv", "maven", "gradle", "cargo"],
    infrastructure: ["docker", "docker-compose", "github-actions", "git"],
    aiClients: ["claude-code", "codex", "cursor"],
  } as const;

  it("taxonomyVersion은 2이고 v1의 capability·tech ID와 의미(label)는 그대로 남아 있으며 새 ID는 중복 없이 추가된다", () => {
    expect(TAXONOMY_VERSION).toBe(2);
    const labels = new Map(CAPABILITIES.map((c) => [c.id, c.label]));
    for (const [id, label] of V1_CAPABILITIES) expect(labels.get(id!), id).toBe(label);
    expect(CAPABILITIES.map((c) => c.id).slice(0, V1_CAPABILITIES.length)).toEqual(V1_CAPABILITIES.map(([id]) => id));
    expect(new Set(CAPABILITIES.map((c) => c.id)).size).toBe(CAPABILITIES.length);
    expect(CAPABILITIES.map((c) => c.id).slice(V1_CAPABILITIES.length)).toEqual(["game-engine-editor", "kubernetes-operations"]);
    for (const [cat, list] of Object.entries(V1_TECH)) expect((KNOWN_TECH_IDS as Record<string, readonly string[]>)[cat]!.slice(0, list.length), cat).toEqual(list);
    const all = Object.values(KNOWN_TECH_IDS).flat();
    expect(new Set(all).size).toBe(all.length);
  });

  it("기존 NR-01~08은 바뀌지 않고 새 규칙은 NR-09부터이며 trigger는 모두 알려진 tech ID다", () => {
    expect(NEED_RULES.slice(0, 8).map((r) => r.id)).toEqual(["NR-01", "NR-02", "NR-03", "NR-04", "NR-05", "NR-06", "NR-07", "NR-08"]);
    expect(JSON.stringify(NEED_RULES.slice(0, 8).map((r) => [r.category, r.triggers, r.needs]))).toBe(
      JSON.stringify([
        ["frameworks", ["react", "nextjs", "vue"], [{ capability: "browser-automation", priority: "high" }, { capability: "e2e-testing", priority: "high" }, { capability: "performance-tracing", priority: "medium" }, { capability: "network-inspection", priority: "medium" }]],
        ["databases", ["postgresql", "mysql"], [{ capability: "db-schema-access", priority: "high" }, { capability: "sql-query", priority: "high" }, { capability: "query-tuning", priority: "medium" }]],
        ["databases", ["sqlite"], [{ capability: "db-schema-access", priority: "high" }, { capability: "sql-query", priority: "high" }]],
        ["databases", ["mongodb"], [{ capability: "db-schema-access", priority: "high" }]],
        ["infrastructure", ["github-actions"], [{ capability: "github-api", priority: "high" }, { capability: "pull-request-review", priority: "medium" }, { capability: "issue-tracking", priority: "medium" }]],
        ["frameworks", ["react", "nextjs", "vue", "spring-boot", "fastapi"], [{ capability: "library-docs", priority: "medium" }]],
        ["languages", ["typescript", "javascript", "python", "java", "csharp", "rust", "cpp"], [{ capability: "semantic-code-navigation", priority: "medium" }, { capability: "code-editing", priority: "low" }]],
        ["aiClients", ["claude-code", "codex", "cursor"], [{ capability: "knowledge-graph-memory", priority: "low" }]],
      ]),
    );
    expect(NEED_RULES.slice(8).map((r) => r.id)).toEqual(["NR-09", "NR-10", "NR-11", "NR-12", "NR-13"]);
    for (const r of NEED_RULES) for (const t of r.triggers) expect((KNOWN_TECH_IDS[r.category] as readonly string[]).includes(t), r.id + " " + t).toBe(true);
  });

  it("기존 Registry Manifest가 taxonomy v2 검증을 통과한다", async () => {
    const { entries, issues } = await loadRegistry(path.join(REPO_ROOT, "registry"));
    expect(issues).toEqual([]);
    expect(entries.length).toBe(7);
  });

  it("taxonomyVersion 1로 만든 보고서는 조용히 해석하지 않고 schema 검증에서 거부한다(다시 생성해야 한다)", async () => {
    const { report } = await analyze("go-service");
    expect(report.generatedFrom.taxonomyVersion).toBe(2);
    const old = { ...report, generatedFrom: { ...report.generatedFrom, taxonomyVersion: 1 } };
    const parsed = recommendationReportSchema.safeParse(old);
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues.map((i) => i.path))).toContain("taxonomyVersion");
  });
});

