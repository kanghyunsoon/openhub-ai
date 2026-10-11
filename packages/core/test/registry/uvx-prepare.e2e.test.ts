import os from "node:os";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
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
const SOURCE = { build: "source-build-reviewed", sourceBuild: [{ package: "proxy-tools", version: "0.1.0", source: "pypi-sdist" }] };
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
  if (result.status !== "succeeded") return { planned, result, health: null };
  expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
  const life: LifecycleEnvironment = { loadEntries: async () => entries, probe: () => h.env.probe(), tempBase: h.isoBase, now: () => new Date(), runHealth: runHealthCheck, uvChildEnv: () => uvChildEnv(process.env) };
  const req = { operation: "health" as const, toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, platform, includeUser: false, targets: CLAUDE };
  const plan = await planLifecycleRequest(req, life);
  if (!plan.ok) throw new Error(plan.code);
  const ok = await requestLifecycleApproval(plan.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (ok.status !== "approved") throw new Error(ok.status);
  return { planned, result, health: await runLifecycleTransaction(plan.planned, ok.approval, req, life) };
}

describe.skipIf(skip)("v0.2.1 uvx Prepare 실제 uv(빈 cache)", () => {
  it("serena: wheel만 허용하면 소스 빌드 없이 UVX_WHEEL_UNAVAILABLE이고 설정은 그대로다", () =>
    withUvCache(async () => {
      const r = await installAndHealth("serena", override("serena", { command: "uvx --from serena-agent==1.7.0 serena start-mcp-server" }));
      expect(r.result).toMatchObject({ status: "failed", code: "UVX_WHEEL_UNAVAILABLE" });
    }), 600_000);

  it("serena: 검토된 소스 빌드 + source-build 승인이면 준비 뒤 첫 Health가 20 s 안에 healthy다", () =>
    withUvCache(async () => {
      const r = await installAndHealth("serena", override("serena", { command: "uvx --from serena-agent==1.7.0 serena start-mcp-server", prepare: SOURCE }));
      expect(r.planned.plan.approvalRequirements).toContain("source-build");
      expect(r.result).toMatchObject({ status: "succeeded", verification: { prepared: "cached" } });
      expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    }), 900_000);

  it.skipIf(DB === undefined)("postgres-mcp 0.3.0 + mcp 1.30.0: 준비 뒤 첫 Health가 healthy다", () =>
    withUvCache(async () => {
      const r = await installAndHealth("postgres-mcp", override("postgres-mcp", { command: "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted" }));
      expect(r.result).toMatchObject({ status: "succeeded", verification: { prepared: "cached" } });
      expect(r.health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    }), 900_000);
});
