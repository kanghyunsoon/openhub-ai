import "./locale-ko";
import { ko } from "../src/i18n/ko";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  FLOATING_ARTIFACT_NOTICE,
  analyzeProject,
  buildInstallPlan,
  formatInstallPlanPreview,
  inspectConfigTarget,
  loadRegistry,
  planInstall,
  recommend,
  requiredEnvNotice,
  verifyInstallation,
  type BackendProbeReport,
  type ExecChild,
  type ExecSpawner,
} from "@openhub/core";
import { INSTALL_DISCARD_CHANNEL, INSTALL_OPTIONS_CHANNEL, INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, buildInstallPlanView, nativeDialogPrompter, registerInstall, smokeInstallDeps, type InstallPlanResponse, type InstallRunResponse, type NativeDialogLike } from "../src/install";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const REGISTRY = path.join(ROOT, "registry");
const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-install-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};
const NPX_TOOLS = ["memory-mcp", "context7", "playwright-mcp", "chrome-devtools-mcp"];

async function wired(options: { accept?: boolean; platform?: string } = {}) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0", "react": "^19.0.0" } }\n');
  await writeFile(path.join(project, ".mcp.json"), '{ "mcpServers": {} }\n');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
  const recommendSession = new RecommendSession();
  const installSession = new InstallSession();
  registerProjectScan(recommendSession.observe(ipc), installSession.trackPicker(fixedDirectory(project)));
  const deps = { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: options.platform ?? "linux" };
  registerProjectRecommend(ipc, recommendSession, deps);
  const dialogs: Parameters<NativeDialogLike["showMessageBox"]>[0][] = [];
  const spawns: string[][] = [];
  const spawner: ExecSpawner = (executable, args) => {
    spawns.push([executable, ...args]);
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", 0, null));
    return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
  };
  registerInstall(ipc, installSession, {
    ...deps,
    homeDir: home,
    recommend: recommendSession,
    dialog: { showMessageBox: async (o) => (dialogs.push(o), { response: options.accept === false ? 0 : 1 }) },
    probe: async () => PROBES,
    spawner,
    isolatedDir: async () => {
      const dir = await mkdtemp(path.join(base, "iso-"));
      return { path: dir, base, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  const recommended = async () => {
    const r = (await call(PROJECT_RECOMMEND_CHANNEL)) as { status: string; view?: { items: { toolId: string }[] } };
    return r.view?.items.map((i) => i.toolId) ?? [];
  };
  return {
    handlers,
    project,
    home,
    dialogs,
    spawns,
    scan: () => call(PROJECT_SCAN_CHANNEL),
    recommended,
    plan: (...args: unknown[]) => call(INSTALL_PLAN_CHANNEL, ...args) as Promise<InstallPlanResponse>,
    run: (...args: unknown[]) => call(INSTALL_RUN_CHANNEL, ...args) as Promise<InstallRunResponse>,
  };
}
const files = async (dir: string) => (await readdir(dir, { recursive: true })).map((f) => f.replace(/\\/gu, "/")).sort();

describe("REQ-034 Desktop 설치 흐름", () => {
  it("AC-036-01 IPC 인자는 현재 추천 목록의 toolId 하나뿐이고 경로·Plan을 보내도 무시한다", async () => {
    const w = await wired();
    expect(await w.plan("postgres-mcp")).toEqual({ status: "no-project" });
    await w.scan();
    expect(await w.recommended()).toContain("postgres-mcp");
    const ok = await w.plan("postgres-mcp", "C:/Windows/System32", { plan: { steps: [{ kind: "run", executable: "cmd" }] }, planDigest: "sha256:" + "0".repeat(64) });
    expect(ok.status).toBe("ok");
    if (ok.status === "ok") expect(ok.view.targets.map((t) => t.file)).toEqual([".mcp.json"]);
    for (const bad of ["no-such-tool", "../registry/x", 42, { toolId: "postgres-mcp" }]) expect((await w.plan(bad)).status, String(bad)).toBe("not-recommended");
    // v0.2.0 P0-3 PR C: Client 선택 화면 채널(install:options, toolId만)이 추가됐다. install:plan의 두 번째 인자는 clients 속성이 있는
    // 객체일 때만 Client 선택으로 쓰고(엄격 검증), 위처럼 경로·Plan을 보내면 여전히 무시한다.
    // install:discard(toolId만): Client 선택을 바꾸면 그 toolId의 Pending Plan을 버린다(쓰기·실행 0).
    expect([...w.handlers.keys()].filter((c) => c.startsWith("install:")).sort()).toEqual([INSTALL_DISCARD_CHANNEL, INSTALL_OPTIONS_CHANNEL, INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL].sort());
    const preload = await read("src/preload.ts");
    expect(preload).toContain('installOptions: (toolId: unknown) => ipcRenderer.invoke("install:options", String(toolId))');
    // v0.2.0 P0-3 C2: 범위 이름("project"·"user")만 함께 보낸다(경로 없음, main이 검증).
    expect(preload).toContain('return ipcRenderer.invoke("install:plan", String(toolId), clients === undefined ? undefined : scope === undefined ? { clients } : { clients, scope });');
    expect(preload).toContain(".clients.slice(0, 6).map(String)");
    expect(preload).toContain('runInstall: (toolId: unknown) => ipcRenderer.invoke("install:run", String(toolId))');
    expect(await read("renderer/install.js")).toContain('t("install.open")');
    expect(ko["install.open"]).toBe("설치 계획 보기");
  });

  it("AC-036-02 Plan Preview는 CLI와 같은 Core preview 문장이고 textContent로만 렌더링한다", async () => {
    const w = await wired();
    await w.scan();
    const response = await w.plan("postgres-mcp");
    if (response.status !== "ok") throw new Error(response.status);
    const env = {
      loadEntries: async () => (await loadRegistry(REGISTRY)).entries,
      analyze: async (root: string) => {
        const a = await analyzeProject(root);
        if (!a.ok) throw new Error("analysis");
        return a.profile;
      },
      probe: async () => PROBES,
      verify: verifyInstallation,
    };
    const core = await planInstall({ toolId: "postgres-mcp", projectRoot: w.project, homeDir: w.home, targets: [{ client: "claude-code", scope: "project" }], includeHost: false, platform: "linux" }, env);
    if (!core.result.ok) throw new Error(core.result.code);
    expect(response.view.previewLines).toEqual(formatInstallPlanPreview(core.result.planned));
    const js = await read("renderer/install.js");
    expect(js).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write|\brequire\(/u);
    expect(js).toContain('el("pre", "install-preview", view.previewLines.join("\\n"))');
    expect(js).toContain("node.textContent = text");
  });

  it("AC-036-03 추가 승인 항목마다 체크박스가 있고 모두 체크하기 전에는 확인 버튼이 비활성이다", async () => {
    const w = await wired();
    await w.scan();
    const response = await w.plan("postgres-mcp");
    if (response.status !== "ok") throw new Error(response.status);
    expect(response.view.requirements.map((r) => r.id)).toEqual(["base", "floating-artifact", "client-env-parse-risk"]);
    const js = await read("renderer/install.js");
    expect(js).toMatch(/for \(const r of view\.requirements\) \{[\s\S]*box\.type = "checkbox";/u);
    expect(js).toContain("confirm.disabled = true;");
    expect(js).toContain("confirm.disabled = !boxes.every((b) => b.checked);");
    expect(js).not.toMatch(/runInstall\([^)]*,/u);
  });

  it("AC-036-04 최종 Approval은 main의 네이티브 확인 대화상자에서만 만들어지고 취소하면 아무것도 바꾸지 않는다", async () => {
    const cancel = await wired({ accept: false });
    await cancel.scan();
    await cancel.plan("postgres-mcp");
    expect(await cancel.run("postgres-mcp", "sha256:" + "0".repeat(64), ["base"])).toEqual({ status: "rejected" });
    expect(cancel.dialogs).toHaveLength(1);
    expect(cancel.dialogs[0]).toMatchObject({ type: "warning", buttons: ["취소", "설치 승인"], defaultId: 0, cancelId: 0 });
    expect(cancel.dialogs[0]!.detail).toContain("[client-env-parse-risk]");
    expect(cancel.spawns).toEqual([]);
    expect(await readFile(path.join(cancel.project, ".mcp.json"), "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(await cancel.run("postgres-mcp")).toEqual({ status: "no-plan" });

    const accept = await wired();
    await accept.scan();
    expect(await accept.run("postgres-mcp")).toEqual({ status: "no-plan" });
    await accept.plan("postgres-mcp");
    const done = await accept.run("postgres-mcp");
    expect(done).toMatchObject({ status: "done", result: { status: "succeeded" } });
    expect(nativeDialogPrompter({ showMessageBox: async () => ({ response: 1 }) }).channel).toBe("desktop-native-dialog");
    for (const file of ["src/preload.ts", "renderer/install.js", "src/install.ts"]) expect(await read(file), file).not.toMatch(/install:approve|approveDigest|ipcRenderer\.invoke\("[^"]*approve/u);
  });

  it("AC-036-05 PLAN_STALE이면 재승인 화면으로 돌아간다", async () => {
    const w = await wired();
    await w.scan();
    await w.plan("postgres-mcp");
    await writeFile(path.join(w.project, ".mcp.json"), '{ "mcpServers": {}, "changed": true }\n');
    const response = await w.run("postgres-mcp");
    expect(response).toMatchObject({ status: "done", result: { status: "stale", reapprove: true } });
    if (response.status === "done") expect(response.result.changed).toContain("config-precondition");
    expect(w.spawns).toEqual([]);
    const js = await read("renderer/install.js");
    expect(js).toMatch(/if \(response\.result\.reapprove\) \{[\s\S]*await open\(toolId\)/u);
    expect((await w.plan("postgres-mcp")).status).toBe("ok");
  });

  it("AC-036-06 결과 화면에 Prepared / Configured / Detected를 단계별로 표시한다", async () => {
    const w = await wired();
    await w.scan();
    await w.plan("postgres-mcp");
    const response = await w.run("postgres-mcp");
    if (response.status !== "done") throw new Error(response.status);
    expect(response.result.stages).toEqual([
      { name: "Prepared", value: "launch-on-demand(Client 첫 실행 때 받음)" },
      { name: "Configured", value: "예" },
      { name: "Detected", value: "예" },
    ]);
    expect(response.result.nextActions.join("\n")).toContain("DATABASE_URI");
    const js = await read("renderer/install.js");
    expect(js).toContain('el("li", "stage", s.name + "  " + s.value)');
    // 화면에 나가는 문자열 리터럴에 확인 상태 이름 "Installed"·"설치 완료"가 없다(식별자 alreadyInstalled는 제외).
    for (const file of ["renderer/install.js", "src/install.ts"]) {
      const literals = [...(await read(file)).matchAll(/"([^"\n]*)"/gu)].map((m) => m[1]!);
      expect(literals.filter((s) => /Installed|설치 완료/u.test(s)), file).toEqual([]);
    }
    expect(JSON.stringify(response)).not.toMatch(/Installed|설치 완료/u);
  });

  it("AC-036-07 user scope 수정은 별도 경고 스타일로 구분한다", async () => {
    const w = await wired();
    const { entries } = await loadRegistry(REGISTRY);
    const a = await analyzeProject(w.project);
    if (!a.ok) throw new Error("analysis");
    const report = recommend(a.profile, entries, undefined, { platform: "linux" });
    const targets = [await inspectConfigTarget("claude-code", "project", "context7", { projectRoot: w.project, homeDir: w.home }), await inspectConfigTarget("cursor", "user", "context7", { projectRoot: w.project, homeDir: w.home })];
    const built = buildInstallPlan({ toolId: "context7", entries, report, probes: PROBES, targets, platform: "linux" });
    if (!built.ok) throw new Error(built.code);
    const view = buildInstallPlanView(built.planned);
    expect(view.userScope).toBe(true);
    expect(view.targets.map((t) => [t.file, t.userScope])).toEqual([
      [".mcp.json", false],
      ["~/.cursor/mcp.json", true],
    ]);
    expect(view.requirements.find((r) => r.id === "user-scope-config")?.userScope).toBe(true);
    const js = await read("renderer/install.js");
    expect(js).toContain('t.userScope ? "target warn-user-scope" : "target"');
    expect(js).toContain('r.userScope ? "requirement warn-user-scope" : "requirement"');
    expect(await read("renderer/styles.css")).toMatch(/\.warn-user-scope \{[^}]*var\(--warn\)/u);
  });

  it("AC-036-08 M3 AC-026-04 테스트를 M4 계약으로 갱신하고 이유를 기록했다", async () => {
    const forYouTest = await read("test/for-you.test.ts");
    expect(forYouTest).toContain("AC-036-08(M4)로 갱신");
    expect(forYouTest).toContain("AC-026-04 FOR YOU 모듈은 추천만 하고(recommendProject만 호출) 설치 버튼은 install.js만 붙인다");
    // 명세 기록 검사는 test/internal-truth.internal.test.ts로 옮겼다(TASK-074, public export 제외).
  });

  it("AC-036-09 fake executor smoke 의존성으로 화면과 같은 경로가 끝까지 통과하고 main은 --smoke일 때만 OPENHUB_SMOKE_INSTALL을 쓴다", async () => {
    const deps = smokeInstallDeps();
    const base = await mkdtemp(path.join(scratch, "smoke-"));
    const project = path.join(base, "project");
    await mkdir(project);
    await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
    await writeFile(path.join(project, ".mcp.json"), '{ "mcpServers": {} }\n');
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (c: string, fn: (...args: unknown[]) => unknown) => void handlers.set(c, fn) };
    const rs = new RecommendSession();
    const is = new InstallSession();
    registerProjectScan(rs.observe(ipc), is.trackPicker(fixedDirectory(project)));
    registerInstall(ipc, is, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux", homeDir: base, recommend: rs, dialog: deps.dialog, probe: deps.probe, spawner: deps.spawner });
    await handlers.get(PROJECT_SCAN_CHANNEL)?.({});
    expect(((await handlers.get(INSTALL_PLAN_CHANNEL)?.({}, "postgres-mcp")) as InstallPlanResponse).status).toBe("ok");
    expect(await handlers.get(INSTALL_RUN_CHANNEL)?.({}, "postgres-mcp")).toMatchObject({ status: "done", result: { status: "succeeded" } });
    expect(deps.dialogs).toBe(1);
    expect(deps.spawned).toEqual([]);
    expect(await files(project)).toEqual([".mcp.json", "package.json"]);
    const main = await read("src/main.ts");
    expect(main).toContain('const smokeInstall = smoke ? process.env["OPENHUB_SMOKE_INSTALL"] || undefined : undefined;');
    expect(main).toContain("cpSync(smokeProjectSource, copy, { recursive: true })");
    expect(main).toContain("dialog: smokeDeps?.dialog ?? { showMessageBox: (options) => dialog.showMessageBox(options) }");
  });

  it("AC-036-10 floating 고지문과 env 안내문을 표시하고 floating-artifact·client-env-parse-risk는 각각 별도 체크박스다", async () => {
    const w = await wired();
    await w.scan();
    const response = await w.plan("postgres-mcp");
    if (response.status !== "ok") throw new Error(response.status);
    const text = response.view.previewLines.join("\n");
    expect(text).toContain(FLOATING_ARTIFACT_NOTICE);
    expect(text).toContain(requiredEnvNotice("DATABASE_URI"));
    const ids = response.view.requirements.map((r) => r.id);
    expect(ids.filter((id) => id === "floating-artifact")).toHaveLength(1);
    expect(ids.filter((id) => id === "client-env-parse-risk")).toHaveLength(1);
  });

  it("AC-036-02 Windows에서는 Preview에 실제 기록될 cmd /d /c npx와 OpenHub 호환 정책 문구가 보이고 공식 권장이라고 쓰지 않는다", async () => {
    const w = await wired({ platform: "win32" });
    await w.scan();
    const toolId = (await w.recommended()).find((id) => NPX_TOOLS.includes(id));
    expect(toolId).toBeDefined();
    const response = await w.plan(toolId);
    if (response.status !== "ok") throw new Error(response.status);
    const text = response.view.previewLines.join("\n");
    expect(text).toMatch(/Client 실행 명령 {2}cmd \/d \/c npx /u);
    expect(text).toContain("Windows 호환 정책(OpenHub)");
    expect(text).not.toMatch(/공식 권장|officially recommended/u);
  });
});
