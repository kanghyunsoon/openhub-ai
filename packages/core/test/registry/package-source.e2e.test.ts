import os from "node:os";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTreeKiller,
  locateWindowsNpxLauncher,
  mcpServerChildEnv,
  nodeExecSpawner,
  nodeHealthSpawner,
  npmChildEnv,
  planBenchmark,
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  uvChildEnv,
  type HealthSpawnOptions,
  type InstallEnvironment,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.1 #46 리뷰(A안) 실제 E2E: 패키지 출처 불변성(OPENHUB_E2E=1 그리고 OPENHUB_SOURCE_E2E=1에서만). 실제 uv·npm·network를 쓴다.
 * - 사내 index·registry 대신 공개 mirror(mirrors.aliyun.com/pypi, registry.npmmirror.com)를 쓴다. 인증 정보는 합성 값이다(mirror는 무시한다).
 * - 매 경우 빈 cache(UV_CACHE_DIR·npm_config_cache)에서 시작한다. Registry Manifest는 메모리에서만 정확한 버전으로 바꾼다.
 * - uvx(postgres-mcp)는 OPENHUB_UVX_E2E_DATABASE_URI(버리는 테스트 DB)가 있을 때만 실행한다.
 */
const skip = process.env["OPENHUB_E2E"] !== "1" || process.env["OPENHUB_SOURCE_E2E"] !== "1";
const DB = process.env["OPENHUB_UVX_E2E_DATABASE_URI"];
const platform = process.platform === "win32" ? ("windows" as const) : ("linux" as const);
const SECRET = "synthetic-e2e-index-secret-7731";
const PYPI_MIRROR = "https://mirrors.aliyun.com/pypi/simple/";
const NPM_MIRROR = "https://registry.npmmirror.com/";
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];
const NOTES = { command: "uvx", args: ["notes-mcp==1.0.0"] };
const TOOLS = {
  postgres: { toolId: "postgres-mcp", command: "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted" },
  memory: { toolId: "memory-mcp", command: "npx -y @modelcontextprotocol/server-memory@2026.8.31" },
} as const;
const seed = skip ? [] : await seedEntries();

async function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map(Object.keys(vars).map((k) => [k, process.env[k]] as const));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 빈 cache에서 설치(실제 Prepare)한 뒤 Health 계획을 만들고, ready면 실제 Health를 실행한다. Health spawn의 환경을 기록한다. */
async function installThenHealth(tool: keyof typeof TOOLS, vars: Record<string, string>, opts: { changeAfterApproval?: Record<string, string>; omitSource?: boolean } = {}) {
  const { toolId, command } = TOOLS[tool];
  const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-src-e2e-"));
  const cache = await mkdtemp(path.join(os.tmpdir(), "openhub-src-cache-"));
  const cacheVar = tool === "postgres" ? { UV_CACHE_DIR: cache } : { npm_config_cache: cache };
  // 승인 뒤 바꿀 변수도 withEnv가 원래 값으로 되돌리도록 키를 미리 넣는다(값은 시작 값).
  const restoreKeys = Object.fromEntries(Object.keys(opts.changeAfterApproval ?? {}).filter((k) => !(k in vars)).map((k) => [k, process.env[k] ?? ""]));
  return withEnv({ ...restoreKeys, ...cacheVar, ...(tool === "postgres" && DB !== undefined ? { DATABASE_URI: DB } : {}), ...vars }, async () => {
    const entries: RegistryEntry[] = seed.map((e) => (e.manifest.name === toolId ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command } } } } : e));
    const h = await createHarness(scratch, { entries, verify: false });
    await writeFile(path.join(h.projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { notes: NOTES } }, null, 2) + "\n");
    const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
    const { spawner: _fake, ...rest } = h.env;
    const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env), uvChildEnv: () => uvChildEnv(process.env) };
    const request = { ...h.request(toolId, CLAUDE), platform };
    const planned = await plannedOf({ ...h, env }, request);
    const installed = await runInstallTransaction(planned, await approveAll(planned), request, env);
    const config = await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8");
    const spawned: Record<string, string>[] = [];
    if (installed.status !== "succeeded") return { installed, config, health: null, plan: null, spawned, benchmark: null, cache };
    expect(await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
    const life: LifecycleEnvironment = {
      loadEntries: async () => entries,
      probe: () => h.env.probe(),
      tempBase: os.tmpdir(),
      now: () => new Date(),
      spawner: nodeExecSpawner,
      windowsNpx: async () => windowsNpx,
      killTree: createTreeKiller({ cwd: os.tmpdir() }),
      npmChildEnv: () => npmChildEnv(process.env),
      uvChildEnv: () => uvChildEnv(process.env),
      ...(opts.omitSource === true ? {} : { mcpSourceEnv: () => process.env }),
      healthSpawner: (exe: string, args: readonly string[], options: HealthSpawnOptions) => (spawned.push({ ...(options.env ?? {}) }), nodeHealthSpawner(exe, args, options)),
    };
    const req: LifecycleRequest = { operation: "health", toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, platform, includeUser: false, targets: CLAUDE };
    const built = await planLifecycleRequest(req, life);
    if (!built.ok) throw new Error(built.code + " " + built.message);
    const benchmark = await planBenchmark({ toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: false, mcpSourceEnv: () => process.env });
    if (built.planned.plan.status !== "ready") return { installed, config, health: null, plan: built.planned.plan, spawned, benchmark, cache };
    const ok = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (ok.status !== "approved") throw new Error(ok.status);
    if (opts.changeAfterApproval !== undefined) Object.assign(process.env, opts.changeAfterApproval);
    return { installed, config, health: await runLifecycleTransaction(built.planned, ok.approval, req, life), plan: built.planned.plan, spawned, benchmark, cache };
  });
}

const valueOf = (env: Record<string, string>, name: string) => Object.entries(env).find(([k]) => k.toUpperCase() === name)?.[1];

describe.skipIf(skip)("v0.2.1 패키지 출처 불변성 실제 E2E(uv·npm)", () => {
  it("npx 기본 공개 registry: 준비 뒤 Health healthy", async () => {
    const r = await installThenHealth("memory", {});
    expect(r.installed.status).toBe("succeeded");
    expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
  }, 600_000);

  it("npx 인증 정보 없는 사내 registry(mirror): Health가 같은 registry 값을 받고 healthy", async () => {
    const r = await installThenHealth("memory", { npm_config_registry: NPM_MIRROR });
    expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    expect(r.spawned).toHaveLength(1);
    expect(valueOf(r.spawned[0]!, "NPM_CONFIG_REGISTRY")).toBe(NPM_MIRROR);
  }, 600_000);

  it("npx URL에 인증 정보가 든 registry: Prepare는 그 registry로 성공하지만 Health·Benchmark는 막히고 spawn 0, 값 0", async () => {
    const r = await installThenHealth("memory", { npm_config_registry: "https://probe:" + SECRET + "@registry.npmmirror.com/" });
    expect(r.installed.status).toBe("succeeded");
    expect(r.plan?.status).toBe("blocked");
    expect(r.plan?.warnings.map((w) => w.code)).toContain("PACKAGE_SOURCE_UNVERIFIED");
    expect(r.benchmark?.ok && r.benchmark.planned.plan.blockers.map((b) => b.code)).toContain("BENCHMARK_PACKAGE_SOURCE_UNVERIFIED");
    expect(r.spawned).toEqual([]);
    for (const text of [JSON.stringify(r.plan), JSON.stringify(r.installed), r.config, JSON.stringify(r.benchmark)]) expect(text).not.toContain(SECRET);
  }, 600_000);

  it("npx 인증 정보를 .npmrc로 옮기면(환경변수 없음) Health가 같은 설정 파일을 읽고 healthy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openhub-src-npmrc-"));
    const npmrc = path.join(dir, ".npmrc");
    await writeFile(npmrc, "registry=https://probe:" + SECRET + "@registry.npmmirror.com/\n");
    const r = await installThenHealth("memory", { npm_config_userconfig: npmrc });
    expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    expect(valueOf(r.spawned[0]!, "NPM_CONFIG_USERCONFIG")).toBe(npmrc);
    for (const text of [JSON.stringify(r.plan), JSON.stringify(r.health), r.config]) expect(text).not.toContain(SECRET);
  }, 600_000);

  it("npx registry 접속 실패: Prepare가 실패하고 설정은 그대로이며 공개 registry로 fallback하지 않는다", async () => {
    const r = await installThenHealth("memory", { npm_config_registry: "http://127.0.0.1:9/", npm_config_fetch_retries: "0" });
    expect(r.installed.status).toBe("failed");
    expect(r.config).not.toContain("server-memory");
    expect(r.spawned).toEqual([]);
  }, 600_000);

  // #46 리뷰 경계 사례 1·2(실제 npm): 승인 뒤 인증 정보 없는 registry 주소 변경, 원본 누락.
  it("npx 사내 registry(mirror)로 승인한 뒤 다른 registry 주소로 바뀌면 PLAN_STALE이고 spawn 0이다", async () => {
    const r = await installThenHealth("memory", { npm_config_registry: NPM_MIRROR }, { changeAfterApproval: { npm_config_registry: "https://registry.npmjs.org/" } });
    expect(r.installed.status).toBe("succeeded");
    expect(r.plan?.steps.find((s) => s.kind === "health")).toMatchObject({ packageSource: expect.stringMatching(/^sha256:/u) });
    expect(r.health).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(r.spawned).toEqual([]);
  }, 600_000);

  it("npx Health 환경 원본이 없으면(누락) 계획이 PACKAGE_SOURCE_UNVERIFIED로 막히고 spawn 0이다", async () => {
    const r = await installThenHealth("memory", {}, { omitSource: true });
    expect(r.installed.status).toBe("succeeded");
    expect(r.plan?.status).toBe("blocked");
    expect(r.plan?.warnings.map((w) => w.code)).toContain("PACKAGE_SOURCE_UNVERIFIED");
    expect(r.spawned).toEqual([]);
  }, 600_000);

  it.skipIf(DB === undefined)("uvx 인증 정보 없는 사내 index(mirror): Health가 같은 index 값을 받고 healthy", async () => {
    const r = await installThenHealth("postgres", { UV_INDEX_URL: PYPI_MIRROR });
    expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    expect(valueOf(r.spawned[0]!, "UV_INDEX_URL")).toBe(PYPI_MIRROR);
  }, 900_000);

  it.skipIf(DB === undefined)("uvx URL에 인증 정보가 든 index: Prepare는 성공하지만 Health·Benchmark는 막히고 spawn 0, 값 0", async () => {
    const credentialed = "https://probe:" + SECRET + "@mirrors.aliyun.com/pypi/simple/";
    const r = await installThenHealth("postgres", { UV_INDEX_URL: credentialed });
    expect(r.installed.status).toBe("succeeded");
    expect(r.plan?.warnings.map((w) => w.code)).toContain("PACKAGE_SOURCE_UNVERIFIED");
    expect(r.benchmark?.ok && r.benchmark.planned.plan.blockers.map((b) => b.code)).toContain("BENCHMARK_PACKAGE_SOURCE_UNVERIFIED");
    expect(r.spawned).toEqual([]);
    for (const text of [JSON.stringify(r.plan), JSON.stringify(r.installed), r.config, JSON.stringify(r.benchmark)]) expect(text).not.toContain(SECRET);
    // 수정 전 재현: 이 수정 전 Health가 쓰던 환경(허용 목록으로 걸러 인증 index가 빠진 환경)으로 같은 고정 명령을 실행하면, 준비된 cache를
    // 쓰지 않고 기본 공개 index에서 다시 해석·설치한다(다른 출처). 이 수정 뒤 Health·Benchmark는 위처럼 이 명령을 실행하지 않는다(spawn 0).
    const preFixHealthEnv = { ...mcpServerChildEnv({ ...process.env, UV_CACHE_DIR: r.cache, UV_INDEX_URL: credentialed }, { backend: "uvx", declaredNames: [] }) };
    expect(Object.keys(preFixHealthEnv).some((k) => k.toUpperCase() === "UV_INDEX_URL")).toBe(false);
    const repro = spawnSync("uvx", ["--no-build", "--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "python", "-c", "pass"], { env: preFixHealthEnv, encoding: "utf8", shell: false, timeout: 600_000 });
    expect(repro.status).toBe(0);
    expect(repro.stderr).toMatch(/Installed \d+ packages/u);
  }, 900_000);

  it.skipIf(DB === undefined)("uvx 인증 정보를 uv.toml로 옮기면(UV_CONFIG_FILE) Health가 같은 설정 파일을 읽고 healthy", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "openhub-src-uvtoml-"));
    const file = path.join(dir, "uv.toml");
    await writeFile(file, '[[index]]\nurl = "https://probe:' + SECRET + '@mirrors.aliyun.com/pypi/simple/"\ndefault = true\n');
    const r = await installThenHealth("postgres", { UV_CONFIG_FILE: file });
    expect(r.installed.status).toBe("succeeded");
    expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    expect(valueOf(r.spawned[0]!, "UV_CONFIG_FILE")).toBe(file);
    for (const text of [JSON.stringify(r.plan), JSON.stringify(r.installed), JSON.stringify(r.health), r.config]) expect(text).not.toContain(SECRET);
  }, 900_000);

  it.skipIf(DB === undefined)("uvx index 접속 실패: Prepare가 실패하고 설정은 그대로이며 공개 index로 fallback하지 않는다", async () => {
    const r = await installThenHealth("postgres", { UV_INDEX_URL: "http://127.0.0.1:9/simple/" });
    expect(r.installed.status).toBe("failed");
    expect(r.config).not.toContain("postgres-mcp");
    expect(r.spawned).toEqual([]);
  }, 900_000);
});
