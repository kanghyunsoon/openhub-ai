import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  containsAbsolutePath,
  inspectNpxEntry,
  npmChildEnv,
  npmToolArgv,
  nodeNpxSpawner,
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
  return { platform: "linux", windowsNpx: null, spawner, killTree: async () => true, graceMs: 300, lockProbeMs: 150, busyWaitMs: 2_000, ...extra };
}
/** npm이 만드는 모양의 항목. lockfile에 의존성 하나(dep-a)를 적고 실제 파일 유무를 고를 수 있다. */
async function writeEntry(root: string, opts: { lock?: boolean; version?: string; dep?: boolean; bin?: boolean } = {}) {
  const dir = entryDir(root);
  const main = path.join(dir, "node_modules", "@acme", "big-mcp");
  await mkdir(main, { recursive: true });
  await writeFile(path.join(dir, "package.json"), JSON.stringify({ _npx: { packages: [SPEC] } }));
  await writeFile(path.join(main, "package.json"), JSON.stringify({ version: opts.version ?? "3.0.5", bin: { "big-mcp": "cli.js" } }));
  if (opts.bin ?? true) await writeFile(path.join(main, "cli.js"), "");
  if (opts.dep ?? true) {
    await mkdir(path.join(dir, "node_modules", "dep-a"), { recursive: true });
    await writeFile(path.join(dir, "node_modules", "dep-a", "package.json"), JSON.stringify({ main: "index.js" }));
    await writeFile(path.join(dir, "node_modules", "dep-a", "index.js"), "");
  }
  const packages = { "node_modules/@acme/big-mcp": {}, "node_modules/dep-a": {}, "node_modules/opt-b": { optional: true } };
  if (opts.lock ?? true) await writeFile(path.join(dir, "node_modules", ".package-lock.json"), JSON.stringify({ packages }));
  return dir;
}
const installs = (calls: string[][]) => calls.filter((c) => c.some((a) => a.startsWith("--package=")));
/** 다른 npm process가 concurrency.lock을 잡고 1 s(여기서는 50 ms)마다 갱신하는 상황. stop()으로 끝낸다. */
async function foreignLock(dir: string) {
  const lock = path.join(dir, "concurrency.lock");
  await mkdir(lock, { recursive: true });
  let t = Date.now();
  const timer = setInterval(() => void utimes(lock, new Date(), new Date((t += 1000))).catch(() => undefined), 50);
  return { stop: async () => (clearInterval(timer), rm(lock, { recursive: true, force: true })) };
}

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
    expect((await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner, { platform: "windows", windowsNpx: launcher }))).status).toBe("done");
    expect(npm.calls.every((c) => c[0] === launcher.node)).toBe(true);
    expect(npm.calls.flat().some((a) => /^cmd(\.exe)?$/iu.test(a) || a === "/c")).toBe(false);
    const none = fakeNpmSpawner({ cacheRoot: root });
    expect(await prepareNpxPackage(ARGS, scratch, ctx(none.spawner, { platform: "windows", windowsNpx: null }))).toMatchObject({ status: "failed", code: "LAUNCHER_NOT_FOUND" });
    expect(none.calls).toEqual([]);
  });

  it("빈 cache: 받고 파일 검사를 통과하면 표시를 남기고, 다음에는 다시 받지 않는다(재사용도 매번 파일 검사)", async () => {
    const root = await cache();
    const npm = fakeNpmSpawner({ cacheRoot: root });
    const first = await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner));
    expect(first).toMatchObject({ status: "done", excerpt: "npx cache: installed (file checks passed)" });
    expect(npm.calls).toEqual([["npm", "config", "get", "cache"], ["npx", ...ARGS]]);
    expect(JSON.parse(await readFile(path.join(entryDir(root), ".openhub-prepared"), "utf8"))).toMatchObject({ spec: SPEC, checks: "file-presence" });
    const second = await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner));
    expect(second).toMatchObject({ status: "done", excerpt: "npx cache: reused (file checks passed)" });
    expect(installs(npm.calls)).toHaveLength(1);
    expect(containsAbsolutePath(JSON.stringify([first, second]))).toBe(false);
    expect(JSON.stringify([first, second])).not.toMatch(/verified/iu);
  });

  it("OpenHub가 만들지 않은 완성 항목은 파일 검사를 통과하면 그대로 쓰고 지우거나 다시 받지 않는다", async () => {
    const root = await cache();
    const dir = await writeEntry(root);
    const npm = fakeNpmSpawner({ cacheRoot: root });
    expect(await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner))).toMatchObject({ status: "done", excerpt: "npx cache: reused (file checks passed)" });
    expect(installs(npm.calls)).toEqual([]);
    expect(existsSync(path.join(dir, "node_modules", "dep-a", "index.js"))).toBe(true);
  });

  it("이미 있던 불완전·손상 항목은 지우지 않고 실패하며 그 항목 하나의 수동 복구 방법을 알려 준다", async () => {
    for (const [label, opts] of [["완료 파일 없음", { lock: false }], ["lockfile의 의존성 없음", { dep: false }], ["bin 파일 없음", { bin: false }], ["버전 다름", { version: "3.0.4" }]] as const) {
      const root = await cache();
      const dir = await writeEntry(root, opts);
      const other = path.join(root, "_npx", "0123456789abcdef");
      await mkdir(other, { recursive: true });
      await writeFile(path.join(other, "keep"), "keep");
      const npm = fakeNpmSpawner({ cacheRoot: root });
      const r = await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner));
      expect(r, label).toMatchObject({ status: "failed", code: "NPX_CACHE_DAMAGED" });
      expect(r.excerpt, label).toContain("_npx/" + npxCacheKey(SPEC));
      expect(containsAbsolutePath(r.excerpt ?? ""), label).toBe(false);
      expect(installs(npm.calls), label).toEqual([]);
      expect(existsSync(path.join(dir, "package.json")), label).toBe(true);
      expect(await readFile(path.join(other, "keep"), "utf8"), label).toBe("keep");
    }
  });

  it("파일 검사: optional 의존성은 빼고, lockfile의 패키지·main·bin을 확인한다", async () => {
    const root = await cache();
    const dir = await writeEntry(root);
    expect(await inspectNpxEntry(dir, "@acme/big-mcp", "3.0.5")).toEqual({ state: "complete", problems: [] });
    await rm(path.join(dir, "node_modules", "dep-a", "index.js"));
    expect(await inspectNpxEntry(dir, "@acme/big-mcp", "3.0.5")).toEqual({ state: "incomplete", problems: ["node_modules/dep-a -> index.js"] });
    expect((await inspectNpxEntry(path.join(root, "_npx", "nope"), "@acme/big-mcp", "3.0.5")).state).toBe("absent");
    await mkdir(path.join(root, "_npx", "empty"), { recursive: true });
    expect((await inspectNpxEntry(path.join(root, "_npx", "empty"), "@acme/big-mcp", "3.0.5")).state).toBe("absent");
  });

  it("다른 npm process가 같은 항목의 lock을 갱신하는 동안 기다리고, 끝나면 그 결과를 검사해 재사용한다", async () => {
    const root = await cache();
    const dir = await writeEntry(root, { lock: false });
    const lock = await foreignLock(dir);
    const npm = fakeNpmSpawner({ cacheRoot: root });
    const pending = prepareNpxPackage(ARGS, scratch, ctx(npm.spawner, { busyWaitMs: 5_000 }));
    setTimeout(() => void (async () => {
      await writeFile(path.join(dir, "node_modules", ".package-lock.json"), JSON.stringify({ packages: { "node_modules/@acme/big-mcp": {}, "node_modules/dep-a": {} } }));
      await lock.stop();
    })(), 600);
    expect(await pending).toMatchObject({ status: "done", excerpt: "npx cache: reused (file checks passed)" });
    expect(installs(npm.calls)).toEqual([]);
  });

  it("다른 npm process가 계속 쓰고 있으면 제한 시간 뒤 BUSY로 끝나고 아무것도 바꾸지 않는다", async () => {
    const root = await cache();
    const dir = await writeEntry(root, { lock: false });
    const lock = await foreignLock(dir);
    try {
      const npm = fakeNpmSpawner({ cacheRoot: root });
      expect(await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner, { busyWaitMs: 400 }))).toMatchObject({ status: "failed", code: "NPX_CACHE_BUSY" });
      expect(installs(npm.calls)).toEqual([]);
      expect(existsSync(path.join(dir, "package.json"))).toBe(true);
    } finally {
      await lock.stop();
    }
  });

  it("실패·버전 불일치·불완전이면 이번에 만든 항목만 정리하고(빈 자리 유지) 다시 시도할 수 있다", async () => {
    for (const mode of ["fail", "wrong-version", "incomplete"] as const) {
      const root = await cache();
      const bad = fakeNpmSpawner({ cacheRoot: root, prepare: mode });
      const r = await prepareNpxPackage(ARGS, scratch, ctx(bad.spawner));
      expect(r.status, mode).toBe("failed");
      expect(r.code, mode).toBe(mode === "fail" ? "STEP_FAILED" : "NPX_PREPARE_INCOMPLETE");
      expect(r.excerpt, mode).toMatch(/정리했습니다|남은 npx cache 항목이 없습니다/u);
      expect(await readdir(entryDir(root)).catch(() => []), mode).toEqual([]);
      expect((await prepareNpxPackage(ARGS, scratch, ctx(fakeNpmSpawner({ cacheRoot: root }).spawner))).status, mode).toBe("done");
    }
  });

  it("timeout: tree 종료를 요청하고 종료를 확인하면 정리하며 다시 시도하면 완료된다", async () => {
    const root = await cache();
    const hang = fakeNpmSpawner({ cacheRoot: root, prepare: "hang" });
    const killTree = vi.fn(async () => true);
    const r = await prepareNpxPackage(ARGS, scratch, ctx(hang.spawner, { killTree, timeoutMs: 100 }));
    expect(r).toMatchObject({ status: "failed", code: "STEP_TIMEOUT" });
    expect(killTree).toHaveBeenCalledWith(4242, "linux");
    expect(r.excerpt).toContain("정리했습니다");
    expect(await readdir(entryDir(root))).toEqual([]);
    expect((await prepareNpxPackage(ARGS, scratch, ctx(fakeNpmSpawner({ cacheRoot: root }).spawner))).status).toBe("done");
  });

  it("timeout 뒤 종료를 확인하지 못하면 정해진 시간 안에 반환하되 cache를 지우지 않고 cleanup 미완료를 알린다", async () => {
    const root = await cache();
    const stuck = fakeNpmSpawner({ cacheRoot: root, prepare: "hang-unkillable" });
    const t0 = Date.now();
    const r = await prepareNpxPackage(ARGS, scratch, ctx(stuck.spawner, { killTree: async () => false, timeoutMs: 100, graceMs: 300 }));
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(r).toMatchObject({ status: "failed", code: "STEP_TIMEOUT_UNCONFIRMED" });
    expect(r.excerpt).toContain("cleanup 미완료");
    expect(existsSync(path.join(entryDir(root), "package.json"))).toBe(true);
  });

  it("이번 시도가 실패했어도 다른 npm process가 같은 항목 lock을 갱신 중이면 정리하지 않는다", async () => {
    const root = await cache();
    const dir = entryDir(root);
    let lock: Awaited<ReturnType<typeof foreignLock>> | undefined;
    const base = fakeNpmSpawner({ cacheRoot: root, prepare: "incomplete" });
    const spawner: ExecSpawner = (exe, args, o) => {
      const child = base.spawner(exe, args, o);
      if (args.some((a) => a.startsWith("--package="))) void foreignLock(dir).then((l) => (lock = l));
      return child;
    };
    try {
      const r = await prepareNpxPackage(ARGS, scratch, ctx(spawner));
      expect(r).toMatchObject({ status: "failed", code: "NPX_PREPARE_INCOMPLETE" });
      expect(r.excerpt).toContain("다른 npm process가 같은 npx cache 항목을 쓰고 있어 정리하지 않았습니다");
      expect(existsSync(path.join(dir, "package.json"))).toBe(true);
    } finally {
      await lock?.stop();
    }
  });

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

describe("npm 자식 process 환경(허용 목록)", () => {
  const source = {
    PATH: "/usr/bin", Path: "C:\\Windows", SystemRoot: "C:\\Windows", ComSpec: "C:\\Windows\\system32\\cmd.exe", TEMP: "/tmp", HOME: "/home/u", LOCALAPPDATA: "C:\\x",
    npm_config_registry: "https://registry.example", NPM_CONFIG_CACHE: "/c", HTTPS_PROXY: "http://proxy:8080", no_proxy: "localhost", NODE_EXTRA_CA_CERTS: "/ca.pem", NPM_TOKEN: "npm-fake", LC_ALL: "C",
    OPENAI_API_KEY: "sk-fake", ANTHROPIC_API_KEY: "x", GITHUB_TOKEN: "ghp-fake", GH_TOKEN: "x", AWS_SECRET_ACCESS_KEY: "x", AWS_ACCESS_KEY_ID: "x", AZURE_CLIENT_SECRET: "x",
    GOOGLE_APPLICATION_CREDENTIALS: "/k.json", NODE_OPTIONS: "--require /evil.js", MY_SECRET: "x", DATABASE_URI: "postgres://u:p@h/db", MDB_MCP_CONNECTION_STRING: "mongodb://u:p@h", KUBECONFIG: "/k",
    UNDEFINED_ONE: undefined,
  };

  it("npm 실행·인증·프록시·CA에 필요한 이름만 남기고 API key·token·클라우드 자격증명·NODE_OPTIONS·사용자 변수는 뺀다", () => {
    const env = npmChildEnv(source);
    expect(Object.keys(env).sort()).toEqual(
      ["HOME", "HTTPS_PROXY", "LC_ALL", "LOCALAPPDATA", "NODE_EXTRA_CA_CERTS", "NPM_CONFIG_CACHE", "NPM_TOKEN", "PATH", "Path", "ComSpec", "SystemRoot", "TEMP", "no_proxy", "npm_config_registry"].sort(),
    );
    for (const secret of ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GITHUB_TOKEN", "GH_TOKEN", "AWS_SECRET_ACCESS_KEY", "AWS_ACCESS_KEY_ID", "AZURE_CLIENT_SECRET", "GOOGLE_APPLICATION_CREDENTIALS", "NODE_OPTIONS", "MY_SECRET", "DATABASE_URI", "MDB_MCP_CONNECTION_STRING", "KUBECONFIG"]) {
      expect(env, secret).not.toHaveProperty(secret);
    }
  });

  it("Prepare는 넘겨받은 환경만 npm 두 명령에 쓰고, 넘기지 않으면 spawn 옵션에 env가 없다(하위 호환)", async () => {
    const root = await cache();
    const npm = fakeNpmSpawner({ cacheRoot: root });
    const childEnv = npmChildEnv(source);
    expect((await prepareNpxPackage(ARGS, scratch, ctx(npm.spawner, { childEnv }))).status).toBe("done");
    expect(npm.envs).toEqual([childEnv, childEnv]);
    const plain = fakeNpmSpawner({ cacheRoot: await cache() });
    await prepareNpxPackage(ARGS, scratch, ctx(plain.spawner));
    expect(plain.envs).toEqual([undefined, undefined]);
  });

  it("실제 spawn(nodeNpxSpawner)에서 자식 process는 허용 목록 환경만 본다(부모의 API key·token 상속 0)", async () => {
    const parent = { ...process.env, OPENAI_API_KEY: "sk-openhub-fake-parent", GITHUB_TOKEN: "ghp_openhub_fake_parent", NODE_OPTIONS: "--max-old-space-size=64" };
    const env = npmChildEnv(parent);
    const child = nodeNpxSpawner(process.execPath, ["-e", "process.stdout.write(JSON.stringify(Object.keys(process.env)))"], { shell: false, cwd: scratch, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], env });
    let out = "";
    child.stdout?.on("data", (d) => (out += d.toString()));
    await new Promise<void>((resolve) => child.on("close", () => resolve()));
    const seen = (JSON.parse(out) as string[]).map((k) => k.toUpperCase());
    for (const name of ["OPENAI_API_KEY", "GITHUB_TOKEN", "NODE_OPTIONS"]) expect(seen, name).not.toContain(name);
    expect(seen).toContain("PATH");
    const allowed = new Set(Object.keys(env).map((k) => k.toUpperCase()));
    // Windows에서는 libuv(make_program_env)가 필수 시스템 변수를 보충한다(값은 OS가 정한다). 그 밖의 이름은 허용 목록 안에 있어야 한다.
    const LIBUV_REQUIRED = /^(HOMEDRIVE|HOMEPATH|LOGONSERVER|PATH|SYSTEMDRIVE|SYSTEMROOT|TEMP|USERDOMAIN|USERNAME|USERPROFILE|WINDIR|=.*)$/u;
    const extra = seen.filter((k) => !allowed.has(k) && !(process.platform === "win32" && LIBUV_REQUIRED.test(k)));
    expect(extra).toEqual([]);
  });
});
