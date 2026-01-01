import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject, loadMetadataSnapshot, loadRegistry, recommend, type MetadataSnapshot, type RecommendationReport } from "@openhub/core";
import { OPEN_SCORE_NOTICE, buildForYouView } from "../src/for-you-view";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, recommendCurrentProject, registerProjectRecommend, type RecommendResponse } from "../src/recommend";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const PROJECTS = path.join(ROOT, "packages/core/test/fixtures/projects");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const deps = { registryDir: path.join(ROOT, "registry"), metadataFile: SEED_SNAPSHOT, platform: "linux" };
const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");

function fakeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return { handlers, handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
}

async function wired(project: string) {
  const ipc = fakeIpc();
  const session = new RecommendSession();
  registerProjectScan(session.observe(ipc), fixedDirectory(path.join(PROJECTS, project)));
  registerProjectRecommend(ipc, session, deps);
  return { ipc, session, scan: () => ipc.handlers.get(PROJECT_SCAN_CHANNEL)?.({}), recommend: (...args: unknown[]) => ipc.handlers.get(PROJECT_RECOMMEND_CHANNEL)?.({}, ...args) as Promise<RecommendResponse> };
}

async function reportFor(project: string, snapshot: MetadataSnapshot | undefined): Promise<RecommendationReport> {
  const a = await analyzeProject(path.join(PROJECTS, project));
  if (!a.ok) throw new Error("analysis");
  return recommend(a.profile, (await loadRegistry(deps.registryDir)).entries, snapshot, { platform: "linux" });
}

describe("REQ-022 Desktop FOR YOU", () => {
  it("AC-026-01 메인 프로세스는 대화상자로 분석한 프로젝트만 Core recommend에 넘기고 renderer 인자를 무시한다", async () => {
    const w = await wired("python-fastapi");
    expect(await w.recommend()).toEqual({ status: "no-project" });
    await w.scan();
    const response = await w.recommend("C:/Windows/System32", { profile: { project: { name: "evil" } } });
    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    expect(response.view.projectName).toBe("python-fastapi");
    expect(response.view.items.map((i) => i.toolId)).toEqual((await reportFor("python-fastapi", await loadMetadataSnapshot(SEED_SNAPSHOT))).recommendations.map((r) => r.toolId));
  });

  it("AC-026-01 preload는 인자 없는 recommendProject만 노출하고 Desktop은 Host Probe를 실행하지 않는다", async () => {
    const preload = await read("src/preload.ts");
    expect(preload).toMatch(/recommendProject: \(\) => ipcRenderer\.invoke\("project:recommend"\)/u);
    for (const file of ["src/recommend.ts", "src/for-you-view.ts", "renderer/for-you.js"]) expect(await read(file), file).not.toMatch(/includeHost|probeHost/u);
    const w = await wired("react-pnpm");
    await w.scan();
    const r = await w.recommend();
    expect(r.status === "ok" && r.view.scope).toBe("프로젝트 범위(사용자 범위 미검사)");
  });

  it("AC-026-02 추천 목록은 이름·Project Fit·OpenScore(분리)·이유 최대 3개·상태 배지를 가진다", async () => {
    const view = buildForYouView(await reportFor("react-pnpm", await loadMetadataSnapshot(SEED_SNAPSHOT)));
    expect(view.items.length).toBeGreaterThan(0);
    for (const item of view.items) {
      expect(item.name.length).toBeGreaterThan(0);
      expect(item.projectFit).toMatch(/^\d\.\d{2}$/u);
      expect(item.openScore).toMatch(/^(\d\.\d{2}|—)$/u);
      expect(item.reasons.length).toBeLessThanOrEqual(3);
      expect(item.badges.length).toBeGreaterThan(0);
    }
    const js = await read("renderer/for-you.js");
    expect(js).toContain("Project Fit ${view.projectFit}");
    expect(js).toContain("OpenScore ${view.openScore}");
    expect(await read("renderer/index.html")).not.toContain("프로젝트 맞춤 추천은 M3(Recommendation)에서 연결됩니다.");
  });

  it("AC-026-03 판단 보류·사용자 범위 미검사·식별되지 않은 MCP 배지를 구분한다", async () => {
    const base = await reportFor("claude-mcp", undefined);
    const view = buildForYouView(base);
    expect(view.items.every((i) => i.badges.some((b) => b.kind === "host-unchecked" && b.label === "사용자 범위 미검사"))).toBe(true);
    const unresolved: RecommendationReport = { ...base, recommendations: base.recommendations.map((r) => ({ ...r, installation: { ...r.installation, status: "unidentified-present" as const } })) };
    expect(buildForYouView(unresolved).items[0]?.badges.map((b) => b.label)).toContain("식별되지 않은 MCP 있음");
    const unknown: RecommendationReport = { ...base, recommendations: base.recommendations.map((r) => ({ ...r, installation: { ...r.installation, status: "unknown" as const } })) };
    expect(buildForYouView(unknown).items[0]?.badges.map((b) => b.label)).toContain("판단 보류");
    const labels = new Set(["판단 보류", "사용자 범위 미검사", "식별되지 않은 MCP 있음"]);
    expect(labels.size).toBe(3);
  });

  // AC-036-08(M4)로 갱신: M3에서는 설치 기능이 없어 "설치 버튼 없음·IPC 0회"를 검증했다. M4에서 설치 흐름이 생겼으므로
  // 계약을 "FOR YOU 모듈은 여전히 추천만 하고(recommendProject만 호출, 설치 코드 없음), 설치 버튼은 별도 install.js가
  // 붙이며 install.js는 planInstall·runInstall만 호출한다"로 바꾼다. 정적 HTML 버튼은 여전히 [프로젝트 선택] 하나다.
  it("AC-026-04 FOR YOU 모듈은 추천만 하고(recommendProject만 호출) 설치 버튼은 install.js만 붙인다", async () => {
    const html = await read("renderer/index.html");
    expect([...html.matchAll(/<button\b[^>]*id="([^"]+)"/gu)].map((m) => m[1])).toEqual(["project-select"]);
    const js = await read("renderer/for-you.js");
    expect(js).not.toMatch(/createElement\("button"\)|install|addEventListener\("click"/iu);
    expect([...new Set([...js.matchAll(/window\.openhub\.(\w+)/gu)].map((m) => m[1]))]).toEqual(["recommendProject"]);
    const install = await read("renderer/install.js");
    expect([...new Set([...install.matchAll(/window\.openhub\.(\w+)/gu)].map((m) => m[1]))].sort()).toEqual(["planInstall", "runInstall"]);
    expect(install).toContain('"설치 계획 보기"');
  });

  it("AC-026-05 후보가 없는 Gap은 '등록된 도구 없음'으로 표시된다", async () => {
    const view = buildForYouView(await reportFor("react-spring-monorepo", undefined));
    expect(view.noCandidate.map((g) => g.capability)).toEqual(expect.arrayContaining(["db-schema-access", "sql-query", "query-tuning"]));
    for (const g of view.noCandidate) expect(g.message).toBe("등록된 도구 없음");
  });

  it("AC-026-06 이름·이유는 textContent로만 렌더링되고 XSS 문자열은 텍스트로 남는다", async () => {
    const base = await reportFor("python-fastapi", undefined);
    const xss = '<img src=x onerror="alert(1)">';
    const view = buildForYouView({ ...base, recommendations: base.recommendations.map((r) => ({ ...r, displayName: xss, reasons: [{ ...r.reasons[0]!, message: xss }] })) });
    expect(view.items[0]?.name).toBe(xss);
    expect(view.items[0]?.reasons).toEqual([xss]);
    const js = await read("renderer/for-you.js");
    expect(js).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write|\brequire\(/u);
    expect(js).toContain("node.textContent = text");
  });

  it("AC-026-07 PROJECT 카드 연동은 그대로이고 FOR YOU는 별도 모듈로 PROJECT 렌더링 뒤에 연결된다", async () => {
    const html = await read("renderer/index.html");
    expect(html.indexOf('src="project.js"')).toBeLessThan(html.indexOf('src="for-you.js"'));
    expect(html).toContain('id="project-body"');
    // Requirement 추적 주석 검사는 test/internal-truth.internal.test.ts로 옮겼다(TASK-074, public export 제외).
    const main = await read("src/main.ts");
    expect(main).toContain("registerProjectScan(recommendSession.observe(ipcMain)");
    expect(main).toContain("registerProjectRecommend(ipcMain, recommendSession");
    const session = new RecommendSession();
    expect(await recommendCurrentProject(session, deps)).toEqual({ status: "no-project" });
  });

  it("AC-026-08 OpenScore 라벨 옆에 의미 안내가 있고 cache가 없으면 한 줄 안내를 보여준다", async () => {
    const html = await read("renderer/index.html");
    expect(html).toContain(OPEN_SCORE_NOTICE);
    const js = await read("renderer/for-you.js");
    expect(js).toContain("저장소 신호 · 보안·품질 평가 아님");
    const noCache = buildForYouView(await reportFor("python-fastapi", undefined));
    expect(noCache.notice).toBe(OPEN_SCORE_NOTICE);
    expect(noCache.openScoreUnavailable).toContain("metadata cache가 없어");
    expect(noCache.items.every((i) => i.openScore === "—")).toBe(true);
  });
});
