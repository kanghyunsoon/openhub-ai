import { EventEmitter } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatLifecyclePlanPreview,
  lifecyclePlanSchema,
  planBenchmark,
  planLifecycleRequest,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  uvxPrepareArgs,
  uvxVerifyArgs,
  type ExecChild,
  type ExecSpawner,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { configEntryDigest } from "../../src/lifecycle/status";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/** v0.2.1 uvx Prepare — update·rollback(정확한 버전). 합성 Manifest, 가짜 PyPI·spawner·Health(network·실제 uv 0). */
const seed = await seedEntries();
const scratch = await newScratch("uvx-prepare-lifecycle-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const PIN = "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted";
const entries: RegistryEntry[] = seed.map((e) => (e.manifest.name === "postgres-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: PIN } } } } : e));
const CURSOR = [{ client: "cursor" as const, scope: "project" as const }];
const V030 = { from: "postgres-mcp==0.3.0", withPins: ["mcp==1.30.0"] };
const V031 = { from: "postgres-mcp==0.3.1", withPins: ["mcp==1.30.0"] };

function uvxSpawner(spawns: string[][], codes: number[] = []): ExecSpawner {
  let n = 0;
  return (executable, args) => {
    spawns.push([executable, ...args]);
    const code = codes[n++] ?? 0;
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", code, null));
    return { pid: 9000 + n, stdout: null, stderr: new EventEmitter(), on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as unknown as ExecChild;
  };
}

async function installed() {
  const h = await createHarness(scratch, { entries });
  const install = h.request("postgres-mcp", CURSOR);
  const planned = await plannedOf(h, install);
  const r = await runInstallTransaction(planned, await approveAll(planned), install, h.env);
  expect(r.status).toBe("succeeded");
  expect(await recordInstallInState(planned, r, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-11T00:00:00.000Z") })).toMatchObject({ ok: true });
  const files = async () => [await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8"), await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8")];
  const env = (spawns: string[][], codes: number[] = []): LifecycleEnvironment => ({
    loadEntries: async () => entries,
    mcpSourceEnv: () => ({}),
    probe: () => h.env.probe(),
    tempBase: h.base,
    now: () => new Date("2026-10-12T00:00:00.000Z"),
    fetch: async (url: string) =>
      url.startsWith("https://pypi.org/pypi/postgres-mcp/") ? new Response(JSON.stringify({ info: { name: "postgres-mcp", version: url.includes("/0.3.0/") ? "0.3.0" : "0.3.1" } }), { status: 200 }) : new Response("missing", { status: 404 }),
    configFs: h.env.configFs!,
    spawner: uvxSpawner(spawns, codes),
    runHealth: async (verified) => ({ ok: true, result: { status: "healthy", reason: null, toolCount: 9, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null } }),
  });
  // 고정 버전 Manifest의 update는 기본적으로 Manifest 버전을 목표로 한다. 새 버전은 정확히 지정한다(--to).
  const request = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId: "postgres-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets: CURSOR, ...(operation === "update" ? { to: "0.3.1" } : {}) });
  const run = async (operation: LifecycleRequest["operation"], e: LifecycleEnvironment) => {
    const built = await planLifecycleRequest(request(operation), e);
    if (!built.ok) throw new Error(built.code + " " + built.message);
    if (built.planned.plan.status !== "ready") throw new Error("PLANSTATUS " + built.planned.plan.status + " " + JSON.stringify(built.planned.plan.warnings));
    const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    return { plan: built.planned.plan, result: await runLifecycleTransaction(built.planned, outcome.approval, request(operation), e) };
  };
  return { h, files, env, run, request };
}

describe("uvx Prepare: update·rollback", () => {
  it("정확한 버전 update는 새 버전 환경을 설정 교체 전에 준비하고 Health는 그 뒤다", async () => {
    const c = await installed();
    const spawns: string[][] = [];
    const { plan, result } = await c.run("update", c.env(spawns));
    expect(lifecyclePlanSchema.safeParse(plan).success).toBe(true);
    expect(plan.steps.map((s) => s.id)).toEqual(["uvx-prepare", "config-cursor-project", "health", "state-commit"]);
    expect(plan.steps[0]).toMatchObject({ executable: "uvx", args: uvxPrepareArgs(V031, "wheels-only"), timeoutMs: 600_000 });
    expect(plan.warnings.map((w) => w.code)).toContain("uvx-prepare");
    expect(plan.healthPolicy.timeouts.startupMs).toBe(20_000);
    const preview = formatLifecyclePlanPreview({ plan, planDigest: "sha256:" + "0".repeat(64) } as never).join("\n");
    expect(preview).toContain("uv cache에 설치하고 네트워크 없이 다시 확인합니다");
    expect(preview).not.toContain("image");
    expect(result.status).toBe("updated");
    expect(spawns).toEqual([["uvx", ...uvxPrepareArgs(V031, "wheels-only")], ["uvx", ...uvxVerifyArgs(V031, "wheels-only")]]);
    const config = JSON.parse((await c.files())[0]!);
    expect(config.mcpServers.postgres.args).toEqual(["--no-build", "--from", "postgres-mcp==0.3.1", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"]);
  });

  it("update 준비가 실패하면 preparation-failed이고 설정·Version State는 그대로다", async () => {
    const c = await installed();
    const before = await c.files();
    const spawns: string[][] = [];
    const { result } = await c.run("update", c.env(spawns, [1]));
    expect(result).toMatchObject({ status: "preparation-failed", stateCommitted: false });
    expect(spawns).toHaveLength(1);
    expect(await c.files()).toEqual(before);
  });

  it("rollback도 직전 정확한 버전 환경을 준비한 뒤 설정을 되돌린다", async () => {
    const c = await installed();
    expect((await c.run("update", c.env([]))).result.status).toBe("updated");
    const spawns: string[][] = [];
    const { plan, result } = await c.run("rollback", c.env(spawns));
    expect(plan.steps[0]).toMatchObject({ executable: "uvx", args: uvxPrepareArgs(V030, "wheels-only") });
    expect(result.status).toBe("rolled-back");
    expect(spawns[0]).toEqual(["uvx", ...uvxPrepareArgs(V030, "wheels-only")]);
    expect(JSON.parse((await c.files())[0]!).mcpServers.postgres.args.slice(0, 3)).toEqual(["--no-build", "--from", "postgres-mcp==0.3.0"]);
  });

  it("--no-build 이전 형식으로 기록된 설치(Version State·Client 설정)와도 호환된다: Health·update·rollback 모두 --no-build로 실행·기록한다(버전은 그대로)", async () => {
    const c = await installed();
    // --no-build 없이 기록된 설치를 만든다(이 PR 이전 형식). 설정 항목과 Version State의 clientSpec에서 같은 token만 지우고,
    // State에 기록된 설정 항목 digest도 그 항목에 맞춘다(외부 변경이 아니라 이전 버전이 쓴 일관된 기록).
    const cfgFile = path.join(c.h.projectRoot, ".cursor", "mcp.json");
    const stateFile = path.join(c.h.homeDir, ".openhub", "state", "lifecycle.json");
    const cfg = JSON.parse(await readFile(cfgFile, "utf8"));
    cfg.mcpServers.postgres.args = (cfg.mcpServers.postgres.args as string[]).filter((a) => a !== "--no-build");
    await writeFile(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    const state = JSON.parse(await readFile(stateFile, "utf8"));
    for (const tool of Object.values(state.entries) as { launch: { clientSpec: { args: string[] } }; config: { entryDigest: string } }[]) {
      tool.launch.clientSpec.args = (tool.launch.clientSpec.args as string[]).filter((a) => a !== "--no-build");
      tool.config.entryDigest = configEntryDigest(cfg.mcpServers.postgres);
    }
    await writeFile(stateFile, JSON.stringify(state, null, 2) + "\n");
    const old = JSON.parse(await readFile(cfgFile, "utf8")).mcpServers.postgres.args as string[];
    expect(old[0]).toBe("--from");
    // Health만: 설정은 바꾸지 않는다. OpenHub의 Health 실행은 기록된 인자 앞에 --no-build를 붙인다(소스 빌드 없음).
    const healthSpawns: string[][] = [];
    const health = await c.run("health", c.env(healthSpawns));
    expect(health.result.status).toBe("health-checked");
    expect(health.plan.steps.find((s) => s.kind === "health")).toMatchObject({ args: ["--no-build", ...old] });
    expect(JSON.parse(await readFile(cfgFile, "utf8")).mcpServers.postgres.args).toEqual(old);
    // Benchmark(설정을 쓰지 않음)도 기록된 인자 앞에 --no-build를 붙여 실행한다.
    const bench = await planBenchmark({ toolId: "postgres-mcp", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, entries, platform: "linux", includeUser: false, mcpSourceEnv: () => ({}) });
    if (!bench.ok) throw new Error(bench.code);
    expect(bench.planned.plan.launch?.args).toEqual(["--no-build", ...old]);
    // update: 새 인자는 --no-build로 시작하고 준비는 wheel만이다.
    const spawns: string[][] = [];
    const up = await c.run("update", c.env(spawns));
    expect(up.result.status).toBe("updated");
    expect(spawns[0]).toEqual(["uvx", ...uvxPrepareArgs(V031, "wheels-only")]);
    expect(JSON.parse(await readFile(cfgFile, "utf8")).mcpServers.postgres.args[0]).toBe("--no-build");
    // rollback: 기록된 직전 버전(0.3.0)으로 되돌리되 Client 실행에는 --no-build를 붙인다. 준비는 wheel만이다.
    const rb = await c.run("rollback", c.env([]));
    expect(rb.result.status).toBe("rolled-back");
    expect(rb.plan.steps[0]).toMatchObject({ args: uvxPrepareArgs(V030, "wheels-only") });
    expect(JSON.parse(await readFile(cfgFile, "utf8")).mcpServers.postgres.args).toEqual(["--no-build", ...old]);
  });

  it("Health만 하는 계획은 준비 단계가 없다(설정을 쓰지 않는다)", async () => {
    const c = await installed();
    const spawns: string[][] = [];
    const { plan } = await c.run("health", c.env(spawns));
    expect(plan.steps.some((s) => s.kind === "run")).toBe(false);
    expect(spawns).toEqual([]);
  });

  it("update 계획도 uv.toml의 패키지 출처 설정을 fingerprint로 담고, 승인 뒤 바뀌면 PLAN_STALE이다(준비·쓰기 0)", async () => {
    const c = await installed();
    const before = await c.files();
    let toml: string | null = '[[index]]\nurl = "https://ci-user:Toml-Pass@idx.example/simple"\ndefault = true\n';
    const spawns: string[][] = [];
    const e: LifecycleEnvironment = { ...c.env(spawns), uvChildEnv: () => ({ HOME: "/home/u" }), readUvConfig: async (f) => (f === "/home/u/.config/uv/uv.toml" ? toml : null) };
    const built = await planLifecycleRequest(c.request("update"), e);
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.steps[0]).toMatchObject({ executable: "uvx", index: { custom: true } });
    expect(JSON.stringify(built.planned.plan)).not.toContain("Toml-Pass");
    const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    toml = '[[index]]\nurl = "https://other.example/simple"\ndefault = true\n';
    const result = await runLifecycleTransaction(built.planned, outcome.approval, c.request("update"), e);
    expect(result).toMatchObject({ code: "PLAN_STALE" });
    expect(spawns).toEqual([]);
    expect(await c.files()).toEqual(before);
  });

  it("uv.toml을 읽을 수 없으면 update 계획이 막힌다(UVX_CONFIG_UNSUPPORTED)", async () => {
    const c = await installed();
    const e: LifecycleEnvironment = { ...c.env([]), uvChildEnv: () => ({ HOME: "/home/u" }), readUvConfig: async () => "broken = [" };
    const built = await planLifecycleRequest(c.request("update"), e);
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.status).not.toBe("ready");
    expect(JSON.stringify(built.planned.plan)).toContain("UVX_CONFIG_UNSUPPORTED");
  });
});
