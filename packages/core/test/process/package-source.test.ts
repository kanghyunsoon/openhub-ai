import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  mcpPackageSourceMismatch,
  mcpPackageSourceMismatchOf,
  mcpServerChildEnv,
  planBenchmark,
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type HealthSpawnOptions,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.1 #46 리뷰(A안): 패키지 출처 불변성. Prepare가 uv·npm에 넘기는 index·registry 설정을 MCP 서버(Health·Benchmark) 환경에 같은 값으로
 * 넘길 수 없으면(인증 정보가 든 URL 등) 실행하지 않는다(spawn 0). 공개 index로 fallback하지 않고, 인증 정보를 MCP 서버에 넘기지 않는다.
 * 합성 값만 쓴다(실제 자격증명·network 0).
 */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-pkg-source-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

const SECRET = "synthetic-registry-secret-0001";
const BASE = { PATH: "/usr/bin", HOME: "/home/u", TEMP: "/tmp", UV_CACHE_DIR: "/c/uv", NPM_CONFIG_CACHE: "/c/npm" };

describe("mcpPackageSourceMismatch(이름만, 값 없음)", () => {
  it("기본 공개 index·registry(설정 없음)와 인증 정보 없는 사내 index·registry는 그대로 넘기고 불일치가 없다", () => {
    for (const backend of ["uvx", "npx"] as const) expect(mcpPackageSourceMismatch(BASE, backend)).toEqual([]);
    const corp = { ...BASE, UV_INDEX_URL: "https://pypi.corp.example/simple", UV_EXTRA_INDEX_URL: "https://extra.corp.example/simple", NPM_CONFIG_REGISTRY: "https://npm.corp.example/" };
    expect(mcpPackageSourceMismatch(corp, "uvx")).toEqual([]);
    expect(mcpPackageSourceMismatch(corp, "npx")).toEqual([]);
    expect(mcpServerChildEnv(corp, { backend: "uvx", declaredNames: [] })).toMatchObject({ UV_INDEX_URL: corp.UV_INDEX_URL, UV_EXTRA_INDEX_URL: corp.UV_EXTRA_INDEX_URL });
    expect(mcpServerChildEnv(corp, { backend: "npx", declaredNames: [] })).toMatchObject({ NPM_CONFIG_REGISTRY: corp.NPM_CONFIG_REGISTRY });
  });

  const credentialed: [string, "uvx" | "npx", Record<string, string>, string[]][] = [
    ["UV_INDEX_URL userinfo", "uvx", { UV_INDEX_URL: "https://u:" + SECRET + "@pypi.corp.example/simple" }, ["UV_INDEX_URL"]],
    ["UV_DEFAULT_INDEX userinfo", "uvx", { UV_DEFAULT_INDEX: "https://u:" + SECRET + "@pypi.corp.example/simple" }, ["UV_DEFAULT_INDEX"]],
    ["UV_EXTRA_INDEX_URL userinfo", "uvx", { UV_EXTRA_INDEX_URL: "https://u:" + SECRET + "@extra.corp.example/simple" }, ["UV_EXTRA_INDEX_URL"]],
    ["UV_INDEX 이름 있는 목록 안의 userinfo", "uvx", { UV_INDEX: "pub=https://pypi.org/simple corp=https://u:" + SECRET + "@pypi.corp.example/simple" }, ["UV_INDEX"]],
    ["UV_INDEX_URL query token", "uvx", { UV_INDEX_URL: "https://pypi.corp.example/simple?token=" + SECRET }, ["UV_INDEX_URL"]],
    ["UV_INDEX_URL fragment", "uvx", { UV_INDEX_URL: "https://pypi.corp.example/simple#" + SECRET }, ["UV_INDEX_URL"]],
    ["uv 이름 있는 index 인증", "uvx", { UV_INDEX: "corp=https://pypi.corp.example/simple", UV_INDEX_CORP_USERNAME: "u", UV_INDEX_CORP_PASSWORD: SECRET }, ["UV_INDEX_CORP_PASSWORD", "UV_INDEX_CORP_USERNAME"]],
    ["NPM_CONFIG_REGISTRY userinfo", "npx", { NPM_CONFIG_REGISTRY: "https://u:" + SECRET + "@npm.corp.example/" }, ["NPM_CONFIG_REGISTRY"]],
    ["npm registry query(소문자 이름)", "npx", { npm_config_registry: "https://npm.corp.example/?auth=" + SECRET }, ["NPM_CONFIG_REGISTRY"]],
    ["환경변수로만 둔 npm scope registry", "npx", { "npm_config_@corp:registry": "https://npm.corp.example/" }, ["NPM_CONFIG_@CORP:REGISTRY"]],
    ["Windows식 소문자 이름(uv)", "uvx", { uv_index_url: "https://u:" + SECRET + "@pypi.corp.example/simple" }, ["UV_INDEX_URL"]],
  ];
  for (const [name, backend, vars, expected] of credentialed) {
    it(name + " → 불일치(" + expected.join(",") + "), MCP 서버 환경에 값 0", () => {
      const source = { ...BASE, ...vars };
      expect(mcpPackageSourceMismatch(source, backend)).toEqual(expected);
      const child = mcpServerChildEnv(source, { backend, declaredNames: [] });
      expect(JSON.stringify(child)).not.toContain(SECRET);
      expect(JSON.stringify(mcpPackageSourceMismatch(source, backend))).not.toContain(SECRET);
    });
  }

  it("출처를 바꾸지 않는 npm 인증 값(NPM_TOKEN·_authToken)만 있으면 불일치가 아니다(MCP 서버에도 넘기지 않는다)", () => {
    const source = { ...BASE, NPM_TOKEN: SECRET, "npm_config_//registry.npmjs.org/:_authToken": SECRET, NODE_AUTH_TOKEN: SECRET };
    expect(mcpPackageSourceMismatch(source, "npx")).toEqual([]);
    expect(JSON.stringify(mcpServerChildEnv(source, { backend: "npx", declaredNames: [] }))).not.toContain(SECRET);
  });

  it("backend별로 따로 본다. docker는 검사하지 않는다", () => {
    const source = { ...BASE, UV_INDEX_URL: "https://u:" + SECRET + "@pypi.corp.example/simple", NPM_CONFIG_REGISTRY: "https://u:" + SECRET + "@npm.corp.example/" };
    expect(mcpPackageSourceMismatch(source, "uvx")).toEqual(["UV_INDEX_URL"]);
    expect(mcpPackageSourceMismatch(source, "npx")).toEqual(["NPM_CONFIG_REGISTRY"]);
    expect(mcpPackageSourceMismatch(source, "docker")).toEqual([]);
  });

  it("원본이 없거나 예외를 던지면 빈 원본이다(이때 MCP 서버 환경도 비어 출처 설정이 없다)", () => {
    expect(mcpPackageSourceMismatchOf(undefined, "uvx")).toEqual([]);
    expect(mcpPackageSourceMismatchOf(() => { throw new Error("boom"); }, "npx")).toEqual([]);
  });
});

describe("Lifecycle Health·Benchmark: 출처를 확인할 수 없으면 실행하지 않는다", () => {
  const PIN = "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted";
  const CURSOR = [{ client: "cursor" as const, scope: "project" as const }];
  const CLEAN = () => ({ ...BASE, DATABASE_URI: "postgresql://probe:synthetic-declared@db/app" });
  const CREDENTIALED = () => ({ ...CLEAN(), UV_INDEX_URL: "https://u:" + SECRET + "@pypi.corp.example/simple" });

  async function installed() {
    const seed = await seedEntries();
    const entries: RegistryEntry[] = seed.map((e) => (e.manifest.name === "postgres-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: PIN } } } } : e));
    const h = await createHarness(scratch, { entries });
    const install = h.request("postgres-mcp", CURSOR);
    const planned = await plannedOf(h, install);
    const done = await runInstallTransaction(planned, await approveAll(planned), install, h.env);
    expect(done.status).toBe("succeeded");
    expect(await recordInstallInState(planned, done, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-12T00:00:00.000Z") })).toMatchObject({ ok: true });
    const spawned: string[] = [];
    let source: () => Record<string, string> = CLEAN;
    const env: LifecycleEnvironment = {
      loadEntries: async () => entries,
      probe: () => h.env.probe(),
      tempBase: h.base,
      now: () => new Date("2026-10-12T00:00:00.000Z"),
      configFs: h.env.configFs!,
      healthSpawner: (exe: string, _args: readonly string[], _options: HealthSpawnOptions) => {
        spawned.push(exe);
        throw new Error("spawn은 일어나면 안 된다");
      },
      mcpSourceEnv: () => source(),
    };
    const request = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId: "postgres-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets: CURSOR });
    return { h, entries, env, spawned, request, setSource: (s: () => Record<string, string>) => void (source = s) };
  }

  it("health 계획: 인증 정보가 든 UV_INDEX_URL이면 PACKAGE_SOURCE_UNVERIFIED로 막히고(승인 불가) 계획에 값이 없다", async () => {
    const c = await installed();
    c.setSource(CREDENTIALED);
    const built = await planLifecycleRequest(c.request("health"), c.env);
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.status).toBe("blocked");
    const warning = built.planned.plan.warnings.find((w) => w.code === "PACKAGE_SOURCE_UNVERIFIED");
    expect(warning?.message).toContain("UV_INDEX_URL");
    expect(warning?.message).toContain("uv.toml");
    expect(JSON.stringify(built.planned.plan)).not.toContain(SECRET);
    expect((await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) })).status).not.toBe("approved");
    expect(c.spawned).toEqual([]);
  });

  it("update 계획도 Health를 실행하므로 막힌다. 인증 정보 없는 사내 index는 막지 않는다", async () => {
    const c = await installed();
    c.setSource(CREDENTIALED);
    const blocked = await planLifecycleRequest({ ...c.request("update"), to: "0.3.0" }, c.env);
    if (!blocked.ok) throw new Error(blocked.code);
    expect(blocked.planned.plan.warnings.map((w) => w.code)).toContain("PACKAGE_SOURCE_UNVERIFIED");
    c.setSource(() => ({ ...CLEAN(), UV_INDEX_URL: "https://pypi.corp.example/simple" }));
    const health = await planLifecycleRequest(c.request("health"), c.env);
    if (!health.ok) throw new Error(health.code);
    expect(health.planned.plan.warnings.map((w) => w.code)).not.toContain("PACKAGE_SOURCE_UNVERIFIED");
  });

  it("승인 뒤 환경변수가 인증 정보가 든 index로 바뀌면 PLAN_STALE이고 spawn 0이다(새 계획·승인 필요)", async () => {
    const c = await installed();
    const built = await planLifecycleRequest(c.request("health"), c.env);
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.status).toBe("ready");
    const approved = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (approved.status !== "approved") throw new Error(approved.status);
    c.setSource(CREDENTIALED);
    const result = await runLifecycleTransaction(built.planned, approved.approval, c.request("health"), c.env);
    expect(result).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(c.spawned).toEqual([]);
    expect(JSON.stringify(result)).not.toContain(SECRET);
  });

  it("Benchmark 계획도 같은 이유로 막힌다(BENCHMARK_PACKAGE_SOURCE_UNVERIFIED, 값 없음)", async () => {
    const c = await installed();
    const base = { toolId: "postgres-mcp", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, entries: c.entries, platform: "linux" as const, includeUser: false, fs: c.h.env.configFs! };
    const blocked = await planBenchmark({ ...base, mcpSourceEnv: CREDENTIALED });
    if (!blocked.ok) throw new Error(blocked.code);
    expect(blocked.planned.plan.blockers.map((b) => b.code)).toContain("BENCHMARK_PACKAGE_SOURCE_UNVERIFIED");
    expect(JSON.stringify(blocked.planned.plan)).not.toContain(SECRET);
    const clean = await planBenchmark({ ...base, mcpSourceEnv: CLEAN });
    if (!clean.ok) throw new Error(clean.code);
    expect(clean.planned.plan.blockers.map((b) => b.code)).not.toContain("BENCHMARK_PACKAGE_SOURCE_UNVERIFIED");
  });
});
