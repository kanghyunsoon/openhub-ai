// v0.2.0 RC 결과 판정기. packaged-rc.mjs run이 쓴 결과 JSON을 읽어 RC 통과 여부를 정한다(fail-closed).
// - 필수 단계(3~14)는 모두 PASS여야 한다. 단계 1·2·15는 workflow 단계가 직접 실패를 낸다.
// - FAIL인 단계·check, errors 항목, 빠진 단계, 알 수 없는 상태, 실패 주입 흔적은 모두 실패다.
// - (v0.2.1) 필수 check ID 집합(OS별)이 정확히 있어야 한다. 빈 checks, 빠진 필수 check, 모르는 이름(오타 포함)은 모두 실패다.
// - NOT-RUN 단계는 실패다. 세부 NOT-RUN 항목(notRun[])은 아래 허용 목록에 있는 id·단계·OS일 때만 허용하고 기록한다.
// 사용: node scripts/rc/check-rc-result.mjs <result.json> [--os windows|linux]
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const REQUIRED_STEPS = [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14];
const STATUSES = new Set(["PASS", "FAIL", "NOT-RUN"]);

/**
 * 하네스(packaged-rc.mjs)가 OS마다 반드시 기록하는 check ID. 하네스에 check를 더하거나 빼면 이 표와 테스트를 함께 바꾼다.
 * Linux만 OS 언어를 바꿀 수 있어 한국어 첫 실행 check가 있다(Windows는 NOT-RUN 허용 목록).
 * @type {Readonly<Record<"windows" | "linux", readonly string[]>>}
 */
export const REQUIRED_CHECKS = Object.freeze({
  windows: Object.freeze(["reject-writes-nothing", "plan-stale-blocks-and-keeps-external-change", "install-prepared-exact-version", "kubernetes-secret-denied-configmap-read-no-token", "kubernetes-reviewed-tool-config", "kubernetes-only-0.0.67", "health-failure-compensation", "app-version-shown"]),
  linux: Object.freeze(["reject-writes-nothing", "plan-stale-blocks-and-keeps-external-change", "install-prepared-exact-version", "kubernetes-secret-denied-configmap-read-no-token", "kubernetes-reviewed-tool-config", "kubernetes-only-0.0.67", "health-failure-compensation", "app-version-shown", "first-start-follows-os-korean"]),
});

/**
 * 실제로 수행할 수 없어 기록만 하는 세부 항목. 여기에 없는 NOT-RUN은 RC 실패다.
 * 항목을 줄이는 것은 자유지만 늘리려면 이유를 docs/specs/v0.2.0-rc-verification.md에 남긴다.
 * @type {Readonly<Record<string, { step: number; os: readonly string[]; reason: string }>>}
 */
export const ALLOWED_NOT_RUN = Object.freeze({
  "korean-os-first-start": { step: 3, os: ["windows"], reason: "the Windows runner's OS display language cannot be switched" },
});

/**
 * @param {unknown} result packaged-rc.mjs run 결과(JSON.parse 값)
 * @param {{ os?: string; requiredSteps?: readonly number[]; allowedNotRun?: typeof ALLOWED_NOT_RUN; requiredChecks?: typeof REQUIRED_CHECKS }} [options]
 * @returns {{ ok: boolean; failures: string[]; notRunRecorded: { id: string; step: number; reason: string }[] }}
 */
export function checkRcResult(result, options = {}) {
  /** @type {string[]} */
  const failures = [];
  /** @type {{ id: string; step: number; reason: string }[]} */
  const notRunRecorded = [];
  const requiredSteps = options.requiredSteps ?? REQUIRED_STEPS;
  const allowed = options.allowedNotRun ?? ALLOWED_NOT_RUN;
  const requiredChecks = options.requiredChecks ?? REQUIRED_CHECKS;
  if (!isRecord(result)) return { ok: false, failures: ["result is not an object"], notRunRecorded };
  const os = result["os"];
  if (os !== "windows" && os !== "linux") failures.push("os: expected windows or linux, got " + JSON.stringify(os));
  if (options.os !== undefined && os !== options.os) failures.push("os: expected " + options.os + ", got " + JSON.stringify(os));
  if (result["injected"] !== undefined) failures.push("injected failure: " + JSON.stringify(result["injected"]));

  const steps = result["steps"];
  if (!isRecord(steps)) failures.push("steps: missing");
  else {
    for (const n of requiredSteps) {
      const s = steps[String(n)];
      if (s === undefined) failures.push("step " + n + ": missing");
      else if (!isRecord(s) || !STATUSES.has(String(s["status"]))) failures.push("step " + n + ": unknown status " + JSON.stringify(isRecord(s) ? s["status"] : s));
      else if (s["status"] !== "PASS") failures.push("step " + n + ": " + String(s["status"]));
    }
    for (const [n, s] of Object.entries(steps)) if (!requiredSteps.includes(Number(n)) && (!isRecord(s) || s["status"] !== "PASS")) failures.push("step " + n + ": unexpected and not PASS");
  }

  const checks = result["checks"];
  if (!isRecord(checks)) failures.push("checks: missing");
  else {
    const expected = os === "windows" || os === "linux" ? requiredChecks[os] : [];
    for (const name of expected) if (!Object.hasOwn(checks, name)) failures.push("check " + name + ": missing");
    for (const [name, c] of Object.entries(checks)) {
      if (!expected.includes(name)) failures.push("check " + name + ": unknown check id");
      else if (!isRecord(c) || c["status"] !== "PASS") failures.push("check " + name + ": " + (isRecord(c) ? String(c["status"]) : "malformed"));
    }
  }

  const errors = result["errors"];
  if (!Array.isArray(errors)) failures.push("errors: missing");
  else for (const e of errors) failures.push("error: " + String(e).split(/\r?\n/u)[0]);

  const notRun = result["notRun"];
  if (!Array.isArray(notRun)) failures.push("notRun: missing");
  else
    for (const item of notRun) {
      const id = isRecord(item) && typeof item["id"] === "string" ? item["id"] : null;
      const rule = id !== null && Object.hasOwn(allowed, id) ? allowed[id] : undefined;
      if (id === null || rule === undefined) failures.push("NOT-RUN not allowed: " + JSON.stringify(item));
      else if (!isRecord(item) || item["step"] !== rule.step) failures.push("NOT-RUN " + id + ": expected step " + rule.step);
      else if (!rule.os.includes(String(os))) failures.push("NOT-RUN " + id + ": not allowed on " + String(os));
      else notRunRecorded.push({ id, step: rule.step, reason: rule.reason });
    }
  return { ok: failures.length === 0, failures, notRunRecorded };
}

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isRecord(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/** @param {{ ok: boolean; failures: string[]; notRunRecorded: { id: string; step: number; reason: string }[] }} verdict */
export function formatVerdict(verdict) {
  return [
    verdict.ok ? "RC result: PASS" : "RC result: FAIL",
    ...verdict.failures.map((f) => "  FAIL " + f),
    ...verdict.notRunRecorded.map((n) => "  NOT-RUN (allowed) step " + n.step + " " + n.id + ": " + n.reason),
  ].join("\n");
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const i = process.argv.indexOf("--os");
  const os = i >= 0 ? process.argv[i + 1] : undefined;
  let verdict;
  try {
    if (file === undefined || file.startsWith("--")) throw new Error("usage: check-rc-result.mjs <result.json> [--os windows|linux]");
    verdict = checkRcResult(JSON.parse(readFileSync(file, "utf8")), os === undefined ? {} : { os });
  } catch (error) {
    verdict = { ok: false, failures: ["cannot read result: " + (error instanceof Error ? error.message : String(error))], notRunRecorded: [] };
  }
  console.log(formatVerdict(verdict));
  process.exit(verdict.ok ? 0 : 1);
}
