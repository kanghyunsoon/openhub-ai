import "./locale-ko";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { INSTALL_PLAN_CHANNEL, INSTALL_RUN_CHANNEL, InstallSession, registerInstall, smokeInstallDeps, type InstallPlanResponse, type InstallRunResponse } from "../src/install";
import { PROJECT_SCAN_CHANNEL, registerProjectScan } from "../src/project-scan";
import { PROJECT_RECOMMEND_CHANNEL, RecommendSession, registerProjectRecommend } from "../src/recommend";

/**
 * v0.2.1 P0-1 재현: 프로젝트 A의 추천이 보이는 동안 프로젝트 B를 고르고, B 분석이 끝나기 전에 설치를 계획·실행하면
 * A의 추천(postgres-mcp)이 B에 쓰이면 안 된다. 선택 취소·응답 순서 역전도 본다. main IPC를 그대로 호출한다.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY = path.join(ROOT, "registry");
const SEED = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-v021-race-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

async function setup() {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const a = path.join(base, "project-a");
  const b = path.join(base, "project-b");
  const home = path.join(base, "home");
  for (const d of [a, b, home]) await mkdir(d);
  await writeFile(path.join(a, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  await writeFile(path.join(a, ".mcp.json"), '{ "mcpServers": {} }\n');
  await writeFile(path.join(b, "README.md"), "# notes only\n");
  await writeFile(path.join(b, ".mcp.json"), '{ "mcpServers": {} }\n');
  const picks: Array<() => Promise<string | undefined>> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn) };
  const rs = new RecommendSession();
  const is = new InstallSession();
  registerProjectScan(rs.observe(ipc), is.trackPicker(async () => (picks.shift() ?? (async () => undefined))()));
  registerProjectRecommend(ipc, rs, { registryDir: REGISTRY, metadataFile: SEED, platform: "linux" });
  const deps = smokeInstallDeps(path.join(base, "npm-cache"));
  registerInstall(ipc, is, { registryDir: REGISTRY, metadataFile: SEED, platform: "linux", homeDir: home, recommend: rs, dialog: deps.dialog, probe: deps.probe, spawner: deps.spawner });
  const call = (ch: string, ...args: unknown[]) => handlers.get(ch)!({}, ...args);
  return {
    a,
    b,
    is,
    rs,
    pick: (f: () => Promise<string | undefined>) => picks.push(f),
    scan: () => call(PROJECT_SCAN_CHANNEL) as Promise<{ status: string }>,
    recommend: () => call(PROJECT_RECOMMEND_CHANNEL) as Promise<{ status: string; view?: { items?: { toolId: string }[] } }>,
    plan: (toolId: string) => call(INSTALL_PLAN_CHANNEL, toolId) as Promise<InstallPlanResponse>,
    run: (toolId: string) => call(INSTALL_RUN_CHANNEL, toolId) as Promise<InstallRunResponse>,
    mcp: (dir: string) => readFile(path.join(dir, ".mcp.json"), "utf8"),
    dialogs: deps,
  };
}

describe("v0.2.1 P0-1 프로젝트 전환 경쟁 조건", () => {
  it("A 추천 표시 → B 선택(분석 중) → 설치 계획·실행: B에 쓰기 0, A에도 쓰기 0", async () => {
    const s = await setup();
    s.pick(async () => s.a);
    expect((await s.scan()).status).toBe("ok");
    await s.recommend();
    const bBefore = await s.mcp(s.b);
    const aBefore = await s.mcp(s.a);
    s.pick(async () => s.b);
    const scanB = s.scan();
    // B 폴더 선택이 반영된 직후(분석은 아직 진행 중) 화면에 남아 있던 A의 [설치]를 누른다.
    for (let i = 0; i < 20 && s.is.projectDir !== s.b; i += 1) await Promise.resolve();
    const profileAtPlan = s.rs.profile?.project.name ?? "none";
    const plan = await s.plan("postgres-mcp");
    const run = await s.run("postgres-mcp");
    await scanB;
    expect(await s.mcp(s.b), JSON.stringify({ plan: plan.status, run: run.status, profileAtPlan, dirAtPlan: "b" })).toBe(bBefore);
    expect(await s.mcp(s.a)).toBe(aBefore);
    expect(run.status).not.toBe("done");
  });

  it("선택 응답 순서 역전(A 선택이 늦게 끝남): 마지막으로 고른 프로젝트만 현재 프로젝트다", async () => {
    const s = await setup();
    const slowA = deferred<string | undefined>();
    s.pick(() => slowA.promise);
    const scanA = s.scan();
    s.pick(async () => s.b);
    expect((await s.scan()).status).toBe("ok");
    slowA.resolve(s.a);
    await scanA;
    // 늦게 끝난 A 선택이 현재 프로젝트·Profile을 덮어쓰면 안 된다.
    expect(s.is.projectDir).toBe(s.b);
    expect(s.rs.profile?.project.name).toBe(path.basename(s.b));
    const plan = await s.plan("postgres-mcp");
    expect(plan.status).not.toBe("ok");
  });

  it("선택 취소: 기존 프로젝트와 Profile을 유지한다", async () => {
    const s = await setup();
    s.pick(async () => s.a);
    await s.scan();
    s.pick(async () => undefined);
    expect((await s.scan()).status).toBe("canceled");
    expect(s.is.projectDir).toBe(s.a);
    expect((await s.plan("postgres-mcp")).status).toBe("ok");
  });

  it("A에서 만든 Pending Plan은 B 폴더를 고르는 순간 버려진다(실행 0), 분석 중에는 현재 프로젝트가 없다", async () => {
    const s = await setup();
    s.pick(async () => s.a);
    await s.scan();
    expect((await s.plan("postgres-mcp")).status).toBe("ok");
    const aBefore = await s.mcp(s.a);
    s.pick(async () => s.b);
    const scanB = s.scan();
    for (let i = 0; i < 20 && s.is.profile !== undefined; i += 1) await Promise.resolve();
    // 분석 중: 경로·Profile 없음(INSTALLED·Release도 이 경로를 쓴다).
    expect(s.is.projectDir).toBeUndefined();
    expect(s.is.profile).toBeUndefined();
    expect((await s.run("postgres-mcp")).status).toBe("no-plan");
    await scanB;
    expect(s.is.projectDir).toBe(s.b);
    expect(await s.mcp(s.a)).toBe(aBefore);
  });

  it("선택 IPC를 겹쳐 두 번 호출해도(대화상자 두 번) 나중에 시작한 선택만 남고 먼저 시작한 쪽은 superseded다", async () => {
    const s = await setup();
    const first = deferred<string | undefined>();
    const second = deferred<string | undefined>();
    s.pick(() => first.promise);
    s.pick(() => second.promise);
    const one = s.scan();
    const two = s.scan();
    second.resolve(s.b);
    first.resolve(s.a);
    expect([(await one).status, (await two).status]).toEqual(["superseded", "ok"]);
    expect(s.is.projectDir).toBe(s.b);
    expect(s.rs.profile).toBe(s.is.profile);
  });
});
