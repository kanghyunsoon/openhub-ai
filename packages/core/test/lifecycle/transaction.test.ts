import { EventEmitter } from "node:events";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import * as core from "../../src/index";
import {
  configEntryDigest,
  lifecycleResultSchema,
  planLifecycleRequest,
  readLifecycleState,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  serializeLifecycleResult,
  type ConfigFs,
  type ExecSpawner,
  type HealthCheckStatus,
  type HealthFailureReason,
  type InstallRequest,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type VerifiedLifecyclePlan,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";
import { fakeNpmSpawner, isNpxPrepareCall } from "../process/fake-npm";

/** TASK-043 Update transaction. 임시 project·home, 가짜 registry·준비 spawner·Health 실행기, 실패 주입 fs. */
const seed = await seedEntries();
const scratch = await newScratch("lifecycle-tx-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const INSTALLED_AT = () => new Date("2026-10-07T01:02:03.000Z");
const UPDATED_AT = new Date("2026-10-08T04:05:06.000Z");
const DIGEST = "sha256:" + "f".repeat(64);

function registry() {
  return vi.fn(async (url: string) => {
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: "1.2.3" });
    if (url === "https://pypi.org/pypi/postgres-mcp/json") return json({ info: { name: "postgres-mcp", version: "0.3.0" } });
    if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
    if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": DIGEST } });
    return new Response("missing", { status: 404 });
  });
}
function fakeExec(code = 0, prepare: "ok" | "fail" | "hang" = "ok") {
  // npx Prepare(npm config get cache, npx --package=…)는 가짜 npm cache에 흉내 낸다. 그 밖(docker pull)은 code로 닫는다.
  return fakeNpmSpawner({ cacheRoot: path.join(scratch, "npm-cache-" + Math.random().toString(36).slice(2, 8)), exitCode: code, prepare });
}
function fakeHealth(log: string[], status: HealthCheckStatus = "healthy", reason: HealthFailureReason | null = null) {
  const calls: VerifiedLifecyclePlan[] = [];
  const run: NonNullable<LifecycleEnvironment["runHealth"]> = async (verified) => {
    calls.push(verified);
    log.push("health:run");
    const environmentUnverified = verified.plan.requiredEnv.some((e) => e.required);
    return { ok: true, result: { status, reason, toolCount: status === "healthy" ? 3 : null, environmentUnverified, terminated: reason !== "termination-failed", excerpt: null } };
  };
  return { calls, run };
}
/** rename 대상 경로(끝부분)로 실패를 주입한다. failOn이 n번째 rename부터 실패하도록 할 수 있다. */
function failingFs(base: ConfigFs, rules: { suffix: string; after?: number }[]): ConfigFs {
  const counts = new Map<string, number>();
  return {
    ...base,
    rename: async (from, to) => {
      const norm = to.replace(/\\/gu, "/");
      for (const rule of rules) {
        if (!norm.endsWith(rule.suffix)) continue;
        const n = (counts.get(rule.suffix) ?? 0) + 1;
        counts.set(rule.suffix, n);
        if (n > (rule.after ?? 0)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      }
      return base.rename(from, to);
    },
  };
}

interface Case {
  h: Harness;
  request: LifecycleRequest;
  env: LifecycleEnvironment;
  log: string[];
  exec: ReturnType<typeof fakeExec>;
  health: ReturnType<typeof fakeHealth>;
  planned: Awaited<ReturnType<typeof planOf>>;
  approval: core.LifecycleApproval;
  file(rel: string): Promise<Buffer>;
  state(): Promise<Buffer>;
}
async function planOf(request: LifecycleRequest, env: LifecycleEnvironment) {
  const r = await planLifecycleRequest(request, env);
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
}
async function setup(
  toolId: string,
  targets: InstallRequest["targets"] = [{ client: "claude-code", scope: "project" }],
  opts: { exitCode?: number; prepare?: "ok" | "fail" | "hang"; health?: [HealthCheckStatus, HealthFailureReason | null]; skipHealth?: boolean; fs?: (base: ConfigFs) => ConfigFs } = {},
): Promise<Case> {
  const h = await createHarness(scratch, { entries: seed });
  const install = h.request(toolId, targets);
  const planned0 = await plannedOf(h, install);
  const installed = await runInstallTransaction(planned0, await approveAll(planned0), install, h.env);
  expect(installed.status).toBe("succeeded");
  expect(await recordInstallInState(planned0, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: INSTALLED_AT })).toMatchObject({ ok: true });
  const log = h.writes;
  const exec = fakeExec(opts.exitCode ?? 0, opts.prepare ?? "ok");
  const health = fakeHealth(log, ...(opts.health ?? ["healthy", null]));
  const fs = opts.fs === undefined ? h.env.configFs! : opts.fs(h.env.configFs!);
  const env: LifecycleEnvironment = {
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: scratch,
    now: () => UPDATED_AT,
    fetch: registry(),
    configFs: fs,
    spawner: exec.spawner,
    runHealth: health.run,
    trace: (p) => log.push("phase:" + p),
  };
  const request: LifecycleRequest = { operation: "update", toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets, ...(opts.skipHealth === true ? { skipHealth: true } : {}) };
  const planned = await planOf(request, env);
  const outcome = await requestLifecycleApproval(planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  h.reset();
  return {
    h,
    request,
    env,
    log: h.writes,
    exec,
    health,
    planned,
    approval: outcome.approval,
    file: (rel) => readFile(path.join(h.projectRoot, rel)),
    state: () => readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json")),
  };
}
const run = (c: Case) => runLifecycleTransaction(c.planned, c.approval, c.request, c.env);
async function stateEntries(c: Case) {
  const r = await readLifecycleState({ homeDir: c.h.homeDir });
  if (!r.ok) throw new Error(r.code);
  return Object.values(r.state.entries);
}

describe("REQ-040 REQ-043 REQ-050 Update transaction", () => {
  it("AC-043-01 실행 순서가 승인 확인 → 재생성·digest 비교 → probe → 준비 → config 교체 → Health → state commit이다", async () => {
    const c = await setup("github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const result = await run(c);
    expect(result.status).toBe("updated");
    const phases = c.log.filter((l) => l.startsWith("phase:") || l === "health:run");
    expect(phases).toEqual(["phase:approval-check", "phase:regenerate", "phase:digest-compare", "phase:probe", "phase:prepare", "phase:config-replace", "phase:health", "health:run", "phase:state-commit"]);
    expect(c.exec.calls).toEqual([["docker", "pull", "ghcr.io/github/github-mcp-server@" + DIGEST]]);
  });

  it("AC-043-02 성공하면 revision+1·previous snapshot·healthy이고 승인된 skip은 commit하되 skipped(healthy 아님)다", async () => {
    const c = await setup("memory-mcp");
    const [before] = await stateEntries(c);
    const result = await run(c);
    expect(result).toMatchObject({ status: "updated", stateCommitted: true, artifact: { from: "@modelcontextprotocol/server-memory", to: "@modelcontextprotocol/server-memory@1.2.3" } });
    const [after] = await stateEntries(c);
    expect(after!.revision).toBe(2);
    const { previous: _p, lastHealth: _h, ...beforeCore } = before!;
    expect(after!.previous).toEqual(beforeCore);
    expect(after!.lastHealth).toEqual({ status: "healthy", environmentUnverified: false, checkedAt: UPDATED_AT.toISOString() });
    expect(after!.artifact.resolved?.spec).toBe("@modelcontextprotocol/server-memory@1.2.3");
    const doc = JSON.parse((await c.file(".mcp.json")).toString("utf8"));
    expect(after!.config.entryDigest).toBe(configEntryDigest(doc.mcpServers.memory));
    expect(result.targets[0]).toMatchObject({ revisionBefore: 1, revisionAfter: 2, configApplied: true, configRestored: false });

    const s = await setup("postgres-mcp", [{ client: "claude-code", scope: "project" }], { skipHealth: true });
    const skipped = await run(s);
    expect(skipped).toMatchObject({ status: "updated", health: { status: "skipped", environmentUnverified: true, checkedAt: null } });
    expect(skipped.warnings).toContainEqual({ code: "health-not-verified", message: "Health: Not verified / Reason: Required environment is unchecked" });
    expect(s.health.calls).toEqual([]);
    expect((await stateEntries(s))[0]!.lastHealth).toEqual({ status: "skipped", environmentUnverified: true, checkedAt: null });
  });

  it("AC-043-03 준비 단계(docker pull)가 실패하면 config·state가 byte 그대로이고 preparation-failed다", async () => {
    const c = await setup("github-mcp-server", [{ client: "cursor", scope: "project" }], { exitCode: 1 });
    const config = await c.file(".cursor/mcp.json");
    const state = await c.state();
    const result = await run(c);
    expect(result).toMatchObject({ status: "preparation-failed", stateCommitted: false, compensated: false });
    expect((await c.file(".cursor/mcp.json")).equals(config)).toBe(true);
    expect((await c.state()).equals(state)).toBe(true);
    expect(c.log.filter((l) => l.startsWith("write:") || l.startsWith("rename:"))).toEqual([]);
    expect(c.health.calls).toEqual([]);
  });

  it("AC-043-04 두 번째 config 교체가 실패하면 첫 번째 파일을 원본 byte로 되돌리고 config-failed(compensated)다", async () => {
    const c = await setup("memory-mcp", [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "project" }], { fs: (b) => failingFs(b, [{ suffix: ".cursor/mcp.json" }]) });
    const claude = await c.file(".mcp.json");
    const cursor = await c.file(".cursor/mcp.json");
    const state = await c.state();
    const result = await run(c);
    expect(result).toMatchObject({ status: "config-failed", code: "CONFIG_WRITE_FAILED", compensated: true, stateCommitted: false });
    expect(result.steps.map((s) => [s.id, s.status])).toEqual([
      ["npx-prepare", "done"],
      ["config-claude-code-project", "compensated"],
      ["config-cursor-project", "failed"],
      ["health", "skipped"],
      ["state-commit", "skipped"],
    ]);
    expect((await c.file(".mcp.json")).equals(claude)).toBe(true);
    expect((await c.file(".cursor/mcp.json")).equals(cursor)).toBe(true);
    expect((await c.state()).equals(state)).toBe(true);
  });

  it("AC-043-05 Health 실패 6종은 모두 config 원본 복구·state 그대로·health-failed이고 우회 API와 image 삭제가 없다", async () => {
    const failures: [HealthCheckStatus, HealthFailureReason][] = [
      ["launch-failed", "process-exited"],
      ["handshake-failed", "invalid-message"],
      ["timeout", "startup-timeout"],
      ["unhealthy", "tools-list-error"],
      ["handshake-failed", "output-limit"],
      ["unhealthy", "termination-failed"],
    ];
    for (const [status, reason] of failures) {
      const c = await setup("github-mcp-server", [{ client: "cursor", scope: "project" }], { health: [status, reason] });
      const config = await c.file(".cursor/mcp.json");
      const state = await c.state();
      const result = await run(c);
      expect(result, reason).toMatchObject({ status: "health-failed", code: reason, compensated: true, stateCommitted: false, health: { status } });
      expect((await c.file(".cursor/mcp.json")).equals(config), reason).toBe(true);
      expect((await c.state()).equals(state), reason).toBe(true);
      expect(c.exec.calls.flat().some((a) => /^(rmi|prune)$/u.test(a)) || c.exec.calls.some((a) => a.includes("rm"))).toBe(false);
      expect(await run(c), reason).toMatchObject({ status: "approval-required", code: "APPROVAL_CONSUMED" });
    }
    const exported = Object.keys(core);
    expect(exported.filter((k) => /force|override|anyway|bypass|skipAfter|ignoreHealth/iu.test(k))).toEqual([]);
    expect(Object.keys(lifecycleResultSchema.shape)).not.toContain("override");
  }, 30_000);

  it("AC-043-06 state commit 실패면 config를 복원하고 state-commit-failed, 복원까지 실패하면 rollback-failed와 논리 경로 안내다", async () => {
    const c = await setup("memory-mcp", undefined, { fs: (b) => failingFs(b, [{ suffix: "/.openhub/state/lifecycle.json" }]) });
    const config = await c.file(".mcp.json");
    const state = await c.state();
    expect(await run(c)).toMatchObject({ status: "state-commit-failed", code: "STATE_WRITE_FAILED", compensated: true });
    expect((await c.file(".mcp.json")).equals(config)).toBe(true);
    expect((await c.state()).equals(state)).toBe(true);

    const d = await setup("memory-mcp", undefined, { fs: (b) => failingFs(b, [{ suffix: "/.openhub/state/lifecycle.json" }, { suffix: "/.mcp.json", after: 1 }]) });
    const failed = await run(d);
    expect(failed).toMatchObject({ status: "rollback-failed", code: "CONFIG_RESTORE_FAILED", stateCommitted: false });
    expect(failed.nextActions.join("\n")).toContain(".mcp.json");
    expect(failed.nextActions.join("\n")).toContain("~/.openhub/state/lifecycle.json");
    expect(failed.nextActions.join("\n")).not.toContain(d.h.projectRoot);
  });

  it("AC-043-07 Health 성공(또는 승인된 skip) 전에는 state write가 0회다", async () => {
    const c = await setup("memory-mcp");
    await run(c);
    const firstStateWrite = c.log.findIndex((l) => /\.openhub\/state\/.*lifecycle\.json/u.test(l));
    expect(firstStateWrite).toBeGreaterThan(c.log.indexOf("health:run"));
    expect(c.log.indexOf("health:run")).toBeGreaterThan(c.log.findIndex((l) => l === "rename:project/.mcp.json"));
    const failed = await setup("memory-mcp", undefined, { health: ["timeout", "total-timeout"] });
    await run(failed);
    expect(failed.log.filter((l) => /lifecycle\.json/u.test(l))).toEqual([]);
  });

  it("AC-043-08 npx·uvx update는 config args의 패키지 token 교체와 state 갱신뿐이고 패키지 매니저 명령 spawn이 0건이다", async () => {
    for (const [toolId, before, after] of [
      ["memory-mcp", ["-y", "@modelcontextprotocol/server-memory"], ["-y", "@modelcontextprotocol/server-memory@1.2.3"]],
      ["postgres-mcp", ["postgres-mcp", "--access-mode=restricted"], ["postgres-mcp==0.3.0", "--access-mode=restricted"]],
    ] as const) {
      const c = await setup(toolId);
      const original = JSON.parse((await c.file(".mcp.json")).toString("utf8"));
      const server = toolId === "memory-mcp" ? "memory" : "postgres";
      expect(original.mcpServers[server].args).toEqual(before);
      expect((await run(c)).status).toBe("updated");
      const updated = JSON.parse((await c.file(".mcp.json")).toString("utf8"));
      expect(updated.mcpServers[server]).toEqual({ ...original.mcpServers[server], args: after });
      // v0.2.0 npx Prepare: npx는 정확한 target 버전을 npx cache에 받는 명령 두 개(cache 위치 확인, 내려받기)만 실행한다.
      // MCP 서버(패키지 bin)는 실행하지 않고(-- node --version), uvx는 여전히 0건이다.
      if (toolId === "memory-mcp") {
        expect(c.exec.calls).toEqual([
          ["npm", "config", "get", "cache"],
          ["npx", "--yes", "--package=@modelcontextprotocol/server-memory@1.2.3", "--", "node", "--version"],
        ]);
      } else expect(c.exec.calls).toEqual([]);
      expect(c.exec.calls.every(isNpxPrepareCall)).toBe(true);
      const healthArgs = c.health.calls[0]!.plan.steps.find((s) => s.kind === "health");
      expect(JSON.stringify(healthArgs)).not.toMatch(/"install"|"pip"|"add"/u);
    }
  });

  it("AC-043-09 LifecycleResult v1이 schema를 통과하고 token·URL credential·절대 경로·env 값이 0건이다", async () => {
    vi.stubEnv("DATABASE_URI", "postgresql://admin:Lifecycle-Secret-7@db.internal:5432/app");
    const c = await setup("postgres-mcp", [{ client: "claude-code", scope: "project" }, { client: "codex", scope: "project" }]);
    const result = await run(c);
    expect(result.status).toBe("updated");
    const text = serializeLifecycleResult(result);
    expect(lifecycleResultSchema.safeParse(JSON.parse(text)).success).toBe(true);
    for (const forbidden of ["Lifecycle-Secret-7", c.h.projectRoot, c.h.homeDir, "anon"]) expect(text).not.toContain(forbidden);
    expect(result.requiredEnv).toEqual([{ name: "DATABASE_URI", status: "unchecked" }]);
    expect(lifecycleResultSchema.safeParse({ ...result, nextActions: ["see " + c.h.projectRoot] }).success).toBe(false);
    expect(lifecycleResultSchema.safeParse({ ...result, nextActions: ["https://user:pw@example.com"] }).success).toBe(false);
  });

  it("v0.2.0 npx Prepare: npx update는 설정 교체 전에 target 버전을 준비하고, 준비가 실패하면 설정·Version State를 바꾸지 않고 Health도 실행하지 않는다", async () => {
    const ok = await setup("memory-mcp");
    expect(ok.planned.plan.steps.map((s) => s.id)).toEqual(["npx-prepare", "config-claude-code-project", "health", "state-commit"]);
    const done = await run(ok);
    expect(done.status).toBe("updated");
    expect(done.steps[0]).toMatchObject({ id: "npx-prepare", status: "done" });

    // timeout 경로(process tree 종료·불완전 항목 정리)는 prepareNpxPackage 단위 테스트와 E2E가 다룬다.
    for (const prepare of ["fail"] as const) {
      const c = await setup("memory-mcp", undefined, { prepare });
      const config = await c.file(".mcp.json");
      const state = await c.state();
      const result = await run(c);
      expect(result, prepare).toMatchObject({ status: "preparation-failed", stateCommitted: false, retryable: true });
      expect(result.steps.map((s) => [s.id, s.status])).toEqual([["npx-prepare", "failed"], ["config-claude-code-project", "skipped"], ["health", "skipped"], ["state-commit", "skipped"]]);
      expect(c.health.calls).toHaveLength(0);
      expect((await c.file(".mcp.json")).equals(config)).toBe(true);
      expect((await c.state()).equals(state)).toBe(true);
    }
  });

  it("AC-043-10 Approval은 1회만 쓰이고 승인 없이는 spawn·write 0회이며 up-to-date는 효과가 0이다", async () => {
    const c = await setup("github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const none = await runLifecycleTransaction(c.planned, undefined, c.request, c.env);
    expect(none).toMatchObject({ status: "approval-required", code: "APPROVAL_REQUIRED" });
    expect(c.exec.calls).toEqual([]);
    expect(c.log.filter((l) => !l.startsWith("phase:"))).toEqual([]);
    expect((await run(c)).status).toBe("updated");
    const writes = c.log.length;
    expect(await run(c)).toMatchObject({ status: "approval-required", code: "APPROVAL_CONSUMED" });
    expect(c.exec.calls).toHaveLength(1);
    expect(c.log.slice(writes).filter((l) => !l.startsWith("phase:"))).toEqual([]);

    // 방금 update가 끝나 current = target이다. 같은 identity면 up-to-date이고 효과가 0이다.
    const again = await planOf(c.request, c.env);
    expect(again.plan.status).toBe("up-to-date");
    const before = c.log.length;
    expect(await runLifecycleTransaction(again, undefined, c.request, c.env)).toMatchObject({ status: "up-to-date", stateCommitted: false });
    expect(c.log.slice(before).filter((l) => !l.startsWith("phase:"))).toEqual([]);
    expect(c.exec.calls).toHaveLength(1);
  });
});

