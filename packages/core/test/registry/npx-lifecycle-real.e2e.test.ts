import os from "node:os";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  createTreeKiller,
  lifecycleStatus,
  locateWindowsNpxLauncher,
  nodeExecSpawner,
  npmChildEnv,
  planLifecycleRequest,
  readLifecycleState,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type InstallEnvironment,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.0 실제 npx Lifecycle E2E(OPENHUB_E2E=1에서만). 실제 npm·실제 MCP 서버로 버전 변경을 끝까지 실행한다.
 *   Install V1 → Prepare V1 → Health → Update V2 → Prepare V2 → Health → Rollback V1 → Health → Version State·설정 확인
 * - 대상: @modelcontextprotocol/server-memory(자격증명·외부 서비스가 필요 없는 공식 레퍼런스 서버). 두 버전 모두 npm에 실제로 있는 정확한 버전이다.
 * - 실제 Registry 파일은 바꾸지 않는다: Registry의 memory-mcp Manifest를 이 테스트 메모리 안에서만 복사해 V1로 고정한다.
 * - npm cache는 임시 폴더(npm_config_cache)로 격리한다. 사용자 DB·클러스터·인증 정보를 쓰지 않는다. Health는 실제 MCP handshake·tools/list다.
 */
const platform = process.platform === "win32" ? "windows" : "linux";
const PACKAGE = "@modelcontextprotocol/server-memory";
const V1 = "2026.7.4";
const V2 = "2026.8.31";
const NOTES = { command: "uvx", args: ["notes-mcp==1.0.0"] };

describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("v0.2.0 실제 npx Lifecycle E2E(install V1 → update V2 → rollback V1, 실제 npm·실제 Health)", () => {
  it("정확한 버전으로 준비·설정·Health를 거치고, rollback 뒤 V1 설정·Version State로 돌아오며 다른 항목은 그대로다", async () => {
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub e2e (npx) & 한글-"));
    const npmCache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
    const saved = process.env["npm_config_cache"];
    try {
      process.env["npm_config_cache"] = npmCache;
      const real = await seedEntries();
      const memory = real.find((e) => e.manifest.name === "memory-mcp")!;
      expect(memory.manifest.install.options?.["command"]).toBe("npx -y " + PACKAGE);
      // 테스트 메모리 안에서만 V1 고정(Registry 파일은 그대로).
      const pinned = structuredClone(memory);
      pinned.manifest.install.options = { ...pinned.manifest.install.options, command: "npx -y " + PACKAGE + "@" + V1 };
      const entries: RegistryEntry[] = real.map((e) => (e === memory ? pinned : e));
      const h = await createHarness(scratch, { entries });
      await writeFile(path.join(h.projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { notes: NOTES } }, null, 2) + "\n");
      await mkdir(path.join(h.projectRoot, ".codex"), { recursive: true });
      const codexBefore = '# mine\nmodel = "o4"\n\n[mcp_servers.notes]\ncommand = "uvx"\nargs = ["notes-mcp==1.0.0"]\n';
      await writeFile(path.join(h.projectRoot, ".codex", "config.toml"), codexBefore);
      const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
      const { spawner: _fake, ...rest } = h.env;
      const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const targets = [{ client: "claude-code" as const, scope: "project" as const }, { client: "codex" as const, scope: "project" as const }];
      const request = { ...h.request("memory-mcp", targets), platform } as const;

      // Install V1 → Prepare V1(실제 npm, 격리 cache)
      const planned = await plannedOf({ ...h, env }, request);
      expect(planned.plan.artifact).toMatchObject({ spec: PACKAGE + "@" + V1, pinned: true, preparation: "npm-cache" });
      expect(planned.plan.steps.map((s) => s.kind)).toEqual(["run", "config-patch", "config-patch"]);
      const installed = await runInstallTransaction(planned, await approveAll(planned), request, env);
      console.log("npx install " + JSON.stringify({ status: installed.status, steps: installed.steps.map((s) => s.id + ":" + s.status), verification: installed.verification }));
      expect(installed.status).toBe("succeeded");
      expect(installed.verification?.prepared).toBe("cached");
      expect(await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 2 });

      const lifecycleEnv: LifecycleEnvironment = {
        loadEntries: async () => entries,
        probe: h.env.probe,
        tempBase: os.tmpdir(),
        now: () => new Date(),
        fetch: globalThis.fetch,
        spawner: nodeExecSpawner,
        windowsNpx: async () => windowsNpx,
        killTree: createTreeKiller({ cwd: os.tmpdir() }),
        npmChildEnv: () => npmChildEnv(process.env),
      };
      const op = async (operation: LifecycleRequest["operation"], extra: Partial<LifecycleRequest> = {}) => {
        const req: LifecycleRequest = { operation, toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, platform, includeUser: false, targets, ...extra };
        const built = await planLifecycleRequest(req, lifecycleEnv);
        if (!built.ok) throw new Error(built.code + " " + built.message);
        const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
        if (outcome.status !== "approved") throw new Error(operation + " " + outcome.status + " " + JSON.stringify(built.planned.plan.warnings));
        const t0 = Date.now();
        const result = await runLifecycleTransaction(built.planned, outcome.approval, req, lifecycleEnv);
        console.log("npx " + operation + " " + String(Date.now() - t0) + "ms " + JSON.stringify({ status: result.status, health: result.health, steps: result.steps.map((s) => s.id + ":" + s.status), artifact: result.artifact }));
        return { plan: built.planned.plan, result };
      };
      const memoryArgs = async () => {
        const claude = JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> };
        const toml = await readFile(path.join(h.projectRoot, ".codex", "config.toml"), "utf8");
        return { claude: claude.mcpServers, toml };
      };
      const stateEntries = async () => {
        const s = await readLifecycleState({ homeDir: h.homeDir });
        if (!s.ok) throw new Error(s.code);
        return Object.values(s.state.entries).sort((a, b) => (a.target.client < b.target.client ? -1 : 1));
      };
      const hasVersion = (v: string, args: readonly string[]) => args.some((a) => a === PACKAGE + "@" + v);

      // Health(V1, 실제 MCP)
      const h1 = await op("health");
      expect(h1.result).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
      let files = await memoryArgs();
      expect(hasVersion(V1, files.claude["memory"]!.args)).toBe(true);
      expect(files.claude["notes"]).toEqual(NOTES);

      // Update V2 → Prepare V2(실제 npm) → Health(실제) → commit
      const up = await op("update", { to: V2 });
      expect(up.plan.steps.map((s) => s.kind)).toContain("run");
      expect(up.result).toMatchObject({ status: "updated", stateCommitted: true, health: { status: "healthy" }, artifact: { from: PACKAGE + "@" + V1, to: PACKAGE + "@" + V2 } });
      files = await memoryArgs();
      expect(hasVersion(V2, files.claude["memory"]!.args)).toBe(true);
      expect(files.toml).toContain(PACKAGE + "@" + V2);
      expect(files.toml.startsWith(codexBefore)).toBe(true);
      expect(files.claude["notes"]).toEqual(NOTES);
      let state = await stateEntries();
      expect(state.map((e) => [e.target.client, e.revision, e.artifact.resolved?.spec, e.lastHealth?.status, e.previous?.artifact.requested])).toEqual([
        ["claude-code", 2, PACKAGE + "@" + V2, "healthy", PACKAGE + "@" + V1],
        ["codex", 2, PACKAGE + "@" + V2, "healthy", PACKAGE + "@" + V1],
      ]);

      // Rollback V1 → Health(실제) → commit
      const back = await op("rollback");
      expect(back.result).toMatchObject({ status: "rolled-back", stateCommitted: true, health: { status: "healthy" } });
      files = await memoryArgs();
      expect(hasVersion(V1, files.claude["memory"]!.args)).toBe(true);
      expect(files.toml).toContain(PACKAGE + "@" + V1);
      expect(files.toml).not.toContain(PACKAGE + "@" + V2);
      expect(files.toml.startsWith(codexBefore)).toBe(true);
      expect(files.claude["notes"]).toEqual(NOTES);
      state = await stateEntries();
      expect(state.map((e) => [e.target.client, e.artifact.requested, e.lastHealth?.status])).toEqual([
        ["claude-code", PACKAGE + "@" + V1, "healthy"],
        ["codex", PACKAGE + "@" + V1, "healthy"],
      ]);
      const s = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: false });
      expect(s.ok && s.items.filter((i) => i.toolId === "memory-mcp").map((i) => i.state)).toEqual(["state-consistent", "state-consistent"]);
      // 마지막 Health(rollback 뒤 V1).
      const h3 = await op("health");
      expect(h3.result).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
    } finally {
      if (saved === undefined) delete process.env["npm_config_cache"];
      else process.env["npm_config_cache"] = saved;
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      await rm(npmCache, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
    }
  }, 900_000);
});

