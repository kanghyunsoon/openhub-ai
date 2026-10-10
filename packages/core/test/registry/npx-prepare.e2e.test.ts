import os from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NPX_PREPARED_MARKER,
  createTreeKiller,
  locateWindowsNpxLauncher,
  nodeExecSpawner,
  npxCacheKey,
  npxPrepareArgs,
  planLifecycle,
  prepareNpxPackage,
  recordInstallInState,
  requestLifecycleApproval,
  runHealthCheck,
  runInstallTransaction,
  verifyApprovedLifecyclePlan,
  type InstallEnvironment,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.0 npx Prepare 실제 E2E(OPENHUB_E2E=1에서만). 실제 npm·npx·네트워크를 쓰고, npm cache는 매번 새 임시 디렉터리다
 * (npm_config_cache를 이 테스트 동안만 바꾼다. 사용자 cache는 쓰지 않는다). 자격증명·실제 서비스는 쓰지 않는다.
 * 대상 패키지는 OPENHUB_E2E_NPX_COMMAND로 바꿀 수 있다(예: 대형 패키지 재검증). 기본은 Memory MCP의 고정 버전이다.
 * 이 테스트는 Registry Manifest를 바꾸지 않는다. memory-mcp Manifest를 메모리에서만 고정 버전 명령으로 바꿔 쓴다.
 */
const COMMAND = process.env["OPENHUB_E2E_NPX_COMMAND"] ?? "npx -y @modelcontextprotocol/server-memory@2026.8.31";
const INTERRUPT_MS = Number(process.env["OPENHUB_E2E_NPX_INTERRUPT_MS"] ?? "1500");
const platform = process.platform === "win32" ? "windows" : "linux";
const SPEC = COMMAND.split(" ").find((t, i) => i > 0 && !t.startsWith("-"))!;
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];

async function withCache<T>(fn: (cache: string) => Promise<T>): Promise<T> {
  const cache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
  const previous = process.env["npm_config_cache"];
  process.env["npm_config_cache"] = cache;
  try {
    return await fn(cache);
  } finally {
    if (previous === undefined) delete process.env["npm_config_cache"];
    else process.env["npm_config_cache"] = previous;
    await rm(cache, { recursive: true, force: true }).catch(() => undefined);
  }
}
const launcher = () => (platform === "windows" ? locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : Promise.resolve(null));

describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("v0.2.0 npx Prepare 실제 E2E", () => {
  it("빈 npm cache: 승인 → Prepare → 설정 기록 → Version State → Health(20 s 한도)가 통과한다", async () => {
    await withCache(async (cache) => {
      const seed = await seedEntries();
      const entries: RegistryEntry[] = seed.map((e) => (e.manifest.name === "memory-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: COMMAND } } } } : e));
      const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-prepare-"));
      try {
        const h = await createHarness(scratch, { entries });
        const windowsNpx = await launcher();
        const { spawner: _fake, ...rest } = h.env;
        const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }) };
        const request = { ...h.request("memory-mcp", CLAUDE), platform } as const;
        const planned = await plannedOf({ ...h, env }, request);
        expect(planned.plan.steps[0]).toMatchObject({ id: "npx-prepare", args: npxPrepareArgs(SPEC) });
        const started = Date.now();
        const result = await runInstallTransaction(planned, await approveAll(planned), request, env);
        console.log("prepare+install ms " + String(Date.now() - started) + " " + JSON.stringify(result.steps));
        expect(result.status).toBe("succeeded");
        expect(result.verification?.prepared).toBe("cached");
        expect(existsSync(path.join(cache, "_npx", npxCacheKey(SPEC), NPX_PREPARED_MARKER))).toBe(true);
        expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
        const regen = () => planLifecycle({ operation: "health", toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: false });
        const first = await regen();
        if (!first.ok) throw new Error(first.code);
        const outcome = await requestLifecycleApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
        if (outcome.status !== "approved") throw new Error(outcome.status);
        const gate = await verifyApprovedLifecyclePlan(outcome.approval, regen);
        if (!gate.ok) throw new Error(gate.code);
        const t0 = Date.now();
        const health = await runHealthCheck(gate.verified, { healthCheckType: "mcp-handshake", tempBase: os.tmpdir(), windowsNpx });
        console.log("health ms " + String(Date.now() - t0) + " " + JSON.stringify(health.ok ? { status: health.result.status, toolCount: health.result.toolCount } : health));
        expect(health).toMatchObject({ ok: true, result: { status: "healthy" } });
      } finally {
        await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }, 900_000);

  it("중간에 끊긴 Prepare는 불완전 항목을 정리하고, 재시도·손상 항목 복구가 된다", async () => {
    await withCache(async (cache) => {
      const windowsNpx = await launcher();
      const ctx = { platform, windowsNpx, spawner: nodeExecSpawner, killTree: createTreeKiller({ cwd: os.tmpdir() }) } as const;
      const cwd = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-prepare-cwd-"));
      const dir = path.join(cache, "_npx", npxCacheKey(SPEC));
      try {
        const cut = await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, { ...ctx, timeoutMs: INTERRUPT_MS });
        console.log("interrupted: " + JSON.stringify(cut));
        expect(cut).toMatchObject({ status: "failed", code: "STEP_TIMEOUT" });
        expect(existsSync(dir)).toBe(false);
        const retry = await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx);
        expect(retry).toMatchObject({ status: "done", excerpt: "npx cache: installed" });
        // npm 완료 표시를 지워 "끊긴 설치"를 흉내 내면 그 항목만 다시 받는다.
        await unlink(path.join(dir, "node_modules", ".package-lock.json"));
        const repaired = await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx);
        expect(repaired).toMatchObject({ status: "done", excerpt: "npx cache: repaired and installed" });
        expect((await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx)).excerpt).toBe("npx cache: reused (verified by OpenHub)");
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }, 900_000);
});
