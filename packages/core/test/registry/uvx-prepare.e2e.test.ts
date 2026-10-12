import os from "node:os";
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  planInstall,
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runHealthCheck,
  runInstallTransaction,
  runLifecycleTransaction,
  uvChildEnv,
  type InstallEnvironment,
  type LifecycleEnvironment,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.1 uvx Prepare 실제 E2E(OPENHUB_E2E=1 그리고 OPENHUB_UVX_E2E=1에서만). 실제 uv·PyPI·네트워크를 쓰고 uv cache는 매번 새 임시
 * 디렉터리다(UV_CACHE_DIR를 이 테스트 동안만 바꾼다). Registry Manifest는 바꾸지 않고 메모리에서만 정확한 버전 명령으로 바꾼다.
 * postgres-mcp는 OPENHUB_UVX_E2E_DATABASE_URI(버리는 테스트 DB)가 있을 때만 실행한다. 실제 자격증명은 쓰지 않는다.
 */
const skip = process.env["OPENHUB_E2E"] !== "1" || process.env["OPENHUB_UVX_E2E"] !== "1";
const DB = process.env["OPENHUB_UVX_E2E_DATABASE_URI"];
const platform = process.platform === "win32" ? ("windows" as const) : ("linux" as const);
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];
const SOURCE = { build: "source-build-reviewed", sourceBuild: [{ package: "proxy-tools", version: "0.1.0", source: "pypi-sdist", sha256: "ccb3751f529c047e2d8a58440d86b205303cf0fe8146f784d1cbcd94f0a28010" }] };
const seed = skip ? [] : await seedEntries();
const override = (name: string, options: Record<string, unknown>): RegistryEntry[] =>
  seed.map((e) => (e.manifest.name === name ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options } } } : e));

async function withUvCache<T>(fn: () => Promise<T>): Promise<T> {
  const previous = { cache: process.env["UV_CACHE_DIR"], db: process.env["DATABASE_URI"] };
  process.env["UV_CACHE_DIR"] = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-uvcache-"));
  if (DB !== undefined) process.env["DATABASE_URI"] = DB;
  try {
    return await fn();
  } finally {
    for (const [k, v] of [["UV_CACHE_DIR", previous.cache], ["DATABASE_URI", previous.db]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** 계획만 만든다(실제 uv 환경·실제 uv.toml). 막힌 계획이면 실행하지 않고 설정 파일이 그대로인지 본다. */
async function planOnly(toolId: string, entries: RegistryEntry[]) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-uvx-e2e-plan-"));
  const h = await createHarness(scratch, { entries, verify: false });
  const before = '{\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
  await writeFile(path.join(h.projectRoot, ".mcp.json"), before);
  const { spawner: _fake, ...rest } = h.env;
  const env: InstallEnvironment = { ...rest, uvChildEnv: () => uvChildEnv(process.env) };
  const built = await planInstall(h.request(toolId, CLAUDE), env);
  if (!built.result.ok) throw new Error(built.result.code);
  return { status: built.result.planned.plan.status, codes: built.result.planned.plan.warnings.map((w) => w.code), before, config: await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8") };
}

async function installAndHealth(toolId: string, entries: RegistryEntry[]) {
  const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-uvx-e2e-"));
  const h = await createHarness(scratch, { entries, verify: false });
  const existing = '{\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
  await writeFile(path.join(h.projectRoot, ".mcp.json"), existing);
  const { spawner: _fake, ...rest } = h.env;
  const env: InstallEnvironment = { ...rest, uvChildEnv: () => uvChildEnv(process.env) };
  const request = h.request(toolId, CLAUDE);
  const planned = await plannedOf(h, request);
  const result = await runInstallTransaction(planned, await approveAll(planned), request, env);
  const doc = JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8"));
  expect(doc.mcpServers.notes).toEqual({ command: "uvx", args: ["notes-mcp==1.0.0"] });
  if (result.status !== "succeeded") return { planned, result, health: null, config: doc };
  expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
  // CLI·Desktop과 같은 경로: Health 환경의 원본을 넘기고 core가 허용 목록으로 거른다(#46). 원본이 없으면 빈 환경(fail-closed)이다.
  const life: LifecycleEnvironment = { loadEntries: async () => entries, probe: () => h.env.probe(), tempBase: h.isoBase, now: () => new Date(), runHealth: runHealthCheck, uvChildEnv: () => uvChildEnv(process.env), mcpSourceEnv: () => process.env };
  const req = { operation: "health" as const, toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, platform, includeUser: false, targets: CLAUDE };
  const plan = await planLifecycleRequest(req, life);
  if (!plan.ok) throw new Error(plan.code);
  const ok = await requestLifecycleApproval(plan.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (ok.status !== "approved") throw new Error(ok.status);
  return { planned, result, health: await runLifecycleTransaction(plan.planned, ok.approval, req, life), config: doc };
}

/** Client 설정에 기록된 명령을 그대로(같은 command·args) 실행해 MCP initialize 응답을 받는다. Client가 하는 실행과 같다. */
function clientHandshake(command: string, args: readonly string[], extraEnv: Record<string, string>): Promise<{ ok: boolean; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, [...args], { shell: false, env: { ...process.env, ...extraEnv }, stdio: ["pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    const done = (ok: boolean) => {
      clearTimeout(timer);
      child.kill();
      resolve({ ok, stderr: err });
    };
    const timer = setTimeout(() => done(false), 120_000);
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      if (/"serverInfo"/u.test(out)) done(true);
    });
    child.stderr.on("data", (d: Buffer) => (err += d.toString("utf8")));
    child.on("close", () => done(/"serverInfo"/u.test(out)));
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openhub-e2e", version: "0" } } }) + "\n");
  });
}

describe.skipIf(skip)("v0.2.1 uvx Prepare 실제 uv(빈 cache)", () => {
  it("serena: wheel만 허용하면 소스 빌드 없이 UVX_WHEEL_UNAVAILABLE이고 설정은 그대로다", () =>
    withUvCache(async () => {
      const r = await installAndHealth("serena", override("serena", { command: "uvx --from serena-agent==1.7.0 serena start-mcp-server" }));
      expect(r.result).toMatchObject({ status: "failed", code: "UVX_WHEEL_UNAVAILABLE" });
    }), 600_000);

  it("serena: 검토된 소스 빌드는 v0.2.1에서 계획 단계에서 막히고(UVX_SOURCE_BUILD_DISABLED) uv 실행·설정 변경이 없다", () =>
    withUvCache(async () => {
      for (const command of ["uvx --from serena-agent==1.7.0 serena start-mcp-server", "uvx --from serena-agent==1.7.0 --with docopt==0.6.2 serena start-mcp-server"]) {
        const r = await planOnly("serena", override("serena", { command, prepare: SOURCE }));
        expect(r.status, command).toBe("blocked");
        expect(r.codes, command).toContain("UVX_SOURCE_BUILD_DISABLED");
        expect(r.config, command).toBe(r.before);
      }
    }), 900_000);

  // 차단 근거(실제 uv 재현). uv가 바뀌어 이 단언이 깨지면 소스 빌드 정책을 다시 평가한다(docs/specs/uvx-prepare.md).
  it("재현: uvx는 constraints의 sdist hash가 틀려도 소스 빌드한다(Client cache 단계의 입력 무결성을 강제할 수 없음)", () =>
    withUvCache(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openhub-uvx-hash-"));
      await writeFile(path.join(dir, "c.txt"), "proxy-tools==0.1.0 --hash=sha256:" + "1".repeat(64) + "\n");
      const r = spawnSync("uvx", ["--constraints", path.join(dir, "c.txt"), "--from", "serena-agent==1.7.0", "python", "-c", "pass"], { cwd: dir, encoding: "utf8", shell: false, timeout: 600_000 });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/Built proxy-tools==0\.1\.0/u);
    }), 900_000);

  it("대조: uv build는 build-constraints hash가 틀리면 빌드하지 않는다(1차 빌드 의존성은 hash로 강제 가능)", () =>
    withUvCache(async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "openhub-uvbuild-hash-"));
      const doc = (await (await fetch("https://pypi.org/pypi/proxy-tools/0.1.0/json")).json()) as { urls: { packagetype: string; url: string; filename: string; digests: { sha256: string } }[] };
      const sdist = doc.urls.find((u) => u.packagetype === "sdist")!;
      expect(sdist.digests.sha256).toBe(SOURCE.sourceBuild[0]!.sha256);
      await writeFile(path.join(dir, sdist.filename), Buffer.from(await (await fetch(sdist.url)).arrayBuffer()));
      await writeFile(path.join(dir, "bc.txt"), "setuptools==84.0.0 --hash=sha256:" + "0".repeat(64) + "\n");
      const r = spawnSync("uv", ["build", "--wheel", "--build-constraints", path.join(dir, "bc.txt"), "--out-dir", path.join(dir, "w"), path.join(dir, sdist.filename)], { cwd: dir, encoding: "utf8", shell: false, timeout: 600_000 });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/hash/iu);
    }), 900_000);

  // #45 리뷰: Client가 나중에 직접 uvx를 실행할 때(cache 삭제·재해석)도 검토되지 않은 sdist를 빌드하면 안 된다.
  it("수정 전 재현: --no-build 없는 Client 명령(v0.2.0 형식)은 빈 cache에서 검토되지 않은 sdist(proxy-tools)를 빌드한다", () =>
    withUvCache(async () => {
      const r = spawnSync("uvx", ["--from", "serena-agent==1.7.0", "python", "-c", "pass"], { encoding: "utf8", shell: false, timeout: 600_000 });
      expect(r.status).toBe(0);
      expect(r.stderr).toMatch(/Built proxy-tools==0\.1\.0/u);
    }), 900_000);

  it("수정 후: --no-build Client 명령은 빈 cache(삭제된 cache)에서 소스 빌드 없이 실패한다", () =>
    withUvCache(async () => {
      const r = spawnSync("uvx", ["--no-build", "--from", "serena-agent==1.7.0", "serena", "start-mcp-server"], { encoding: "utf8", shell: false, timeout: 600_000 });
      expect(r.status).not.toBe(0);
      expect(r.stderr).not.toMatch(/Built /u);
      expect(r.stderr).toMatch(/proxy-tools/u);
    }), 900_000);

  it.skipIf(DB === undefined)("postgres-mcp 0.3.0 + mcp 1.30.0: 준비 뒤 첫 Health가 healthy다", () =>
    withUvCache(async () => {
      const r = await installAndHealth("postgres-mcp", override("postgres-mcp", { command: "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted" }));
      expect(r.result).toMatchObject({ status: "succeeded", verification: { prepared: "cached" } });
      expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
      // Client 설정은 Prepare·Health와 같은 고정 패키지를 --no-build로 실행한다.
      const entry = r.config.mcpServers.postgres as { command: string; args: string[] };
      expect(entry.command).toBe("uvx");
      expect(entry.args).toEqual(["--no-build", "--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"]);
      // 재실행: 기록된 Client 명령 그대로, 오프라인(UV_OFFLINE=1)으로 준비된 cache만 써서 MCP initialize에 응답한다.
      const offline = await clientHandshake(entry.command, entry.args, { UV_OFFLINE: "1", DATABASE_URI: DB! });
      expect(offline.ok, offline.stderr.slice(-2000)).toBe(true);
      expect(offline.stderr).not.toMatch(/Built /u);
    }), 900_000);

  it.skipIf(DB === undefined)("postgres-mcp: cache를 지운 뒤 Client 명령(--no-build)은 wheel만 받아 빌드 없이 시작한다", () =>
    withUvCache(async () => {
      const args = ["--no-build", "--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"];
      const fresh = await clientHandshake("uvx", args, { DATABASE_URI: DB! });
      expect(fresh.ok, fresh.stderr.slice(-2000)).toBe(true);
      expect(fresh.stderr).not.toMatch(/Built /u);
    }), 900_000);
});
