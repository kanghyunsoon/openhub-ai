import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type InstallRequest,
  type LifecycleEnvironment,
  type LifecycleRequest,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";
import { fakeNpmSpawner } from "../process/fake-npm";

/**
 * v0.2.1 P0-5 재현: Update에서 config 교체 뒤 Health 실행기가 값을 돌려주지 않고 예외를 던지면(TEMP 접근 실패·파일 생성 실패·spawner 예외 등)
 * 정상 Health 실패와 같은 보상 경로로 가야 한다: Client 설정 원본 복구, Version State 그대로, 원인 표시, 다음 행동 안내.
 */
const seed = await seedEntries();
const scratch = await newScratch("v021-health-exception");
afterAll(() => rm(scratch, { recursive: true, force: true }));

interface CaseContext {
  /** 프로젝트 Cursor 설정 파일(절대 경로)과 설치 직후 내용 */
  cursorFile: string;
  original: string;
}

async function installedCase(makeEnv: (base: LifecycleEnvironment, ctx: CaseContext) => LifecycleEnvironment, operation: LifecycleRequest["operation"] = "update") {
  const h = await createHarness(scratch, { entries: seed });
  const targets: InstallRequest["targets"] = [{ client: "cursor", scope: "project" }];
  const install = h.request("github-mcp-server", targets);
  const planned0 = await plannedOf(h, install);
  const installed = await runInstallTransaction(planned0, await approveAll(planned0), install, h.env);
  expect(installed.status).toBe("succeeded");
  expect(await recordInstallInState(planned0, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-11T00:00:00.000Z") })).toMatchObject({ ok: true });
  const exec = fakeNpmSpawner({ cacheRoot: path.join(scratch, "npm-" + Math.random().toString(36).slice(2, 8)) });
  const base: LifecycleEnvironment = {
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: scratch,
    now: () => new Date("2026-10-12T00:00:00.000Z"),
    fetch: async (url: string) => {
      const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
      if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
      if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "f".repeat(64) } });
      return new Response("missing", { status: 404 });
    },
    configFs: h.env.configFs!,
    spawner: exec.spawner,
  };
  const cursorFile = path.join(h.projectRoot, ".cursor", "mcp.json");
  const env = makeEnv(base, { cursorFile, original: await readFile(cursorFile, "utf8") });
  const request: LifecycleRequest = { operation, toolId: "github-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets };
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) throw new Error(built.code + " " + built.message);
  const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  const files = async () => [await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8"), await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8")];
  return { run: () => runLifecycleTransaction(built.planned, outcome.approval, request, env), files };
}

describe("v0.2.1 P0-5 Health 예외 보상(Update)", () => {
  const throwing: [string, (base: LifecycleEnvironment) => LifecycleEnvironment][] = [
    ["runHealth가 Error를 던짐(TEMP 접근 실패)", (b) => ({ ...b, runHealth: async () => { throw Object.assign(new Error("EACCES: permission denied, mkdtemp"), { code: "EACCES" }); } })],
    ["runHealth가 Error가 아닌 값으로 reject", (b) => ({ ...b, runHealth: () => Promise.reject("boom") })],
    ["실제 runHealthCheck + Health spawner 예외(프로세스 시작 예외)", (b) => ({ ...b, healthSpawner: () => { throw new Error("spawn EPERM"); } })],
  ];
  for (const [name, makeEnv] of throwing) {
    it(name + ": config 원본 복구·Version State 그대로·health-failed·다음 행동 안내", async () => {
      const c = await installedCase(makeEnv);
      const before = await c.files();
      const result = await c.run().catch((e: unknown) => ({ status: "threw", error: String(e) }));
      const after = await c.files();
      expect(after[0], JSON.stringify(result).slice(0, 400)).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
      expect(result).toMatchObject({ status: "health-failed", compensated: true, stateCommitted: false });
      expect((result as { nextActions?: string[] }).nextActions?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it("실제 runHealthCheck + 임시 폴더를 만들 수 없는 tempBase(파일 경로): 예외로 빠지지 않고 같은 보상 경로", async () => {
    const blocker = path.join(scratch, "not-a-dir-" + Math.random().toString(36).slice(2, 8));
    await writeFile(blocker, "x");
    const c = await installedCase((b) => ({ ...b, tempBase: blocker }));
    const before = await c.files();
    const result = await c.run().catch((e: unknown) => ({ status: "threw", error: String(e) }));
    const after = await c.files();
    expect(after[0], JSON.stringify(result).slice(0, 400)).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(result).toMatchObject({ status: "health-failed", compensated: true, stateCommitted: false });
  });
});

const healthy: NonNullable<LifecycleEnvironment["runHealth"]> = async () => ({ ok: true, result: { status: "healthy", reason: null, toolCount: 3, environmentUnverified: false, terminated: true, excerpt: null } });
const changed = async (ctx: CaseContext) => (await readFile(ctx.cursorFile, "utf8")) !== ctx.original;

describe("v0.2.1 P0-5 A. Manifest를 읽지 못하면 Health를 실행하지 않는다", () => {
  const cases: [string, (b: LifecycleEnvironment, ctx: CaseContext) => LifecycleEnvironment][] = [
    // 설정이 바뀐 뒤(= Health 직전)에만 실패한다. 계획·실행 직전 재생성은 정상이다.
    ["loadEntries 예외", (b, ctx) => ({ ...b, loadEntries: async () => { if (await changed(ctx)) throw new Error("EACCES: registry"); return seed; } })],
    ["Registry에 그 Tool이 없음", (b, ctx) => ({ ...b, loadEntries: async () => ((await changed(ctx)) ? seed.filter((e) => e.manifest.name !== "github-mcp-server") : seed) })],
  ];
  for (const [name, makeEnv] of cases) {
    it("update: " + name + " → Health 실행 0회, MANIFEST_UNAVAILABLE, config 원본 복구, Version State 그대로", async () => {
      let healthRuns = 0;
      const c = await installedCase((b, ctx) => ({ ...makeEnv(b, ctx), runHealth: async (...a) => ((healthRuns += 1), healthy(...a)) }));
      const before = await c.files();
      const result = await c.run();
      expect(healthRuns).toBe(0);
      expect(result).toMatchObject({ status: "health-failed", code: "MANIFEST_UNAVAILABLE", compensated: true, stateCommitted: false, health: null });
      expect(result.steps.find((s) => s.id === "health")).toMatchObject({ status: "failed", code: "MANIFEST_UNAVAILABLE" });
      expect(result.nextActions.join(" ")).toContain("Registry Manifest");
      expect(await c.files()).toEqual(before);
    });
  }

  it("단독 health: Manifest 예외 → Health 실행 0회, 설정·Version State 그대로", async () => {
    let healthRuns = 0;
    let calls = 0;
    let armed = false;
    const c = await installedCase((b) => ({
      ...b,
      // 실행 직전 재생성(1회) 뒤 Health 단계의 Manifest 읽기만 실패시킨다.
      loadEntries: async () => {
        if (armed && ++calls >= 2) throw new Error("registry unreadable");
        return seed;
      },
      runHealth: async (...a) => ((healthRuns += 1), healthy(...a)),
    }), "health");
    const before = await c.files();
    armed = true;
    const result = await c.run();
    expect(healthRuns).toBe(0);
    expect(result).toMatchObject({ status: "health-failed", code: "MANIFEST_UNAVAILABLE", stateCommitted: false, health: null });
    expect(await c.files()).toEqual(before);
  });
});

describe("v0.2.1 P0-5 D·E. 보상 자체가 실패하거나 외부 변경이 있으면 덮어쓰지 않는다", () => {
  it("D. Health 예외 뒤 설정 복구 쓰기가 실패하면 rollback-failed(CONFIG_RESTORE_FAILED)이고 succeeded·health-failed로 표시하지 않으며 Version State는 그대로다", async () => {
    let renames = 0;
    const c = await installedCase((b, ctx) => ({
      ...b,
      configFs: {
        ...b.configFs!,
        // 첫 rename(update의 설정 교체)은 통과, 그 다음(보상 복구)부터 실패한다.
        rename: async (from: string, to: string) => {
          if (path.resolve(to) === path.resolve(ctx.cursorFile) && ++renames > 1) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
          return b.configFs!.rename(from, to);
        },
      },
      runHealth: async () => {
        throw new Error("health crashed");
      },
    }));
    const before = await c.files();
    const result = await c.run();
    const after = await c.files();
    expect(result).toMatchObject({ status: "rollback-failed", code: "CONFIG_RESTORE_FAILED", compensated: false, stateCommitted: false });
    expect(after[0]).not.toBe(before[0]); // 복구하지 못했다는 사실 그대로(거짓 성공 없음)
    expect(after[1]).toBe(before[1]);
    expect(result.nextActions.join(" ")).toContain(".cursor/mcp.json");
  });

  it("E. Health 중 다른 프로그램이 같은 설정 파일을 바꾸면 보상이 그 내용을 덮어쓰지 않는다", async () => {
    const external = '{ "mcpServers": { "edited-by-user": { "command": "uvx", "args": ["x-mcp==1.0.0"] } } }\n';
    const c = await installedCase((b, ctx) => ({
      ...b,
      runHealth: async () => {
        await writeFile(ctx.cursorFile, external);
        throw new Error("health crashed");
      },
    }));
    const before = await c.files();
    const result = await c.run();
    const after = await c.files();
    expect(after[0]).toBe(external);
    expect(after[1]).toBe(before[1]);
    expect(result).toMatchObject({ status: "rollback-failed", code: "CONFIG_RESTORE_FAILED", stateCommitted: false });
  });
});
