import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPinnedNpmSpec, parseNpmSpec } from "../installer/command";
import type { RecommendPlatform } from "../recommendation/index";
import type { ExecChild, ExecSpawner, StepOutcome } from "./executor";
import type { TreeKiller, WindowsNpxLauncher } from "./health";

/**
 * npx Prepare(v0.2.0, docs/specs/npx-prepare.md). 승인된 Plan의 npx 준비 단계만 실행한다.
 *
 * 왜: 큰 npx 패키지는 첫 실행 때 내려받기에 Health 시작 한도(20 s)보다 오래 걸린다. Health가 그 설치를 끊으면 npm의
 * npx cache 항목(`<npm cache>/_npx/<key>`)이 불완전하게 남고, npm은 이것을 스스로 고치지 않는다(이후 실행 모두 실패).
 *
 * 무엇을 하나:
 * - 정확한 버전으로 고정된 spec(pkg@X.Y.Z)만 받는다. Client가 실행하는 `npx -y pkg@X.Y.Z …`와 같은 cache 항목을 채운다
 *   (npm의 npx cache key = 패키지 spec 목록의 sha512 앞 16자리). MCP 서버(패키지 bin)는 실행하지 않는다(`-- node --version`).
 *   단, npm은 설치 중 의존성의 install script를 실행할 수 있다(Client 첫 실행 때와 같다). Plan 고지가 이를 알린다.
 * - 그 key의 디렉터리 하나만 다룬다. 다른 cache 항목·npm 전역 cache는 건드리지 않는다.
 * - OpenHub가 완성·검증한 항목(`.openhub-prepared` 표시 + npm 완료 표시 + 버전 일치)은 다시 받지 않는다.
 *   그 밖의 기존 항목(불완전하거나 출처를 모르는 항목)은 먼저 옆 이름으로 옮긴 뒤 지우고 새로 받는다. 옮길 수 없으면(사용 중)
 *   완료 표시와 버전이 맞는 항목은 그대로 쓰고, 아니면 아무것도 바꾸지 않고 실패한다.
 * - 준비 전용 timeout(10분). 시간이 지나면 process tree를 끝내고 이번에 생긴 불완전 항목을 정리한다(다음 시도가 깨끗하다).
 * - 새로 받은 항목은 남은 준비 시간 안에서 JS·JSON·native 파일을 한 번 읽어 둔다(실행하지 않음). 새 파일을 처음 열 때의 비용
 *   (Windows 실시간 검사 등)이 첫 실행(Health 20 s, Client 시작)에 얹히지 않게 하기 위해서다. 실측: 10,656 파일, 첫 실행 26-80 s → 3.7 s.
 * - shell을 쓰지 않는다. Windows는 node.exe + npm의 npx-cli.js·npm-cli.js로 실행한다(D-016: cmd 없음).
 * - 결과에는 절대 경로·cache 위치를 남기지 않는다.
 */

export const NPX_PREPARE_TIMEOUT_MS = 600_000;
export const NPX_CACHE_QUERY_TIMEOUT_MS = 30_000;
export const NPX_PREPARE_STEP_ID = "npx-prepare";
export const NPX_PREPARED_MARKER = ".openhub-prepared";
const NPM_COMPLETE_MARKER = path.join("node_modules", ".package-lock.json");

/** npm(libnpmexec)의 npx cache key: spec 목록을 정렬해 줄바꿈으로 이은 sha512 hex 앞 16자리. */
export function npxCacheKey(spec: string): string {
  return createHash("sha512").update([spec].sort((a, b) => a.localeCompare(b, "en")).join("\n")).digest("hex").slice(0, 16);
}

/** 준비 단계 인자(고정 형식). 패키지를 npx cache에 받고 패키지 bin 대신 `node --version`만 실행한다. */
export function npxPrepareArgs(spec: string): string[] {
  return ["--yes", "--package=" + spec, "--", "node", "--version"];
}

/** 준비 단계 인자가 고정 형식이고 spec이 정확한 버전이면 spec을, 아니면 null을 돌려준다. */
export function parseNpxPrepareArgs(args: readonly string[]): string | null {
  if (args.length !== 5 || args[0] !== "--yes" || args[2] !== "--" || args[3] !== "node" || args[4] !== "--version") return null;
  const flag = args[1]!;
  if (!flag.startsWith("--package=")) return null;
  const spec = flag.slice("--package=".length);
  return isPinnedNpmSpec(spec) ? spec : null;
}

export interface NpxPrepareFs {
  lstat(p: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  realpath(p: string): Promise<string>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string): Promise<void>;
}

export const nodeNpxPrepareFs: NpxPrepareFs = {
  lstat: (p) => lstat(p),
  realpath: (p) => realpath(p),
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, d) => writeFile(p, d),
  rename: (a, b) => rename(a, b),
  rm: (p) => rm(p, { recursive: true, force: true }),
};

export interface NpxPrepareContext {
  platform: RecommendPlatform;
  /** Windows에서 필요(probe 단계에서 locateWindowsNpxLauncher로 찾는다). */
  windowsNpx: WindowsNpxLauncher | null;
  spawner: ExecSpawner;
  killTree?: TreeKiller;
  fs?: Partial<NpxPrepareFs>;
  /** 준비 timeout(기본 NPX_PREPARE_TIMEOUT_MS). Plan의 timeoutMs를 넘긴다. */
  timeoutMs?: number;
  /** 새로 받은 항목의 파일을 미리 읽는다(기본 true). */
  warm?: boolean;
  /** 임시 디렉터리 이름 접미사(테스트용). */
  suffix?: () => string;
}

type Argv = { executable: string; args: string[] };

/** backend 명령("npx"·"npm")을 플랫폼별 실제 argv로 바꾼다. Windows는 cmd 없이 node.exe + *-cli.js다. */
export function npmToolArgv(tool: "npx" | "npm", args: readonly string[], platform: RecommendPlatform, launcher: WindowsNpxLauncher | null): Argv | null {
  if (platform !== "windows") return { executable: tool, args: [...args] };
  if (launcher === null) return null;
  const cli = tool === "npx" ? launcher.npxCli : path.win32.join(path.win32.dirname(launcher.npxCli), "npm-cli.js");
  return { executable: launcher.node, args: [cli, ...args] };
}

interface Captured {
  status: "done" | "failed";
  code?: string;
  exitCode: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

const TAIL = 64 * 1024;
/** timeout 뒤 tree 종료가 끝나지 않아도 이 시간 뒤에는 반드시 실패로 끝낸다. */
export const NPX_KILL_GRACE_MS = 10_000;
function capture(argv: Argv, cwd: string, timeoutMs: number, ctx: NpxPrepareContext): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let child: ExecChild | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const detach = () => {
      // 손자 process가 pipe를 잡고 있어도 OpenHub process가 기다리지 않게 stream을 닫는다.
      for (const s of [child?.stdout, child?.stderr]) (s as { destroy?: () => void } | null | undefined)?.destroy?.();
    };
    const finish = (c: Omit<Captured, "stdout" | "stderr">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      if (timedOut) detach();
      resolve({ ...c, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      const pid = child?.pid;
      // tree 종료 결과와 무관하게 grace 뒤에는 끝낸다(close가 오지 않거나 tree 종료가 멈춰도).
      grace = setTimeout(() => finish({ status: "failed", code: "STEP_TIMEOUT", exitCode: null, signal: "SIGKILL" }), NPX_KILL_GRACE_MS);
      const tree = pid !== undefined && ctx.killTree !== undefined ? ctx.killTree(pid, ctx.platform).catch(() => false) : Promise.resolve(false);
      void tree.finally(() => {
        try {
          child?.kill("SIGKILL");
        } catch {
          // 이미 끝났다.
        }
      });
    }, timeoutMs);
    try {
      child = ctx.spawner(argv.executable, argv.args, { shell: false, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ status: "failed", code: "SPAWN_FAILED", exitCode: null, signal: null });
      return;
    }
    child.stdout?.on("data", (d) => (stdout = (stdout + d.toString()).slice(-TAIL)));
    child.stderr?.on("data", (d) => (stderr = (stderr + d.toString()).slice(-TAIL)));
    child.on("error", () => finish({ status: "failed", code: "SPAWN_FAILED", exitCode: null, signal: null }));
    child.on("close", (code, signal) => {
      if (timedOut) finish({ status: "failed", code: "STEP_TIMEOUT", exitCode: code, signal: signal ?? "SIGKILL" });
      else finish(code === 0 ? { status: "done", exitCode: 0, signal: null } : { status: "failed", code: "STEP_FAILED", exitCode: code, signal });
    });
  });
}

type EntryState = "absent" | "verified" | "complete-unverified" | "incomplete";

async function entryState(dir: string, name: string, version: string, spec: string, fs: NpxPrepareFs): Promise<EntryState> {
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return "incomplete";
  } catch {
    return "absent";
  }
  const exists = async (p: string) => {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  };
  let installedVersion: unknown;
  try {
    installedVersion = (JSON.parse(await fs.readFile(path.join(dir, "node_modules", ...name.split("/"), "package.json"))) as { version?: unknown }).version;
  } catch {
    installedVersion = undefined;
  }
  const complete = installedVersion === version && (await exists(path.join(dir, NPM_COMPLETE_MARKER)));
  if (!complete) return "incomplete";
  try {
    const marker = JSON.parse(await fs.readFile(path.join(dir, NPX_PREPARED_MARKER))) as { schemaVersion?: unknown; spec?: unknown };
    if (marker.schemaVersion === 1 && marker.spec === spec) return "verified";
  } catch {
    // 표시가 없으면 출처를 모르는 항목이다.
  }
  return "complete-unverified";
}

const outcome = (status: StepOutcome["status"], extra: Partial<StepOutcome> = {}): StepOutcome => ({ id: NPX_PREPARE_STEP_ID, status, ...extra });

const WARM_FILE = /\.(?:c|m)?js$|\.json$|\.node$/u;
/** 항목 안의 파일을 deadline까지 순서대로 한 번 읽는다(symlink는 따라가지 않는다). 끝까지 읽었으면 true. */
async function warmEntry(dir: string, deadline: number): Promise<boolean> {
  const stack = [dir];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (Date.now() > deadline) return false;
      const p = path.join(current, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && WARM_FILE.test(e.name)) await readFile(p).catch(() => undefined);
    }
  }
  return true;
}

/** 마지막 몇 줄만, 절대 경로·token은 가린다(executor와 같은 규칙을 호출 측이 다시 적용한다). */
const lastLines = (text: string) => text.split(/\r?\n/u).filter((l) => l.trim() !== "").slice(-6).join("\n").slice(-1000);

/**
 * 준비 단계 하나를 실행한다. step 검증(고정 인자·정확한 버전)은 여기서 다시 한다.
 * cwd는 executor가 만든 격리 임시 디렉터리다.
 */
export async function prepareNpxPackage(stepArgs: readonly string[], cwd: string, ctx: NpxPrepareContext): Promise<StepOutcome> {
  const started = Date.now();
  const budget = ctx.timeoutMs ?? NPX_PREPARE_TIMEOUT_MS;
  const spec = parseNpxPrepareArgs(stepArgs);
  const parsed = spec === null ? null : parseNpmSpec(spec);
  if (spec === null || parsed === null || parsed.version === null) return outcome("failed", { code: "NPX_PREPARE_REJECTED", excerpt: "준비 단계는 정확한 버전의 npm 패키지(pkg@X.Y.Z)만 받습니다" });
  const fs: NpxPrepareFs = { ...nodeNpxPrepareFs, ...(ctx.fs ?? {}) };

  // 1. npm cache 위치(npm이 사용자 설정·환경을 반영해 알려 준다). 결과에는 남기지 않는다.
  const configArgv = npmToolArgv("npm", ["config", "get", "cache"], ctx.platform, ctx.windowsNpx);
  const installArgv = npmToolArgv("npx", stepArgs, ctx.platform, ctx.windowsNpx);
  if (configArgv === null || installArgv === null) return outcome("failed", { code: "LAUNCHER_NOT_FOUND", excerpt: "npx 실행 경로(node.exe·npx-cli.js)를 찾지 못했습니다" });
  const config = await capture(configArgv, cwd, NPX_CACHE_QUERY_TIMEOUT_MS, ctx);
  const cacheRoot = config.stdout.trim();
  // cache 위치는 이 기계(OpenHub가 실행되는 호스트)의 경로다.
  if (config.status !== "done" || cacheRoot === "" || cacheRoot.includes("\n") || !path.isAbsolute(cacheRoot)) {
    return outcome("failed", { code: "NPX_CACHE_UNKNOWN", excerpt: "npm cache 위치를 확인하지 못했습니다" });
  }
  const npxRoot = path.join(cacheRoot, "_npx");
  const dir = path.join(npxRoot, npxCacheKey(spec));
  // npx root가 있으면 그 안에 있는 항목만 다룬다(symlink·junction으로 밖을 가리키면 거부).
  try {
    const realRoot = await fs.realpath(npxRoot);
    const st = await fs.lstat(dir).catch(() => null);
    if (st !== null) {
      if (st.isSymbolicLink()) return outcome("failed", { code: "NPX_CACHE_REJECTED", excerpt: "npx cache 항목이 symlink·junction입니다" });
      const realDir = await fs.realpath(dir);
      if (path.dirname(realDir) !== realRoot) return outcome("failed", { code: "NPX_CACHE_REJECTED", excerpt: "npx cache 항목이 cache 밖을 가리킵니다" });
    }
  } catch {
    // _npx가 아직 없으면 npm이 만든다.
  }

  const suffix = ctx.suffix ?? (() => Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  /** 항목을 옆 이름으로 옮긴 뒤 지운다. 옮기기가 실패하면(사용 중 등) 아무것도 지우지 않는다. */
  const discard = async (): Promise<boolean> => {
    const aside = dir + ".openhub-stale-" + suffix();
    try {
      await fs.rename(dir, aside);
    } catch {
      return false;
    }
    await fs.rm(aside).catch(() => undefined);
    return true;
  };

  // 2. 기존 항목 확인.
  const before = await entryState(dir, parsed.name, parsed.version, spec, fs);
  if (before === "verified") return outcome("done", { excerpt: "npx cache: reused (verified by OpenHub)" });
  let repaired = false;
  if (before !== "absent") {
    if (!(await discard())) {
      if (before === "complete-unverified") return outcome("done", { excerpt: "npx cache: reused (in use, not re-downloaded)" });
      return outcome("failed", { code: "NPX_CACHE_IN_USE", excerpt: "불완전한 npx cache 항목을 다른 프로세스가 쓰고 있어 정리하지 못했습니다. 이 도구를 쓰는 Client를 닫고 다시 시도하세요" });
    }
    repaired = before === "incomplete";
  }

  // 3. 내려받기(전용 timeout). 실패·시간 초과면 이번에 생긴 불완전 항목을 정리한다.
  const run = await capture(installArgv, cwd, Math.max(1, started + budget - Date.now()), ctx);
  if (run.status !== "done") {
    const cleaned = (await entryState(dir, parsed.name, parsed.version, spec, fs)) === "absent" ? true : await discard();
    const tail = lastLines(run.stderr || run.stdout);
    return outcome("failed", {
      code: run.code ?? "STEP_FAILED",
      exitCode: run.exitCode,
      signal: run.signal,
      excerpt: (cleaned ? "불완전한 npx cache 항목을 정리했습니다. 다시 시도할 수 있습니다." : "불완전한 npx cache 항목을 정리하지 못했습니다.") + (tail === "" ? "" : "\n" + tail),
    });
  }

  // 4. 검증: npm 완료 표시와 버전. 맞으면 OpenHub 표시를 남긴다.
  const after = await entryState(dir, parsed.name, parsed.version, spec, fs);
  if (after === "incomplete" || after === "absent") {
    await discard();
    return outcome("failed", { code: "NPX_PREPARE_INCOMPLETE", excerpt: "내려받은 패키지가 요청한 버전과 다르거나 설치가 완료되지 않았습니다" });
  }
  try {
    await fs.writeFile(path.join(dir, NPX_PREPARED_MARKER), JSON.stringify({ schemaVersion: 1, spec }) + "\n");
  } catch {
    return outcome("done", { exitCode: 0, signal: null, excerpt: "npx cache: installed (OpenHub 표시를 남기지 못했습니다)" });
  }
  const base = repaired ? "npx cache: repaired and installed" : "npx cache: installed";
  // 사전 읽기는 실패 사유가 아니다. 시간이 모자라면 일부만 읽고 표시한다.
  const warmed = ctx.warm === false ? null : await warmEntry(dir, started + budget);
  return outcome("done", { exitCode: 0, signal: null, excerpt: base + (warmed === false ? " (files partly pre-read)" : "") });
}
