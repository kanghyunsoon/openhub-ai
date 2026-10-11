import { readFile, rm, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  STATE_LOCK_STALE_MS,
  commitLifecycleState,
  lifecycleStatus,
  planLifecycleRequest,
  readLifecycleState,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type InstallRequest,
  type LifecycleEnvironment,
  type LifecycleRequest,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { fakeNpmSpawner } from "../process/fake-npm";
import { homeIn, newScratch, stateOf, toolState } from "./helpers";

/**
 * v0.2.1 B 영역 재현.
 * P0-4: 같은 Version State를 거의 동시에 커밋하면(읽은 digest가 같음) 하나만 성공하고 나머지는 STATE_CONFLICT여야 한다.
 * P0-3: Update가 config를 바꾼 뒤 Health 도중 프로세스가 끝나면(강제 종료) 보상이 실행되지 않는다. 그 상태와 승인 Repair 복구 경로를 고정한다.
 */
const seed = await seedEntries();
const scratch = await newScratch("v021-state-concurrency");
afterAll(() => rm(scratch, { recursive: true, force: true }));

const named = (serverName: string) => toolState({ target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName, projectName: "demo", projectKey: "0123456789abcdef" } });

describe("v0.2.1 P0-4 Version State 동시 커밋", () => {
  it("같은 digest로 동시에 커밋하면 정확히 하나만 성공하고 나머지는 STATE_CONFLICT이며 성공한 내용이 파일에 남는다", async () => {
    for (const writers of [2, 8]) {
      const home = await homeIn(scratch);
      const first = await commitLifecycleState(stateOf(), null, { homeDir: home });
      if (!first.ok) throw new Error(first.code);
      const nexts = Array.from({ length: writers }, (_, i) => stateOf(named("s" + i)));
      const results = await Promise.all(nexts.map((n) => commitLifecycleState(n, first.digest, { homeDir: home })));
      const ok = results.flatMap((r, i) => (r.ok ? [i] : []));
      expect(ok.length, writers + " writers: " + JSON.stringify(results.map((r) => (r.ok ? "ok" : r.code)))).toBe(1);
      expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code))).toEqual(Array(writers - 1).fill("STATE_CONFLICT"));
      const read = await readLifecycleState({ homeDir: home });
      expect(read.ok && Object.values(read.state.entries).map((e) => e.target.serverName)).toEqual(["s" + ok[0]]);
    }
  });

  it("서로 다른 Tool을 같은 시점에 기록해도(설치 기록 경쟁) 한쪽 기록이 조용히 사라지지 않는다", async () => {
    const home = await homeIn(scratch);
    const first = await commitLifecycleState(stateOf(), null, { homeDir: home });
    if (!first.ok) throw new Error(first.code);
    const [a, b] = await Promise.all([commitLifecycleState(stateOf(named("a")), first.digest, { homeDir: home }), commitLifecycleState(stateOf(named("b")), first.digest, { homeDir: home })]);
    const read = await readLifecycleState({ homeDir: home });
    const names = read.ok ? Object.values(read.state.entries).map((e) => e.target.serverName) : [];
    // 둘 다 성공했다고 보고했는데 파일에는 하나만 있으면 lost update다.
    expect([a.ok, b.ok].filter(Boolean).length).toBe(names.length);
  });

  it("강제 종료로 남은 오래된 잠금은 회수하고, 새 잠금은 기다린 뒤 STATE_CONFLICT로 포기한다(쓰기 0)", async () => {
    const home = await homeIn(scratch);
    const first = await commitLifecycleState(stateOf(), null, { homeDir: home });
    if (!first.ok) throw new Error(first.code);
    const lock = path.join(home, ".openhub", "state", "lifecycle.json.lock");
    await writeFile(lock, "99999 2026-10-01T00:00:00.000Z\n");
    const old = new Date(Date.now() - STATE_LOCK_STALE_MS - 5_000);
    await utimes(lock, old, old);
    const stale = await commitLifecycleState(stateOf(named("after-stale")), first.digest, { homeDir: home });
    expect(stale.ok).toBe(true);

    const before = await readFile(path.join(home, ".openhub", "state", "lifecycle.json"), "utf8");
    await writeFile(lock, "1 now\n");
    const busy = await commitLifecycleState(stateOf(named("busy")), stale.ok ? stale.digest : null, { homeDir: home });
    expect(busy).toMatchObject({ ok: false, code: "STATE_CONFLICT" });
    expect(await readFile(path.join(home, ".openhub", "state", "lifecycle.json"), "utf8")).toBe(before);
    await rm(lock);
  }, 30_000);
});

describe("v0.2.1 P0-3 Update 중 강제 종료", () => {
  /**
   * 현재 동작 기록(v0.2.1 결정 대기, 고치지 않음). 첫 Update의 Health 도중 강제 종료되면 config는 새 항목, Version State는 이전 항목으로 남는다.
   * update·health는 CONFIG_DRIFT로 blocked, rollback은 previous가 없어 불가, repair는 tool config 도구 전용이라 불가하다.
   * 복구 경로(작업 journal + 승인 복구)가 생기면 이 테스트를 그 동작으로 바꾼다.
   */
  it("config 교체 뒤 Health 도중 끝나면 config-drift가 남고 앱 안의 복구 경로가 없다(알려진 결함, 결정 대기)", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const targets: InstallRequest["targets"] = [{ client: "cursor", scope: "project" }];
    const install = h.request("github-mcp-server", targets);
    const planned0 = await plannedOf(h, install);
    const installed = await runInstallTransaction(planned0, await approveAll(planned0), install, h.env);
    expect(installed.status).toBe("succeeded");
    expect(await recordInstallInState(planned0, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-11T00:00:00.000Z") })).toMatchObject({ ok: true });
    const cursorFile = path.join(h.projectRoot, ".cursor", "mcp.json");
    const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
    const before = [await readFile(cursorFile, "utf8"), await readFile(stateFile, "utf8")];

    let reached!: () => void;
    const inHealth = new Promise<void>((r) => (reached = r));
    const env = (runHealth: NonNullable<LifecycleEnvironment["runHealth"]>): LifecycleEnvironment => ({
      loadEntries: async () => seed,
      probe: () => h.env.probe(),
      tempBase: scratch,
      now: () => new Date("2026-10-12T00:00:00.000Z"),
      fetch: async (url: string) => {
        const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
        if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
        if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "f".repeat(64) } });
        return new Response("missing", { status: 404 });
      },
      configFs: h.env.configFs!,
      spawner: fakeNpmSpawner({ cacheRoot: path.join(scratch, "npm-" + Math.random().toString(36).slice(2, 8)) }).spawner,
      runHealth,
    });
    const request = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId: "github-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets });
    const approveRun = async (operation: LifecycleRequest["operation"], e: LifecycleEnvironment) => {
      const built = await planLifecycleRequest(request(operation), e);
      if (!built.ok) throw new Error(built.code + " " + built.message);
      const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (outcome.status !== "approved") throw new Error(outcome.status);
      return runLifecycleTransaction(built.planned, outcome.approval, request(operation), e);
    };

    // Health가 끝나지 않는다 = 이 시점에 프로세스가 강제 종료된 것과 같은 디스크 상태.
    void approveRun("update", env(() => (reached(), new Promise(() => undefined))));
    await inHealth;
    const killed = [await readFile(cursorFile, "utf8"), await readFile(stateFile, "utf8")];
    expect(killed[0]).not.toBe(before[0]); // config는 이미 새 항목
    expect(killed[1]).toBe(before[1]); // Version State는 이전 그대로
    const status = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false });
    expect(status.ok && status.items.map((i) => i.state)).toEqual(["config-drift"]);

    const healthy = async () => ({ ok: true as const, result: { status: "healthy" as const, reason: null, toolCount: 3, environmentUnverified: false, terminated: true, excerpt: null } });
    const outcomes: Record<string, unknown> = {};
    for (const op of ["update", "rollback", "health", "repair"] as const) {
      const b = await planLifecycleRequest(request(op), env(healthy));
      outcomes[op] = b.ok ? { status: b.planned.plan.status, warnings: b.planned.plan.warnings.map((w) => w.code) } : { code: b.code };
    }
    expect(outcomes).toEqual({
      update: { status: "blocked", warnings: ["CONFIG_DRIFT"] },
      rollback: { code: "NO_ROLLBACK_TARGET" },
      health: { status: "blocked", warnings: ["CONFIG_DRIFT"] },
      repair: { code: "REPAIR_UNSUPPORTED" },
    });
  });
});
