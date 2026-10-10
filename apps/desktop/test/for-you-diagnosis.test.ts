import path from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import { EMPTY_REASONS, EXCLUSION_CODES, analyzeProject, loadRegistry, recommend, type ProjectProfile, type RecommendContext, type RegistryEntry } from "@openhub/core";
import { buildForYouView, type ForYouView } from "../src/for-you-view";
import { en } from "../src/i18n/en";
import { ko } from "../src/i18n/ko";
import { setDesktopLocale } from "../src/i18n/index";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend, type RecommendResponse } from "../src/recommend";
import { item, profile, tool } from "../../../packages/core/test/recommendation/helpers";

/**
 * v0.2.0 P0-3 C3 추천 진단. FOR YOU가 추천 0개·후보 제외 이유를 Core diagnoseRecommendation과 RecommendationReport의
 * excludedBy 코드 그대로 보여 주는지 검증한다. 새 점수·후보를 만들지 않고, 검증 수준은 제외 사유가 아니라 정보로만 보인다.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const PROJECTS = path.join(ROOT, "packages/core/test/fixtures/projects");
const { entries } = await loadRegistry(path.join(ROOT, "registry"));
const HANGUL = /[\uac00-\ud7a3]/u;
afterAll(() => setDesktopLocale("ko"));

async function fixtureProfile(name: string): Promise<ProjectProfile> {
  const a = await analyzeProject(path.join(PROJECTS, name));
  if (!a.ok) throw new Error(name);
  return a.profile;
}
function viewOf(p: ProjectProfile, list: readonly RegistryEntry[] = entries, context: RecommendContext = { platform: "linux" }): { view: ForYouView; report: ReturnType<typeof recommend> } {
  const report = recommend(p, list, undefined, context);
  return { view: buildForYouView(report, { profile: p, entries: list, platform: context.platform ?? "linux" }), report };
}
const claude = item("claude-code", "Claude Code", "config", { file: ".mcp.json" });
// AI Client를 넣으면 범용 need(예: memory)가 함께 추천되므로, "0개" 사유를 보는 합성 Profile에는 Client를 넣지 않는다.
const k8sProfile = (extra: Parameters<typeof profile>[0] = {}) => profile({ infrastructure: [item("kubernetes", "Kubernetes", "config", { file: "k8s/deployment.yaml" })], ...extra });
const withK8s = (change: (m: RegistryEntry["manifest"]) => void): RegistryEntry[] =>
  entries.map((e) => {
    if (e.manifest.name !== "kubernetes-mcp-server") return e;
    const copy = structuredClone(e);
    change(copy.manifest);
    return copy;
  });

describe("v0.2.0 C3 추천 진단: 추천이 0개인 이유", () => {
  it("스택 미인식(README 언급만)은 no-stack-detected를 영어·한국어로 설명한다", async () => {
    const p = await fixtureProfile("readme-mentions");
    for (const locale of ["en", "ko"] as const) {
      setDesktopLocale(locale);
      const { view } = viewOf(p);
      expect(view.items).toEqual([]);
      expect(view.diagnosis?.empty).toEqual({ code: "no-stack-detected", text: (locale === "en" ? en : ko)["forYou.empty.noStackDetected"] });
    }
  });

  it("Verified Registry에 도구가 없는 need만 있으면 no-verified-tool이다(Unity 에디터 프로젝트)", async () => {
    setDesktopLocale("en");
    const { view } = viewOf(await fixtureProfile("unity-editor-only"));
    expect(view.diagnosis).toMatchObject({ empty: { code: "no-verified-tool" }, unmappedTechs: [], excluded: [] });
    expect(view.noCandidate.map((g) => g.capability)).toEqual(["game-engine-editor"]);
  });

  it("인식한 기술에 규칙이 없으면 no-mapped-need이다(Docker만 있는 합성 프로젝트, Docker는 의도적으로 규칙 없음)", () => {
    setDesktopLocale("en");
    const { view } = viewOf(profile({ infrastructure: [item("docker", "Docker", "config", { file: "Dockerfile" })] }));
    expect(view.diagnosis?.empty?.code).toBe("no-mapped-need");
  });

  it("필요한 Capability가 모두 설치된 도구로 충족되면 all-satisfied이고 그 도구는 '이미 설치됨(중복)'으로 제외 목록에 있다", () => {
    setDesktopLocale("en");
    const { view } = viewOf(k8sProfile({ aiTools: [tool("kubernetes")] }));
    expect(view.items).toEqual([]);
    expect(view.diagnosis?.empty?.code).toBe("all-satisfied");
    expect(view.diagnosis?.excluded.map((x) => [x.toolId, x.codes])).toEqual([["kubernetes-mcp-server", ["installed"]]]);
    expect(view.diagnosis?.excluded[0]?.text).toContain(en["forYou.exclusion.installed"]);
  });

  it("후보가 모두 제외되면 candidates-excluded이고 OS 미지원·Client 미지원·설치 방식 없음을 도구별로 보인다", () => {
    setDesktopLocale("en");
    const platform = viewOf(k8sProfile(), withK8s((m) => void (m.platform.linux = false))).view;
    expect(platform.diagnosis?.empty?.code).toBe("candidates-excluded");
    expect(platform.diagnosis?.excluded.map((x) => [x.toolId, x.codes])).toEqual([["kubernetes-mcp-server", ["platform-unsupported"]]]);
    // Client 미지원: Claude Code가 있는 프로젝트에서 Cursor만 지원하는 도구(다른 범용 추천은 있을 수 있어 제외 목록만 본다).
    const client = viewOf(k8sProfile({ aiClients: [claude] }), withK8s((m) => void (m.targets = ["cursor"]))).view;
    const k8sExcluded = client.diagnosis?.excluded.find((x) => x.toolId === "kubernetes-mcp-server");
    expect(k8sExcluded?.codes).toEqual(["client-unsupported"]);
    expect(k8sExcluded?.text).toBe(k8sExcluded!.name + " (" + k8sExcluded!.capabilities.join(", ") + "): " + en["forYou.exclusion.clientUnsupported"]);
    expect(client.items.some((i) => i.toolId === "kubernetes-mcp-server")).toBe(false);
    const backend = viewOf(k8sProfile(), entries, { platform: "linux", availableBackends: [] }).view;
    expect(backend.diagnosis?.empty?.code).toBe("candidates-excluded");
    expect(backend.diagnosis?.excluded.flatMap((x) => x.codes)).toContain("backend-unavailable");
    setDesktopLocale("ko");
    const ko1 = viewOf(k8sProfile(), withK8s((m) => void (m.platform.linux = false))).view;
    expect(ko1.diagnosis?.empty?.text).toBe(ko["forYou.empty.candidatesExcluded"]);
    expect(ko1.diagnosis?.excluded[0]?.text).toContain(ko["forYou.exclusion.platformUnsupported"]);
  });
});

describe("v0.2.0 C3 추천 진단: 추천이 있어도 보이는 정보", () => {
  it("규칙이 없는 기술(jest)과 스택 불일치(mongodb)·이미 설치된 도구(context7·playwright) 제외를 보이고, 추천 목록·점수는 그대로다", async () => {
    setDesktopLocale("en");
    const jest = viewOf(await fixtureProfile("jest-app"));
    expect(jest.view.diagnosis).toMatchObject({ empty: null, unmappedTechs: ["jest"] });
    const py = viewOf(await fixtureProfile("python-fastapi"));
    expect(py.view.diagnosis?.excluded.map((x) => [x.toolId, x.codes])).toEqual([["mongodb-mcp-server", ["stack-mismatch"]]]);
    const mcp = viewOf(await fixtureProfile("claude-mcp"));
    expect(mcp.view.diagnosis?.excluded.map((x) => [x.toolId, x.codes])).toEqual([["context7", ["installed"]], ["playwright-mcp", ["installed"]]]);
    for (const { view, report } of [jest, py, mcp]) {
      // 새 점수·후보를 만들지 않는다: 추천 목록·순서·점수는 report와 같고, 제외 목록은 report의 후보에서만 나온다.
      expect(view.items.map((i) => [i.toolId, i.projectFit, i.openScore])).toEqual(report.recommendations.map((r) => [r.toolId, r.projectFit.score === null ? "—" : r.projectFit.score.toFixed(2), r.openScore.score === null ? "—" : r.openScore.score.toFixed(2)]));
      const candidates = new Set(report.needs.flatMap((n) => n.candidates.map((c) => c.toolId)));
      for (const x of view.diagnosis!.excluded) {
        expect(candidates.has(x.toolId)).toBe(true);
        expect(view.items.some((i) => i.toolId === x.toolId)).toBe(false);
        for (const code of x.codes) expect(EXCLUSION_CODES).toContain(code);
      }
    }
  });

  it("검증 수준: Registry 등록과 실제 실행 검증을 구분해 보이고, 제외 사유로 쓰지 않는다", async () => {
    setDesktopLocale("en");
    const p = await fixtureProfile("k8s-deploy");
    const linux = viewOf(p).view;
    expect(linux.items.map((i) => i.toolId)).toEqual(["kubernetes-mcp-server"]);
    expect(linux.items[0]?.verification).toBe("Registry listed · OpenHub run check on Linux: Claude Code verified, Codex verified, Cursor not verified");
    const mac = viewOf(p, entries, { platform: "macos" }).view;
    expect(mac.items.map((i) => i.toolId)).toEqual(["kubernetes-mcp-server"]);
    expect(mac.items[0]?.verification).toBe("Registry listed · OpenHub run check on macOS: Claude Code not verified on this OS, Codex not verified on this OS, Cursor not verified on this OS");
    // 기록이 없는 도구는 "검증됨"으로 보이지 않는다.
    const react = viewOf(await fixtureProfile("react-pnpm")).view;
    for (const i of react.items) expect(i.verification).toBe("Registry listed · OpenHub has not recorded a per-client run check for this tool on Linux");
    expect(react.verificationNotice).toBe(en["forYou.verify.notice"]);
    for (const v of [linux, mac, react]) expect(v.items.every((i) => !HANGUL.test(i.verification ?? ""))).toBe(true);
  });

  it("카탈로그: 모든 Core EmptyReason·ExclusionCode에 영어·한국어 문장이 있고 영어 문장에는 한글이 없다", () => {
    const camel = (s: string) => s.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase());
    for (const r of EMPTY_REASONS) for (const cat of [en, ko] as Record<string, string>[]) expect(cat["forYou.empty." + camel(r)], r).toBeTruthy();
    for (const c of EXCLUSION_CODES) for (const cat of [en, ko] as Record<string, string>[]) expect(cat["forYou.exclusion." + camel(c)], c).toBeTruthy();
    for (const [k, v] of Object.entries(en)) if (k.startsWith("forYou.")) expect(v, k).not.toMatch(HANGUL);
  });
});

describe("v0.2.0 C3 IPC·화면", () => {
  function wired(project: string) {
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
    const session = new RecommendSession();
    registerProjectScan(session.observe(ipc), fixedDirectory(path.join(PROJECTS, project)));
    registerProjectRecommend(ipc, session, { registryDir: path.join(ROOT, "registry"), metadataFile: path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json"), platform: "linux" });
    return { scan: () => handlers.get(PROJECT_SCAN_CHANNEL)?.({}), recommend: (...args: unknown[]) => handlers.get(PROJECT_RECOMMEND_CHANNEL)?.({}, ...args) as Promise<RecommendResponse> };
  }

  it("메인 프로세스가 대화상자로 분석한 Profile로 진단을 만들고 renderer 인자는 무시한다", async () => {
    setDesktopLocale("en");
    const w = wired("unity-editor-only");
    await w.scan();
    const r = await w.recommend({ profile: { project: { name: "evil" } }, diagnosis: { empty: null } });
    expect(r.status === "ok" && r.view.diagnosis?.empty?.code).toBe("no-verified-tool");
  });

  it("renderer는 진단을 textContent로만 그리고 진단 영역이 화면에 있다", async () => {
    const js = await readFile(path.join(ROOT, "apps/desktop/renderer/for-you.js"), "utf8");
    expect(js).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/u);
    expect(js).toContain('document.getElementById("for-you-diagnosis")');
    expect(await readFile(path.join(ROOT, "apps/desktop/renderer/index.html"), "utf8")).toContain('<div id="for-you-diagnosis" class="for-you-diagnosis"></div>');
  });
});

