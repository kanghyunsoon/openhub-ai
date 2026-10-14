import { EventEmitter } from "node:events";
import { readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PACKAGE_SOURCE_UNAVAILABLE_MESSAGE,
  mcpPackageSourceCheck,
  mcpPackageSourceMismatch,
  mcpServerChildEnv,
  planBenchmark,
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  runHealthCheck,
  type ExecChild,
  type ExecSpawner,
  type HealthSpawner,
  type HealthSpawnOptions,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedWithNpxFixture } from "../recommendation/helpers";

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

  // 수정 전(5454c36): 원본 누락·예외를 빈 원본으로 보고 불일치 없음([])을 돌려줘 npx·uvx Health가 출처 확인 없이 실행될 수 있었다.
  it("원본 누락·예외·객체가 아닌 값은 출처를 확인할 수 없다(source-unavailable). 명시적인 빈 원본은 출처 설정이 없는 정상 환경이다", () => {
    for (const backend of ["uvx", "npx"] as const) {
      expect(mcpPackageSourceCheck(undefined, backend)).toEqual({ ok: false, reason: "source-unavailable", names: [] });
      expect(mcpPackageSourceCheck(() => { throw new Error("boom"); }, backend)).toEqual({ ok: false, reason: "source-unavailable", names: [] });
      expect(mcpPackageSourceCheck((() => null) as never, backend)).toEqual({ ok: false, reason: "source-unavailable", names: [] });
      expect(mcpPackageSourceCheck(() => ({}), backend)).toEqual({ ok: true, digest: null });
    }
    // docker는 패키지 출처 확인 대상이 아니다.
    expect(mcpPackageSourceCheck(undefined, "docker")).toEqual({ ok: true, digest: null });
  });

  it("승인할 출처 digest: 주소·설정 추가·제거마다 다르고, 공개 기본값(설정 없음)은 null이며, 값은 digest에만 들어간다", () => {
    const digest = (vars: Record<string, string>, backend: "uvx" | "npx") => {
      const c = mcpPackageSourceCheck(() => ({ ...BASE, ...vars }), backend);
      if (!c.ok) throw new Error(c.reason);
      return c.digest;
    };
    const a = digest({ NPM_CONFIG_REGISTRY: "https://mirror-a.example/" }, "npx");
    const b = digest({ NPM_CONFIG_REGISTRY: "https://mirror-b.example/" }, "npx");
    expect(a).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(a).not.toBe(b);
    expect(digest({}, "npx")).toBeNull();
    expect(digest({ npm_config_registry: "https://mirror-a.example/" }, "npx")).toBe(a);
    const ua = digest({ UV_INDEX_URL: "https://mirror-a.example/simple" }, "uvx");
    expect(ua).not.toBe(digest({ UV_INDEX_URL: "https://mirror-b.example/simple" }, "uvx"));
    expect(ua).not.toBe(digest({ UV_INDEX_URL: "https://mirror-a.example/simple", UV_EXTRA_INDEX_URL: "https://extra.example/simple" }, "uvx"));
    expect(digest({}, "uvx")).toBeNull();
    expect(String(a) + String(ua)).not.toContain("mirror-a");
  });
});

describe("Lifecycle Health·Benchmark: 출처를 확인할 수 없으면 실행하지 않는다", () => {
  const PIN = "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted";
  const NPX_PIN = "npx -y @openhub-fixture/npx-mcp@2026.8.31";
  const CURSOR = [{ client: "cursor" as const, scope: "project" as const }];
  const CLEAN = () => ({ ...BASE, DATABASE_URI: "postgresql://probe:synthetic-declared@db/app" });
  const CREDENTIALED = () => ({ ...CLEAN(), UV_INDEX_URL: "https://u:" + SECRET + "@pypi.corp.example/simple" });

  /** uvx 준비 단계 가짜(성공). onSpawn은 spawn마다 불린다(Prepare 도중 환경 변경 재현용). */
  const fakeUvx = (onSpawn: () => void): ExecSpawner => () => {
    onSpawn();
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", 0, null));
    return { pid: 9100, stdout: null, stderr: new EventEmitter(), on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as unknown as ExecChild;
  };

  async function installed(tool: "postgres" | "fixture-npx" = "postgres") {
    const seed = await seedWithNpxFixture();
    const toolId = tool === "postgres" ? "postgres-mcp" : "fixture-npx-mcp";
    const entries: RegistryEntry[] = seed.map((e) => (e.manifest.name === toolId ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: tool === "postgres" ? PIN : NPX_PIN } } } } : e));
    const h = await createHarness(scratch, { entries });
    const install = h.request(toolId, CURSOR);
    const planned = await plannedOf(h, install);
    const done = await runInstallTransaction(planned, await approveAll(planned), install, h.env);
    expect(done.status).toBe("succeeded");
    expect(await recordInstallInState(planned, done, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-12T00:00:00.000Z") })).toMatchObject({ ok: true });
    const spawned: string[] = [];
    let source: (() => Record<string, string>) | undefined = CLEAN;
    let onPrepare = () => undefined as void;
    const env: LifecycleEnvironment = {
      loadEntries: async () => entries,
      probe: () => h.env.probe(),
      tempBase: h.base,
      now: () => new Date("2026-10-12T00:00:00.000Z"),
      configFs: h.env.configFs!,
      spawner: fakeUvx(() => onPrepare()),
      fetch: async (url: string) =>
        url.startsWith("https://pypi.org/pypi/postgres-mcp/") ? new Response(JSON.stringify({ info: { name: "postgres-mcp", version: url.includes("/0.3.0/") ? "0.3.0" : "0.3.1" } }), { status: 200 }) : new Response("missing", { status: 404 }),
      healthSpawner: (exe: string, _args: readonly string[], _options: HealthSpawnOptions) => {
        spawned.push(exe);
        throw new Error("spawn은 일어나면 안 된다");
      },
      ...(source === undefined ? {} : { mcpSourceEnv: () => (source === undefined ? (undefined as never) : source()) }),
    };
    const request = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets: CURSOR, ...(operation === "update" && tool === "postgres" ? { to: "0.3.1" } : {}) });
    const approveRun = async (operation: LifecycleRequest["operation"]) => {
      const built = await planLifecycleRequest(request(operation), env);
      if (!built.ok) throw new Error(built.code);
      if (built.planned.plan.status !== "ready") throw new Error("PLANSTATUS " + built.planned.plan.status + " " + JSON.stringify(built.planned.plan.warnings));
      const approved = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (approved.status !== "approved") throw new Error(approved.status);
      return { built, run: () => runLifecycleTransaction(built.planned, approved.approval, request(operation), env) };
    };
    return {
      h,
      entries,
      env,
      spawned,
      request,
      approveRun,
      setSource: (s: (() => Record<string, string>) | undefined) => void (source = s),
      onPrepare: (f: () => void) => void (onPrepare = f),
      withoutSource: (): LifecycleEnvironment => {
        const { mcpSourceEnv: _omit, ...rest } = env;
        return rest;
      },
    };
  }

  // 수정 전(5454c36): 원본이 없으면 불일치 없음으로 보아 Health 계획이 ready였고, 실행은 빈 환경으로 MCP 서버를 띄웠다.
  it("원본 누락: health 계획은 PACKAGE_SOURCE_UNVERIFIED로 막히고(원본 확인 불가 안내) spawn 0", async () => {
    const c = await installed();
    const built = await planLifecycleRequest(c.request("health"), c.withoutSource());
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.status).toBe("blocked");
    expect(built.planned.plan.warnings.find((w) => w.code === "PACKAGE_SOURCE_UNVERIFIED")?.message).toBe(PACKAGE_SOURCE_UNAVAILABLE_MESSAGE);
    // 원본 함수가 예외를 던져도 같다.
    const throwing = await planLifecycleRequest(c.request("health"), { ...c.withoutSource(), mcpSourceEnv: () => { throw new Error("boom"); } });
    if (!throwing.ok) throw new Error(throwing.code);
    expect(throwing.planned.plan.warnings.map((w) => w.code)).toContain("PACKAGE_SOURCE_UNVERIFIED");
    expect(c.spawned).toEqual([]);
  });

  // 수정 전(5454c36): 승인한 출처가 Plan에 없어 인증 정보 없는 주소 변경(mirror-a → mirror-b)을 잡지 못하고 실행했다.
  for (const [label, tool, name, a, b] of [
    ["npm NPM_CONFIG_REGISTRY", "fixture-npx", "NPM_CONFIG_REGISTRY", "https://mirror-a.example/", "https://mirror-b.example/"],
    ["uv UV_INDEX_URL", "postgres", "UV_INDEX_URL", "https://mirror-a.example/simple", "https://mirror-b.example/simple"],
  ] as const) {
    it("승인 뒤 " + label + " 주소 변경(인증 정보 없음) → PLAN_STALE, spawn 0. 같은 주소면 Health 단계에 같은 출처 digest", async () => {
      const c = await installed(tool);
      c.setSource(() => ({ ...CLEAN(), [name]: a }));
      const { built, run } = await c.approveRun("health");
      const step = built.planned.plan.steps.find((s) => s.kind === "health");
      expect(step).toMatchObject({ packageSource: expect.stringMatching(/^sha256:/u) });
      expect(JSON.stringify(built.planned.plan)).not.toContain("mirror-a");
      c.setSource(() => ({ ...CLEAN(), [name]: b }));
      expect(await run()).toMatchObject({ status: "stale", code: "PLAN_STALE" });
      expect(c.spawned).toEqual([]);
    });
  }

  it("승인 뒤 출처 설정 추가·제거·인증 정보가 든 주소로 변경·원본 누락 → 모두 실행하지 않는다(spawn 0)", async () => {
    const cases: [string, (() => Record<string, string>) | undefined, (() => Record<string, string>) | undefined, string][] = [
      ["추가", CLEAN, () => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-a.example/simple" }), "stale"],
      ["제거", () => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-a.example/simple" }), CLEAN, "stale"],
      ["인증 정보가 든 주소로", () => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-a.example/simple" }), () => ({ ...CLEAN(), UV_INDEX_URL: "https://u:" + SECRET + "@mirror-a.example/simple" }), "stale"],
    ];
    for (const [label, before, after, status] of cases) {
      const c = await installed();
      c.setSource(before);
      const { run } = await c.approveRun("health");
      c.setSource(after);
      const result = await run();
      expect(result.status, label).toBe(status);
      expect(c.spawned, label).toEqual([]);
      expect(JSON.stringify(result), label).not.toContain(SECRET);
    }
  });

// 수정 전(d11b486): Health는 출처 확인(packageSourceRunBlock)과 spawn 환경(mcpChildEnvForPlan)에서 원본을 따로 읽었다.
  // 첫 호출은 승인한 출처(mirror-a)라 확인을 통과하고, 두 번째 호출의 다른 출처(mirror-b)로 MCP 서버를 띄웠다.
  it("Health는 원본을 한 번만 읽은 스냅샷으로 확인과 spawn 환경을 만든다(뒤 호출이 바뀌어도 승인한 출처로만 실행)", async () => {
    const c = await installed();
    const A = () => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-a.example/simple" });
    c.setSource(A);
    const { run } = await c.approveRun("health");
    let calls = 0;
    const flipping = () => (++calls === 1 ? A() : { ...CLEAN(), UV_INDEX_URL: "https://mirror-b.example/simple" });
    const spawnedEnv: Record<string, string>[] = [];
    const recording: HealthSpawner = (_exe, _args, options) => {
      spawnedEnv.push({ ...options.env });
      throw new Error("기록만 하고 실제로 띄우지 않는다");
    };
    c.env.runHealth = (v, o) => runHealthCheck(v, { ...o, sourceEnv: flipping, spawner: recording });
    await run();
    expect(calls).toBe(1);
    expect(spawnedEnv).toHaveLength(1);
    expect(spawnedEnv[0]!["UV_INDEX_URL"]).toBe("https://mirror-a.example/simple");
  });

  // 수정 전(d11b486): 출처 확인이 임시 폴더 생성(비동기 준비) 전에 있었다. 지금은 준비가 끝난 뒤 spawn 직전에 확인한다.
  it("Health 출처 확인은 비동기 파일 준비(임시 폴더) 뒤 spawn 직전에 한다", async () => {
    const c = await installed();
    c.setSource(CLEAN);
    const { run } = await c.approveRun("health");
    const prepared: boolean[] = [];
    c.env.runHealth = (v, o) =>
      runHealthCheck(v, {
        ...o,
        sourceEnv: () => (prepared.push(readdirSync(o.tempBase).some((n) => n.startsWith("openhub-health-"))), CLEAN()),
        spawner: () => {
          throw new Error("기록만 하고 실제로 띄우지 않는다");
        },
      });
    await run();
    expect(prepared).toEqual([true]);
  });

  it("Health 스냅샷의 원본 조회 오류·승인과 다른 출처 → 그 MCP 서버를 실행하지 않는다(spawn 0)", async () => {
    for (const bad of [() => { throw new Error("boom"); }, () => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-b.example/simple" })]) {
      const c = await installed();
      c.setSource(() => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-a.example/simple" }));
      const { run } = await c.approveRun("health");
      let spawned = 0;
      c.env.runHealth = (v, o) => runHealthCheck(v, { ...o, sourceEnv: bad as () => Record<string, string>, spawner: () => { spawned += 1; throw new Error("no"); } });
      const result = await run();
      expect(result.steps.find((s) => s.id === "health")).toMatchObject({ status: "failed", code: "package-source-unverified" });
      expect(spawned).toBe(0);
    }
  });

  it("같은 update 실행 안에서 Prepare 뒤 Health 전에 출처가 바뀌면 Health는 실행하지 않고(spawn 0) 설정을 되돌린다", async () => {
    const c = await installed();
    c.setSource(() => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-a.example/simple" }));
    const before = await readFile(path.join(c.h.projectRoot, ".cursor", "mcp.json"), "utf8");
    const { run } = await c.approveRun("update");
    // 승인 뒤 재생성 확인을 통과한 다음, Prepare(uvx) 단계가 실행되는 순간 출처가 바뀐다.
    c.onPrepare(() => c.setSource(() => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-b.example/simple" })));
    const result = await run();
    expect(result.status).not.toBe("updated");
    expect(result.steps.find((s) => s.id === "health")).toMatchObject({ status: "failed", code: "package-source-unverified" });
    expect(c.spawned).toEqual([]);
    expect(await readFile(path.join(c.h.projectRoot, ".cursor", "mcp.json"), "utf8")).toBe(before);
  });

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

  it("Benchmark 계획도 같은 이유로 막히고(원본 누락 포함), 승인할 출처 digest가 launch에 들어간다(주소가 바뀌면 launch가 달라짐)", async () => {
    const c = await installed();
    const base = { toolId: "postgres-mcp", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, entries: c.entries, platform: "linux" as const, includeUser: false, fs: c.h.env.configFs! };
    const blocked = await planBenchmark({ ...base, mcpSourceEnv: CREDENTIALED });
    if (!blocked.ok) throw new Error(blocked.code);
    expect(blocked.planned.plan.blockers.map((b) => b.code)).toContain("BENCHMARK_PACKAGE_SOURCE_UNVERIFIED");
    expect(JSON.stringify(blocked.planned.plan)).not.toContain(SECRET);
    const missing = await planBenchmark(base);
    if (!missing.ok) throw new Error(missing.code);
    expect(missing.planned.plan.blockers.map((b) => b.code)).toContain("BENCHMARK_PACKAGE_SOURCE_UNVERIFIED");
    const clean = await planBenchmark({ ...base, mcpSourceEnv: CLEAN });
    if (!clean.ok) throw new Error(clean.code);
    expect(clean.planned.plan.blockers.map((b) => b.code)).not.toContain("BENCHMARK_PACKAGE_SOURCE_UNVERIFIED");
    const mirrorA = await planBenchmark({ ...base, mcpSourceEnv: () => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-a.example/simple" }) });
    const mirrorB = await planBenchmark({ ...base, mcpSourceEnv: () => ({ ...CLEAN(), UV_INDEX_URL: "https://mirror-b.example/simple" }) });
    if (!mirrorA.ok || !mirrorB.ok) throw new Error("plan");
    expect(mirrorA.planned.plan.launch?.packageSource).toMatch(/^sha256:/u);
    expect(mirrorA.planned.plan.launch?.packageSource).not.toBe(mirrorB.planned.plan.launch?.packageSource);
  });
});
