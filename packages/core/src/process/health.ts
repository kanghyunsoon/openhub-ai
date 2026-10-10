import { spawn } from "node:child_process";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { isVerifiedLifecyclePlan, type HealthStep, type VerifiedLifecyclePlan } from "../lifecycle/plan";
import type { RecommendPlatform } from "../recommendation/index";
import { EXEC_EXCERPT_BYTES, OutputTail, redactExcerpt, type ExecSpawner } from "./executor";
import { TOOL_CONFIG_PLACEHOLDER, substituteToolConfig } from "../tool-config/index";

/**
 * MCP Health Check(TASK-041, D-019). 승인된 LifecyclePlan의 health 단계로만 MCP 서버를 실행해 handshake를 확인한다.
 * - argv(모두 shell:false): POSIX npx "npx …", Windows npx "node.exe <npm의 npx-cli.js> …", uvx "uvx …", docker "docker run -i --rm -e NAME… image@sha256".
 *   OpenHub는 cmd·cmd.exe·.cmd를 실행하지 않는다. D-016 "cmd /d /c npx"는 Client config 표현일 뿐이다.
 *   (npm 11의 @npmcli/run-script는 package bin을 scriptShell로 실행하므로 npm 내부가 Windows에서 ComSpec을 쓸 수 있다. 그것은 npm의 동작이다.)
 * - handshake: initialize → notifications/initialized → tools/list → stdin 닫기 → 종료. Client 앱은 실행하지 않는다.
 * - 한도: startup 20초(initialize 응답), handshake 10초(tools/list 응답), 전체 45초. stdout·stderr 각 64KB 보관, 1MB 초과 시 kill.
 * - 종료: POSIX는 process group kill, Windows는 taskkill.exe /T /F /PID(shell:false). 종료 실패도 Health 실패다.
 * - cwd는 OpenHub가 만든 격리 임시 디렉터리. spawn 옵션에 env key가 없어 OS 기본으로 상속된다. process.env를 읽지 않는다.
 *   Windows npx 실행 경로(node.exe·npx-cli.js)는 호출 측이 probe 단계에서 찾아 넘긴다(Health 안에서 PATH를 읽지 않는다).
 * - 결과에는 상태·사유·tool 개수·redact한 1KB 이하 출력만 남는다. 실행 경로·cwd·env 값은 남기지 않는다.
 */

export const HEALTH_STATUS_VALUES = ["healthy", "unhealthy", "timeout", "launch-failed", "handshake-failed", "unsupported"] as const;
export type HealthCheckStatus = (typeof HEALTH_STATUS_VALUES)[number];
export type HealthFailureReason =
  | "spawn-failed"
  | "launcher-not-found"
  | "process-exited"
  | "startup-timeout"
  | "handshake-timeout"
  | "total-timeout"
  | "invalid-message"
  | "initialize-error"
  | "tools-list-error"
  | "output-limit"
  | "termination-failed"
  | "unsupported-health-check";
export const HEALTH_OUTPUT_KILL_BYTES = 1024 * 1024;
export const HEALTH_SHUTDOWN_GRACE_MS = 2000;
export const HEALTH_KILL_WAIT_MS = 5000;
export const MCP_PROTOCOL_VERSION = "2025-06-18";

export interface HealthCheckResult {
  status: HealthCheckStatus;
  reason: HealthFailureReason | null;
  toolCount: number | null;
  environmentUnverified: boolean;
  /** process tree를 끝까지 정리했는지. false면 Health 실패다. */
  terminated: boolean;
  excerpt: string | null;
}

interface DataStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}
export interface HealthChild {
  readonly pid?: number | undefined;
  readonly stdin: { write(chunk: string): unknown; end(): unknown; on?(event: "error", listener: (error: Error) => void): unknown } | null;
  readonly stdout: DataStream | null;
  readonly stderr: DataStream | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
}
export interface HealthSpawnOptions {
  readonly shell: false;
  readonly cwd: string;
  readonly windowsHide: true;
  readonly stdio: readonly ["pipe", "pipe", "pipe"];
  /** POSIX에서 process group kill을 위해 새 group으로 시작한다. */
  readonly detached: boolean;
}
export type HealthSpawner = (executable: string, args: readonly string[], options: HealthSpawnOptions) => HealthChild;

export const nodeHealthSpawner: HealthSpawner = (executable, args, options) =>
  spawn(executable, [...args], { shell: false, cwd: options.cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: options.detached });

/** process tree 종료. 성공(이미 없음 포함)이면 true. */
export type TreeKiller = (pid: number, platform: RecommendPlatform) => Promise<boolean>;

/** 기본 tree killer. POSIX는 process group에 SIGKILL, Windows는 taskkill.exe /T /F /PID(shell:false). */
export function createTreeKiller(deps: { spawner?: ExecSpawner; killGroup?: (pid: number, signal: NodeJS.Signals) => void; cwd: string }): TreeKiller {
  return async (pid, platform) => {
    if (platform === "windows") {
      const spawner: ExecSpawner =
        deps.spawner ?? ((exe, args, options) => spawn(exe, [...args], { shell: false, cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
      return new Promise<boolean>((resolve) => {
        try {
          const child = spawner("taskkill.exe", ["/T", "/F", "/PID", String(pid)], { shell: false, cwd: deps.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
          child.on("error", () => resolve(false));
          // 0 = 종료함, 128 = 이미 없음
          child.on("close", (code) => resolve(code === 0 || code === 128));
        } catch {
          resolve(false);
        }
      });
    }
    try {
      (deps.killGroup ?? ((p, s) => process.kill(p, s)))(-pid, "SIGKILL");
      return true;
    } catch (error) {
      return (error as { code?: string }).code === "ESRCH";
    }
  };
}

export interface WindowsNpxLauncher {
  /** node.exe 절대 경로(결과·로그에 남기지 않는다). */
  node: string;
  /** npm의 bin/npx-cli.js 절대 경로(결과·로그에 남기지 않는다). */
  npxCli: string;
}

/**
 * Windows npx 실행 경로를 찾는다. PATH에서 npx shim이 있는 디렉터리의 node.exe와 node_modules/npm/bin/npx-cli.js가
 * 모두 파일일 때만 돌려준다. 아무것도 실행하지 않는다. pathEnv는 호출 측(probe 단계)이 넘긴다.
 */
/** 존재 확인에 쓰는 최소 fs(probe 모듈과 독립, AC-029-07). */
export interface LauncherFs {
  stat(file: string): Promise<{ isFile(): boolean }>;
}

export async function locateWindowsNpxLauncher(env: { pathEnv: string; fs: LauncherFs }): Promise<WindowsNpxLauncher | null> {
  const p = path.win32;
  const isFile = async (f: string) => {
    try {
      return (await env.fs.stat(f)).isFile();
    } catch {
      return false;
    }
  };
  for (const raw of env.pathEnv.split(";")) {
    const dir = raw.trim();
    if (dir === "" || !p.isAbsolute(dir)) continue;
    if (!(await isFile(p.join(dir, "npx.cmd"))) && !(await isFile(p.join(dir, "npx")))) continue;
    const node = p.join(dir, "node.exe");
    const npxCli = p.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
    if ((await isFile(node)) && (await isFile(npxCli))) return { node, npxCli };
    return null;
  }
  return null;
}

/** health 단계 → 실제 argv. Windows npx는 node.exe + npx-cli.js이며 cmd를 거치지 않는다. */
export function healthArgv(step: HealthStep, platform: RecommendPlatform, launcher: WindowsNpxLauncher | null): string[] | null {
  if (step.executable === "npx" && platform === "windows") return launcher === null ? null : [launcher.node, launcher.npxCli, ...step.args];
  return [step.executable, ...step.args];
}

export interface HealthRunOptions {
  /** Manifest healthCheck.type. mcp-handshake가 아니면 unsupported(spawn 0회). */
  healthCheckType: string | undefined;
  /** Windows npx일 때 필요(probe 단계에서 locateWindowsNpxLauncher로 찾는다). */
  windowsNpx?: WindowsNpxLauncher | null;
  /**
   * OpenHub 관리 tool config 파일 경로(v0.2.0). health 인자에 {toolConfig}가 있으면 필요하다. 호출 측이 실행 직전 내용 digest를 확인한 뒤 넘긴다.
   * 결과·로그에 남기지 않는다.
   */
  toolConfigFile?: string;
  spawner?: HealthSpawner;
  killTree?: TreeKiller;
  /**
   * 격리 임시 디렉터리 기준. 호출 측이 Health 전에 정한다(os.tmpdir()는 Windows에서 TEMP 환경변수를 읽으므로
   * Health 안에서 부르지 않는다).
   */
  tempBase: string;
}

export type HealthRunReport = { ok: true; result: HealthCheckResult } | { ok: false; code: "APPROVAL_REQUIRED" | "VERIFIED_PLAN_CONSUMED"; message: string };

const ran = new WeakSet<object>();

const result = (status: HealthCheckStatus, reason: HealthFailureReason | null, environmentUnverified: boolean, extra: Partial<HealthCheckResult> = {}): HealthCheckResult => ({
  status,
  reason,
  toolCount: null,
  environmentUnverified,
  terminated: true,
  excerpt: null,
  ...extra,
});

/** 승인된 LifecyclePlan의 health 단계를 실행한다. VerifiedLifecyclePlan 없이는 spawn 0회로 APPROVAL_REQUIRED다. */
export async function runHealthCheck(verified: VerifiedLifecyclePlan, options: HealthRunOptions): Promise<HealthRunReport> {
  if (!isVerifiedLifecyclePlan(verified)) return { ok: false, code: "APPROVAL_REQUIRED", message: "승인·검증된 LifecyclePlan(health 단계 포함)만 실행할 수 있습니다" };
  const step = verified.plan.steps.find((s): s is HealthStep => s.kind === "health");
  if (step === undefined || !verified.acknowledgements.includes("health-execution")) {
    return { ok: false, code: "APPROVAL_REQUIRED", message: "health 단계와 health-execution 승인이 있는 Plan만 실행할 수 있습니다" };
  }
  if (ran.has(verified)) return { ok: false, code: "VERIFIED_PLAN_CONSUMED", message: "이미 실행한 Health Plan입니다. 다시 승인하세요" };
  ran.add(verified);

  const environmentUnverified = verified.plan.requiredEnv.some((e) => e.required);
  if (options.healthCheckType !== "mcp-handshake") return { ok: true, result: result("unsupported", "unsupported-health-check", environmentUnverified, { terminated: true }) };
  let argv = healthArgv(step, verified.plan.platform, options.windowsNpx ?? null);
  if (argv !== null && step.args.includes(TOOL_CONFIG_PLACEHOLDER)) {
    const sub = options.toolConfigFile === undefined ? null : substituteToolConfig(argv, options.toolConfigFile, verified.plan.platform);
    if (sub === null || !sub.ok) return { ok: true, result: result("launch-failed", "spawn-failed", environmentUnverified, { excerpt: "tool config 파일을 확인하지 못해 실행하지 않았습니다" }) };
    argv = sub.args;
  }
  if (argv === null) return { ok: true, result: result("launch-failed", "launcher-not-found", environmentUnverified) };

  const base = options.tempBase;
  const cwd = await mkdtemp(path.join(base, "openhub-health-"));
  try {
    const realBase = await realpath(base);
    const realCwd = await realpath(cwd);
    const rel = path.relative(realBase, realCwd);
    if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return { ok: true, result: result("launch-failed", "spawn-failed", environmentUnverified) };
    const outcome = await handshake(argv, realCwd, step.timeouts, verified.plan.platform, { ...options, killTree: options.killTree ?? createTreeKiller({ cwd: realBase }) });
    return { ok: true, result: { ...outcome, environmentUnverified } };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}

type Outcome = Omit<HealthCheckResult, "environmentUnverified">;

/** handshake 시점 관찰자(TASK-066 Benchmark). 없으면 M5 Health와 동작이 같다. 값(출력·경로)은 넘기지 않는다. */
export type HandshakeMark = "spawned" | "initialize-sent" | "initialize-response" | "tools-sent" | "tools-response" | "shutdown-start" | "closed";
export interface HandshakeObserver {
  mark(event: HandshakeMark): void;
  /** initialize 응답의 serverInfo(이름·버전 문자열만, 호출 측이 정제한다). */
  serverInfo?(info: { name: unknown; version: unknown }): void;
}
export type HandshakeOutcome = Outcome;

/**
 * 승인 검증을 마친 호출 측(Benchmark)이 같은 handshake를 한 번 실행한다. initialize → notifications/initialized → tools/list → 종료만 하고
 * tools/call은 보내지 않는다. cwd는 호출 측이 만든 격리 디렉터리, argv는 healthArgv 규칙으로 만든 값이다.
 */
export function runHandshake(argv: string[], cwd: string, timeouts: HealthStep["timeouts"], platform: RecommendPlatform, options: Omit<HealthRunOptions, "healthCheckType" | "tempBase"> & { killTree: TreeKiller }, observer: HandshakeObserver): Promise<HandshakeOutcome> {
  return handshake(argv, cwd, timeouts, platform, { ...options, healthCheckType: "mcp-handshake", tempBase: cwd }, observer);
}

function handshake(argv: string[], cwd: string, timeouts: HealthStep["timeouts"], platform: RecommendPlatform, options: HealthRunOptions, observer?: HandshakeObserver): Promise<Outcome> {
  const spawner = options.spawner ?? nodeHealthSpawner;
  const killTree = options.killTree!;
  return new Promise<Outcome>((resolve) => {
    const stdout = new OutputTail();
    const stderr = new OutputTail();
    const totals = { stdout: 0, stderr: 0 };
    const timers: ReturnType<typeof setTimeout>[] = [];
    let buffer = "";
    let phase: "initialize" | "tools" | "done" = "initialize";
    let decided: Outcome | null = null;
    let closed = false;
    let onClose: (() => void) | null = null;
    let child: HealthChild;

    const excerpt = () => {
      const text = redactExcerpt((stderr.size > 0 ? stderr : stdout).tail(EXEC_EXCERPT_BYTES));
      return text === "" ? null : text;
    };
    const waitClose = (ms: number) =>
      new Promise<boolean>((done) => {
        if (closed) return done(true);
        const t = setTimeout(() => done(closed), ms);
        onClose = () => {
          clearTimeout(t);
          done(true);
        };
      });
    const send = (message: unknown) => {
      try {
        child.stdin?.write(JSON.stringify(message) + "\n");
      } catch {
        // stdin이 닫힌 경우 close·timeout이 결과를 정한다.
      }
    };

    const conclude = async (outcome: Outcome, graceful: boolean) => {
      if (decided !== null) return;
      decided = outcome;
      phase = "done";
      for (const t of timers) clearTimeout(t);
      let terminated = closed;
      if (!closed && graceful) {
        observer?.mark("shutdown-start");
        try {
          child.stdin?.end();
        } catch {
          // 무시: 아래에서 tree kill로 정리한다.
        }
        terminated = await waitClose(HEALTH_SHUTDOWN_GRACE_MS);
      }
      if (!terminated) {
        const pid = child.pid;
        const killed = pid === undefined ? false : await killTree(pid, platform);
        terminated = killed && (await waitClose(HEALTH_KILL_WAIT_MS));
      }
      const final: Outcome = { ...outcome, terminated, excerpt: outcome.excerpt ?? (outcome.status === "healthy" ? null : excerpt()) };
      if (!terminated) {
        resolve({ ...final, status: final.status === "healthy" ? "unhealthy" : final.status, reason: final.status === "healthy" ? "termination-failed" : final.reason });
      } else resolve(final);
    };
    const fail = (status: HealthCheckStatus, reason: HealthFailureReason) => void conclude({ status, reason, toolCount: null, terminated: false, excerpt: null }, false);

    const onMessage = (line: string) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return fail("handshake-failed", "invalid-message");
      }
      if (msg === null || typeof msg !== "object" || Array.isArray(msg) || (msg as Record<string, unknown>)["jsonrpc"] !== "2.0") return fail("handshake-failed", "invalid-message");
      const m = msg as Record<string, unknown>;
      if (typeof m["method"] === "string") {
        // 서버의 요청에는 지원하지 않는다고 답하고, 알림은 무시한다.
        if (m["id"] !== undefined) send({ jsonrpc: "2.0", id: m["id"], error: { code: -32601, message: "Method not found" } });
        return;
      }
      if (phase === "initialize" && m["id"] === 1) {
        const res = m["result"];
        if (m["error"] !== undefined || res === null || typeof res !== "object" || Array.isArray(res)) return fail("handshake-failed", "initialize-error");
        observer?.mark("initialize-response");
        const info = (res as Record<string, unknown>)["serverInfo"];
        if (info !== null && typeof info === "object" && !Array.isArray(info)) observer?.serverInfo?.({ name: (info as Record<string, unknown>)["name"], version: (info as Record<string, unknown>)["version"] });
        phase = "tools";
        send({ jsonrpc: "2.0", method: "notifications/initialized" });
        send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
        observer?.mark("tools-sent");
        timers.push(setTimeout(() => fail("timeout", "handshake-timeout"), timeouts.handshakeMs));
        return;
      }
      if (phase === "tools" && m["id"] === 2) {
        observer?.mark("tools-response");
        if (m["error"] !== undefined) return void conclude({ status: "unhealthy", reason: "tools-list-error", toolCount: null, terminated: false, excerpt: null }, true);
        const tools = (m["result"] as Record<string, unknown> | undefined)?.["tools"];
        if (!Array.isArray(tools)) return fail("handshake-failed", "invalid-message");
        return void conclude({ status: "healthy", reason: null, toolCount: tools.length, terminated: false, excerpt: null }, true);
      }
    };

    const onData = (which: "stdout" | "stderr", chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      totals[which] += buf.length;
      (which === "stdout" ? stdout : stderr).push(buf);
      if (decided !== null) return;
      if (totals[which] > HEALTH_OUTPUT_KILL_BYTES) return fail("handshake-failed", "output-limit");
      if (which === "stderr") return;
      buffer += buf.toString("utf8");
      for (let nl = buffer.indexOf("\n"); nl !== -1 && decided === null; nl = buffer.indexOf("\n")) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line !== "") onMessage(line);
      }
    };

    try {
      child = spawner(argv[0]!, argv.slice(1), { shell: false, cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: platform !== "windows" });
    } catch {
      resolve({ status: "launch-failed", reason: "spawn-failed", toolCount: null, terminated: true, excerpt: null });
      return;
    }
    observer?.mark("spawned");
    child.stdin?.on?.("error", () => undefined);
    child.stdout?.on("data", (c) => onData("stdout", c));
    child.stderr?.on("data", (c) => onData("stderr", c));
    child.on("error", () => {
      if (decided === null && phase === "initialize") {
        closed = true;
        void conclude({ status: "launch-failed", reason: "spawn-failed", toolCount: null, terminated: true, excerpt: null }, false);
      }
    });
    child.on("close", () => {
      closed = true;
      observer?.mark("closed");
      const notify = onClose;
      onClose = null;
      notify?.();
      if (decided === null) void conclude({ status: phase === "initialize" ? "launch-failed" : "handshake-failed", reason: "process-exited", toolCount: null, terminated: true, excerpt: null }, false);
    });
    timers.push(setTimeout(() => (phase === "initialize" ? fail("timeout", "startup-timeout") : undefined), timeouts.startupMs));
    timers.push(setTimeout(() => fail("timeout", "total-timeout"), timeouts.totalMs));
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: "openhub-health", version: "1" } } });
    observer?.mark("initialize-sent");
  });
}

