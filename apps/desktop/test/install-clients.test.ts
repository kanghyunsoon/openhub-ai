import "./locale-ko";
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import type { BackendProbeReport, ExecChild, ExecSpawner, InstallClient } from "@openhub/core";
import { setDesktopLocale } from "../src/i18n/index";
import {
  INSTALL_OPTIONS_CHANNEL,
  INSTALL_DISCARD_CHANNEL,
  INSTALL_PLAN_CHANNEL,
  INSTALL_RUN_CHANNEL,
  InstallSession,
  parseClientSelection,
  registerInstall,
  type InstallOptionsResponse,
  type InstallPlanResponse,
  type InstallRunResponse,
  type NativeDialogLike,
} from "../src/install";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";

/**
 * v0.2.0 P0-3 PR C: Desktop 설치 Client 선택. main IPC(install:options·install:plan·install:run)를 실제 Core Plan·임시 project로 지난다
 * (가짜 probe·executor·대화상자, network·실제 spawn 0). 고른 Client의 설정 파일만 바뀌는지 파일로 확인한다.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const REGISTRY = path.join(ROOT, "registry");
const HANGUL = /[\uac00-\ud7a3]/u;
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-clients-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => setDesktopLocale("ko"));

const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};

async function wired(o: { files?: Record<string, string>; platform?: string; registryDir?: string; duringDialog?: (call: (channel: string, ...args: unknown[]) => unknown) => Promise<void> } = {}) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  const files = o.files ?? { "package.json": '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n', ".mcp.json": '{ "mcpServers": {} }\n' };
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
    await writeFile(path.join(project, rel), text);
  }
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
  const rs = new RecommendSession();
  const is = new InstallSession();
  // 테스트가 프로젝트를 바꿀 수 있는 picker(fixedDirectory와 같은 동작 + 대상 교체).
  let pickDir = project;
  registerProjectScan(rs.observe(ipc), is.trackPicker(async () => pickDir));
  const deps = { registryDir: o.registryDir ?? REGISTRY, metadataFile: SEED_SNAPSHOT, platform: o.platform ?? "linux" };
  registerProjectRecommend(ipc, rs, deps);
  const dialogs: string[] = [];
  const spawns: string[][] = [];
  // 계획 도중(backend probe)에서 멈췄다가 풀 수 있는 문(응답 순서 제어용). 먼저 도착한 요청 하나가 하나씩 가져간다.
  const holds: { wait: Promise<void>; reached: () => void }[] = [];
  const spawner: ExecSpawner = (executable, args) => {
    spawns.push([executable, ...args]);
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", 0, null));
    return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
  };
  const dialog: NativeDialogLike = {
    showMessageBox: async (x) => {
      dialogs.push(x.title);
      await o.duringDialog?.(call);
      return { response: 1 };
    },
  };
  registerInstall(ipc, is, {
    ...deps,
    homeDir: home,
    recommend: rs,
    dialog,
    probe: async () => {
      const hold = holds.shift();
      if (hold !== undefined) {
        hold.reached();
        await hold.wait;
      }
      return PROBES;
    },
    spawner,
    isolatedDir: async () => {
      const dir = await mkdtemp(path.join(base, "iso-"));
      return { path: dir, base, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  void fixedDirectory;
  await call(PROJECT_SCAN_CHANNEL);
  const recommended = ((await call(PROJECT_RECOMMEND_CHANNEL)) as { view?: { items: { toolId: string }[] } }).view?.items.map((i) => i.toolId) ?? [];
  return {
    project,
    home,
    dialogs,
    spawns,
    recommended,
    /** 다음 계획 요청을 probe 단계에서 멈춘다. reached는 그 요청이 실제로 멈췄을 때, release는 풀 때. */
    hold: () => {
      let release!: () => void;
      let reached!: () => void;
      const arrived = new Promise<void>((r) => (reached = r));
      holds.push({ wait: new Promise<void>((r) => (release = r)), reached });
      return { arrived, release };
    },
    switchProject: async (files: Record<string, string>) => {
      const other = path.join(base, "other-" + String(Date.now()));
      await mkdir(other);
      for (const [rel, text] of Object.entries(files)) await writeFile(path.join(other, rel), text);
      pickDir = other;
      await call(PROJECT_SCAN_CHANNEL);
      return other;
    },
    discard: (...a: unknown[]) => call(INSTALL_DISCARD_CHANNEL, ...a),
    options: (...a: unknown[]) => call(INSTALL_OPTIONS_CHANNEL, ...a) as Promise<InstallOptionsResponse>,
    plan: (...a: unknown[]) => call(INSTALL_PLAN_CHANNEL, ...a) as Promise<InstallPlanResponse>,
    run: (...a: unknown[]) => call(INSTALL_RUN_CHANNEL, ...a) as Promise<InstallRunResponse>,
  };
}

const projectFiles = async (dir: string) => (await readdir(dir, { recursive: true })).map((f) => f.replace(/\\/gu, "/")).sort();

describe("v0.2.0 P0-3 PR C Desktop 설치 Client 선택", () => {
  it("install:options: Client별 지원·탐지·기본 선택·이 OS의 검증 수준(기록 없으면 not-recorded)을 돌려주고 계획·쓰기·실행이 없다", async () => {
    const w = await wired();
    expect(w.recommended).toContain("postgres-mcp");
    const r = await w.options("postgres-mcp", "C:/Windows/System32", { clients: ["codex"] });
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view).toMatchObject({ toolId: "postgres-mcp", platform: "linux", platformSupported: true, defaultScope: "project" });
    expect(r.view.clients.map((c) => [c.client, c.supported, c.detected, c.selected, c.verification])).toEqual([
      ["claude-code", true, true, true, "not-recorded"],
      ["codex", true, false, false, "not-recorded"],
      ["cursor", true, false, false, "not-recorded"],
    ]);
    expect(r.view.clients[1]!.note).toBe("이 프로젝트에서 탐지되지 않음 · Linux에서 이 Client의 OpenHub 실행 검증 기록 없음(Manifest에는 지원으로 적혀 있음)");
    expect(await projectFiles(w.project)).toEqual([".mcp.json", "package.json"]);
    expect(w.spawns).toEqual([]);
    expect(w.dialogs).toEqual([]);
    // 추천 목록에 없는 toolId·잘못된 인자는 거부한다.
    for (const bad of ["no-such-tool", 42, { toolId: "postgres-mcp" }]) expect((await w.options(bad)).status, String(bad)).toBe("not-recommended");
  });

  it("검토된 tool config 도구는 OS × Client 검증 수준을 Core(clientVerificationLevel)와 같은 값으로 보여 준다(Windows·Linux·macOS)", async () => {
    const k8s = { "package.json": '{ "name": "ops" }\n', ".mcp.json": '{ "mcpServers": {} }\n', "Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n", "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n" };
    const expected = {
      win32: ["launch-verified", "launch-verified", "not-verified"],
      linux: ["launch-verified", "launch-verified", "not-verified"],
      darwin: ["platform-unverified", "platform-unverified", "platform-unverified"],
    } as const;
    for (const platform of ["win32", "linux", "darwin"] as const) {
      const w = await wired({ files: k8s, platform });
      if (!w.recommended.includes("kubernetes-mcp-server")) throw new Error("kubernetes-mcp-server not recommended: " + w.recommended.join(","));
      const r = await w.options("kubernetes-mcp-server");
      if (r.status !== "ok") throw new Error(r.status);
      expect(r.view.clients.map((c) => c.verification), platform).toEqual(expected[platform]);
    }
  });

  it("고른 Client만 계획·설치한다: Codex만 → .codex/config.toml만 생기고 .mcp.json은 그대로다", async () => {
    const w = await wired();
    const before = await readFile(path.join(w.project, ".mcp.json"), "utf8");
    const plan = await w.plan("postgres-mcp", { clients: ["codex"] });
    if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
    expect(plan.view.targets.map((t) => [t.client, t.file, t.scope])).toEqual([["codex", ".codex/config.toml", "project"]]);
    const run = await w.run("postgres-mcp");
    if (run.status !== "done") throw new Error(run.status);
    expect(run.result.status).toBe("succeeded");
    expect(await readFile(path.join(w.project, ".mcp.json"), "utf8")).toBe(before);
    expect(await projectFiles(w.project)).toEqual([".codex", ".codex/config.toml", ".mcp.json", "package.json"]);
    expect(await readFile(path.join(w.project, ".codex", "config.toml"), "utf8")).toContain("[mcp_servers.");
  });

  it("탐지된 Client가 없는 프로젝트도 선택하면 설치할 수 있다(기본 선택은 비어 있고 선택 없이 계획하면 no-client)", async () => {
    const w = await wired({ files: { "package.json": '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n' } });
    const r = await w.options("postgres-mcp");
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.clients.every((c) => !c.detected && !c.selected)).toBe(true);
    expect(await w.plan("postgres-mcp")).toEqual({ status: "no-client" });
    expect(await w.plan("postgres-mcp", { clients: [] })).toEqual({ status: "no-client" });
    const plan = await w.plan("postgres-mcp", { clients: ["cursor", "claude-code", "cursor"] });
    if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
    expect(plan.view.targets.map((t) => t.client)).toEqual(["claude-code", "cursor"]);
  });

  it("잘못된 선택은 계획하지 않는다(허용 목록 밖·Manifest 미지원·배열 아님·과다). 경로·Plan 객체는 선택이 아니라 무시된다", async () => {
    const copy = path.join(scratch, "registry-copy");
    await cp(REGISTRY, copy, { recursive: true });
    const file = path.join(copy, "database", "postgres-mcp.yaml");
    await writeFile(file, (await readFile(file, "utf8")).replace("targets: [claude-code, codex, cursor]", "targets: [claude-code, codex]"));
    const w = await wired({ registryDir: copy });
    const r = await w.options("postgres-mcp");
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.clients.find((c) => c.client === "cursor")).toMatchObject({ supported: false, selected: false, note: "이 도구가 지원하지 않는 Client(Manifest targets)" });
    for (const bad of [{ clients: ["cursor"] }, { clients: ["vscode"] }, { clients: ["../x"] }, { clients: "codex" }, { clients: [1] }, { clients: Array(7).fill("codex") }]) {
      expect(await w.plan("postgres-mcp", bad), JSON.stringify(bad)).toMatchObject({ status: "error", code: "invalid-selection" });
      expect(await w.run("postgres-mcp")).toEqual({ status: "no-plan" });
    }
    // AC-036-01: 경로·Plan 객체는 Client 선택이 아니다(무시하고 기본 선택).
    const ignored = await w.plan("postgres-mcp", "C:/Windows/System32");
    expect(ignored.status === "ok" && ignored.view.targets.map((t) => t.client)).toEqual(["claude-code"]);
    const ignoredPlan = await w.plan("postgres-mcp", { plan: { steps: [] }, planDigest: "sha256:" + "0".repeat(64) });
    expect(ignoredPlan.status === "ok" && ignoredPlan.view.targets.map((t) => t.client)).toEqual(["claude-code"]);
    expect(w.spawns).toEqual([]);
    const supported = (c: InstallClient) => c !== "cursor";
    expect(parseClientSelection({ clients: ["codex", "claude-code"] }, supported, () => false)).toEqual({ ok: true, clients: ["claude-code", "codex"], scope: "project" });
    expect(parseClientSelection({ clients: null }, supported, () => false)).toEqual({ ok: false });
  });

  it("선택을 바꿔 다시 계획하면 마지막 계획만 실행된다(이전 계획은 승인·실행되지 않는다)", async () => {
    const w = await wired();
    await w.plan("postgres-mcp", { clients: ["claude-code"] });
    const second = await w.plan("postgres-mcp", { clients: ["cursor"] });
    expect(second.status === "ok" && second.view.targets.map((t) => t.file)).toEqual([".cursor/mcp.json"]);
    const run = await w.run("postgres-mcp");
    expect(run.status === "done" && run.result.status).toBe("succeeded");
    expect(await readFile(path.join(w.project, ".mcp.json"), "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(await projectFiles(w.project)).toContain(".cursor/mcp.json");
    expect(w.dialogs).toHaveLength(1);
  });

  it("English 모드: Client 설명이 영어이고 검증 수준 표현이 같은 의미다", async () => {
    setDesktopLocale("en");
    const w = await wired();
    const r = await w.options("postgres-mcp");
    if (r.status !== "ok") throw new Error(r.status);
    expect(r.view.clients.map((c) => c.note)).toEqual([
      "Detected in this project · No OpenHub run record for this client on Linux (the Manifest lists it as supported)",
      "Not detected in this project · No OpenHub run record for this client on Linux (the Manifest lists it as supported)",
      "Not detected in this project · No OpenHub run record for this client on Linux (the Manifest lists it as supported)",
    ]);
    for (const c of r.view.clients) expect(c.note).not.toMatch(HANGUL);
  });
});


describe("v0.2.0 P0-3 PR C 계획 일관성(main IPC 직접 호출)", () => {
  const onlyMcp = async (w: { project: string }) => (await readFile(path.join(w.project, ".mcp.json"), "utf8")) === '{ "mcpServers": {} }\n';

  it("정상 Plan A → 잘못된 Plan B → install:run은 no-plan이고 실행·쓰기가 0이다(이전 Plan 재사용 없음)", async () => {
    const w = await wired();
    expect((await w.plan("postgres-mcp", { clients: ["claude-code"] })).status).toBe("ok");
    expect(await w.plan("postgres-mcp", { clients: ["vscode"] })).toMatchObject({ status: "error", code: "invalid-selection" });
    expect(await w.run("postgres-mcp")).toEqual({ status: "no-plan" });
    expect(w.spawns).toEqual([]);
    expect(w.dialogs).toEqual([]);
    expect(await onlyMcp(w)).toBe(true);
    expect(await projectFiles(w.project)).toEqual([".mcp.json", "package.json"]);
  });

  it("Client 전체 해제(빈 선택)·선택 변경 알림(install:discard)·선택 화면 다시 열기·프로젝트 변경은 모두 이전 Plan을 실행할 수 없게 한다", async () => {
    const w = await wired();
    for (const invalidate of [
      () => w.plan("postgres-mcp", { clients: [] }),
      () => w.discard("postgres-mcp"),
      () => w.options("postgres-mcp"),
      () => w.switchProject({ "package.json": '{ "name": "other", "dependencies": { "pg": "^8.13.0" } }\n', ".mcp.json": '{ "mcpServers": {} }\n' }),
    ]) {
      expect((await w.plan("postgres-mcp", { clients: ["claude-code"] })).status).toBe("ok");
      await invalidate();
      expect(await w.run("postgres-mcp")).toEqual({ status: "no-plan" });
    }
    expect(w.spawns).toEqual([]);
    expect(w.dialogs).toEqual([]);
    expect(await w.discard(42)).toEqual({ status: "invalid" });
  });

  it("A 요청 → B 요청 → B 응답 → A 응답: A는 superseded이고 Pending Plan·실행은 B다", async () => {
    const w = await wired();
    const holdA = w.hold();
    const a = w.plan("postgres-mcp", { clients: ["claude-code"] });
    await holdA.arrived;
    const b = await w.plan("postgres-mcp", { clients: ["cursor"] });
    expect(b.status === "ok" && b.view.targets.map((t) => t.client)).toEqual(["cursor"]);
    holdA.release();
    expect(await a).toEqual({ status: "superseded" });
    const run = await w.run("postgres-mcp");
    expect(run.status === "done" && run.result.status).toBe("succeeded");
    expect(await onlyMcp(w)).toBe(true);
    expect(await projectFiles(w.project)).toEqual([".cursor", ".cursor/mcp.json", ".mcp.json", "package.json"]);
  });

  it("A 요청 → 프로젝트 변경 → A 응답: 이전 프로젝트 Plan은 기억되지 않고 실행할 수 없다", async () => {
    const w = await wired();
    const holdA = w.hold();
    const a = w.plan("postgres-mcp", { clients: ["claude-code"] });
    await holdA.arrived;
    const other = await w.switchProject({ "package.json": '{ "name": "other", "dependencies": { "pg": "^8.13.0" } }\n', ".mcp.json": '{ "mcpServers": {} }\n' });
    holdA.release();
    expect(await a).toEqual({ status: "superseded" });
    expect(await w.run("postgres-mcp")).toEqual({ status: "no-plan" });
    expect(await onlyMcp(w)).toBe(true);
    expect(await readFile(path.join(other, ".mcp.json"), "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(w.spawns).toEqual([]);
  });

  it("A Plan 승인 대화상자가 열린 동안 Client 선택을 바꾸면(새 계획·discard) 받은 승인으로 실행하지 않는다", async () => {
    for (const during of [
      async (call: (channel: string, ...args: unknown[]) => unknown) => void (await call(INSTALL_DISCARD_CHANNEL, "postgres-mcp")),
      async (call: (channel: string, ...args: unknown[]) => unknown) => void (await call(INSTALL_PLAN_CHANNEL, "postgres-mcp", { clients: ["cursor"] })),
    ]) {
      const w = await wired({ duringDialog: during });
      expect((await w.plan("postgres-mcp", { clients: ["claude-code"] })).status).toBe("ok");
      const r = await w.run("postgres-mcp");
      expect(r.status).toBe("plan-changed");
      expect(w.dialogs).toHaveLength(1);
      expect(w.spawns).toEqual([]);
      expect(await onlyMcp(w)).toBe(true);
      expect((await projectFiles(w.project)).filter((f) => f.startsWith(".cursor"))).toEqual([]);
    }
  });
});

