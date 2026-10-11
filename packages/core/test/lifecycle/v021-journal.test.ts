import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  containsAbsolutePath,
  executeRecovery,
  lifecycleStatus,
  planLifecycleRequest,
  planRecovery,
  readJournals,
  readLifecycleState,
  recordInstallInState,
  removeJournal,
  requestLifecycleApproval,
  requestRecoveryApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  setJournalPhase,
  withOperationLock,
  type InstallRequest,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RecoveryMode,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { fakeNpmSpawner } from "../process/fake-npm";
import { abandonOperationLock, newScratch } from "./helpers";

/**
 * v0.2.1 P0-3 Journal + 승인 기반 Recovery(프로세스 생성 없음). "Health가 끝나지 않음"은 강제 종료 시점과 같은 디스크 상태를 만든다.
 * 실제 자식 프로세스 강제 종료는 v021-journal-kill.e2e.test.ts(OPENHUB_E2E)에서 확인한다.
 */
const seed = await seedEntries();
const scratch = await newScratch("v021-journal");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const healthy: NonNullable<LifecycleEnvironment["runHealth"]> = async () => ({ ok: true, result: { status: "healthy", reason: null, toolCount: 3, environmentUnverified: false, terminated: true, excerpt: null } });

type Scope = "project" | "user";
async function installed(scope: Scope = "project") {
  const h = await createHarness(scratch, { entries: seed });
  if (scope === "user") {
    await mkdir(path.join(h.homeDir, ".cursor"), { recursive: true });
    await writeFile(path.join(h.homeDir, ".cursor", "mcp.json"), '{\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n');
  }
  const targets: InstallRequest["targets"] = [{ client: "cursor", scope }];
  const install = h.request("github-mcp-server", targets, scope === "user");
  const p = await plannedOf(h, install);
  const r = await runInstallTransaction(p, await approveAll(p), install, h.env);
  expect(r.status).toBe("succeeded");
  expect(await recordInstallInState(p, r, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-11T00:00:00.000Z") })).toMatchObject({ ok: true });
  const cursorFile = scope === "project" ? path.join(h.projectRoot, ".cursor", "mcp.json") : path.join(h.homeDir, ".cursor", "mcp.json");
  const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
  const env = (runHealth: NonNullable<LifecycleEnvironment["runHealth"]>, over: Partial<LifecycleEnvironment> = {}): LifecycleEnvironment => ({
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
    ...over,
  });
  const request = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId: "github-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: scope === "user", targets });
  const update = async (e: LifecycleEnvironment) => {
    const built = await planLifecycleRequest(request("update"), e);
    if (!built.ok) throw new Error(built.code + " " + built.message);
    const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    return runLifecycleTransaction(built.planned, outcome.approval, request("update"), e);
  };
  /** Update를 Health에서 멈춘다(강제 종료와 같은 디스크 상태). */
  const interrupt = async () => {
    let reached!: () => void;
    const inHealth = new Promise<void>((r) => (reached = r));
    void update(env(() => (reached(), new Promise(() => undefined))));
    await inHealth;
    await abandonOperationLock(h.homeDir);
  };
  const files = async () => [await readFile(cursorFile, "utf8"), await readFile(stateFile, "utf8")] as const;
  const status = async () => {
    const s = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: scope === "user" });
    return s.ok ? s.items.map((i) => i.state) : [s.code];
  };
  const recoveryOptions = (mode: RecoveryMode = "undo") => ({ toolId: "github-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, mode });
  const approveRecovery = async (mode: RecoveryMode = "undo") => {
    const built = await planRecovery(recoveryOptions(mode));
    if (!built.ok) throw new Error(built.code);
    const o = await requestRecoveryApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (o.status !== "approved") throw new Error(o.status);
    return { built, approval: o.approval, run: (approval = o.approval) => executeRecovery(approval, { ...recoveryOptions(mode), regenerate: () => planRecovery(recoveryOptions(mode)) }) };
  };
  const journals = async () => {
    const r = await readJournals(h.homeDir);
    if (!r.ok) throw new Error(r.code);
    return r.journals;
  };
  return { h, env, update, interrupt, files, status, recoveryOptions, approveRecovery, journals, cursorFile, stateFile };
}

describe("v0.2.1 P0-3 Journal 기록", () => {
  it("설정을 바꾸기 전에 Journal을 남기고(Health 중에 단계 health, 변경 전/후 digest, 경로·secret 없음), 정상 완료하면 지운다", async () => {
    const c = await installed();
    let during: Awaited<ReturnType<typeof c.journals>> = [];
    const r = await c.update(c.env(async (...a) => ((during = await c.journals()), healthy(...a))));
    expect(r.status).toBe("updated");
    expect(during).toHaveLength(1);
    const j = during[0]!;
    expect(j).toMatchObject({ operation: "update", toolId: "github-mcp-server", phase: "health", toolConfig: false });
    expect(j.targets[0]).toMatchObject({ client: "cursor", scope: "project", file: ".cursor/mcp.json" });
    expect(j.targets[0]!.beforeEntryDigest).not.toBe(j.targets[0]!.afterEntryDigest);
    expect(j.targets[0]!.before).not.toBeNull();
    expect(JSON.stringify(j).split('"').some((s) => containsAbsolutePath(s))).toBe(false);
    expect(await c.journals()).toEqual([]);
    expect(await c.status()).toEqual(["state-consistent"]);
  });

  it("Health 실패로 보상에 성공하면 Journal을 지우고, 보상까지 실패하면 compensation-failed로 남긴다", async () => {
    const unhealthy = async () => ({ ok: true as const, result: { status: "unhealthy" as const, reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } });
    const ok = await installed();
    expect(await ok.update(ok.env(unhealthy))).toMatchObject({ status: "health-failed", compensated: true });
    expect(await ok.journals()).toEqual([]);
    const bad = await installed();
    const r = await bad.update(bad.env(async () => (await writeFile(bad.cursorFile, '{ "mcpServers": {} }\n'), unhealthy())));
    expect(r).toMatchObject({ status: "rollback-failed" });
    expect((await bad.journals()).map((j) => j.phase)).toEqual(["compensation-failed"]);
  });

  it("Journal 경로가 디렉터리가 아니면 계획 단계에서 막고(JOURNAL_UNREADABLE) Client 설정을 바꾸지 않는다", async () => {
    const c = await installed();
    await writeFile(path.join(c.h.homeDir, ".openhub", "state", "journal"), "not a directory");
    const before = await c.files();
    const built = await planLifecycleRequest({ operation: "update", toolId: "github-mcp-server", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, platform: "linux", includeUser: false, targets: [{ client: "cursor", scope: "project" }] }, c.env(healthy));
    expect(built.ok && built.planned.plan.status).toBe("blocked");
    expect(built.ok && built.planned.plan.warnings.map((w) => w.code)).toContain("JOURNAL_UNREADABLE");
    expect(await c.files()).toEqual(before);
  });
});

describe("v0.2.1 P0-3 중단된 작업 감지와 승인 기반 Recovery", () => {
  it("Health 중 끝난 Update는 interrupted-update로 보이고 update·health는 INTERRUPTED_OPERATION으로 막힌다", async () => {
    const c = await installed();
    await c.interrupt();
    expect(await c.status()).toEqual(["interrupted-update"]);
    for (const op of ["update", "health"] as const) {
      const built = await planLifecycleRequest({ operation: op, toolId: "github-mcp-server", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, platform: "linux", includeUser: false, targets: [{ client: "cursor", scope: "project" }] }, c.env(healthy));
      expect(built.ok && built.planned.plan.status, op).toBe("blocked");
      expect(built.ok && built.planned.plan.warnings.map((w) => w.code), op).toContain("INTERRUPTED_OPERATION");
    }
  });

  it("승인 전(계획·거절)에는 쓰기 0, 승인 뒤 undo는 변경 전 항목으로 되돌리고 Version State는 그대로·일치, Journal 삭제. 다시 요청하면 복구할 것이 없다", async () => {
    const c = await installed();
    const original = await c.files();
    await c.interrupt();
    const interrupted = await c.files();
    expect(interrupted[0]).not.toBe(original[0]);
    const plan = await planRecovery(c.recoveryOptions());
    expect(plan.ok && plan.planned.plan).toMatchObject({ status: "ready", mode: "undo", approvalRequirements: ["base"], effects: { configWrites: 1, stateWrite: 0 } });
    expect(plan.ok && plan.planned.plan.targets.map((t) => t.current)).toEqual(["after"]);
    if (!plan.ok) throw new Error();
    expect(await requestRecoveryApproval(plan.planned, { channel: "cli-tty", confirm: async () => "rejected" })).toMatchObject({ status: "rejected" });
    expect(await c.files()).toEqual(interrupted);

    const a = await c.approveRecovery();
    const r = await a.run();
    expect(r).toMatchObject({ status: "recovered", targets: [{ restored: true }] });
    const after = await c.files();
    expect(JSON.parse(after[0])).toEqual(JSON.parse(original[0]));
    expect(after[1]).toBe(original[1]);
    expect(await c.status()).toEqual(["state-consistent"]);
    expect(await c.journals()).toEqual([]);
    expect(await planRecovery(c.recoveryOptions())).toMatchObject({ ok: false, code: "NO_INTERRUPTED_OPERATION" });
    // 같은 승인 재사용 → 실행하지 않는다.
    expect((await a.run()).status).not.toBe("recovered");
    expect(await c.files()).toEqual(after);
  });

  it("중단 뒤 사용자가 항목을 바꿨으면 blocked(EXTERNAL_CHANGE)이고, 미리 받은 승인도 실행 직전 재검증에서 막혀 덮어쓰지 않는다", async () => {
    const c = await installed();
    await c.interrupt();
    const early = await c.approveRecovery();
    const external = '{ "mcpServers": { "github": { "command": "docker", "args": ["run", "-i", "--rm", "my-own-image"] } } }\n';
    await writeFile(c.cursorFile, external);
    const plan = await planRecovery(c.recoveryOptions());
    expect(plan.ok && plan.planned.plan.status).toBe("blocked");
    expect(plan.ok && plan.planned.plan.blockers.map((b) => b.code)).toContain("EXTERNAL_CHANGE");
    const r = await early.run();
    expect(r.status).toBe("stale");
    expect(await readFile(c.cursorFile, "utf8")).toBe(external);
    expect(await c.journals()).toHaveLength(1);
  });

  it("같은 Journal에 대한 복구 승인 5개가 동시에 실행돼도 한 번만 되돌리고 나머지는 recovered가 아니다", async () => {
    const c = await installed();
    const original = await c.files();
    await c.interrupt();
    const approvals = await Promise.all(Array.from({ length: 5 }, () => c.approveRecovery()));
    const results = await Promise.all(approvals.map((a) => a.run()));
    expect(results.filter((r) => r.status === "recovered")).toHaveLength(1);
    expect(results.filter((r) => r.status !== "recovered").every((r) => r.status === "stale" || r.status === "failed")).toBe(true);
    expect(JSON.parse((await c.files())[0])).toEqual(JSON.parse(original[0]));
    expect(await c.journals()).toEqual([]);
  });

  it("사용자 범위 대상: user-scope-config 승인이 필요하고, 다른 사용자 설정 항목은 그대로 되돌린다", async () => {
    const c = await installed("user");
    const original = await c.files();
    await c.interrupt();
    expect(await c.status()).toEqual(["interrupted-update"]);
    const a = await c.approveRecovery();
    expect(a.built.ok && a.built.planned.plan.approvalRequirements).toEqual(["base", "user-scope-config"]);
    expect(await a.run()).toMatchObject({ status: "recovered" });
    const after = JSON.parse((await c.files())[0]) as { mcpServers: Record<string, unknown> };
    expect(after).toEqual(JSON.parse(original[0]));
    expect(after.mcpServers["notes"]).toEqual({ command: "uvx", args: ["notes-mcp==1.0.0"] });
  });

  it("이미 변경 전으로 돌아간 기록은 discard로만 지울 수 있다(undo는 할 일이 없다)", async () => {
    const c = await installed();
    const original = await c.files();
    await c.interrupt();
    await writeFile(c.cursorFile, original[0]);
    const undo = await planRecovery(c.recoveryOptions("undo"));
    expect(undo.ok && undo.planned.plan.blockers.map((b) => b.code)).toEqual(["NOTHING_TO_UNDO"]);
    const d = await c.approveRecovery("discard");
    expect(d.built.ok && d.built.planned.plan.effects.configWrites).toBe(0);
    expect(await d.run()).toMatchObject({ status: "discarded" });
    expect(await c.journals()).toEqual([]);
    expect(await c.files()).toEqual(original);
  });

  it("v0.2.0 Version State는 그대로 읽히고, Journal은 lifecycle.json에 아무 필드도 추가하지 않는다", async () => {
    const c = await installed();
    const before = (await c.files())[1];
    await c.interrupt();
    expect((await c.files())[1]).toBe(before);
    const read = await readLifecycleState({ homeDir: c.h.homeDir });
    expect(read.ok).toBe(true);
    expect(await readdir(path.join(c.h.homeDir, ".openhub", "state"))).toEqual(expect.arrayContaining(["journal", "lifecycle.json"]));
  });
});

const journalDirOf = (homeDir: string) => path.join(homeDir, ".openhub", "state", "journal");
/** 지울 수 없는 장애물: 같은 작업 ID의 선점 이름을 가진 디렉터리(rm이 실패한다). */
const OBSTACLE = (id: string) => id + ".claim-1-deadbeef.json";

describe("v0.2.1 P0-3 보완: 잠금·손상 Journal·정리 확인·단계 갱신 실패", () => {
  it("[A] 다른 OpenHub 작업이 진행 중이면 승인된 복구도 OPERATION_IN_PROGRESS이고 설정·Journal을 바꾸지 않는다. 끝난 뒤에는 복구된다", async () => {
    const c = await installed();
    await c.interrupt();
    const killed = await c.files();
    const { run } = await c.approveRecovery();
    // 작업 잠금이 회수된 뒤(강제 종료 상태) 다른 작업이 진행 중인 동안 복구를 실행한다.
    const busy = await withOperationLock({ homeDir: c.h.homeDir, purpose: "lifecycle-update" }, () => run());
    expect(busy).toMatchObject({ ok: true, value: { status: "failed", error: { code: "OPERATION_IN_PROGRESS" } } });
    expect(await c.files()).toEqual(killed);
    expect(await c.journals()).toHaveLength(1);
    const again = await c.approveRecovery();
    expect(await again.run()).toMatchObject({ status: "recovered" });
    expect(await c.status()).toEqual(["state-consistent"]);
  });

  it("[B] 읽을 수 없는 Journal이 있으면 복구·update·health·repair 계획을 막고(JOURNAL_DAMAGED) 그 파일을 지우지 않는다", async () => {
    const c = await installed();
    await c.interrupt();
    const damaged = path.join(journalDirOf(c.h.homeDir), "0".repeat(32) + ".json");
    await writeFile(damaged, "{ broken");
    expect(await planRecovery(c.recoveryOptions())).toMatchObject({ ok: false, code: "JOURNAL_DAMAGED" });
    expect(await planRecovery(c.recoveryOptions("discard"))).toMatchObject({ ok: false, code: "JOURNAL_DAMAGED" });
    for (const operation of ["update", "health", "repair"] as const) {
      const req: LifecycleRequest = { operation, toolId: "github-mcp-server", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, platform: "linux", includeUser: false, targets: [{ client: "cursor", scope: "project" }] };
      const built = await planLifecycleRequest(req, c.env(healthy));
      if (built.ok) {
        expect(built.planned.plan.status).toBe("blocked");
        expect(built.planned.plan.warnings.map((w) => w.code)).toContain("JOURNAL_DAMAGED");
      } else expect(operation).toBe("repair"); // 이 도구는 tool config가 없어 repair 계획 자체가 없다
    }
    const s = await lifecycleStatus({ projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, entries: seed, platform: "linux", includeUser: false });
    expect(s.ok && s.journalsUnreadable).toBe(1);
    expect(await readFile(damaged, "utf8")).toBe("{ broken");
    // 사용자가 손상 파일을 치우면 정상 복구 경로로 돌아온다.
    await rm(damaged);
    expect(await (await c.approveRecovery()).run()).toMatchObject({ status: "recovered" });
  });

  it("[C] removeJournal은 지운 뒤 남은 파일이 있으면 false다(조용히 성공하지 않는다)", async () => {
    const c = await installed();
    await c.interrupt();
    const [j] = await c.journals();
    await mkdir(path.join(journalDirOf(c.h.homeDir), OBSTACLE(j!.transactionId)));
    expect(await removeJournal(c.h.homeDir, j!.transactionId)).toBe(false);
    await rm(path.join(journalDirOf(c.h.homeDir), OBSTACLE(j!.transactionId)), { recursive: true });
    expect(await removeJournal(c.h.homeDir, j!.transactionId)).toBe(true);
    expect(await c.journals()).toEqual([]);
    expect(await removeJournal(c.h.homeDir, "not-an-id")).toBe(false);
  });

  it("[C] 복구가 설정을 되돌린 뒤 Journal을 지우지 못하면 recovered가 아니라 cleanup-failed이고, 현재 설정·남은 기록·다음 단계를 알린다", async () => {
    const c = await installed();
    await c.interrupt();
    const [j] = await c.journals();
    const opts = c.recoveryOptions();
    const built = await planRecovery(opts);
    if (!built.ok) throw new Error(built.code);
    const o = await requestRecoveryApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (o.status !== "approved") throw new Error(o.status);
    const r = await executeRecovery(o.approval, { ...opts, regenerate: () => planRecovery(opts), trace: async (phase) => {
      if (phase === "recover-cleanup") await mkdir(path.join(journalDirOf(c.h.homeDir), OBSTACLE(j!.transactionId)));
    } });
    expect(r).toMatchObject({ status: "cleanup-failed", error: { code: "JOURNAL_CLEANUP_FAILED" }, targets: [{ restored: true }] });
    expect(r.nextActions.join(" ")).toContain("변경 전");
    expect(r.nextActions.join(" ")).toContain("--discard");
    expect(JSON.stringify(r).split('"').some((s) => containsAbsolutePath(s))).toBe(false);
    const s = await lifecycleStatus({ projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, entries: seed, platform: "linux", includeUser: false });
    expect(s.ok && s.journalsUnreadable).toBe(1); // 남은 장애물은 손상 기록으로 보이고 계획을 막는다
    await rm(path.join(journalDirOf(c.h.homeDir), OBSTACLE(j!.transactionId)), { recursive: true });
    expect(await c.status()).toEqual(["state-consistent"]);
  });

  it("[C] 작업이 끝난 뒤 Journal을 지우지 못하면 결과에 journal-cleanup-failed 경고와 다음 단계를 남긴다", async () => {
    const c = await installed();
    const env = c.env(healthy, { trace: (phase) => {
      if (phase !== "journal-cleanup") return;
      const id = readdirSync(journalDirOf(c.h.homeDir)).find((n) => /^[0-9a-f]{32}\.json$/u.test(n))!.slice(0, 32);
      mkdirSync(path.join(journalDirOf(c.h.homeDir), OBSTACLE(id)));
    } });
    const r = await c.update(env);
    expect(r.status).toBe("updated");
    expect(r.warnings.map((w) => w.code)).toContain("journal-cleanup-failed");
    expect(r.nextActions.join(" ")).toContain("openhub lifecycle recover github-mcp-server");
  });

  it("[C] 작업이 Version State commit까지 끝나고 Journal만 남았으면 undo는 막고(OPERATION_COMPLETED) discard로 기록만 지운다", async () => {
    const c = await installed();
    // commit 뒤 정리 직전 강제 종료와 같은 디스크 상태를 만든다: 정리 직전 Journal 내용을 복사해 두고, 끝난 뒤 다시 둔다.
    let copy: { name: string; body: string } | undefined;
    const env = c.env(healthy, { trace: (phase) => {
      if (phase !== "journal-cleanup") return;
      const name = readdirSync(journalDirOf(c.h.homeDir)).find((n) => /^[0-9a-f]{32}\.json$/u.test(n))!;
      copy = { name, body: readFileSync(path.join(journalDirOf(c.h.homeDir), name), "utf8") };
    } });
    expect((await c.update(env)).status).toBe("updated");
    await writeFile(path.join(journalDirOf(c.h.homeDir), copy!.name), copy!.body);
    expect((await c.journals()).map((j) => j.phase)).toEqual(["state-commit"]);
    expect(await c.status()).toEqual(["interrupted-update"]);
    const committed = await c.files();
    const undo = await planRecovery(c.recoveryOptions());
    expect(undo.ok && undo.planned.plan.status).toBe("blocked");
    expect(undo.ok && undo.planned.plan.blockers.map((b) => b.code)).toEqual(["OPERATION_COMPLETED"]);
    const discard = await c.approveRecovery("discard");
    expect(discard.built.ok && discard.built.planned.plan).toMatchObject({ status: "ready", effects: { configWrites: 0 } });
    expect(await discard.run()).toMatchObject({ status: "discarded" });
    expect(await c.files()).toEqual(committed);
    expect(await c.status()).toEqual(["state-consistent"]);
  });

  it("[D] 단계 갱신(setJournalPhase)이 실패하면 예외이고, Health 직전 실패는 설정을 되돌리고 JOURNAL_WRITE_FAILED다", async () => {
    const c = await installed();
    await expect(setJournalPhase(c.h.homeDir, { schemaVersion: 1 } as never, "health")).rejects.toThrow();
    const before = await c.files();
    let healthRan = false;
    const env = c.env(async (...a) => ((healthRan = true), healthy(...a)), { trace: (phase) => {
      if (phase !== "config-replaced") return;
      const dir = journalDirOf(c.h.homeDir);
      const name = readdirSync(dir).find((n) => /^[0-9a-f]{32}\.json$/u.test(n))!;
      unlinkSync(path.join(dir, name));
      mkdirSync(path.join(dir, name)); // 같은 이름 디렉터리: 다음 Journal rename이 실패한다
    } });
    const r = await c.update(env);
    expect(r).toMatchObject({ status: "config-failed", code: "JOURNAL_WRITE_FAILED", compensated: true });
    expect(healthRan).toBe(false);
    expect(await c.files()).toEqual(before);
  });

  it("[D] Version State commit 직전 단계 갱신이 실패하면 commit하지 않고 설정을 되돌린다(state-commit-failed / JOURNAL_WRITE_FAILED)", async () => {
    const c = await installed();
    const before = await c.files();
    const env = c.env(healthy, { trace: (phase) => {
      if (phase !== "state-commit") return;
      const dir = journalDirOf(c.h.homeDir);
      const name = readdirSync(dir).find((n) => /^[0-9a-f]{32}\.json$/u.test(n))!;
      unlinkSync(path.join(dir, name));
      mkdirSync(path.join(dir, name));
    } });
    const r = await c.update(env);
    expect(r).toMatchObject({ status: "state-commit-failed", code: "JOURNAL_WRITE_FAILED", compensated: true, stateCommitted: false });
    expect(r.health?.status).toBe("healthy");
    expect(await c.files()).toEqual(before);
  });
});
