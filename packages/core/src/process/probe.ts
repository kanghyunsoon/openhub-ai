import { spawn } from "node:child_process";
import path from "node:path";
import { defaultHostEnvironment, type HostFs } from "../analyzer/host-probe";
import type { RecommendContext, RecommendPlatform } from "../recommendation/index";
import type { ProbeSnapshot } from "../installer/plan";

/**
 * Runtime / Backend Probe(TASK-029, D-011이 D-003을 제한적으로 보완).
 * - allowlist node·npx·uvx·docker만 다룬다. 그 밖의 이름은 spawn 없이 거부한다.
 * - 실제 실행 파일만 고정 인자 ["--version"], shell:false로 실행한다. timeout 3초, stdout 4KB.
 * - Windows에서 첫 번째로 찾은 파일이 .exe·.com이 아니면(.cmd·.bat·.ps1 shim 등) 실행하지 않는다.
 *   available은 PATH 존재로만 판단하고 version은 npx일 때 같은 디렉터리의 npm package.json에서만 읽는다.
 * - 결과는 { name, available, version, status }뿐이다. 실행 파일 경로·PATH 원문은 결과에 남지 않는다.
 * - python은 probe하지 않는다. OpenHub 자신의 Node(Electron 포함)를 사용자 런타임으로 쓰지 않는다.
 * - 이 모듈은 executor를 import하지 않는다(executor도 이 모듈을 import하지 않는다).
 * - 프로세스를 실행하는 코드는 src/process/에만 둔다. src/installer/는 계획·승인·설정만 다룬다(M1 AC-005-04 유지).
 */

export const PROBE_ALLOWLIST = ["node", "npx", "uvx", "docker"] as const;
export type ProbeName = (typeof PROBE_ALLOWLIST)[number];
export const PROBE_ARGS = ["--version"] as const;
export const PROBE_TIMEOUT_MS = 3000;
export const PROBE_MAX_STDOUT_BYTES = 4096;
const REAL_EXECUTABLE_EXTS = [".exe", ".com"];
const SHIM_EXTS = [".cmd", ".bat", ".ps1"];

export interface ProbeSpawnOptions {
  readonly shell: false;
  readonly windowsHide: true;
  readonly signal: AbortSignal;
  readonly maxStdoutBytes: number;
}
export interface ProbeSpawnResult {
  exitCode: number | null;
  stdout: string;
}
/** 실행 파일 하나를 고정 인자로 실행한다. file은 PATH에서 찾은 실제 실행 파일이며 결과에 남기지 않는다. */
export type ProbeSpawner = (file: string, args: readonly string[], options: ProbeSpawnOptions) => Promise<ProbeSpawnResult>;

export interface ProbeEnvironment {
  pathEnv: string;
  pathExt: string;
  platform: NodeJS.Platform;
  fs: HostFs;
  spawner: ProbeSpawner;
  timeoutMs: number;
}

/** child_process.spawn 기반 기본 spawner. shell:false, env 옵션 없음, stdout 상한. */
export const nodeProbeSpawner: ProbeSpawner = (file, args, options) =>
  new Promise((resolve) => {
    let stdout = "";
    let bytes = 0;
    const child = spawn(file, [...args], { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "ignore"], signal: options.signal });
    child.stdout?.on("data", (chunk: Buffer) => {
      if (bytes >= options.maxStdoutBytes) return;
      const slice = chunk.subarray(0, options.maxStdoutBytes - bytes);
      bytes += slice.length;
      stdout += slice.toString("utf8");
    });
    child.on("error", () => resolve({ exitCode: null, stdout }));
    child.on("close", (code) => resolve({ exitCode: code, stdout }));
  });

export function defaultProbeEnvironment(): ProbeEnvironment {
  const host = defaultHostEnvironment();
  return { pathEnv: host.pathEnv, pathExt: host.pathExt, platform: host.platform, fs: host.fs, spawner: nodeProbeSpawner, timeoutMs: PROBE_TIMEOUT_MS };
}

export function isProbeName(name: string): name is ProbeName {
  return (PROBE_ALLOWLIST as readonly string[]).includes(name);
}

interface Located {
  file: string;
  kind: "executable" | "shim";
}

async function isFile(fs: HostFs, file: string): Promise<boolean> {
  try {
    return (await fs.stat(file)).isFile();
  } catch {
    return false;
  }
}

/** PATH에서 이름을 찾는다. 존재 여부만 확인하며 아무것도 실행하지 않는다. */
async function locate(name: ProbeName, env: ProbeEnvironment): Promise<Located | undefined> {
  const windows = env.platform === "win32";
  // 실행 중인 OS가 아니라 probe 대상 플랫폼의 경로 규칙을 쓴다(테스트·CI에서 win32 PATH를 Linux에서 해석해도 같다).
  const p = windows ? path.win32 : path.posix;
  const dirs = env.pathEnv.split(windows ? ";" : ":").filter((d) => d.trim() !== "" && p.isAbsolute(d.trim()));
  const pathExts = env.pathExt.split(";").map((e) => e.trim().toLowerCase()).filter((e) => e.startsWith("."));
  const exts = windows ? [...new Set([...pathExts, ...SHIM_EXTS])] : [""];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = p.join(dir.trim(), name + ext);
      if (!(await isFile(env.fs, file))) continue;
      const kind = !windows || REAL_EXECUTABLE_EXTS.includes(ext) ? "executable" : "shim";
      return { file, kind };
    }
  }
  return undefined;
}

const VERSION_PATTERN = /(\d+)\.(\d+)\.(\d+)/u;
export function parseProbeVersion(stdout: string): string | null {
  const match = VERSION_PATTERN.exec(stdout.slice(0, PROBE_MAX_STDOUT_BYTES));
  return match === null ? null : match[1] + "." + match[2] + "." + match[3];
}

/** shim은 실행하지 않는다. npx shim이면 같은 디렉터리(node 옆) npm package.json의 version만 읽는다. */
async function shimVersion(name: ProbeName, located: Located, env: ProbeEnvironment): Promise<string | null> {
  if (name !== "npx") return null;
  const p = env.platform === "win32" ? path.win32 : path.posix;
  try {
    const doc: unknown = JSON.parse(await env.fs.readFile(p.join(p.dirname(located.file), "node_modules", "npm", "package.json")));
    const version = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>)["version"] : undefined;
    return typeof version === "string" ? parseProbeVersion(version) : null;
  } catch {
    return null;
  }
}

export type ProbeOutcome = { ok: true; snapshot: ProbeSnapshot } | { ok: false; code: "PROBE_NOT_ALLOWED"; message: string };

/** allowlist 이름 하나를 probe한다. allowlist 밖이면 spawn 없이 거부한다(입력 이름은 결과에 되돌려 쓰지 않는다). */
export async function probeExecutable(name: string, overrides: Partial<ProbeEnvironment> = {}): Promise<ProbeOutcome> {
  if (!isProbeName(name)) return { ok: false, code: "PROBE_NOT_ALLOWED", message: "probe allowlist(node·npx·uvx·docker)에 없는 이름입니다" };
  const env: ProbeEnvironment = { ...defaultProbeEnvironment(), ...overrides };
  const located = await locate(name, env);
  if (located === undefined) return { ok: true, snapshot: { name, available: false, version: null, status: "not-found" } };
  if (located.kind === "shim") return { ok: true, snapshot: { name, available: true, version: await shimVersion(name, located, env), status: "shim-not-executed" } };

  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve("timeout");
    }, env.timeoutMs);
  });
  try {
    const run = env.spawner(located.file, [...PROBE_ARGS], { shell: false, windowsHide: true, signal: controller.signal, maxStdoutBytes: PROBE_MAX_STDOUT_BYTES }).catch(
      (): ProbeSpawnResult => ({ exitCode: null, stdout: "" }),
    );
    const result = await Promise.race([run, timeout]);
    if (result === "timeout") return { ok: true, snapshot: { name, available: "unknown", version: null, status: "timeout" } };
    if (result.exitCode !== 0) return { ok: true, snapshot: { name, available: "unknown", version: null, status: "error" } };
    return { ok: true, snapshot: { name, available: true, version: parseProbeVersion(result.stdout), status: "ok" } };
  } finally {
    clearTimeout(timer);
  }
}

export type BackendProbeReport = Readonly<Record<ProbeName, ProbeSnapshot>>;

/** node·npx·uvx·docker를 순서대로 probe한다. */
export async function probeBackends(overrides: Partial<ProbeEnvironment> = {}): Promise<BackendProbeReport> {
  const env: ProbeEnvironment = { ...defaultProbeEnvironment(), ...overrides };
  const out: Partial<Record<ProbeName, ProbeSnapshot>> = {};
  for (const name of PROBE_ALLOWLIST) {
    const outcome = await probeExecutable(name, env);
    if (outcome.ok) out[name] = outcome.snapshot;
  }
  return Object.freeze(out as Record<ProbeName, ProbeSnapshot>);
}

/**
 * Probe 결과 → M3 RecommendContext.
 * - runtimes.node: node --version이 성공했을 때만. python은 probe하지 않으므로 넣지 않는다(unknown).
 * - availableBackends: 없다고 확인된(available false) backend만 뺀다. timeout·error는 근거 없이 제외하지 않는다.
 */
export function probeToRecommendContext(report: BackendProbeReport, platform?: RecommendPlatform): RecommendContext {
  const node = report.node;
  const runtimes: { node?: string } = node.status === "ok" && node.version !== null ? { node: node.version } : {};
  const availableBackends = (["npx", "uvx", "docker"] as const).filter((b) => report[b].available !== false);
  return { ...(platform === undefined ? {} : { platform }), runtimes, availableBackends };
}
