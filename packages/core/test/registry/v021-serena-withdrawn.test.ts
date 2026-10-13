import { EventEmitter } from "node:events";
import { cp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  executeRecovery,
  formatLifecycleStatusItem,
  lifecycleStatus,
  planAdopt,
  planBenchmark,
  planInstall,
  planLifecycleRequest,
  planRecovery,
  precheckPinokioRequest,
  readJournals,
  recommend,
  recordInstallInState,
  requestLifecycleApproval,
  requestRecoveryApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  validateRegistry,
  withdrawnManifestOf,
  type ExecChild,
  type ExecSpawner,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { abandonOperationLock, newScratch } from "../lifecycle/helpers";
import { REPO_ROOT, fixtureProfile, legacySerenaEntry, seedEntries } from "../recommendation/helpers";

/**
 * v0.2.1 #39(D1) Serena 신규 설치 중단과 기존 사용자 호환. 실제 Registry(Serena 없음)와 테스트 전용 v0.2.0 Serena Manifest만 쓴다.
 * 가짜 spawner·fetch·Health(network·실제 uv 0). 기존 Client 설정·Version State·Journal은 지우지 않고, 복구는 Manifest 없이 동작해야 한다.
 */

/**
 * "v0.2.0 코드"로 설치·update를 시작한 사용자를 재현하기 위한 테스트 전용 스위치. v0.2.0에는 지원 중단 목록이 없었으므로, 켜져 있는
 * 동안만 판정 함수가 목록을 보지 않는다(제품 코드에는 이런 우회가 없다). 기존 사용자 상태를 만든 뒤에는 항상 끈다.
 */
const v020 = vi.hoisted(() => ({ on: false }));
vi.mock("../../src/registry/withdrawn", async (importOriginal) => {
  const m = await importOriginal<typeof import("../../src/registry/withdrawn")>();
  return {
    ...m,
    resolveRegistryTool: <E extends RegistryEntry>(entries: readonly E[], toolId: string) => {
      if (!v020.on) return m.resolveRegistryTool(entries, toolId);
      const entry = entries.find((e) => e.manifest.name === toolId);
      return entry === undefined ? { ok: false as const, code: "TOOL_NOT_FOUND" as const, message: "Registry에 없는 Tool입니다" } : { ok: true as const, entry };
    },
    withdrawnManifestOf: (manifest: RegistryEntry["manifest"]) => (v020.on ? undefined : m.withdrawnManifestOf(manifest)),
    withdrawnManifestError: (manifest: RegistryEntry["manifest"]) => (v020.on ? undefined : m.withdrawnManifestError(manifest)),
  };
});
async function asV020<T>(fn: () => Promise<T>): Promise<T> {
  v020.on = true;
  try {
    return await fn();
  } finally {
    v020.on = false;
  }
}

const seed = await seedEntries();
const serenaEntry = await legacySerenaEntry();
/** 사용자 정의 Registry: 실제 Registry + v0.2.0 Serena Manifest. */
const legacy = [...seed, serenaEntry];
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
  const { planned, done } = await asV020(async () => {
    const planned = await plannedOf(h, install);
    return { planned, done: await runInstallTransaction(planned, await approveAll(planned), install, h.env) };
  });
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
  const status = async (entries: readonly RegistryEntry[] = seed) => {
    const s = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "linux", includeUser: false });
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
    await asV020(async () => {
      const built = await planLifecycleRequest(u.request("update"), u.env(legacy));
      if (!built.ok) throw new Error(built.code + " " + built.message);
      expect(built.planned.plan.status).toBe("ready");
      const approved = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (approved.status !== "approved") throw new Error(approved.status);
      let reached!: () => void;
      const inHealth = new Promise<void>((r) => (reached = r));
      void runLifecycleTransaction(built.planned, approved.approval, u.request("update"), u.env(legacy, { runHealth: () => (reached(), new Promise(() => undefined)) }));
      await inHealth;
    });
    await abandonOperationLock(u.h.homeDir);
    expect((await u.files())[0]).not.toBe(before[0]);
    // 이제 v0.2.1 코드: 실제 Registry(Serena 없음)와 사용자 Registry(Serena 있음) 모두 상태는 중단으로 보이고, 복구는 Manifest 없이 된다.
    expect((await u.status())[0]).toMatchObject({ state: "interrupted-update" });
    expect((await u.status(legacy))[0]).toMatchObject({ state: "interrupted-update" });
    // 사용자 Registry에 Serena가 있어도 update·health로 우회할 수 없다(중단 상태에서도 계획 0).
    for (const operation of ["update", "health"] as const) expect(await planLifecycleRequest(u.request(operation), u.env(legacy)), operation).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
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
    expect((await u.status(legacy))[0]).toMatchObject({ state: "state-consistent" });
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

/** v0.2.1 #39 독립 리뷰: Registry 검증만 믿지 않고 Core 계획 단계에서 막는다. */
describe("v0.2.1 #39 리뷰: 사용자 Registry·직접 넘긴 Manifest의 Serena도 계획 단계에서 막는다", () => {
  const renamed = (name: string, over: { repo?: string; alias?: string; command?: string; fallbackPackage?: string }): RegistryEntry => ({
    ...serenaEntry,
    manifest: {
      ...serenaEntry.manifest,
      name,
      repository: { ...serenaEntry.manifest.repository, github: over.repo ?? "someone/code-nav" },
      recommendation: { ...serenaEntry.manifest.recommendation!, identity: { mcpServerNames: [over.alias ?? name] } },
      install: { ...serenaEntry.manifest.install, options: { command: over.command ?? "uvx --from code-nav==1.0.0 code-nav" }, fallback: over.fallbackPackage === undefined ? [] : [{ adapter: "uv", package: over.fallbackPackage }] },
    },
  });

  it("사용자 Registry에 Serena Manifest가 있어도 설치·update·rollback·health·repair·adopt·Benchmark는 TOOL_WITHDRAWN이고 쓰기 0이다", async () => {
    const h = await createHarness(scratch, { entries: legacy });
    const built = await planInstall(h.request("serena", CURSOR), h.env);
    expect(built.result).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    if (!built.result.ok) expect(built.result.message).toContain(ISSUE);
    expect(h.writes).toEqual([]);
    const u = await legacyUser();
    const before = await u.files();
    for (const operation of ["update", "rollback", "health", "repair"] as const) {
      const plan = await planLifecycleRequest(u.request(operation), u.env(legacy));
      expect(plan, operation).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      if (!plan.ok) expect(plan.message, operation).toContain(ISSUE);
    }
    expect(await planAdopt({ toolId: "serena", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, entries: legacy, platform: "linux", client: "cursor", scope: "project" })).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    expect(await planBenchmark({ toolId: "serena", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, entries: legacy, platform: "linux", includeUser: false, mcpSourceEnv: () => ({}) })).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    expect(await u.files()).toEqual(before);
  });

  it("사용자 Registry에 Serena가 있어도 추천 후보가 아니다(v0.2.0 코드였다면 추천됐을 프로젝트)", async () => {
    const profile = await fixtureProfile("react-pnpm");
    const old = await asV020(async () => recommend(profile, legacy, undefined));
    expect(old.recommendations.map((r) => r.toolId)).toContain("serena");
    const report = recommend(profile, legacy, undefined);
    expect(report.recommendations.map((r) => r.toolId)).not.toContain("serena");
    expect(report.needs.flatMap((n) => n.candidates.map((c) => c.toolId))).not.toContain("serena");
    // 다른 도구의 추천은 실제 Registry만 쓸 때와 같다.
    expect(report.recommendations.map((r) => r.toolId)).toEqual(recommend(profile, seed, undefined).recommendations.map((r) => r.toolId));
  });

  it("이름을 바꾼 Manifest도 저장소·canonical MCP alias·PyPI 패키지(git 저장소 포함)로 식별해 막는다. 비슷한 다른 패키지는 막지 않는다", async () => {
    const cases: [string, RegistryEntry][] = [
      ["저장소", renamed("code-nav-a", { repo: "Oraios/Serena" })],
      ["MCP alias", renamed("code-nav-b", { alias: "serena" })],
      ["PyPI 패키지(PEP 503 표기 차이)", renamed("code-nav-c", { command: "uvx --from Serena_Agent==1.7.0 serena start-mcp-server" })],
      ["git 저장소", renamed("code-nav-d", { command: "uvx --from git+https://github.com/oraios/serena serena start-mcp-server" })],
      ["fallback 패키지", renamed("code-nav-e", { fallbackPackage: "serena-agent" })],
    ];
    for (const [label, entry] of cases) {
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      const built = await planInstall(h.request(entry.manifest.name, CURSOR), h.env);
      expect(built.result, label).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      if (!built.result.ok) expect(built.result.message, label).toContain("지원 중단 도구 Serena로 식별됩니다");
      expect(h.writes, label).toEqual([]);
      expect(precheckPinokioRequest({ operation: "install", manifest: entry.manifest }), label).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    }
    const lookalike = renamed("code-nav-ok", { command: "uvx --from serena-agentx==1.0.0 serena start-mcp-server" });
    expect(withdrawnManifestOf(lookalike.manifest)).toBeUndefined();
    const h = await createHarness(scratch, { entries: [...seed, lookalike] });
    expect((await planInstall(h.request("code-nav-ok", CURSOR), h.env)).result).toMatchObject({ ok: true });
    // 실제 Registry 도구는 하나도 지원 중단으로 식별되지 않는다.
    expect(seed.filter((e) => withdrawnManifestOf(e.manifest) !== undefined)).toEqual([]);
  });

  // #39 2차 리뷰: 이름·저장소·MCP alias를 모두 바꾸고 PyPI 패키지만 Serena로 남긴 Manifest. uvx가 실제로 받는 인자 형식(uvx 0.12.3 실측) 전부.
  it("PyPI 패키지만 Serena인 Manifest를 uvx가 받는 모든 인자 형식(--from=·--with=·-w·-wX·-w=X·-qw·쉼표 목록·위치 인자·--)에서 막는다", async () => {
    const forms = [
      "uvx --from=serena-agent==1.7.0 serena start-mcp-server",
      "uvx --from serena-agent==1.7.0 serena start-mcp-server",
      "uvx --from=Serena.Agent[extra]==1.7.0 serena start-mcp-server",
      "uvx --from=serena-agent@1.7.0 serena start-mcp-server",
      "uvx --with=serena-agent==1.7.0 code-nav",
      "uvx -w serena-agent==1.7.0 code-nav",
      "uvx -wserena-agent==1.7.0 code-nav",
      "uvx -w=serena-agent code-nav",
      "uvx -qw serena-agent code-nav",
      "uvx -qwserena-agent code-nav",
      "uvx --with mcp==1.30.0,serena-agent==1.7.0 code-nav",
      "uvx serena-agent@1.7.0",
      "uvx -- serena-agent",
    ];
    for (const command of forms) {
      const entry = renamed("pkg-only", { command });
      expect(entry.manifest.repository.github, command).toBe("someone/code-nav");
      expect(entry.manifest.recommendation?.identity?.mcpServerNames, command).toEqual(["pkg-only"]);
      expect(withdrawnManifestOf(entry.manifest)?.toolId, command).toBe("serena");
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      const built = await planInstall(h.request("pkg-only", CURSOR), h.env);
      expect(built.result, command).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      expect(h.writes, command).toEqual([]);
      expect(precheckPinokioRequest({ operation: "install", manifest: entry.manifest }), command).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    }
  });

  it("정상적인 다른 패키지는 과도하게 막지 않는다(비슷한 이름, 명령 뒤 인자, 실제 Registry). 붙여 쓴 형식은 지원 중단이 아니라 형식 거부다", async () => {
    const allowed = [
      "uvx --from serena-agentx==1.0.0 serena start-mcp-server",
      "uvx --from code-nav==1.0.0 --with serena-agent-tools==1.0.0 code-nav",
      "uvx --from code-nav==1.0.0 code-nav --model serena",
      "uvx --from code-nav==1.0.0 code-nav --model serena-agent",
      "uvx --from my-serena-agent==1.0.0 serena",
    ];
    for (const command of allowed) {
      const entry = renamed("code-nav-ok", { command });
      expect(withdrawnManifestOf(entry.manifest), command).toBeUndefined();
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      expect((await planInstall(h.request("code-nav-ok", CURSOR), h.env)).result, command).toMatchObject({ ok: true });
    }
    // uvx는 받지만 OpenHub가 Prepare·update·artifact 판정에서 다루지 않는 형식: 지원 중단이 아니고 MANIFEST_COMMAND_REJECTED로 실행 0
    const attached = renamed("code-nav-attached", { command: "uvx --from=code-nav==1.0.0 code-nav" });
    expect(withdrawnManifestOf(attached.manifest)).toBeUndefined();
    const h = await createHarness(scratch, { entries: [...seed, attached] });
    expect((await planInstall(h.request("code-nav-attached", CURSOR), h.env)).result).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
    expect(h.writes).toEqual([]);
    expect(seed.filter((e) => withdrawnManifestOf(e.manifest) !== undefined)).toEqual([]);
  });

  it("직접 넘긴 Serena Manifest로 Pinokio install·update·rollback·health 계획을 만들지 않는다(probe 전에 막는다)", () => {
    for (const operation of ["install", "update", "rollback", "health"] as const) {
      const r = precheckPinokioRequest({ operation, manifest: serenaEntry.manifest });
      expect(r, operation).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      if (!r.ok) expect(r.message, operation).toContain(ISSUE);
    }
  });

  it("사용자 Registry에 Serena가 있어도 기존 사용자의 상태 조회는 그대로이고 지원 중단 안내가 붙는다", async () => {
    const u = await legacyUser();
    const items = await u.status(legacy);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ toolId: "serena", state: "state-consistent", client: "cursor", scope: "project" });
    expect(formatLifecycleStatusItem(items[0]!).find((l) => l.includes("지원 중단"))).toContain(ISSUE);
  });
});
