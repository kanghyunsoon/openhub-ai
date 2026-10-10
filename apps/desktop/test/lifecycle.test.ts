import "./locale-ko";
import { ko } from "../src/i18n/ko";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { formatLifecyclePlanPreview, loadRegistry, planLifecycleRequest, probeBackends, type BackendProbeReport, type ExecChild, type ExecSpawner, type LifecycleEnvironment } from "@openhub/core";
import { INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, registerInstall, smokeInstallDeps, type InstallRunResponse, type NativeDialogLike } from "../src/install";
import {
  LIFECYCLE_CHECK_CHANNEL,
  LIFECYCLE_PLAN_CHANNELS,
  LIFECYCLE_RUN_CHANNEL,
  LIFECYCLE_STATUS_CHANNEL,
  LifecycleSession,
  nativeLifecycleDialogPrompter,
  registerLifecycle,
  smokeLifecycleDeps,
  type LifecycleCheckResponse,
  type LifecyclePlanResponse,
  type LifecycleRunResponse,
  type LifecycleStatusResponse,
} from "../src/lifecycle";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";

/** TASK-046 Desktop Lifecycle. Desktop 설치 흐름으로 만든 실제 설정·Version State 위에서 IPC를 호출한다. */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const REGISTRY = path.join(ROOT, "registry");
const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-lifecycle-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
void probeBackends;

const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};
const ID = "project:claude-code:postgres";

async function wired(options: { accept?: boolean } = {}) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  await writeFile(path.join(project, ".mcp.json"), '{ "mcpServers": {} }\n');
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
  const recommendSession = new RecommendSession();
  const installSession = new InstallSession();
  registerProjectScan(recommendSession.observe(ipc), installSession.trackPicker(fixedDirectory(project)));
  registerProjectRecommend(ipc, recommendSession, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux" });
  const spawns: string[][] = [];
  const spawner: ExecSpawner = (executable, args) => {
    spawns.push([executable, ...args]);
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", 0, null));
    return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
  };
  const dialogs: Parameters<NativeDialogLike["showMessageBox"]>[0][] = [];
  const dialog: NativeDialogLike = { showMessageBox: async (o) => (dialogs.push(o), { response: options.accept === false && o.title !== "OpenHub 설치 승인" ? 0 : 1 }) };
  registerInstall(ipc, installSession, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux", homeDir: home, recommend: recommendSession, dialog, probe: async () => PROBES, spawner });
  const fetches: string[] = [];
  const healthRuns: string[] = [];
  const fetch = async (url: string) => {
    fetches.push(url);
    if (url === "https://pypi.org/pypi/postgres-mcp/json") return new Response(JSON.stringify({ info: { name: "postgres-mcp", version: "0.3.0" } }), { status: 200 });
    return new Response("missing", { status: 404 });
  };
  const runHealth: NonNullable<LifecycleEnvironment["runHealth"]> = async (verified) => {
    healthRuns.push(verified.plan.operation);
    return { ok: true, result: { status: "healthy", reason: null, toolCount: 2, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null } };
  };
  const deps = { registryDir: REGISTRY, platform: "linux", homeDir: home, dialog, probe: async () => PROBES, fetch, runHealth, spawner, now: () => new Date("2026-10-07T10:00:00.000Z"), tempBase: base };
  registerLifecycle(ipc, new LifecycleSession(() => installSession.projectDir), deps);
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)?.({}, ...args);
  const w = {
    base,
    project,
    home,
    handlers,
    dialogs,
    spawns,
    fetches,
    healthRuns,
    deps,
    scan: () => call(PROJECT_SCAN_CHANNEL),
    install: async (toolId = "postgres-mcp") => {
      await call(PROJECT_RECOMMEND_CHANNEL);
      await call(INSTALL_PLAN_CHANNEL, toolId);
      return (await call(INSTALL_RUN_CHANNEL, toolId)) as InstallRunResponse;
    },
    status: (...args: unknown[]) => call(LIFECYCLE_STATUS_CHANNEL, ...args) as Promise<LifecycleStatusResponse>,
    check: (...args: unknown[]) => call(LIFECYCLE_CHECK_CHANNEL, ...args) as Promise<LifecycleCheckResponse>,
    plan: (op: keyof typeof LIFECYCLE_PLAN_CHANNELS, ...args: unknown[]) => call(LIFECYCLE_PLAN_CHANNELS[op], ...args) as Promise<LifecyclePlanResponse>,
    run: (...args: unknown[]) => call(LIFECYCLE_RUN_CHANNEL, ...args) as Promise<LifecycleRunResponse>,
  };
  return w;
}
async function installed(options: { accept?: boolean } = {}) {
  const w = await wired(options);
  await w.scan();
  expect(await w.install()).toMatchObject({ status: "done", result: { status: "succeeded" } });
  w.dialogs.length = 0;
  w.fetches.length = 0;
  return w;
}
const items = async (w: Awaited<ReturnType<typeof wired>>) => {
  const s = await w.status();
  if (s.status !== "ok") throw new Error(s.status);
  return s.items;
};
const stateFile = (w: { home: string }) => path.join(w.home, ".openhub", "state", "lifecycle.json");

describe("REQ-040 REQ-043 REQ-044 REQ-050 Desktop Lifecycle", () => {
  it("AC-046-01 Lifecycle IPC 인자는 state entry id 하나뿐이고 경로·Plan·digest를 보내도 무시한다", async () => {
    const w = await installed();
    expect((await items(w)).map((i) => i.id)).toEqual([ID]);
    const ok = await w.plan("update", ID, "C:/Windows/System32", { plan: { steps: [{ kind: "run", executable: "cmd" }] } }, "sha256:" + "0".repeat(64));
    expect(ok.status).toBe("ok");
    for (const bad of ["../.mcp.json", "project:claude-code:memory", "user:cursor:postgres", 42, { id: ID }, w.project]) {
      for (const op of ["update", "rollback", "health"] as const) expect((await w.plan(op, bad)).status, op + " " + String(bad)).toBe("not-managed");
      expect((await w.check(bad)).status).toBe("not-managed");
      expect((await w.run(bad)).status).toBe("no-plan");
    }
    expect([...w.handlers.keys()].filter((c) => c.startsWith("lifecycle:")).sort()).toEqual(
      [LIFECYCLE_STATUS_CHANNEL, LIFECYCLE_CHECK_CHANNEL, ...Object.values(LIFECYCLE_PLAN_CHANNELS), LIFECYCLE_RUN_CHANNEL].sort(),
    );
    const preload = await read("src/preload.ts");
    expect(preload).toContain('lifecycleStatus: () => ipcRenderer.invoke("lifecycle:status")');
    for (const ch of ["lifecycle:check", "lifecycle:plan-update", "lifecycle:plan-rollback", "lifecycle:plan-health", "lifecycle:run"]) {
      expect(preload).toMatch(new RegExp("\\(id: unknown\\) => ipcRenderer\\.invoke\\(\"" + ch + "\", String\\(id\\)\\)", "u"));
    }
  }, 30_000);

  it("AC-046-02 renderer·main에 timer·polling이 0개이고 update 확인은 버튼 클릭 때만 resolver를 호출한다", async () => {
    for (const file of ["renderer/lifecycle.js", "src/lifecycle.ts", "src/main.ts"]) expect(await read(file), file).not.toMatch(/setInterval|setTimeout|requestIdleCallback|\.poll\(/u);
    const w = await installed();
    await w.status();
    await w.status();
    expect(w.fetches).toEqual([]);
    const check = await w.check(ID);
    expect(check).toMatchObject({ status: "ok", view: { result: "update-available", from: "postgres-mcp", to: "postgres-mcp==0.3.0" } });
    expect(w.fetches).toEqual(["https://pypi.org/pypi/postgres-mcp/json"]);
    expect(w.spawns).toEqual([]);
    const js = await read("renderer/lifecycle.js");
    expect(js).toContain('button("lifecycle-check", t("lifecycle.check"), () => void check(item.id, li))');
    expect(ko["lifecycle.check"]).toBe("업데이트 확인");
    expect([...js.matchAll(/window\.openhub\.checkLifecycle\(/gu)]).toHaveLength(1);
  });

  it("AC-046-03 Preview는 Core 문장을 textContent로만 렌더링하고 승인 항목마다 체크박스가 있으며 모두 체크하기 전 확인 버튼이 비활성이다", async () => {
    const w = await installed();
    const response = await w.plan("update", ID);
    if (response.status !== "ok") throw new Error(response.status);
    const { entries } = await loadRegistry(REGISTRY);
    const core = await planLifecycleRequest(
      { operation: "update", toolId: "postgres-mcp", projectRoot: w.project, homeDir: w.home, platform: "linux", includeUser: false, targets: [{ client: "claude-code", scope: "project" }] },
      { loadEntries: async () => entries, probe: async () => PROBES, tempBase: w.base, now: () => new Date(), fetch: w.deps.fetch },
    );
    if (!core.ok) throw new Error(core.code);
    expect(response.view.previewLines).toEqual(formatLifecyclePlanPreview(core.planned));
    expect(response.view.requirements.map((r) => r.id)).toEqual(["base", "health-execution", "environment-unverified"]);
    const js = await read("renderer/lifecycle.js");
    expect(js).not.toMatch(/\brequire\(|\.(inner|outer)HTML\s*=|insertAdjacentHTML/u);
    expect(js).toContain('el("pre", "install-preview", view.previewLines.join("\\n"))');
    expect(js).toMatch(/for \(const r of view\.requirements\) \{[\s\S]*box\.type = "checkbox";/u);
    expect(js).toContain("confirm.disabled = true;");
    expect(js).toContain("confirm.disabled = !boxes.every((b) => b.checked);");
  });

  it("AC-046-04 최종 Approval은 main 프로세스 네이티브 확인 대화상자에서만 만들어진다", async () => {
    const cancel = await installed({ accept: false });
    const before = await readFile(path.join(cancel.project, ".mcp.json"));
    const state = await readFile(stateFile(cancel));
    await cancel.plan("update", ID);
    expect(await cancel.run(ID, "sha256:" + "0".repeat(64), ["base"])).toEqual({ status: "rejected" });
    expect(cancel.dialogs).toHaveLength(1);
    expect(cancel.dialogs[0]).toMatchObject({ type: "warning", title: "OpenHub 업데이트 승인", buttons: ["취소", "승인"], defaultId: 0, cancelId: 0 });
    expect(cancel.dialogs[0]!.detail).toContain("[health-execution]");
    expect((await readFile(path.join(cancel.project, ".mcp.json"))).equals(before)).toBe(true);
    expect((await readFile(stateFile(cancel))).equals(state)).toBe(true);
    expect(cancel.healthRuns).toEqual([]);
    expect(await cancel.run(ID)).toEqual({ status: "no-plan" });
    expect(nativeLifecycleDialogPrompter({ showMessageBox: async () => ({ response: 1 }) }).channel).toBe("desktop-native-dialog");
    for (const file of ["src/preload.ts", "renderer/lifecycle.js", "src/lifecycle.ts"]) expect(await read(file), file).not.toMatch(/lifecycle:approve|approveDigest|ipcRenderer\.invoke\("[^"]*approve/u);
    const accept = await installed();
    await accept.plan("update", ID);
    expect(await accept.run(ID)).toMatchObject({ status: "done", result: { status: "updated" } });
    expect(accept.dialogs).toHaveLength(1);
  });

  it("AC-046-05 진행 단계와 Health 결과를 표시하고 skip된 Health는 Not verified로 표시한다", async () => {
    const w = await installed();
    await w.plan("update", ID);
    const done = await w.run(ID);
    if (done.status !== "done") throw new Error(done.status);
    expect(done.result.lines[0]).toBe("결과  updated");
    expect(done.result.health).toEqual(["Health: Healthy (2026-10-07T10:00:00.000Z)", "Note: Required environment is unchecked"]);
    expect(w.healthRuns).toEqual(["update"]);
    const js = await read("renderer/lifecycle.js");
    expect(js).toContain('status.textContent = t("lifecycle.progress");');
    expect(ko["lifecycle.progress"]).toBe("진행: 승인 확인 → 계획 재확인 → 준비 → 설정 교체 → Health → Version State 기록");
    const doc = JSON.parse(await readFile(stateFile(w), "utf8"));
    for (const e of Object.values(doc.entries) as Record<string, unknown>[]) e["lastHealth"] = { status: "skipped", environmentUnverified: true, checkedAt: null };
    await writeFile(stateFile(w), JSON.stringify(doc, null, 2) + "\n");
    const lines = (await items(w))[0]!.lines;
    expect(lines).toContain("  Health: Not verified");
    expect(lines).toContain("  Reason: Required environment is unchecked");
    expect(lines.join("\n")).not.toContain("Healthy");
  });

  it("AC-046-06 rollback 버튼은 previous snapshot이 있을 때만 보이고 별도 승인을 받는다", async () => {
    const w = await installed();
    expect((await items(w))[0]).toMatchObject({ canUpdate: true, canHealth: true, canRollback: false });
    expect((await w.plan("rollback", ID)).status).toBe("not-managed");
    await w.plan("update", ID);
    expect((await w.run(ID)).status).toBe("done");
    expect((await items(w))[0]).toMatchObject({ canRollback: true });
    const plan = await w.plan("rollback", ID);
    if (plan.status !== "ok") throw new Error(plan.status);
    expect(plan.view.requirements.map((r) => r.id)).toContain("rollback-to-previous");
    w.dialogs.length = 0;
    expect(await w.run(ID)).toMatchObject({ status: "done", result: { status: "rolled-back" } });
    expect(w.dialogs.map((d) => d.title)).toEqual(["OpenHub 롤백 승인"]);
    expect(await read("renderer/lifecycle.js")).toContain('if (item.canRollback) actions.append(button("lifecycle-rollback", t("lifecycle.rollback")');
    expect(ko["lifecycle.rollback"]).toBe("이전 버전으로 롤백");
  });

  it("AC-046-07 config-drift·untracked-foreign·state 손상은 경고만 표시하고 update·rollback 실행 버튼이 0개다", async () => {
    const w = await installed();
    const file = path.join(w.project, ".mcp.json");
    await writeFile(file, (await readFile(file, "utf8")).replace("--access-mode=restricted", "--access-mode=unrestricted"));
    await mkdir(path.join(w.project, ".cursor"));
    await writeFile(path.join(w.project, ".cursor", "mcp.json"), '{ "mcpServers": { "memory": { "command": "node", "args": ["mine.js"] } } }\n');
    const list = await items(w);
    expect(list.map((i) => [i.id, i.state, i.canUpdate, i.canRollback, i.canHealth, i.warning !== null])).toEqual([
      ["project:cursor:memory", "untracked-foreign", false, false, false, true],
      [ID, "config-drift", false, false, false, true],
    ]);
    for (const op of ["update", "rollback", "health"] as const) expect((await w.plan(op, ID)).status).toBe("not-managed");
    await writeFile(stateFile(w), "{ broken");
    const broken = await w.status();
    expect(broken).toEqual({
      status: "state-unreadable",
      code: "STATE_CORRUPT",
      message: "Version State(~/.openhub/state/lifecycle.json)를 읽을 수 없습니다 (STATE_CORRUPT). OpenHub는 이 파일을 자동으로 고치거나 덮어쓰지 않습니다. 파일과 백업(lifecycle.json.bak)을 확인하세요.",
    });
    expect((await w.plan("update", ID)).status).toBe("not-managed");
    expect(await readFile(stateFile(w), "utf8")).toBe("{ broken");
    const js = await read("renderer/lifecycle.js");
    expect(js).toMatch(/if \(response\.status !== "ok"\) \{[\s\S]*list\.replaceChildren\(\);/u);
    expect(js).toContain("if (item.canUpdate) {");
  });

  it("AC-046-08 fake resolver·Health·executor smoke가 통과하고 main은 --smoke + OPENHUB_SMOKE_UPDATE일 때만 쓴다", async () => {
    const install = smokeInstallDeps();
    const life = smokeLifecycleDeps();
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
    registerProjectRecommend(ipc, rs, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux" });
    registerInstall(ipc, is, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux", homeDir: base, recommend: rs, dialog: install.dialog, probe: install.probe, spawner: install.spawner });
    registerLifecycle(ipc, new LifecycleSession(() => is.projectDir), { registryDir: REGISTRY, platform: "linux", homeDir: base, dialog: life.dialog, fetch: life.fetch, runHealth: life.runHealth, spawner: life.spawner, probe: install.probe, tempBase: base });
    await handlers.get(PROJECT_SCAN_CHANNEL)?.({});
    await handlers.get(PROJECT_RECOMMEND_CHANNEL)?.({});
    await handlers.get(INSTALL_PLAN_CHANNEL)?.({}, "postgres-mcp");
    expect(await handlers.get(INSTALL_RUN_CHANNEL)?.({}, "postgres-mcp")).toMatchObject({ status: "done", result: { status: "succeeded" } });
    expect(((await handlers.get(LIFECYCLE_PLAN_CHANNELS.update)?.({}, ID)) as LifecyclePlanResponse).status).toBe("ok");
    expect(await handlers.get(LIFECYCLE_RUN_CHANNEL)?.({}, ID)).toMatchObject({ status: "done", result: { status: "updated" } });
    // resolver는 Plan 생성 1회 + 실행 직전 재생성 1회(D-018)만 호출된다.
    expect([life.fetched, life.healthRuns, life.spawned, life.dialogs]).toEqual([["https://pypi.org/pypi/postgres-mcp/json", "https://pypi.org/pypi/postgres-mcp/json"], 1, [], 1]);
    expect(JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8")).mcpServers.postgres.args).toEqual(["postgres-mcp==9.9.9", "--access-mode=restricted"]);
    const main = await read("src/main.ts");
    expect(main).toContain('const smokeUpdate = smokeInstall === undefined ? undefined : process.env["OPENHUB_SMOKE_UPDATE"] || undefined;');
    expect(main).toContain("dialog: smokeLifecycle?.dialog ?? { showMessageBox: (options) => dialog.showMessageBox(options) }");
    expect(await read("renderer/lifecycle.js")).toContain("window.__openhubLifecycle = async (toolId) => {");
  });

  it("AC-046-09 Lifecycle을 붙여도 FOR YOU·설치 흐름이 그대로 동작하고 서로의 화면 요소를 건드리지 않는다", async () => {
    const w = await wired();
    await w.scan();
    expect(await w.status()).toEqual({ status: "ok", items: [], note: "사용자 범위 설정은 Desktop에서 확인하지 않습니다(CLI --include-host)." });
    expect(await w.install()).toMatchObject({ status: "done", result: { status: "succeeded", stages: [{ name: "Prepared" }, { name: "Configured" }, { name: "Detected" }] } });
    expect((await items(w)).map((i) => i.toolId)).toEqual(["postgres-mcp"]);
    const js = await read("renderer/lifecycle.js");
    expect(js).not.toMatch(/for-you-list|install-panel|planInstall|runInstall|recommendProject/u);
    for (const file of ["renderer/for-you.js", "renderer/install.js"]) expect(await read(file), file).not.toMatch(/lifecycle/u);
    const html = await read("renderer/index.html");
    expect(html).toContain('<section class="card" id="lifecycle">');
    expect(html).not.toContain("설치·업데이트 상태는 M4–M5에서 연결됩니다.");
  });
});

