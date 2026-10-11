import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  planLifecycleRequest,
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
import { newScratch } from "./helpers";
import { fakeNpmSpawner } from "../process/fake-npm";

/**
 * v0.2.1 P0-5 재현: Update에서 config 교체 뒤 Health 실행기가 값을 돌려주지 않고 예외를 던지면(TEMP 접근 실패·파일 생성 실패·spawner 예외 등)
 * 정상 Health 실패와 같은 보상 경로로 가야 한다: Client 설정 원본 복구, Version State 그대로, 원인 표시, 다음 행동 안내.
 */
const seed = await seedEntries();
const scratch = await newScratch("v021-health-exception");
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function installedCase(makeEnv: (base: LifecycleEnvironment) => LifecycleEnvironment) {
  const h = await createHarness(scratch, { entries: seed });
  const targets: InstallRequest["targets"] = [{ client: "cursor", scope: "project" }];
  const install = h.request("github-mcp-server", targets);
  const planned0 = await plannedOf(h, install);
  const installed = await runInstallTransaction(planned0, await approveAll(planned0), install, h.env);
  expect(installed.status).toBe("succeeded");
  expect(await recordInstallInState(planned0, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-11T00:00:00.000Z") })).toMatchObject({ ok: true });
  const exec = fakeNpmSpawner({ cacheRoot: path.join(scratch, "npm-" + Math.random().toString(36).slice(2, 8)) });
  const base: LifecycleEnvironment = {
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
    spawner: exec.spawner,
  };
  const env = makeEnv(base);
  const request: LifecycleRequest = { operation: "update", toolId: "github-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets };
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) throw new Error(built.code + " " + built.message);
  const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  const files = async () => [await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8"), await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8")];
  return { run: () => runLifecycleTransaction(built.planned, outcome.approval, request, env), files };
}

describe("v0.2.1 P0-5 Health 예외 보상(Update)", () => {
  const throwing: [string, (base: LifecycleEnvironment) => LifecycleEnvironment][] = [
    ["runHealth가 Error를 던짐(TEMP 접근 실패)", (b) => ({ ...b, runHealth: async () => { throw Object.assign(new Error("EACCES: permission denied, mkdtemp"), { code: "EACCES" }); } })],
    ["runHealth가 Error가 아닌 값으로 reject", (b) => ({ ...b, runHealth: () => Promise.reject("boom") })],
    ["실제 runHealthCheck + Health spawner 예외(프로세스 시작 예외)", (b) => ({ ...b, healthSpawner: () => { throw new Error("spawn EPERM"); } })],
  ];
  for (const [name, makeEnv] of throwing) {
    it(name + ": config 원본 복구·Version State 그대로·health-failed·다음 행동 안내", async () => {
      const c = await installedCase(makeEnv);
      const before = await c.files();
      const result = await c.run().catch((e: unknown) => ({ status: "threw", error: String(e) }));
      const after = await c.files();
      expect(after[0], JSON.stringify(result).slice(0, 400)).toBe(before[0]);
      expect(after[1]).toBe(before[1]);
      expect(result).toMatchObject({ status: "health-failed", compensated: true, stateCommitted: false });
      expect((result as { nextActions?: string[] }).nextActions?.length ?? 0).toBeGreaterThan(0);
    });
  }

  it("실제 runHealthCheck + 임시 폴더를 만들 수 없는 tempBase(파일 경로): 예외로 빠지지 않고 같은 보상 경로", async () => {
    const blocker = path.join(scratch, "not-a-dir-" + Math.random().toString(36).slice(2, 8));
    await writeFile(blocker, "x");
    const c = await installedCase((b) => ({ ...b, tempBase: blocker }));
    const before = await c.files();
    const result = await c.run().catch((e: unknown) => ({ status: "threw", error: String(e) }));
    const after = await c.files();
    expect(after[0], JSON.stringify(result).slice(0, 400)).toBe(before[0]);
    expect(after[1]).toBe(before[1]);
    expect(result).toMatchObject({ status: "health-failed", compensated: true, stateCommitted: false });
  });
});
