import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { analyzeProject, loadMetadataSnapshot, loadRegistry, readLifecycleState, recommend, toolConfigLocation, projectKeyFromRealpath, type BackendProbeReport, type HealthRunReport } from "@openhub/core";
import { realpath } from "node:fs/promises";
import { setDesktopLocale } from "../src/i18n/index";
import { en } from "../src/i18n/en";
import { ko } from "../src/i18n/ko";
import { INSTALL_OPTIONS_CHANNEL, INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, registerInstall, type InstallOptionsResponse, type InstallPlanResponse, type InstallRunResponse, type NativeDialogLike } from "../src/install";
import { LIFECYCLE_PLAN_CHANNELS, LIFECYCLE_RUN_CHANNEL, LIFECYCLE_STATUS_CHANNEL, LifecycleSession, registerLifecycle, type LifecyclePlanResponse, type LifecycleRunResponse, type LifecycleStatusResponse } from "../src/lifecycle";
import { PROJECT_SCAN_CHANNEL, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend, type RecommendResponse } from "../src/recommend";
import { fakeNpmSpawner } from "../../../packages/core/test/process/fake-npm";

/**
 * v0.2.0 범위별 설치 × Desktop 추가 설치 진입점. 이 프로젝트에서 이미 쓰고 있어 Core가 추천에서 제외한(installed) 도구를
 * 다른 Client·범위에 추가한다. main IPC를 그대로 부른다(실제 Core Plan·승인 kernel·파일 쓰기, 임시 project·home).
 * npm은 가짜(npx Prepare 캐시 계약), Health는 주입(실제 MCP Health는 Core Kubernetes E2E에서 따로 본다). network 0.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const REGISTRY = path.join(ROOT, "registry");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-add-elsewhere-"));
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
const PROJECT_FILES: Record<string, string> = {
  "package.json": '{ "name": "ops", "dependencies": { "pg": "^8.13.0" } }\n',
  ".mcp.json": '{ "mcpServers": {} }\n',
  "Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n",
  "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
};
const CURSOR_USER = '{\n  "theme": "dark",\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
const CODEX_USER = '# my codex settings\nmodel = "o4"\n\n[mcp_servers.notes]\ncommand = "uvx"\nargs = ["notes-mcp==1.0.0"]\n';

async function wired(o: { dialog?: () => number } = {}) {
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
  const dialog: NativeDialogLike = { showMessageBox: async (x) => (dialogs.push({ title: x.title, detail: x.detail }), { response: o.dialog?.() ?? 1 }) };
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
  registerLifecycle(ipc, new LifecycleSession(() => is.projectDir), {
    registryDir: REGISTRY,
    platform: "linux",
    homeDir: home,
    dialog,
    probe: async () => PROBES,
    spawner: npm.spawner as never,
    tempBase: base,
    runHealth: async (verified) => (healthRuns.push(verified.plan.targets.map((t) => t.scope + ":" + t.client).join(",")), healthy),
    now: () => new Date("2026-10-11T00:00:00.000Z"),
  });
  const call = (channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args);
  const scan = async (dir: string) => {
    pick = dir;
    await call(PROJECT_SCAN_CHANNEL);
    return (await call(PROJECT_RECOMMEND_CHANNEL)) as RecommendResponse;
  };
  await scan(projectA);
  const p = (rel: string) => path.join(projectA, rel);
  return {
    base,
    home,
    projectA,
    projectB,
    dialogs,
    healthRuns,
    scan,
    options: (...a: unknown[]) => call(INSTALL_OPTIONS_CHANNEL, ...a) as Promise<InstallOptionsResponse>,
    plan: (...a: unknown[]) => call(INSTALL_PLAN_CHANNEL, ...a) as Promise<InstallPlanResponse>,
    install: (...a: unknown[]) => call(INSTALL_RUN_CHANNEL, ...a) as Promise<InstallRunResponse>,
    status: (...a: unknown[]) => call(LIFECYCLE_STATUS_CHANNEL, ...a) as Promise<LifecycleStatusResponse>,
    lifePlan: (op: keyof typeof LIFECYCLE_PLAN_CHANNELS, id: string) => call(LIFECYCLE_PLAN_CHANNELS[op], id) as Promise<LifecyclePlanResponse>,
    lifeRun: (id: string) => call(LIFECYCLE_RUN_CHANNEL, id) as Promise<LifecycleRunResponse>,
    readProject: (rel: string) => readFile(p(rel), "utf8").catch(() => null),
    readHome: (rel: string) => readFile(path.join(home, rel), "utf8").catch(() => null),
    projectToolConfig: async () => toolConfigLocation({ homeDir: home, scope: "project", toolId: K8S, projectKey: projectKeyFromRealpath(await realpath(projectA)) })!.file,
  };
}
type W = Awaited<ReturnType<typeof wired>>;

/** Cursor 프로젝트에 Kubernetes를 설치(일반 추천 경로)하고 프로젝트를 다시 분석한다. 이후 Kubernetes는 "이미 사용 중"으로 추천에서 빠진다. */
async function cursorProjectInstalled(w: W) {
  const plan = await w.plan(K8S, { clients: ["cursor"], scope: "project" });
  expect(plan.status).toBe("ok");
  const run = await w.install(K8S);
  expect(run.status === "done" && run.result.status).toBe("succeeded");
  const again = await w.scan(w.projectA);
  if (again.status !== "ok") throw new Error(again.status);
  return again.view;
}
describe("v0.2.0 Desktop 추가 설치 진입점(이미 사용 중인 도구 → 다른 Client·범위)", () => {
  it("B·M: 설치 뒤 도구는 추천에서 빠지고 '이미 사용 중'으로 제외 목록에 있으며 추가 가능 표시가 붙는다. 추천 목록·점수는 Core 보고서와 같다", async () => {
    setDesktopLocale("en");
    const w = await wired();
    const before = await w.scan(w.projectA);
    expect(before.status === "ok" && before.view.items.map((i) => i.toolId)).toContain(K8S);
    const view = await cursorProjectInstalled(w);
    expect(view.items.map((i) => i.toolId)).not.toContain(K8S);
    const row = view.diagnosis?.excluded.find((x) => x.toolId === K8S);
    expect(row).toMatchObject({ codes: ["installed"], addable: true });
    expect(row?.text).toContain(en["forYou.exclusion.installed"]);
    // M: 화면 목록·순서·점수 = 같은 Profile로 만든 Core 보고서(추가 설치 진입점이 점수를 바꾸지 않는다).
    const a = await analyzeProject(w.projectA);
    if (!a.ok) throw new Error("analysis");
    const report = recommend(a.profile, (await loadRegistry(REGISTRY)).entries, await loadMetadataSnapshot(SEED_SNAPSHOT), { platform: "linux" });
    expect(view.items.map((i) => [i.toolId, i.projectFit, i.openScore])).toEqual(report.recommendations.map((r) => [r.toolId, r.projectFit.score === null ? "—" : r.projectFit.score.toFixed(2), r.openScore.score === null ? "—" : r.openScore.score.toFixed(2)]));
    // 옵션·계획 호출은 추천을 바꾸지 않는다.
    await w.options(K8S);
    await w.plan(K8S, { clients: ["codex"], scope: "project" });
    const after = await w.scan(w.projectA);
    expect(after.status === "ok" && after.view.items.map((i) => [i.toolId, i.projectFit])).toEqual(view.items.map((i) => [i.toolId, i.projectFit]));
  });

  it("Main 검증: 추천 목록·installed 후보가 아닌 toolId(스택 불일치·후보 아님·Registry에 없음)는 options·plan 모두 not-recommended", async () => {
    const w = await wired();
    await cursorProjectInstalled(w);
    for (const id of ["mongodb-mcp-server", "github-mcp-server", "no-such-tool", 42, null]) {
      expect((await w.options(id)).status, String(id)).toBe("not-recommended");
      expect((await w.plan(id, { clients: ["codex"], scope: "project" })).status, String(id)).toBe("not-recommended");
    }
  });

  it("C·G·N: Cursor 프로젝트 설치됨 → Cursor 사용자 범위 추가(user-scope-config 승인), 프로젝트·다른 사용자 설정은 byte 그대로", async () => {
    const w = await wired();
    await cursorProjectInstalled(w);
    const opts = await w.options(K8S);
    if (opts.status !== "ok") throw new Error(opts.status);
    expect(opts.view.entry).toBe("installed-elsewhere");
    expect(opts.view.clients.every((c) => !c.selected)).toBe(true);
    const projectCursor = await w.readProject(".cursor/mcp.json");
    const plan = await w.plan(K8S, { clients: ["cursor"], scope: "user" });
    if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
    expect(plan.view.targets.map((t) => [t.client, t.scope, t.change])).toEqual([["cursor", "user", "add"]]);
    expect(plan.view.requirements.map((r) => r.id)).toContain("user-scope-config");
    const run = await w.install(K8S);
    expect(run.status === "done" && run.result.status).toBe("succeeded");
    expect(w.dialogs.at(-1)?.detail).toContain("~/.cursor/mcp.json");
    const userCursor = JSON.parse((await w.readHome(".cursor/mcp.json"))!);
    expect(Object.keys(userCursor.mcpServers).sort()).toEqual(["kubernetes", "notes"]);
    expect(userCursor.theme).toBe("dark");
    expect(await w.readProject(".cursor/mcp.json")).toBe(projectCursor);
    expect(await w.readHome(".codex/config.toml")).toBe(CODEX_USER);
  });

  it("D·N·K: Cursor 프로젝트 설치됨 → Codex 프로젝트 추가, 기존 Cursor 항목·Version State 보존, 추가 뒤 Status·Health·Repair", async () => {
    const w = await wired();
    await cursorProjectInstalled(w);
    const cursorBytes = await w.readProject(".cursor/mcp.json");
    const before = await readLifecycleState({ homeDir: w.home });
    if (!before.ok) throw new Error(before.code);
    const cursorState = Object.values(before.state.entries).find((e) => e.target.client === "cursor");
    const plan = await w.plan(K8S, { clients: ["codex"], scope: "project" });
    if (plan.status !== "ok") throw new Error(JSON.stringify(plan));
    expect(plan.view.targets.map((t) => [t.client, t.change])).toEqual([["codex", "add"]]);
    expect(plan.view.requirements.map((r) => r.id)).not.toContain("user-scope-config");
    const run = await w.install(K8S);
    expect(run.status === "done" && run.result.status).toBe("succeeded");
    expect(await w.readProject(".cursor/mcp.json")).toBe(cursorBytes);
    expect(await w.readProject(".codex/config.toml")).toContain("[mcp_servers.kubernetes]");
    const after = await readLifecycleState({ homeDir: w.home });
    if (!after.ok) throw new Error(after.code);
    expect(Object.values(after.state.entries).find((e) => e.target.client === "cursor")).toEqual(cursorState);
    // K: Status·Health·Repair
    const s = await w.status();
    if (s.status !== "ok") throw new Error(s.status);
    expect(s.items.filter((i) => i.toolId === K8S).map((i) => [i.id, i.state])).toEqual([
      ["project:codex:kubernetes", "state-consistent"],
      ["project:cursor:kubernetes", "state-consistent"],
    ]);
    expect((await w.lifePlan("health", "project:codex:kubernetes")).status).toBe("ok");
    expect(await w.lifeRun("project:codex:kubernetes")).toMatchObject({ status: "done", result: { status: "health-checked" } });
    expect(w.healthRuns).toEqual(["project:codex"]);
    await unlink(await w.projectToolConfig());
    const broken = await w.status();
    if (broken.status !== "ok") throw new Error(broken.status);
    expect(broken.items.find((i) => i.id === "project:codex:kubernetes")).toMatchObject({ state: "tool-config-missing", canRepair: true });
    // tool config가 없는 동안 같은 대상 재설치 요청은 "변경 없음"이 아니라 막힌다(PR #20).
    const blocked = await w.plan(K8S, { clients: ["cursor"], scope: "project" });
    expect(blocked.status === "ok" && [blocked.view.status, blocked.view.alreadyInstalled]).toEqual(["blocked", false]);
    expect((await w.lifePlan("repair", "project:codex:kubernetes")).status).toBe("ok");
    expect(await w.lifeRun("project:codex:kubernetes")).toMatchObject({ status: "done", result: { status: "repaired" } });
    const fixed = await w.status();
    expect(fixed.status === "ok" && fixed.items.filter((i) => i.toolId === K8S).map((i) => i.state)).toEqual(["state-consistent", "state-consistent"]);
  });

  it("E·F: 같은 대상 재요청은 변경 없음(no-op, 쓰기 0), 같은 이름의 다른 설정은 충돌(실행 불가, 덮어쓰지 않음)", async () => {
    const w = await wired();
    await cursorProjectInstalled(w);
    const same = await w.plan(K8S, { clients: ["cursor"], scope: "project" });
    if (same.status !== "ok") throw new Error(JSON.stringify(same));
    expect([same.view.alreadyInstalled, same.view.executable, same.view.targets.map((t) => t.change)]).toEqual([true, false, ["unchanged"]]);
    const stateBefore = JSON.stringify(await readLifecycleState({ homeDir: w.home }));
    const cursorBytes = await w.readProject(".cursor/mcp.json");
    const noop = await w.install(K8S);
    expect(noop.status === "done" && noop.result.status).toBe("no-op");
    expect(await w.readProject(".cursor/mcp.json")).toBe(cursorBytes);
    expect(JSON.stringify(await readLifecycleState({ homeDir: w.home }))).toBe(stateBefore);
    const mine = '{ "mcpServers": { "kubernetes": { "command": "npx", "args": ["-y", "kubernetes-mcp-server@0.0.67"] } } }\n';
    await writeFile(path.join(w.projectA, ".mcp.json"), mine);
    const conflict = await w.plan(K8S, { clients: ["claude-code"], scope: "project" });
    if (conflict.status !== "ok") throw new Error(JSON.stringify(conflict));
    expect([conflict.view.status, conflict.view.executable, conflict.view.targets.map((t) => t.change)]).toEqual(["blocked", false, ["conflict"]]);
    // 막힌 Plan은 승인할 수 없다: 네이티브 대화상자를 열지 않고 실행·쓰기 0.
    const dialogsBefore = w.dialogs.length;
    expect(await w.install(K8S)).toEqual({ status: "rejected" });
    expect(w.dialogs.length).toBe(dialogsBefore);
    expect(await w.readProject(".mcp.json")).toBe(mine);
  });

  it("H: 승인 거절은 쓰기 0", async () => {
    let answer = 1;
    const w = await wired({ dialog: () => answer });
    await cursorProjectInstalled(w);
    answer = 0;
    expect((await w.plan(K8S, { clients: ["codex"], scope: "user" })).status).toBe("ok");
    expect(await w.install(K8S)).toEqual({ status: "rejected" });
    expect(await w.readHome(".codex/config.toml")).toBe(CODEX_USER);
  });

  it("I: 계획 뒤 대상 파일이 바뀌면 PLAN_STALE이고 바뀐 내용을 덮어쓰지 않는다", async () => {
    const w = await wired();
    await cursorProjectInstalled(w);
    expect((await w.plan(K8S, { clients: ["codex"], scope: "user" })).status).toBe("ok");
    const external = CODEX_USER + "\n[mcp_servers.extra]\ncommand = \"uvx\"\nargs = [\"extra==1.0.0\"]\n";
    await writeFile(path.join(w.home, ".codex", "config.toml"), external);
    const run = await w.install(K8S);
    expect(run.status === "done" && [run.result.status, run.result.reapprove]).toEqual(["stale", true]);
    expect(await w.readHome(".codex/config.toml")).toBe(external);
  });

  it("J: 프로젝트를 바꾸면 이전 프로젝트의 추가 설치 계획은 실행되지 않는다", async () => {
    const w = await wired();
    await cursorProjectInstalled(w);
    expect((await w.plan(K8S, { clients: ["codex"], scope: "project" })).status).toBe("ok");
    await w.scan(w.projectB);
    expect((await w.install(K8S)).status).toBe("no-plan");
    expect(await w.readProject(".codex/config.toml")).toBeNull();
  });

  it("L: 추가 설치 안내·제외 사유 문구가 영어·한국어로 있고 영어에는 한글이 없다", async () => {
    for (const [locale, cat] of [["en", en], ["ko", ko]] as const) {
      setDesktopLocale(locale);
      const w = await wired();
      const view = await cursorProjectInstalled(w);
      expect(view.diagnosis?.excluded.find((x) => x.toolId === K8S)?.text).toContain(cat["forYou.exclusion.installed"]);
      expect(cat["install.clients.addElsewhere"]).toBeTruthy();
      expect(cat["forYou.addElsewhere"]).toBeTruthy();
    }
    for (const k of ["install.clients.addElsewhere", "forYou.addElsewhere", "forYou.exclusion.installed"] as const) expect(en[k]).not.toMatch(/[\uac00-\ud7a3]/u);
  });
});

