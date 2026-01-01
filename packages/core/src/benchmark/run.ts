import { mkdtemp, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { INSTALL_BACKENDS } from "../installer/plan";
import { createTreeKiller, healthArgv, runHandshake, type HandshakeMark, type HealthSpawner, type TreeKiller, type WindowsNpxLauncher } from "../process/health";
import { RECOMMEND_PLATFORMS, TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, redactSensitive } from "../recommendation/index";
import { verifyApprovedBenchmarkPlan, type BenchmarkApproval, type BenchmarkGateFailure, type BenchmarkPlanResult, type VerifiedBenchmarkPlan } from "./plan";

/**
 * Benchmark 실행·BenchmarkReport v1(TASK-066, D-032).
 * - 승인 검증(kernel, 실행 직전 재생성·digest 비교)을 통과한 Plan만 실행한다. 검증된 Plan은 1회만 실행할 수 있다.
 * - 순차 6회(warmup 1 + measured 5). 매 회 M5 Health와 같은 격리 임시 cwd·shell:false·process tree 정리로
 *   spawn → initialize → notifications/initialized → tools/list → stdin 닫기 → 종료만 한다. tools/call·Client 앱·shell 실행 0.
 * - 종료 실패가 나면 이후 spawn을 하지 않는다. Plan 전체 300초를 넘기면 남은 회차는 aborted다.
 * - 요약은 성공한 measured 회차의 median·min·max와 실패 수뿐이다(p95 등 백분위·peak RSS 없음).
 * - 환경 정보는 os·arch·Node 버전·backend·tool 버전·정제한 serverInfo뿐이다. 사용자명·hostname·절대 경로·env 값·출력(stderr)은 남기지 않는다.
 * - 결과는 메모리 값이며 파일·state·config를 쓰지 않는다(격리 임시 cwd만 만들고 지운다). process.env를 읽지 않는다.
 */

export const BENCHMARK_REPORT_SCHEMA_VERSION = 1;
export const BENCHMARK_RUN_STATUSES = ["succeeded", "timeout", "launch-failed", "handshake-failed", "unhealthy", "termination-failed", "aborted"] as const;
export type BenchmarkRunStatus = (typeof BENCHMARK_RUN_STATUSES)[number];
export const BENCHMARK_REPORT_NOTES = ["p95 not reported (5 measured runs)", "peak RSS not measured", "results are local to this machine and are not comparable across machines"] as const;

const ms = z.number().int().min(0).nullable();
const stat = z.strictObject({ median: z.number().int().min(0), min: z.number().int().min(0), max: z.number().int().min(0) }).nullable();
const short = z.string().min(1).max(100);
export const benchmarkReportSchema = z
  .strictObject({
    schemaVersion: z.literal(BENCHMARK_REPORT_SCHEMA_VERSION),
    kind: z.literal("openhub-benchmark-report"),
    toolId: short,
    planDigest: z.string().regex(/^sha256:[0-9a-f]{64}$/u),
    environment: z.strictObject({
      os: z.enum(RECOMMEND_PLATFORMS),
      arch: z.string().regex(/^[a-z0-9_-]{1,20}$/u),
      nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/u),
      backend: z.enum(INSTALL_BACKENDS),
      toolVersion: short.nullable(),
      serverInfo: z.strictObject({ name: short.nullable(), version: short.nullable() }).nullable(),
    }),
    runs: z.array(
      z.strictObject({
        index: z.number().int().min(1).max(6),
        phase: z.enum(["warmup", "measured"]),
        status: z.enum(BENCHMARK_RUN_STATUSES),
        reason: z.string().min(1).max(60).nullable(),
        spawnMs: ms,
        initializeMs: ms,
        toolsListMs: ms,
        readyMs: ms,
        cleanupMs: ms,
        terminated: z.boolean(),
      }),
    ).length(6),
    summary: z.strictObject({
      measured: z.literal(5),
      succeeded: z.number().int().min(0).max(5),
      failed: z.number().int().min(0).max(5),
      startupMs: stat,
      initializeMs: stat,
      toolsListMs: stat,
      readyMs: stat,
      cleanupMs: stat,
    }),
    notes: z.tuple([z.literal(BENCHMARK_REPORT_NOTES[0]), z.literal(BENCHMARK_REPORT_NOTES[1]), z.literal(BENCHMARK_REPORT_NOTES[2])]),
  })
  .superRefine((r, ctx) => {
    const walk = (v: unknown): boolean =>
      typeof v === "string" ? containsAbsolutePath(v) || TOKEN_PATTERN.test(v) || URL_CREDENTIAL_PATTERN.test(v) : Array.isArray(v) ? v.some(walk) : v !== null && typeof v === "object" ? Object.values(v).some(walk) : false;
    if (walk(r)) ctx.addIssue({ code: "custom", path: [], message: "Report에 절대 경로·token이 있다" });
  });
export type BenchmarkReportV1 = z.output<typeof benchmarkReportSchema>;
export type BenchmarkRun = BenchmarkReportV1["runs"][number];

export interface BenchmarkRunOptions {
  /** planBenchmark를 승인 때와 같은 옵션으로 다시 부른다. */
  regenerate: () => Promise<BenchmarkPlanResult>;
  /** 격리 임시 디렉터리의 기준(호출 측이 정한다). */
  tempBase: string;
  /** Windows npx일 때 필요(probe 단계에서 locateWindowsNpxLauncher로 찾는다). */
  windowsNpx?: WindowsNpxLauncher | null;
  spawner?: HealthSpawner;
  killTree?: TreeKiller;
  /** 단조 증가 시계(ms). 테스트는 주입한다. */
  clock?: () => number;
  /** 실행 환경(호출 측이 process.arch·process.versions.node로 채운다). */
  host: { arch: string; nodeVersion: string };
}

export type BenchmarkRunResult = { ok: true; report: BenchmarkReportV1 } | (BenchmarkGateFailure & { ok: false }) | { ok: false; code: "VERIFIED_PLAN_CONSUMED" | "BENCHMARK_LAUNCHER_NOT_FOUND"; message: string };

const consumed = new WeakSet<object>();
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
};
const statOf = (xs: (number | null)[]) => {
  const v = xs.filter((x): x is number => x !== null);
  return v.length === 0 ? null : { median: median(v), min: Math.min(...v), max: Math.max(...v) };
};
const clean = (v: unknown): string | null => {
  if (typeof v !== "string" && typeof v !== "number") return null;
  const s = redactSensitive(String(v).replace(/[\u0000-\u001f\u007f]/gu, " ").trim()).slice(0, 100);
  return s === "" ? null : s;
};

function statusOf(o: { status: string; reason: string | null; terminated: boolean }): BenchmarkRunStatus {
  if (!o.terminated) return "termination-failed";
  if (o.status === "healthy") return "succeeded";
  return (BENCHMARK_RUN_STATUSES as readonly string[]).includes(o.status) ? (o.status as BenchmarkRunStatus) : "handshake-failed";
}

/** 승인 검증 → 6회 순차 실행 → BenchmarkReport v1(메모리). */
export async function runBenchmark(approval: BenchmarkApproval | undefined, options: BenchmarkRunOptions): Promise<BenchmarkRunResult> {
  const gate = await verifyApprovedBenchmarkPlan(approval, options.regenerate);
  if (!gate.ok) return { ...gate, ok: false };
  return executeVerifiedBenchmark(gate.verified, options);
}

async function executeVerifiedBenchmark(verified: VerifiedBenchmarkPlan, options: BenchmarkRunOptions): Promise<BenchmarkRunResult> {
  if (consumed.has(verified)) return { ok: false, code: "VERIFIED_PLAN_CONSUMED", message: "이미 실행한 Benchmark Plan입니다. 다시 승인하세요" };
  consumed.add(verified);
  const plan = verified.plan;
  const launch = plan.launch!;
  const argv = healthArgv({ id: "benchmark", kind: "health", executable: launch.executable, args: launch.args, envNames: launch.envNames, cwd: "isolated", timeouts: { startupMs: plan.timeouts.startupMs, handshakeMs: plan.timeouts.handshakeMs, totalMs: plan.timeouts.runTotalMs } }, plan.platform, options.windowsNpx ?? null);
  if (argv === null) return { ok: false, code: "BENCHMARK_LAUNCHER_NOT_FOUND", message: "Windows npx 실행 경로(node.exe·npx-cli.js)를 찾지 못했습니다" };
  const clock = options.clock ?? (() => performance.now());
  const realBase = await realpath(options.tempBase);
  const killTree = options.killTree ?? createTreeKiller({ cwd: realBase });
  const started = clock();
  const runs: BenchmarkRun[] = [];
  let serverInfo: { name: string | null; version: string | null } | null = null;
  let stop: "termination" | "plan-total" | null = null;
  for (let index = 1; index <= 6; index += 1) {
    const phase = index === 1 ? "warmup" : "measured";
    if (stop === null && clock() - started > plan.timeouts.planTotalMs) stop = "plan-total";
    if (stop !== null) {
      runs.push({ index, phase, status: "aborted", reason: stop === "plan-total" ? "plan-total-timeout" : "previous-termination-failed", spawnMs: null, initializeMs: null, toolsListMs: null, readyMs: null, cleanupMs: null, terminated: true });
      continue;
    }
    const marks = new Map<HandshakeMark | "begin", number>();
    const cwd = await mkdtemp(path.join(realBase, "openhub-benchmark-"));
    let outcome: { status: string; reason: string | null; terminated: boolean };
    try {
      const realCwd = await realpath(cwd);
      const rel = path.relative(realBase, realCwd);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) outcome = { status: "launch-failed", reason: "spawn-failed", terminated: true };
      else {
        marks.set("begin", clock());
        outcome = await runHandshake(argv, realCwd, { startupMs: plan.timeouts.startupMs, handshakeMs: plan.timeouts.handshakeMs, totalMs: plan.timeouts.runTotalMs }, plan.platform, { ...(options.spawner === undefined ? {} : { spawner: options.spawner }), killTree }, {
          mark: (e) => void (marks.has(e) ? undefined : marks.set(e, clock())),
          serverInfo: (info) => {
            if (serverInfo === null) serverInfo = { name: clean(info.name), version: clean(info.version) };
          },
        });
      }
    } finally {
      await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
    }
    const at = (e: HandshakeMark | "begin") => marks.get(e);
    const diff = (a: HandshakeMark | "begin", b: HandshakeMark | "begin") => {
      const x = at(a);
      const y = at(b);
      return x === undefined || y === undefined ? null : Math.max(0, Math.round(y - x));
    };
    const status = statusOf(outcome);
    const ok = status === "succeeded";
    runs.push({
      index,
      phase,
      status,
      reason: ok ? null : status === "termination-failed" ? "termination-failed" : outcome.reason,
      spawnMs: diff("begin", "spawned"),
      initializeMs: diff("initialize-sent", "initialize-response"),
      toolsListMs: diff("tools-sent", "tools-response"),
      readyMs: ok ? diff("begin", "tools-response") : null,
      cleanupMs: ok ? diff("shutdown-start", "closed") : null,
      terminated: outcome.terminated,
    });
    if (!outcome.terminated) stop = "termination";
  }
  const measured = runs.filter((r) => r.phase === "measured");
  const good = measured.filter((r) => r.status === "succeeded");
  const report = benchmarkReportSchema.parse({
    schemaVersion: BENCHMARK_REPORT_SCHEMA_VERSION,
    kind: "openhub-benchmark-report",
    toolId: plan.toolId,
    planDigest: verified.planDigest,
    environment: {
      os: plan.platform,
      arch: options.host.arch,
      nodeVersion: options.host.nodeVersion,
      backend: launch.executable,
      toolVersion: plan.artifact.resolved?.version ?? (plan.artifact.resolved?.digest ? plan.artifact.resolved.digest.slice(0, 19) : null),
      serverInfo,
    },
    runs,
    summary: {
      measured: 5,
      succeeded: good.length,
      failed: measured.length - good.length,
      startupMs: statOf(good.map((r) => (r.spawnMs === null || r.initializeMs === null ? null : r.spawnMs + r.initializeMs))),
      initializeMs: statOf(good.map((r) => r.initializeMs)),
      toolsListMs: statOf(good.map((r) => r.toolsListMs)),
      readyMs: statOf(good.map((r) => r.readyMs)),
      cleanupMs: statOf(good.map((r) => r.cleanupMs)),
    },
    notes: [...BENCHMARK_REPORT_NOTES],
  });
  return { ok: true, report };
}

/** 사람이 읽는 결과 줄(CLI·Desktop 공용). */
export function formatBenchmarkReport(r: BenchmarkReportV1): string[] {
  const s = (x: { median: number; min: number; max: number } | null) => (x === null ? "측정 실패" : "median " + String(x.median) + " ms · min " + String(x.min) + " · max " + String(x.max));
  const lines = ["Benchmark " + r.toolId + " — 측정 " + String(r.summary.measured) + "회 중 성공 " + String(r.summary.succeeded) + " · 실패 " + String(r.summary.failed)];
  lines.push("  준비 완료(ready)  " + s(r.summary.readyMs));
  lines.push("  시작(startup)     " + s(r.summary.startupMs));
  lines.push("  initialize        " + s(r.summary.initializeMs));
  lines.push("  tools/list        " + s(r.summary.toolsListMs));
  lines.push("  정리(cleanup)     " + s(r.summary.cleanupMs));
  lines.push("환경: " + r.environment.os + " " + r.environment.arch + " · Node " + r.environment.nodeVersion + " · " + r.environment.backend + (r.environment.toolVersion === null ? "" : " " + r.environment.toolVersion));
  for (const run of r.runs.filter((x) => x.status !== "succeeded")) lines.push("  회차 " + String(run.index) + " (" + run.phase + "): " + run.status + (run.reason === null ? "" : " — " + run.reason));
  for (const n of r.notes) lines.push("참고: " + n);
  return lines;
}

