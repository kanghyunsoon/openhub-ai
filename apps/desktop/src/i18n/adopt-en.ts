import type {
  AdoptApprovalRequirement,
  AdoptBlockerCode,
  AdoptResultV1,
  BenchmarkApprovalRequirement,
  BenchmarkBlockerCode,
  BenchmarkReportV1,
  PlannedAdopt,
  PlannedBenchmark,
} from "@openhub/core";
import { blockerSentenceEn } from "./core-en";

/**
 * Adopt·Benchmark 영어 표시(Desktop English 모드 전용, v0.2.0 P0-3 PR B 보완). 실행 승인 화면이므로 Core 한국어 Preview를 쓰지 않는다.
 * - Plan·Result·Report 구조(code·ID·필드)에서 영어 문장을 만든다. Core 문장을 찾거나 바꾸지 않는다.
 * - Core Preview(formatAdoptPlanPreview·formatBenchmarkPlanPreview)와 같은 순서·같은 정보. 승인 요구 ID는 모두 그대로 보인다.
 * - 영어 문장이 없는 code는 code와 Core 원문을 그대로 두고 미번역으로 표시한다(정보를 버리지 않는다).
 */

const CLIENT: Readonly<Record<string, string>> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };
const clientName = (c: string) => CLIENT[c] ?? c;
const untranslated = (message: string) => "(not translated) " + message;

export const ADOPT_APPROVAL_EN: Readonly<Record<AdoptApprovalRequirement, string>> = {
  base: "I reviewed the adopt plan above (the configuration entry to register as managed and one Version State write) and agree to register it. No configuration file changes and nothing runs.",
  "identity-strong-match":
    "The server name differs from the Registry name, but the package or image matches exactly and there is only one candidate, so OpenHub identified it as the same tool (strong). I confirm this identification.",
  "artifact-unlocked": "The artifact version in the configuration is not pinned. OpenHub does not record an exact version and manages it as artifact-unlocked.",
  "user-scope-target": "Registers an entry in user configuration outside the project (home directory). It is the same entry for other projects.",
};

export const BENCHMARK_APPROVAL_EN: Readonly<Record<BenchmarkApprovalRequirement, string>> = {
  base: "I reviewed the Benchmark plan above (the MCP server, third-party code, runs 6 times in an isolated temporary directory, no tool calls) and agree to run it.",
  "environment-unverified": "This tool needs environment variables to run, but OpenHub does not check their values or whether they are set. If they are not set, the runs may fail.",
  "artifact-fetch": "npx, uvx or docker may download the pinned artifact (network use).",
};

const ADOPT_GRADE_EN: Readonly<Record<string, string>> = {
  exact: "exact — the server name and the package or image both match the Registry",
  strong: "strong — the server name differs, but the package or image matches exactly and there is one candidate",
  weak: "weak — only the name is similar (cannot adopt)",
  unresolved: "unresolved — no identifying evidence (cannot adopt)",
};

export const ADOPT_BLOCKER_EN: Readonly<Record<AdoptBlockerCode, string>> = {
  ADOPT_IDENTITY_WEAK: "Only the name is similar and there is no package or image evidence (weak). This entry cannot be adopted.",
  ADOPT_IDENTITY_UNRESOLVED: "OpenHub could not identify this entry as a Registry tool (unresolved).",
  ADOPT_IDENTITY_MISMATCH: "This entry is identified as a different Registry tool.",
  ADOPT_ALREADY_MANAGED: "This entry is already managed in Version State.",
  ADOPT_ENTRY_UNSUPPORTED: "OpenHub cannot represent this entry for adopt (for example a file where OpenHub reads only server names, D-003).",
};

export const BENCHMARK_BLOCKER_EN: Readonly<Record<BenchmarkBlockerCode, string>> = {
  BENCHMARK_NOT_MANAGED: "There is no entry managed in Version State. Install or adopt the tool before running Benchmark.",
  BENCHMARK_ARTIFACT_UNLOCKED: "The artifact is not pinned (artifact-unlocked), so repeated runs are not guaranteed to use the same artifact. Pin it with update first.",
  BENCHMARK_CONFIG_DRIFT: "The configuration entry differs from Version State (config-drift or missing-config).",
  BENCHMARK_UNSUPPORTED: "Only tools checked with an MCP stdio handshake can be benchmarked (Pinokio, HTTP and similar are excluded).",
  BENCHMARK_ARTIFACT_MISMATCH: "The launch arguments do not contain the artifact pinned in Version State.",
};

/** Adopt·Benchmark 계획·실행 오류 code(Plan 생성 실패, 승인 gate, 실행 전 확인). */
export const ADOPT_BENCHMARK_ERROR_EN: Readonly<Record<string, string>> = {
  ADOPT_TARGET_NOT_FOUND: "There is no server entry to adopt in that configuration file.",
  ADOPT_TARGET_AMBIGUOUS: "Several entries are identified as this tool. Choose one server name.",
  ADOPT_INVALID_SERVER_NAME: "The server name format is invalid.",
  ADOPT_CONFIG_UNPARSEABLE: "The configuration file could not be parsed.",
  CONFIG_PATH_ESCAPE: "The configuration path points outside the allowed location (symlink or junction).",
  BENCHMARK_TARGET_AMBIGUOUS: "Several managed entries match. Choose one client and scope.",
  BENCHMARK_LAUNCHER_NOT_FOUND: "The Windows npx launch path (node.exe and npx-cli.js) was not found.",
  VERIFIED_PLAN_CONSUMED: "This Benchmark plan was already run. Approve it again.",
  APPROVAL_REQUIRED: "The plan was not approved.",
  APPROVAL_INCOMPLETE: "Not every approval item was approved.",
  APPROVAL_CONSUMED: "This approval was already used. Review the plan and approve again.",
  PLAN_NOT_EXECUTABLE: "This plan cannot be executed.",
  PLAN_REGENERATION_FAILED: "The plan could not be created again right before running, so nothing was run.",
  PLAN_STALE: "The plan changed after approval, so nothing was run. Review the new plan and approve again.",
};

/** 오류 code 하나 → 영어 문장. 없으면 Core 원문을 미번역으로 그대로 둔다. */
export function adoptBenchmarkErrorEn(code: string, message: string): string {
  return ADOPT_BENCHMARK_ERROR_EN[code] ?? blockerSentenceEn(code) ?? untranslated(message);
}

const blockerLine = (table: Readonly<Record<string, string>>, b: { code: string; message: string }) => "Blocked: " + b.code + " — " + (table[b.code] ?? untranslated(b.message));

/** AdoptPlan Preview(영어). Core formatAdoptPlanPreview와 같은 순서·같은 정보. */
export function adoptPreviewEn(planned: PlannedAdopt): string[] {
  const p = planned.plan;
  const lines: string[] = [];
  lines.push("Adopt plan: " + p.toolId + " (" + p.status + ")");
  lines.push("Target: " + clientName(p.target.client) + " · " + p.target.scope + " · " + p.target.file + " · server " + p.target.serverName);
  lines.push("Identification: " + (ADOPT_GRADE_EN[p.identity.grade] ?? p.identity.grade) + " [" + p.identity.reason + "]");
  lines.push("  Matched artifact: " + (p.identity.artifactKey ?? "(none)"));
  lines.push("  Current server name: " + p.identity.serverName);
  lines.push("  Registry name: " + p.toolId + (p.identity.canonicalAlias === null ? "" : " (canonical alias " + p.identity.canonicalAlias + ")"));
  if (p.launch !== null && p.backend !== null) lines.push("Launch (kept as configured): " + p.backend + " · " + [p.launch.clientSpec.command, ...p.launch.clientSpec.args].join(" "));
  if (p.artifact !== null) {
    lines.push(
      p.artifact.lock === "locked"
        ? "Artifact: " + p.artifact.requested + " (the spec pinned in the configuration is recorded)"
        : "Artifact: " + p.artifact.requested + " (artifact-unlocked: the version is not pinned, so no exact artifact is recorded)",
    );
  }
  lines.push("Effects: " + String(p.effects.stateWrite) + " Version State write · " + String(p.effects.configWrite) + " configuration file changes · " + String(p.effects.spawn) + " processes run · " + String(p.effects.network) + " network use");
  lines.push("Health: Not verified (adopt does not run the MCP server)");
  for (const b of p.blockers) lines.push(blockerLine(ADOPT_BLOCKER_EN, b));
  if (p.status === "ready") {
    lines.push("Approval items:");
    for (const r of p.approvalRequirements) lines.push("  [" + r + "] " + ADOPT_APPROVAL_EN[r]);
  }
  lines.push("Plan digest: " + planned.planDigest);
  return lines;
}

const seconds = (ms: number) => String(ms / 1000) + " s";

/** BenchmarkPlan Preview(영어). 실행 횟수·제한 시간·외부 코드 실행·Health와의 관계를 Plan 구조에서 보여 준다. */
export function benchmarkPreviewEn(planned: PlannedBenchmark): string[] {
  const p = planned.plan;
  const total = p.runs.warmup + p.runs.measured;
  const lines = ["Benchmark plan: " + p.toolId + " (" + p.status + ")"];
  if (p.target !== null) lines.push("Target: " + clientName(p.target.client) + " · " + p.target.scope + " · " + p.target.file + " · server " + p.target.serverName);
  if (p.artifact.resolved !== null) lines.push("Artifact (pinned): " + p.artifact.resolved.spec);
  if (p.launch !== null) lines.push("Run: " + [p.launch.executable, ...p.launch.args].join(" ") + " (isolated temporary directory, no shell)");
  lines.push(
    "Runs: " + String(p.runs.warmup) + " warm-up + " + String(p.runs.measured) + " measured — the MCP server is started " + String(total) + " times · limits: startup " + seconds(p.timeouts.startupMs) + " · handshake " + seconds(p.timeouts.handshakeMs) + " · " + seconds(p.timeouts.runTotalMs) + " per run · " + seconds(p.timeouts.planTotalMs) + " total",
  );
  lines.push("Each run starts the MCP server (third-party code) and measures only " + p.protocol.methods.filter((m) => m !== "notifications/initialized").join(" and ") + " response times. No MCP tool is called (tools/call 0).");
  if (p.launch !== null && p.launch.envNames.length > 0) lines.push("Environment variables passed by name only (values are not read or shown): " + p.launch.envNames.join(", "));
  lines.push("This is not a Health Check: Version State and the recorded Health status do not change. A failed run is reported, not hidden.");
  lines.push("Result: median, min, max and failure count (no p95, peak RSS not measured). Meaningful only on this machine and not saved.");
  for (const b of p.blockers) lines.push(blockerLine(BENCHMARK_BLOCKER_EN, b));
  if (p.status === "ready") {
    lines.push("Approval items:");
    for (const r of p.approvalRequirements) lines.push("  [" + r + "] " + BENCHMARK_APPROVAL_EN[r]);
  }
  lines.push("Plan digest: " + planned.planDigest);
  return lines;
}

/** AdoptResult(영어). */
export function adoptResultEn(r: AdoptResultV1): string[] {
  if (r.status === "adopted") return ["Adopt completed: " + r.toolId + " (Version State revision 1). Configuration files were not changed.", "Health: Not verified (check it with lifecycle health)"];
  const lines = ["Adopt " + r.status + ": " + r.toolId + (r.error === null ? "" : " — " + r.error.code + ": " + adoptBenchmarkErrorEn(r.error.code, r.error.message))];
  if (r.changed.length > 0) lines.push("Changed: " + r.changed.join(", "));
  lines.push("Version State and configuration files were not changed.");
  return lines;
}

const NOTE_EN: Readonly<Record<string, string>> = {
  "p95 not reported (5 measured runs)": "p95 not reported (5 measured runs)",
  "peak RSS not measured": "peak RSS not measured",
  "results are local to this machine and are not comparable across machines": "results are local to this machine and are not comparable across machines",
};

/** BenchmarkReport(영어). 실패한 회차는 모두 보인다. */
export function benchmarkReportEn(r: BenchmarkReportV1): string[] {
  const s = (x: { median: number; min: number; max: number } | null) => (x === null ? "measurement failed" : "median " + String(x.median) + " ms · min " + String(x.min) + " · max " + String(x.max));
  const lines = ["Benchmark " + r.toolId + " — " + String(r.summary.succeeded) + " of " + String(r.summary.measured) + " measured runs succeeded · " + String(r.summary.failed) + " failed"];
  lines.push("  ready             " + s(r.summary.readyMs));
  lines.push("  startup           " + s(r.summary.startupMs));
  lines.push("  initialize        " + s(r.summary.initializeMs));
  lines.push("  tools/list        " + s(r.summary.toolsListMs));
  lines.push("  cleanup           " + s(r.summary.cleanupMs));
  lines.push("Environment: " + r.environment.os + " " + r.environment.arch + " · Node " + r.environment.nodeVersion + " · " + r.environment.backend + (r.environment.toolVersion === null ? "" : " " + r.environment.toolVersion));
  for (const run of r.runs.filter((x) => x.status !== "succeeded")) lines.push("  Run " + String(run.index) + " (" + run.phase + "): " + run.status + (run.reason === null ? "" : " — " + run.reason));
  for (const n of r.notes) lines.push("Note: " + (NOTE_EN[n] ?? n));
  return lines;
}

