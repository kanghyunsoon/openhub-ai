import { spawn } from "node:child_process";
import { lstat, mkdtemp, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { containsAbsolutePath } from "../analyzer/index";
import { isVerifiedPlan, type VerifiedPlan } from "../installer/approval-v1";
import type { ConfigPatchStep, RunStep } from "../installer/plan";
import { isVerifiedLifecyclePlan, type VerifiedLifecyclePlan } from "../lifecycle/plan";
import { redactSensitive } from "../recommendation/index";
import { prepareNpxPackage, type NpxPrepareContext } from "./npx-prepare";

/**
 * 공통 Process Executor(TASK-031, D-012). 프로세스를 실행하는 곳은 여기(와 read-only probe)뿐이다.
 * - TASK-028이 발급한 VerifiedPlan만 받는다. 같은 VerifiedPlan은 한 번만 실행한다.
 * - executable + args[]를 그대로 spawn한다. shell:false, spawn 옵션에 env key가 없다(child는 OS 기본으로 상속).
 *   OpenHub 코드는 process.env를 읽거나 쓰지 않는다.
 * - timeout이면 종료하고 signal을 기록한다. stdout·stderr는 각 64KB만 보관하고 결과에는 redact한 마지막 1KB만 남긴다.
 * - cwd는 project root 또는 OpenHub가 만든 격리 임시 디렉터리뿐이다. symlink·junction으로 밖을 가리키면 거부한다.
 * - 준비 단계(run)가 모두 성공한 뒤에만 config-patch 단계를 onConfigStep으로 넘긴다. 실패하면 이후 단계는 skipped다.
 * - npx 준비 단계(npx Prepare)는 고정 인자만 받으며 process/npx-prepare.ts가 실행한다(executable "npx"를 그대로 spawn하지 않는다).
 * - probe 모듈을 import하지 않는다.
 */

export const EXEC_MAX_BUFFER_BYTES = 64 * 1024;
export const EXEC_EXCERPT_BYTES = 1024;
export const EXEC_KILL_GRACE_MS = 5000;

interface DataStream {
  on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
}
export interface ExecChild {
  readonly pid?: number | undefined;
  readonly stdout: DataStream | null;
  readonly stderr: DataStream | null;
  on(event: "close", listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(signal?: NodeJS.Signals): boolean;
}
export interface ExecSpawnOptions {
  readonly shell: false;
  readonly cwd: string;
  readonly windowsHide: true;
  readonly stdio: readonly ["ignore", "pipe", "pipe"];
}
export type ExecSpawner = (executable: string, args: readonly string[], options: ExecSpawnOptions) => ExecChild;

export const nodeExecSpawner: ExecSpawner = (executable, args, options) =>
  spawn(executable, [...args], { shell: false, cwd: options.cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });

export interface IsolatedDir {
  /** 만든 디렉터리(절대 경로, 결과에 남기지 않는다). */
  path: string;
  /** 이 디렉터리가 들어 있어야 하는 기준 디렉터리. */
  base: string;
  cleanup(): Promise<void>;
}

export async function createIsolatedDir(): Promise<IsolatedDir> {
  const base = os.tmpdir();
  const dir = await mkdtemp(path.join(base, "openhub-install-"));
  return { path: dir, base, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export type StepStatus = "done" | "failed" | "skipped";
export interface StepOutcome {
  id: string;
  status: StepStatus;
  exitCode?: number | null;
  signal?: string | null;
  excerpt?: string;
  code?: string;
}

export interface ExecutorOptions {
  projectRoot: string;
  spawner?: ExecSpawner;
  isolatedDir?: () => Promise<IsolatedDir>;
  /** config-patch 단계 적용(TASK-032 Config Writer·TASK-033 Transaction). 준비 단계가 모두 성공한 뒤에만 호출된다. */
  onConfigStep?: (step: ConfigPatchStep) => Promise<StepOutcome>;
  /** npx Prepare 실행 문맥(플랫폼·Windows npx 경로·tree killer). 없으면 npx 준비 단계는 NPX_PREPARE_UNAVAILABLE로 실패한다. */
  npx?: Omit<NpxPrepareContext, "spawner" | "timeoutMs">;
}

export type ExecutionReport =
  | { ok: true; prepared: boolean; steps: StepOutcome[]; failedStep?: string }
  | { ok: false; code: "APPROVAL_REQUIRED" | "VERIFIED_PLAN_CONSUMED"; message: string };

const executed = new WeakSet<object>();

/** 줄 단위 redact: 절대 경로·token·URL credential이 있는 줄은 가린다. */
export function redactExcerpt(text: string): string {
  return text
    .split(/\r?\n/u)
    .map((line) => (containsAbsolutePath(line) ? "[redacted]" : redactSensitive(line)))
    .join("\n");
}

/** 스트림 하나의 마지막 64KB만 보관한다. */
export class OutputTail {
  #chunks: Buffer[] = [];
  #size = 0;
  push(chunk: Buffer | string): void {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    this.#chunks.push(buf);
    this.#size += buf.length;
    while (this.#size > EXEC_MAX_BUFFER_BYTES && this.#chunks.length > 0) {
      const over = this.#size - EXEC_MAX_BUFFER_BYTES;
      const first = this.#chunks[0]!;
      if (first.length <= over) {
        this.#chunks.shift();
        this.#size -= first.length;
      } else {
        this.#chunks[0] = first.subarray(over);
        this.#size -= over;
      }
    }
  }
  get size(): number {
    return this.#size;
  }
  tail(bytes: number): string {
    const all = Buffer.concat(this.#chunks);
    return all.subarray(Math.max(0, all.length - bytes)).toString("utf8");
  }
}

const samePath = (a: string, b: string) => (process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b);
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
};

async function resolveCwd(kind: RunStep["cwd"], options: ExecutorOptions): Promise<{ cwd: string; cleanup?: () => Promise<void> } | { rejected: string }> {
  try {
    if (kind === "project") {
      const root = path.resolve(options.projectRoot);
      const real = await realpath(root);
      if ((await lstat(root)).isSymbolicLink() || !samePath(real, root)) return { rejected: "project root가 symlink·junction입니다" };
      return { cwd: root };
    }
    const dir = await (options.isolatedDir ?? createIsolatedDir)();
    const realBase = await realpath(dir.base);
    const realDir = await realpath(dir.path);
    if ((await lstat(dir.path)).isSymbolicLink() || !inside(realDir, realBase)) {
      return { rejected: "격리 디렉터리가 기준 디렉터리 밖을 가리킵니다" };
    }
    return { cwd: dir.path, cleanup: dir.cleanup };
  } catch {
    return { rejected: "작업 디렉터리를 확인하지 못했습니다" };
  }
}

async function runAnyStep(step: RunStep, cwd: string, spawner: ExecSpawner, options: ExecutorOptions): Promise<StepOutcome> {
  if (step.executable !== "npx") return runStep(step, cwd, spawner);
  if (options.npx === undefined) return { id: step.id, status: "failed", code: "NPX_PREPARE_UNAVAILABLE", excerpt: "npx 준비 단계를 실행할 문맥(플랫폼·실행 경로)이 없습니다" };
  const outcome = await prepareNpxPackage(step.args, cwd, { ...options.npx, spawner, timeoutMs: step.timeoutMs });
  return { ...outcome, id: step.id, ...(outcome.excerpt === undefined ? {} : { excerpt: redactExcerpt(outcome.excerpt) }) };
}

function runStep(step: RunStep, cwd: string, spawner: ExecSpawner): Promise<StepOutcome> {
  return new Promise((resolve) => {
    const stdout = new OutputTail();
    const stderr = new OutputTail();
    let timedOut = false;
    let settled = false;
    let child: ExecChild;
    const finish = (outcome: Omit<StepOutcome, "id" | "excerpt">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      const source = stderr.size > 0 ? stderr : stdout;
      const excerpt = redactExcerpt(source.tail(EXEC_EXCERPT_BYTES));
      resolve({ id: step.id, ...outcome, ...(excerpt === "" ? {} : { excerpt }) });
    };
    let grace: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      grace = setTimeout(() => {
        child.kill("SIGKILL");
        finish({ status: "failed", code: "STEP_TIMEOUT", exitCode: null, signal: "SIGKILL" });
      }, EXEC_KILL_GRACE_MS);
    }, step.timeoutMs);
    try {
      child = spawner(step.executable, [...step.args], { shell: false, cwd, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    } catch {
      finish({ status: "failed", code: "SPAWN_FAILED", exitCode: null, signal: null });
      return;
    }
    child.stdout?.on("data", (c) => stdout.push(c));
    child.stderr?.on("data", (c) => stderr.push(c));
    child.on("error", () => finish({ status: "failed", code: "SPAWN_FAILED", exitCode: null, signal: null }));
    child.on("close", (code, signal) => {
      if (timedOut) finish({ status: "failed", code: "STEP_TIMEOUT", exitCode: code, signal: signal ?? "SIGTERM" });
      else finish(code === 0 ? { status: "done", exitCode: 0, signal: null } : { status: "failed", code: "STEP_FAILED", exitCode: code, signal });
    });
  });
}

/** VerifiedPlan의 단계를 순서대로 실행한다. run 단계가 실패하면 이후 단계(config-patch 포함)는 실행하지 않는다. */
export async function executeVerifiedPlan(verified: VerifiedPlan, options: ExecutorOptions): Promise<ExecutionReport> {
  if (!isVerifiedPlan(verified)) return { ok: false, code: "APPROVAL_REQUIRED", message: "검증된 Plan(VerifiedPlan)만 실행할 수 있습니다" };
  if (executed.has(verified)) return { ok: false, code: "VERIFIED_PLAN_CONSUMED", message: "이미 실행한 Plan입니다. 다시 승인하세요" };
  executed.add(verified);

  const spawner = options.spawner ?? nodeExecSpawner;
  const steps: StepOutcome[] = [];
  let failedStep: string | undefined;
  for (const step of verified.plan.steps) {
    if (failedStep !== undefined) {
      steps.push({ id: step.id, status: "skipped" });
      continue;
    }
    if (step.kind === "config-patch") {
      const outcome = options.onConfigStep === undefined ? { id: step.id, status: "skipped" as const, code: "NO_CONFIG_WRITER" } : await options.onConfigStep(step);
      steps.push(outcome);
      if (outcome.status === "failed") failedStep = step.id;
      continue;
    }
    const cwd = await resolveCwd(step.cwd, options);
    if ("rejected" in cwd) {
      steps.push({ id: step.id, status: "failed", code: "CWD_REJECTED", excerpt: cwd.rejected });
      failedStep = step.id;
      continue;
    }
    try {
      const outcome = await runAnyStep(step, cwd.cwd, spawner, options);
      steps.push(outcome);
      if (outcome.status !== "done") failedStep = step.id;
    } finally {
      await cwd.cleanup?.();
    }
  }
  const prepared = verified.plan.steps.every((s, i) => s.kind !== "run" || steps[i]?.status === "done");
  return { ok: true, prepared, steps, ...(failedStep === undefined ? {} : { failedStep }) };
}

/**
 * LifecyclePlan 준비 단계(docker pull image@sha256, 정확한 버전 npx 패키지의 npx Prepare)를 실행한다(TASK-043, D-020).
 * 검증된 LifecyclePlan만, 한 번만 실행한다. uvx update에는 준비 단계가 없다. 받은 image·완성된 npx cache는 지우지 않는다.
 */
export async function executeLifecyclePreparation(
  verified: VerifiedLifecyclePlan,
  options: ExecutorOptions,
): Promise<{ ok: true; prepared: boolean; steps: StepOutcome[] } | { ok: false; code: "APPROVAL_REQUIRED" | "VERIFIED_PLAN_CONSUMED"; message: string }> {
  if (!isVerifiedLifecyclePlan(verified)) return { ok: false, code: "APPROVAL_REQUIRED", message: "검증된 LifecyclePlan만 실행할 수 있습니다" };
  if (executed.has(verified)) return { ok: false, code: "VERIFIED_PLAN_CONSUMED", message: "이미 실행한 Plan입니다. 다시 승인하세요" };
  executed.add(verified);
  const spawner = options.spawner ?? nodeExecSpawner;
  const steps: StepOutcome[] = [];
  for (const step of verified.plan.steps) {
    if (step.kind !== "run") continue;
    if (steps.some((s) => s.status !== "done")) {
      steps.push({ id: step.id, status: "skipped" });
      continue;
    }
    const cwd = await resolveCwd(step.cwd, options);
    if ("rejected" in cwd) {
      steps.push({ id: step.id, status: "failed", code: "CWD_REJECTED", excerpt: cwd.rejected });
      continue;
    }
    try {
      steps.push(await runAnyStep(step, cwd.cwd, spawner, options));
    } finally {
      await cwd.cleanup?.();
    }
  }
  return { ok: true, prepared: steps.every((s) => s.status === "done"), steps };
}
