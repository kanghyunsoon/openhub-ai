import "./locale-ko";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRegistry, npxCacheKey, readLifecycleState, recordInstallInState, runInstallTransaction, type HealthRunReport } from "@openhub/core";
import { en } from "../src/i18n/en";
import { setDesktopLocale } from "../src/i18n/index";
import { ko } from "../src/i18n/ko";
import { INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, registerInstall, smokeInstallDeps, type InstallRunResponse, type NativeDialogLike } from "../src/install";
import {
  EXACT_VERSION,
  LIFECYCLE_DISCARD_CHANNEL,
  LIFECYCLE_PLAN_CHANNELS,
  LIFECYCLE_RUN_CHANNEL,
  LIFECYCLE_STATUS_CHANNEL,
  LifecycleSession,
  registerLifecycle,
  requestedVersion,
  smokeLifecycleDeps,
  type LifecyclePlanResponse,
  type LifecycleRunResponse,
  type LifecycleStatusResponse,
} from "../src/lifecycle";
import { PROJECT_SCAN_CHANNEL, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";
import { approveAll, createHarness, plannedOf } from "../../../packages/core/test/installer/harness";
import { fakeNpmSpawner } from "../../../packages/core/test/process/fake-npm";

/**
 * v0.2.0 RC 선택 A: INSTALLED의 "정확한 버전으로 Update". 원본 Registry(수정 없음)의 memory-mcp(고정 안 된 npx)를 Desktop 설치 IPC로
 * 설치한 뒤 lifecycle:plan-update { version } → 네이티브 승인(가짜 대화상자) → 실행을 IPC로 그대로 호출한다. npm은 Prepare 캐시 계약을
 * 지키는 가짜(smokeNpmSpawner), Health는 주입, network 0(정확한 버전은 resolver가 조회하지 않는다).
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const REGISTRY = path.join(ROOT, "registry");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-exact-version-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const PKG = "@modelcontextprotocol/server-memory";
const MEMORY = "project:claude-code:memory";
const POSTGRES = "project:claude-code:postgres";
const NOTES = { command: "uvx", args: ["notes-mcp"] };
const V1 = "2026.7.4";
const V2 = "2026.8.31";
const HEALTHY: HealthRunReport = { ok: true, result: { status: "healthy", reason: null, toolCount: 9, environmentUnverified: false, terminated: true, excerpt: null } };

interface Options {
  /** 대화상자가 열렸을 때 할 일(응답 전). 기본은 승인(1). */
  dialog?: (ctx: { discard: () => Promise<unknown> }) => Promise<number> | number;
  health?: () => HealthRunReport;
}

async function setup(o: Options = {}) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { notes: NOTES } }, null, 2) + "\n");
  const cache = path.join(base, "npm-cache");
  const install = smokeInstallDeps(cache);
  const life = smokeLifecycleDeps(cache);
  const fetches: string[] = [];
  const dialogs: Parameters<NativeDialogLike["showMessageBox"]>[0][] = [];
  const healthRuns: string[] = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn) };
  const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a);
  const rs = new RecommendSession();
  const is = new InstallSession();
  let pick = project;
  registerProjectScan(rs.observe(ipc), is.trackPicker(async () => pick));
  registerProjectRecommend(ipc, rs, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux" });
  registerInstall(ipc, is, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux", homeDir: home, recommend: rs, dialog: install.dialog, probe: install.probe, spawner: install.spawner });
  const dialog: NativeDialogLike = { showMessageBox: async (opt) => (dialogs.push(opt), { response: await (o.dialog?.({ discard: async () => call(LIFECYCLE_DISCARD_CHANNEL) }) ?? 1) }) };
  registerLifecycle(ipc, new LifecycleSession(() => is.projectDir), {
    registryDir: REGISTRY,
    platform: "linux",
    homeDir: home,
    dialog,
    // 정확한 버전은 조회하지 않는다. 버전 없이 계획할 때만 latest를 조회한다(npm registry 응답 형식의 가짜).
    fetch: async (url) => {
      fetches.push(String(url));
      if (String(url) === "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest") return new Response(JSON.stringify({ name: PKG, version: V2 }), { status: 200 });
      return new Response("missing", { status: 404 });
    },
    runHealth: async (verified) => (healthRuns.push(verified.plan.operation), o.health?.() ?? HEALTHY),
    spawner: life.spawner,
    probe: install.probe,
    tempBase: base,
    now: () => new Date("2026-10-11T00:00:00.000Z"),
  });
  await call(PROJECT_SCAN_CHANNEL);
  await call(PROJECT_RECOMMEND_CHANNEL);
  const installTool = async (toolId: string) => {
    await call(INSTALL_PLAN_CHANNEL, toolId);
    return (await call(INSTALL_RUN_CHANNEL, toolId)) as InstallRunResponse;
  };
  const status = async () => {
    const s = (await call(LIFECYCLE_STATUS_CHANNEL)) as LifecycleStatusResponse;
    if (s.status !== "ok") throw new Error(s.status);
    return s.items;
  };
  const mcp = async () => JSON.parse(await readFile(path.join(project, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
  const stateBytes = () => readFile(path.join(home, ".openhub", "state", "lifecycle.json"), "utf8");
  const memoryState = async () => {
    const s = await readLifecycleState({ homeDir: home });
    if (!s.ok) throw new Error(s.code);
    return Object.values(s.state.entries).find((e) => e.toolId === "memory-mcp")!;
  };
  const cached = (spec: string) => stat(path.join(cache, "_npx", npxCacheKey(spec), "node_modules", ".package-lock.json")).then(() => true, () => false);
  return {
    project,
    home,
    fetches,
    dialogs,
    healthRuns,
    npmCalls: life.spawned,
    handlers,
    installTool,
    status,
    mcp,
    stateBytes,
    memoryState,
    cached,
    plan: (op: keyof typeof LIFECYCLE_PLAN_CHANNELS, ...a: unknown[]) => call(LIFECYCLE_PLAN_CHANNELS[op], ...a) as Promise<LifecyclePlanResponse>,
    run: (...a: unknown[]) => call(LIFECYCLE_RUN_CHANNEL, ...a) as Promise<LifecycleRunResponse>,
    discard: () => call(LIFECYCLE_DISCARD_CHANNEL),
    /** 사용자가 다른 프로젝트를 고른다([프로젝트 선택]과 같은 경로). */
    switchProject: async (dir: string) => {
      pick = dir;
      await call(PROJECT_SCAN_CHANNEL);
    },
    showUser: (on: boolean) => call(LIFECYCLE_STATUS_CHANNEL, { includeUser: on }) as Promise<LifecycleStatusResponse>,
  };
}
type Ctx = Awaited<ReturnType<typeof setup>>;
async function withMemory(o: Options = {}) {
  const c = await setup(o);
  expect(await c.installTool("memory-mcp")).toMatchObject({ status: "done", result: { status: "succeeded" } });
  c.dialogs.length = 0;
  c.npmCalls.length = 0;
  return c;
}
async function updateTo(c: Ctx, version: string) {
  const plan = await c.plan("update", MEMORY, { version });
  if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
  const run = await c.run(MEMORY, { version });
  if (run.status !== "done") throw new Error(JSON.stringify(run));
  return { plan: plan.view, result: run.result };
}

describe("정확한 버전 입력 검증(main)", () => {
  it("X.Y.Z만 받고 범위·dist-tag·prerelease·URL·경로·셸 문법·공백·과도한 길이는 거부한다", () => {
    for (const ok of ["0.0.1", "1.2.3", V1, V2, "10.20.30", "0.0.67"]) expect(requestedVersion({ version: ok }), ok).toBe(ok);
    const bad = [
      "latest", "next", "^1.2.3", "~1.2.3", ">=1.0.0", "1.x", "*", "1.2", "1.2.3.4", "v1.2.3", "01.2.3", "1.02.3", "1.2.3-beta.1", "1.2.3+build.5",
      " 1.2.3", "1.2.3 ", "1.2.3\n", "https://evil.example/pkg.tgz", "file:../pkg", "../1.2.3", "C:\\pkg", "npm:other@1.0.0", "git+https://x/y.git",
      "$(whoami)", "1.2.3;rm -rf /", "1.2.3&&calc", "\u0060id\u0060", "1.2.3|x", "%COMSPEC%", "1".repeat(10) + ".0.0", "1.2.3".padEnd(70, "0"),
    ];
    for (const v of bad) expect(requestedVersion({ version: v }), JSON.stringify(v)).toBeNull();
    for (const v of [42, true, {}, [], null]) expect(requestedVersion({ version: v }), JSON.stringify(v)).toBeNull();
    for (const options of ["1.2.3", 42, ["1.2.3"], true]) expect(requestedVersion(options), JSON.stringify(options)).toBeNull();
    for (const none of [undefined, null, {}, { version: "" }, { version: undefined, digest: "x" }]) expect(requestedVersion(none), JSON.stringify(none)).toBeUndefined();
    expect(EXACT_VERSION.test("1.2.3-rc.1")).toBe(false);
  });

  it("형식이 틀리면 계획하지 않는다: resolver·npm·대화상자·쓰기 0, 기억한 계획 없음", async () => {
    const c = await withMemory();
    const before = [await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()];
    for (const options of [{ version: "latest" }, { version: "^2026.7.4" }, { version: "https://registry.npmjs.org/x" }, { version: "$(id)" }, "2026.7.4", { version: 7 }]) {
      const r = await c.plan("update", MEMORY, options);
      expect(r, JSON.stringify(options)).toEqual({ status: "invalid-version", message: ko["life.version.invalid"] });
      expect(await c.run(MEMORY, options)).toEqual({ status: "no-plan" });
    }
    expect(c.fetches).toEqual([]);
    expect(c.npmCalls).toEqual([]);
    expect(c.dialogs).toEqual([]);
    expect([await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()]).toEqual(before);
  });

  it("preload가 그대로 넘긴 잘못된 타입·공백 값(숫자·배열·객체·null·true·공백)도 main이 거절한다: 계획·resolver·npm·대화상자·쓰기 0", async () => {
    const c = await withMemory();
    const before = [await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()];
    // preload: version이 undefined가 아니면 { version }으로 넘긴다. 아래는 renderer가 보낼 수 있는 값을 그 형태로 넣은 것이다.
    for (const version of [" " + V1, V1 + " ", "   ", "\t" + V1, 42, [], [V1], {}, { version: V1 }, null, true]) {
      expect(await c.plan("update", MEMORY, { version }), JSON.stringify(version)).toEqual({ status: "invalid-version", message: ko["life.version.invalid"] });
      expect(await c.run(MEMORY, { version })).toEqual({ status: "no-plan" });
    }
    expect(c.fetches).toEqual([]);
    expect(c.npmCalls).toEqual([]);
    expect(c.dialogs).toEqual([]);
    expect(c.healthRuns).toEqual([]);
    expect([await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()]).toEqual(before);
  });

  it("npx 항목만 버전을 고를 수 있다: uvx(postgres-mcp)는 version-not-supported, rollback·health는 버전 인자를 쓰지 않는다", async () => {
    const c = await withMemory();
    expect(await c.installTool("postgres-mcp")).toMatchObject({ status: "done", result: { status: "succeeded" } });
    const items = await c.status();
    expect(items.map((i) => [i.id, i.canUpdate, i.canChooseVersion]).sort()).toEqual([
      [MEMORY, true, true],
      [POSTGRES, true, false],
    ]);
    c.fetches.length = 0;
    c.npmCalls.length = 0;
    expect(await c.plan("update", POSTGRES, { version: "0.3.0" })).toEqual({ status: "version-not-supported", message: ko["life.version.notSupported"] });
    expect(c.fetches).toEqual([]);
    const health = await c.plan("health", MEMORY, { version: V1 });
    expect(health.status === "ok" && health.view.version).toBeNull();
  });
});

describe("정확한 버전 Update V1 → V2 → Rollback V1(IPC, 실제 파일·Version State)", () => {
  it("계획·승인 대화상자·Prepare·Client 설정·Version State·Health가 정확한 버전을 따른다", async () => {
    const c = await withMemory();
    expect((await c.mcp()).mcpServers.memory!.args).toEqual(["-y", PKG]);

    const first = await updateTo(c, V1);
    expect(first.plan.version).toEqual({ from: PKG, to: PKG + "@" + V1 });
    expect(first.plan.requirements.map((r) => r.id)).toContain("health-execution");
    expect(first.result).toMatchObject({ status: "updated", outcome: "succeeded" });
    expect(c.dialogs).toHaveLength(1);
    const detail = c.dialogs[0]!.detail!;
    expect(detail).toContain("버전: " + PKG + " → " + PKG + "@" + V1);
    expect(detail).toMatch(new RegExp("준비 명령: npx .*--package=" + PKG.replace("/", "\\/") + "@" + V1.replaceAll(".", "\\.")));
    expect(detail).toContain(ko["dialog.health.gate"]);
    expect(detail).toContain("대상: Claude Code · 프로젝트 범위 · .mcp.json");
    expect(detail).toMatch(/\[base\][\s\S]*\[health-execution\]/u);
    expect(detail).toMatch(/sha256:[0-9a-f]{64}/u);
    expect(await c.cached(PKG + "@" + V1)).toBe(true);
    const afterV1 = await c.mcp();
    expect(afterV1.mcpServers.memory!.args).toContain(PKG + "@" + V1);
    expect(afterV1.mcpServers.notes).toEqual(NOTES);
    expect((await c.memoryState()).artifact.resolved?.spec).toBe(PKG + "@" + V1);

    const second = await updateTo(c, V2);
    expect(second.plan.version).toEqual({ from: PKG + "@" + V1, to: PKG + "@" + V2 });
    expect(second.result.status).toBe("updated");
    expect(await c.cached(PKG + "@" + V2)).toBe(true);
    expect((await c.mcp()).mcpServers.memory!.args).toContain(PKG + "@" + V2);
    const v2State = await c.memoryState();
    expect(v2State.artifact.resolved?.spec).toBe(PKG + "@" + V2);
    expect(v2State.previous?.artifact.resolved?.spec).toBe(PKG + "@" + V1);

    const rollback = await c.plan("rollback", MEMORY);
    if (rollback.status !== "ok") throw new Error(JSON.stringify(rollback));
    expect(rollback.view.version).toEqual({ from: PKG + "@" + V2, to: PKG + "@" + V1 });
    expect(await c.run(MEMORY)).toMatchObject({ status: "done", result: { status: "rolled-back", outcome: "succeeded" } });
    expect(c.dialogs.at(-1)!.detail).toContain("버전: " + PKG + "@" + V2 + " → " + PKG + "@" + V1);
    expect(await c.mcp()).toEqual(afterV1);
    expect((await c.memoryState()).artifact.resolved?.spec).toBe(PKG + "@" + V1);

    const health = await c.plan("health", MEMORY);
    expect(health.status).toBe("ok");
    expect(await c.run(MEMORY)).toMatchObject({ status: "done", result: { status: "health-checked", outcome: "succeeded" } });
    expect(c.healthRuns).toEqual(["update", "update", "rollback", "health"]);
    // 정확한 버전은 resolver가 network로 조회하지 않는다(존재 여부는 npm Prepare가 확인한다).
    expect(c.fetches).toEqual([]);
  });

  it("같은 버전이면 up-to-date(실행·쓰기 0), Health 실패면 이번 변경을 되돌리고 Version State를 바꾸지 않는다", async () => {
    let failHealth = false;
    const c = await withMemory({ health: () => (failHealth ? { ok: true, result: { status: "unhealthy", reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } } : { ok: true, result: { status: "healthy", reason: null, toolCount: 9, environmentUnverified: false, terminated: true, excerpt: null } }) });
    await updateTo(c, V1);
    const same = await c.plan("update", MEMORY, { version: V1 });
    expect(same.status === "ok" && same.view.upToDate).toBe(true);
    const files = [await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()];
    failHealth = true;
    await c.plan("update", MEMORY, { version: V2 });
    const failed = await c.run(MEMORY, { version: V2 });
    expect(failed).toMatchObject({ status: "done", result: { status: "health-failed", outcome: "failed" } });
    expect([await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()]).toEqual(files);
  });
});

describe("버전을 바꾸면 계획을 버린다", () => {
  it("계획을 본 뒤 버전을 바꾸면(discard) 그 계획은 실행할 수 없다", async () => {
    const c = await withMemory();
    expect((await c.plan("update", MEMORY, { version: V1 })).status).toBe("ok");
    expect(await c.discard()).toEqual({ status: "discarded" });
    expect(await c.run(MEMORY, { version: V1 })).toEqual({ status: "no-plan" });
    expect(c.dialogs).toEqual([]);
  });

  it("실행 때 화면의 버전이 계획의 버전과 다르면 대화상자를 열지 않는다(버전 없음 포함)", async () => {
    const c = await withMemory();
    const before = [await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()];
    for (const shown of [{ version: V2 }, undefined, { version: "latest" }, "2026.7.4"]) {
      expect((await c.plan("update", MEMORY, { version: V1 })).status).toBe("ok");
      expect(await c.run(MEMORY, shown), JSON.stringify(shown)).toEqual({ status: "plan-changed", message: ko["life.version.changed"] });
    }
    // 버전 없이 만든 계획에 버전을 붙여 실행해도 막는다.
    await c.plan("update", MEMORY);
    expect((await c.run(MEMORY, { version: V1 })).status).toBe("plan-changed");
    expect(c.dialogs).toEqual([]);
    expect(c.npmCalls).toEqual([]);
    expect([await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()]).toEqual(before);
  });

  it("계획을 만드는 동안 버전을 바꾸면 그 계획은 기억하지 않는다(superseded)", async () => {
    const c = await withMemory();
    const pending = c.plan("update", MEMORY, { version: V1 });
    await c.discard();
    expect(await pending).toEqual({ status: "superseded" });
    expect(await c.run(MEMORY, { version: V1 })).toEqual({ status: "no-plan" });
  });

  it("승인 대화상자가 열린 동안 버전을 바꾸면 방금 받은 승인도 쓰지 않는다(실행·Prepare·Health·쓰기 0)", async () => {
    const c = await withMemory({ dialog: async ({ discard }) => (await discard(), 1) });
    const before = [await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()];
    expect((await c.plan("update", MEMORY, { version: V1 })).status).toBe("ok");
    expect(await c.run(MEMORY, { version: V1 })).toEqual({ status: "plan-changed", message: ko["life.planChanged"] });
    expect(c.dialogs).toHaveLength(1);
    expect(c.npmCalls).toEqual([]);
    expect(c.healthRuns).toEqual([]);
    expect([await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()]).toEqual(before);
    expect(await c.cached(PKG + "@" + V1)).toBe(false);
  });

  it("D. 정확한 버전 계획을 만든 뒤 프로젝트를 바꾸면 project-changed(실행·쓰기 0)", async () => {
    const c = await withMemory();
    const other = path.join(path.dirname(c.project), "other");
    await mkdir(other);
    await writeFile(path.join(other, ".mcp.json"), '{ "mcpServers": {} }\n');
    const before = [await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()];
    expect((await c.plan("update", MEMORY, { version: V1 })).status).toBe("ok");
    await c.switchProject(other);
    expect((await c.run(MEMORY, { version: V1 })).status).toBe("project-changed");
    expect(c.dialogs).toEqual([]);
    expect(c.npmCalls).toEqual([]);
    expect([await readFile(path.join(c.project, ".mcp.json"), "utf8"), await c.stateBytes()]).toEqual(before);
  });

  it("E. 프로젝트 항목의 정확한 버전 계획은 사용자 범위 보기를 켜고 꺼도 그대로 실행된다(기존 계약)", async () => {
    const c = await withMemory();
    expect((await c.plan("update", MEMORY, { version: V1 })).status).toBe("ok");
    expect((await c.showUser(true)).status).toBe("ok");
    expect((await c.showUser(false)).status).toBe("ok");
    expect(await c.run(MEMORY, { version: V1 })).toMatchObject({ status: "done", result: { status: "updated" } });
    expect((await c.mcp()).mcpServers.memory!.args).toContain(PKG + "@" + V1);
  });

  it("F. 실행이 끝난 계획은 다시 실행할 수 없다(no-plan)", async () => {
    const c = await withMemory();
    await updateTo(c, V1);
    const dialogs = c.dialogs.length;
    expect(await c.run(MEMORY, { version: V1 })).toEqual({ status: "no-plan" });
    expect(c.dialogs).toHaveLength(dialogs);
  });
});

describe("영어 승인 대화상자", () => {
  it("버전 줄·준비 명령·Health 되돌림·승인 ID가 English로 보인다", async () => {
    setDesktopLocale("en");
    try {
      const c = await withMemory();
      await updateTo(c, V1);
      const detail = c.dialogs.at(-1)!.detail!;
      expect(detail).toContain("Version: " + PKG + " → " + PKG + "@" + V1);
      expect(detail).toContain("Preparation command: npx ");
      expect(detail).toContain(en["dialog.health.gate"]);
      expect(detail).toMatch(/\[base\][\s\S]*\[health-execution\]/u);
      expect(detail).not.toMatch(/[\uac00-\ud7a3]/u);
    } finally {
      setDesktopLocale("ko");
    }
  });
});

describe("Kubernetes MCP Server는 검토된 0.0.67 밖으로 바꿀 수 없다", () => {
  it("다른 정확한 버전은 Core가 TOOL_CONFIG_VERSION_UNREVIEWED로 막고(실행 버튼 없음), 0.0.67은 up-to-date다", async () => {
    const { entries } = await loadRegistry(REGISTRY);
    const h = await createHarness(scratch, { entries });
    const request = { ...h.request("kubernetes-mcp-server", [{ client: "claude-code" as const, scope: "project" as const }]), platform: "linux" as const };
    const planned = await plannedOf(h, request);
    const installed = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(installed.status).toBe("succeeded");
    await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const dialogs: unknown[] = [];
    registerLifecycle({ handle: (ch, fn) => void handlers.set(ch, fn) }, new LifecycleSession(() => h.projectRoot), {
      registryDir: REGISTRY,
      platform: "linux",
      homeDir: h.homeDir,
      dialog: { showMessageBox: async (o) => (dialogs.push(o), { response: 1 }) },
      probe: h.env.probe,
      spawner: fakeNpmSpawner({ cacheRoot: path.join(h.base, "npm-cache") }).spawner,
      tempBase: h.base,
    });
    const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({}, ...a);
    const id = "project:claude-code:kubernetes";
    const s = (await call(LIFECYCLE_STATUS_CHANNEL)) as LifecycleStatusResponse;
    expect(s.status === "ok" && s.items.find((i) => i.id === id)?.canChooseVersion).toBe(true);
    const unreviewed = (await call(LIFECYCLE_PLAN_CHANNELS.update, id, { version: "0.0.68" })) as LifecyclePlanResponse;
    if (unreviewed.status !== "ok") throw new Error(JSON.stringify(unreviewed));
    expect(unreviewed.view.executable).toBe(false);
    expect(unreviewed.view.previewLines.join("\n")).toContain("TOOL_CONFIG_VERSION_UNREVIEWED");
    // 실행할 수 없는 계획: 승인 kernel이 대화상자를 열지 않고 거부한다(기존 동작). 쓰기·Prepare 0.
    const before = await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8");
    expect(await call(LIFECYCLE_RUN_CHANNEL, id, { version: "0.0.68" })).toEqual({ status: "rejected" });
    expect(dialogs).toEqual([]);
    expect(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).toBe(before);
    const reviewed = (await call(LIFECYCLE_PLAN_CHANNELS.update, id, { version: "0.0.67" })) as LifecyclePlanResponse;
    expect(reviewed.status === "ok" && reviewed.view.upToDate).toBe(true);
  });
});

describe("renderer·preload", () => {
  it("버전 입력은 npx 항목에만 있고, 값은 문자열로만 보내며, 입력을 바꾸면 계획을 지우고 main에 폐기를 알린다", async () => {
    const js = await readFile(path.join(DESKTOP, "renderer/lifecycle.js"), "utf8");
    const preload = await readFile(path.join(DESKTOP, "src/preload.ts"), "utf8");
    expect(js).toMatch(/if \(item\.canChooseVersion\) \{[\s\S]*input\.className = "lifecycle-version";/u);
    expect(js).toMatch(/input\.addEventListener\("input", \(\) => \{\s*\/\/[^\n]*\n\s*current = null;\s*show\(\[\]\);\s*void window\.openhub\.discardLifecyclePlan\(\);/u);
    expect(js).toContain("update: (id) => window.openhub.planLifecycleUpdate(id, versionOf(id)),");
    // 입력값을 고치지 않는다(trim 없음). 완전히 빈 값만 버전 미지정이다.
    expect(js).toContain('const value = input ? input.value : "";');
    expect(js).toContain('return value === "" ? undefined : value;');
    expect(js).not.toMatch(/versionOf[\s\S]{0,300}\.trim\(\)/u);
    expect(js).toContain('window.openhub.runLifecycle(id, operation === "update" ? versionOf(id) : undefined)');
    expect(js).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML/u);
    expect(preload).toContain('ipcRenderer.invoke("lifecycle:plan-update", String(id), version === undefined ? undefined : { version })');
    expect(preload).toContain('ipcRenderer.invoke("lifecycle:run", String(id), version === undefined ? undefined : { version })');
    expect(preload).toContain('discardLifecyclePlan: () => ipcRenderer.invoke("lifecycle:discard")');
    for (const key of ["lifecycle.version.label", "lifecycle.version.placeholder", "lifecycle.version.hint", "life.version.invalid", "life.version.notSupported", "life.version.changed", "dialog.version"] as const) {
      expect(en[key], key).toBeTruthy();
      expect(ko[key], key).toBeTruthy();
    }
  });
});
