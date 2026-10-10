import { cp, mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KUBERNETES_TOOL_CONFIG,
  REVIEWED_TOOL_CONFIGS,
  commitLifecycleState,
  containsAbsolutePath,
  fastManifestIssues,
  lifecycleStatus,
  planLifecycle,
  readLifecycleState,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  toolConfigDigest,
  toolConfigLocation,
  projectKeyFromRealpath,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { fakeNpmSpawner } from "../process/fake-npm";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";

/**
 * v0.2.0 tool config 통합: 승인된 InstallPlan·LifecyclePlan으로 실제 임시 파일을 쓴다(가짜 npm·가짜 Health, network 0).
 * 실제 Registry Manifest(registry/mcp/kubernetes-mcp-server.yaml)를 쓴다. 검토된 정책과 같은지 먼저 확인한다.
 */
const scratch = await newScratch("tool-config-flow");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const seed = await seedEntries();
const entries: RegistryEntry[] = seed;
const k8s = seed.find((e) => e.manifest.name === "kubernetes-mcp-server")!.manifest;

describe("Registry Kubernetes Manifest", () => {
  it("검토된 명령·TOML과 정확히 같고 Registry fast validation을 통과한다", () => {
    expect(k8s.install.options?.["command"]).toBe(REVIEWED_TOOL_CONFIGS["kubernetes-mcp-server"]!.commands[0]);
    expect(toolConfigDigest(k8s.toolConfig!.content)).toBe(toolConfigDigest(KUBERNETES_TOOL_CONFIG));
    expect(fastManifestIssues(k8s)).toEqual([]);
  });

  it("설치 계획은 Client·플랫폼 검증 수준을 구분하고 RBAC·로그 위험 고지를 유지한다", async () => {
    const h = await createHarness(scratch, { entries });
    for (const platform of ["linux", "windows", "macos"] as const) {
      const { plan } = await plannedOf(h, { ...h.request("kubernetes-mcp-server", CLIENTS), platform });
      const notices = plan.warnings.filter((w) => w.code === "client-launch-unverified" || w.code === "platform-unverified").map((w) => w.message);
      // Codex: 프로젝트 설정 파일에서 실제 시작·호출까지 확인(launch-verified) → 경고 없음. Cursor는 미검증 경고가 남는다.
      expect(notices.some((m) => m.startsWith("Codex"))).toBe(false);
      expect(notices.some((m) => m.startsWith("Cursor:"))).toBe(true);
      expect(notices.some((m) => m.startsWith("Claude Code"))).toBe(false);
      expect(notices.some((m) => m.startsWith("macos"))).toBe(platform === "macos");
      expect(plan.warnings.find((w) => w.code === "tool-config")?.message).toMatch(/Pod·Node 로그.*RBAC/u);
    }
  });
});
const CLIENTS = (["claude-code", "codex", "cursor"] as const).map((client) => ({ client, scope: "project" as const }));
const DIGEST = toolConfigDigest(KUBERNETES_TOOL_CONFIG);

async function projectLoc(h: Harness, root = h.projectRoot) {
  const { realpath } = await import("node:fs/promises");
  return toolConfigLocation({ homeDir: h.homeDir, scope: "project", toolId: "kubernetes-mcp-server", projectKey: projectKeyFromRealpath(await realpath(root)) })!;
}

async function install(h: Harness) {
  const request = { ...h.request("kubernetes-mcp-server", CLIENTS), platform: "linux" as const };
  const planned = await plannedOf(h, request);
  return { request, planned, run: async () => runInstallTransaction(planned, await approveAll(planned), request, h.env) };
}

const healthCalls: { toolConfigFile: string | undefined; content: string | null }[] = [];
function lifecycleEnv(h: Harness): LifecycleEnvironment {
  return {
    loadEntries: async () => entries,
    probe: h.env.probe,
    tempBase: os.tmpdir(),
    now: () => new Date("2026-10-10T00:00:00.000Z"),
    spawner: fakeNpmSpawner({ cacheRoot: path.join(h.base, "npm-cache") }).spawner,
    runHealth: async (_verified, options) => {
      healthCalls.push({ toolConfigFile: options.toolConfigFile, content: options.toolConfigFile === undefined ? null : await readFile(options.toolConfigFile, "utf8") });
      return { ok: true, result: { status: "healthy", reason: null, toolCount: 13, environmentUnverified: false, terminated: true, excerpt: null } };
    },
  };
}
async function lifecycle(h: Harness, operation: LifecycleRequest["operation"], projectRoot = h.projectRoot) {
  const request: LifecycleRequest = { operation, toolId: "kubernetes-mcp-server", projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false };
  const env = lifecycleEnv(h);
  const built = await planLifecycle({ ...request, entries });
  return { request, env, built, run: async () => {
    if (!built.ok) throw new Error(built.code);
    const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    return runLifecycleTransaction(built.planned, outcome.approval, request, env);
  } };
}
const statusOf = async (h: Harness, projectRoot = h.projectRoot) => {
  const s = await lifecycleStatus({ projectRoot, homeDir: h.homeDir, entries, platform: "linux", includeUser: false });
  if (!s.ok) throw new Error(s.code);
  return s.items.filter((i) => i.serverName === "kubernetes").map((i) => i.client + ":" + i.state);
};

describe("v0.2.0 tool config: 설치(InstallPlan)", () => {
  it("승인 → Prepare → tool config → 3개 Client 설정 → Version State. Plan·Result·State에는 절대 경로가 없고 Client 설정에만 있다", async () => {
    const h = await createHarness(scratch, { entries });
    const { planned, run, request } = await install(h);
    expect(planned.plan.status).toBe("installable");
    expect(planned.plan.steps.map((s) => s.kind + ":" + s.id)).toEqual(["run:npx-prepare", "tool-config:tool-config-project", "config-patch:config-claude-code-project", "config-patch:config-codex-project", "config-patch:config-cursor-project"]);
    const step = planned.plan.steps[1]!;
    expect(step).toMatchObject({ kind: "tool-config", fileId: "tool-config:project:kubernetes-mcp-server", scope: "project", contentDigest: DIGEST, expected: { state: "absent", digest: null }, action: "create" });
    expect(planned.plan.approvalRequirements).toContain("tool-config");
    expect(planned.plan.warnings.map((w) => w.code)).toContain("tool-config");
    expect(planned.plan.launch?.clientSpec).toEqual({ command: "npx", args: ["-y", "kubernetes-mcp-server@0.0.67", "--read-only", "--toolsets", "core", "--config", "{toolConfig}"] });
    expect(containsAbsolutePath(JSON.stringify(planned.plan))).toBe(false);
    const loc = await projectLoc(h);
    const result = await run();
    expect(result).toMatchObject({ status: "succeeded", verification: { prepared: "cached", configured: true } });
    expect(result.toolConfigChanges).toEqual([{ fileId: "tool-config:project:kubernetes-mcp-server", scope: "project", action: "create", applied: true, restored: false }]);
    expect(containsAbsolutePath(JSON.stringify(result))).toBe(false);
    expect(await readFile(loc.file, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
    const mcp = JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).mcpServers.kubernetes;
    expect(mcp).toEqual({ command: "npx", args: ["-y", "kubernetes-mcp-server@0.0.67", "--read-only", "--toolsets", "core", "--config", loc.file] });
    expect(await readFile(path.join(h.projectRoot, ".codex", "config.toml"), "utf8")).toContain(JSON.stringify(loc.file));
    expect(await recordInstallInState(planned, result, { projectRoot: request.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 3 });
    const state = await readLifecycleState({ homeDir: h.homeDir });
    if (!state.ok) throw new Error(state.code);
    const recorded = Object.values(state.state.entries);
    expect(recorded.every((e) => e.toolConfig?.digest === DIGEST && e.toolConfig.fileId === "tool-config:project:kubernetes-mcp-server")).toBe(true);
    expect(containsAbsolutePath(JSON.stringify(state.state))).toBe(false);
    expect(await statusOf(h)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
    // 이미 설정된 상태에서 다시 계획하면 already-installed(no-op)다(중복 설치 없음, tool config 단계도 없다).
    const again = (await install(h)).planned.plan;
    expect(again.status).toBe("already-installed");
    expect(again.steps).toEqual([]);
  });

  it("승인 뒤 tool config가 생기면 PLAN_STALE이고 아무것도 쓰지 않는다", async () => {
    const h = await createHarness(scratch, { entries });
    const { planned, request } = await install(h);
    const approval = await approveAll(planned);
    const loc = await projectLoc(h);
    await mkdir(path.dirname(loc.file), { recursive: true });
    await writeFile(loc.file, "read_only = false\n");
    const result = await runInstallTransaction(planned, approval, request, h.env);
    expect(result).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(await readFile(loc.file, "utf8")).toBe("read_only = false\n");
    await expect(readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).rejects.toThrow();
  });

  it("기존(변경된) tool config가 있으면 Plan은 replace이고 승인 뒤 검토된 내용으로 바뀐다", async () => {
    const h = await createHarness(scratch, { entries });
    const loc = await projectLoc(h);
    await mkdir(path.dirname(loc.file), { recursive: true });
    await writeFile(loc.file, "read_only = false\n");
    const { planned, run } = await install(h);
    expect(planned.plan.steps.find((s) => s.kind === "tool-config")).toMatchObject({ action: "replace", expected: { state: "present", digest: toolConfigDigest("read_only = false\n") } });
    expect((await run()).status).toBe("succeeded");
    expect(await readFile(loc.file, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
  });

  it("Client 설정 쓰기가 중간에 실패하면 이번에 쓴 Client 설정과 tool config만 되돌린다(기존 파일 byte 보존)", async () => {
    const h = await createHarness(scratch, { entries, failRenameFor: ".cursor/mcp.json" });
    const original = '{ "mcpServers": { "keep": { "command": "x", "args": [] } } }\n';
    await writeFile(path.join(h.projectRoot, ".mcp.json"), original);
    const { run } = await install(h);
    const result = await run();
    expect(result).toMatchObject({ status: "partial-compensated", code: "CONFIG_WRITE_FAILED" });
    expect(result.toolConfigChanges?.[0]).toMatchObject({ applied: true, restored: true });
    expect(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).toBe(original);
    await expect(readFile((await projectLoc(h)).file, "utf8")).rejects.toThrow();
  });

  it("tool config를 쓸 수 없으면(경로의 junction) Client 설정을 쓰지 않는다", async () => {
    const h = await createHarness(scratch, { entries });
    const outside = path.join(h.base, "outside");
    await mkdir(outside);
    await mkdir(path.join(h.homeDir, ".openhub", "tool-config"), { recursive: true });
    const { symlink } = await import("node:fs/promises");
    await symlink(outside, path.join(h.homeDir, ".openhub", "tool-config", "project"), process.platform === "win32" ? "junction" : "dir");
    const { planned } = await install(h);
    // 상태를 확인할 수 없는 위치는 승인 전에 막는다.
    expect(planned.plan.status).toBe("blocked");
    expect(planned.plan.warnings.map((w) => w.code)).toContain("TOOL_CONFIG_UNKNOWN");
  });

  it("Windows: Plan은 node + {npxCli} 직접 실행(cmd 없음)이고, 검증된 Node.js 실행 경로가 없으면 tool config·Client 설정을 하나도 쓰지 않는다", async () => {
    const h = await createHarness(scratch, { entries });
    const request = { ...h.request("kubernetes-mcp-server", CLIENTS), platform: "windows" as const };
    const planned = await plannedOf(h, request);
    expect(planned.plan.launch?.clientSpec).toEqual({ command: "node", args: ["{npxCli}", "-y", "kubernetes-mcp-server@0.0.67", "--read-only", "--toolsets", "core", "--config", "{toolConfig}"] });
    const value = planned.plan.steps.find((s) => s.kind === "config-patch");
    expect(value?.kind === "config-patch" && value.value.command).toBe("node");
    expect(containsAbsolutePath(JSON.stringify(planned.plan))).toBe(false);
    // 일반 npx Tool의 Windows 계약(cmd 래퍼)은 그대로다.
    const memory = await plannedOf(h, { ...h.request("memory-mcp", CLIENTS), platform: "windows" as const });
    expect(memory.plan.launch?.clientSpec.command).toBe("cmd");
    // 실행 경로 없음(windowsNpx 없음) → MANUAL_SETUP_REQUIRED, 쓰기 0.
    const result = await runInstallTransaction(planned, await approveAll(planned), request, { ...h.env, windowsNpx: async () => null });
    expect(result).toMatchObject({ status: "failed", code: "MANUAL_SETUP_REQUIRED" });
    await expect(readFile((await projectLoc(h)).file, "utf8")).rejects.toThrow();
    await expect(readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).rejects.toThrow();
  });
});

describe("v0.2.0 tool config: Status·Repair·Health·Rollback·Update(LifecyclePlan)", () => {
  async function installed() {
    const h = await createHarness(scratch, { entries });
    const { planned, run, request } = await install(h);
    const result = await run();
    await recordInstallInState(planned, result, { projectRoot: request.projectRoot, homeDir: h.homeDir, now: () => new Date() });
    return { h, loc: await projectLoc(h) };
  }

  it("tool config가 바뀌면 tool-config-drift, 지우면 tool-config-missing이고 Health·update는 막히며 repair(승인)가 되돌린다", async () => {
    const { h, loc } = await installed();
    await writeFile(loc.file, KUBERNETES_TOOL_CONFIG.replace('kind = "Secret"', 'kind = "ConfigMap"'));
    expect(await statusOf(h)).toEqual(["claude-code:tool-config-drift", "codex:tool-config-drift", "cursor:tool-config-drift"]);
    const health = await lifecycle(h, "health");
    expect(health.built.ok && health.built.planned.plan.status).toBe("blocked");
    expect(health.built.ok && health.built.planned.plan.warnings.map((w) => w.code)).toContain("TOOL_CONFIG_DRIFT");
    await unlink(loc.file);
    expect(await statusOf(h)).toEqual(["claude-code:tool-config-missing", "codex:tool-config-missing", "cursor:tool-config-missing"]);

    const repair = await lifecycle(h, "repair");
    if (!repair.built.ok) throw new Error(repair.built.code);
    expect(repair.built.planned.plan.status).toBe("ready");
    expect(repair.built.planned.plan.steps.map((s) => s.kind)).toEqual(["run", "tool-config", "config-replace", "config-replace", "config-replace", "health", "state-commit"]);
    expect(repair.built.planned.plan.approvalRequirements).toEqual(expect.arrayContaining(["base", "health-execution", "tool-config"]));
    expect(await readFile(loc.file, "utf8").catch(() => null)).toBeNull(); // 승인 전에는 만들지 않는다.
    healthCalls.length = 0;
    const result = await repair.run();
    expect(result).toMatchObject({ status: "repaired", stateCommitted: true });
    expect(healthCalls).toEqual([{ toolConfigFile: loc.file, content: KUBERNETES_TOOL_CONFIG }]);
    expect(await readFile(loc.file, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
    expect(await statusOf(h)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
    const again = await lifecycle(h, "repair");
    expect(again.built.ok && again.built.planned.plan.warnings.map((w) => w.code)).toContain("NOTHING_TO_REPAIR");
  });

  it("Health는 Client와 같은 tool config 파일로 실행한다", async () => {
    const { h, loc } = await installed();
    healthCalls.length = 0;
    const health = await lifecycle(h, "health");
    expect(await health.run()).toMatchObject({ status: "health-checked" });
    expect(healthCalls).toEqual([{ toolConfigFile: loc.file, content: KUBERNETES_TOOL_CONFIG }]);
  });

  it("옮기거나 복사한 프로젝트: tool-config-relocated → repair가 새 위치의 tool config와 새 기록을 만들고 원래 기록은 남긴다", async () => {
    const { h } = await installed();
    const copy = path.join(h.base, "project-copy");
    await cp(h.projectRoot, copy, { recursive: true });
    expect(await statusOf(h, copy)).toEqual(["claude-code:tool-config-relocated", "codex:tool-config-relocated", "cursor:tool-config-relocated"]);
    const repair = await lifecycle(h, "repair", copy);
    if (!repair.built.ok) throw new Error(repair.built.code);
    expect(repair.built.planned.plan.targets.every((t) => t.relocatedFrom !== undefined && t.stateRevision === null)).toBe(true);
    expect(await repair.run()).toMatchObject({ status: "repaired" });
    const newLoc = await projectLoc(h, copy);
    expect(await readFile(newLoc.file, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
    expect(JSON.parse(await readFile(path.join(copy, ".mcp.json"), "utf8")).mcpServers.kubernetes.args).toContain(newLoc.file);
    expect(await statusOf(h, copy)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
    expect(await statusOf(h)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
  });

  it("rollback: 직전 기록이 같은 버전이면 바꿀 것이 없고(up-to-date), 검토되지 않은 직전 버전이면 막는다", async () => {
    const { h } = await installed();
    const state = await readLifecycleState({ homeDir: h.homeDir });
    if (!state.ok) throw new Error(state.code);
    const withPrevious = (version: string) =>
      Object.fromEntries(
        Object.entries(state.state.entries).map(([k, s]) => {
          const { previous: _p, lastHealth: _l, ...core } = s;
          const spec = "kubernetes-mcp-server@" + version;
          const args = core.launch.clientSpec.args.map((a) => (a.startsWith("kubernetes-mcp-server@") ? spec : a));
          return [k, { ...s, revision: 2, previous: { ...core, revision: 1, artifact: { requested: spec, resolved: core.artifact.resolved === null ? null : { ...core.artifact.resolved, spec, version } }, launch: { ...core.launch, clientSpec: { ...core.launch.clientSpec, args } } } }];
        }),
      );
    expect((await commitLifecycleState({ ...state.state, entries: withPrevious("0.0.67") }, state.digest, { homeDir: h.homeDir })).ok).toBe(true);
    const same = await lifecycle(h, "rollback");
    expect(same.built.ok && same.built.planned.plan.status).toBe("up-to-date");
    const read2 = await readLifecycleState({ homeDir: h.homeDir });
    if (!read2.ok) throw new Error(read2.code);
    expect((await commitLifecycleState({ ...read2.state, entries: withPrevious("0.0.66") }, read2.digest, { homeDir: h.homeDir })).ok).toBe(true);
    const unreviewed = await lifecycle(h, "rollback");
    expect(unreviewed.built.ok && unreviewed.built.planned.plan.status).toBe("blocked");
    expect(unreviewed.built.ok && unreviewed.built.planned.plan.warnings.map((w) => w.code)).toContain("TOOL_CONFIG_VERSION_UNREVIEWED");
  });

  it("update는 검토되지 않은 버전으로 가지 않는다(TOOL_CONFIG_VERSION_UNREVIEWED)", async () => {
    const { h } = await installed();
    const fetch = async (url: string) => (url.endsWith("kubernetes-mcp-server/0.0.68") ? new Response(JSON.stringify({ name: "kubernetes-mcp-server", version: "0.0.68" }), { status: 200 }) : new Response("missing", { status: 404 }));
    const built = await planLifecycle({ operation: "update", toolId: "kubernetes-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "linux", includeUser: false, to: "0.0.68", fetch });
    if (!built.ok) throw new Error(built.code + " " + built.message);
    expect(built.planned.plan.status).toBe("blocked");
    expect(built.planned.plan.warnings.map((w) => w.code)).toContain("TOOL_CONFIG_VERSION_UNREVIEWED");
  });
});


describe("v0.2.0 tool config: 같은 프로젝트 repair(경로만 다른 항목)", () => {
  async function installed() {
    const h = await createHarness(scratch, { entries });
    const { planned, run, request } = await install(h);
    const result = await run();
    await recordInstallInState(planned, result, { projectRoot: request.projectRoot, homeDir: h.homeDir, now: () => new Date() });
    return { h, loc: await projectLoc(h) };
  }
  const FILES = { "claude-code": ".mcp.json", cursor: path.join(".cursor", "mcp.json"), codex: path.join(".codex", "config.toml") } as const;
  /** Client 파일에서 문자열 하나를 바꾼다(JSON·TOML 모두 JSON 문자열 escape를 쓴다). */
  async function rewrite(h: Harness, client: keyof typeof FILES, from: string, to: string) {
    const file = path.join(h.projectRoot, FILES[client]);
    const text = await readFile(file, "utf8");
    expect(text).toContain(JSON.stringify(from));
    await writeFile(file, text.split(JSON.stringify(from)).join(JSON.stringify(to)));
  }
  const otherManaged = (h: Harness) => toolConfigLocation({ homeDir: h.homeDir, scope: "user", toolId: "kubernetes-mcp-server" })!.file;

  for (const client of ["codex", "claude-code", "cursor"] as const) {
    it("A·B·C " + client + ": --config 경로만 바뀐 항목은 승인 뒤 repair가 고치고 다른 항목·사용자 TOML은 그대로다", async () => {
      const { h, loc } = await installed();
      const codexFile = path.join(h.projectRoot, FILES.codex);
      // F: 사용자 TOML(최상위 설정은 앞에, 다른 MCP 항목은 뒤에)을 둔다. repair 뒤 byte 그대로 남아야 한다.
      const userHead = '# user\nmodel = "o3"\n\n';
      const userToml = '\n[mcp_servers.other]\ncommand = "uvx"\nargs = ["other-mcp"]\n';
      await writeFile(codexFile, userHead + (await readFile(codexFile, "utf8")) + userToml);
      // Codex block을 덧붙였으므로 Version State(파일 digest가 아닌 항목 digest)는 그대로 일치한다.
      await rewrite(h, client, loc.file, otherManaged(h));
      const states = await statusOf(h);
      expect(states).toContain(client + ":config-drift");
      const repair = await lifecycle(h, "repair");
      if (!repair.built.ok) throw new Error(repair.built.code);
      expect(repair.built.planned.plan.status, JSON.stringify(repair.built.planned.plan.warnings.filter((x) => x.code.toUpperCase() === x.code))).toBe("ready");
      const result = await repair.run();
      expect(result, JSON.stringify(result.steps)).toMatchObject({ status: "repaired", stateCommitted: true });
      expect(await statusOf(h)).toEqual(["claude-code:state-consistent", "codex:state-consistent", "cursor:state-consistent"]);
      const after = await readFile(codexFile, "utf8");
      expect(after.startsWith(userHead)).toBe(true);
      expect(after.endsWith(userToml)).toBe(true);
      expect(after).toContain(JSON.stringify(loc.file));
      expect(after).not.toContain(JSON.stringify(otherManaged(h)));
    });
  }

  it("D: 명령 인자가 바뀐 항목은 repair하지 않는다(CONFIG_DRIFT)", async () => {
    const { h } = await installed();
    await rewrite(h, "claude-code", "kubernetes-mcp-server@0.0.67", "kubernetes-mcp-server@0.0.66");
    const repair = await lifecycle(h, "repair");
    expect(repair.built.ok && repair.built.planned.plan.status).toBe("blocked");
    expect(repair.built.ok && repair.built.planned.plan.warnings.map((w) => w.code)).toContain("CONFIG_DRIFT");
  });

  it("E: 보안 플래그(--read-only·--toolsets)가 바뀐 항목, OpenHub 관리 위치가 아닌 --config는 repair하지 않는다", async () => {
    const { h, loc } = await installed();
    await rewrite(h, "codex", "--read-only", "--log-level");
    const a = await lifecycle(h, "repair");
    expect(a.built.ok && a.built.planned.plan.warnings.map((w) => w.code)).toContain("CONFIG_DRIFT");
    const second = await installed();
    await rewrite(second.h, "cursor", second.loc.file, path.join(second.h.base, "evil", "config.toml"));
    const b = await lifecycle(second.h, "repair");
    expect(b.built.ok && b.built.planned.plan.warnings.map((w) => w.code)).toContain("CONFIG_DRIFT");
    expect(loc.file).not.toBe("");
  });

  it("G: 승인 뒤 항목이 다시 바뀌면 PLAN_STALE이고 아무것도 쓰지 않는다", async () => {
    const { h, loc } = await installed();
    await rewrite(h, "codex", loc.file, otherManaged(h));
    const repair = await lifecycle(h, "repair");
    if (!repair.built.ok) throw new Error(repair.built.code);
    const outcome = await requestLifecycleApproval(repair.built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    const moved = path.join(h.base, "x", ".openhub", "tool-config", "user", "kubernetes-mcp-server", "config.toml");
    await rewrite(h, "codex", otherManaged(h), moved);
    const before = await readFile(path.join(h.projectRoot, FILES.codex), "utf8");
    const result = await runLifecycleTransaction(repair.built.planned, outcome.approval, repair.request, repair.env);
    expect(result).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(await readFile(path.join(h.projectRoot, FILES.codex), "utf8")).toBe(before);
  });

  it("H: 보상 중 다른 프로세스가 바꾼 Client 설정은 덮어쓰지 않고 rollback-failed(CONFIG_RESTORE_FAILED)로 남긴다", async () => {
    const { h, loc } = await installed();
    await rewrite(h, "claude-code", loc.file, otherManaged(h));
    const repair = await lifecycle(h, "repair");
    if (!repair.built.ok) throw new Error(repair.built.code);
    const outcome = await requestLifecycleApproval(repair.built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    const mcp = path.join(h.projectRoot, FILES["claude-code"]);
    const external = '{ "mcpServers": { "kubernetes": { "command": "someone-else", "args": [] } } }\n';
    const env: LifecycleEnvironment = {
      ...repair.env,
      runHealth: async () => {
        await writeFile(mcp, external);
        return { ok: true as const, result: { status: "unhealthy" as const, reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } };
      },
    };
    const result = await runLifecycleTransaction(repair.built.planned, outcome.approval, repair.request, env);
    expect(result).toMatchObject({ status: "rollback-failed", code: "CONFIG_RESTORE_FAILED", stateCommitted: false });
    expect(await readFile(mcp, "utf8")).toBe(external);
  });
});


