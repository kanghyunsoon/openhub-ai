import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  InstallationRouter,
  analyzeProject,
  containsAbsolutePath,
  loadMetadataSnapshot,
  loadRegistry,
  recommend,
  recommendationReportSchema,
  serializeRecommendationReport,
  type HostFs,
  type MetadataSnapshot,
} from "@openhub/core";
import { runCli } from "../src/cli";
import { OPEN_SCORE_NOTICE } from "../src/recommend";
import { memoryIO } from "./helpers";

const REPO = path.resolve(import.meta.dirname, "../../..");
const PROJECTS = path.join(REPO, "packages/core/test/fixtures/projects");
const GOLDENS = path.join(import.meta.dirname, "fixtures/recommend");
const UPDATE = process.env["OPENHUB_UPDATE_GOLDEN"] === "1";
const snapshot = (await loadMetadataSnapshot(path.join(REPO, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json"))) as MetadataSnapshot;

afterEach(() => vi.restoreAllMocks());

function io(extra: Record<string, unknown> = {}) {
  return Object.assign(memoryIO(REPO), { metadataSnapshot: snapshot, platform: "linux" }, extra);
}

async function golden(name: string, actual: string) {
  const file = path.join(GOLDENS, name);
  if (UPDATE) {
    await mkdir(GOLDENS, { recursive: true });
    await writeFile(file, actual);
  }
  if (!existsSync(file)) throw new Error(`golden 없음: ${name} — OPENHUB_UPDATE_GOLDEN=1로 생성하세요`);
  expect(actual).toBe(await readFile(file, "utf8"));
}

async function withHome<T>(files: Record<string, string>, fn: (home: string, fs: HostFs, calls: string[]) => Promise<T>): Promise<T> {
  const home = await mkdtemp(path.join(tmpdir(), "openhub-rec-home-"));
  try {
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(home, rel)), { recursive: true });
      await writeFile(path.join(home, rel), text);
    }
    const calls: string[] = [];
    const fs: HostFs = {
      stat: async (f) => (calls.push(f), stat(f)),
      readFile: async (f) => (calls.push(f), readFile(f, "utf8")),
    };
    return await fn(home, fs, calls);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

describe("REQ-022 openhub project recommend", () => {
  it("AC-025-01 사람이 읽는 출력(순위·이름·Project Fit·OpenScore·이유)이 golden과 일치한다", async () => {
    const x = io();
    expect(await runCli(["project", "recommend", path.join(PROJECTS, "react-pnpm")], x)).toBe(0);
    const out = x.stdout.join("\n") + "\n";
    expect(out).toMatch(/ 1\. .+ \(.+\)  \[likely-gap · high · /u);
    expect(out).toContain("Project Fit 0.");
    expect(out).toContain("OpenScore 0.");
    await golden("react-pnpm.txt", out);
  });

  it("AC-025-02 --json 출력은 Core 직렬화 결과와 바이트 단위로 같고 schema를 통과한다", async () => {
    const x = io();
    expect(await runCli(["project", "recommend", path.join(PROJECTS, "python-fastapi"), "--json"], x)).toBe(0);
    const analysis = await analyzeProject(path.join(PROJECTS, "python-fastapi"));
    if (!analysis.ok) throw new Error("analysis");
    const { entries } = await loadRegistry(path.join(REPO, "registry"));
    expect(x.stdout.join("\n") + "\n").toBe(serializeRecommendationReport(recommend(analysis.profile, entries, snapshot, { platform: "linux" })));
    expect(recommendationReportSchema.safeParse(JSON.parse(x.stdout.join("\n"))).success).toBe(true);
  });

  it("AC-025-03 --include-host가 없으면 Host Probe를 호출하지 않고, 있으면 호출해 사용자 범위 설치를 반영한다", async () => {
    await withHome({ ".claude.json": JSON.stringify({ mcpServers: { playwright: { command: "npx", env: { TOKEN: "FAKE-HOST-TOKEN" } } } }) }, async (home, fs, calls) => {
      const hostEnvironment = { homeDir: home, pathEnv: "", pathExt: "", platform: process.platform, fs };
      const off = io({ hostEnvironment });
      expect(await runCli(["project", "recommend", path.join(PROJECTS, "react-pnpm"), "--json"], off)).toBe(0);
      expect(calls).toEqual([]);
      const offReport = recommendationReportSchema.parse(JSON.parse(off.stdout.join("\n")));
      expect(offReport.assessment.inspectedScopes).toEqual(["project"]);
      expect(offReport.recommendations.map((r) => r.toolId)).toContain("playwright-mcp");

      const on = io({ hostEnvironment });
      expect(await runCli(["project", "recommend", path.join(PROJECTS, "react-pnpm"), "--json", "--include-host"], on)).toBe(0);
      expect(calls.length).toBeGreaterThan(0);
      const onReport = recommendationReportSchema.parse(JSON.parse(on.stdout.join("\n")));
      expect(onReport.assessment.inspectedScopes).toEqual(["project", "user"]);
      expect(onReport.needs.find((n) => n.capability === "browser-automation")?.satisfiedBy).toEqual([{ toolId: "playwright-mcp", serverName: "playwright", scope: "user" }]);
      expect(onReport.recommendations.map((r) => r.toolId)).not.toContain("playwright-mcp");
      expect(on.stdout.join("\n")).not.toContain("FAKE-HOST-TOKEN");
      expect(on.stdout.join("\n")).not.toContain(home);
    });
  });

  it("AC-025-04 경로 오류·분석 실패는 0이 아닌 종료 코드와 고정 문구만 출력한다", async () => {
    const missing = io();
    expect(await runCli(["project", "recommend", path.join(REPO, "does-not-exist-xyz")], missing)).toBe(1);
    expect(missing.stderr).toEqual(["추천할 수 없습니다: 프로젝트를 분석하지 못했습니다 (root-not-found)"]);
    const file = io();
    expect(await runCli(["project", "recommend", path.join(REPO, "package.json")], file)).toBe(1);
    for (const line of [...missing.stderr, ...file.stderr]) {
      expect(containsAbsolutePath(line)).toBe(false);
      expect(line).not.toMatch(/\n\s+at /u);
    }
    expect(await runCli(["project", "recommend"], io())).toBe(2);
    expect(await runCli(["project", "recommend", ".", "--yaml"], io())).toBe(2);
  });

  it("AC-025-05 metadata cache가 없어도 추천을 출력하고 OpenScore는 —와 안내 한 줄이며 종료 코드는 0이다", async () => {
    const x = io({ metadataSnapshot: null });
    expect(await runCli(["project", "recommend", path.join(PROJECTS, "python-fastapi")], x)).toBe(0);
    const out = x.stdout.join("\n");
    expect(out).toContain("OpenScore —");
    expect(out.match(/OpenScore —: metadata cache가 없어 계산하지 않았습니다/gu)).toHaveLength(1);
    expect(out).toContain("1. Postgres MCP Pro (postgres-mcp)");
  });

  for (const name of ["react-pnpm", "nextjs-app", "react-spring-monorepo", "python-fastapi"]) {
    it(`AC-025-06 ${name} 추천 JSON이 golden과 일치한다(시나리오 1~4)`, async () => {
      const x = io();
      expect(await runCli(["project", "recommend", path.join(PROJECTS, name), "--json"], x)).toBe(0);
      await golden(`${name}.json`, x.stdout.join("\n") + "\n");
    });
  }

  it("AC-025-07 실행 중 installer와 네트워크(fetch) 호출이 0회다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const selectSpy = vi.spyOn(InstallationRouter.prototype, "select");
    expect(await runCli(["project", "recommend", path.join(PROJECTS, "claude-mcp")], io())).toBe(0);
    expect(await runCli(["project", "recommend", path.join(PROJECTS, "claude-mcp"), "--json"], io({ metadataSnapshot: null }))).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(selectSpy).not.toHaveBeenCalled();
  });

  it("AC-025-08 출력에 OpenScore 의미 안내가 한 줄 있다", async () => {
    const x = io();
    expect(await runCli(["project", "recommend", path.join(PROJECTS, "nextjs-app")], x)).toBe(0);
    expect(x.stdout.filter((l) => l === OPEN_SCORE_NOTICE)).toHaveLength(1);
    expect(OPEN_SCORE_NOTICE).toBe("OpenScore는 저장소 유지관리·활동성·커뮤니티 신호이며 보안·코드 품질 평가가 아닙니다");
  });
});

describe("REQ-046 project recommend Identity Fingerprint 연결", () => {
  it("AC-051-01 alias가 다른 project MCP도 package가 같으면 strong으로 resolved되고 이유가 warnings에 붙는다", async () => {
    const project = await mkdtemp(path.join(tmpdir(), "openhub-rec-identity-"));
    try {
      await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "identity-demo", dependencies: { react: "^19.0.0" } }));
      await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { "team-memory": { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@2025.9.1"], env: { SECRET_VALUE: "sk-proj-abcdefghijklmnopqrstuvwxyz" } } } }));
      const x = io();
      expect(await runCli(["project", "recommend", project, "--json"], x)).toBe(0);
      const report = recommendationReportSchema.parse(JSON.parse(x.stdout.join("\n")));
      expect(report.installedTools.map((t) => [t.serverName, t.resolution, t.toolId])).toEqual([["team-memory", "resolved", "memory-mcp"]]);
      expect(report.assessment.warnings.map((w) => w.code)).toContain("identity-strong-match");
      expect(x.stdout.join("\n")).not.toMatch(/sk-proj|SECRET_VALUE/u);
      expect(containsAbsolutePath(x.stdout.join("\n"))).toBe(false);
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  });
});
