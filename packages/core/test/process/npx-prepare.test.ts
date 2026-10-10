import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  NPX_PREPARED_MARKER,
  containsAbsolutePath,
  npmToolArgv,
  npxCacheKey,
  npxPrepareArgs,
  parseNpxPrepareArgs,
  prepareNpxPackage,
  type ExecSpawner,
  type NpxPrepareContext,
} from "../../src/index";
import { fakeNpmSpawner } from "./fake-npm";

/** v0.2.0 npx Prepare(process/npx-prepare.ts). 임시 디렉터리를 npm cache로 쓰고 가짜 npm만 실행한다(network 0). */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-npx-prepare-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const SPEC = "@acme/big-mcp@3.0.5";
const ARGS = npxPrepareArgs(SPEC);
let n = 0;
async function cache() {
  const root = path.join(scratch, "cache-" + String(n++));
  await mkdir(path.join(root, "_npx"), { recursive: true });
  return root;
}
const entryDir = (root: string, spec = SPEC) => path.join(root, "_npx", npxCacheKey(spec));
function ctx(spawner: ExecSpawner, extra: Partial<NpxPrepareContext> = {}): NpxPrepareContext {
  return { platform: "linux", windowsNpx: null, spawner, killTree: async () => true, ...extra };
}
async function writeEntry(root: string, opts: { lock?: boolean; version?: string; marker?: boolean } = {}) {
  const dir = entryDir(root);
  await mkdir(path.join(dir, "node_modules", "@acme", "big-mcp"), { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ _npx: { packages: [SPEC] } }));
  await writeFile(path.join(dir, "node_modules", "@acme", "big-mcp", "package.json"), JSON.stringify({ version: opts.version ?? "3.0.5" }));
  if (opts.lock ?? true) await writeFile(path.join(dir, "node_modules", ".package-lock.json"), "{}");
  if (opts.marker === true) await writeFile(path.join(dir, NPX_PREPARED_MARKER), JSON.stringify({ schemaVersion: 1, spec: SPEC }));
  return dir;
}
const installs = (calls: string[][]) => calls.filter((c) => c.some((a) => a.startsWith("--package=")));

describe("npx Prepare 계약", () => {
  it("npx cache key는 npm(libnpmexec)과 같다(실측값)", () => {
    expect(npxCacheKey("mongodb-mcp-server@3.0.5")).toBe("af0658195794d41e");
    expect(npxCacheKey("kubernetes-mcp-server@0.0.67")).toBe("38d314ab26c67524");
    expect(npxCacheKey("mongodb-mcp-server")).toBe("191c568aa03d4fb8");
    expect(npxCacheKey("kubernetes-mcp-server")).toBe("1f190e3fd794e4ed");
  });

  it("준비 인자는 고정 형식이고 정확한 버전만 받는다", () => {
    expect(ARGS).toEqual(["--yes", "--package=@acme/big-mcp@3.0.5", "--", "node", "--version"]);
    expect(parseNpxPrepareArgs(ARGS)).toBe(SPEC);
    for (const spec of ["@acme/big-mcp", "@acme/big-mcp@latest", "@acme/big-mcp@^3.0.5", "big@3", "big@3.0.5;rm"]) expect(parseNpxPrepareArgs(npxPrepareArgs(spec)), spec).toBeNull();
    for (const args of [["--yes", "--package=" + SPEC, "--", "big-mcp"], ["--package=" + SPEC, "--yes", "--", "node", "--version"], [...ARGS, "--extra"], ["-y", SPEC]]) expect(parseNpxPrepareArgs(args)).toBeNull();
  });

  it("Windows는 cmd 없이 node.exe + npx-cli.js·npm-cli.js로 실행하고 실행 경로가 없으면 spawn 0회다", async () => {
    const launcher = { node: "C:\\nodejs\\node.exe", npxCli: "C:\\nodejs\\node_modules\\npm\\bin\\npx-cli.js" };
    expect(npmToolArgv("npx", ARGS, "windows", launcher)).toEqual({ executable: launcher.node, args: [launcher.npxCli, ...ARGS] });
    expect(npmToolArgv("npm", ["config", "get", "cache"], "windows", launcher)).toEqual({ executable: launcher.node, args: ["C:\\nodejs\\node_modules\\npm\\bin\\npm-cli.js", "config", "get", "cache"] });
    const root = await cache();
    const npm = fakeNpmSpawner({ cacheRoot: root });
    const r = await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner, { platform: "windows", windowsNpx: launcher }));
    expect(r.status).toBe("done");
    expect(npm.calls.every((c) => c[0] === launcher.node)).toBe(true);
    expect(npm.calls.flat().some((a) => /^cmd(\.exe)?$/iu.test(a) || a === "/c")).toBe(false);
    const none = fakeNpmSpawner({ cacheRoot: root });
    expect(await prepareNpxPackage(ARGS, scratch, ctx(none.spawner, { platform: "windows", windowsNpx: null }))).toMatchObject({ status: "failed", code: "LAUNCHER_NOT_FOUND" });
    expect(none.calls).toEqual([]);
  });

  it("빈 cache: 받고 검증한 뒤 OpenHub 표시를 남기며 다음에는 다시 받지 않는다", async () => {
    const root = await cache();
    const npm = fakeNpmSpawner({ cacheRoot: root });
    const first = await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner));
    expect(first).toMatchObject({ status: "done", excerpt: "npx cache: installed" });
    expect(npm.calls).toEqual([["npm", "config", "get", "cache"], ["npx", ...ARGS]]);
    expect(JSON.parse(await readFile(path.join(entryDir(root), NPX_PREPARED_MARKER), "utf8"))).toEqual({ schemaVersion: 1, spec: SPEC });
    const second = await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner));
    expect(second).toMatchObject({ status: "done", excerpt: "npx cache: reused (verified by OpenHub)" });
    expect(installs(npm.calls)).toHaveLength(1);
    expect(containsAbsolutePath(JSON.stringify([first, second]))).toBe(false);
  });

  it("끊긴 설치(완료 표시 없음)는 그 항목만 치우고 다시 받으며 다른 cache 항목은 그대로다", async () => {
    const root = await cache();
    await writeEntry(root, { lock: false });
    const other = path.join(root, "_npx", "0123456789abcdef");
    await mkdir(other, { recursive: true });
    await writeFile(path.join(other, "package.json"), "keep");
    const npm = fakeNpmSpawner({ cacheRoot: root });
    expect(await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner))).toMatchObject({ status: "done", excerpt: "npx cache: repaired and installed" });
    expect(await readFile(path.join(other, "package.json"), "utf8")).toBe("keep");
    expect((await readdir(path.join(root, "_npx"))).sort()).toEqual(["0123456789abcdef", npxCacheKey(SPEC)].sort());
    expect(existsSync(path.join(entryDir(root), "node_modules", ".package-lock.json"))).toBe(true);
  });

  it("출처를 모르는 완성 항목(Client가 만든 항목)은 새로 받아 검증하고, 사용 중이라 옮길 수 없으면 그대로 쓴다", async () => {
    const root = await cache();
    await writeEntry(root, { lock: true });
    const npm = fakeNpmSpawner({ cacheRoot: root });
    expect(await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner))).toMatchObject({ status: "done", excerpt: "npx cache: installed" });
    expect(installs(npm.calls)).toHaveLength(1);

    const busy = await cache();
    await writeEntry(busy, { lock: true });
    const npm2 = fakeNpmSpawner({ cacheRoot: busy });
    const locked = { rename: async () => Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" })) };
    expect(await prepareNpxPackage(ARGS, scratch, ctx(npm2.spawner, { fs: locked }))).toMatchObject({ status: "done", excerpt: "npx cache: reused (in use, not re-downloaded)" });
    expect(installs(npm2.calls)).toEqual([]);
  });

  it("불완전 항목을 옮길 수 없으면(사용 중) 아무것도 바꾸지 않고 실패한다", async () => {
    const root = await cache();
    const dir = await writeEntry(root, { lock: false });
    const npm = fakeNpmSpawner({ cacheRoot: root });
    const locked = { rename: async () => Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" })) };
    expect(await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner, { fs: locked }))).toMatchObject({ status: "failed", code: "NPX_CACHE_IN_USE" });
    expect(installs(npm.calls)).toEqual([]);
    expect(existsSync(path.join(dir, "node_modules", "@acme", "big-mcp", "package.json"))).toBe(true);
  });

  it("실패·버전 불일치면 이번 불완전 항목을 정리하고 다시 시도할 수 있다", async () => {
    for (const mode of ["fail", "wrong-version", "incomplete"] as const) {
      const root = await cache();
      const bad = fakeNpmSpawner({ cacheRoot: root, prepare: mode });
      const r = await prepareNpxPackage(ARGS, scratch, ctx(bad.spawner));
      expect(r.status, mode).toBe("failed");
      expect(r.code, mode).toBe(mode === "fail" ? "STEP_FAILED" : "NPX_PREPARE_INCOMPLETE");
      expect(existsSync(entryDir(root)), mode).toBe(false);
      expect((await prepareNpxPackage(ARGS, scratch, ctx(fakeNpmSpawner({ cacheRoot: root }).spawner))).status, mode).toBe("done");
    }
  });

  it("Prepare 전용 timeout이 지나면 process tree를 끝내고 불완전 항목을 정리하며 재시도하면 완료된다", async () => {
    const root = await cache();
    const hang = fakeNpmSpawner({ cacheRoot: root, prepare: "hang" });
    const killTree = vi.fn(async () => true);
    const r = await prepareNpxPackage(ARGS, scratch, ctx(hang.spawner, { killTree, timeoutMs: 50 }));
    expect(r).toMatchObject({ status: "failed", code: "STEP_TIMEOUT" });
    expect(killTree).toHaveBeenCalledWith(4242, "linux");
    expect(existsSync(entryDir(root))).toBe(false);
    expect(r.excerpt).toContain("다시 시도할 수 있습니다");
    expect((await prepareNpxPackage(ARGS, scratch, ctx(fakeNpmSpawner({ cacheRoot: root }).spawner))).status).toBe("done");
  }, 15_000);

  it("cache 위치를 알 수 없거나 상대 경로면 받지 않는다", async () => {
    for (const out of ["", "relative/cache", "/a\n/b"]) {
      const npm = fakeNpmSpawner({ cacheRoot: await cache(), configStdout: out });
      expect(await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner))).toMatchObject({ status: "failed", code: "NPX_CACHE_UNKNOWN" });
      expect(installs(npm.calls)).toEqual([]);
    }
  });

  it("cache 항목이 symlink·junction이면 거부한다", async () => {
    const root = await cache();
    const outside = path.join(scratch, "outside-" + String(n++));
    await mkdir(outside, { recursive: true });
    await symlink(outside, entryDir(root), process.platform === "win32" ? "junction" : "dir");
    const npm = fakeNpmSpawner({ cacheRoot: root });
    expect(await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner))).toMatchObject({ status: "failed", code: "NPX_CACHE_REJECTED" });
    expect(installs(npm.calls)).toEqual([]);
  });

  it("고정되지 않았거나 형식이 다른 준비 단계는 spawn 0회로 거부한다", async () => {
    const npm = fakeNpmSpawner({ cacheRoot: await cache() });
    expect(await prepareNpxPackage(["--yes", "--package=@acme/big-mcp@latest", "--", "node", "--version"], scratch, ctx(npm.spawner))).toMatchObject({ status: "failed", code: "NPX_PREPARE_REJECTED" });
    expect(await prepareNpxPackage(["-y", SPEC], scratch, ctx(npm.spawner))).toMatchObject({ status: "failed", code: "NPX_PREPARE_REJECTED" });
    expect(npm.calls).toEqual([]);
  });
});
