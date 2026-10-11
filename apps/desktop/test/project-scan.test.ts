import "./locale-ko";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject, serializeProfile } from "@openhub/core";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan, scanSelectedProject } from "../src/project-scan";

const FIXTURE = path.resolve(import.meta.dirname, "../../../packages/core/test/fixtures/projects/react-spring-monorepo");
const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");

function fakeIpc() {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return { handlers, handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
}

describe("REQ-010 Desktop Project Scan", () => {
  it("AC-015-01 폴더를 고르면 메인 프로세스가 Core analyzeProject 결과를 그대로 돌려준다", async () => {
    const ipc = fakeIpc();
    registerProjectScan(ipc, fixedDirectory(FIXTURE));
    const response = (await ipc.handlers.get(PROJECT_SCAN_CHANNEL)?.({})) as Awaited<ReturnType<typeof scanSelectedProject>>;
    expect(response.status).toBe("ok");
    if (response.status !== "ok") return;
    const core = await analyzeProject(FIXTURE);
    if (!core.ok) throw new Error();
    expect(serializeProfile(response.profile)).toBe(serializeProfile(core.profile));
    expect(response.profile.frameworks.map((f) => f.id)).toEqual(["nextjs", "react", "spring-boot"]);
    expect(await scanSelectedProject(async () => undefined)).toEqual({ status: "canceled" });
    expect(await scanSelectedProject(async () => path.join(FIXTURE, "missing"))).toMatchObject({ status: "error", code: "root-not-found" });
  });

  it("AC-015-02 화면이 보낸 인자는 무시되고 preload는 경로 인자를 전달하지 않는다", async () => {
    const ipc = fakeIpc();
    const picked: string[] = [];
    registerProjectScan(ipc, async () => {
      picked.push("dialog");
      return FIXTURE;
    });
    const response = (await ipc.handlers.get(PROJECT_SCAN_CHANNEL)?.({}, "C:/Windows/System32", { root: "/etc" })) as { status: string; profile?: { project: { name: string } } };
    expect(picked).toEqual(["dialog"]);
    expect(response.profile?.project.name).toBe("react-spring-monorepo");
    const preload = await read("src/preload.ts");
    expect(preload).toMatch(/scanProject: \(\) => ipcRenderer\.invoke\("project:select-and-scan"\)/u);
    // TASK-026(AC-026-07): FOR YOU 브리지(recommendBridge)가 추가됐다. 두 브리지 모두 인자를 받지 않는다.
    // TASK-036(M4): 설치 브리지(installBridge)가 추가됐다. 분석·추천 브리지는 여전히 인자가 없고,
    // 설치 브리지는 경로가 아니라 toolId 문자열 하나만 보낸다(main이 추천 목록에 있는지 다시 확인한다).
    // TASK-046(M5): Lifecycle 브리지(lifecycleBridge)가 추가됐다. 경로가 아니라 state entry id 문자열 하나만 보낸다
    // (main이 현재 프로젝트의 Version State 항목인지 다시 확인한다). 분석 브리지는 여전히 인자가 없다.
    expect(preload).toMatch(/exposeInMainWorld\("openhub", \{\s*listRegistry: \(\) => ipcRenderer\.invoke\("registry:list"\),\s*\.\.\.projectBridge,\s*\.\.\.recommendBridge,\s*\.\.\.installBridge,\s*\.\.\.lifecycleBridge,\s*\}\)/u);
    // v0.2.0 P0-3 PR C: 설치 브리지는 toolId 문자열과 Client 이름 문자열 목록만 보낸다(경로 없음).
    expect(preload).toMatch(/planInstall: \(toolId: unknown, selection\?: unknown\) => \{/u);
    expect(preload).toContain('ipcRenderer.invoke("install:plan", String(toolId), clients === undefined ? undefined : scope === undefined ? { clients } : { clients, scope })');
    expect(preload).toContain('runLifecycle: (id: unknown, version?: unknown) => ipcRenderer.invoke("lifecycle:run", String(id), typeof version === "string" ? { version } : undefined)');
  });

  it("AC-015-03 Desktop 코드에는 탐지 로직·Mock 데이터가 없고 Core 결과를 표시만 한다", async () => {
    const scanSource = await read("src/project-scan.ts");
    expect(scanSource).toContain('from "@openhub/core"');
    const renderer = await read("renderer/project.js");
    for (const source of [scanSource, renderer]) {
      expect(source).not.toMatch(/package\.json|pom\.xml|Cargo\.toml|dependencies|mcpServers|readFile|from "yaml"|smol-toml/u);
      expect(source).not.toMatch(/"(React|Spring Boot|PostgreSQL|TypeScript|Claude Code)"/u);
    }
    expect(renderer).toContain("window.openhub.scanProject()");
    expect(renderer).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML|\brequire\(/u);
  });

  it("AC-015-04 프로젝트 분석 코드는 REQ-010에 연결된 별도 모듈에 있다", async () => {
    // Requirement 추적 주석 검사는 test/internal-truth.internal.test.ts로 옮겼다(TASK-074, public export 제외).
    const renderer = await read("renderer/renderer.js");
    expect(renderer).not.toContain("scanProject");
  });

  it("AC-015-05 스모크 실행은 버튼과 같은 경로(window.__openhubScanProject)로 분석·렌더링한다", async () => {
    const main = await read("src/main.ts");
    expect(main).toContain('process.env["OPENHUB_SMOKE_PROJECT"]');
    expect(main).toContain("fixedDirectory(smokeProject)");
    expect(await read("src/project-scan.ts")).toContain('executeJavaScript("window.__openhubScanProject()")');
    expect(await read("renderer/project.js")).toContain("window.__openhubScanProject = scan");
  });

  it("AC-015-06 PROJECT 분석 코드에는 추천·Gap UI가 없고 Host Probe도 실행하지 않는다", async () => {
    const html = await read("renderer/index.html");
    for (const s of [await read("renderer/project.js"), await read("src/project-scan.ts")]) {
      expect(s).not.toMatch(/includeHost|recommend|\bgap\b|Project Fit|OpenScore/iu);
    }
    // 화면의 버튼은 [프로젝트 선택] 하나뿐이다. FOR YOU 추천은 M3 TASK-026의 별도 모듈(for-you.js)이 담당한다(AC-026-07).
    expect([...html.matchAll(/<button\b[^>]*id="([^"]+)"/gu)].map((m) => m[1])).toEqual(["project-select"]);
    expect(html).not.toContain("프로젝트 맞춤 추천은 M3(Recommendation)에서 연결됩니다.");
  });
});
