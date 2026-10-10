import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isPinnedNpmSpec, parseNpmSpec } from "../installer/command";
import type { RecommendPlatform } from "../recommendation/index";
import type { ExecChild, ExecSpawnOptions, StepOutcome } from "./executor";
import type { TreeKiller, WindowsNpxLauncher } from "./health";

/**
 * npx Prepare(v0.2.0, docs/specs/npx-prepare.md). 승인된 Plan의 npx 준비 단계만 실행한다.
 *
 * 왜: 큰 npx 패키지는 첫 실행 때 내려받기와 첫 파일 열기에 Health 시작 한도(20 s)보다 오래 걸린다. 그 사이에 설치가 끊기면
 * npm의 npx cache 항목(`<npm cache>/_npx/<key>`)이 불완전하게 남고 npm은 이것을 스스로 고치지 않는다.
 *
 * 무엇을 하나:
 * - 정확한 버전으로 고정된 spec(pkg@X.Y.Z)만 받는다. Client가 실행하는 `npx -y pkg@X.Y.Z …`와 같은 cache 항목을 채운다
 *   (npm npx cache key = spec 목록 sha512 앞 16자리). MCP 서버(패키지 bin)는 실행하지 않는다(`-- node --version`).
 *   단, npm은 설치 중 의존성의 install script를 실행할 수 있다(Client 첫 실행 때와 같다). Plan 고지가 이를 알린다.
 * - 그 key의 디렉터리 하나만 다룬다. 다른 cache 항목·npm content cache·전역 설정은 건드리지 않는다.
 * - 기존 항목은 매번 파일 검사(npm 완료 파일, 버전, lockfile의 각 패키지 package.json, main·bin 파일)를 한다.
 *   통과하면 재사용, 통과하지 못하면 지우지 않고 실패하며 그 항목 하나만 지우는 수동 복구 방법을 알려 준다.
 *   다른 npm process가 그 항목을 쓰는 중(npm concurrency.lock 갱신 중)이면 끝날 때까지 기다린다.
 * - 자동 정리는 "이번 시도가 새로 만든 항목 + 우리 process 종료 확인 + npm lock이 다른 process에 의해 갱신되지 않음"일 때만 한다.
 *   정리 뒤 빈 디렉터리를 다시 만들어, 기다리던 다른 npx가 그 자리에서 새로 설치할 수 있게 한다.
 * - 준비 전용 timeout. 시간이 지나면 process tree 종료를 요청하고 종료를 확인한다. 확인하지 못하면 정리하지 않고 그 사실을 알린다.
 *   어떤 경우에도 한도 + 유예 시간 안에 반환한다.
 * - shell을 쓰지 않는다. Windows는 node.exe + npm의 npx-cli.js·npm-cli.js로 실행한다(D-016: cmd 없음).
 * - npm 자식 process에는 호출 측이 넘긴 환경(npmChildEnv: 허용 목록)만 준다.
 * - 새로 받은 항목은 남은 시간 안에서 JS·JSON·native 파일을 한 번 읽어 둔다(실행하지 않음, 첫 실행 비용을 옮긴다).
 * - 결과에는 절대 경로·cache 위치를 남기지 않는다. 파일 검사는 존재 확인이며 암호학적 무결성 검증이 아니다.
 */

export const NPX_PREPARE_TIMEOUT_MS = 600_000;
export const NPX_CACHE_QUERY_TIMEOUT_MS = 30_000;
/** timeout 뒤 종료 확인을 기다리는 최대 시간. 이 시간이 지나면 종료를 확인하지 못한 채 반환한다. */
export const NPX_KILL_GRACE_MS = 10_000;
/** 다른 npm process가 같은 항목을 쓰는 동안 기다리는 최대 시간(남은 준비 시간을 넘지 않는다). */
export const NPX_BUSY_WAIT_MS = 120_000;
export const NPX_PREPARE_STEP_ID = "npx-prepare";
export const NPX_PREPARED_MARKER = ".openhub-prepared";
const NPM_COMPLETE_MARKER = path.join("node_modules", ".package-lock.json");
const NPM_LOCK = "concurrency.lock";
/** npm with-lock.js는 잡고 있는 동안 1 s마다 lock mtime을 갱신한다. 이 간격 동안 갱신되면 다른 process가 쓰는 중이다. */
const LOCK_PROBE_MS = 2_500;

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

// ---------------------------------------------------------------- npm 자식 process 환경(허용 목록)

const ENV_EXACT = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS",
  "USER", "USERNAME", "LOGNAME", "LANG", "LANGUAGE", "TERM", "SHELL", "TZ",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR",
  // 네트워크 경로(프록시·사내 CA). 프록시 URL에 계정이 들어 있을 수 있지만 npm이 내려받는 데 필요하다.
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
  // npm registry 인증(.npmrc의 ${NPM_TOKEN} 등). npm이 패키지를 받는 데 쓰는 값이다.
  "NPM_TOKEN", "NODE_AUTH_TOKEN",
] as const;
const ENV_PREFIX = [/^npm_config_/iu, /^LC_[A-Z_]+$/iu];
const EXACT = new Set<string>(ENV_EXACT);

/**
 * npm 자식 process에 넘길 환경(허용 목록). core는 process.env를 읽지 않으므로 호출 측(CLI·Desktop)이 원본을 넘긴다.
 * 넘기지 않는 예: OPENAI_API_KEY 등 API key, GITHUB_TOKEN·GH_TOKEN, AWS_·AZURE_·GOOGLE_APPLICATION_CREDENTIALS 등 클라우드 자격증명,
 * NODE_OPTIONS(코드 주입 경로), 그 밖에 목록에 없는 사용자 변수. Windows 환경변수 이름은 대소문자를 구분하지 않는다.
 */
export function npmChildEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (EXACT.has(name.toUpperCase()) || ENV_PREFIX.some((p) => p.test(name))) out[name] = value;
  }
  return out;
}

/**
 * npx Prepare 전용 spawn 옵션. 일반 준비 단계(executor)는 env를 다루지 않는다(AC-031-05). npm 자식 process만
 * 허용 목록 환경(npmChildEnv)을 받는다. env가 없으면 OS 기본 상속이다.
 */
export type NpxSpawnOptions = ExecSpawnOptions & { readonly env?: Record<string, string> };
export type NpxSpawner = (executable: string, args: readonly string[], options: NpxSpawnOptions) => ExecChild;

export const nodeNpxSpawner: NpxSpawner = (executable, args, options) =>
  spawn(executable, [...args], { shell: false, cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(options.env === undefined ? {} : { env: options.env }) });

// ---------------------------------------------------------------- 파일 접근

export interface NpxPrepareFs {
  lstat(p: string): Promise<{ isDirectory(): boolean; isSymbolicLink(): boolean }>;
  stat(p: string): Promise<{ mtimeMs: number }>;
  realpath(p: string): Promise<string>;
  readFile(p: string): Promise<string>;
  writeFile(p: string, data: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(p: string): Promise<void>;
  mkdir(p: string): Promise<void>;
}

export const nodeNpxPrepareFs: NpxPrepareFs = {
  lstat: (p) => lstat(p),
  stat: (p) => stat(p),
  realpath: (p) => realpath(p),
  readFile: (p) => readFile(p, "utf8"),
  writeFile: (p, d) => writeFile(p, d),
  rename: (a, b) => rename(a, b),
  rm: (p) => rm(p, { recursive: true, force: true }),
  mkdir: async (p) => void (await mkdir(p, { recursive: true })),
};

export interface NpxPrepareContext {
  platform: RecommendPlatform;
  /** Windows에서 필요(probe 단계에서 locateWindowsNpxLauncher로 찾는다). */
  windowsNpx: WindowsNpxLauncher | null;
  spawner: NpxSpawner;
  killTree?: TreeKiller;
  fs?: Partial<NpxPrepareFs>;
  /** 준비 timeout(기본 NPX_PREPARE_TIMEOUT_MS). Plan의 timeoutMs를 넘긴다. */
  timeoutMs?: number;
  /** npm 자식 process 환경. 보통 npmChildEnv(원본 환경). 생략하면 OS 기본 상속이다(테스트·하위 호환). */
  childEnv?: Record<string, string>;
  /** 새로 받은 항목의 파일을 미리 읽는다(기본 true). */
  warm?: boolean;
  /** 대기·유예 시간(테스트용으로 줄일 수 있다). */
  graceMs?: number;
  busyWaitMs?: number;
  lockProbeMs?: number;
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
  /** timeout이 아니었거나, timeout 뒤 우리 process가 끝난 것을 확인했다. */
  terminated: boolean;
  stdout: string;
  stderr: string;
}

const TAIL = 64 * 1024;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * argv 하나를 실행하고 출력을 모은다. timeout이면 tree 종료를 요청하고 자식의 종료(exit·close)를 기다린다.
 * 종료를 grace 안에 확인하지 못하면 terminated=false로 반환한다(그 경우 호출 측은 cache를 정리하지 않는다).
 */
function capture(argv: Argv, cwd: string, timeoutMs: number, ctx: NpxPrepareContext): Promise<Captured> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let exited = false;
    let child: ExecChild | undefined;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const detach = () => {
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
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      if (exited) return;
      exited = true;
      if (timedOut) finish({ status: "failed", code: "STEP_TIMEOUT", exitCode: code, signal: signal ?? "SIGKILL", terminated: true });
      else finish(code === 0 ? { status: "done", exitCode: 0, signal: null, terminated: true } : { status: "failed", code: "STEP_FAILED", exitCode: code, signal, terminated: true });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      grace = setTimeout(() => finish({ status: "failed", code: "STEP_TIMEOUT", exitCode: null, signal: null, terminated: false }), ctx.graceMs ?? NPX_KILL_GRACE_MS);
      const pid = child?.pid;
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
      child = ctx.spawner(argv.executable, argv.args, { shell: false, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"], ...(ctx.childEnv === undefined ? {} : { env: ctx.childEnv }) });
    } catch {
      finish({ status: "failed", code: "SPAWN_FAILED", exitCode: null, signal: null, terminated: true });
      return;
    }
    child.stdout?.on("data", (d) => (stdout = (stdout + d.toString()).slice(-TAIL)));
    child.stderr?.on("data", (d) => (stderr = (stderr + d.toString()).slice(-TAIL)));
    child.on("error", () => finish({ status: "failed", code: "SPAWN_FAILED", exitCode: null, signal: null, terminated: !timedOut }));
    child.on("exit", onExit);
    child.on("close", onExit);
  });
}

// ---------------------------------------------------------------- 항목 검사

export type NpxEntryState = "absent" | "complete" | "incomplete";
export interface NpxEntryInspection {
  state: NpxEntryState;
  /** incomplete일 때 첫 몇 개 사유(상대 경로·패키지 이름만). */
  problems: string[];
}

/**
 * 항목 파일 검사(존재 확인, 암호학적 검증 아님): npm 완료 파일, 요청 버전, lockfile에 적힌 모든(선택 의존성 제외) 패키지의
 * package.json, 각 패키지의 main·bin 파일. 패키지 안의 다른 파일이 빠진 경우는 잡지 못할 수 있다.
 */
export async function inspectNpxEntry(dir: string, name: string, version: string, fs: NpxPrepareFs = nodeNpxPrepareFs): Promise<NpxEntryInspection> {
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { state: "incomplete", problems: ["entry is not a directory"] };
  } catch {
    return { state: "absent", problems: [] };
  }
  // 비어 있는 디렉터리(정리 뒤 다시 만든 자리, npm이 막 만든 자리)는 없는 것과 같다.
  if ((await readdir(dir).catch(() => [] as string[])).length === 0) return { state: "absent", problems: [] };
  const exists = async (p: string) => {
    try {
      await fs.lstat(p);
      return true;
    } catch {
      return false;
    }
  };
  const problems: string[] = [];
  let lock: { packages?: Record<string, { link?: boolean; optional?: boolean }> };
  try {
    lock = JSON.parse(await fs.readFile(path.join(dir, NPM_COMPLETE_MARKER))) as typeof lock;
  } catch {
    return { state: "incomplete", problems: ["npm completion file missing"] };
  }
  try {
    const main = JSON.parse(await fs.readFile(path.join(dir, "node_modules", ...name.split("/"), "package.json"))) as { version?: unknown };
    if (main.version !== version) problems.push(name + " version " + String(main.version));
  } catch {
    problems.push(name + "/package.json");
  }
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith("node_modules/") || meta.link === true || meta.optional === true) continue;
    const pkgDir = path.join(dir, ...key.split("/"));
    let pj: { main?: unknown; bin?: unknown };
    try {
      pj = JSON.parse(await fs.readFile(path.join(pkgDir, "package.json"))) as typeof pj;
    } catch {
      problems.push(key + "/package.json");
      if (problems.length >= 5) break;
      continue;
    }
    const files = [typeof pj.main === "string" ? pj.main : null, ...(typeof pj.bin === "string" ? [pj.bin] : pj.bin !== null && typeof pj.bin === "object" ? Object.values(pj.bin) : [])]
      .filter((f): f is string => typeof f === "string" && f !== "" && !path.isAbsolute(f) && !f.split(/[\\/]/u).includes(".."));
    for (const f of new Set(files)) {
      const p = path.join(pkgDir, f);
      if (!(await exists(p)) && !(await exists(p + ".js")) && !(await exists(path.join(p, "index.js")))) problems.push(key + " -> " + f);
    }
    if (problems.length >= 5) break;
  }
  return { state: problems.length === 0 ? "complete" : "incomplete", problems: problems.slice(0, 5) };
}

/** npm concurrency.lock이 다른 process에 의해 갱신되는 중인지(probeMs 동안 mtime이 바뀌는지) 본다. */
async function npmLockActive(dir: string, fs: NpxPrepareFs, probeMs: number): Promise<boolean> {
  const mtime = async () => (await fs.stat(path.join(dir, NPM_LOCK)).catch(() => null))?.mtimeMs ?? null;
  const first = await mtime();
  if (first === null) return false;
  await sleep(probeMs);
  const second = await mtime();
  return second !== null && second !== first;
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

const lastLines = (text: string) => text.split(/\r?\n/u).filter((l) => l.trim() !== "").slice(-6).join("\n").slice(-900);

/** 수동 복구 안내(절대 경로 없이). */
export function npxManualRepairNotice(spec: string): string {
  return "수동 복구: 이 패키지를 쓰는 Client를 모두 닫고, `npm config get cache`로 npm cache 위치를 확인한 뒤 그 안의 _npx/" + npxCacheKey(spec) + " 디렉터리 하나만 지우고 다시 시도하세요(" + spec + "). 다른 _npx 항목이나 npm cache 전체는 지우지 마세요.";
}

/**
 * 준비 단계 하나를 실행한다. step 검증(고정 인자·정확한 버전)은 여기서 다시 한다.
 * cwd는 executor가 만든 격리 임시 디렉터리다.
 */
export async function prepareNpxPackage(stepArgs: readonly string[], cwd: string, ctx: NpxPrepareContext): Promise<StepOutcome> {
  const started = Date.now();
  const budget = ctx.timeoutMs ?? NPX_PREPARE_TIMEOUT_MS;
  const remaining = () => Math.max(1, started + budget - Date.now());
  const spec = parseNpxPrepareArgs(stepArgs);
  const parsed = spec === null ? null : parseNpmSpec(spec);
  if (spec === null || parsed === null || parsed.version === null) return outcome("failed", { code: "NPX_PREPARE_REJECTED", excerpt: "준비 단계는 정확한 버전의 npm 패키지(pkg@X.Y.Z)만 받습니다" });
  const { name, version } = { name: parsed.name, version: parsed.version };
  const fs: NpxPrepareFs = { ...nodeNpxPrepareFs, ...(ctx.fs ?? {}) };
  const probeMs = ctx.lockProbeMs ?? LOCK_PROBE_MS;

  // 1. npm cache 위치(npm이 사용자 설정·환경을 반영해 알려 준다). 결과에는 남기지 않는다.
  const configArgv = npmToolArgv("npm", ["config", "get", "cache"], ctx.platform, ctx.windowsNpx);
  const installArgv = npmToolArgv("npx", stepArgs, ctx.platform, ctx.windowsNpx);
  if (configArgv === null || installArgv === null) return outcome("failed", { code: "LAUNCHER_NOT_FOUND", excerpt: "npx 실행 경로(node.exe·npx-cli.js)를 찾지 못했습니다" });
  const config = await capture(configArgv, cwd, Math.min(NPX_CACHE_QUERY_TIMEOUT_MS, remaining()), ctx);
  const cacheRoot = config.stdout.trim();
  if (config.status !== "done" || cacheRoot === "" || cacheRoot.includes("\n") || !path.isAbsolute(cacheRoot)) {
    return outcome("failed", { code: "NPX_CACHE_UNKNOWN", excerpt: "npm cache 위치를 확인하지 못했습니다" });
  }
  const npxRoot = path.join(cacheRoot, "_npx");
  const dir = path.join(npxRoot, npxCacheKey(spec));
  // 항목이 symlink·junction이거나 _npx 밖을 가리키면 거부한다.
  try {
    const st = await fs.lstat(dir).catch(() => null);
    if (st !== null) {
      if (st.isSymbolicLink()) return outcome("failed", { code: "NPX_CACHE_REJECTED", excerpt: "npx cache 항목이 symlink·junction입니다" });
      if (path.dirname(await fs.realpath(dir)) !== (await fs.realpath(npxRoot))) return outcome("failed", { code: "NPX_CACHE_REJECTED", excerpt: "npx cache 항목이 cache 밖을 가리킵니다" });
    }
  } catch {
    return outcome("failed", { code: "NPX_CACHE_REJECTED", excerpt: "npx cache 항목 위치를 확인하지 못했습니다" });
  }

  // 2. 기존 항목: 다른 npm process가 쓰는 중이면 기다린 뒤 검사한다. 검사를 통과하지 못한 기존 항목은 지우지 않는다.
  const busyUntil = Date.now() + Math.min(ctx.busyWaitMs ?? NPX_BUSY_WAIT_MS, remaining());
  while (await npmLockActive(dir, fs, probeMs)) {
    if (Date.now() > busyUntil) return outcome("failed", { code: "NPX_CACHE_BUSY", excerpt: "다른 npm process가 이 패키지의 npx cache 항목을 쓰고 있습니다. 끝난 뒤 다시 시도하세요" });
  }
  const before = await inspectNpxEntry(dir, name, version, fs);
  if (before.state === "complete") return outcome("done", { excerpt: "npx cache: reused (file checks passed)" });
  if (before.state === "incomplete") {
    return outcome("failed", {
      code: "NPX_CACHE_DAMAGED",
      excerpt: "이미 있는 npx cache 항목이 불완전하거나 손상됐습니다(" + before.problems.slice(0, 3).join(", ") + "). OpenHub가 만들지 않은 항목은 자동으로 지우지 않습니다. " + npxManualRepairNotice(spec),
    });
  }

  // 3. 내려받기(전용 timeout).
  const run = await capture(installArgv, cwd, remaining(), ctx);
  const suffix = ctx.suffix ?? (() => Date.now().toString(36) + Math.random().toString(36).slice(2, 8));
  /** 이번 시도가 만든 항목만 정리한다: 우리 process 종료 확인 + npm lock이 다른 process에 의해 갱신되지 않음. */
  const cleanupOwn = async (terminated: boolean): Promise<"cleaned" | "absent" | "kept-process-alive" | "kept-in-use" | "kept-rename-failed"> => {
    if ((await inspectNpxEntry(dir, name, version, fs)).state === "absent") return "absent";
    if (!terminated) return "kept-process-alive";
    if (await npmLockActive(dir, fs, probeMs)) return "kept-in-use";
    const aside = dir + ".openhub-stale-" + suffix();
    try {
      await fs.rename(dir, aside);
    } catch {
      return "kept-rename-failed";
    }
    // 같은 자리에 빈 디렉터리를 만들어 두면, lock을 기다리던 다른 npx가 그 자리에서 새로 설치할 수 있다.
    await fs.mkdir(dir).catch(() => undefined);
    await fs.rm(aside).catch(() => undefined);
    return "cleaned";
  };
  const cleanupText: Record<Awaited<ReturnType<typeof cleanupOwn>>, string> = {
    cleaned: "이번 시도가 만든 불완전한 npx cache 항목을 정리했습니다. 다시 시도할 수 있습니다.",
    absent: "남은 npx cache 항목이 없습니다. 다시 시도할 수 있습니다.",
    "kept-process-alive": "npm process 종료를 확인하지 못해 npx cache 항목을 정리하지 않았습니다(cleanup 미완료). 잠시 뒤 다시 시도하거나, " + "process가 끝난 것을 확인한 뒤 수동으로 정리하세요. " + npxManualRepairNotice(spec),
    "kept-in-use": "다른 npm process가 같은 npx cache 항목을 쓰고 있어 정리하지 않았습니다(cleanup 미완료). 그 process가 끝난 뒤 다시 시도하세요.",
    "kept-rename-failed": "npx cache 항목을 옮기지 못해 정리하지 않았습니다(사용 중일 수 있음, cleanup 미완료). " + npxManualRepairNotice(spec),
  };
  if (run.status !== "done") {
    const cleanup = await cleanupOwn(run.terminated);
    const tail = lastLines(run.stderr || run.stdout);
    return outcome("failed", {
      code: run.terminated ? (run.code ?? "STEP_FAILED") : "STEP_TIMEOUT_UNCONFIRMED",
      exitCode: run.exitCode,
      signal: run.signal,
      excerpt: cleanupText[cleanup] + (tail === "" ? "" : "\n" + tail),
    });
  }

  // 4. 파일 검사. 통과하면 표시를 남기고(검사 시각·spec 기록, 검증 증명이 아님) 파일을 미리 읽는다.
  const after = await inspectNpxEntry(dir, name, version, fs);
  if (after.state !== "complete") {
    const cleanup = await cleanupOwn(true);
    return outcome("failed", { code: "NPX_PREPARE_INCOMPLETE", excerpt: "내려받은 항목이 파일 검사를 통과하지 못했습니다(" + after.problems.slice(0, 3).join(", ") + "). " + cleanupText[cleanup] });
  }
  await fs.writeFile(path.join(dir, NPX_PREPARED_MARKER), JSON.stringify({ schemaVersion: 1, spec, preparedBy: "openhub", checks: "file-presence" }) + "\n").catch(() => undefined);
  const warmed = ctx.warm === false ? null : await warmEntry(dir, started + budget);
  return outcome("done", { exitCode: 0, signal: null, excerpt: "npx cache: installed (file checks passed)" + (warmed === false ? " (files partly pre-read)" : "") });
}
