import "./locale-ko";
import { readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  OPENHUB_CORE_VERSION,
  executeRecovery,
  planLifecycleRequest,
  planRecovery,
  recordInstallInState,
  requestLifecycleApproval,
  requestRecoveryApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type LifecycleEnvironment,
  type LifecycleRequest,
  nodeConfigFs,
  type ConfigFs,
} from "@openhub/core";
import { setDesktopLocale } from "../src/i18n/index";
import { LIFECYCLE_STATUS_CHANNEL, LifecycleSession, registerLifecycle, type LifecycleStatusResponse } from "../src/lifecycle";
import { approveAll, createHarness, plannedOf } from "../../../packages/core/test/installer/harness";
import { seedEntries } from "../../../packages/core/test/recommendation/helpers";
import { fakeNpmSpawner } from "../../../packages/core/test/process/fake-npm";
import { abandonOperationLock, newScratch } from "../../../packages/core/test/lifecycle/helpers";

/**
 * v0.2.1 Desktop 복구 안내. Core harness로 "Health 중 끝난 Update"(interrupted-update)를 만든 뒤 Desktop INSTALLED 상태가
 * 정확한 CLI 명령·CLI 설치 방법·확인 방법을 보여 주는지, CLI와 같은 Core 복구 뒤 경고가 사라지는지 확인한다(spawn·network 0).
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY = path.join(ROOT, "registry");
const seed = await seedEntries();
const scratch = await newScratch("desktop-recovery-guidance");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const targets = [{ client: "cursor" as const, scope: "project" as const }];

async function interrupted() {
  const h = await createHarness(scratch, { entries: seed });
  const install = h.request("github-mcp-server", targets);
  const p = await plannedOf(h, install);
  const r = await runInstallTransaction(p, await approveAll(p), install, h.env);
  await recordInstallInState(p, r, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
  let reached!: () => void;
  const inHealth = new Promise<void>((res) => (reached = res));
  const env: LifecycleEnvironment = {
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: scratch,
    now: () => new Date(),
    fetch: async (url: string) =>
      url.startsWith("https://ghcr.io/token") ? new Response(JSON.stringify({ token: "anon" })) : url.includes("/manifests/") ? new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "f".repeat(64) } }) : new Response("x", { status: 404 }),
    configFs: h.env.configFs!,
    spawner: fakeNpmSpawner({ cacheRoot: path.join(h.base, "npm") }).spawner,
    runHealth: () => (reached(), new Promise(() => undefined)),
  };
  const request: LifecycleRequest = { operation: "update", toolId: "github-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets };
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) throw new Error(built.code);
  const o = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (x) => x.requirements.map((y) => y.id) });
  if (o.status !== "approved") throw new Error(o.status);
  void runLifecycleTransaction(built.planned, o.approval, request, env);
  await inHealth;
  await abandonOperationLock(h.homeDir);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  // 안내 조회는 읽기만 한다: 쓰기·spawn·network를 모두 기록한다.
  const effects: string[] = [];
  const watchFs: ConfigFs = {
    ...nodeConfigFs,
    writeFile: async (f, d) => (effects.push("write"), nodeConfigFs.writeFile(f, d)),
    rename: async (a, b) => (effects.push("rename"), nodeConfigFs.rename(a, b)),
    mkdir: async (d) => (effects.push("mkdir"), nodeConfigFs.mkdir(d)),
    rm: async (f) => (effects.push("rm"), nodeConfigFs.rm(f)),
  };
  registerLifecycle({ handle: (ch: string, fn: (...args: unknown[]) => unknown) => void handlers.set(ch, fn) }, new LifecycleSession(() => h.projectRoot), {
    registryDir: REGISTRY,
    platform: "linux",
    homeDir: h.homeDir,
    dialog: { showMessageBox: async () => ({ response: 0 }) },
    configFs: watchFs,
    spawner: (() => {
      effects.push("spawn");
      throw new Error("no spawn during status");
    }) as never,
    fetch: (async () => {
      effects.push("network");
      throw new Error("no network during status");
    }) as never,
  });
  const status = async () => {
    const s = (await handlers.get(LIFECYCLE_STATUS_CHANNEL)!({}, undefined)) as LifecycleStatusResponse;
    if (s.status !== "ok") throw new Error(s.status);
    return s.items.find((i) => i.toolId === "github-mcp-server")!;
  };
  return { h, status, effects };
}

/** ~/.openhub/state 아래 모든 파일의 (이름, 크기, mtime). 안내 조회 전후가 같아야 한다. */
async function stateSnapshot(home: string): Promise<string[]> {
  const root = path.join(home, ".openhub", "state");
  const names = (await readdir(root, { recursive: true })).map(String).sort();
  return Promise.all(names.map(async (n) => {
    const s = await stat(path.join(root, n));
    return n + ":" + (s.isFile() ? String(s.size) + ":" + String(s.mtimeMs) : "dir");
  }));
}

describe("v0.2.1 Desktop: 중단된 작업 복구 안내", () => {
  it("INSTALLED가 지금 가능한 복구 명령(정확한 도구 ID)·CLI 설치 방법·확인 방법을 보여 주고, CLI와 같은 Core 복구 뒤 경고가 사라진다", async () => {
    setDesktopLocale("ko");
    const c = await interrupted();
    const stateBefore = await stateSnapshot(c.h.homeDir);
    const configBefore = await readFile(path.join(c.h.projectRoot, ".cursor", "mcp.json"), "utf8");
    const before = await c.status();
    expect(before.state).toBe("interrupted-update");
    expect(before.warning).toContain("openhub lifecycle recover github-mcp-server");
    expect(before.warning).not.toContain("--discard");
    expect(before.warning).toContain("npm install -g ./openhub-ai-" + OPENHUB_CORE_VERSION + ".tgz");
    expect(before.warning).toContain("interrupted-update가 사라졌는지");
    expect(before.canUpdate || before.canRollback || before.canRepair).toBe(false);

    setDesktopLocale("en");
    const english = await c.status();
    expect(english.warning).toContain("run openhub lifecycle recover github-mcp-server");
    expect(english.warning).toContain("npm install -g ./openhub-ai-" + OPENHUB_CORE_VERSION + ".tgz");
    setDesktopLocale("ko");
    // 안내를 두 번(한국어·영어) 조회하는 동안 쓰기·spawn·network 0, state·journal·설정 파일 그대로.
    expect(c.effects).toEqual([]);
    expect(await stateSnapshot(c.h.homeDir)).toEqual(stateBefore);
    expect(await readFile(path.join(c.h.projectRoot, ".cursor", "mcp.json"), "utf8")).toBe(configBefore);

    // CLI(openhub lifecycle recover)와 같은 Core 경로로 승인·복구한다.
    const options = { toolId: "github-mcp-server", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, mode: "undo" as const };
    const built = await planRecovery(options);
    if (!built.ok) throw new Error(built.code);
    const approved = await requestRecoveryApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (approved.status !== "approved") throw new Error(approved.status);
    const done = await executeRecovery(approved.approval, { toolId: "github-mcp-server", projectRoot: c.h.projectRoot, homeDir: c.h.homeDir, regenerate: () => planRecovery(options) });
    expect(done.status).toBe("recovered");
    const after = await c.status();
    expect(after.state).toBe("state-consistent");
    expect(after.warning ?? "").not.toContain("lifecycle recover");
    expect(JSON.parse(await readFile(path.join(c.h.projectRoot, ".cursor", "mcp.json"), "utf8")).mcpServers).toHaveProperty("github");
  }, 30_000);
});
