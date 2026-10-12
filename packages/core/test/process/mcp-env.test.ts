import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTreeKiller,
  fastManifestIssues,
  healthEnvNotice,
  isCodeInjectionEnvName,
  mcpServerChildEnv,
  nodeHealthSpawner,
  packageSourceDigest,
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runHandshake,
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
 * v0.2.1 외부 MCP 실행 환경 최소화(process/mcp-env.ts). 합성 API key·token만 쓴다(실제 자격증명 0).
 * 실제 node 자식 process가 받은 환경을 파일로 남기게 해서 확인한다.
 */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-mcp-env-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

/** 합성 값. 실제 자격증명이 아니다. */
const SYNTH: Record<string, string> = {
  OPENAI_API_KEY: "sk-synthetic-openai-0001",
  ANTHROPIC_API_KEY: "sk-ant-synthetic-0002",
  GITHUB_TOKEN: "ghp_synthetic0003",
  GH_TOKEN: "gho_synthetic0004",
  AWS_ACCESS_KEY_ID: "AKIASYNTHETIC0005",
  AWS_SECRET_ACCESS_KEY: "synthetic-aws-secret-0006",
  AZURE_CLIENT_SECRET: "synthetic-azure-0007",
  GOOGLE_APPLICATION_CREDENTIALS: "/synthetic/gcp.json",
  HF_TOKEN: "hf_synthetic0008",
  SLACK_BOT_TOKEN: "xoxb-synthetic-0009",
  NPM_TOKEN: "npm_synthetic0010",
  NODE_AUTH_TOKEN: "synthetic-node-auth-0011",
  "npm_config_//registry.npmjs.org/:_authToken": "synthetic-npmrc-0012",
  NPM_CONFIG__AUTH: "synthetic-npm-auth-0013",
  UV_INDEX_CORP_PASSWORD: "synthetic-uv-pass-0014",
  UV_INDEX_CORP_USERNAME: "synthetic-uv-user",
  DATABASE_URL: "postgresql://u:synthetic-db-0015@db/app",
  MONGODB_URI: "mongodb://u:synthetic-mongo-0016@db/app",
  NODE_OPTIONS: "--require /synthetic/inject.js",
  PYTHONPATH: "/synthetic/py",
  PYTHONSTARTUP: "/synthetic/start.py",
  MY_SERVICE_PASSWORD: "synthetic-0017",
};
const BASE = { PATH: "/usr/bin", HOME: "/home/u", TEMP: "/tmp", LANG: "C.UTF-8", LC_ALL: "C.UTF-8", HTTPS_PROXY: "http://proxy.example:3128", SSL_CERT_FILE: "/etc/ca.pem" };

describe("mcpServerChildEnv(허용 목록)", () => {
  it("OS 기본·backend 설정·Manifest 선언 이름만 넘기고 합성 API key·token·자격증명·코드 주입 변수는 하나도 넘기지 않는다", () => {
    for (const backend of ["npx", "uvx", "docker"] as const) {
      const env = mcpServerChildEnv({ ...SYNTH, ...BASE, NPM_CONFIG_CACHE: "/c/npm", UV_CACHE_DIR: "/c/uv", DOCKER_HOST: "unix:///d.sock" }, { backend, declaredNames: [] });
      for (const name of Object.keys(SYNTH)) expect(env, backend + " " + name).not.toHaveProperty(name);
      for (const value of Object.values(SYNTH)) expect(JSON.stringify(env)).not.toContain(value);
      expect(env).toMatchObject(BASE);
      expect("NPM_CONFIG_CACHE" in env).toBe(backend === "npx");
      expect("UV_CACHE_DIR" in env).toBe(backend === "uvx");
      expect("DOCKER_HOST" in env).toBe(backend === "docker");
    }
  });

  it("Manifest가 선언한 이름(대소문자 무관)은 값이 있을 때만 넘긴다", () => {
    const env = mcpServerChildEnv({ ...SYNTH, ...BASE, GITHUB_PERSONAL_ACCESS_TOKEN: "synthetic-declared-pat", database_uri: "postgresql://synthetic" }, { backend: "docker", declaredNames: ["GITHUB_PERSONAL_ACCESS_TOKEN", "DATABASE_URI", "KUBECONFIG"] });
    expect(env["GITHUB_PERSONAL_ACCESS_TOKEN"]).toBe("synthetic-declared-pat");
    expect(env["database_uri"]).toBe("postgresql://synthetic");
    expect(env).not.toHaveProperty("KUBECONFIG");
    expect(env).not.toHaveProperty("GITHUB_TOKEN");
  });

  it("backend index·registry URL에 계정이 들어 있으면 넘기지 않는다", () => {
    expect(mcpServerChildEnv({ UV_INDEX_URL: "https://u:synthetic-pass@idx.example/simple" }, { backend: "uvx", declaredNames: [] })).toEqual({});
    expect(mcpServerChildEnv({ UV_INDEX_URL: "https://idx.example/simple" }, { backend: "uvx", declaredNames: [] })).toEqual({ UV_INDEX_URL: "https://idx.example/simple" });
    expect(mcpServerChildEnv({ NPM_CONFIG_REGISTRY: "https://u:p@npm.example/" }, { backend: "npx", declaredNames: [] })).toEqual({});
  });

  it("승인 화면 설명은 이름만 보여 주고 값은 보여 주지 않는다", () => {
    expect(healthEnvNotice(["DATABASE_URI"])).toContain("DATABASE_URI");
    // 선언된 자격증명 예외를 숨기지 않는다: 값이 있으면 MCP 서버가 받는다는 것을 승인 전에 알린다.
    expect(healthEnvNotice(["GITHUB_PERSONAL_ACCESS_TOKEN"])).toContain("MCP 서버가 그 값을 그대로 받습니다");
    expect(healthEnvNotice(["GITHUB_PERSONAL_ACCESS_TOKEN"])).not.toMatch(/ghp_|synthetic/u);
  });

  it("코드 주입 변수는 Manifest가 선언해도 넘기지 않고, Registry 검증은 선언 자체를 거부한다", async () => {
    const injection = ["NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "DYLD_LIBRARY_PATH", "JAVA_TOOL_OPTIONS", "PERL5OPT", "RUBYOPT", "BASH_ENV", "ELECTRON_RUN_AS_NODE"];
    const source = Object.fromEntries(injection.map((n) => [n, "/synthetic/" + n]));
    expect(mcpServerChildEnv(source, { backend: "npx", declaredNames: injection })).toEqual({});
    for (const n of injection) expect(isCodeInjectionEnvName(n.toLowerCase()), n).toBe(true);
    expect(isCodeInjectionEnvName("DATABASE_URI")).toBe(false);
    const seed = await seedEntries();
    const memory = seed.find((e) => e.manifest.name === "memory-mcp")!.manifest;
    for (const n of ["NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES"]) {
      const issues = fastManifestIssues({ ...memory, env: [{ name: n, required: false, description: "x" }] });
      expect(issues.map((i) => i.path), n).toContain("env[0].name");
    }
    expect(fastManifestIssues({ ...memory, env: [{ name: "DATABASE_URI", required: true, description: "x" }] }).some((i) => i.path.startsWith("env["))).toBe(false);
  });

  it("승인 화면 설명은 값을 보여 주지 않는다(빈 목록)", () => {
    expect(healthEnvNotice(["DATABASE_URI"])).toContain("DATABASE_URI");
    expect(healthEnvNotice([])).toContain("선언한 환경변수 없음");
  });
});

/** 실제 node 가짜 MCP 서버: handshake에 답하고, 받은 환경 이름·값을 파일에 남긴다. */
async function envRecordingServer(out: string): Promise<string> {
  const script = path.join(scratch, "env-mcp-server-" + path.basename(out) + ".cjs");
  await writeFile(
    script,
    [
      "require('node:fs').writeFileSync(" + JSON.stringify(out) + ", JSON.stringify(process.env));",
      "const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');",
      "let buf = '';",
      "process.stdin.on('data', (d) => {",
      "  buf += d;",
      "  for (let i = buf.indexOf('\\n'); i !== -1; i = buf.indexOf('\\n')) {",
      "    const m = JSON.parse(buf.slice(0, i)); buf = buf.slice(i + 1);",
      "    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'env', version: '1' } } });",
      "    if (m.method === 'tools/list') send({ jsonrpc: '2.0', id: m.id, result: { tools: [{ name: 't' }] } });",
      "  }",
      "});",
      "process.stdin.on('end', () => process.exit(0));",
    ].join("\n"),
  );
  return script;
}

const HOST = process.platform === "win32" ? ("windows" as const) : process.platform === "darwin" ? ("macos" as const) : ("linux" as const);
/** 실제 OS에서 node가 뜨는 데 필요한 값 + 합성 자격증명(부모 환경에 섞여 있는 상황). */
const parentEnv = () => ({ ...process.env, ...SYNTH, DATABASE_URI: "postgresql://probe:synthetic-declared@db/app" });
/** uv 이름 있는 index 인증(UV_INDEX_CORP_*)을 뺀 원본. 이 쌍은 패키지 출처 설정이라 있으면 uvx Health가 실행되지 않는다(#46 리뷰 A안). */
const UV_INDEX_AUTH_NAMES = ["UV_INDEX_CORP_PASSWORD", "UV_INDEX_CORP_USERNAME"];
const parentEnvWithoutUvIndexAuth = () => Object.fromEntries(Object.entries(parentEnv()).filter(([k]) => !UV_INDEX_AUTH_NAMES.includes(k)));

describe("실제 자식 process가 받는 환경", () => {
  const LIMITS = { startupMs: 20_000, handshakeMs: 10_000, totalMs: 45_000 };
  /** 부모 process.env에 합성 key를 넣은 채로 fn을 실행한다(원본을 주지 않는 호출이 부모 환경을 쓰는지 보기 위해). */
  async function withParentSecrets<T>(fn: () => Promise<T>): Promise<T> {
    const saved = new Map(Object.keys(SYNTH).map((k) => [k, process.env[k]] as const));
    Object.assign(process.env, SYNTH);
    try {
      return await fn();
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }
  const noSynthetic = (seen: Record<string, string>) => {
    for (const [name, value] of Object.entries(SYNTH)) {
      expect(seen, name).not.toHaveProperty(name);
      expect(JSON.stringify(seen)).not.toContain(value);
    }
  };
  /**
   * Windows의 libuv(uv_spawn)는 env에 없으면 이 OS 변수들을 부모에서 채워 넣는다(값이 비밀이 아닌 OS 정보). POSIX는 채우지 않는다.
   * 원본 없이 띄운 자식이 볼 수 있는 키는 이 목록뿐이어야 한다.
   */
  const LIBUV_REQUIRED = new Set(process.platform === "win32" ? ["HOMEDRIVE", "HOMEPATH", "LOGONSERVER", "PATH", "SYSTEMDRIVE", "SYSTEMROOT", "TEMP", "USERDOMAIN", "USERNAME", "USERPROFILE", "WINDIR"] : []);
  const onlyOsDefaults = (seen: Record<string, string>) => expect(Object.keys(seen).filter((k) => !LIBUV_REQUIRED.has(k.toUpperCase()))).toEqual([]);

  it("handshake: 허용 목록 환경으로 띄운 MCP 서버는 합성 key를 하나도 받지 못하고 선언된 값만 받는다(선언해도 코드 주입 변수는 제외)", async () => {
    const out = path.join(scratch, "handshake.json");
    const script = await envRecordingServer(out);
    // uvx backend: uv index 인증 쌍을 빼야 실행된다(있으면 아래 테스트처럼 spawn 0). 나머지 합성 key 20종은 그대로 둔다.
    const source = () => ({ ...parentEnvWithoutUvIndexAuth(), LD_PRELOAD: "/synthetic/evil.so", DYLD_INSERT_LIBRARIES: "/synthetic/evil.dylib", NODE_PATH: "/synthetic/node" });
    const declaredNames = ["DATABASE_URI", "NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_PATH"];
    const outcome = await runHandshake([process.execPath, script], scratch, LIMITS, HOST, { killTree: createTreeKiller({ cwd: scratch }), sourceEnv: source }, { mark: () => undefined }, { backend: "uvx", declaredNames, approvedPackageSource: packageSourceDigest(source(), "uvx") });
    expect(outcome.status).toBe("healthy");
    const seen = JSON.parse(await readFile(out, "utf8")) as Record<string, string>;
    noSynthetic(seen);
    for (const name of ["LD_PRELOAD", "DYLD_INSERT_LIBRARIES", "NODE_PATH"]) expect(seen, name).not.toHaveProperty(name);
    expect(seen["DATABASE_URI"]).toBe("postgresql://probe:synthetic-declared@db/app");
    expect(Object.keys(seen).some((k) => k.toUpperCase() === "PATH")).toBe(true);
  }, 30_000);

  it("handshake(합성 key 22종 전부, uv index 인증 포함): uvx는 패키지 출처를 확인할 수 없어 spawn 0이고 결과에 값이 없다", async () => {
    const out = path.join(scratch, "handshake-blocked.json");
    const script = await envRecordingServer(out);
    const spawned: unknown[] = [];
    const spawner = (exe: string, args: readonly string[], options: HealthSpawnOptions) => (spawned.push(exe), nodeHealthSpawner(exe, args, options));
    const outcome = await runHandshake([process.execPath, script], scratch, LIMITS, HOST, { killTree: createTreeKiller({ cwd: scratch }), sourceEnv: parentEnv, spawner }, { mark: () => undefined }, { backend: "uvx", declaredNames: ["DATABASE_URI"], approvedPackageSource: null });
    expect(outcome).toMatchObject({ status: "launch-failed", reason: "package-source-unverified" });
    expect(spawned).toEqual([]);
    expect(outcome.excerpt).toContain("UV_INDEX_CORP_PASSWORD");
    for (const value of Object.values(SYNTH)) expect(JSON.stringify(outcome)).not.toContain(value);
  });

  // 재현(이전 HEAD 3027da6): 원본 없이 띄우면 부모 process.env의 합성 key가 그대로 전달됐다(이 자리의 테스트가 누출을 단언했다).
  // 수정 뒤 같은 시나리오: 원본 누락·빈 원본·예외를 던지는 원본 모두 부모 환경을 쓰지 않는다(fail-closed).
  // #46 리뷰(5454c36 이후): npx·uvx는 원본 누락·예외면 패키지 출처를 확인할 수 없어 아예 실행하지 않는다(spawn 0). 명시적인 빈 원본은 빈 환경으로 실행한다.
  // docker(패키지 출처 확인 대상 아님)는 세 경우 모두 빈 환경으로 실행해 부모 환경을 상속하지 않는다.
  for (const [label, sourceEnv] of [
    ["원본 누락", undefined],
    ["빈 원본", () => ({})],
    ["예외를 던지는 원본", () => { throw new Error("boom"); }],
  ] as const) {
    for (const backend of ["npx", "docker"] as const) {
      it("fail-closed(" + label + ", " + backend + "): 부모 process.env에 합성 key가 있어도 MCP 서버는 하나도 받지 못한다", async () => {
        const out = path.join(scratch, "closed-" + backend + "-" + label.length + ".json");
        const script = await envRecordingServer(out);
        const spawned: string[] = [];
        const spawner = (exe: string, args: readonly string[], options: HealthSpawnOptions) => (spawned.push(exe), nodeHealthSpawner(exe, args, options));
        const outcome = await withParentSecrets(() =>
          runHandshake([process.execPath, script], scratch, LIMITS, HOST, { killTree: createTreeKiller({ cwd: scratch }), spawner, ...(sourceEnv === undefined ? {} : { sourceEnv }) }, { mark: () => undefined }, { backend, declaredNames: ["OPENAI_API_KEY"], approvedPackageSource: null }),
        );
        if (backend === "npx" && label !== "빈 원본") {
          expect(outcome).toMatchObject({ status: "launch-failed", reason: "package-source-unverified" });
          expect(spawned).toEqual([]);
          return;
        }
        expect(outcome.status).toBe("healthy");
        const seen = JSON.parse(await readFile(out, "utf8")) as Record<string, string>;
        noSynthetic(seen);
        onlyOsDefaults(seen);
      }, 30_000);
    }
  }

  for (const mode of ["source", "empty", "missing"] as const) it("Lifecycle Health(" + ({ source: "CLI·Desktop 경로, mcpSourceEnv 있음", empty: "명시적인 빈 원본, fail-closed", missing: "mcpSourceEnv 누락 → 실행 0" })[mode] + "): 실제 MCP 서버 process에는 합성 key 0개, 결과에도 값 0개", async () => {
    const withSource = mode === "source";
    const seed = await seedEntries();
    const PIN = "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted";
    const entries: RegistryEntry[] = seed.map((e) => (e.manifest.name === "postgres-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: PIN } } } } : e));
    const CURSOR = [{ client: "cursor" as const, scope: "project" as const }];
    const h = await createHarness(scratch, { entries });
    const install = h.request("postgres-mcp", CURSOR);
    const planned = await plannedOf(h, install);
    const installed = await runInstallTransaction(planned, await approveAll(planned), install, h.env);
    expect(installed.status).toBe("succeeded");
    expect(await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-12T00:00:00.000Z") })).toMatchObject({ ok: true });

    const out = path.join(scratch, "lifecycle-" + String(withSource) + ".json");
    const script = await envRecordingServer(out);
    const spawned: (Record<string, string> | undefined)[] = [];
    const healthSpawner = (_exe: string, _args: readonly string[], options: HealthSpawnOptions) => (spawned.push(options.env), nodeHealthSpawner(process.execPath, [script], options));
    // uvx(postgres): uv index 인증 쌍이 있으면 Health가 실행되지 않으므로(아래 별도 테스트) 나머지 합성 key 20종으로 실제 실행을 본다.
    const env: LifecycleEnvironment = { loadEntries: async () => entries, probe: () => h.env.probe(), tempBase: h.base, now: () => new Date("2026-10-12T00:00:00.000Z"), configFs: h.env.configFs!, healthSpawner, ...(mode === "source" ? { mcpSourceEnv: parentEnvWithoutUvIndexAuth } : mode === "empty" ? { mcpSourceEnv: () => ({}) } : {}) };
    const request: LifecycleRequest = { operation: "health", toolId: "postgres-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: HOST, includeUser: false, targets: CURSOR };
    const built = await planLifecycleRequest(request, env);
    if (!built.ok) throw new Error(built.code);
    if (mode === "missing") {
      // 수정 전(5454c36): 원본이 없어도 ready였고 빈 환경으로 실행했다. 지금은 출처를 확인할 수 없어 계획이 막힌다.
      expect(built.planned.plan.status).toBe("blocked");
      expect(built.planned.plan.warnings.map((w) => w.code)).toContain("PACKAGE_SOURCE_UNVERIFIED");
      expect(spawned).toEqual([]);
      return;
    }
    const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    const result = await withParentSecrets(() => runLifecycleTransaction(built.planned, outcome.approval, request, env));
    expect(result).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toBeDefined();
    const seen = JSON.parse(await readFile(out, "utf8")) as Record<string, string>;
    for (const [name, value] of Object.entries(SYNTH)) {
      expect(seen, name).not.toHaveProperty(name);
      expect(JSON.stringify(seen)).not.toContain(value);
    }
    if (withSource) expect(seen["DATABASE_URI"]).toBe("postgresql://probe:synthetic-declared@db/app");
    else {
      expect(spawned[0]).toEqual({});
      onlyOsDefaults(seen);
    }
    const serialized = JSON.stringify(result);
    for (const value of [...Object.values(SYNTH), "synthetic-declared"]) expect(serialized).not.toContain(value);
  }, 60_000);
});
