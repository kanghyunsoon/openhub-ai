import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
  readJournals,
  recommend,
  recordInstallInState,
  requestLifecycleApproval,
  requestRecoveryApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  validateRegistry,
  withdrawnManifestError,
  withdrawnManifestOf,
  withdrawnToolOf,
  type ExecChild,
  type ExecSpawner,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { abandonOperationLock, newScratch } from "../lifecycle/helpers";
import { fakeNpmSpawner } from "../process/fake-npm";
import { REPO_ROOT, fixtureProfile, legacyMemoryEntry, seedEntries } from "../recommendation/helpers";

/**
 * v0.2.1 #69 Memory MCP 지원 중단. 기본 저장 파일(memory.jsonl)이 npx cache 안의 패키지 폴더에 있어 버전이 바뀌면 기억이 보이지 않거나
 * 지워진다(재현됨). OpenHub는 신규 설치·관리를 멈추고, 기존 Client 설정·Version State·기억 파일은 건드리지 않는다.
 * 실제 Registry(Memory MCP 없음)와 테스트 전용 예전 Manifest만 쓴다. 가짜 spawner·fetch·Health(network·실제 npm 0).
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
/** "예전 코드"로 설치·update를 시작한 사용자 재현용 테스트 스위치(제품 코드에는 이런 우회가 없다). */
async function asV020<T>(fn: () => Promise<T>): Promise<T> {
  v020.on = true;
  try {
    return await fn();
  } finally {
    v020.on = false;
  }
}

const seed = await seedEntries();
const memoryEntry = await legacyMemoryEntry();
/** 사용자 정의 Registry: 실제 Registry + 예전 Memory MCP Manifest. */
const legacy = [...seed, memoryEntry];
const scratch = await newScratch("v021-memory-withdrawn");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];
const ISSUE = "https://github.com/kanghyunsoon/openhub-ai/issues/69";
const PKG = "@modelcontextprotocol/server-memory";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** 실행을 세는 spawner(성공 흉내). 막힌 경로에서는 0이어야 한다. */
function countingSpawner() {
  const calls: string[][] = [];
  const spawner: ExecSpawner = (exe, args) => {
    calls.push([exe, ...args]);
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", 0, null));
    return { pid: 9300, stdout: null, stderr: new EventEmitter(), on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as unknown as ExecChild;
  };
  return { calls, spawner };
}

/** 예전 코드로 Memory MCP를 설치한 사용자 + 격리된 가짜 npx cache 안의 합성 기억 파일. */
async function legacyUser() {
  const h = await createHarness(scratch, { entries: legacy });
  const install = h.request("memory-mcp", CLAUDE);
  const { planned, done } = await asV020(async () => {
    const planned = await plannedOf(h, install);
    return { planned, done: await runInstallTransaction(planned, await approveAll(planned), install, h.env) };
  });
  expect(done.status).toBe("succeeded");
  expect(await recordInstallInState(planned, done, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-01T00:00:00.000Z") })).toMatchObject({ ok: true });
  // 격리된 npm cache(실제 사용자 cache 아님)에 Client가 만든 것과 같은 위치·형식의 합성 기억 파일
  const memoryFile = path.join(h.base, "npm-cache", "_npx", "15b07286cbcc3329", "node_modules", "@modelcontextprotocol", "server-memory", "dist", "memory.jsonl");
  await mkdir(path.dirname(memoryFile), { recursive: true });
  await writeFile(memoryFile, '{"type":"entity","name":"Alice-synthetic","entityType":"person","observations":["likes tea"]}\n{"type":"relation","from":"Alice-synthetic","to":"ProjectX-synthetic","relationType":"works_on"}\n');
  const mcpFile = path.join(h.projectRoot, ".mcp.json");
  const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
  const files = async () => [await readFile(mcpFile, "utf8"), await readFile(stateFile, "utf8"), sha(await readFile(memoryFile, "utf8"))] as const;
  const counter = countingSpawner();
  const fetched: string[] = [];
  let healthRuns = 0;
  const env = (entries: readonly RegistryEntry[], over: Partial<LifecycleEnvironment> = {}): LifecycleEnvironment => ({
    loadEntries: async () => entries,
    probe: () => h.env.probe(),
    tempBase: h.base,
    now: () => new Date("2026-10-12T00:00:00.000Z"),
    configFs: h.env.configFs!,
    spawner: counter.spawner,
    fetch: async (url: string) => (fetched.push(url), url.includes("server-memory") ? new Response(JSON.stringify({ name: PKG, version: "1.0.0" }), { status: 200 }) : new Response("missing", { status: 404 })),
    mcpSourceEnv: () => ({}),
    runHealth: async () => (healthRuns++, { ok: true, result: { status: "healthy", reason: null, toolCount: 9, environmentUnverified: false, terminated: true, excerpt: null } }),
    ...over,
  });
  const request = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets: CLAUDE });
  const status = async (entries: readonly RegistryEntry[] = seed) => {
    const s = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "linux", includeUser: false });
    if (!s.ok) throw new Error(s.code);
    return s.items.filter((i) => i.toolId === "memory-mcp");
  };
  return { h, files, env, request, status, memoryFile, counter, fetched, health: () => healthRuns };
}

describe("v0.2.1 #69 Memory MCP 지원 중단: 신규 설치 차단과 기존 사용자 데이터 보존", () => {
  it("지원 중단 목록: 사유·Issue #69·since 0.2.1, 공유 저장소와 흔한 alias(memory)는 식별에 쓰지 않고 정확한 npm 패키지·Tool ID만 쓴다", () => {
    const tool = withdrawnToolOf("memory-mcp");
    expect(tool).toMatchObject({ since: "0.2.1", issue: ISSUE, identity: { repositories: [], mcpServerNames: [], pypiPackages: [], npmPackages: [PKG] } });
    expect(tool!.reason).toContain("memory.jsonl");
    expect(tool!.advice).toContain("MEMORY_FILE_PATH");
  });

  it("1·2. 기존 Memory MCP State를 읽고 상태를 그대로 보여 주며, 지원 중단 안내 줄이 붙는다", async () => {
    const u = await legacyUser();
    const items = await u.status();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ toolId: "memory-mcp", state: "state-consistent", client: "claude-code", scope: "project" });
    const lines = formatLifecycleStatusItem(items[0]!);
    expect(lines.find((l) => l.includes("지원 중단"))).toContain(ISSUE);
  });

  it("3. 신규 설치는 TOOL_WITHDRAWN(사유·백업 안내·Issue #69)이고 실행·쓰기 0이다. 실제·사용자 Registry 모두 추천에 나오지 않는다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const built = await planInstall(h.request("memory-mcp", CLAUDE), h.env);
    expect(built.result).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    if (!built.result.ok) {
      expect(built.result.message).toContain(ISSUE);
      expect(built.result.message).toContain("MEMORY_FILE_PATH");
      expect(built.result.message).toContain("기존 Client 설정과 Version State는 지우지 않았습니다");
    }
    expect(h.writes).toEqual([]);
    expect(h.spawns).toEqual([]);
    const profile = await fixtureProfile("react-pnpm");
    for (const entries of [seed, legacy]) {
      const report = recommend(profile, entries, undefined);
      expect(report.recommendations.map((r) => r.toolId)).not.toContain("memory-mcp");
      expect(report.needs.flatMap((n) => n.candidates.map((c) => c.toolId))).not.toContain("memory-mcp");
    }
  });

  it("4. update·rollback·health·repair·adopt·Benchmark: 계획 0, MCP 실행 0, npm 조회 0, Health 0, 설정·State·기억 파일 그대로(실제·사용자 Registry 모두)", async () => {
    const u = await legacyUser();
    const before = await u.files();
    for (const entries of [seed, legacy]) {
      for (const operation of ["update", "rollback", "health", "repair"] as const) {
        const built = await planLifecycleRequest(u.request(operation), u.env(entries));
        expect(built, operation).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
        if (!built.ok) expect(built.message, operation).toContain(ISSUE);
      }
      expect(await planAdopt({ toolId: "memory-mcp", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, entries, platform: "linux", client: "claude-code", scope: "project" })).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      expect(await planBenchmark({ toolId: "memory-mcp", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, entries, platform: "linux", includeUser: false, mcpSourceEnv: () => ({}) })).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    }
    expect(u.counter.calls).toEqual([]);
    expect(u.fetched).toEqual([]);
    expect(u.health()).toBe(0);
    expect(await u.files()).toEqual(before);
  });

  it("5. Manifest가 없어도 중단된 Memory MCP update를 Journal Recovery(undo)로 되돌린다. 기억 파일은 그대로다", async () => {
    const u = await legacyUser();
    const before = await u.files();
    await asV020(async () => {
      const built = await planLifecycleRequest(u.request("update"), u.env(legacy));
      if (!built.ok) throw new Error(built.code + " " + built.message);
      expect(built.planned.plan.status).toBe("ready");
      const approved = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (approved.status !== "approved") throw new Error(approved.status);
      let reached!: () => void;
      const inHealth = new Promise<void>((r) => (reached = r));
      // 예전 코드의 npx Prepare는 격리된 가짜 npm cache에 받는다(실제 npm·사용자 cache 아님).
      const npm = fakeNpmSpawner({ cacheRoot: path.join(u.h.base, "npm-prepare-cache") });
      void runLifecycleTransaction(built.planned, approved.approval, u.request("update"), u.env(legacy, { spawner: npm.spawner, runHealth: () => (reached(), new Promise(() => undefined)) }));
      await inHealth;
    });
    await abandonOperationLock(u.h.homeDir);
    expect((await u.files())[0]).not.toBe(before[0]);
    expect((await u.status())[0]).toMatchObject({ state: "interrupted-update" });
    for (const operation of ["update", "health"] as const) expect(await planLifecycleRequest(u.request(operation), u.env(legacy)), operation).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
    const options = { toolId: "memory-mcp", projectRoot: u.h.projectRoot, homeDir: u.h.homeDir, mode: "undo" as const };
    const plan = await planRecovery(options);
    if (!plan.ok) throw new Error(plan.code);
    const ok = await requestRecoveryApproval(plan.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (ok.status !== "approved") throw new Error(ok.status);
    const result = await executeRecovery(ok.approval, { ...options, regenerate: () => planRecovery(options) });
    expect(result).toMatchObject({ status: "recovered", toolId: "memory-mcp", error: null });
    expect(await u.files()).toEqual(before);
    const journals = await readJournals(u.h.homeDir);
    expect(journals.ok && journals.journals).toEqual([]);
    expect((await u.status())[0]).toMatchObject({ state: "state-consistent" });
  });

  it("6. 다른 Registry 도구(같은 modelcontextprotocol 계열 포함)의 설치·추천에는 영향이 없다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const c7 = await plannedOf(h, h.request("context7", CLAUDE));
    expect(c7.plan.status).toBe("installable");
    expect(seed.map((e) => e.manifest.name).filter((n) => withdrawnManifestOf(seed.find((e) => e.manifest.name === n)!.manifest) !== undefined)).toEqual([]);
    const report = recommend(await fixtureProfile("react-pnpm"), seed, undefined);
    expect(report.recommendations.map((r) => r.toolId)).toEqual(expect.arrayContaining(["playwright-mcp", "chrome-devtools-mcp", "context7"]));
  });

  it("Registry에 Memory MCP Manifest가 다시 들어오면 검증 오류다", async () => {
    const root = path.join(scratch, "registry-with-memory");
    await cp(path.join(REPO_ROOT, "registry"), root, { recursive: true });
    await mkdir(path.join(root, "memory"), { recursive: true });
    await writeFile(path.join(root, "memory", "memory-mcp.yaml"), await readFile(path.join(REPO_ROOT, "packages", "core", "test", "fixtures", "registry-legacy", "memory", "memory-mcp.yaml"), "utf8"));
    const { issues } = await validateRegistry(root);
    expect(issues.some((i) => i.file.includes("memory-mcp") && i.message.includes("지원 중단"))).toBe(true);
    expect((await validateRegistry(path.join(REPO_ROOT, "registry"))).issues).toEqual([]);
  });
});

describe("v0.2.1 #69 npm 패키지 식별: 우회 차단과 오탐 방지", () => {
  const renamed = (name: string, over: { repo?: string; alias?: string; command?: string; fallbackPackage?: string }): RegistryEntry => ({
    ...memoryEntry,
    manifest: {
      ...memoryEntry.manifest,
      name,
      repository: { ...memoryEntry.manifest.repository, github: over.repo ?? "someone/notes" },
      recommendation: { ...memoryEntry.manifest.recommendation!, identity: { mcpServerNames: [over.alias ?? name] } },
      install: { ...memoryEntry.manifest.install, options: { command: over.command ?? "npx -y @someone/notes-mcp" }, fallback: over.fallbackPackage === undefined ? [] : [{ adapter: "npm", package: over.fallbackPackage }] },
    },
  });

  it("이름·저장소·alias를 바꿔도 npm 패키지가 Memory MCP면 막는다(npx가 받는 패키지 지정 형식 전부와 npm alias, fallback)", async () => {
    const forms = [
      "npx -y @modelcontextprotocol/server-memory",
      "npx -y @modelcontextprotocol/server-memory@1.0.0",
      "npx -y @modelcontextprotocol/server-memory@latest",
      "npx --yes @modelcontextprotocol/server-memory@2026.8.31",
      "npx -y --package=@modelcontextprotocol/server-memory mcp-server-memory",
      "npx -y --package @modelcontextprotocol/server-memory mcp-server-memory",
      "npx -y -p @modelcontextprotocol/server-memory@1.0.0 mcp-server-memory",
      "npx -y notes@npm:@modelcontextprotocol/server-memory@1.0.0",
      "npx -y npm:@modelcontextprotocol/server-memory",
      "npx -y -- @modelcontextprotocol/server-memory",
      "npx -y @ModelContextProtocol/Server-Memory",
      "npx --package=@modelcontextprotocol/server-memory@1.0.0 -y -- mcp-server-memory",
      "npx -y memory@npm:@modelcontextprotocol/server-memory",
    ];
    for (const command of forms) {
      const entry = renamed("notes-mcp", { command });
      expect(withdrawnManifestOf(entry.manifest)?.toolId, command).toBe("memory-mcp");
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      const built = await planInstall(h.request("notes-mcp", CLAUDE), h.env);
      expect(built.result, command).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      if (!built.result.ok) expect(built.result.message, command).toContain("지원 중단 도구 Memory MCP로 식별됩니다");
      expect(h.writes, command).toEqual([]);
      expect(h.spawns, command).toEqual([]);
    }
    expect(withdrawnManifestOf(renamed("notes-mcp", { fallbackPackage: PKG }).manifest)?.toolId).toBe("memory-mcp");
    expect(withdrawnManifestOf(renamed("memory-mcp", {}).manifest)?.toolId).toBe("memory-mcp");
    // alias가 memory이든 아니든 실제 패키지가 Memory MCP면 막는다.
    for (const alias of ["memory", "notes"]) expect(withdrawnManifestOf(renamed("notes-mcp", { alias, command: "npx -y " + PKG + "@1.0.0" }).manifest)?.toolId, alias).toBe("memory-mcp");
  });

  it("alias memory만 같은 무관한 npm 패키지는 막지 않는다(#72 리뷰): 설치 계획이 TOOL_WITHDRAWN이 아니다", async () => {
    const unrelated = ["npx -y @someone/notes-mcp", "npx -y mcp-memory-lite@1.0.0", "npx -y @acme/memory-server@2.1.0", "npx -y @modelcontextprotocol/server-filesystem"];
    for (const command of unrelated) {
      const entry = renamed("my-memory", { command, alias: "memory" });
      expect(withdrawnManifestOf(entry.manifest), command).toBeUndefined();
      expect(withdrawnManifestError(entry.manifest), command).toBeUndefined();
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      const built = await planInstall(h.request("my-memory", CLAUDE), h.env);
      expect(built.result, command).toMatchObject({ ok: true });
    }
    // 지원 중단 판정을 좁혀도 기존 명령 검증 정책은 그대로다: 절대 경로 인자는 지원 중단이 아니라 명령 검증으로 거부된다.
    const absolute = renamed("my-memory", { command: "npx -y @modelcontextprotocol/server-filesystem /tmp", alias: "memory" });
    expect(withdrawnManifestOf(absolute.manifest)).toBeUndefined();
    const h = await createHarness(scratch, { entries: [...seed, absolute] });
    const rejected = await planInstall(h.request("my-memory", CLAUDE), h.env);
    expect(rejected.result.ok).toBe(false);
    if (!rejected.result.ok) expect(rejected.result.code).not.toBe("TOOL_WITHDRAWN");
    expect(h.writes).toEqual([]);
    expect(h.spawns).toEqual([]);
  });

  it("공유 저장소 modelcontextprotocol/servers의 다른 서버와 비슷한 이름의 패키지는 막지 않는다", async () => {
    const allowed = [
      "npx -y @modelcontextprotocol/server-filesystem /tmp",
      "npx -y @modelcontextprotocol/server-everything@2026.7.4",
      "npx -y @modelcontextprotocol/server-sequential-thinking",
      "npx -y @modelcontextprotocol/server-memory-plus",
      "npx -y @someone/server-memory",
      "npx -y server-memory",
      "npx -y @modelcontextprotocol/server-memorystore",
      "npx -y @someone/notes-mcp --label server-memory",
    ];
    for (const command of allowed) {
      const entry = renamed("notes-mcp", { command, repo: "modelcontextprotocol/servers", alias: "notes" });
      expect(withdrawnManifestOf(entry.manifest), command).toBeUndefined();
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      const built = await planInstall(h.request("notes-mcp", CLAUDE), h.env);
      if (!built.result.ok) expect(built.result.code, command).not.toBe("TOOL_WITHDRAWN");
    }
    for (const e of seed) expect(withdrawnManifestOf(e.manifest), e.manifest.name).toBeUndefined();
  });

  it("사용자 Registry에 Memory MCP(이름 바꿈 포함)가 있어도 추천 후보가 아니다", async () => {
    const profile = await fixtureProfile("react-pnpm");
    for (const entries of [legacy, [...seed, renamed("notes-mcp", { command: "npx -y " + PKG + "@1.0.0", alias: "notes" })]]) {
      const report = recommend(profile, entries, undefined);
      const ids = [...report.recommendations.map((r) => r.toolId), ...report.needs.flatMap((n) => n.candidates.map((c) => c.toolId))];
      expect(ids).not.toContain("memory-mcp");
      expect(ids).not.toContain("notes-mcp");
    }
  });
});

