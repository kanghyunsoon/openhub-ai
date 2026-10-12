import { EventEmitter } from "node:events";
import { cp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  executeRecovery,
  formatLifecycleStatusItem,
  lifecycleStatus,
  planAdopt,
  planBenchmark,
  planInstall,
  planLifecycleRequest,
  planRecovery,
  readJournals,
  recommend,
  recordInstallInState,
  requestLifecycleApproval,
  requestRecoveryApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  validateRegistry,
  type ExecChild,
  type ExecSpawner,
  type LifecycleEnvironment,
  type LifecycleRequest,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { abandonOperationLock, newScratch } from "../lifecycle/helpers";
import { REPO_ROOT, fixtureProfile, legacySerenaEntry, seedEntries } from "../recommendation/helpers";

/**
 * v0.2.1 #39(D1) Serena 신규 설치 중단과 기존 사용자 호환. 실제 Registry(Serena 없음)와 테스트 전용 v0.2.0 Serena Manifest만 쓴다.
 * 가짜 spawner·fetch·Health(network·실제 uv 0). 기존 Client 설정·Version State·Journal은 지우지 않고, 복구는 Manifest 없이 동작해야 한다.
 */
const seed = await seedEntries();
const legacy = [...seed, await legacySerenaEntry()];
const scratch = await newScratch("v021-serena-withdrawn");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const CURSOR = [{ client: "cursor" as const, scope: "project" as const }];
const ISSUE = "https://github.com/kanghyunsoon/openhub-ai/issues/59";

/** uvx 준비 단계 가짜(성공). */
const okSpawner: ExecSpawner = () => {
  const events = new EventEmitter();
  queueMicrotask(() => events.emit("close", 0, null));
  return { pid: 9200, stdout: null, stderr: new EventEmitter(), on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as unknown as ExecChild;
};

/** v0.2.0에 Serena를 설치한 사용자(테스트 전용 Manifest로 설치·기록). */
async function legacyUser() {
  const h = await createHarness(scratch, { entries: legacy });
  const install = h.request("serena", CURSOR);
  const planned = await plannedOf(h, install);
  const done = await runInstallTransaction(planned, await approveAll(planned), install, h.env);
  expect(done.status).toBe("succeeded");
  expect(await recordInstallInState(planned, done, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-01T00:00:00.000Z") })).toMatchObject({ ok: true });
  const cursorFile = path.join(h.projectRoot, ".cursor", "mcp.json");
  const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
  const files = async () => [await readFile(cursorFile, "utf8"), await readFile(stateFile, "utf8")] as const;
  const env = (entries: typeof seed, over: Partial<LifecycleEnvironment> = {}): LifecycleEnvironment => ({
    loadEntries: async () => entries,
    probe: () => h.env.probe(),
    tempBase: h.base,
    now: () => new Date("2026-10-12T00:00:00.000Z"),
    configFs: h.env.configFs!,
    spawner: okSpawner,
    fetch: async (url: string) => (url.startsWith("https://pypi.org/pypi/serena-agent") ? new Response(JSON.stringify({ info: { name: "serena-agent", version: "1.7.0" } }), { status: 200 }) : new Response("missing", { status: 404 })),
    mcpSourceEnv: () => ({}),
    runHealth: async () => ({ ok: true, result: { status: "healthy", reason: null, toolCount: 5, environmentUnverified: false, terminated: true, excerpt: null } }),
    ...over,
  });
  const request = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId: "serena", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets: CURSOR });
  const status = async () => {
    const s = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false });
    if (!s.ok) throw new Error(s.code);
    return s.items.filter((i) => i.toolId === "serena");
  };
  return { h, files, env, request, status, cursorFile };
}

describe("v0.2.1 #39 Serena 지원 중단(D1): 신규 설치 차단과 기존 사용자 호환", () => {
  it("1·2. 기존 Serena State를 읽고 상태를 그대로 보여 주며, 지원 중단 안내 줄이 붙는다", async () => {
    const u = await legacyUser();
    const items = await u.status();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ toolId: "serena", state: "state-consistent", client: "cursor", scope: "project" });
    const lines = formatLifecycleStatusItem(items[0]!);
    expect(lines.find((l) => l.includes("지원 중단"))).toContain(ISSUE);
  });

  it("3. 신규 설치는 TOOL_WITHDRAWN(사유·Issue #59)이고 설정 파일을 만들지 않는다. 추천에도 나오지 않는다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const built = await planInstall(h.request("serena", CURSOR), h.env);
    expect(built.result).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    if (!built.result.ok) expect(built.result.message).toContain(ISSUE);
    expect(h.writes).toEqual([]);
    const report = recommend(await fixtureProfile("react-pnpm"), seed, undefined);
    expect(report.recommendations.map((r) => r.toolId)).not.toContain("serena");
    expect(report.needs.flatMap((n) => n.candidates.map((c) => c.toolId))).not.toContain("serena");
  });

  it("4. update·rollback·health·repair·adopt·Benchmark는 계획을 만들지 않고 정확한 사유를 안내하며 설정·State는 그대로다", async () => {
    const u = await legacyUser();
    const before = await u.files();
    for (const operation of ["update", "rollback", "health", "repair"] as const) {
      const built = await planLifecycleRequest(u.request(operation), u.env(seed));
      expect(built, operation).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      if (!built.ok) expect(built.message, operation).toContain("기존 Client 설정과 Version State는 지우지 않았습니다");
    }
    const adopt = await planAdopt({ toolId: "serena", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, entries: seed, platform: "linux", client: "cursor", scope: "project" });
    expect(adopt).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    const bench = await planBenchmark({ toolId: "serena", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, entries: seed, platform: "linux", includeUser: false, mcpSourceEnv: () => ({}) });
    expect(bench).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    expect(await u.files()).toEqual(before);
  });

  it("5. Manifest가 없어도 중단된 Serena update를 Journal Recovery(undo)로 되돌린다(설정·State 원래대로, Journal 정리)", async () => {
    const u = await legacyUser();
    const before = await u.files();
    // v0.2.0 Registry(테스트 전용 Manifest)로 update를 시작해 Health에서 멈춘다(강제 종료와 같은 디스크 상태).
    const built = await planLifecycleRequest(u.request("update"), u.env(legacy));
    if (!built.ok) throw new Error(built.code + " " + built.message);
    expect(built.planned.plan.status).toBe("ready");
    const approved = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (approved.status !== "approved") throw new Error(approved.status);
    let reached!: () => void;
    const inHealth = new Promise<void>((r) => (reached = r));
    void runLifecycleTransaction(built.planned, approved.approval, u.request("update"), u.env(legacy, { runHealth: () => (reached(), new Promise(() => undefined)) }));
    await inHealth;
    await abandonOperationLock(u.h.homeDir);
    expect((await u.files())[0]).not.toBe(before[0]);
    // 이제 실제 Registry(Serena 없음): 상태는 중단으로 보이고, 복구 계획·실행은 Manifest 없이 된다.
    expect((await u.status())[0]).toMatchObject({ state: "interrupted-update" });
    const options = { toolId: "serena", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, mode: "undo" as const };
    const plan = await planRecovery(options);
    if (!plan.ok) throw new Error(plan.code);
    const ok = await requestRecoveryApproval(plan.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (ok.status !== "approved") throw new Error(ok.status);
    const result = await executeRecovery(ok.approval, { ...options, regenerate: () => planRecovery(options) });
    expect(result).toMatchObject({ status: "recovered", toolId: "serena", error: null });
    expect(await u.files()).toEqual(before);
    const journals = await readJournals(u.h.homeDir);
    expect(journals.ok && journals.journals).toEqual([]);
    expect((await u.status())[0]).toMatchObject({ state: "state-consistent" });
  });

  it("6. 다른 Registry 도구의 설치·추천에는 영향이 없다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const memory = await plannedOf(h, h.request("memory-mcp", CURSOR));
    expect(memory.plan.status).toBe("installable");
    const report = recommend(await fixtureProfile("react-pnpm"), seed, undefined);
    expect(report.recommendations.map((r) => r.toolId)).toEqual(expect.arrayContaining(["playwright-mcp", "chrome-devtools-mcp", "context7"]));
  });

  it("Registry에 지원 중단 도구의 Manifest가 다시 들어오면 검증 오류다", async () => {
    const root = path.join(scratch, "registry-with-serena");
    await cp(path.join(REPO_ROOT, "registry"), root, { recursive: true });
    await mkdir(path.join(root, "coding-agent"), { recursive: true });
    await writeFile(path.join(root, "coding-agent", "serena.yaml"), await readFile(path.join(REPO_ROOT, "packages", "core", "test", "fixtures", "registry-legacy", "coding-agent", "serena.yaml"), "utf8"));
    const { issues } = await validateRegistry(root);
    expect(issues.some((i) => i.file.includes("serena") && i.message.includes("지원 중단"))).toBe(true);
    expect((await validateRegistry(path.join(REPO_ROOT, "registry"))).issues).toEqual([]);
  });
});
