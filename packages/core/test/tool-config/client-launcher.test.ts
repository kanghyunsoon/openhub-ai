import { readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  clientLauncherDigest,
  containsAbsolutePath,
  formatLifecyclePlanPreview,
  formatLifecycleStatusItem,
  inspectRecordedLauncher,
  lifecycleStatus,
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type ClientLauncher,
  type LauncherCheckFs,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { fakeNpmSpawner } from "../process/fake-npm";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";

/**
 * v0.2.0 client-launcher-invalid·launcher repair. Windows Client 직접 실행(node.exe + npx-cli.js) 경로를 메모리 가짜 Windows
 * 파일 시스템으로 흉내 낸다(어느 OS에서도 같게 돈다). Client 설정·tool config·Version State는 실제 임시 파일이다. network 0, 실제 실행 0.
 */
const scratch = await newScratch("client-launcher");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const entries: RegistryEntry[] = await seedEntries();
const K8S = "kubernetes-mcp-server";
const CLIENTS = (["claude-code", "codex", "cursor"] as const).map((client) => ({ client, scope: "project" as const }));
const FILES = { "claude-code": ".mcp.json", cursor: path.join(".cursor", "mcp.json"), codex: path.join(".codex", "config.toml") } as const;

type Kind = "dir" | "file" | "link";
/** Windows 경로(대소문자 무시)를 키로 쓰는 읽기 전용 가짜 fs. lstat·readFile만 있다(검사는 실행하지 않는다). */
class FakeWindowsFs {
  readonly nodes = new Map<string, { kind: Kind; data: string }>();
  readonly denied = new Set<string>();
  readonly calls: string[] = [];
  private key = (p: string) => path.win32.normalize(p).toLowerCase();
  private parents(p: string) {
    const parts = path.win32.normalize(p).split("\\");
    for (let i = 2; i < parts.length; i++) {
      const k = this.key(parts.slice(0, i).join("\\"));
      if (!this.nodes.has(k)) this.nodes.set(k, { kind: "dir", data: "" });
    }
  }
  file(p: string, data = "") {
    this.parents(p);
    this.nodes.set(this.key(p), { kind: "file", data });
  }
  link(p: string) {
    this.parents(p);
    this.nodes.set(this.key(p), { kind: "link", data: "" });
  }
  remove(p: string) {
    const k = this.key(p);
    for (const key of [...this.nodes.keys()]) if (key === k || key.startsWith(k + "\\")) this.nodes.delete(key);
  }
  /** node.exe와 같은 디렉터리의 npm(공식 Windows 설치 구조). */
  install(dir: string, npmName = "npm"): ClientLauncher {
    const node = path.win32.join(dir, "node.exe");
    const npxCli = path.win32.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
    this.file(node, "MZ");
    this.file(npxCli, "#!/usr/bin/env node");
    this.file(path.win32.join(dir, "node_modules", "npm", "package.json"), JSON.stringify({ name: npmName }));
    return { node, npxCli };
  }
  readonly fs: LauncherCheckFs = {
    lstat: async (p) => {
      this.calls.push("lstat");
      if (this.denied.has(this.key(p))) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      const n = this.nodes.get(this.key(p));
      if (n === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isSymbolicLink: () => n.kind === "link", isDirectory: () => n.kind === "dir", isFile: () => n.kind === "file" };
    },
    readFile: async (p) => {
      this.calls.push("readFile");
      const n = this.nodes.get(this.key(p));
      if (n === undefined || n.kind !== "file") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from(n.data, "utf8");
    },
  };
}

const NODE_A = "C:\\Users\\Kim Dev\\AppData\\Local\\Programs\\nodejs";
const NODE_B = "C:\\Program Files\\nodejs";
const healthy = { ok: true as const, result: { status: "healthy" as const, reason: null, toolCount: 13, environmentUnverified: false, terminated: true, excerpt: null } };

interface Ctx {
  h: Harness;
  win: FakeWindowsFs;
  /** 지금 PATH에서 찾을 Node.js(바꾸면 다음 탐색부터 반영). */
  current: { launcher: ClientLauncher | null };
  a: ClientLauncher;
}

async function installedOnWindows(dir = NODE_A): Promise<Ctx> {
  const h = await createHarness(scratch, { entries });
  const win = new FakeWindowsFs();
  const a = win.install(dir);
  const current = { launcher: a as ClientLauncher | null };
  const request = { ...h.request(K8S, CLIENTS), platform: "windows" as const };
  const env = { ...h.env, windowsNpx: async () => current.launcher, launcherCheckFs: win.fs };
  const planned = await plannedOf(h, request);
  const result = await runInstallTransaction(planned, await approveAll(planned), request, env);
  expect(result.status, JSON.stringify(result.steps)).toBe("succeeded");
  const recorded = await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
  expect(recorded).toEqual({ ok: true, recorded: 3 });
  return { h, win, current, a };
}

function lifecycleEnv(c: Ctx, over: Partial<LifecycleEnvironment> = {}): LifecycleEnvironment {
  return {
    loadEntries: async () => entries,
    probe: c.h.env.probe,
    tempBase: os.tmpdir(),
    now: () => new Date("2026-10-10T00:00:00.000Z"),
    spawner: fakeNpmSpawner({ cacheRoot: path.join(c.h.base, "npm-cache") }).spawner,
    windowsNpx: async () => c.current.launcher,
    launcherCheckFs: c.win.fs,
    runHealth: async () => healthy,
    ...over,
  };
}

async function plan(c: Ctx, operation: LifecycleRequest["operation"], over: Partial<LifecycleEnvironment> = {}) {
  const request: LifecycleRequest = { operation, toolId: K8S, projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, platform: "windows", includeUser: false };
  const env = lifecycleEnv(c, over);
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) throw new Error(built.code + " " + built.message);
  return { request, env, planned: built.planned };
}

async function approve(planned: Awaited<ReturnType<typeof plan>>["planned"]) {
  const outcome = await requestLifecycleApproval(planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  return outcome.approval;
}

async function status(c: Ctx) {
  const s = await lifecycleStatus({ projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, entries, platform: "windows", includeUser: false, launcherCheckFs: c.win.fs });
  if (!s.ok) throw new Error(s.code);
  return s.items.filter((i) => i.serverName === "kubernetes");
}
const states = async (c: Ctx) => (await status(c)).map((i) => i.client + ":" + i.state);
const clientBytes = async (c: Ctx) => Promise.all((Object.keys(FILES) as (keyof typeof FILES)[]).map((k) => readFile(path.join(c.h.projectRoot, FILES[k]), "utf8")));

describe("v0.2.0 client launcher 검사(inspectRecordedLauncher, 실행 없음)", () => {
  const entry = (l: ClientLauncher) => ({ command: l.node, args: [l.npxCli, "-y", "kubernetes-mcp-server@0.0.67"] });

  it("정상 Node 경로와 공백·한글·괄호·& 사용자 경로는 유효하다", async () => {
    const win = new FakeWindowsFs();
    for (const dir of [NODE_A, "C:\\Users\\홍길동\\AppData\\Roaming\\nvm\\v24.1.0", "C:\\Program Files (x86)\\nodejs", "C:\\Users\\R&D Team\\nodejs"]) {
      expect(await inspectRecordedLauncher(entry(win.install(dir)), win.fs), dir).toEqual({ ok: true });
    }
  });

  it("node.exe 삭제, npx-cli.js 삭제, npm package.json 이상, 권한 부족이면 무효다", async () => {
    const win = new FakeWindowsFs();
    const l = win.install(NODE_A);
    win.remove(l.node);
    expect(await inspectRecordedLauncher(entry(l), win.fs)).toMatchObject({ ok: false });
    win.install(NODE_A);
    win.remove(l.npxCli);
    expect(await inspectRecordedLauncher(entry(l), win.fs)).toMatchObject({ ok: false });
    win.install(NODE_A, "not-npm");
    expect(await inspectRecordedLauncher(entry(l), win.fs)).toEqual({ ok: false, reason: "npx-cli.js가 npm 패키지에 속하지 않습니다" });
    win.install(NODE_A);
    win.denied.add(path.win32.join(NODE_A, "node_modules").toLowerCase());
    expect(await inspectRecordedLauncher(entry(l), win.fs)).toEqual({ ok: false, reason: "실행 경로를 확인하지 못했습니다" });
  });

  it("같은 위치에 재설치하면 유효하고, 다른 위치로 재설치·npm 경로 변경이면 무효다", async () => {
    const win = new FakeWindowsFs();
    const l = win.install(NODE_A);
    win.remove(NODE_A);
    win.install(NODE_A);
    expect(await inspectRecordedLauncher(entry(l), win.fs)).toEqual({ ok: true });
    win.remove(NODE_A);
    win.install(NODE_B);
    expect(await inspectRecordedLauncher(entry(l), win.fs)).toMatchObject({ ok: false });
    // npm만 다른 위치(전역 prefix 변경): node.exe와 같은 설치의 npm이 아니다.
    const other = win.install("D:\\npm-global");
    expect(await inspectRecordedLauncher({ command: win.install(NODE_B).node, args: [other.npxCli] }, win.fs)).toEqual({ ok: false, reason: "npx-cli.js가 node.exe와 같은 설치의 npm이 아닙니다" });
  });

  it("경로 중간의 symlink·junction, 직접 실행 형식이 아닌 항목은 무효다. reason에는 경로가 없다", async () => {
    const win = new FakeWindowsFs();
    const l = win.install(NODE_A);
    win.link("C:\\Users\\Kim Dev\\AppData");
    const linked = await inspectRecordedLauncher(entry(l), win.fs);
    expect(linked).toEqual({ ok: false, reason: "실행 경로에 symlink·junction이 있습니다" });
    expect(await inspectRecordedLauncher({ command: "cmd", args: ["/d", "/c", "npx"] }, win.fs)).toMatchObject({ ok: false });
    expect(containsAbsolutePath(JSON.stringify(linked))).toBe(false);
  });
});

describe("v0.2.0 lifecycle status: client-launcher-invalid", () => {
  it("정상 설치는 state-consistent이고 launcher 필드가 없다(기존 응답 그대로)", async () => {
    const c = await installedOnWindows();
    const items = await status(c);
    expect(items.map((i) => i.client + ":" + i.state)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
    for (const i of items) {
      expect(i.launcher).toBeUndefined();
      expect(i.diagnostics).toBeUndefined();
    }
  });

  it("Node.js를 지우거나 옮기면 설정 byte가 같아도 client-launcher-invalid이고, 설정은 바꾸지 않으며 Report에 절대 경로가 없다", async () => {
    const c = await installedOnWindows("C:\\Users\\홍 길동 (R&D)\\nodejs");
    const before = await clientBytes(c);
    c.win.remove("C:\\Users\\홍 길동 (R&D)\\nodejs");
    const items = await status(c);
    expect(items.map((i) => i.client + ":" + i.state)).toEqual(["claude-code:client-launcher-invalid", "codex:client-launcher-invalid", "cursor:client-launcher-invalid"]);
    expect(items[0]!.launcher).toEqual({ status: "invalid", reason: "실행 경로를 확인하지 못했습니다" });
    expect(containsAbsolutePath(JSON.stringify(items))).toBe(false);
    expect(formatLifecycleStatusItem(items[0]!).join("\n")).toContain("client-launcher-invalid");
    expect(await clientBytes(c)).toEqual(before);
  });

  it("여러 문제가 함께 있으면 중대한 쪽이 state이고 diagnostics에 전부 남는다(실행 경로 문제가 보안 정책 변경을 가리지 않는다)", async () => {
    const c = await installedOnWindows();
    c.win.remove(NODE_A);
    const loc = (await readFile(path.join(c.h.projectRoot, FILES["claude-code"]), "utf8")).match(/"--config",\s*"([^"]+)"/u)![1]!.replace(/\\\\/gu, "\\");
    await writeFile(loc, "read_only = false\n");
    const items = await status(c);
    expect(items.map((i) => i.state)).toEqual(["tool-config-drift", "tool-config-drift", "tool-config-drift"]);
    expect(items[0]!.diagnostics).toEqual(["tool-config-drift", "client-launcher-invalid"]);
    // Client 설정의 보안 플래그 변경 + 실행 경로 무효 → config-drift가 먼저다.
    const mcp = path.join(c.h.projectRoot, FILES["claude-code"]);
    await writeFile(mcp, (await readFile(mcp, "utf8")).replace('"--read-only"', '"--log-level"'));
    const claude = (await status(c)).find((i) => i.client === "claude-code")!;
    expect(claude.state).toBe("config-drift");
    expect(claude.diagnostics).toEqual(["config-drift", "tool-config-drift", "client-launcher-invalid"]);
  });

  it("일반 npx Tool(cmd 래퍼)과 Linux 플랫폼은 실행 경로를 검사하지 않는다(기존 판정 그대로)", async () => {
    const h = await createHarness(scratch, { entries });
    const win = new FakeWindowsFs();
    const request = { ...h.request("memory-mcp", CLIENTS), platform: "windows" as const };
    const planned = await plannedOf(h, request);
    const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
    const s = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "windows", includeUser: false, launcherCheckFs: win.fs });
    expect(s.ok && s.items.map((i) => i.state)).toEqual(["state-consistent", "state-consistent", "state-consistent"]);
    expect(win.calls).toEqual([]);
    const c = await installedOnWindows();
    c.win.remove(NODE_A);
    const linux = await lifecycleStatus({ projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, entries, platform: "linux", includeUser: false, launcherCheckFs: c.win.fs });
    expect(linux.ok && linux.items.filter((i) => i.serverName === "kubernetes").every((i) => i.launcher === undefined)).toBe(true);
  });
});

describe("v0.2.0 launcher repair(승인 필수)", () => {
  async function moved(): Promise<Ctx & { b: ClientLauncher }> {
    const c = await installedOnWindows();
    c.win.remove(NODE_A);
    const b = c.win.install(NODE_B);
    c.current.launcher = b;
    return { ...c, b };
  }

  it("Health는 막는다(CLIENT_LAUNCHER_INVALID). Plan은 경로 대신 digest만 갖는다", async () => {
    const c = await moved();
    const health = await plan(c, "health");
    expect(health.planned.plan.status).toBe("blocked");
    expect(health.planned.plan.warnings.map((w) => w.code)).toContain("CLIENT_LAUNCHER_INVALID");
    const repair = await plan(c, "repair");
    expect(repair.planned.plan.status).toBe("ready");
    expect(repair.planned.plan.targets.map((t) => t.launcher)).toEqual(Array(3).fill({ recorded: "invalid", replacementDigest: clientLauncherDigest(c.b) }));
    expect(repair.planned.plan.approvalRequirements).toContain("health-execution");
    expect(containsAbsolutePath(JSON.stringify(repair.planned.plan))).toBe(false);
    const preview = formatLifecyclePlanPreview(repair.planned).join("\n");
    expect(preview).toContain("client-launcher-invalid");
    expect(preview).toContain("실행 경로만 다시 씁니다");
    expect(containsAbsolutePath(preview)).toBe(false);
  });

  it("승인 → 새 실행 경로 검증 → 실행 경로만 교체 → Health → Version State. 다른 MCP 항목·사용자 TOML은 그대로이고 이후 state-consistent다", async () => {
    const c = await moved();
    const codex = path.join(c.h.projectRoot, FILES.codex);
    const userToml = '\n[mcp_servers.other]\ncommand = "uvx"\nargs = ["other-mcp"]\n';
    await writeFile(codex, (await readFile(codex, "utf8")) + userToml);
    const before = await clientBytes(c);
    const r = await plan(c, "repair");
    const result = await runLifecycleTransaction(r.planned, await approve(r.planned), r.request, r.env);
    expect(result, JSON.stringify(result.steps)).toMatchObject({ status: "repaired", stateCommitted: true });
    expect(await states(c)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
    const after = await clientBytes(c);
    after.forEach((text, i) => {
      expect(text).toContain(JSON.stringify(c.b.node));
      expect(text).toContain(JSON.stringify(c.b.npxCli));
      expect(text).not.toContain(JSON.stringify(c.a.node));
      // 실행 경로 두 개 말고는 같다.
      expect(text.split(JSON.stringify(c.b.node)).join("N").split(JSON.stringify(c.b.npxCli)).join("X")).toBe(before[i]!.split(JSON.stringify(c.a.node)).join("N").split(JSON.stringify(c.a.npxCli)).join("X"));
    });
    // clientBytes 순서: claude-code, cursor, codex.
    expect(after[2]!.endsWith(userToml)).toBe(true);
  });

  it("승인 거절이면 아무것도 쓰지 않는다", async () => {
    const c = await moved();
    const before = await clientBytes(c);
    const r = await plan(c, "repair");
    const outcome = await requestLifecycleApproval(r.planned, { channel: "cli-tty", confirm: async () => [] });
    expect(outcome.status).not.toBe("approved");
    const result = await runLifecycleTransaction(r.planned, undefined, r.request, r.env);
    expect(result.status).toBe("approval-required");
    expect(await clientBytes(c)).toEqual(before);
    expect(await states(c)).toEqual(["claude-code:client-launcher-invalid", "codex:client-launcher-invalid", "cursor:client-launcher-invalid"]);
  });

  it("승인 뒤 Node.js 설치가 다시 바뀌면(새 경로·기록 경로 복구) PLAN_STALE이고 아무것도 쓰지 않는다", async () => {
    const c = await moved();
    const before = await clientBytes(c);
    const r = await plan(c, "repair");
    const approval = await approve(r.planned);
    c.current.launcher = c.win.install("C:\\nodejs-24");
    expect(await runLifecycleTransaction(r.planned, approval, r.request, r.env)).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(await clientBytes(c)).toEqual(before);
    const d = await moved();
    const r2 = await plan(d, "repair");
    const approval2 = await approve(r2.planned);
    d.win.install(NODE_A);
    expect(await runLifecycleTransaction(r2.planned, approval2, r2.request, r2.env)).toMatchObject({ status: "stale", code: "PLAN_STALE" });
  });

  it("실행 직전 탐색 결과가 승인한 digest와 다르면(재생성 뒤 변경) 쓰지 않고 PLAN_STALE이다", async () => {
    const c = await moved();
    const before = await clientBytes(c);
    const r = await plan(c, "repair");
    const approval = await approve(r.planned);
    let calls = 0;
    const other = c.win.install("C:\\nodejs-other");
    const env = lifecycleEnv(c, { windowsNpx: async () => (++calls <= 1 ? c.b : other) });
    expect(await runLifecycleTransaction(r.planned, approval, r.request, env)).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(await clientBytes(c)).toEqual(before);
  });

  it("지금 유효한 Node.js가 없으면 repair Plan을 막는다(CLIENT_LAUNCHER_UNAVAILABLE)", async () => {
    const c = await installedOnWindows();
    c.win.remove(NODE_A);
    c.current.launcher = null;
    const r = await plan(c, "repair");
    expect(r.planned.plan.status).toBe("blocked");
    expect(r.planned.plan.warnings.map((w) => w.code)).toContain("CLIENT_LAUNCHER_UNAVAILABLE");
    c.current.launcher = { node: "C:\\elsewhere\\node.exe", npxCli: "C:\\elsewhere\\node_modules\\npm\\bin\\npx-cli.js" };
    expect((await plan(c, "repair")).planned.plan.warnings.map((w) => w.code)).toContain("CLIENT_LAUNCHER_UNAVAILABLE");
  });

  it("Health 실패면 이번에 바꾼 설정만 원래 byte로 되돌리고 Version State는 그대로다", async () => {
    const c = await moved();
    const before = await clientBytes(c);
    const r = await plan(c, "repair", { runHealth: async () => ({ ok: true as const, result: { status: "unhealthy" as const, reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } }) });
    const result = await runLifecycleTransaction(r.planned, await approve(r.planned), r.request, r.env);
    expect(result).toMatchObject({ status: "health-failed", compensated: true, stateCommitted: false });
    expect(await clientBytes(c)).toEqual(before);
    expect(await states(c)).toEqual(["claude-code:client-launcher-invalid", "codex:client-launcher-invalid", "cursor:client-launcher-invalid"]);
  });

  it("복구 도중 다른 프로세스가 바꾼 Client 설정은 덮어쓰지 않는다(rollback-failed · CONFIG_RESTORE_FAILED)", async () => {
    const c = await moved();
    const mcp = path.join(c.h.projectRoot, FILES["claude-code"]);
    const external = '{ "mcpServers": { "kubernetes": { "command": "someone-else", "args": [] } } }\n';
    const r = await plan(c, "repair", {
      runHealth: async () => {
        await writeFile(mcp, external);
        return { ok: true as const, result: { status: "unhealthy" as const, reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } };
      },
    });
    const result = await runLifecycleTransaction(r.planned, await approve(r.planned), r.request, r.env);
    expect(result).toMatchObject({ status: "rollback-failed", code: "CONFIG_RESTORE_FAILED", stateCommitted: false });
    expect(await readFile(mcp, "utf8")).toBe(external);
  });

  it("실행 경로가 유효하면 repair할 것이 없다(NOTHING_TO_REPAIR)", async () => {
    const c = await installedOnWindows();
    const r = await plan(c, "repair");
    expect(r.planned.plan.warnings.map((w) => w.code)).toContain("NOTHING_TO_REPAIR");
    expect(r.planned.plan.targets.map((t) => t.launcher?.recorded)).toEqual(["valid", "valid", "valid"]);
  });
});

