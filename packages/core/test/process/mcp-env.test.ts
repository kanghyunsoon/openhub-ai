import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createTreeKiller,
  healthEnvNotice,
  mcpServerChildEnv,
  nodeHealthSpawner,
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

describe("실제 자식 process가 받는 환경", () => {
  it("handshake: 허용 목록 환경으로 띄운 MCP 서버는 합성 key를 하나도 받지 못하고 선언된 값만 받는다", async () => {
    const out = path.join(scratch, "handshake.json");
    const script = await envRecordingServer(out);
    const childEnv = mcpServerChildEnv(parentEnv(), { backend: "uvx", declaredNames: ["DATABASE_URI"] });
    const outcome = await runHandshake([process.execPath, script], scratch, { startupMs: 20_000, handshakeMs: 10_000, totalMs: 45_000 }, HOST, { killTree: createTreeKiller({ cwd: scratch }), childEnv }, { mark: () => undefined });
    expect(outcome.status).toBe("healthy");
    const seen = JSON.parse(await readFile(out, "utf8")) as Record<string, string>;
    for (const [name, value] of Object.entries(SYNTH)) {
      expect(seen, name).not.toHaveProperty(name);
      expect(JSON.stringify(seen)).not.toContain(value);
    }
    expect(seen["DATABASE_URI"]).toBe("postgresql://probe:synthetic-declared@db/app");
    expect(Object.keys(seen).some((k) => k.toUpperCase() === "PATH")).toBe(true);
  }, 30_000);

  it("비교: childEnv 없이 띄우면(이전 동작) 부모의 합성 key가 그대로 전달된다", async () => {
    const out = path.join(scratch, "inherit.json");
    const script = await envRecordingServer(out);
    const previous = process.env["OPENAI_API_KEY"];
    process.env["OPENAI_API_KEY"] = SYNTH["OPENAI_API_KEY"];
    try {
      const outcome = await runHandshake([process.execPath, script], scratch, { startupMs: 20_000, handshakeMs: 10_000, totalMs: 45_000 }, HOST, { killTree: createTreeKiller({ cwd: scratch }) }, { mark: () => undefined });
      expect(outcome.status).toBe("healthy");
      expect(JSON.parse(await readFile(out, "utf8"))["OPENAI_API_KEY"]).toBe(SYNTH["OPENAI_API_KEY"]);
    } finally {
      if (previous === undefined) delete process.env["OPENAI_API_KEY"];
      else process.env["OPENAI_API_KEY"] = previous;
    }
  }, 30_000);

  it("Lifecycle Health(CLI·Desktop 경로): mcpSourceEnv를 주면 실제 MCP 서버 process에는 합성 key 0개, 결과에도 값 0개", async () => {
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

    const out = path.join(scratch, "lifecycle.json");
    const script = await envRecordingServer(out);
    const spawned: (Record<string, string> | undefined)[] = [];
    const healthSpawner = (_exe: string, _args: readonly string[], options: HealthSpawnOptions) => (spawned.push(options.env), nodeHealthSpawner(process.execPath, [script], options));
    const env: LifecycleEnvironment = { loadEntries: async () => entries, probe: () => h.env.probe(), tempBase: h.base, now: () => new Date("2026-10-12T00:00:00.000Z"), configFs: h.env.configFs!, healthSpawner, mcpSourceEnv: parentEnv };
    const request: LifecycleRequest = { operation: "health", toolId: "postgres-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: HOST, includeUser: false, targets: CURSOR };
    const built = await planLifecycleRequest(request, env);
    if (!built.ok) throw new Error(built.code);
    const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    const result = await runLifecycleTransaction(built.planned, outcome.approval, request, env);
    expect(result).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toBeDefined();
    const seen = JSON.parse(await readFile(out, "utf8")) as Record<string, string>;
    for (const [name, value] of Object.entries(SYNTH)) {
      expect(seen, name).not.toHaveProperty(name);
      expect(JSON.stringify(seen)).not.toContain(value);
    }
    expect(seen["DATABASE_URI"]).toBe("postgresql://probe:synthetic-declared@db/app");
    const serialized = JSON.stringify(result);
    for (const value of [...Object.values(SYNTH), "synthetic-declared"]) expect(serialized).not.toContain(value);
  }, 60_000);
});
