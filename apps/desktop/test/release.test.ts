import "./locale-ko";
import { ko } from "../src/i18n/ko";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { PINOKIO_APPROVAL_MESSAGES, type BackendProbeReport, type ExecChild, type ExecSpawner, type LifecycleEnvironment } from "@openhub/core";
import { setDesktopLocale } from "../src/i18n/index";
import { INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, registerInstall, type NativeDialogLike } from "../src/install";
import { LIFECYCLE_PLAN_CHANNELS, LIFECYCLE_RUN_CHANNEL, LIFECYCLE_STATUS_CHANNEL, LifecycleSession, registerLifecycle, type LifecyclePlanResponse } from "../src/lifecycle";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";
import { PINOKIO_INSPECT_CHANNEL, PINOKIO_PREVIEW_CHANNEL, RELEASE_CHECK_CHANNEL, registerRelease, smokeReleaseDeps, type PinokioInspectResponse, type PinokioPreviewResponse, type ReleaseCheckResponse } from "../src/release";
import { COMMIT, newHome, pinokioManifest, ptermLayout, realFs } from "../../../packages/core/test/pinokio/helpers";

/** TASK-057 Desktop Release·Impact·Pinokio Preview. Desktop 설치·업데이트로 만든 실제 설정·Version State 위에서 IPC를 호출한다. */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const REGISTRY = path.join(ROOT, "registry");
const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-release-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const ID = "project:claude-code:postgres";
const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};
const NOTES = "- BREAKING: removed --legacy <script>alert(1)</script>\n- Fixed pool leak";
const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });

async function wired() {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  await writeFile(path.join(project, ".mcp.json"), '{ "mcpServers": {} }\n');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
  const rs = new RecommendSession();
  const is = new InstallSession();
  registerProjectScan(rs.observe(ipc), is.trackPicker(fixedDirectory(project)));
  registerProjectRecommend(ipc, rs, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux" });
  const spawner: ExecSpawner = () => {
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", 0, null));
    return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
  };
  const dialog: NativeDialogLike = { showMessageBox: async () => ({ response: 1 }) };
  registerInstall(ipc, is, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux", homeDir: home, recommend: rs, dialog, probe: async () => PROBES, spawner });
  const fetches: { url: string; auth: boolean }[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    fetches.push({ url, auth: Object.keys((init?.headers ?? {}) as Record<string, string>).some((k) => k.toLowerCase() === "authorization") });
    if (url === "https://pypi.org/pypi/postgres-mcp/json") return json({ info: { name: "postgres-mcp", version: "0.3.0" }, releases: { "0.3.0": [{ upload_time_iso_8601: "2025-06-01T00:00:00Z" }], "0.4.0": [{ upload_time_iso_8601: "2025-08-01T00:00:00Z" }] } });
    if (url === "https://api.github.com/repos/crystaldba/postgres-mcp/releases?per_page=30&page=1") {
      return json([
        { tag_name: "v0.4.0", name: "v0.4.0", body: NOTES, draft: false, prerelease: false, published_at: "2025-08-01T00:00:00Z", html_url: "https://github.com/crystaldba/postgres-mcp/releases/tag/v0.4.0" },
        { tag_name: "v0.3.0", name: "v0.3.0", body: "- old", draft: false, prerelease: false, published_at: "2025-06-01T00:00:00Z", html_url: "https://github.com/crystaldba/postgres-mcp/releases/tag/v0.3.0" },
      ]);
    }
    if (url.startsWith("https://api.github.com/repos/someone/pinokio-app/contents/install.js")) return new Response("module.exports = { run: [{ method: \"shell.run\", params: { message: \"sudo rm -rf /opt/x\" } }] }", { status: 200 });
    return new Response("missing", { status: 404 });
  };
  const runHealth: NonNullable<LifecycleEnvironment["runHealth"]> = async () => ({ ok: true, result: { status: "healthy", reason: null, toolCount: 2, environmentUnverified: true, terminated: true, excerpt: null } });
  const session = new LifecycleSession(() => is.projectDir);
  registerLifecycle(ipc, session, { registryDir: REGISTRY, platform: "linux", homeDir: home, dialog, probe: async () => PROBES, fetch, runHealth, spawner, now: () => new Date("2026-10-07T10:00:00.000Z"), tempBase: base });
  registerRelease(ipc, new LifecycleSession(() => is.projectDir), { registryDir: REGISTRY, homeDir: home, fetch, probe: async () => PROBES, now: () => new Date("2026-10-07T10:00:00.000Z") });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  await call(PROJECT_SCAN_CHANNEL);
  await call(PROJECT_RECOMMEND_CHANNEL);
  await call(INSTALL_PLAN_CHANNEL, "postgres-mcp");
  expect(await call(INSTALL_RUN_CHANNEL, "postgres-mcp")).toMatchObject({ status: "done", result: { status: "succeeded" } });
  // 0.3.0으로 고정(업데이트)해 둔다.
  expect(((await call(LIFECYCLE_PLAN_CHANNELS.update, ID)) as LifecyclePlanResponse).status).toBe("ok");
  expect(await call(LIFECYCLE_RUN_CHANNEL, ID)).toMatchObject({ status: "done", result: { status: "updated" } });
  fetches.length = 0;
  return { base, home, project, handlers, fetches, call, check: (...a: unknown[]) => call(RELEASE_CHECK_CHANNEL, ...a) as Promise<ReleaseCheckResponse> };
}

describe("REQ-045 REQ-041 REQ-042 REQ-032 Desktop Release·Impact·Pinokio", () => {
  it("AC-057-01 release title·notes·요약은 textContent로만 렌더링되고 <script>·HTML 문자열이 그대로 보인다(innerHTML 0)", async () => {
    const w = await wired();
    const r = await w.check(ID);
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.notes?.lines).toContain("- BREAKING: removed --legacy <script>alert(1)</script>");
    expect(r.view.summary.find((s) => s.label === "Breaking")?.items[0]).toContain("<script>alert(1)</script>");
    const js = await read("renderer/release.js");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u);
    expect(js).toContain("node.textContent = text");
  }, 30_000);

  it("AC-057-02 renderer·main에 timer·polling이 0개다", async () => {
    for (const file of ["renderer/release.js", "src/release.ts", "src/main.ts"]) expect(await read(file), file).not.toMatch(/setInterval|setTimeout|requestIdleCallback|\.poll\(/u);
  });

  it("AC-057-03 release 확인은 버튼 클릭 때만 network를 쓰고 기본 요청에 Authorization이 없으며 token 탐색·gh 실행이 0회다", async () => {
    const w = await wired();
    await w.call(LIFECYCLE_STATUS_CHANNEL);
    await w.call(LIFECYCLE_STATUS_CHANNEL);
    expect(w.fetches).toEqual([]);
    expect((await w.check(ID)).status).toBe("ok");
    expect(w.fetches.map((f) => f.url)).toEqual(["https://pypi.org/pypi/postgres-mcp/json", "https://api.github.com/repos/crystaldba/postgres-mcp/releases?per_page=30&page=1"]);
    expect(w.fetches.every((f) => !f.auth)).toBe(true);
    const code = (await read("src/release.ts")).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    expect(code).not.toMatch(/resolveGitHubToken|GITHUB_TOKEN|GH_TOKEN|githubToken|"gh"|child_process/u);
    const js = await read("renderer/release.js");
    expect([...js.matchAll(/window\.openhubRelease\.checkRelease\(/gu)]).toHaveLength(1);
    expect(js).toContain('button("release-check", t("release.check"), () => void check(li))');
    expect(ko["release.check"]).toBe("릴리스 확인");
    const preload = await read("src/preload.ts");
    expect(preload).toContain('checkRelease: (id: unknown) => ipcRenderer.invoke("release:check", String(id))');
    expect(preload).toContain('contextBridge.exposeInMainWorld("openhubRelease", releaseBridge);');
    for (const bad of ["../x", "user:cursor:postgres", 42, w.project]) expect((await w.check(bad)).status).toBe("not-managed");
  }, 30_000);

  it("AC-057-04 Impact 등급과 reasons를 표시한다", async () => {
    const w = await wired();
    const r = await w.check(ID);
    if (r.status !== "ok") throw new Error(r.status);
    expect([r.view.current, r.view.latest, r.view.updateAvailable]).toEqual(["0.3.0", "0.4.0 (2025-08-01)", true]);
    // postgres-mcp는 Python 최소 버전을 선언하지만 probe는 Python 버전을 모르므로 runtime-unverified(unknown)가 함께 붙는다.
    expect(r.view.impact).toEqual({ verdict: "HIGH", status: "WARNING", reasons: ["version-minor-zero (high)", "notes-breaking (high)", "runtime-unverified (unknown)"] });
    const js = await read("renderer/release.js");
    expect(js).toContain('t("release.impact", { verdict: view.impact.verdict, status: view.impact.status })');
    expect(ko["release.impact"]).toBe("Impact: {verdict} ({status})");
    expect(js).toContain("for (const reason of view.impact.reasons)");
  }, 30_000);

  it("AC-057-05 [업데이트 계획]이 M5 Lifecycle update 계획 화면으로 이어진다", async () => {
    const w = await wired();
    expect((await w.check(ID)).status).toBe("ok");
    const js = await read("renderer/release.js");
    expect(js).toContain('const plan = li.querySelector(".lifecycle-update");');
    expect(js).toContain('button("release-plan", t("release.plan"), () => plan.click())');
    expect(ko["release.plan"]).toBe("업데이트 계획");
    // 같은 항목 id로 M5 update 계획이 만들어진다(계획·승인은 기존 Lifecycle 경로).
    expect(((await w.call(LIFECYCLE_PLAN_CHANNELS.update, ID)) as LifecyclePlanResponse).status).toBe("ok");
  }, 30_000);

  it("AC-057-06 Pinokio Plan Preview와 제3자 script Preview(실행 버튼 0개)를 보여준다", async () => {
    const repo = path.join(scratch, "repo-06");
    await cp(REGISTRY, path.join(repo, "registry"), { recursive: true });
    await writeFile(path.join(repo, "registry", "mcp", "local-llm-ui.yaml"), JSON.stringify(pinokioManifest(), null, 2));
    const layout = await ptermLayout();
    const pinokioHome = await newHome();
    const fetch = async (url: string) =>
      url === "http://127.0.0.1:42000/pinokio/version" ? json({ pinokiod: "4.0.3", script: "4.0" }) : url === "http://127.0.0.1:42000/pinokio/home" ? json({ path: pinokioHome }) : url.includes("/contents/install.js") ? new Response("module.exports = { run: [{ method: \"shell.run\", params: { message: \"sudo apt x\" } }] }") : new Response("missing", { status: 404 });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const home = path.join(scratch, "home-06");
    await mkdir(home, { recursive: true });
    registerRelease({ handle: (c, fn) => void handlers.set(c, fn) }, new LifecycleSession(() => undefined), { registryDir: path.join(repo, "registry"), homeDir: home, fetch, pinokioProbe: { pathEnv: layout.pathEnv, platform: process.platform, fs: realFs() } });
    const preview = (await handlers.get(PINOKIO_PREVIEW_CHANNEL)?.({}, "local-llm-ui")) as PinokioPreviewResponse;
    if (preview.status !== "ok") throw new Error(preview.code);
    expect(preview.lines.join("\n")).toMatch(/openhub-install\.js[\s\S]*git clone --no-checkout https:\/\/github\.com\/acme\/local-llm-ui app[\s\S]*설치는 CLI에서 승인합니다/u);
    const inspect = (await handlers.get(PINOKIO_INSPECT_CHANNEL)?.({}, "someone/pinokio-app@" + COMMIT, "install.js")) as PinokioInspectResponse;
    expect(inspect).toMatchObject({ status: "ok", preview: { warnings: ["L1 sudo", "L1 shell"] } });
    expect([...handlers.keys()].filter((c) => c.startsWith("pinokio:")).sort()).toEqual([PINOKIO_INSPECT_CHANNEL, PINOKIO_PREVIEW_CHANNEL].sort());
    // PINOKIO 카드의 버튼은 release.js가 만드는 미리보기 두 개뿐이다(실행 버튼 0개).
    const js = await read("renderer/release.js");
    const pinokioPart = js.slice(js.indexOf("PINOKIO 카드 입력·버튼은"), js.indexOf("async function preview"));
    expect([...pinokioPart.matchAll(/button\("([^"]+)", t\("([^"]+)"\)/gu)].map((m) => [m[1], ko[m[2] as keyof typeof ko]])).toEqual([["pinokio-preview", "Pinokio 계획 미리보기"], ["pinokio-inspect", "제3자 script 미리보기"]]);
    expect([...js.matchAll(/window\.openhubRelease\.(\w+)/gu)].map((m) => m[1]).sort()).toEqual(["checkRelease", "inspectPinokio", "previewPinokio"]);
    for (const f of ["renderer/release.js", "src/release.ts", "src/preload.ts"]) expect(await read(f), f).not.toMatch(/runPinokio|pinokio:run|executeWithPinokioApproval|executePinokioPlan/u);
  }, 30_000);

  it("AC-057-07 fake 출처 smoke(--smoke + 전용 env일 때만)가 통과한다", async () => {
    const w = await wired();
    const smoke = smokeReleaseDeps();
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const fixedSession = { projectDir: () => w.project } as unknown as LifecycleSession;
    registerRelease({ handle: (c, fn) => void handlers.set(c, fn) }, fixedSession, { registryDir: REGISTRY, homeDir: w.home, fetch: smoke.fetch, probe: async () => PROBES });
    const r = (await handlers.get(RELEASE_CHECK_CHANNEL)?.({}, ID)) as ReleaseCheckResponse;
    expect(r).toMatchObject({ status: "ok", view: { impact: { verdict: expect.any(String) } } });
    expect(smoke.authorized).toBe(0);
    expect(smoke.fetched.length).toBeGreaterThan(0);
    const main = await read("src/main.ts");
    expect(main).toContain('const smokeReleaseTool = smokeUpdate === undefined ? undefined : process.env["OPENHUB_SMOKE_RELEASE"] || undefined;');
    expect(main).toContain("...(smokeRelease === undefined || smokeDeps === undefined ? {} : { fetch: smokeRelease.fetch, probe: smokeDeps.probe })");
    expect(await read("renderer/release.js")).toContain("window.__openhubRelease = async (toolId) => {");
  }, 30_000);

  it("AC-057-08 기존 FOR YOU·설치·Lifecycle 흐름이 그대로이고 새 화면은 기존 브리지·화면을 바꾸지 않는다", async () => {
    const preload = await read("src/preload.ts");
    for (const s of ["...projectBridge,", "...recommendBridge,", "...installBridge,", "...lifecycleBridge,", 'runLifecycle: (id: unknown) => ipcRenderer.invoke("lifecycle:run", String(id))']) expect(preload).toContain(s);
    const html = await read("renderer/index.html");
    for (const s of ['<script src="for-you.js"></script>', '<script src="install.js"></script>', '<script src="lifecycle.js"></script>', 'id="lifecycle-list"', 'id="for-you-list"']) expect(html).toContain(s);
    expect(html.indexOf('<script src="lifecycle.js"></script>')).toBeLessThan(html.indexOf('<script src="release.js"></script>'));
    expect(await read("renderer/lifecycle.js")).toContain("window.__openhubLifecycle = async (toolId) => {");
  });

  it("v0.2.0 Pinokio Preview 보안 고지·승인 요구가 English에서는 영어, 한국어에서는 Core 문장이다(정보 누락 없음)", async () => {
    const repo = path.join(scratch, "repo-pinokio-en");
    await cp(REGISTRY, path.join(repo, "registry"), { recursive: true });
    await writeFile(path.join(repo, "registry", "mcp", "local-llm-ui.yaml"), JSON.stringify(pinokioManifest(), null, 2));
    const layout = await ptermLayout();
    const pinokioHome = await newHome();
    const fetch = async (url: string) => (url === "http://127.0.0.1:42000/pinokio/version" ? json({ pinokiod: "4.0.3", script: "4.0" }) : url === "http://127.0.0.1:42000/pinokio/home" ? json({ path: pinokioHome }) : new Response("missing", { status: 404 }));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const home = path.join(scratch, "home-pinokio-en");
    await mkdir(home, { recursive: true });
    registerRelease({ handle: (c, fn) => void handlers.set(c, fn) }, new LifecycleSession(() => undefined), { registryDir: path.join(repo, "registry"), homeDir: home, fetch, pinokioProbe: { pathEnv: layout.pathEnv, platform: process.platform, fs: realFs() } });
    const preview = async () => {
      const p = (await handlers.get(PINOKIO_PREVIEW_CHANNEL)?.({}, "local-llm-ui")) as PinokioPreviewResponse;
      if (p.status !== "ok") throw new Error(p.code);
      return p.lines;
    };
    try {
      setDesktopLocale("en");
      const enLines = await preview();
      const notices = enLines.filter((l) => /^\[(delegated-shell|health-required)\] /u.test(l));
      expect(notices).toHaveLength(2);
      expect(notices[0]).toBe("[delegated-shell] Pinokio (pinokiod), not OpenHub, runs the shell.run commands in the generated scripts through a shell. OpenHub pins the full script content and compares it again right before running.");
      expect(notices[1]).toMatch(/^\[health-required\] After running, OpenHub checks Health at http:\/\/127\.0\.0\.1:/u);
      const approvals = enLines.filter((l) => l.startsWith("  - ["));
      expect(approvals.map((l) => l.slice(5, l.indexOf("]")))).toEqual(["base", "pinokio-delegated-shell", "health-execution"]);
      for (const l of [...notices, ...approvals]) expect(l).not.toMatch(/[\uac00-\ud7a3]/u);
      setDesktopLocale("ko");
      const koLines = await preview();
      expect(koLines.filter((l) => l.startsWith("[delegated-shell] "))[0]).toContain("Pinokio(pinokiod)가 셸로 실행합니다");
      expect(koLines.filter((l) => l.startsWith("  - [")).map((l) => l.slice(l.indexOf("]") + 2))).toEqual([PINOKIO_APPROVAL_MESSAGES.base, PINOKIO_APPROVAL_MESSAGES["pinokio-delegated-shell"], PINOKIO_APPROVAL_MESSAGES["health-execution"]]);
      // 영어와 한국어 줄 수가 같다(고지·승인 요구가 언어 때문에 빠지지 않는다).
      expect(koLines.length).toBe(enLines.length);
    } finally {
      setDesktopLocale("ko");
    }
  }, 30_000);
});
