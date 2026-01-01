import { EventEmitter } from "node:events";
import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  EXEC_EXCERPT_BYTES,
  EXEC_MAX_BUFFER_BYTES,
  InstallationRouter,
  OutputTail,
  buildInstallPlan,
  dockerAdapter,
  executeVerifiedPlan,
  npxAdapter,
  uvxAdapter,
  type ExecChild,
  type ExecSpawnOptions,
  type ExecSpawner,
  type IsolatedDir,
  type PlanBuildInput,
  type PlannedInstall,
  type VerifiedPlan,
} from "../../src/index";
import { REPO_ROOT, item, seedEntries } from "../recommendation/helpers";
import { ALL_AVAILABLE, clientProfile, entryOf, planFor, reportFor, target, verifiedPlanOf } from "./helpers";

const seed = await seedEntries();
const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-exec-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

interface Script {
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  hang?: boolean;
}
interface SpawnCall {
  executable: string;
  args: readonly string[];
  options: ExecSpawnOptions;
}
function fakeSpawner(script: Script = {}): ExecSpawner & { calls: SpawnCall[]; kills: (string | undefined)[] } {
  const calls: SpawnCall[] = [];
  const kills: (string | undefined)[] = [];
  const spawner = ((executable, args, options) => {
    calls.push({ executable, args: [...args], options });
    const events = new EventEmitter();
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const child: ExecChild = {
      stdout,
      stderr,
      on: (event: string, listener: (...a: unknown[]) => void) => events.on(event, listener),
      kill: (signal) => {
        kills.push(signal);
        queueMicrotask(() => events.emit("close", null, signal ?? "SIGTERM"));
        return true;
      },
    } as ExecChild;
    if (!script.hang) {
      queueMicrotask(() => {
        if (script.stdout !== undefined) stdout.emit("data", Buffer.from(script.stdout));
        if (script.stderr !== undefined) stderr.emit("data", Buffer.from(script.stderr));
        events.emit("close", script.exitCode ?? 0, null);
      });
    }
    return child;
  }) as ExecSpawner & { calls: SpawnCall[]; kills: (string | undefined)[] };
  spawner.calls = calls;
  spawner.kills = kills;
  return spawner;
}

async function isolated(): Promise<IsolatedDir> {
  const dir = await mkdtemp(path.join(scratch, "iso-"));
  return { path: dir, base: scratch, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

function built(toolId: string, over: Partial<PlanBuildInput> = {}): PlannedInstall {
  const p = toolId === "postgres-mcp" ? clientProfile({ databases: [item("postgresql", "PostgreSQL", "dependency", { file: "pyproject.toml" })] }) : clientProfile();
  const result = buildInstallPlan({ toolId, entries: seed, report: reportFor(p, seed), probes: ALL_AVAILABLE, targets: [target("claude-code")], platform: "linux", ...over });
  if (!result.ok) throw new Error(result.code);
  return result.planned;
}
const verifiedOf = (toolId: string, over: Partial<PlanBuildInput> = {}) => verifiedPlanOf(built(toolId, over));
const IMAGE = "ghcr.io/github/github-mcp-server";

describe("REQ-031 REQ-033 Process Executor와 npx·uvx·docker Adapter", () => {
  it("AC-031-01 Executor는 TASK-028이 발급한 VerifiedPlan만 받고 아니면 spawn 0회다", async () => {
    const spawner = fakeSpawner();
    const verified = await verifiedOf("github-mcp-server");
    const forged = [{ ...verified }, { plan: verified.plan, planDigest: verified.planDigest, acknowledgements: ["base"], channel: "cli-tty" }, built("github-mcp-server")];
    for (const candidate of forged) {
      expect(await executeVerifiedPlan(candidate as unknown as VerifiedPlan, { projectRoot: scratch, spawner, isolatedDir: isolated })).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    }
    expect(spawner.calls).toEqual([]);
    expect(await executeVerifiedPlan(verified, { projectRoot: scratch, spawner, isolatedDir: isolated })).toMatchObject({ ok: true, prepared: true });
    expect(await executeVerifiedPlan(verified, { projectRoot: scratch, spawner, isolatedDir: isolated })).toMatchObject({ ok: false, code: "VERIFIED_PLAN_CONSUMED" });
    expect(spawner.calls).toHaveLength(1);
  });

  it("AC-031-02 spawner가 받은 argv는 Plan step과 정확히 같고 shell:false다", async () => {
    const spawner = fakeSpawner();
    const verified = await verifiedOf("github-mcp-server");
    await executeVerifiedPlan(verified, { projectRoot: scratch, spawner, isolatedDir: isolated });
    const step = verified.plan.steps[0]!;
    expect(step.kind).toBe("run");
    expect(spawner.calls).toHaveLength(1);
    expect(spawner.calls[0]).toMatchObject({ executable: "docker", args: step.kind === "run" ? step.args : [] });
    expect(spawner.calls[0]!.args).toEqual(["pull", IMAGE]);
    expect(spawner.calls[0]!.options).toMatchObject({ shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  });

  it("AC-031-03 timeout이면 종료하고 signal을 기록하며 결과에는 redact한 마지막 1KB만 남긴다", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const spawner = fakeSpawner({ hang: true });
    const verified = await verifiedOf("github-mcp-server");
    const pending = executeVerifiedPlan(verified, { projectRoot: scratch, spawner, isolatedDir: isolated });
    while (spawner.calls.length === 0) await new Promise((resolve) => setImmediate(resolve));
    await vi.advanceTimersByTimeAsync(599_999);
    expect(spawner.kills).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    const report = await pending;
    expect(spawner.kills).toEqual(["SIGTERM"]);
    expect(report).toMatchObject({
      ok: true,
      prepared: false,
      failedStep: "docker-pull",
      steps: [{ id: "docker-pull", status: "failed", code: "STEP_TIMEOUT", signal: "SIGTERM" }, { id: "config-claude-code-project", status: "skipped" }],
    });
    vi.useRealTimers();

    const noisy = "x".repeat(100_000) + "\nC:\\Users\\victim\\.docker\\config.json denied\ntoken ghp_" + "a".repeat(36) + "\nhttps://user:pw@registry.example/v2\nfinal line";
    const failing = fakeSpawner({ exitCode: 1, stderr: noisy });
    const result = await executeVerifiedPlan(await verifiedOf("github-mcp-server"), { projectRoot: scratch, spawner: failing, isolatedDir: isolated });
    if (!result.ok) throw new Error("unexpected");
    const excerpt = result.steps[0]!.excerpt!;
    expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(EXEC_EXCERPT_BYTES + 64);
    expect(excerpt).toContain("final line");
    for (const leak of ["victim", "ghp_", "user:pw"]) expect(excerpt).not.toContain(leak);

    const tail = new OutputTail();
    for (let i = 0; i < 10; i += 1) tail.push(Buffer.alloc(20_000, 0x61 + i));
    expect(tail.size).toBe(EXEC_MAX_BUFFER_BYTES);
    expect(EXEC_MAX_BUFFER_BYTES).toBe(64 * 1024);
    expect(tail.tail(1).charCodeAt(0)).toBe(0x61 + 9);
  });

  it("AC-031-04 cwd는 project root 또는 격리 임시 디렉터리뿐이고 symlink·junction으로 밖을 가리키면 거부한다", async () => {
    const spawner = fakeSpawner();
    let created = "";
    await executeVerifiedPlan(await verifiedOf("github-mcp-server"), { projectRoot: scratch, spawner, isolatedDir: async () => ((created = (await isolated()).path), { path: created, base: scratch, cleanup: async () => undefined }) });
    expect(spawner.calls[0]!.options.cwd).toBe(created);

    const outside = await mkdtemp(path.join(os.tmpdir(), "openhub-outside-"));
    const link = path.join(scratch, "escape-link");
    await symlink(outside, link, "junction");
    const escaping = fakeSpawner();
    const report = await executeVerifiedPlan(await verifiedOf("github-mcp-server"), { projectRoot: scratch, spawner: escaping, isolatedDir: async () => ({ path: link, base: scratch, cleanup: async () => undefined }) });
    expect(report).toMatchObject({ ok: true, prepared: false, steps: [{ status: "failed", code: "CWD_REJECTED" }, { status: "skipped" }] });
    expect(escaping.calls).toEqual([]);

    // project cwd: project root 자체가 junction이면 거부한다.
    const projectStep = { id: "project-step", kind: "run" as const, executable: "docker" as const, args: ["pull", IMAGE], cwd: "project" as const, network: true, timeoutMs: 1000 };
    const projectPlan = planFor(seed, reportFor(clientProfile(), seed), "github-mcp-server", { preparation: [projectStep] });
    const linkedRoot = path.join(scratch, "linked-project");
    await symlink(outside, linkedRoot, "junction");
    const projectSpawner = fakeSpawner();
    expect(await executeVerifiedPlan(await verifiedPlanOf(projectPlan), { projectRoot: linkedRoot, spawner: projectSpawner })).toMatchObject({ steps: [{ code: "CWD_REJECTED" }, { status: "skipped" }] });
    expect(await executeVerifiedPlan(await verifiedPlanOf(projectPlan), { projectRoot: outside, spawner: projectSpawner })).toMatchObject({ prepared: true });
    expect(projectSpawner.calls.map((c) => c.options.cwd)).toEqual([path.resolve(outside)]);
    await rm(outside, { recursive: true, force: true });
  });

  it("AC-031-05 spawn 옵션에 env key가 없고 process.env 접근 0회이며 argv에 env 값이 없다", async () => {
    const secret = "ghp_" + "Z".repeat(36);
    vi.stubEnv("GITHUB_PERSONAL_ACCESS_TOKEN", secret);
    const spawner = fakeSpawner();
    const verified = await verifiedOf("github-mcp-server");
    const dir = await isolated();
    const original = process.env;
    const touched: string[] = [];
    process.env = new Proxy(original, {
      get: (t, k) => (touched.push("get:" + String(k)), Reflect.get(t, k)),
      has: (t, k) => (touched.push("has:" + String(k)), Reflect.has(t, k)),
      ownKeys: (t) => (touched.push("ownKeys"), Reflect.ownKeys(t)),
      set: (t, k, v) => (touched.push("set:" + String(k)), Reflect.set(t, k, v)),
    });
    try {
      await executeVerifiedPlan(verified, { projectRoot: scratch, spawner, isolatedDir: async () => dir });
    } finally {
      process.env = original;
    }
    expect(touched).toEqual([]);
    expect("env" in spawner.calls[0]!.options).toBe(false);
    expect(Object.keys(spawner.calls[0]!.options).sort()).toEqual(["cwd", "shell", "stdio", "windowsHide"]);
    expect(JSON.stringify(spawner.calls)).not.toContain(secret);
    expect(JSON.stringify(verified.plan)).not.toContain(secret);
    const src = (await readFile(path.resolve(import.meta.dirname, "../../src/process/executor.ts"), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
    expect(src).not.toContain("process.env");
    expect(src).not.toMatch(/\benv\s*:/u);
  });

  it("AC-031-06 준비 단계는 npx·uvx 0개(launch-on-demand), docker는 docker pull 1개이고 npm·cache add·cmd.exe가 0건이다", async () => {
    const spawner = fakeSpawner();
    for (const toolId of ["memory-mcp", "context7", "postgres-mcp", "serena"]) {
      const verified = await verifiedOf(toolId);
      expect(verified.plan.artifact?.preparation, toolId).toBe("launch-on-demand");
      expect(await executeVerifiedPlan(verified, { projectRoot: scratch, spawner, isolatedDir: isolated })).toMatchObject({ ok: true, prepared: true });
    }
    expect(spawner.calls).toEqual([]);
    const docker = await verifiedOf("github-mcp-server");
    expect(docker.plan.artifact?.preparation).toBe("pull");
    await executeVerifiedPlan(docker, { projectRoot: scratch, spawner, isolatedDir: isolated });
    expect(spawner.calls.map((c) => [c.executable, ...c.args])).toEqual([["docker", "pull", IMAGE]]);
    const record = JSON.stringify(spawner.calls);
    for (const banned of ['"npm"', "cache add", "cmd.exe", "/c"]) expect(record).not.toContain(banned);
  });

  it("AC-031-07 준비 단계가 non-zero exit이면 이후 단계를 건너뛰고 config 파일은 byte 하나도 바뀌지 않는다", async () => {
    const project = await mkdtemp(path.join(scratch, "project-"));
    const config = path.join(project, ".mcp.json");
    const original = '{\n    "mcpServers": {\n        "keep": { "command": "x" }\n    }\n}\n';
    await writeFile(config, original);
    const order: string[] = [];
    const onConfigStep = vi.fn(async (step: { id: string }) => {
      order.push("config:" + step.id);
      await writeFile(config, "{}");
      return { id: step.id, status: "done" as const };
    });
    const spawner = fakeSpawner({ exitCode: 125, stderr: "Error response from daemon" });
    const report = await executeVerifiedPlan(await verifiedOf("github-mcp-server"), { projectRoot: project, spawner, isolatedDir: isolated, onConfigStep });
    expect(report).toMatchObject({ ok: true, prepared: false, failedStep: "docker-pull", steps: [{ id: "docker-pull", status: "failed", exitCode: 125 }, { id: "config-claude-code-project", status: "skipped" }] });
    expect(onConfigStep).not.toHaveBeenCalled();
    expect(await readFile(config, "utf8")).toBe(original);

    const ok = fakeSpawner({ exitCode: 0 });
    const spawnOrder = ((...a: Parameters<ExecSpawner>) => (order.push("spawn:" + a[1].join(" ")), ok(...a))) as ExecSpawner;
    await executeVerifiedPlan(await verifiedOf("github-mcp-server"), { projectRoot: project, spawner: spawnOrder, isolatedDir: isolated, onConfigStep });
    expect(order).toEqual(["spawn:pull " + IMAGE, "config:config-claude-code-project"]);
  });

  it("AC-031-08 Adapter의 update·uninstall·healthCheck는 UNSUPPORTED_IN_M4이고 spawn 0회다", async () => {
    const memory = entryOf(seed, "memory-mcp").manifest;
    const target0 = { manifest: memory, step: { adapter: "npx" as const, options: memory.install.options } };
    const ctx = { platform: "linux" as const, availableAdapters: new Set(["npx" as const]) };
    for (const adapter of [npxAdapter, uvxAdapter, dockerAdapter]) {
      await expect(adapter.update(target0, { planDigest: "x", approvedBy: "x", approvedAt: "x" }, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED_IN_M4" });
      await expect(adapter.uninstall(target0, { planDigest: "x", approvedBy: "x", approvedAt: "x" }, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED_IN_M4" });
      await expect(adapter.healthCheck(target0, ctx)).rejects.toMatchObject({ code: "UNSUPPORTED_IN_M4" });
      await expect(adapter.plan(target0, "update", ctx)).rejects.toMatchObject({ code: "UNSUPPORTED_IN_M4" });
      await expect(adapter.install(target0, { planDigest: "x", approvedBy: "x", approvedAt: "x" }, ctx)).rejects.toMatchObject({ code: "INSTALL_PLAN_V1_REQUIRED" });
    }
    // M1 Router와 그대로 조합된다(CON-002).
    const route = new InstallationRouter([npxAdapter, uvxAdapter, dockerAdapter]).select(memory, ctx);
    expect(route).toMatchObject({ ok: true, source: "preferred" });
    expect(route.ok && route.adapter.id).toBe("npx");
    const backendsSrc = await readFile(path.resolve(import.meta.dirname, "../../src/installer/backends.ts"), "utf8");
    expect(backendsSrc).not.toMatch(/child_process|spawn\(/u);
  });

  it("AC-031-09 기본 테스트와 CI는 fake spawner만 쓰고 실제 설치 e2e는 OPENHUB_E2E=1일 때만 실행한다", async () => {
    const roots = ["packages/core/test", "apps/cli/test", "apps/desktop/test"].map((d) => path.join(REPO_ROOT, d));
    const offenders: string[] = [];
    for (const dir of roots) {
      let files: string[] = [];
      try {
        files = (await readdir(dir, { recursive: true })).filter((f) => f.endsWith(".ts"));
      } catch {
        continue;
      }
      for (const file of files) {
        const src = await readFile(path.join(dir, file), "utf8");
        const real = /nodeExecSpawner|nodeProbeSpawner|from "node:child_process"/u.test(src.replace(/AC-031-09[\s\S]*$/u, ""));
        if (real && !src.includes('process.env["OPENHUB_E2E"] !== "1"')) offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
    const ci = await readFile(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
    expect(ci).not.toContain("OPENHUB_E2E");
    await expect(readFile(path.join(import.meta.dirname, "executor.e2e.test.ts"), "utf8")).resolves.toContain('describe.skipIf(process.env["OPENHUB_E2E"] !== "1")');
  });
});
