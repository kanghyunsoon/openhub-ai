import "./locale-ko";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { npxCacheKey, readLifecycleState } from "@openhub/core";
import { INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, registerInstall, smokeInstallDeps, type InstallRunResponse } from "../src/install";
import { LIFECYCLE_PLAN_CHANNELS, LIFECYCLE_RUN_CHANNEL, LIFECYCLE_STATUS_CHANNEL, LifecycleSession, registerLifecycle, smokeLifecycleDeps, type LifecyclePlanResponse, type LifecycleRunResponse, type LifecycleStatusResponse } from "../src/lifecycle";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";

/**
 * v0.2.0 npx smoke 보완: Desktop 스모크가 쓰는 가짜 npm(smokeNpmSpawner)이 실제 npx Prepare 캐시 계약을 지켜서
 * npx 설치 → Prepare → Update(Prepare) → Health → Rollback → Health가 끝까지 지나가는지 본다.
 * - IPC: 스모크 의존성(smokeInstallDeps·smokeLifecycleDeps)을 그대로 main 핸들러에 넣는다. 정확한 버전 npx 도구(mongodb-mcp-server)는
 *   Registry Manifest 버전을 따르므로 Registry 복사본의 Manifest를 3.0.5 → 3.0.6으로 올려 update를 만든다. network·실제 npm 0.
 * - Electron(OPENHUB_E2E=1): 실제 창에서 playwright-mcp 설치 → update → rollback → Health(클릭), mongodb-mcp-server 설치 Prepare.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-npx-smoke-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const MONGO = "mongodb-mcp-server";
const ID = "project:claude-code:mongodb";

const cacheEntry = async (cacheRoot: string, spec: string) => {
  const dir = path.join(cacheRoot, "_npx", npxCacheKey(spec));
  return stat(path.join(dir, "node_modules", ".package-lock.json")).then(() => true, () => false);
};

describe("v0.2.0 npx smoke: 가짜 npm이 Prepare 캐시 계약을 지킨다(IPC)", () => {
  it("정확한 버전 npx: 설치 Prepare → Update Prepare → Health → Rollback → Health", async () => {
    const base = await mkdtemp(path.join(scratch, "case-"));
    const registry = path.join(base, "registry");
    await cp(path.join(ROOT, "registry"), registry, { recursive: true });
    const project = path.join(base, "project");
    const home = path.join(base, "home");
    await mkdir(project);
    await mkdir(home);
    await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "mongodb": "^6.10.0" } }\n');
    await writeFile(path.join(project, ".mcp.json"), '{ "mcpServers": {} }\n');
    const cache = path.join(base, "npm-cache");
    const install = smokeInstallDeps(cache);
    const life = smokeLifecycleDeps(cache);
    const handlers = new Map<string, (...args: unknown[]) => unknown>();
    const ipc = { handle: (c: string, fn: (...args: unknown[]) => unknown) => void handlers.set(c, fn) };
    const rs = new RecommendSession();
    const is = new InstallSession();
    registerProjectScan(rs.observe(ipc), is.trackPicker(fixedDirectory(project)));
    registerProjectRecommend(ipc, rs, { registryDir: registry, metadataFile: SEED_SNAPSHOT, platform: "linux" });
    registerInstall(ipc, is, { registryDir: registry, metadataFile: SEED_SNAPSHOT, platform: "linux", homeDir: home, recommend: rs, dialog: install.dialog, probe: install.probe, spawner: install.spawner });
    registerLifecycle(ipc, new LifecycleSession(() => is.projectDir), { registryDir: registry, platform: "linux", homeDir: home, dialog: life.dialog, fetch: life.fetch, runHealth: life.runHealth, spawner: life.spawner, probe: install.probe, tempBase: base });
    const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a);
    await call(PROJECT_SCAN_CHANNEL);
    await call(PROJECT_RECOMMEND_CHANNEL);

    expect(((await call(INSTALL_PLAN_CHANNEL, MONGO)) as { status: string }).status).toBe("ok");
    const installed = (await call(INSTALL_RUN_CHANNEL, MONGO)) as InstallRunResponse;
    expect(installed.status === "done" && installed.result.status).toBe("succeeded");
    expect(installed.status === "done" && installed.result.stages.map((s) => s.name + ":" + s.value)[0]).toMatch(/^Prepared:/u);
    expect(await cacheEntry(cache, "mongodb-mcp-server@3.0.5")).toBe(true);

    // Registry가 검토한 새 버전을 낸다(복사본의 Manifest만 바꾼다).
    const manifest = path.join(registry, "database", "mongodb-mcp-server.yaml");
    await writeFile(manifest, (await readFile(manifest, "utf8")).replaceAll("mongodb-mcp-server@3.0.5", "mongodb-mcp-server@3.0.6"));

    const step = async (op: "update" | "rollback" | "health") => {
      const plan = (await call(LIFECYCLE_PLAN_CHANNELS[op], ID)) as LifecyclePlanResponse;
      if (plan.status !== "ok") throw new Error(op + " " + JSON.stringify(plan));
      return (await call(LIFECYCLE_RUN_CHANNEL, ID)) as LifecycleRunResponse;
    };
    const status = async () => (await call(LIFECYCLE_STATUS_CHANNEL)) as LifecycleStatusResponse;
    expect((await status()).status).toBe("ok");
    const updated = await step("update");
    expect(updated.status === "done" && updated.result).toMatchObject({ status: "updated", outcome: "succeeded" });
    expect(await cacheEntry(cache, "mongodb-mcp-server@3.0.6")).toBe(true);
    expect(await readFile(path.join(project, ".mcp.json"), "utf8")).toContain("mongodb-mcp-server@3.0.6");
    await status();
    const rolled = await step("rollback");
    expect(rolled.status === "done" && rolled.result).toMatchObject({ status: "rolled-back", outcome: "succeeded" });
    expect(await readFile(path.join(project, ".mcp.json"), "utf8")).toContain("mongodb-mcp-server@3.0.5");
    await status();
    const health = await step("health");
    expect(health.status === "done" && health.result).toMatchObject({ status: "health-checked", outcome: "succeeded" });
    expect(life.healthRuns).toBe(3);
    const prepares = life.spawned.map((c) => c.slice(1).join(" ")).filter((c) => c.includes("--package="));
    expect(prepares.some((c) => c.includes("--package=mongodb-mcp-server@3.0.6"))).toBe(true);
    const state = await readLifecycleState({ homeDir: home });
    expect(state.ok && Object.values(state.state.entries)[0]?.artifact.requested).toContain("3.0.5");
    expect((await readdir(path.join(cache, "_npx"))).length).toBeGreaterThanOrEqual(2);
  });
});

const electronBin = (() => {
  try {
    return createRequire(path.join(DESKTOP, "package.json"))("electron") as string;
  } catch {
    return null;
  }
})();

async function smoke(env: Record<string, string>) {
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of Object.keys(childEnv)) if (k.startsWith("OPENHUB_SMOKE_") || k === "ELECTRON_RUN_AS_NODE" || k === "OPENHUB_SCREENSHOT") delete childEnv[k];
    Object.assign(childEnv, { OPENHUB_SMOKE_USER_DATA: path.join(scratch, "ud-" + String(Date.now())), OPENHUB_SMOKE_SYSTEM_LOCALE: "en-US" }, env);
    const child = spawn(electronBin!, [".", "--smoke"], { cwd: DESKTOP, env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("OPENHUB_SMOKE "));
  if (line === undefined) throw new Error("smoke 결과 없음: " + out.stderr.slice(-1500));
  return { code: out.code, smoke: JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as Record<string, any> };
}

describe.skipIf(process.env["OPENHUB_E2E"] !== "1" || electronBin === null)("v0.2.0 npx smoke 실제 Electron E2E", () => {
  it("npx 설치 → Update(Prepare) → Health → Rollback → Health(클릭), 정확한 버전 npx 설치 Prepare", async () => {
    await stat(electronBin!);
    await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: DESKTOP });
    const chain = await smoke({ OPENHUB_SMOKE_PROJECT: path.join(ROOT, "examples", "demo-project"), OPENHUB_SMOKE_INSTALL: "playwright-mcp", OPENHUB_SMOKE_UPDATE: "playwright-mcp", OPENHUB_SMOKE_ROLLBACK: "1" });
    expect(chain.code, JSON.stringify(chain.smoke.rollbackChain ?? chain.smoke.update)).toBe(0);
    expect(chain.smoke.install.status).toBe("succeeded");
    expect(chain.smoke.update.status).toBe("updated");
    expect(chain.smoke.rollbackChain.rollback).toMatchObject({ status: "rolled-back", outcome: "succeeded" });
    expect(chain.smoke.rollbackChain.health).toMatchObject({ status: "health-checked", outcome: "succeeded", after: ["state-consistent"] });
    expect((chain.smoke.rollbackChain.npmCalls as string[]).some((c) => c.includes("--package=@playwright/mcp@9.9.9"))).toBe(true);

    const project = path.join(scratch, "mongo-project");
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "mongodb": "^6.10.0" } }\n');
    await writeFile(path.join(project, ".mcp.json"), '{ "mcpServers": {} }\n');
    const mongo = await smoke({ OPENHUB_SMOKE_PROJECT: project, OPENHUB_SMOKE_INSTALL: MONGO });
    expect(mongo.code).toBe(0);
    expect(mongo.smoke.install.status).toBe("succeeded");
    expect(mongo.smoke.install.stages[0]).toMatch(/^Prepared:cached/u);
    console.log("npx smoke: " + JSON.stringify({ update: chain.smoke.update.status, rollback: chain.smoke.rollbackChain.rollback.status, health: chain.smoke.rollbackChain.health.status, mongoPrepared: mongo.smoke.install.stages[0] }));
  }, 300_000);

  it("정확한 버전 Update(선택 A): 목표 버전 입력 → 계획 → 승인 → V1 → V2 → Rollback V1 → Health(클릭), 형식이 틀린 값은 거부", async () => {
    await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: DESKTOP });
    const run = await smoke({ OPENHUB_SMOKE_PROJECT: path.join(ROOT, "examples", "demo-project"), OPENHUB_SMOKE_INSTALL: "playwright-mcp", OPENHUB_SMOKE_UPDATE: "playwright-mcp", OPENHUB_SMOKE_UPDATE_VERSIONS: "9.9.7,9.9.8", OPENHUB_SMOKE_ROLLBACK: "1" });
    const exact = run.smoke.exact;
    expect(run.code, JSON.stringify(exact)).toBe(0);
    expect(exact.invalid.status).toBe("not-executable");
    expect(exact.invalid.message).toContain("1.2.3");
    // 화면 입력의 앞뒤 공백은 고치지 않는다.
    expect(exact.invalidSpaces.status).toBe("not-executable");
    expect(exact.invalidSpaces.message).toContain("1.2.3");
    // renderer → 실제 preload → main: 잘못된 타입·값 14개 모두 invalid-version, 실행 요청은 no-plan, 대화상자·npm·resolver 증가 0.
    expect(exact.bridge.results).toHaveLength(14);
    expect(exact.bridge.results.filter((r: { plan: string; run: string }) => r.plan !== "invalid-version" || r.run !== "no-plan")).toEqual([]);
    expect(exact.bridgeCounters.after).toEqual(exact.bridgeCounters.before);
    expect(exact.steps.map((s: { version: string; result: { status: string; plan: { to: string } } }) => [s.version, s.result.status, s.result.plan.to])).toEqual([
      ["9.9.7", "updated", "@playwright/mcp@9.9.7"],
      ["9.9.8", "updated", "@playwright/mcp@9.9.8"],
    ]);
    expect(exact.steps[1].result.plan.from).toBe("@playwright/mcp@9.9.7");
    // 정확한 버전은 resolver가 조회하지 않는다.
    expect(exact.fetched).toBe(0);
    expect(run.smoke.rollbackChain.rollback).toMatchObject({ status: "rolled-back", outcome: "succeeded" });
    expect(run.smoke.rollbackChain.health).toMatchObject({ status: "health-checked", outcome: "succeeded", after: ["state-consistent"] });
    const npm = run.smoke.rollbackChain.npmCalls as string[];
    expect(npm.some((c) => c.includes("--package=@playwright/mcp@9.9.7"))).toBe(true);
    expect(npm.some((c) => c.includes("--package=@playwright/mcp@9.9.8"))).toBe(true);
    console.log("exact-version smoke: " + JSON.stringify({ steps: exact.steps.map((s: { version: string; result: { status: string } }) => s.version + "=" + s.result.status), rollback: run.smoke.rollbackChain.rollback.status, health: run.smoke.rollbackChain.health.status }));
  }, 300_000);
});

