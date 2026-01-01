import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyzeProject,
  installResultSchema,
  nodeConfigFs,
  planInstall,
  requestApproval,
  runInstallTransaction,
  serializeInstallResult,
  type ApprovalRequirement,
  type ConfigFs,
  type ExecChild,
  type ExecSpawner,
  type InstallEnvironment,
  type InstallRequest,
  type PlannedInstall,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { ALL_AVAILABLE } from "./helpers";

const seed = await seedEntries();
const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-tx-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

interface Harness {
  env: InstallEnvironment;
  log: string[];
  spawns: string[][];
  writes: string[];
  request: (toolId: string, targets: InstallRequest["targets"]) => InstallRequest;
  projectRoot: string;
  homeDir: string;
  isoBase: string;
}

async function harness(options: { exitCode?: number; stderr?: string; failRenameFor?: string } = {}): Promise<Harness> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const projectRoot = path.join(base, "project");
  const homeDir = path.join(base, "home");
  const isoBase = path.join(base, "tmp");
  for (const d of [projectRoot, homeDir, isoBase]) await mkdir(d);
  await writeFile(path.join(projectRoot, "package.json"), '{ "name": "demo", "private": true }\n');
  const log: string[] = [];
  const spawns: string[][] = [];
  const writes: string[] = [];
  const rel = (f: string) => path.relative(base, f).replace(/\\/gu, "/");
  const configFs: ConfigFs = {
    ...nodeConfigFs,
    writeFile: async (f, d) => (writes.push("write:" + rel(f)), log.push("write"), nodeConfigFs.writeFile(f, d)),
    rename: async (a, b) => {
      writes.push("rename:" + rel(b));
      if (options.failRenameFor !== undefined && rel(b).endsWith(options.failRenameFor)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return nodeConfigFs.rename(a, b);
    },
    mkdir: async (d) => (writes.push("mkdir:" + rel(d)), nodeConfigFs.mkdir(d)),
    rm: async (f) => (writes.push("rm:" + rel(f)), nodeConfigFs.rm(f)),
  };
  const spawner: ExecSpawner = (executable, args) => {
    spawns.push([executable, ...args]);
    log.push("spawn");
    const events = new EventEmitter();
    const stderr = new EventEmitter();
    queueMicrotask(() => {
      if (options.stderr !== undefined) stderr.emit("data", Buffer.from(options.stderr));
      events.emit("close", options.exitCode ?? 0, null);
    });
    return { stdout: null, stderr, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
  };
  const env: InstallEnvironment = {
    loadEntries: async () => seed,
    analyze: async (root, includeHost) => {
      const result = await analyzeProject(root, { includeHost });
      if (!result.ok) throw new Error(result.error.code);
      return result.profile;
    },
    probe: async () => (log.push("probe-call"), ALL_AVAILABLE),
    configFs,
    spawner,
    isolatedDir: async () => {
      const dir = await mkdtemp(path.join(isoBase, "iso-"));
      return { path: dir, base: isoBase, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
    trace: (phase) => log.push(phase),
  };
  return { env, log, spawns, writes, projectRoot, homeDir, isoBase, request: (toolId, targets) => ({ toolId, projectRoot, homeDir, targets, includeHost: false, platform: "linux" }) };
}

async function planned(h: Harness, request: InstallRequest): Promise<PlannedInstall> {
  const { result } = await planInstall(request, h.env);
  if (!result.ok) throw new Error(result.code);
  return result.planned;
}
async function approve(p: PlannedInstall, skip: readonly ApprovalRequirement[] = []) {
  const outcome = await requestApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id).filter((id) => !skip.includes(id)) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  return outcome.approval;
}
const reset = (h: Harness) => {
  h.log.length = 0;
  h.spawns.length = 0;
  h.writes.length = 0;
};
const listing = async (dir: string) => (await readdir(dir, { recursive: true })).map((f) => f.replace(/\\/gu, "/")).sort();

describe("REQ-030 Install Transaction(실패 안전성·멱등성)", () => {
  it("AC-033-01 실행 순서는 승인 확인 → 재생성·digest 비교 → probe → 준비 단계 → config write → 확인이다", async () => {
    const h = await harness();
    const request = h.request("github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const p = await planned(h, request);
    const approval = await approve(p);
    reset(h);
    const result = await runInstallTransaction(p, approval, request, h.env);
    expect(result.status).toBe("succeeded");
    expect(h.log).toEqual(["approval-check", "regenerate", "probe-call", "digest-compare", "probe", "probe-call", "prepare", "spawn", "config-write", "write", "verify"]);
    expect(h.spawns).toEqual([["docker", "pull", "ghcr.io/github/github-mcp-server"]]);
  });

  it("AC-033-01 승인 후 대상 config가 바뀌면 재생성 비교에서 멈추고 아무것도 실행하지 않는다", async () => {
    const h = await harness();
    const request = h.request("github-mcp-server", [{ client: "claude-code", scope: "project" }]);
    const p = await planned(h, request);
    const approval = await approve(p);
    await writeFile(path.join(h.projectRoot, ".mcp.json"), '{ "mcpServers": {} }\n');
    reset(h);
    const result = await runInstallTransaction(p, approval, request, h.env);
    expect(result).toMatchObject({ status: "stale", code: "PLAN_STALE", retryable: true, verification: null });
    expect(result.changed).toContain("config-precondition");
    expect(h.spawns).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("AC-033-02 두 번째 config write가 실패하면 첫 번째 파일을 원본 byte로 복구하고 partial-compensated로 기록한다", async () => {
    const h = await harness({ failRenameFor: ".cursor/mcp.json" });
    const original = '{\n\t"mcpServers": { "keep": { "command": "x", "args": [] } }\n}';
    await writeFile(path.join(h.projectRoot, ".mcp.json"), original);
    const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "project" }]);
    const p = await planned(h, request);
    const result = await runInstallTransaction(p, await approve(p), request, h.env);
    expect(result).toMatchObject({ status: "partial-compensated", code: "CONFIG_WRITE_FAILED", failedStep: "config-cursor-project", retryable: true });
    expect(result.steps).toEqual([
      { id: "config-claude-code-project", status: "compensated" },
      { id: "config-cursor-project", status: "failed", code: "CONFIG_WRITE_FAILED", excerpt: expect.any(String) },
    ]);
    expect(result.configChanges).toEqual([
      { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "memory", applied: true, restored: true },
      { client: "cursor", scope: "project", file: ".cursor/mcp.json", serverName: "memory", applied: false, restored: false },
    ]);
    expect(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).toBe(original);
    expect(await listing(h.projectRoot)).toEqual([".mcp.json", "package.json"]);
  });

  it("AC-033-03 InstallResult v1이 schema를 통과하고 failedStep·retryable이 정확하다", async () => {
    const fail = await harness({ exitCode: 1 });
    const req1 = fail.request("github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const p1 = await planned(fail, req1);
    const failed = await runInstallTransaction(p1, await approve(p1), req1, fail.env);
    expect(installResultSchema.parse(failed)).toEqual(failed);
    expect(failed).toMatchObject({ status: "failed", failedStep: "docker-pull", retryable: true, verification: { prepared: "failed", configured: false } });
    expect(failed.steps.map((s) => s.status)).toEqual(["failed", "skipped"]);

    const ok = await harness();
    const req2 = ok.request("memory-mcp", [{ client: "codex", scope: "project" }]);
    const p2 = await planned(ok, req2);
    const succeeded = await runInstallTransaction(p2, await approve(p2), req2, ok.env);
    expect(installResultSchema.parse(succeeded)).toEqual(succeeded);
    expect(succeeded).toMatchObject({ status: "succeeded", retryable: false, verification: { prepared: "launch-on-demand", configured: true, detected: "skipped" } });
    expect(succeeded.failedStep).toBeUndefined();
    expect(installResultSchema.safeParse({ ...succeeded, status: "installed" }).success).toBe(false);
    expect(installResultSchema.safeParse({ ...succeeded, auditLog: "x" }).success).toBe(false);
  });

  it("AC-033-04 already-installed는 spawn·파일 쓰기·probe 0회의 no-op이다", async () => {
    const h = await harness();
    await writeFile(path.join(h.projectRoot, ".mcp.json"), '{ "mcpServers": { "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] } } }\n');
    const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const p = await planned(h, request);
    expect(p.plan.status).toBe("already-installed");
    reset(h);
    const result = await runInstallTransaction(p, undefined, request, h.env);
    expect(result).toMatchObject({ status: "no-op", code: "ALREADY_INSTALLED", steps: [], configChanges: [], verification: null });
    expect(h.log).toEqual(["approval-check"]);
    expect(h.spawns).toEqual([]);
    expect(h.writes).toEqual([]);
  });

  it("AC-033-05 같은 설치를 두 번 실행하면 두 번째는 no-op이고 파일의 서버 항목은 1개다", async () => {
    const h = await harness();
    const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const first = await planned(h, request);
    const approval = await approve(first);
    expect((await runInstallTransaction(first, approval, request, h.env)).status).toBe("succeeded");
    expect((await runInstallTransaction(first, approval, request, h.env)).status).toBe("approval-required");
    const second = await planned(h, request);
    expect(second.plan.status).toBe("already-installed");
    expect((await runInstallTransaction(second, undefined, request, h.env)).status).toBe("no-op");
    const doc = JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8"));
    expect(Object.keys(doc.mcpServers)).toEqual(["memory"]);
  });

  it("AC-033-06 unidentified-present는 자동 no-op하지 않고 추가 승인 없이는 실행하지 않는다", async () => {
    const h = await harness();
    await writeFile(path.join(h.projectRoot, ".mcp.json"), '{ "mcpServers": { "my-memory": { "command": "node", "args": ["mem.js"] } } }\n');
    const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const p = await planned(h, request);
    expect(p.plan.status).toBe("installable");
    expect(p.plan.source.recommendation.installationStatus).toBe("unidentified-present");
    expect(p.plan.approvalRequirements).toContain("unidentified-present");
    reset(h);
    const refused = await runInstallTransaction(p, await approve(p, ["unidentified-present"]), request, h.env);
    expect(refused).toMatchObject({ status: "approval-required", code: "APPROVAL_INCOMPLETE" });
    expect(h.writes).toEqual([]);
    const done = await runInstallTransaction(p, await approve(p), request, h.env);
    expect(done.status).toBe("succeeded");
    expect(Object.keys(JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).mcpServers)).toEqual(["my-memory", "memory"]);
  });

  it("AC-033-07 token·URL credential·절대 경로를 넣어도 InstallResult 직렬화 결과에 0건이다", async () => {
    const token = "ghp_" + "Q".repeat(36);
    const h = await harness({ exitCode: 1, stderr: "pulling into C:\\Users\\victim\\AppData\nauth " + token + "\nproxy https://bob:hunter2@proxy.example\n/home/victim/.docker/config.json\nfailed" });
    const request = h.request("github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const p = await planned(h, request);
    const result = await runInstallTransaction(p, await approve(p), request, h.env);
    const out = serializeInstallResult(result);
    for (const leak of [token, "hunter2", "victim", h.projectRoot, h.homeDir, "C:\\", "/home/"]) expect(out).not.toContain(leak);
    expect(out).toContain("failed");
  });

  it("AC-033-08 대상 config 외 파일을 쓰지 않고 audit 파일도 만들지 않는다", async () => {
    const h = await harness();
    const request = h.request("github-mcp-server", [{ client: "codex", scope: "project" }]);
    const p = await planned(h, request);
    reset(h);
    expect((await runInstallTransaction(p, await approve(p), request, h.env)).status).toBe("succeeded");
    expect(h.writes.map((w) => w.replace(/\.openhub-[0-9a-f]{12}\.tmp$/u, ".TMP"))).toEqual([
      "mkdir:project/.codex",
      "write:project/.codex/.config.toml.TMP",
      "rename:project/.codex/config.toml",
    ]);
    expect(await listing(h.projectRoot)).toEqual([".codex", ".codex/config.toml", "package.json"]);
    expect(await listing(h.homeDir)).toEqual([]);
    expect(await listing(h.isoBase)).toEqual([]);
  });
});
