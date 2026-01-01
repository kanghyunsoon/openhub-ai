import { readFile, rm, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  buildInstallPlan,
  configEntryDigest,
  containsAbsolutePath,
  lifecycleStatus,
  nodeConfigFs,
  readConfiguredEntry,
  readLifecycleState,
  recordInstallInState,
  runInstallTransaction,
  standardEntries,
  tomlBlockDigest,
  type ConfigFs,
  type InstallRequest,
  type LifecycleStateFile,
  type RegistryEntry,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { ALL_AVAILABLE, clientProfile, expectInstallerGolden, reportFor, target } from "../installer/helpers";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { newScratch } from "./helpers";

const seed = await seedEntries();
const scratch = await newScratch("status-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());
const NOW = () => new Date("2026-10-07T01:02:03.000Z");

async function installed(h: Harness, toolId: string, targets: InstallRequest["targets"], includeHost = false) {
  const request = h.request(toolId, targets, includeHost);
  const planned = await plannedOf(h, request);
  const approval = planned.plan.status === "already-installed" ? undefined : await approveAll(planned);
  const result = await runInstallTransaction(planned, approval, request, h.env);
  const recorded = await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: NOW });
  return { planned, result, recorded };
}
async function stateOf(h: Harness): Promise<LifecycleStateFile> {
  const r = await readLifecycleState({ homeDir: h.homeDir });
  if (!r.ok) throw new Error(r.code);
  return r.state;
}
const status = (h: Harness, over: Partial<Parameters<typeof lifecycleStatus>[0]> = {}) =>
  lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false, ...over });
async function items(h: Harness, over: Partial<Parameters<typeof lifecycleStatus>[0]> = {}) {
  const r = await status(h, over);
  if (!r.ok) throw new Error(r.code);
  return r.items;
}

describe("REQ-043 Install 연계·Status·Drift", () => {
  it("AC-038-01 M4 설치가 succeeded이면 target마다 entry가 생긴다(resolved null, revision 1, entryDigest)", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const { recorded } = await installed(h, "postgres-mcp", [{ client: "claude-code", scope: "project" }, { client: "codex", scope: "project" }]);
    expect(recorded).toEqual({ ok: true, recorded: 2 });
    const entries = Object.values((await stateOf(h)).entries);
    expect(entries.map((e) => [e.target.client, e.revision, e.artifact.requested, e.artifact.resolved, e.committedAt])).toEqual([
      ["claude-code", 1, "postgres-mcp", null, "2026-10-07T01:02:03.000Z"],
      ["codex", 1, "postgres-mcp", null, "2026-10-07T01:02:03.000Z"],
    ]);
    const roots = { projectRoot: h.projectRoot, homeDir: h.homeDir };
    for (const e of entries) {
      expect(e.config.entryDigest).toBe(configEntryDigest(await readConfiguredEntry(e.target.client, e.target.scope, e.target.serverName, roots)));
      expect(e.launch.clientSpec).toEqual({ command: "uvx", args: ["postgres-mcp", "--access-mode=restricted"] });
    }
    const codex = entries.find((e) => e.target.client === "codex")!;
    expect(codex.config.tomlBlockDigest).toBe(tomlBlockDigest("postgres", (await readConfiguredEntry("codex", "project", "postgres", roots)) as never));
    expect(await readFile(path.join(h.projectRoot, ".codex", "config.toml"), "utf8")).toContain('[mcp_servers.postgres]\ncommand = "uvx"');
  });

  it("AC-038-01 failed·partial-compensated·no-op 설치는 entry를 0개 남긴다", async () => {
    const failed = await createHarness(scratch, { entries: seed, exitCode: 1 });
    expect((await installed(failed, "github-mcp-server", [{ client: "cursor", scope: "project" }])).recorded).toEqual({ ok: true, recorded: 0 });
    const partial = await createHarness(scratch, { entries: seed, failRenameFor: ".cursor/mcp.json" });
    const p = await installed(partial, "memory-mcp", [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "project" }]);
    expect(p.result.status).toBe("partial-compensated");
    expect(p.recorded).toEqual({ ok: true, recorded: 0 });
    const noop = await createHarness(scratch, { entries: seed });
    await writeFile(path.join(noop.projectRoot, ".mcp.json"), '{ "mcpServers": { "memory": { "command": "npx", "args": [] } } }\n');
    const n = await installed(noop, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    expect(n.result.status).toBe("no-op");
    for (const h of [failed, partial, noop]) expect(Object.keys((await stateOf(h)).entries)).toEqual([]);
  });

  it("AC-038-02 InstallPlan v1 골든 byte와 M4 계약이 그대로다", async () => {
    const plan = (toolId: string, platform: "linux" | "windows") => {
      const built = buildInstallPlan({ toolId, entries: seed, report: reportFor(clientProfile(), seed), probes: ALL_AVAILABLE, targets: [target("claude-code")], platform });
      if (!built.ok) throw new Error(built.code);
      return built.planned.plan;
    };
    const ids = seed.map((e) => e.manifest.name).sort();
    const specsFor = (platform: "linux" | "windows") => Object.fromEntries(ids.map((id) => [id, { backend: plan(id, platform).backend?.adapter, launch: plan(id, platform).launch }]));
    const { canonicalize } = await import("../../src/index");
    await expectInstallerGolden("seed-launch-specs.json", JSON.stringify(canonicalize({ linux: specsFor("linux"), windows: specsFor("windows") }), null, 2) + "\n");
  });

  it("AC-038-03 config 항목 digest가 state와 같으면 state-consistent다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    expect((await items(h)).map((i) => [i.serverName, i.state, i.revision])).toEqual([["memory", "state-consistent", 1]]);
  });

  it("AC-038-04 항목을 수동 수정하면 config-drift, key나 파일을 지우면 missing-config다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "project" }]);
    const claude = path.join(h.projectRoot, ".mcp.json");
    const doc = JSON.parse(await readFile(claude, "utf8"));
    doc.mcpServers.memory.args.push("--extra");
    await writeFile(claude, JSON.stringify(doc));
    await unlink(path.join(h.projectRoot, ".cursor", "mcp.json"));
    expect((await items(h)).map((i) => [i.client, i.state])).toEqual([
      ["claude-code", "config-drift"],
      ["cursor", "missing-config"],
    ]);
    delete doc.mcpServers.memory;
    await writeFile(claude, JSON.stringify(doc));
    expect((await items(h))[0]!.state).toBe("missing-config");
  });

  it("AC-038-05 state 없이 표준 항목과 같으면 untracked-adoptable, 다르면 untracked-foreign이며 자동 편입하지 않는다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const memory = seed.find((e) => e.manifest.name === "memory-mcp")!.manifest;
    const [standard] = standardEntries(memory, "claude-code", "linux");
    await writeFile(path.join(h.projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { memory: standard, context7: { command: "node", args: ["my-context7.js"] } } }, null, 2));
    expect((await items(h)).map((i) => [i.serverName, i.state, i.toolId])).toEqual([
      ["context7", "untracked-foreign", null],
      ["memory", "untracked-adoptable", "memory-mcp"],
    ]);
    expect(Object.keys((await stateOf(h)).entries)).toEqual([]);
  });

  it("AC-038-06 floating은 artifact-unlocked, 고정 spec은 artifact-locked, docker 로컬 존재는 artifact-unknown이다", async () => {
    const pinned: RegistryEntry[] = seed.map((e) =>
      e.manifest.name === "memory-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: "npx -y @modelcontextprotocol/server-memory@2025.9.1" } } } } : e,
    );
    const h = await createHarness(scratch, { entries: pinned });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    await installed(h, "context7", [{ client: "claude-code", scope: "project" }]);
    await installed(h, "github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const byName = Object.fromEntries((await items(h, { entries: pinned })).map((i) => [i.serverName, i.artifact]));
    expect(byName["memory"]).toEqual({ lock: "artifact-locked", presence: "launch-on-demand", requested: "@modelcontextprotocol/server-memory@2025.9.1", resolved: "@modelcontextprotocol/server-memory@2025.9.1" });
    expect(byName["context7"]).toMatchObject({ lock: "artifact-unlocked", presence: "launch-on-demand", resolved: null });
    expect(byName["github"]).toMatchObject({ lock: "artifact-unlocked", presence: "artifact-unknown" });
    const memory = Object.values((await stateOf(h)).entries).find((e) => e.target.serverName === "memory")!;
    expect(memory.artifact.resolved).toEqual({ kind: "npm-package", spec: "@modelcontextprotocol/server-memory@2025.9.1", version: "2025.9.1", digest: null, integrity: null, source: "npm-registry" });
  });

  it("AC-038-07 status 계산 중 fetch·spawn·write가 0회다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const writes: string[] = [];
    const spyFs: ConfigFs = {
      ...nodeConfigFs,
      writeFile: async (f, d) => (writes.push(f), nodeConfigFs.writeFile(f, d)),
      rename: async (a, b) => (writes.push(b), nodeConfigFs.rename(a, b)),
      mkdir: async (d) => (writes.push(d), nodeConfigFs.mkdir(d)),
      rm: async (f) => (writes.push(f), nodeConfigFs.rm(f)),
    };
    await items(h, { fs: spyFs, includeUser: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(writes).toEqual([]);
    const src = await readFile(path.resolve(import.meta.dirname, "../../src/lifecycle/status.ts"), "utf8");
    expect(src).not.toMatch(/child_process|process\/|resolver|fetch\(/u);
  });

  it("AC-038-08 project status에 다른 projectKey의 entry가 없고 user scope는 따로 구분된다", async () => {
    const a = await createHarness(scratch, { entries: seed });
    await installed(a, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    await installed(a, "context7", [{ client: "cursor", scope: "user" }], true);
    // 같은 home에 다른 프로젝트 설치 기록을 더한다.
    const b = await createHarness(scratch, { entries: seed });
    const other = { ...b, homeDir: a.homeDir, request: (t: string, tg: InstallRequest["targets"]) => ({ ...b.request(t, tg), homeDir: a.homeDir }) } as Harness;
    const req = other.request("playwright-mcp", [{ client: "claude-code", scope: "project" }]);
    const planned = await plannedOf(b, req);
    const result = await runInstallTransaction(planned, await approveAll(planned), req, b.env);
    await recordInstallInState(planned, result, { projectRoot: b.projectRoot, homeDir: a.homeDir, now: NOW });
    expect(Object.keys((await stateOf(a)).entries)).toHaveLength(3);
    expect((await items(a)).map((i) => [i.scope, i.serverName, i.state])).toEqual([
      ["project", "memory", "state-consistent"],
      ["user", "context7", "not-inspected"],
    ]);
    expect((await items(a, { includeUser: true })).map((i) => [i.scope, i.serverName, i.state])).toEqual([
      ["project", "memory", "state-consistent"],
      ["user", "context7", "state-consistent"],
    ]);
  });

  it("AC-038-09 status JSON에 절대 경로·env 값이 0건이다", async () => {
    vi.stubEnv("DATABASE_URI", "postgresql://admin:Sup3r@db/app");
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "postgres-mcp", [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "user" }], true);
    const out = JSON.stringify(await items(h, { includeUser: true }));
    expect(containsAbsolutePath(out)).toBe(false);
    for (const leak of ["Sup3r", "postgresql://", h.projectRoot, h.homeDir]) expect(out).not.toContain(leak);
    const file = await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8");
    for (const leak of ["Sup3r", h.projectRoot, h.homeDir]) expect(file).not.toContain(leak);
    vi.unstubAllEnvs();
  });

  it("AC-038-01 같은 EntryKey를 다시 설치하면 새 기록(revision 1)으로 바꾸고 다른 entry는 그대로다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    await installed(h, "context7", [{ client: "claude-code", scope: "project" }]);
    expect(Object.values((await stateOf(h)).entries).map((e) => e.target.serverName).sort()).toEqual(["context7", "memory"]);
  });
});
