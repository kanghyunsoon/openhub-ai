import "./locale-ko";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { nodeConfigFs, readLifecycleState, toolConfigLocation, type BackendProbeReport, type ConfigFs, type HealthRunReport } from "@openhub/core";
import { setDesktopLocale } from "../src/i18n/index";
import {
  INSTALL_OPTIONS_CHANNEL,
  INSTALL_PLAN_CHANNEL,
  INSTALL_RUN_CHANNEL,
  InstallSession,
  registerInstall,
  type InstallOptionsResponse,
  type InstallPlanResponse,
  type InstallRunResponse,
  type NativeDialogLike,
} from "../src/install";
import { LIFECYCLE_PLAN_CHANNELS, LIFECYCLE_RUN_CHANNEL, LIFECYCLE_STATUS_CHANNEL, LifecycleSession, registerLifecycle, type LifecyclePlanResponse, type LifecycleRunResponse, type LifecycleStatusResponse } from "../src/lifecycle";
import { PROJECT_SCAN_CHANNEL, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";
import { fakeNpmSpawner } from "../../../packages/core/test/process/fake-npm";

/**
 * v0.2.0 P0-3 C2 Desktop 사용자 범위: 설치(install:options·plan·run) → INSTALLED(lifecycle:status { includeUser }) → Health → 손상 → Repair.
 * main IPC를 그대로 부른다(실제 Core Plan·승인 kernel·파일 쓰기, 임시 project·home). npm은 가짜(npx Prepare 캐시 계약), Health는 주입,
 * network·실제 MCP 실행 0. 사용자 설정 파일의 다른 항목이 byte 단위로 남는지 본다.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const REGISTRY = path.join(ROOT, "registry");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-user-scope-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => setDesktopLocale("ko"));
const K8S = "kubernetes-mcp-server";
const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};
const healthy: HealthRunReport = { ok: true, result: { status: "healthy", reason: null, toolCount: 13, environmentUnverified: false, terminated: true, excerpt: null } };
const unhealthy: HealthRunReport = { ok: true, result: { status: "unhealthy", reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } };
const PROJECT_FILES: Record<string, string> = {
  "package.json": '{ "name": "ops", "dependencies": { "pg": "^8.13.0" } }\n',
  ".mcp.json": '{ "mcpServers": {} }\n',
  "Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n",
  "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
};
/** 사용자가 이미 가진 Cursor 사용자 설정(다른 서버·다른 키). OpenHub 항목 추가 뒤에도 이 부분이 그대로 있어야 한다. */
const CURSOR_USER = '{\n  "theme": "dark",\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
const CODEX_USER = '# my codex settings\nmodel = "o4"\n\n[mcp_servers.notes]\ncommand = "uvx"\nargs = ["notes-mcp==1.0.0"]\n';

interface Opts {
  dialog?: () => number | Promise<number>;
  health?: () => HealthRunReport;
}

async function wired(o: Opts = {}) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const home = path.join(base, "home");
  const projectA = path.join(base, "project-a");
  const projectB = path.join(base, "project-b");
  for (const dir of [projectA, projectB]) {
    for (const [rel, text] of Object.entries(PROJECT_FILES)) {
      await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await writeFile(path.join(dir, rel), text);
    }
  }
  await mkdir(path.join(home, ".cursor"), { recursive: true });
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".cursor", "mcp.json"), CURSOR_USER);
  await writeFile(path.join(home, ".codex", "config.toml"), CODEX_USER);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
  const rs = new RecommendSession();
  const is = new InstallSession();
  let pick = projectA;
  registerProjectScan(rs.observe(ipc), is.trackPicker(async () => pick));
  const deps = { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux" };
  registerProjectRecommend(ipc, rs, deps);
  const npm = fakeNpmSpawner({ cacheRoot: path.join(base, "npm-cache") });
  const dialogs: { title: string; detail: string }[] = [];
  const dialog: NativeDialogLike = { showMessageBox: async (x) => (dialogs.push({ title: x.title, detail: x.detail }), { response: await (o.dialog?.() ?? 1) }) };
  const healthRuns: string[] = [];
  registerInstall(ipc, is, {
    ...deps,
    homeDir: home,
    recommend: rs,
    dialog,
    probe: async () => PROBES,
    spawner: npm.spawner as never,
    isolatedDir: async () => {
      const dir = await mkdtemp(path.join(base, "iso-"));
      return { path: dir, base, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  });
  const ls = new LifecycleSession(() => is.projectDir);
  // Lifecycle 쪽 설정 파일 읽기를 멈췄다 풀 수 있는 문(응답 순서 제어용). 먼저 도착한 읽기 하나가 하나씩 가져간다.
  const holds: { wait: Promise<void>; reached: () => void }[] = [];
  const gatedFs: ConfigFs = {
    ...nodeConfigFs,
    readFile: async (file) => {
      const hold = holds.shift();
      if (hold !== undefined) {
        hold.reached();
        await hold.wait;
      }
      return nodeConfigFs.readFile(file);
    },
  };
  registerLifecycle(ipc, ls, {
    registryDir: REGISTRY,
    platform: "linux",
    homeDir: home,
    dialog,
    configFs: gatedFs,
    probe: async () => PROBES,
    spawner: npm.spawner as never,
    tempBase: base,
    runHealth: async (verified) => (healthRuns.push(verified.plan.targets.map((t) => t.scope + ":" + t.client).join(",")), o.health?.() ?? healthy),
    now: () => new Date("2026-10-11T00:00:00.000Z"),
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  await call(PROJECT_SCAN_CHANNEL);
  const recommended = ((await call(PROJECT_RECOMMEND_CHANNEL)) as { view?: { items: { toolId: string }[] } }).view?.items.map((i) => i.toolId) ?? [];
  return {
    base,
    home,
    projectA,
    projectB,
    dialogs,
    healthRuns,
    npm,
    recommended,
    /** 다음 Lifecycle 설정 읽기를 멈춘다. arrived: 실제로 멈췄을 때, release: 풀 때. */
    hold: () => {
      let release!: () => void;
      let reached!: () => void;
      const arrived = new Promise<void>((r) => (reached = r));
      holds.push({ wait: new Promise<void>((r) => (release = r)), reached });
      return { arrived, release };
    },
    switchProject: async (dir: string) => {
      pick = dir;
      await call(PROJECT_SCAN_CHANNEL);
      await call(PROJECT_RECOMMEND_CHANNEL);
    },
    options: (...a: unknown[]) => call(INSTALL_OPTIONS_CHANNEL, ...a) as Promise<InstallOptionsResponse>,
    plan: (...a: unknown[]) => call(INSTALL_PLAN_CHANNEL, ...a) as Promise<InstallPlanResponse>,
    install: (...a: unknown[]) => call(INSTALL_RUN_CHANNEL, ...a) as Promise<InstallRunResponse>,
    status: (...a: unknown[]) => call(LIFECYCLE_STATUS_CHANNEL, ...a) as Promise<LifecycleStatusResponse>,
    lifePlan: (op: keyof typeof LIFECYCLE_PLAN_CHANNELS, id: string) => call(LIFECYCLE_PLAN_CHANNELS[op], id) as Promise<LifecyclePlanResponse>,
    lifeRun: (id: string) => call(LIFECYCLE_RUN_CHANNEL, id) as Promise<LifecycleRunResponse>,
    read: (rel: string) => readFile(path.join(home, rel), "utf8"),
    userToolConfig: () => toolConfigLocation({ homeDir: home, scope: "user", toolId: K8S })!.file,
  };
}

const exists = (p: string) => stat(p).then(() => true, () => false);

async function installUser(w: Awaited<ReturnType<typeof wired>>, toolId: string, clients: string[]) {
  const plan = await w.plan(toolId, { clients, scope: "user" });
  if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
  const run = await w.install(toolId);
  if (run.status !== "done") throw new Error(JSON.stringify(run));
  return { plan, run };
}

describe("v0.2.0 P0-3 C2 사용자 범위 설치", () => {
  it("install:options: Client별 프로젝트·사용자 설정 파일을 보여 주고 Claude Code 사용자 설정(~/.claude.json)은 쓰지 않는다고 표시한다", async () => {
    const w = await wired();
    expect(w.recommended).toEqual(expect.arrayContaining([K8S, "postgres-mcp"]));
    const r = await w.options("postgres-mcp");
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.defaultScope).toBe("project");
    expect(r.view.clients.map((c) => [c.client, c.files.project, c.files.user])).toEqual([
      ["claude-code", ".mcp.json", null],
      ["codex", ".codex/config.toml", "~/.codex/config.toml"],
      ["cursor", ".cursor/mcp.json", "~/.cursor/mcp.json"],
    ]);
    expect(r.view.clients[0]!.userNote).toBe("OpenHub는 이 Client의 사용자 설정(~/.claude.json)을 쓰지 않습니다. 프로젝트 범위를 고르거나 Client에서 직접 추가하세요.");
  });

  it("잘못된 scope IPC는 계획하지 않는다(알 수 없는 범위·문자열 아닌 범위·user + Claude Code·경로)", async () => {
    const w = await wired();
    for (const bad of [{ clients: ["cursor"], scope: "global" }, { clients: ["cursor"], scope: 1 }, { clients: ["claude-code"], scope: "user" }, { clients: ["cursor"], scope: "~/.cursor/mcp.json" }, { clients: ["cursor"], scope: null }]) {
      expect(await w.plan("postgres-mcp", bad), JSON.stringify(bad)).toMatchObject({ status: "error", code: "invalid-selection" });
      expect(await w.install("postgres-mcp")).toEqual({ status: "no-plan" });
    }
    expect(await w.read(".cursor/mcp.json")).toBe(CURSOR_USER);
    expect(await w.read(".codex/config.toml")).toBe(CODEX_USER);
    expect(w.dialogs).toEqual([]);
  });

  it("사용자 범위 설치: user-scope-config 승인과 홈 폴더·다른 프로젝트 영향 경고가 대화상자에 있고, 고른 Client 사용자 설정만 바뀌며 기존 항목은 byte 그대로다", async () => {
    const w = await wired();
    const { plan, run } = await installUser(w, "postgres-mcp", ["cursor"]);
    expect(plan.view.targets.map((t) => [t.client, t.scope, t.file])).toEqual([["cursor", "user", "~/.cursor/mcp.json"]]);
    expect(plan.view.userScope).toBe(true);
    expect(plan.view.requirements.map((r) => r.id)).toContain("user-scope-config");
    expect(run.status === "done" && run.result.status).toBe("succeeded");
    const d = w.dialogs[0]!;
    expect(d.detail).toContain("Cursor · 사용자 범위(다른 프로젝트에도 영향) · ~/.cursor/mcp.json");
    expect(d.detail).toContain("사용자 범위: OpenHub가 홈 폴더의 설정 파일을 바꿉니다. 이 프로젝트만이 아니라 이 Client를 쓰는 모든 프로젝트에 영향을 줍니다.");
    expect(d.detail).toContain("[user-scope-config]");
    const after = await w.read(".cursor/mcp.json");
    expect(after).not.toBe(CURSOR_USER);
    const parsed = JSON.parse(after) as { theme: string; mcpServers: Record<string, unknown> };
    expect(parsed.theme).toBe("dark");
    expect(parsed.mcpServers["notes"]).toEqual({ command: "uvx", args: ["notes-mcp==1.0.0"] });
    expect(Object.keys(parsed.mcpServers).sort()).toEqual(["notes", "postgres"]);
    // 고르지 않은 Codex 사용자 설정·프로젝트 설정은 그대로다.
    expect(await w.read(".codex/config.toml")).toBe(CODEX_USER);
    expect(await readFile(path.join(w.projectA, ".mcp.json"), "utf8")).toBe(PROJECT_FILES[".mcp.json"]);
    expect(await exists(path.join(w.projectA, ".cursor"))).toBe(false);
    const state = await readLifecycleState({ homeDir: w.home });
    expect(state.ok && Object.values(state.state.entries).map((e) => [e.target.scope, e.target.client, e.target.projectKey])).toEqual([["user", "cursor", null]]);
  });

  it("English 승인 대화상자도 사용자 범위의 넓은 영향을 표시한다", async () => {
    setDesktopLocale("en");
    const w = await wired();
    await installUser(w, "postgres-mcp", ["codex"]);
    expect(w.dialogs[0]!.detail).toContain("Codex · user scope (affects other projects too) · ~/.codex/config.toml");
    expect(w.dialogs[0]!.detail).toContain("User scope: OpenHub changes configuration files in your home folder. This affects every project that uses these clients, not only this project.");
    const toml = await w.read(".codex/config.toml");
    expect(toml.startsWith(CODEX_USER)).toBe(true);
  });

  it("승인 거절 → 쓰기 0(사용자 설정·Version State 그대로), 승인 중 사용자 설정이 바뀌면 PLAN_STALE이고 외부 변경을 덮지 않는다", async () => {
    const rejected = await wired({ dialog: () => 0 });
    expect((await rejected.plan("postgres-mcp", { clients: ["cursor"], scope: "user" })).status).toBe("ok");
    expect(await rejected.install("postgres-mcp")).toEqual({ status: "rejected" });
    expect(await rejected.read(".cursor/mcp.json")).toBe(CURSOR_USER);
    expect(await exists(path.join(rejected.home, ".openhub"))).toBe(false);

    const external = '{ "mcpServers": { "mine": { "command": "x" } } }\n';
    let w: Awaited<ReturnType<typeof wired>>;
    w = await wired({ dialog: async () => (await writeFile(path.join(w.home, ".cursor", "mcp.json"), external), 1) });
    expect((await w.plan("postgres-mcp", { clients: ["cursor"], scope: "user" })).status).toBe("ok");
    const run = await w.install("postgres-mcp");
    expect(run.status === "done" && run.result).toMatchObject({ status: "stale", reapprove: true });
    expect(await w.read(".cursor/mcp.json")).toBe(external);
    expect(await exists(path.join(w.home, ".openhub", "state"))).toBe(false);
  });

  it("사용자 설정을 쓸 수 없으면(파일 자리에 폴더) 실패로 끝나고 다른 파일·Version State는 그대로다", async () => {
    const w = await wired();
    await rm(path.join(w.home, ".codex", "config.toml"));
    await mkdir(path.join(w.home, ".codex", "config.toml"));
    const plan = await w.plan("postgres-mcp", { clients: ["cursor", "codex"], scope: "user" });
    if (plan.status === "ok") {
      const run = await w.install("postgres-mcp");
      expect(run.status === "done" && run.result.status).not.toBe("succeeded");
    } else {
      expect(plan.status).toBe("error");
    }
    expect(await w.read(".cursor/mcp.json")).toBe(CURSOR_USER);
    const state = await readLifecycleState({ homeDir: w.home });
    expect(state.ok ? Object.keys(state.state.entries) : []).toEqual([]);
  });
});


describe("v0.2.0 P0-3 C2 사용자 범위 계획 일관성(main IPC 직접 호출)", () => {
  it("A. 사용자 항목 계획 중 보기를 끄면 계획이 끝나도 기억하지 않는다(superseded, 실행 불가)", async () => {
    const w = await wired();
    await installUser(w, "postgres-mcp", ["cursor"]);
    await w.status({ includeUser: true });
    const hold = w.hold();
    const pending = w.lifePlan("health", "user:cursor:postgres");
    await hold.arrived;
    await w.status({ includeUser: false });
    hold.release();
    // 보기를 끈 시점에 따라 superseded(계획 뒤 확인) 또는 not-managed(사용자 항목 확인)다. 어느 쪽이든 기억하지 않는다.
    expect(["superseded", "not-managed"]).toContain((await pending).status);
    expect(await w.lifeRun("user:cursor:postgres")).toEqual({ status: "no-plan" });
    expect(w.healthRuns).toEqual([]);
    expect(w.dialogs).toHaveLength(1);
  });

  it("B. 사용자 항목 계획을 만든 뒤 보기를 끄면 실행 요청은 no-plan이다(다시 켜도 이전 계획은 없다)", async () => {
    const w = await wired();
    await installUser(w, "postgres-mcp", ["cursor"]);
    await w.status({ includeUser: true });
    expect((await w.lifePlan("health", "user:cursor:postgres")).status).toBe("ok");
    await w.status({ includeUser: false });
    await w.status({ includeUser: true });
    expect(await w.lifeRun("user:cursor:postgres")).toEqual({ status: "no-plan" });
    expect(w.healthRuns).toEqual([]);
  });

  it("C. 사용자 Repair 승인 대화상자가 열린 동안 보기를 끄면 승인해도 실행·쓰기·Health가 0이다", async () => {
    let armed = false;
    let w: Awaited<ReturnType<typeof wired>>;
    w = await wired({ dialog: async () => (armed ? void (await w.status({ includeUser: false })) : undefined, 1) });
    await installUser(w, K8S, ["codex"]);
    const toolConfig = w.userToolConfig();
    await unlink(toolConfig);
    await w.status({ includeUser: true });
    expect((await w.lifePlan("repair", "user:codex:kubernetes")).status).toBe("ok");
    const before = JSON.stringify(await readLifecycleState({ homeDir: w.home }));
    const toml = await w.read(".codex/config.toml");
    armed = true;
    const r = await w.lifeRun("user:codex:kubernetes");
    expect(r).toMatchObject({ status: "plan-changed" });
    expect(await exists(toolConfig)).toBe(false);
    expect(await w.read(".codex/config.toml")).toBe(toml);
    expect(JSON.stringify(await readLifecycleState({ homeDir: w.home }))).toBe(before);
    expect(w.healthRuns).toEqual([]);
    expect(w.npm.calls.filter((c) => c.some((a) => a.startsWith("--package=")))).toHaveLength(1);
  });

  it("D. 프로젝트 항목 계획은 사용자 범위 보기를 켜고 꺼도 그대로 실행된다", async () => {
    const w = await wired();
    expect((await w.plan("postgres-mcp", { clients: ["cursor"], scope: "project" })).status).toBe("ok");
    expect((await w.install("postgres-mcp")).status).toBe("done");
    expect((await w.lifePlan("health", "project:cursor:postgres")).status).toBe("ok");
    await w.status({ includeUser: true });
    await w.status({ includeUser: false });
    const run = await w.lifeRun("project:cursor:postgres");
    expect(run.status === "done" && run.result.status).toBe("health-checked");
    expect(w.healthRuns).toEqual(["project:cursor"]);
    // 프로젝트 계획 중 보기를 바꿔도 그 계획은 기억된다.
    const hold = w.hold();
    const pending = w.lifePlan("health", "project:cursor:postgres");
    await hold.arrived;
    await w.status({ includeUser: true });
    hold.release();
    expect((await pending).status).toBe("ok");
    const again = await w.lifeRun("project:cursor:postgres");
    expect(again.status === "done" && again.result.status).toBe("health-checked");
  });

  it("E. 보기를 유지하면 사용자 항목 Health가 정상 실행된다(같은 규칙: 대화상자 전후 재검사 통과)", async () => {
    const w = await wired();
    await installUser(w, "postgres-mcp", ["cursor"]);
    await w.status({ includeUser: true });
    expect((await w.lifePlan("health", "user:cursor:postgres")).status).toBe("ok");
    const r = await w.lifeRun("user:cursor:postgres");
    expect(r.status === "done" && r.result.status).toBe("health-checked");
  });

  it("F. 계획을 만든 뒤 프로젝트를 바꾸면 사용자·프로젝트 항목 모두 이전 계획을 실행할 수 없다", async () => {
    const w = await wired();
    await installUser(w, "postgres-mcp", ["cursor"]);
    await w.status({ includeUser: true });
    expect((await w.lifePlan("health", "user:cursor:postgres")).status).toBe("ok");
    await w.switchProject(w.projectB);
    expect((await w.lifeRun("user:cursor:postgres")).status).toBe("project-changed");
    expect(w.healthRuns).toEqual([]);
    // 계획 중 프로젝트가 바뀌면 그 계획은 기억하지 않는다.
    const hold = w.hold();
    const pending = w.lifePlan("health", "user:cursor:postgres");
    await hold.arrived;
    await w.switchProject(w.projectA);
    hold.release();
    expect(await pending).toEqual({ status: "superseded" });
    expect(await w.lifeRun("user:cursor:postgres")).toEqual({ status: "no-plan" });
  });
});

describe("v0.2.0 P0-3 C2 사용자 범위 Lifecycle(INSTALLED)", () => {
  it("기본 상태 조회는 사용자 설정을 읽지 않는다(not-inspected, 실행 버튼 없음). user 항목 계획은 사용자 범위 보기를 켜야만 된다", async () => {
    const w = await wired();
    await installUser(w, "postgres-mcp", ["cursor"]);
    const off = await w.status();
    if (off.status !== "ok") throw new Error(off.status);
    const item = off.items.find((i) => i.id === "user:cursor:postgres")!;
    expect(off.includeUser).toBe(false);
    expect(item).toMatchObject({ scope: "user", state: "not-inspected", canHealth: false, canRepair: false, canUpdate: false });
    expect(item.warning).toContain("[사용자 범위 보기]");
    expect(await w.lifePlan("health", "user:cursor:postgres")).toEqual({ status: "not-managed" });
    // 문자열이 아닌 includeUser는 무시한다.
    expect(((await w.status({ includeUser: "yes" })) as { includeUser: boolean }).includeUser).toBe(false);
    const on = await w.status({ includeUser: true });
    if (on.status !== "ok") throw new Error(on.status);
    expect(on.includeUser).toBe(true);
    expect(on.items.find((i) => i.id === "user:cursor:postgres")).toMatchObject({ state: "state-consistent", canHealth: true });
    // 끄면 다시 계획할 수 없다.
    await w.status({ includeUser: false });
    expect(await w.lifePlan("health", "user:cursor:postgres")).toEqual({ status: "not-managed" });
  });

  it("사용자 범위 Health → 승인 → healthy, 여러 프로젝트에서 같은 사용자 항목 상태가 일관된다", async () => {
    const w = await wired();
    await installUser(w, "postgres-mcp", ["cursor"]);
    await w.status({ includeUser: true });
    const plan = await w.lifePlan("health", "user:cursor:postgres");
    if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
    const run = await w.lifeRun("user:cursor:postgres");
    expect(run.status === "done" && run.result).toMatchObject({ status: "health-checked", outcome: "succeeded" });
    expect(w.healthRuns).toEqual(["user:cursor"]);
    await w.switchProject(w.projectB);
    const b = await w.status();
    if (b.status !== "ok") throw new Error(b.status);
    expect(b.items.filter((i) => i.scope === "user").map((i) => [i.id, i.state, i.canHealth])).toEqual([["user:cursor:postgres", "state-consistent", true]]);
    expect(b.items.filter((i) => i.scope === "project")).toEqual([]);
  });

  it("User·Project 중복 설치: 범위별로 따로 보이고 사용자 항목 Health는 사용자 대상만 실행한다", async () => {
    const w = await wired();
    // 사용자 범위를 먼저 설치한다(프로젝트 분석은 사용자 설정을 읽지 않으므로 프로젝트 범위 설치가 이어서 가능하다).
    // 반대 순서(프로젝트에 이미 있음)는 Core가 already-installed로 보고 사용자 설정을 쓰지 않는다(아래 테스트).
    await installUser(w, "postgres-mcp", ["cursor"]);
    expect((await w.plan("postgres-mcp", { clients: ["cursor"], scope: "project" })).status).toBe("ok");
    expect((await w.install("postgres-mcp")).status).toBe("done");
    const s = await w.status({ includeUser: true });
    if (s.status !== "ok") throw new Error(s.status);
    expect(s.items.filter((i) => i.toolId === "postgres-mcp").map((i) => [i.id, i.scope, i.state])).toEqual([
      ["project:cursor:postgres", "project", "state-consistent"],
      ["user:cursor:postgres", "user", "state-consistent"],
    ]);
    const plan = await w.lifePlan("health", "user:cursor:postgres");
    expect(plan.status === "ok" && plan.view.previewLines.join("\n")).toContain("~/.cursor/mcp.json");
    await w.lifeRun("user:cursor:postgres");
    expect(w.healthRuns).toEqual(["user:cursor"]);
    const again = await w.plan("postgres-mcp", { clients: ["codex"], scope: "user" });
    expect(again.status === "ok" && [again.view.alreadyInstalled, again.view.executable]).toEqual([true, false]);
    // 성공이 아니라 변경 없음(no-op)이고 사용자 Codex 설정·Version State에 아무것도 기록하지 않는다.
    const stateBefore = JSON.stringify(await readLifecycleState({ homeDir: w.home }));
    const noop = await w.install("postgres-mcp");
    expect(noop.status === "done" && noop.result.status).toBe("no-op");
    expect(await w.read(".codex/config.toml")).toBe(CODEX_USER);
    expect(JSON.stringify(await readLifecycleState({ homeDir: w.home }))).toBe(stateBefore);
    expect(await readFile(path.join(ROOT, "apps/desktop/renderer/install.js"), "utf8")).toContain('t(view.userScope ? "install.noChangesUserScope" : "install.noChanges")');
  });

  it("사용자 범위 tool config 손상 → Repair Plan(user-scope-config 승인) → 승인 → 복구 → Health. 거절·Health 실패는 Version State·설정을 바꾸지 않는다", async () => {
    let health: HealthRunReport = healthy;
    let answer = 1;
    const w = await wired({ dialog: () => answer, health: () => health });
    await installUser(w, K8S, ["codex"]);
    const toolConfig = w.userToolConfig();
    const tomlAfterInstall = await w.read(".codex/config.toml");
    expect(tomlAfterInstall.startsWith(CODEX_USER)).toBe(true);
    await unlink(toolConfig);
    const s = await w.status({ includeUser: true });
    if (s.status !== "ok") throw new Error(s.status);
    expect(s.items.find((i) => i.id === "user:codex:kubernetes")).toMatchObject({ state: "tool-config-missing", canRepair: true });
    const before = await readLifecycleState({ homeDir: w.home });

    // 거절: 쓰기 0.
    answer = 0;
    expect((await w.lifePlan("repair", "user:codex:kubernetes")).status).toBe("ok");
    expect(await w.lifeRun("user:codex:kubernetes")).toEqual({ status: "rejected" });
    expect(await exists(toolConfig)).toBe(false);
    // Health 실패: 이번 변경을 되돌리고 Version State는 그대로다.
    answer = 1;
    health = unhealthy;
    const plan = await w.lifePlan("repair", "user:codex:kubernetes");
    if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
    expect(plan.view.requirements.map((r) => r.id)).toContain("user-scope-config");
    const failed = await w.lifeRun("user:codex:kubernetes");
    expect(failed.status === "done" && failed.result.outcome).toBe("failed");
    expect(await exists(toolConfig)).toBe(false);
    expect(await w.read(".codex/config.toml")).toBe(tomlAfterInstall);
    expect(JSON.stringify(await readLifecycleState({ homeDir: w.home }))).toBe(JSON.stringify(before));
    // 성공: 복구 → Health → 일관.
    health = healthy;
    expect((await w.lifePlan("repair", "user:codex:kubernetes")).status).toBe("ok");
    const ok = await w.lifeRun("user:codex:kubernetes");
    expect(ok.status === "done" && ok.result).toMatchObject({ status: "repaired", outcome: "succeeded" });
    expect(await readFile(toolConfig, "utf8")).toContain('kind = "Secret"');
    expect(await w.read(".codex/config.toml")).toBe(tomlAfterInstall);
    const after = await w.status();
    expect(after.status === "ok" && after.items.find((i) => i.id === "user:codex:kubernetes")?.state).toBe("state-consistent");
    expect((await w.lifePlan("health", "user:codex:kubernetes")).status).toBe("ok");
    const h = await w.lifeRun("user:codex:kubernetes");
    expect(h.status === "done" && h.result.status).toBe("health-checked");
    const files = await readdir(path.join(w.home, ".openhub"));
    expect(files.sort()).toEqual(["state", "tool-config"]);
  });

  it("Repair 승인 중 사용자 설정이 바뀌면 PLAN_STALE이고 그 변경을 덮지 않는다", async () => {
    let w: Awaited<ReturnType<typeof wired>>;
    let armed = false;
    const external = '# replaced by user\n';
    w = await wired({ dialog: async () => (armed ? await writeFile(path.join(w.home, ".codex", "config.toml"), external) : undefined, 1) });
    await installUser(w, K8S, ["codex"]);
    await unlink(w.userToolConfig());
    await w.status({ includeUser: true });
    expect((await w.lifePlan("repair", "user:codex:kubernetes")).status).toBe("ok");
    armed = true;
    const r = await w.lifeRun("user:codex:kubernetes");
    expect(r.status === "done" && r.result).toMatchObject({ status: "stale", reapprove: true });
    expect(await w.read(".codex/config.toml")).toBe(external);
    expect(await exists(w.userToolConfig())).toBe(false);
  });
});

