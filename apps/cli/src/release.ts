import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  INSTALL_CLIENTS,
  SUMMARY_CATEGORIES,
  analyzeUpdateImpact,
  collectReleaseSnapshot,
  formatRegistryIssue,
  loadRegistry,
  openAiProviderFromCli,
  probeBackends,
  projectKeyFor,
  readConfiguredEntry,
  readLifecycleState,
  releaseRequestOf,
  resolveGitHubToken,
  runLlmSummary,
  summarizeReleases,
  type LifecyclePlanV1,
  type LlmSummaryResult,
  type Manifest,
  type ReleaseRequest,
  type ReleaseSnapshotV1,
  type ReleaseSummaryV1,
  type ToolState,
  type UpdateImpactV1,
} from "@openhub/core";
import { registryDirOf } from "./paths";
import type { LifecycleCommandIO } from "./lifecycle";

/**
 * openhub releases·impact와 update Preview 머리말(TASK-056, D-022·D-023·D-024).
 * - 실행·쓰기가 없다(network 조회와 표시뿐). --json도 같다. --yes·-y·--approve는 exit 2다.
 * - GitHub 인증은 CLI 계층에서만 D-007(GITHUB_TOKEN → GH_TOKEN → gh auth token)로 해석해 opaque 값으로 core에 넘긴다. --no-token이면 비인증.
 * - LLM 요약은 --llm-summary --llm-model <id>일 때만, OPENAI_API_KEY 하나만 읽는다(표시 전용). 출력에 token·key·env 값·절대 경로가 없다.
 */

export interface ReleaseCommandIO extends LifecycleCommandIO {
  resolveToken?: () => Promise<{ token: string; source: string } | undefined>;
  /** LLM provider용 환경변수(테스트 주입). 기본 process.env. */
  env?: Readonly<Record<string, string | undefined>>;
}

const FORBIDDEN_FLAGS = /^(?:--yes|-y|--approve|--auto-approve|--force)(?:=.*)?$/u;
export function rejectAutoApprove(argv: readonly string[], io: { err(line: string): void }): boolean {
  const bad = argv.find((a) => FORBIDDEN_FLAGS.test(a));
  if (bad === undefined) return false;
  io.err(bad.split("=")[0] + "는 지원하지 않습니다. OpenHub는 자동 승인 옵션이 없습니다.");
  return true;
}

const CATEGORY_LABEL: Readonly<Record<(typeof SUMMARY_CATEGORIES)[number], string>> = { breaking: "Breaking", security: "Security", compatibility: "Compatibility", performance: "Performance", fix: "Fix", other: "Other" };
const NOTES_PREVIEW_LINES = 12;
const oneLine = (s: string, max = 160) => s.replace(/[\u0000-\u001f\u007f]/gu, " ").slice(0, max);

interface Context {
  manifest: Manifest;
  state: ToolState | null;
  projectRoot: string;
  homeDir: string;
}

async function contextOf(toolId: string, values: { project?: string; client?: string[]; scope?: string }, io: ReleaseCommandIO): Promise<Context | string> {
  const { entries, issues } = await loadRegistry(registryDirOf(io));
  for (const issue of issues) io.err("경고: " + formatRegistryIssue(issue));
  const manifest = entries.find((e) => e.manifest.name === toolId)?.manifest;
  if (manifest === undefined) return "Registry에 없는 Tool입니다. openhub registry list로 Tool ID를 확인하세요.";
  const projectRoot = path.resolve(io.cwd, values.project ?? ".");
  const homeDir = io.homeDir ?? os.homedir();
  const read = await readLifecycleState({ homeDir, ...(io.configFs === undefined ? {} : { fs: io.configFs }) });
  let state: ToolState | null = null;
  if (read.ok) {
    const key = await projectKeyFor(projectRoot).catch(() => null);
    const scope = values.scope === "user" ? "user" : "project";
    state =
      Object.values(read.state.entries).find(
        (e) => e.toolId === toolId && e.target.scope === scope && (scope === "user" || e.target.projectKey === key) && ((values.client ?? []).length === 0 || (values.client ?? []).includes(e.target.client)),
      ) ?? null;
  }
  return { manifest, state, projectRoot, homeDir };
}

async function tokenOf(io: ReleaseCommandIO, noToken: boolean): Promise<string | undefined> {
  if (noToken) return undefined;
  const found = await (io.resolveToken ?? (() => resolveGitHubToken()))().catch(() => undefined);
  return found?.token;
}

function requestOf(ctx: Context): ReleaseRequest | null {
  const base = releaseRequestOf(ctx.manifest);
  if (base === null) return null;
  if (ctx.state === null) return { ...base, github: ctx.manifest.repository.github };
  return { ...base, backend: ctx.state.backend, requested: ctx.state.artifact.requested, resolved: ctx.state.artifact.resolved, github: ctx.manifest.repository.github };
}

export async function snapshotOf(request: ReleaseRequest, io: ReleaseCommandIO, opts: { token?: string; prerelease?: boolean }) {
  return collectReleaseSnapshot(request, {
    now: io.now ?? (() => new Date()),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    ...(opts.token === undefined ? {} : { githubToken: opts.token }),
    ...(opts.prerelease === true ? { includePrerelease: true } : {}),
  });
}

export function formatSummary(summary: ReleaseSummaryV1): string[] {
  const lines: string[] = [];
  for (const c of SUMMARY_CATEGORIES) {
    const items = summary.categories[c];
    lines.push("  " + CATEGORY_LABEL[c].padEnd(14) + String(items.length) + (summary.omitted[c] > 0 ? " (+" + String(summary.omitted[c]) + " 생략)" : ""));
    for (const i of items.slice(0, 5)) lines.push("    - [" + i.version + " L" + String(i.line) + "] " + oneLine(i.text));
    if (items.length > 5) lines.push("    … " + String(items.length - 5) + "개 더 (--json)");
  }
  if (summary.notesMissing.length > 0) lines.push("  notes 없음: " + summary.notesMissing.join(", "));
  if (summary.notesTruncated.length > 0) lines.push("  64 KiB에서 잘린 notes: " + summary.notesTruncated.join(", "));
  return lines;
}

export function formatReleases(manifest: Manifest, snap: ReleaseSnapshotV1, summary: ReleaseSummaryV1, llm: LlmSummaryResult | null): string[] {
  const t = snap.target;
  const lines = [(manifest.displayName ?? manifest.name) + " (" + manifest.name + ") 릴리스", ""];
  lines.push("버전 출처   " + snap.versionSource + " · notes " + snap.notesSource);
  lines.push("현재        " + (snap.current.version ?? "확인되지 않음(고정되지 않은 설치 또는 미설치)"));
  lines.push("최신        " + (t === null ? "비교할 수 없음" : t.version + (t.prerelease ? " (prerelease)" : "") + (t.yanked ? " (yanked)" : "") + (t.publishedAt === null ? "" : " · 게시 " + t.publishedAt.slice(0, 10))));
  if (t?.deprecated) lines.push("deprecated  " + oneLine(t.deprecated));
  if (snap.between.length > 0) lines.push("포함 릴리스 " + snap.between.map((e) => e.version).join(", ") + (snap.selection.truncated ? " …" : ""));
  lines.push("", "요약(결정론 분류, 근거 [버전 L줄])");
  lines.push(...formatSummary(summary));
  if (t?.notes) {
    const noteLines = t.notes.text.split(/\r\n|\n|\r/u);
    lines.push("", "Release notes " + t.version + " (원문 일부, 해석하지 않음)");
    for (const l of noteLines.slice(0, NOTES_PREVIEW_LINES)) lines.push("  | " + oneLine(l, 200));
    if (noteLines.length > NOTES_PREVIEW_LINES) lines.push("  … 원문 " + String(noteLines.length - NOTES_PREVIEW_LINES) + "줄 더 (--json)");
  }
  if (t?.url) lines.push("", "링크        " + t.url);
  if (llm !== null) {
    lines.push("");
    if (llm.status === "ok") lines.push("LLM 요약(표시 전용, " + llm.model + "):", ...llm.text.split(/\r?\n/u).map((l) => "  " + oneLine(l, 200)));
    else lines.push("LLM 요약 사용 불가(" + llm.reason + ") — 위 결정론 요약이 기준입니다");
  }
  return lines;
}

export function formatImpact(manifest: Manifest, impact: UpdateImpactV1): string[] {
  const lines = [(manifest.displayName ?? manifest.name) + " (" + manifest.name + ") 업데이트 영향", ""];
  lines.push("버전        " + (impact.from.version ?? "확인되지 않음") + " → " + (impact.to.version ?? "비교할 수 없음"));
  lines.push("판정        " + impact.verdict.toUpperCase() + " (" + impact.status + ")");
  lines.push("이유");
  if (impact.reasons.length === 0) lines.push("  - 변경 신호 없음");
  for (const r of impact.reasons) lines.push("  - " + r.code + " (" + r.level + ")");
  lines.push("근거");
  for (const e of impact.evidence.slice(0, 20)) lines.push("  - " + e.kind + " " + e.source + ": " + oneLine(e.ref));
  if (impact.evidence.length > 20) lines.push("  … " + String(impact.evidence.length - 20) + "개 더 (--json)");
  lines.push("영향 파일   " + impact.affectedFiles.join(", "));
  lines.push("", "Impact는 판단 근거이며 승인이 아닙니다. 실행은 openhub update의 계획·승인을 거칩니다.");
  return lines;
}

async function configEnvNames(ctx: Context, io: ReleaseCommandIO): Promise<string[]> {
  if (ctx.state === null) return [];
  const t = ctx.state.target;
  const entry = await readConfiguredEntry(t.client, t.scope, t.serverName, { projectRoot: ctx.projectRoot, homeDir: ctx.homeDir, ...(io.configFs === undefined ? {} : { fs: io.configFs }) }).catch(() => undefined);
  if (entry === null || typeof entry !== "object") return [];
  const e = entry as Record<string, unknown>;
  const names = e["env"] !== null && typeof e["env"] === "object" ? Object.keys(e["env"] as object) : Array.isArray(e["env_vars"]) ? (e["env_vars"] as unknown[]).filter((x): x is string => typeof x === "string") : [];
  return names.filter((n) => /^[A-Z][A-Z0-9_]*$/u.test(n)).sort();
}

async function runtimesOf(io: ReleaseCommandIO) {
  const probes = await (io.probe ?? (() => probeBackends()))().catch(() => null);
  return { node: probes?.node.version ?? null, python: null };
}

const COMMON_OPTIONS = {
  project: { type: "string" },
  client: { type: "string", multiple: true },
  scope: { type: "string", default: "project" },
  json: { type: "boolean", default: false },
  "no-token": { type: "boolean", default: false },
} as const;

function parse(argv: readonly string[], extra: Record<string, { type: "string" | "boolean"; default?: boolean }>, io: ReleaseCommandIO, usage: string) {
  try {
    const parsed = parseArgs({ args: [...argv], options: { ...COMMON_OPTIONS, ...extra }, allowPositionals: true, strict: true });
    if (parsed.positionals.length !== 1) {
      io.err("Tool ID를 하나 지정하세요\n\n" + usage);
      return null;
    }
    const v = parsed.values as Record<string, unknown>;
    if (v["scope"] !== "project" && v["scope"] !== "user") {
      io.err("--scope는 project 또는 user입니다");
      return null;
    }
    if (((v["client"] as string[] | undefined) ?? []).some((c) => !(INSTALL_CLIENTS as readonly string[]).includes(c))) {
      io.err("--client는 " + INSTALL_CLIENTS.join(", ") + " 중 하나입니다");
      return null;
    }
    return { toolId: parsed.positionals[0] as string, values: v };
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return null;
  }
}

/** openhub releases <toolId> — 0 성공, 1 조회 실패, 2 인자 오류 */
export async function runReleases(argv: readonly string[], io: ReleaseCommandIO, usage: string): Promise<number> {
  if (rejectAutoApprove(argv, io)) return 2;
  const p = parse(argv, { prerelease: { type: "boolean", default: false }, "llm-summary": { type: "boolean", default: false }, "llm-model": { type: "string" } }, io, usage);
  if (p === null) return 2;
  const v = p.values as { project?: string; client?: string[]; scope: string; json: boolean; "no-token": boolean; prerelease: boolean; "llm-summary": boolean; "llm-model"?: string };
  const ctx = await contextOf(p.toolId, v, io);
  if (typeof ctx === "string") {
    io.err(ctx);
    return 2;
  }
  const request = requestOf(ctx);
  if (request === null) {
    io.err("이 도구의 버전 출처(" + ctx.manifest.update.source + ")는 지원하지 않습니다.");
    return 1;
  }
  const token = await tokenOf(io, v["no-token"]);
  const snap = await snapshotOf(request, io, { ...(token === undefined ? {} : { token }), prerelease: v.prerelease });
  if (!snap.ok) {
    io.err("release 정보를 가져오지 못했습니다 (" + snap.code + "). " + snap.message + (snap.resetAt === null ? "" : " 재시도 가능 시각: " + snap.resetAt));
    return 1;
  }
  const summary = summarizeReleases(snap.snapshot);
  let llm: LlmSummaryResult | null = null;
  if (v["llm-summary"]) {
    const made = openAiProviderFromCli({ llmSummary: true, llmModel: v["llm-model"] ?? null }, io.env ?? process.env, io.fetch === undefined ? {} : { fetch: io.fetch });
    llm = made.provider === null ? { status: "unavailable", reason: made.unavailable ?? "not-configured" } : await runLlmSummary(summary, snap.snapshot, made.provider);
  }
  if (v.json) {
    io.out(JSON.stringify({ snapshot: snap.snapshot, summary, ...(llm === null ? {} : { llm }) }, null, 2));
    return 0;
  }
  for (const line of formatReleases(ctx.manifest, snap.snapshot, summary, llm)) io.out(line);
  return 0;
}

/** openhub impact <toolId> [--to <version>] — 0 성공, 1 조회 실패, 2 인자 오류 */
export async function runImpact(argv: readonly string[], io: ReleaseCommandIO, usage: string): Promise<number> {
  if (rejectAutoApprove(argv, io)) return 2;
  const p = parse(argv, { to: { type: "string" }, prerelease: { type: "boolean", default: false } }, io, usage);
  if (p === null) return 2;
  const v = p.values as { project?: string; client?: string[]; scope: string; json: boolean; "no-token": boolean; to?: string; prerelease: boolean };
  const ctx = await contextOf(p.toolId, v, io);
  if (typeof ctx === "string") {
    io.err(ctx);
    return 2;
  }
  if (ctx.state === null) {
    io.err("Version State에 " + p.toolId + " 기록이 없습니다. openhub install로 설치한 도구의 업데이트 영향만 계산합니다.");
    return 1;
  }
  const request = requestOf(ctx);
  if (request === null) {
    io.err("이 도구의 버전 출처(" + ctx.manifest.update.source + ")는 지원하지 않습니다.");
    return 1;
  }
  const token = await tokenOf(io, v["no-token"]);
  const snap = await snapshotOf(request, io, { ...(token === undefined ? {} : { token }), prerelease: v.prerelease || (v.to !== undefined && /[-a-z]/iu.test(v.to)) });
  if (!snap.ok) {
    io.err("release 정보를 가져오지 못했습니다 (" + snap.code + "). " + snap.message);
    return 1;
  }
  let snapshot = snap.snapshot;
  if (v.to !== undefined && snapshot.target?.version !== v.to) {
    const pick = snapshot.between.find((e) => e.version === v.to);
    if (pick === undefined) {
      io.err("--to " + v.to + " 버전을 release 목록에서 찾지 못했습니다.");
      return 2;
    }
    snapshot = { ...snapshot, target: pick, between: snapshot.between.filter((e) => e === pick || snapshot.between.indexOf(e) > snapshot.between.indexOf(pick)) };
  }
  const impact = analyzeUpdateImpact({ state: ctx.state, configEnvNames: await configEnvNames(ctx, io), manifest: ctx.manifest, snapshot, runtimes: await runtimesOf(io) });
  if (v.json) {
    io.out(JSON.stringify(impact, null, 2));
    return 0;
  }
  for (const line of formatImpact(ctx.manifest, impact)) io.out(line);
  return 0;
}

/**
 * openhub update Preview 머리말: Update available·Impact·Reasons·Summary. LifecyclePlan은 바꾸지 않는다.
 * GitHub는 비인증으로만 조회한다(업데이트 화면에서 credential을 쓰지 않는다). 실패하면 "확인 불가"로 표시한다.
 */
export async function updateImpactHeader(plan: LifecyclePlanV1, manifest: Manifest, state: ToolState | null, io: ReleaseCommandIO, roots: { projectRoot: string; homeDir: string }): Promise<string[]> {
  const from = plan.current.identity?.version ?? plan.current.requested;
  const to = plan.target.identity?.version ?? plan.target.requested;
  const lines = ["Update available: " + from + " → " + to];
  const base = releaseRequestOf(manifest);
  if (base === null || state === null) return [...lines, "Impact: 확인 불가 (지원하지 않는 버전 출처)", ""];
  const snap = await snapshotOf({ ...base, backend: plan.backend, requested: plan.current.requested, resolved: plan.current.identity, github: manifest.repository.github }, io, {});
  if (!snap.ok) return [...lines, "Impact: 확인 불가 (" + snap.code + ")", "(Impact는 판단 근거이며 승인이 아닙니다)", ""];
  const ctx: Context = { manifest, state, ...roots };
  const impact = analyzeUpdateImpact({ state, configEnvNames: await configEnvNames(ctx, io), manifest, snapshot: snap.snapshot, runtimes: await runtimesOf(io), targetLaunch: { backend: plan.backend, clientSpec: plan.target.clientSpec } });
  const summary = summarizeReleases(snap.snapshot);
  lines.push("Impact: " + impact.verdict.toUpperCase() + " (" + impact.status + ")");
  lines.push("Reasons: " + (impact.reasons.length === 0 ? "없음" : impact.reasons.map((r) => r.code).join(", ")));
  lines.push("Summary: " + SUMMARY_CATEGORIES.map((c) => CATEGORY_LABEL[c] + " " + String(summary.categories[c].length)).join(" · "));
  lines.push("(Impact·Summary는 판단 근거이며 승인이 아닙니다. 아래 계획을 확인하세요)", "");
  return lines;
}

