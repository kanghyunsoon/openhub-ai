import { cp, mkdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  containsAbsolutePath,
  LIFECYCLE_APPROVAL_MESSAGES,
  loadRegistry,
  planLifecycle,
  projectKeyFromRealpath,
  recordInstallInState,
  runInstallTransaction,
  toolConfigLocation,
  type ClientLauncher,
  type HealthRunReport,
  type InstallClient,
} from "@openhub/core";
import type { NativeDialogLike } from "../src/install";
import {
  LIFECYCLE_PLAN_CHANNELS,
  LIFECYCLE_RUN_CHANNEL,
  LIFECYCLE_STATUS_CHANNEL,
  LifecycleSession,
  lifecycleDialogDetail,
  registerLifecycle,
  type LifecyclePlanResponse,
  type LifecycleRunResponse,
  type LifecycleStatusResponse,
} from "../src/lifecycle";
import { approveAll, createHarness, plannedOf, type Harness } from "../../../packages/core/test/installer/harness";
import { fakeNpmSpawner } from "../../../packages/core/test/process/fake-npm";
import { FakeWindowsFs } from "../../../packages/core/test/tool-config/fake-windows-fs";

/**
 * v0.2.0 P0-3 Desktop Repair. Core로 실제 kubernetes-mcp-server(검토된 tool config)를 임시 프로젝트에 설치한 뒤, Desktop main 프로세스의
 * Lifecycle IPC(lifecycle:status → lifecycle:plan-repair → lifecycle:run)를 그대로 호출한다. 승인은 네이티브 대화상자(가짜)에서만 만들어진다.
 * 실제 파일(Client 설정·tool config·Version State)을 쓰고 읽는다. npm은 가짜(npx Prepare 흉내), Health는 주입, network 0.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY = path.join(ROOT, "registry");
const { entries } = await loadRegistry(REGISTRY);
const scratch = await (async () => {
  const { mkdtemp } = await import("node:fs/promises");
  return mkdtemp(path.join(tmpdir(), "openhub-desktop-repair-"));
})();
afterAll(() => rm(scratch, { recursive: true, force: true }));
const K8S = "kubernetes-mcp-server";
const ID = "project:claude-code:kubernetes";
const CLIENTS = (["claude-code", "codex", "cursor"] as const).map((client) => ({ client, scope: "project" as const }));
const NODE_A = "C:\\Users\\Kim Dev\\nodejs";
const NODE_B = "C:\\Program Files\\nodejs";
const OTHER = { mcpServers: { other: { command: "uvx", args: ["other-mcp"] } } };
const healthy: HealthRunReport = { ok: true, result: { status: "healthy", reason: null, toolCount: 13, environmentUnverified: false, terminated: true, excerpt: null } };
const unhealthy: HealthRunReport = { ok: true, result: { status: "unhealthy", reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } };

interface Options {
  windows?: boolean;
  /** 대화상자 응답(1 = 승인, 0 = 취소). 대화상자가 열린 뒤(승인 직후) 할 일을 넣을 수 있다. */
  dialog?: () => Promise<number> | number;
  health?: () => Promise<HealthRunReport> | HealthRunReport;
}

async function setup(o: Options = {}) {
  const h = await createHarness(scratch, { entries });
  await writeFile(path.join(h.projectRoot, ".mcp.json"), JSON.stringify(OTHER, null, 2) + "\n");
  const win = new FakeWindowsFs();
  const a = win.install(NODE_A);
  const current: { launcher: ClientLauncher | null } = { launcher: a };
  const windows = o.windows === true;
  const request = { ...h.request(K8S, CLIENTS), platform: windows ? ("windows" as const) : ("linux" as const) };
  const installEnv = { ...h.env, ...(windows ? { windowsNpx: async () => current.launcher, launcherCheckFs: win.fs } : {}) };
  const planned = await plannedOf(h, request);
  const installed = await runInstallTransaction(planned, await approveAll(planned), request, installEnv);
  expect(installed.status, JSON.stringify(installed.steps)).toBe("succeeded");
  await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });

  const npm = fakeNpmSpawner({ cacheRoot: path.join(h.base, "npm-cache") });
  const dialogs: Parameters<NativeDialogLike["showMessageBox"]>[0][] = [];
  const healthRuns: string[] = [];
  let projectDir: string | undefined = h.projectRoot;
  const dialog: NativeDialogLike = { showMessageBox: async (opt) => (dialogs.push(opt), { response: await (o.dialog?.() ?? 1) }) };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (c: string, fn: (...args: unknown[]) => unknown) => void handlers.set(c, fn) };
  registerLifecycle(ipc, new LifecycleSession(() => projectDir), {
    registryDir: REGISTRY,
    platform: windows ? "win32" : "linux",
    homeDir: h.homeDir,
    dialog,
    probe: h.env.probe,
    spawner: npm.spawner,
    runHealth: async (verified) => (healthRuns.push(verified.plan.operation), (await o.health?.()) ?? healthy),
    tempBase: h.base,
    now: () => new Date("2026-10-10T00:00:00.000Z"),
    ...(windows ? { windowsNpx: async () => current.launcher, launcherCheckFs: win.fs } : {}),
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  const status = async () => {
    const s = (await call(LIFECYCLE_STATUS_CHANNEL)) as LifecycleStatusResponse;
    if (s.status !== "ok") throw new Error(s.status);
    return s.items.filter((i) => i.toolId === K8S);
  };
  const toolConfigFile = async (root = h.projectRoot) => toolConfigLocation({ homeDir: h.homeDir, scope: "project", toolId: K8S, projectKey: projectKeyFromRealpath(await realpath(root)) })!.file;
  const files = async (root = h.projectRoot) => Promise.all([".mcp.json", path.join(".cursor", "mcp.json"), path.join(".codex", "config.toml")].map((f) => readFile(path.join(root, f), "utf8")));
  const stateBytes = () => readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8");
  return {
    h,
    win,
    current,
    a,
    npm,
    dialogs,
    healthRuns,
    handlers,
    setProject: (d: string | undefined) => void (projectDir = d),
    status,
    plan: (id: unknown = ID) => call(LIFECYCLE_PLAN_CHANNELS.repair, id) as Promise<LifecyclePlanResponse>,
    run: (id: unknown = ID) => call(LIFECYCLE_RUN_CHANNEL, id) as Promise<LifecycleRunResponse>,
    toolConfigFile,
    files,
    stateBytes,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
const claude = (c: Ctx) => c.status().then((items) => items.find((i) => i.id === ID)!);
const states = (c: Ctx) => c.status().then((items) => items.map((i) => i.id.split(":")[1] + ":" + i.state));
async function repaired(c: Ctx) {
  const plan = await c.plan();
  expect(plan.status, JSON.stringify(plan)).toBe("ok");
  const run = await c.run();
  if (run.status !== "done") throw new Error(JSON.stringify(run));
  return run.result;
}

describe("v0.2.0 P0-3 Desktop Repair(lifecycle:plan-repair → 네이티브 승인 → lifecycle:run)", () => {
  it("1: 정상 상태에서는 [복구 계획 확인]이 없고 repair IPC도 계획을 만들지 않는다. 관리하지 않는 id·user scope도 거부한다", async () => {
    const c = await setup();
    const items = await c.status();
    expect(items.map((i) => [i.state, i.canRepair])).toEqual(Array(3).fill(["state-consistent", false]));
    for (const id of [ID, "user:cursor:kubernetes", "project:claude-code:other", "../.mcp.json", 7, { id: ID }]) expect((await c.plan(id)).status, String(id)).toBe("not-managed");
    expect(c.dialogs).toEqual([]);
    expect(await c.run()).toEqual({ status: "no-plan" });
  });

  it("2·9·10·14: tool config 삭제 → tool-config-missing → Repair Plan 미리보기 → 승인 → 복구 성공·Health 성공 → 최신 상태 일치. 다른 MCP 항목은 그대로다", async () => {
    const c = await setup();
    const before = await c.files();
    await unlink(await c.toolConfigFile());
    const item = await claude(c);
    expect(item).toMatchObject({ state: "tool-config-missing", canRepair: true, canHealth: false, canUpdate: false });
    expect(item.warning).toContain("[복구 계획 확인]");
    const result = await repaired(c);
    expect(result).toMatchObject({ status: "repaired", outcome: "succeeded", health: ["Health: Healthy (2026-10-10T00:00:00.000Z)"] });
    expect(c.healthRuns).toEqual(["repair"]);
    expect(await states(c)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
    expect(await readFile(await c.toolConfigFile(), "utf8")).toContain("kind = \"Secret\"");
    const after = await c.files();
    expect(after).toEqual(before);
    expect(JSON.parse(after[0]!).mcpServers.other).toEqual(OTHER.mcpServers.other);
  });

  it("3: tool config 내용이 바뀌면 tool-config-drift → 승인한 repair가 검토된 내용으로 되돌린다", async () => {
    const c = await setup();
    await writeFile(await c.toolConfigFile(), "read_only = false\n");
    expect(await claude(c)).toMatchObject({ state: "tool-config-drift", canRepair: true });
    expect(await repaired(c)).toMatchObject({ status: "repaired", outcome: "succeeded" });
    expect(await readFile(await c.toolConfigFile(), "utf8")).toContain("read_only = true");
  });

  it("4: Windows Node.js 실행 경로가 바뀌면 client-launcher-invalid → 승인한 repair가 이 Client의 실행 경로만 바꾼다", async () => {
    const c = await setup({ windows: true });
    c.win.remove(NODE_A);
    const b = c.win.install(NODE_B);
    c.current.launcher = b;
    const item = await claude(c);
    expect(item).toMatchObject({ state: "client-launcher-invalid", canRepair: true, canHealth: false });
    expect(item.lines.join("\n")).toContain("실행 경로");
    const plan = await c.plan();
    if (plan.status !== "ok") throw new Error(plan.status);
    expect(plan.view.previewLines.join("\n")).toContain("client-launcher-invalid");
    expect(containsAbsolutePath(JSON.stringify(plan))).toBe(false);
    expect(await c.run()).toMatchObject({ status: "done", result: { status: "repaired", outcome: "succeeded" } });
    const mcp = JSON.parse((await c.files())[0]!).mcpServers;
    expect(mcp.kubernetes.command).toBe(b.node);
    expect(mcp.kubernetes.args[0]).toBe(b.npxCli);
    expect(mcp.other).toEqual(OTHER.mcpServers.other);
    // 이 항목만 고쳤다. 다른 Client는 각자 [복구 계획 확인]으로 승인받는다(일괄 자동 수정 없음).
    expect(await states(c)).toEqual(["claude-code:state-consistent", "codex:client-launcher-invalid", "cursor:client-launcher-invalid"]);
    expect((await c.status()).find((i) => i.id === "project:codex:kubernetes")?.canRepair).toBe(true);
  });

  it("5: 옮기거나 복사한 프로젝트는 tool-config-relocated → 승인한 repair가 이 프로젝트용 tool config와 기록을 만든다", async () => {
    const c = await setup();
    const copy = path.join(c.h.base, "copied project");
    await cp(c.h.projectRoot, copy, { recursive: true });
    c.setProject(copy);
    const item = (await c.status()).find((i) => i.id === ID)!;
    expect(item).toMatchObject({ state: "tool-config-relocated", canRepair: true });
    expect(await repaired(c)).toMatchObject({ status: "repaired", outcome: "succeeded" });
    expect(await states(c)).toContain("claude-code:state-consistent");
    expect(await readFile(await c.toolConfigFile(copy), "utf8")).toContain("kind = \"Secret\"");
  });

  it("6: Preview는 Core 문장이고, 네이티브 대화상자에 도구·Client·scope·설정·준비 명령·tool config·Health·주의·승인 항목·digest가 모두 있다(경로 없음)", async () => {
    const c = await setup();
    await unlink(await c.toolConfigFile());
    const plan = await c.plan();
    if (plan.status !== "ok") throw new Error(plan.status);
    expect(plan.view).toMatchObject({ operation: "repair", executable: true });
    expect(plan.view.previewLines[0]).toBe("Kubernetes MCP Server (kubernetes-mcp-server) 복구 계획");
    expect(plan.view.requirements.map((r) => r.id)).toEqual(["base", "health-execution", "tool-config"]);
    await c.run();
    const detail = c.dialogs[0]!.detail!;
    for (const part of [
      "도구: Kubernetes MCP Server (kubernetes-mcp-server)",
      "대상: Claude Code · 프로젝트 범위 · .mcp.json — kubernetes 항목 교체",
      "준비 명령: npx ",
      "tool config(프로젝트 범위): 새로 만듭니다",
      "Health Check: 실행 — 실패하면 이번에 바꾼 설정을 되돌리고 Version State를 바꾸지 않습니다",
      "주의 [tool-config]",
      "[tool-config] " + LIFECYCLE_APPROVAL_MESSAGES["tool-config"],
      "Plan digest sha256:",
    ]) expect(detail).toContain(part);
    expect(c.dialogs[0]).toMatchObject({ title: "OpenHub 복구 승인", buttons: ["취소", "승인"], defaultId: 0, cancelId: 0 });
    expect(containsAbsolutePath(detail)).toBe(false);
  });

  it("7: 승인을 거절하면 파일 쓰기·명령 실행·Health가 0건이다", async () => {
    const c = await setup({ dialog: () => 0 });
    await unlink(await c.toolConfigFile());
    const files = await c.files();
    const state = await c.stateBytes();
    await c.plan();
    expect(await c.run()).toEqual({ status: "rejected" });
    expect(c.npm.calls).toEqual([]);
    expect(c.healthRuns).toEqual([]);
    expect(await c.files()).toEqual(files);
    expect(await c.stateBytes()).toBe(state);
    await expect(readFile(await c.toolConfigFile())).rejects.toThrow();
  });

  it("8: 승인 직후 파일이 바뀌면 PLAN_STALE이고 아무것도 쓰지 않으며 재승인을 요구한다", async () => {
    let file = "";
    const c = await setup({ dialog: async () => (await writeFile(file, "read_only = false\n"), 1) });
    file = await c.toolConfigFile();
    await unlink(file);
    await c.plan();
    const run = await c.run();
    expect(run).toMatchObject({ status: "done", result: { status: "stale", code: "PLAN_STALE", outcome: "not-run", reapprove: true } });
    if (run.status === "done") expect(run.result.summary).toContain("다시 승인");
    expect(await readFile(file, "utf8")).toBe("read_only = false\n");
    expect(c.npm.calls).toEqual([]);
  });

  it("11·12: Health가 실패하면 실패(HEALTH_FAILED)로 표시하고 이번 변경만 되돌린다(보상 성공). Version State는 그대로다", async () => {
    const c = await setup({ health: () => unhealthy });
    await unlink(await c.toolConfigFile());
    const files = await c.files();
    const state = await c.stateBytes();
    const result = await repaired(c);
    expect(result).toMatchObject({ status: "health-failed", outcome: "failed" });
    expect(result.summary).toContain("HEALTH_FAILED");
    expect(result.summary).toContain("되돌렸고");
    expect(await c.files()).toEqual(files);
    expect(await c.stateBytes()).toBe(state);
    await expect(readFile(await c.toolConfigFile())).rejects.toThrow();
    expect(await claude(c)).toMatchObject({ state: "tool-config-missing", canRepair: true });
  });

  it("13: 보상 중 다른 프로그램이 바꾼 설정은 덮어쓰지 않고 부분 실패(CONFIG_RESTORE_FAILED)로 표시한다", async () => {
    const external = '{ "mcpServers": { "kubernetes": { "command": "someone-else", "args": [] } } }\n';
    let mcp = "";
    const c = await setup({ health: async () => (await writeFile(mcp, external), unhealthy) });
    mcp = path.join(c.h.projectRoot, ".mcp.json");
    await writeFile(await c.toolConfigFile(), "read_only = false\n");
    const result = await repaired(c);
    expect(result).toMatchObject({ status: "rollback-failed", code: "CONFIG_RESTORE_FAILED", outcome: "partial" });
    expect(result.summary).toContain("덮어쓰지 않았습니다");
    expect(await readFile(mcp, "utf8")).toBe(external);
  });

  it("15: user scope는 Desktop이 읽거나 고치지 않고(D-003), Core user scope Repair Plan은 user-scope-config 승인을 요구하며 대화상자에 표시된다", async () => {
    const h = await createHarness(scratch, { entries });
    const request = { ...h.request(K8S, [{ client: "cursor" as InstallClient, scope: "user" as const }], true), platform: "linux" as const };
    const planned = await plannedOf(h, request);
    const installed = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(installed.status).toBe("succeeded");
    await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
    await unlink(toolConfigLocation({ homeDir: h.homeDir, scope: "user", toolId: K8S })!.file);
    const built = await planLifecycle({ operation: "repair", toolId: K8S, projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "linux", includeUser: true, targets: [{ client: "cursor", scope: "user" }] });
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.status).toBe("ready");
    expect(built.planned.plan.approvalRequirements).toContain("user-scope-config");
    const detail = lifecycleDialogDetail(built.planned, built.planned.plan.approvalRequirements.map((id) => ({ id, message: LIFECYCLE_APPROVAL_MESSAGES[id] })));
    expect(detail).toContain("대상: Cursor · 사용자 범위");
    expect(detail).toContain("[user-scope-config]");
    // Desktop IPC는 user scope 항목을 보여 주지도, 계획하지도 않는다.
    const c = await setup();
    expect((await c.plan("user:cursor:kubernetes")).status).toBe("not-managed");
  });

  it("16: 계획을 만든 뒤 다른 프로젝트를 고르면 이전 계획을 실행하지 않는다(대화상자 0, 쓰기 0)", async () => {
    const c = await setup();
    await unlink(await c.toolConfigFile());
    expect((await c.plan()).status).toBe("ok");
    const other = path.join(c.h.base, "other project");
    await mkdir(other);
    c.setProject(other);
    expect(await c.run()).toMatchObject({ status: "project-changed" });
    expect(c.dialogs).toEqual([]);
    expect(c.npm.calls).toEqual([]);
    c.setProject(c.h.projectRoot);
    expect(await c.run()).toEqual({ status: "no-plan" });
    await expect(readFile(await c.toolConfigFile())).rejects.toThrow();
  });

  it("16b: 승인 대화상자가 열린 동안 다른 프로젝트를 고르면 승인을 쓰지 않는다(이전 프로젝트 쓰기 0, 다른 프로젝트 보존)", async () => {
    let switchTo: (() => void) | undefined;
    const c = await setup({ dialog: () => (switchTo?.(), 1) });
    const other = path.join(c.h.base, "other project");
    await mkdir(other);
    await writeFile(path.join(other, ".mcp.json"), JSON.stringify(OTHER, null, 2) + "\n");
    switchTo = () => c.setProject(other);
    await unlink(await c.toolConfigFile());
    const files = await c.files();
    const state = await c.stateBytes();
    expect((await c.plan()).status).toBe("ok");
    expect(await c.run()).toMatchObject({ status: "project-changed" });
    expect(c.dialogs).toHaveLength(1);
    expect(c.npm.calls).toEqual([]);
    expect(c.healthRuns).toEqual([]);
    expect(await c.files()).toEqual(files);
    expect(await c.stateBytes()).toBe(state);
    expect(await readFile(path.join(other, ".mcp.json"), "utf8")).toBe(JSON.stringify(OTHER, null, 2) + "\n");
    await expect(readFile(await c.toolConfigFile())).rejects.toThrow();
  });

  it("Core가 repair를 거부하는 config-drift(인자 변경)와 유효한 Node.js가 없는 경우는 버튼을 만들지 않고 이유를 보여 준다", async () => {
    const c = await setup();
    const mcp = path.join(c.h.projectRoot, ".mcp.json");
    await writeFile(mcp, (await readFile(mcp, "utf8")).replace("--read-only", "--log-level"));
    expect(await claude(c)).toMatchObject({ state: "config-drift", canRepair: false });
    expect((await c.plan()).status).toBe("not-managed");
    const w = await setup({ windows: true });
    w.win.remove(NODE_A);
    w.current.launcher = null;
    const item = await claude(w);
    expect(item).toMatchObject({ state: "client-launcher-invalid", canRepair: false });
    expect(item.warning).toContain("CLIENT_LAUNCHER_UNAVAILABLE");
  });

  it("renderer는 canRepair일 때만 [복구 계획 확인]을 만들고, preload는 entry id 하나만 보낸다. 결과 요약을 textContent로 보여 준다", async () => {
    const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");
    const js = await read("renderer/lifecycle.js");
    expect(js).toContain('if (item.canRepair) actions.append(button("lifecycle-repair", "복구 계획 확인", () => void open("repair", item.id)));');
    expect(js).toContain("repair: (id) => window.openhub.planLifecycleRepair(id),");
    expect(js).toContain('if (result.summary) nodes.push(el("p", "lifecycle-outcome outcome-" + result.outcome, result.summary));');
    expect(js).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML/u);
    expect(await read("src/preload.ts")).toContain('planLifecycleRepair: (id: unknown) => ipcRenderer.invoke("lifecycle:plan-repair", String(id)),');
  });
});

