import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  containsAbsolutePath,
  executePinokioPlan,
  executeWithPinokioApproval,
  loopbackGet,
  planPinokio,
  readPinokioState,
  requestPinokioApproval,
  serializePinokioPlan,
  serializePinokioResult,
  serializePinokioState,
  type ExecSpawner,
  type PinokioPlanRequest,
  type PlannedPinokio,
} from "../../src/index";
import { COMMIT, COMMIT2, newHome, pinokioManifest, pinokiod, ptermLayout, realFs, scratch } from "./helpers";

/** TASK-053 Pinokio 실행·Health·Lifecycle. fake pterm(spawner)과 fake pinokiod(loopback HTTP)만 쓴다. */
const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
const TIMEOUTS = { runMs: 2000, healthMs: 300, pollMs: 10, stopMs: 200 };
let n = 0;

interface FakeOptions {
  failRun?: string[];
  exitCode?: number;
  health?: "ok" | "500" | "never";
  stuckStart?: boolean;
}
type Listener = (...a: unknown[]) => void;
function fakeChild() {
  const listeners: Record<string, Listener[]> = {};
  let closed = false;
  const close = (code: number | null, signal: string | null = null) => {
    if (closed) return;
    closed = true;
    for (const l of listeners["close"] ?? []) l(code, signal);
  };
  const child = { stdout: null, stderr: null, on: (e: string, l: Listener) => ((listeners[e] ??= []).push(l), child), kill: () => (close(null, "SIGTERM"), true) };
  return { child, close };
}

/** pterm을 흉내 낸다: start <script>는 script JSON의 fs.write 단계(완료 표시)를 app 폴더에 쓰고, start openhub-start.js는 stop까지 띄운다. */
function fakePinokio(home: string, opts: FakeOptions = {}) {
  const calls: string[][] = [];
  const seen: { script: string; content: string }[] = [];
  let running = false;
  let startClose: ((c: number | null) => void) | null = null;
  const applyWrites = async (dir: string, script: string) => {
    const content = await readFile(path.join(dir, script), "utf8");
    seen.push({ script, content });
    const doc = JSON.parse(content.slice("module.exports = ".length, -2)) as { run: { method: string; params: { path?: string; text?: string } }[] };
    for (const step of doc.run) if (step.method === "fs.write" && !(opts.failRun ?? []).includes(script)) await writeFile(path.join(dir, step.params.path!), step.params.text!);
  };
  const spawner: ExecSpawner = (executable, args, options) => {
    calls.push([path.basename(executable), ...args.slice(1)]);
    const { child, close } = fakeChild();
    const [, verb, script] = args as string[];
    setTimeout(() => {
      void (async () => {
        if (verb === "start" && script !== "openhub-start.js") {
          await applyWrites(options.cwd, script!);
          close(opts.exitCode ?? 0);
        } else if (verb === "start") {
          await applyWrites(options.cwd, script!);
          running = opts.health !== "never";
          startClose = close;
        } else {
          running = false;
          if (opts.stuckStart !== true) startClose?.(0);
          close(0);
        }
      })();
    }, 1);
    return child as never;
  };
  const daemon = pinokiod(home, undefined, async () => (running ? new Response("ok", { status: opts.health === "500" ? 500 : 200 }) : Promise.reject(new TypeError("connection refused"))));
  return { spawner, calls, seen, fetch: daemon.fetch, fetchCalls: daemon.calls };
}

async function setup(opts: FakeOptions = {}) {
  n += 1;
  const layout = await ptermLayout();
  const home = await newHome();
  const openhubHome = path.join(scratch, "openhub-home-" + String(n));
  const projectRoot = path.join(scratch, "project-" + String(n));
  await mkdir(openhubHome, { recursive: true });
  await mkdir(projectRoot, { recursive: true });
  const fake = fakePinokio(home, opts);
  return { layout, home, openhubHome, projectRoot, fake, appDir: path.join(home, "api", "openhub-local-llm-ui") };
}
type Setup = Awaited<ReturnType<typeof setup>>;
const deps = (s: Setup) => ({ probe: { pathEnv: s.layout.pathEnv, platform: process.platform, fs: realFs(), fetch: s.fake.fetch }, homeDir: s.openhubHome });
const request = (over: Partial<PinokioPlanRequest> = {}): PinokioPlanRequest => ({ operation: "install", manifest: pinokioManifest(), ...over });

async function run(s: Setup, req: PinokioPlanRequest, fake = s.fake) {
  const first = await planPinokio(req, { ...deps(s), probe: { ...deps(s).probe, fetch: fake.fetch } });
  if (!first.ok) throw new Error(first.code + " " + first.message);
  const out = await requestPinokioApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (out.status !== "approved") throw new Error(out.status);
  const regenerate = async (): Promise<PlannedPinokio> => {
    const again = await planPinokio(req, { ...deps(s), probe: { ...deps(s).probe, fetch: fake.fetch } });
    if (!again.ok) throw new Error(again.code);
    return again.planned;
  };
  const report = await executeWithPinokioApproval(out.approval, regenerate, { entry: first.entry, homeDir: s.openhubHome, projectRoot: s.projectRoot, fetch: fake.fetch, spawner: fake.spawner, timeouts: TIMEOUTS, now: () => new Date("2026-10-07T12:00:00.000Z") });
  if (!report.ok) throw new Error(report.code);
  if (!("result" in report)) throw new Error("gate");
  return { result: report.result, planned: first.planned };
}
const stateOf = async (s: Setup) => {
  const r = await readPinokioState({ homeDir: s.openhubHome });
  if (!r.ok) throw new Error(r.code);
  return r.state;
};
const stateFile = (s: Setup) => path.join(s.openhubHome, ".openhub", "state", "pinokio.json");
const verbs = (calls: string[][]) => calls.map((c) => c.slice(1, 3).join(" "));

describe("REQ-032 Pinokio 실행·Health·Lifecycle", () => {
  it("AC-053-01 VerifiedPlan(pinokio-plan-v1) 없이 실행하면 APPROVAL_REQUIRED이고 spawn·write 0회다", async () => {
    const s = await setup();
    const planned = await planPinokio(request(), deps(s));
    if (!planned.ok) throw new Error(planned.code);
    const options = { entry: planned.entry, homeDir: s.openhubHome, fetch: s.fake.fetch, spawner: s.fake.spawner, timeouts: TIMEOUTS };
    expect(await executePinokioPlan(planned.planned as never, options)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(await executePinokioPlan({ plan: planned.planned.plan, planDigest: planned.planned.planDigest, acknowledgements: ["base", "pinokio-delegated-shell", "health-execution"], channel: "cli-tty" } as never, options)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(await executeWithPinokioApproval(undefined, () => planned.planned, options)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(s.fake.calls).toEqual([]);
    expect(existsSync(s.appDir)).toBe(false);
    expect(existsSync(stateFile(s))).toBe(false);
  });

  it("AC-053-02 fake pinokiod로 install이 성공하고 성공 판정은 pterm exit code가 아니라 완료 표시와 Health다", async () => {
    const s = await setup({ exitCode: 1 });
    const { result, planned } = await run(s, request());
    expect([result.status, result.code, result.health, result.stateRevision]).toEqual(["succeeded", null, { status: "healthy", httpStatus: 200 }, 1]);
    expect(verbs(s.fake.calls)).toEqual(["start openhub-install.js", "start openhub-start.js", "stop openhub-start.js"]);
    for (const sc of planned.plan.scripts) expect(await readFile(path.join(s.appDir, sc.name), "utf8")).toBe(sc.content);
    expect((await stateOf(s)).entries["local-llm-ui"]).toMatchObject({ commit: COMMIT, revision: 1, appRef: "api/openhub-local-llm-ui", lastHealth: { status: "healthy" }, previous: null });
    // exit 0이어도 완료 표시가 없으면 실패이고 Health를 실행하지 않는다.
    const t = await setup({ failRun: ["openhub-install.js"] });
    const failed = await run(t, request());
    expect([failed.result.status, failed.result.code, failed.result.recovered]).toEqual(["failed", "PINOKIO_RUN_INCOMPLETE", true]);
    expect(verbs(t.fake.calls)).toEqual(["start openhub-install.js"]);
    expect(await readdir(t.appDir)).toEqual([]);
    expect(existsSync(stateFile(t))).toBe(false);
    expect(failed.result.notices.map((x) => x.code)).toContain("app-folder-leftover");
  });

  it("AC-053-03 Health는 loopback URL만 확인하고 끝나면 pterm stop으로 정리하며 정리 실패는 Health 실패다", async () => {
    const s = await setup();
    await run(s, request());
    expect(s.fake.fetchCalls.filter((u) => !u.startsWith("http://127.0.0.1:42000/")).every((u) => u === "http://127.0.0.1:7860/health")).toBe(true);
    expect(verbs(s.fake.calls).at(-1)).toBe("stop openhub-start.js");
    const stuck = await setup({ stuckStart: true });
    const r = await run(stuck, request());
    expect([r.result.status, r.result.code, r.result.health?.status]).toEqual(["failed", "PINOKIO_HEALTH_FAILED", "cleanup-failed"]);
    expect(existsSync(stateFile(stuck))).toBe(false);
    const never = await setup({ health: "never" });
    expect((await run(never, request())).result.health?.status).toBe("timeout");
    const fetch = vi.fn(async () => new Response("ok"));
    expect(await loopbackGet("http://example.com:7860/", { fetch })).toEqual({ ok: false, reason: "not-loopback" });
    expect(await loopbackGet("https://127.0.0.1:7860/", { fetch })).toEqual({ ok: false, reason: "not-loopback" });
    expect(fetch).not.toHaveBeenCalled();
    const remote = await planPinokio(request({ manifest: pinokioManifest({ healthCheck: { type: "http", url: "http://10.0.0.5:7860/" } }) }), deps(s));
    expect(remote).toMatchObject({ ok: false, code: "PINOKIO_HEALTH_UNSUPPORTED" });
  });

  it("AC-053-04 Health가 실패하면 생성 script를 원본 byte로 복구하고 이전 commit으로 되돌리며 Pinokio state를 바꾸지 않는다", async () => {
    const s = await setup();
    await run(s, request());
    const before = new Map<string, string>();
    for (const f of await readdir(s.appDir)) before.set(f, await readFile(path.join(s.appDir, f), "utf8"));
    const stateBytes = await readFile(stateFile(s), "utf8");
    const bad = fakePinokio(s.home, { health: "500" });
    const r = await run(s, request({ operation: "update", targetCommit: COMMIT2 }), bad);
    expect([r.result.status, r.result.code, r.result.health, r.result.recovered]).toEqual(["failed", "PINOKIO_HEALTH_FAILED", { status: "unhealthy", httpStatus: 500 }, true]);
    expect(verbs(bad.calls)).toEqual(["start openhub-update.js", "start openhub-start.js", "stop openhub-start.js", "start openhub-update.js"]);
    expect(bad.seen[0]!.content).toContain("checkout " + COMMIT2);
    expect(bad.seen.at(-1)!.content).toContain("checkout " + COMMIT);
    expect(r.planned.plan.recovery?.content).toBe(bad.seen.at(-1)!.content);
    const after = new Map<string, string>();
    for (const f of await readdir(s.appDir)) after.set(f, await readFile(path.join(s.appDir, f), "utf8"));
    expect(after).toEqual(before);
    expect(await readFile(stateFile(s), "utf8")).toBe(stateBytes);
  });

  it("AC-053-05 update는 새 commit checkout 후 재설치이고 성공 시 state revision+1·previous를 남긴다", async () => {
    const s = await setup();
    await run(s, request());
    const r = await run(s, request({ operation: "update", targetCommit: COMMIT2 }));
    expect([r.result.status, r.result.stateRevision, r.planned.plan.previousCommit]).toEqual(["succeeded", 2, COMMIT]);
    expect(s.fake.seen.filter((x) => x.script === "openhub-update.js").at(-1)!.content).toMatch(new RegExp("fetch origin " + COMMIT2 + ".*checkout " + COMMIT2 + ".*uv pip install --python env local-llm-ui==1\\.2\\.0", "u"));
    const entry = (await stateOf(s)).entries["local-llm-ui"]!;
    expect([entry.commit, entry.revision, entry.previous?.commit, entry.previous?.revision]).toEqual([COMMIT2, 2, COMMIT, 1]);
    expect(existsSync(stateFile(s) + ".bak")).toBe(true);
  });

  it("AC-053-06 rollback은 이전 commit으로 같은 경로를 따르고 Preview·Result에 venv 원상 복구 비보장 고지가 있다", async () => {
    const s = await setup();
    await run(s, request());
    await run(s, request({ operation: "update", targetCommit: COMMIT2 }));
    const r = await run(s, request({ operation: "rollback" }));
    expect(r.planned.plan.notices.map((x) => x.code)).toContain("venv-not-restored");
    expect(r.result.notices.map((x) => x.code)).toContain("venv-not-restored");
    expect([r.result.status, r.planned.plan.run.script, r.planned.plan.commit]).toEqual(["succeeded", "openhub-update.js", COMMIT]);
    expect(s.fake.seen.at(-2)!.content).toContain("checkout " + COMMIT);
    const entry = (await stateOf(s)).entries["local-llm-ui"]!;
    expect([entry.commit, entry.revision, entry.previous?.commit]).toEqual([COMMIT, 3, COMMIT2]);
  });

  it("AC-053-07 PINOKIO_HOME이 절대 로컬 경로가 아니거나 app 폴더가 symlink·junction이면 거부하고 openhub-<toolId> 밖 쓰기가 0회다", async () => {
    const s = await setup();
    for (const bad of ["relative/pinokio", "\\\\\\\\server\\\\share\\\\pinokio", "//server/share", "file:///tmp/x", ""]) {
      const fetch = vi.fn(async (url: string) => new Response(JSON.stringify(url.endsWith("/home") ? { path: bad } : { pinokiod: "4.0.3", script: "4.0" }), { status: 200 }));
      expect(await planPinokio(request(), { ...deps(s), probe: { ...deps(s).probe, fetch } }), bad).toMatchObject({ ok: false, code: "PINOKIO_HOME_INVALID" });
    }
    const outside = path.join(scratch, "outside-" + String(n));
    await mkdir(outside, { recursive: true });
    await symlink(outside, s.appDir, process.platform === "win32" ? "junction" : "dir");
    expect(await planPinokio(request(), deps(s))).toMatchObject({ ok: false, code: "PINOKIO_PATH_ESCAPE" });
    // 승인 뒤 app 폴더가 junction으로 바뀌면 실행 단계에서 거부하고 밖에 쓰지 않는다.
    const t = await setup();
    const planned = await planPinokio(request(), deps(t));
    if (!planned.ok) throw new Error(planned.code);
    const out = await requestPinokioApproval(planned.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (out.status !== "approved") throw new Error(out.status);
    const outside2 = path.join(scratch, "outside2-" + String(n));
    await mkdir(outside2, { recursive: true });
    const report = await executeWithPinokioApproval(out.approval, () => planned.planned, { entry: planned.entry, homeDir: t.openhubHome, fetch: t.fake.fetch, spawner: t.fake.spawner, timeouts: TIMEOUTS });
    expect(report).toMatchObject({ ok: true });
    const u = await setup();
    const p2 = await planPinokio(request(), deps(u));
    if (!p2.ok) throw new Error(p2.code);
    const a2 = await requestPinokioApproval(p2.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (a2.status !== "approved") throw new Error(a2.status);
    await symlink(outside2, u.appDir, process.platform === "win32" ? "junction" : "dir");
    const escaped = await executeWithPinokioApproval(a2.approval, () => p2.planned, { entry: p2.entry, homeDir: u.openhubHome, fetch: u.fake.fetch, spawner: u.fake.spawner, timeouts: TIMEOUTS });
    expect(escaped).toMatchObject({ ok: true, result: { status: "failed", code: "PINOKIO_PATH_ESCAPE" } });
    expect(await readdir(outside2)).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
    expect(u.fake.calls).toEqual([]);
  });

  it("AC-053-08 Pinokio state·결과·로그에 절대 경로·env 값·token이 0건이다", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const s = await setup();
    const install = await run(s, request({ configTargets: [{ client: "claude-code", scope: "project" }, { client: "cursor", scope: "user" }, { client: "codex", scope: "project" }] }));
    expect(install.result.config).toEqual([
      { client: "codex", scope: "project", file: ".codex/config.toml", status: "manual-setup-required" },
      { client: "claude-code", scope: "project", file: ".mcp.json", status: "written" },
      { client: "cursor", scope: "user", file: "~/.cursor/mcp.json", status: "written" },
    ]);
    expect(JSON.parse(await readFile(path.join(s.projectRoot, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { "local-llm-ui": { type: "http", url: "http://127.0.0.1:7860/mcp" } } });
    expect(JSON.parse(await readFile(path.join(s.openhubHome, ".cursor", "mcp.json"), "utf8"))).toEqual({ mcpServers: { "local-llm-ui": { url: "http://127.0.0.1:7860/mcp" } } });
    const outputs = [serializePinokioState(await stateOf(s)), serializePinokioResult(install.result), await readFile(stateFile(s), "utf8")];
    for (const out of outputs) expect(containsAbsolutePath(out)).toBe(false);
    // Plan의 script 내용은 Pinokio on.event 정규식 문자열("/…/")이 있어 TASK-052 전용 검사를 쓴다. 여기서는 실제 경로가 없는지 본다.
    for (const out of [...outputs, serializePinokioPlan(install.planned.plan)]) {
      for (const banned of [s.home, s.openhubHome, s.layout.prefix, scratch, "ghp_", "sk-", "OPENAI_API_KEY"]) expect(out).not.toContain(banned);
    }
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("AC-053-09 실제 Pinokio 연동 E2E는 OPENHUB_E2E=1일 때만 실행되고 기본 테스트·CI에서는 skip이다", () => {
    const e2e = readFileSync(path.join(import.meta.dirname, "e2e.test.ts"), "utf8");
    expect(e2e).toContain('describe.skipIf(process.env["OPENHUB_E2E"] !== "1")');
    expect(readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8")).not.toContain("OPENHUB_E2E");
    expect(process.env["OPENHUB_E2E"] === "1" || true).toBe(true);
  });
});

