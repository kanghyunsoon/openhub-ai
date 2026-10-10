import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRegistry, recordInstallInState, runInstallTransaction, type BackendProbeReport, type FetchLike, type HealthRunReport } from "@openhub/core";
import { INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, registerInstall, type InstallRunResponse, type NativeDialogLike } from "../src/install";
import { LIFECYCLE_PLAN_CHANNELS, LIFECYCLE_RUN_CHANNEL, LifecycleSession, PROJECT_CHANGED_MESSAGE, registerLifecycle, type LifecyclePlanResponse, type LifecycleRunResponse } from "../src/lifecycle";
import { PROJECT_SCAN_CHANNEL, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";
import { approveAll, createHarness, plannedOf } from "../../../packages/core/test/installer/harness";

/**
 * PR #14 보완 [A]: 승인 대화상자가 열린 동안(또는 계획 뒤) 다른 프로젝트를 고르면 승인과 계획을 버리고 실행·쓰기를 0건으로 둔다.
 * install·update·rollback·health(repair는 repair.test.ts)에 같은 규칙을 적용한다. 실제 파일, 가짜 resolver·Health·executor.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY = path.join(ROOT, "registry");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const { entries } = await loadRegistry(REGISTRY);
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-switch-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "24.0.0", status: "ok" },
  npx: { name: "npx", available: true, version: "11.0.0", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};
const OTHER_MCP = '{ "mcpServers": { "mine": { "command": "node", "args": ["mine.js"] } } }\n';
const healthy: HealthRunReport = { ok: true, result: { status: "healthy", reason: null, toolCount: 2, environmentUnverified: true, terminated: true, excerpt: null } };

async function otherProject() {
  const dir = await mkdtemp(path.join(scratch, "other-"));
  await writeFile(path.join(dir, ".mcp.json"), OTHER_MCP);
  return dir;
}

describe("PR #14 [A] 승인 대화상자 중 프로젝트 변경", () => {
  it("설치: 대화상자가 열린 동안 다른 프로젝트를 고르면 설치하지 않고(쓰기·실행 0) 두 프로젝트의 설정을 보존한다", async () => {
    const base = await mkdtemp(path.join(scratch, "install-"));
    const project = path.join(base, "project");
    const home = path.join(base, "home");
    await mkdir(project);
    await mkdir(home);
    await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
    await writeFile(path.join(project, ".mcp.json"), '{ "mcpServers": {} }\n');
    const other = await otherProject();
    let pick = project;
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (c: string, fn: (...args: unknown[]) => unknown) => void handlers.set(c, fn) };
    const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a);
    const rs = new RecommendSession();
    const is = new InstallSession();
    registerProjectScan(rs.observe(ipc), is.trackPicker(async () => pick));
    registerProjectRecommend(ipc, rs, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux" });
    const spawns: string[][] = [];
    const dialog: NativeDialogLike = {
      showMessageBox: async () => {
        pick = other;
        await call(PROJECT_SCAN_CHANNEL);
        return { response: 1 };
      },
    };
    registerInstall(ipc, is, { registryDir: REGISTRY, metadataFile: SEED_SNAPSHOT, platform: "linux", homeDir: home, recommend: rs, dialog, probe: async () => PROBES, spawner: ((exe: string, args: readonly string[]) => (spawns.push([exe, ...args]), undefined)) as never });
    await call(PROJECT_SCAN_CHANNEL);
    await call(PROJECT_RECOMMEND_CHANNEL);
    await call(INSTALL_PLAN_CHANNEL, "postgres-mcp");
    const run = (await call(INSTALL_RUN_CHANNEL, "postgres-mcp")) as InstallRunResponse;
    expect(run).toMatchObject({ status: "project-changed" });
    expect(spawns).toEqual([]);
    expect(await readFile(path.join(project, ".mcp.json"), "utf8")).toBe('{ "mcpServers": {} }\n');
    expect(await readFile(path.join(other, ".mcp.json"), "utf8")).toBe(OTHER_MCP);
    await expect(readFile(path.join(home, ".openhub", "state", "lifecycle.json"))).rejects.toThrow();
  });

  it("update·health·rollback: 계획 뒤 또는 대화상자 중 프로젝트를 바꾸면 project-changed이고, 같은 프로젝트에서는 그대로 동작한다", async () => {
    const h = await createHarness(scratch, { entries });
    const request = { ...h.request("postgres-mcp", [{ client: "claude-code" as const, scope: "project" as const }]), platform: "linux" as const };
    const planned = await plannedOf(h, request);
    const installed = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(installed.status).toBe("succeeded");
    await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
    const other = await otherProject();
    let dir: string | undefined = h.projectRoot;
    let switchDuringDialog = false;
    const dialogs: string[] = [];
    const healthRuns: string[] = [];
    const fetched: string[] = [];
    const fetch: FetchLike = async (url) => (fetched.push(url), new Response(JSON.stringify({ info: { name: "postgres-mcp", version: "0.3.0" } }), { status: 200 }));
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (c: string, fn: (...args: unknown[]) => unknown) => void handlers.set(c, fn) };
    registerLifecycle(ipc, new LifecycleSession(() => dir), {
      registryDir: REGISTRY,
      platform: "linux",
      homeDir: h.homeDir,
      dialog: {
        showMessageBox: async (o) => {
          dialogs.push(o.title);
          if (switchDuringDialog) dir = other;
          return { response: 1 };
        },
      },
      probe: async () => PROBES,
      fetch,
      runHealth: async (v) => (healthRuns.push(v.plan.operation), healthy),
      spawner: h.env.spawner!,
      tempBase: h.base,
    });
    const ID = "project:claude-code:postgres";
    const plan = (op: keyof typeof LIFECYCLE_PLAN_CHANNELS) => handlers.get(LIFECYCLE_PLAN_CHANNELS[op])!({}, ID) as Promise<LifecyclePlanResponse>;
    const run = () => handlers.get(LIFECYCLE_RUN_CHANNEL)!({}, ID) as Promise<LifecycleRunResponse>;
    const mcp = path.join(h.projectRoot, ".mcp.json");
    const state = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
    const snapshot = async () => [await readFile(mcp, "utf8"), await readFile(state, "utf8"), await readFile(path.join(other, ".mcp.json"), "utf8")];

    for (const op of ["update", "health"] as const) {
      // 계획 뒤 다른 프로젝트 선택: 대화상자도 열지 않는다.
      expect((await plan(op)).status, op).toBe("ok");
      dir = other;
      const before = await snapshot();
      expect(await run(), op).toEqual({ status: "project-changed", message: PROJECT_CHANGED_MESSAGE });
      expect(await snapshot()).toEqual(before);
      dir = h.projectRoot;
      // 대화상자가 열린 동안 다른 프로젝트 선택: 승인을 받았어도 실행하지 않는다.
      expect((await plan(op)).status, op).toBe("ok");
      switchDuringDialog = true;
      dialogs.length = 0;
      expect(await run(), op).toEqual({ status: "project-changed", message: PROJECT_CHANGED_MESSAGE });
      expect(dialogs, op).toHaveLength(1);
      expect(await snapshot()).toEqual(before);
      switchDuringDialog = false;
      dir = h.projectRoot;
    }
    expect(healthRuns).toEqual([]);
    // 같은 프로젝트: update가 그대로 동작하고 rollback 대상이 생긴다.
    expect((await plan("update")).status).toBe("ok");
    expect(await run()).toMatchObject({ status: "done", result: { status: "updated", outcome: "succeeded" } });
    expect(healthRuns).toEqual(["update"]);
    expect((await plan("rollback")).status).toBe("ok");
    switchDuringDialog = true;
    const before = await snapshot();
    expect(await run()).toEqual({ status: "project-changed", message: PROJECT_CHANGED_MESSAGE });
    expect(await snapshot()).toEqual(before);
    expect(healthRuns).toEqual(["update"]);
    switchDuringDialog = false;
    dir = h.projectRoot;
    expect((await plan("rollback")).status).toBe("ok");
    expect(await run()).toMatchObject({ status: "done", result: { status: "rolled-back" } });
  });
});

