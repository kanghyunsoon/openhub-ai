import os from "node:os";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm, stat, unlink } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  NPX_PREPARED_MARKER,
  createTreeKiller,
  inspectNpxEntry,
  locateWindowsNpxLauncher,
  nodeExecSpawner,
  npmChildEnv,
  npmToolArgv,
  npxCacheKey,
  npxPrepareArgs,
  parseNpmSpec,
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
        // 실제 CLI·Desktop처럼 npm 자식 환경 허용 목록을 넘긴다(가짜 API key는 넘어가지 않아야 한다).
        const env: InstallEnvironment = {
          ...rest,
          spawner: nodeExecSpawner,
          windowsNpx: async () => windowsNpx,
          killTree: createTreeKiller({ cwd: os.tmpdir() }),
          npmChildEnv: () => npmChildEnv({ ...process.env, OPENAI_API_KEY: "sk-openhub-e2e-fake" }),
        };
        const request = { ...h.request("memory-mcp", CLAUDE), platform } as const;
        const planned = await plannedOf({ ...h, env }, request);
        expect(planned.plan.steps[0]).toMatchObject({ id: "npx-prepare", args: npxPrepareArgs(SPEC) });
        const started = Date.now();
        const result = await runInstallTransaction(planned, await approveAll(planned), request, env);
        console.log("prepare+install ms " + String(Date.now() - started) + " " + JSON.stringify(result.steps));
        expect(result.status).toBe("succeeded");
        expect(result.verification?.prepared).toBe("cached");
        expect(JSON.stringify(result)).not.toContain("sk-openhub-e2e-fake");
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

  it("중간에 끊긴 Prepare는 이번에 만든 항목만 정리하고, 재시도가 되며, 이미 있던 손상 항목은 지우지 않고 수동 복구 뒤 다시 받는다", async () => {
    await withCache(async (cache) => {
      const windowsNpx = await launcher();
      const ctx = { platform, windowsNpx, spawner: nodeExecSpawner, killTree: createTreeKiller({ cwd: os.tmpdir() }), childEnv: npmChildEnv(process.env) } as const;
      const cwd = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-prepare-cwd-"));
      const dir = path.join(cache, "_npx", npxCacheKey(SPEC));
      try {
        const cut = await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, { ...ctx, timeoutMs: INTERRUPT_MS });
        console.log("interrupted: " + JSON.stringify(cut));
        expect(cut).toMatchObject({ status: "failed", code: "STEP_TIMEOUT" });
        // 이번 시도가 만든 항목은 정리하고 빈 자리를 남긴다(기다리던 다른 npx가 그 자리에서 새로 받을 수 있다).
        expect(existsSync(dir) ? await readdir(dir) : []).toEqual([]);
        const retry = await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx);
        expect(retry).toMatchObject({ status: "done", excerpt: "npx cache: installed (file checks passed)" });
        expect((await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx)).excerpt).toBe("npx cache: reused (file checks passed)");
        // npm 완료 표시를 지워 "다른 process가 끊긴 설치"를 흉내 낸다. OpenHub는 이 항목을 지우지 않는다.
        await unlink(path.join(dir, "node_modules", ".package-lock.json"));
        const damaged = await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx);
        expect(damaged).toMatchObject({ status: "failed", code: "NPX_CACHE_DAMAGED" });
        expect(existsSync(path.join(dir, "package.json"))).toBe(true);
        // 사용자의 수동 복구(그 항목 하나만 삭제)를 흉내 낸 뒤 다시 받는다.
        await rm(dir, { recursive: true, force: true });
        expect(await prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx)).toMatchObject({ status: "done", excerpt: "npx cache: installed (file checks passed)" });
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }, 900_000);

  it("같은 spec의 Prepare 두 개와 외부 npx를 동시에 실행해도 모두 끝나고 최종 항목은 파일 검사를 통과한다", async () => {
    await withCache(async (cache) => {
      const windowsNpx = await launcher();
      const ctx = { platform, windowsNpx, spawner: nodeExecSpawner, killTree: createTreeKiller({ cwd: os.tmpdir() }), childEnv: npmChildEnv(process.env) } as const;
      const cwd = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-prepare-cwd-"));
      try {
        const external = npmToolArgv("npx", npxPrepareArgs(SPEC), platform, windowsNpx);
        if (external === null) throw new Error("npx launcher not found");
        const outside = new Promise<number | null>((resolve) => {
          const child = nodeExecSpawner(external.executable, external.args, { shell: false, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          child.on("error", () => resolve(-1));
          child.on("close", (code) => resolve(code));
        });
        const [a, b, ext] = await Promise.all([prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx), prepareNpxPackage(npxPrepareArgs(SPEC), cwd, ctx), outside]);
        console.log("concurrent: " + JSON.stringify({ a, b, ext }));
        expect(a.status).toBe("done");
        expect(b.status).toBe("done");
        expect(ext).toBe(0);
        const parsed = parseNpmSpec(SPEC);
        const entry = await inspectNpxEntry(path.join(cache, "_npx", npxCacheKey(SPEC)), parsed!.name, parsed!.version!);
        expect(entry.state).toBe("complete");
      } finally {
        await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
      }
    });
  }, 900_000);
});
