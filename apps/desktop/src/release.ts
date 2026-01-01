import { readFile, realpath, stat } from "node:fs/promises";
import {
  SUMMARY_CATEGORIES,
  analyzeUpdateImpact,
  collectReleaseSnapshot,
  fetchThirdPartyScript,
  loadRegistry,
  planPinokio,
  probeBackends,
  projectKeyFor,
  readConfiguredEntry,
  readLifecycleState,
  releaseRequestOf,
  summarizeReleases,
  type BackendProbeReport,
  type ConfigFs,
  type FetchLike,
  type PinokioProbeEnv,
  type ReleaseSnapshotV1,
  type ReleaseSummaryV1,
  type ToolState,
} from "@openhub/core";
import type { LifecycleSession } from "./lifecycle";

/**
 * Desktop Release·Impact·Pinokio Preview(TASK-057, D-022·D-024·D-027).
 * - release:check는 INSTALLED 항목 id 하나만 받는다. 버튼을 눌렀을 때만 network를 쓰고 timer·polling이 없다.
 * - GitHub는 비인증 REST만 쓴다. token 자동 탐색·GITHUB_TOKEN·GH_TOKEN·gh auth token 호출이 0회다. rate limit이면 그대로 안내한다.
 * - 결정론 요약만 보여 준다(Desktop LLM 요약 없음). 문자열은 renderer가 textContent로만 넣는다.
 * - Pinokio는 Plan Preview와 제3자 script Preview만 제공한다. 이 모듈에는 실행 채널이 없다(설치는 CLI 승인 흐름).
 */

export const RELEASE_CHECK_CHANNEL = "release:check";
export const PINOKIO_PREVIEW_CHANNEL = "pinokio:preview";
export const PINOKIO_INSPECT_CHANNEL = "pinokio:inspect";

type Listener = (...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
}

export interface ReleaseDeps {
  registryDir: string;
  homeDir: string;
  fetch?: FetchLike;
  probe?: () => Promise<BackendProbeReport>;
  now?: () => Date;
  configFs?: ConfigFs;
  /** Pinokio 비실행 probe 입력(PATH 원문 등). 결과에 남지 않는다. */
  pinokioProbe?: Partial<PinokioProbeEnv>;
  /** [릴리스 확인] 결과를 세션 메모리(AI Summary 입력, TASK-063)에 넘긴다. 디스크에 쓰지 않는다. */
  onSnapshot?: (id: string, snapshot: ReleaseSnapshotV1, summary: ReleaseSummaryV1) => void;
}

export interface ReleaseView {
  id: string;
  title: string;
  current: string;
  latest: string;
  updateAvailable: boolean;
  impact: { verdict: string; status: string; reasons: string[] };
  summary: { label: string; count: number; items: string[] }[];
  notes: { version: string; lines: string[]; more: number } | null;
  url: string | null;
}
export type ReleaseCheckResponse = { status: "ok"; view: ReleaseView } | { status: "no-project" | "not-managed" } | { status: "error"; code: string; message: string };
export type PinokioPreviewResponse = { status: "ok"; lines: string[] } | { status: "error"; code: string; message: string };
export type PinokioInspectResponse =
  | { status: "ok"; preview: { title: string; lines: string[]; warnings: string[]; notice: string } }
  | { status: "error"; code: string; message: string };

const LABEL: Readonly<Record<(typeof SUMMARY_CATEGORIES)[number], string>> = { breaking: "Breaking", security: "Security", compatibility: "Compatibility", performance: "Performance", fix: "Fix", other: "Other" };
const NOTE_LINES = 20;
const clean = (s: string, max = 300) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").slice(0, max);

async function stateFor(session: LifecycleSession, deps: ReleaseDeps, id: unknown): Promise<{ state: ToolState; dir: string } | "no-project" | "not-managed"> {
  const dir = session.projectDir();
  if (dir === undefined) return "no-project";
  if (typeof id !== "string") return "not-managed";
  const [scope, client, serverName] = id.split(":");
  if (scope !== "project" || client === undefined || serverName === undefined) return "not-managed";
  const read = await readLifecycleState({ homeDir: deps.homeDir, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) });
  if (!read.ok) return "not-managed";
  const key = await projectKeyFor(dir).catch(() => null);
  const state = Object.values(read.state.entries).find((e) => e.target.scope === "project" && e.target.projectKey === key && e.target.client === client && e.target.serverName === serverName);
  return state === undefined ? "not-managed" : { state, dir };
}

/** release:check — INSTALLED 항목 id 하나. 비인증 조회 → ReleaseSnapshot → 결정론 요약 → UpdateImpact. 쓰기·실행 없음. */
export async function releaseCheckForRenderer(session: LifecycleSession, deps: ReleaseDeps, id: unknown): Promise<ReleaseCheckResponse> {
  try {
    const found = await stateFor(session, deps, id);
    if (found === "no-project" || found === "not-managed") return { status: found };
    const { state, dir } = found;
    const { entries } = await loadRegistry(deps.registryDir);
    const manifest = entries.find((e) => e.manifest.name === state.toolId)?.manifest;
    const base = manifest === undefined ? null : releaseRequestOf(manifest);
    if (manifest === undefined || base === null) return { status: "error", code: "RELEASE_SOURCE_UNSUPPORTED", message: "이 도구의 버전 출처는 지원하지 않습니다" };
    const snap = await collectReleaseSnapshot(
      { ...base, backend: state.backend, requested: state.artifact.requested, resolved: state.artifact.resolved, github: manifest.repository.github },
      { now: deps.now ?? (() => new Date()), ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }) },
    );
    if (!snap.ok) {
      const hint = snap.code === "RELEASE_RATE_LIMITED" ? " GitHub 비인증 요청 한도에 걸렸습니다" + (snap.resetAt === null ? "." : "(재시도 가능 " + snap.resetAt + ").") + " CLI openhub releases는 인증을 쓸 수 있습니다." : "";
      return { status: "error", code: snap.code, message: "release 정보를 가져오지 못했습니다." + hint };
    }
    const summary = summarizeReleases(snap.snapshot);
    deps.onSnapshot?.(id as string, snap.snapshot, summary);
    const entry = await readConfiguredEntry(state.target.client, state.target.scope, state.target.serverName, { projectRoot: dir, homeDir: deps.homeDir, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) }).catch(() => undefined);
    const env = entry !== null && typeof entry === "object" && (entry as Record<string, unknown>)["env"] !== null && typeof (entry as Record<string, unknown>)["env"] === "object" ? Object.keys((entry as Record<string, object>)["env"]!) : [];
    const probes = await (deps.probe ?? (() => probeBackends()))().catch(() => null);
    const impact = analyzeUpdateImpact({ state, configEnvNames: env, manifest, snapshot: snap.snapshot, runtimes: { node: probes?.node.version ?? null } });
    const t = snap.snapshot.target;
    const noteLines = t?.notes?.text.split(/\r\n|\n|\r/u) ?? [];
    return {
      status: "ok",
      view: {
        id: id as string,
        title: (manifest.displayName ?? manifest.name) + " 릴리스",
        current: snap.snapshot.current.version ?? "확인되지 않음",
        latest: t === null ? "비교할 수 없음" : t.version + (t.publishedAt === null ? "" : " (" + t.publishedAt.slice(0, 10) + ")"),
        updateAvailable: impact.reasons.some((r) => r.code.startsWith("version-") && r.code !== "version-incomparable"),
        impact: { verdict: impact.verdict.toUpperCase(), status: impact.status, reasons: impact.reasons.map((r) => r.code + " (" + r.level + ")") },
        summary: SUMMARY_CATEGORIES.map((c) => ({ label: LABEL[c], count: summary.categories[c].length, items: summary.categories[c].slice(0, 5).map((i) => "[" + i.version + " L" + String(i.line) + "] " + clean(i.text)) })),
        notes: t?.notes ? { version: t.version, lines: noteLines.slice(0, NOTE_LINES).map((l) => clean(l)), more: Math.max(0, noteLines.length - NOTE_LINES) } : null,
        url: t?.url ?? null,
      },
    };
  } catch {
    return { status: "error", code: "release-check-failed", message: "release 정보를 확인하지 못했습니다" };
  }
}

const nodeProbeFs = { stat: (f: string) => stat(f), readFile: (f: string) => readFile(f, "utf8"), realpath: (f: string) => realpath(f) };

/** pinokio:preview — Registry toolId 하나. 비실행 probe로 PinokioPlan을 만들어 보여 주기만 한다(실행 채널 없음). */
export async function pinokioPreviewForRenderer(deps: ReleaseDeps, toolId: unknown): Promise<PinokioPreviewResponse> {
  try {
    if (typeof toolId !== "string") return { status: "error", code: "PINOKIO_NOT_SUPPORTED", message: "도구를 고르세요" };
    const { entries } = await loadRegistry(deps.registryDir);
    const manifest = entries.find((e) => e.manifest.name === toolId)?.manifest;
    if (manifest === undefined) return { status: "error", code: "TOOL_NOT_FOUND", message: "Registry에 없는 도구입니다" };
    const probe: PinokioProbeEnv = {
      pathEnv: deps.pinokioProbe?.pathEnv ?? "",
      platform: deps.pinokioProbe?.platform ?? process.platform,
      fs: deps.pinokioProbe?.fs ?? nodeProbeFs,
      ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    };
    const r = await planPinokio({ operation: "install", manifest }, { probe, homeDir: deps.homeDir });
    if (!r.ok) return { status: "error", code: r.code, message: r.message };
    const plan = r.planned.plan;
    const lines = [plan.toolId + " Pinokio 설치 계획(미리보기)", "저장소 " + plan.repo + " @ " + plan.commit, "Pinokio app " + plan.appRef, "버전 pterm " + plan.versions.pterm + " · pinokiod " + plan.versions.pinokiod + " · script " + plan.versions.script, ""];
    for (const s of plan.scripts) {
      lines.push(s.name + "  " + s.digest);
      const body = JSON.parse(s.content.slice("module.exports = ".length, -2)) as { run: { method: string; params: Record<string, unknown> }[] };
      for (const step of body.run) lines.push("  - " + step.method + (typeof step.params["message"] === "string" ? ": " + step.params["message"] : ""));
    }
    lines.push("", "Health " + plan.health.url + " → " + String(plan.health.expectStatus) + " 확인 후 종료(상주하지 않음)");
    for (const n of plan.notices) lines.push("[" + n.code + "] " + n.message);
    lines.push("승인 요구 " + plan.approvalRequirements.join(", "), "Plan digest " + r.planned.planDigest, "", "설치는 CLI에서 승인합니다: openhub install " + plan.toolId + " --backend pinokio");
    return { status: "ok", lines: lines.map((l) => clean(l, 400)) };
  } catch {
    return { status: "error", code: "pinokio-preview-failed", message: "Pinokio 계획을 만들지 못했습니다" };
  }
}

/** pinokio:inspect — "owner/repo@commit"과 script 경로. 원문·정적 경고만 보여 준다(실행 없음, GitHub 비인증). */
export async function pinokioInspectForRenderer(deps: ReleaseDeps, ref: unknown, scriptPath: unknown): Promise<PinokioInspectResponse> {
  const m = typeof ref === "string" ? /^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})@([0-9a-f]{40})$/u.exec(ref.trim()) : null;
  if (m === null) return { status: "error", code: "THIRD_PARTY_INPUT_INVALID", message: "owner/repo@40자리 commit 형식으로 고정하세요" };
  const r = await fetchThirdPartyScript({ repo: m[1]!, commit: m[2]!, path: typeof scriptPath === "string" && scriptPath.trim() !== "" ? scriptPath.trim() : "install.js" }, deps.fetch === undefined ? {} : { fetch: deps.fetch });
  if (!r.ok) return { status: "error", code: r.code, message: r.message };
  const p = r.preview;
  return {
    status: "ok",
    preview: { title: p.repo + " @ " + p.commit + " / " + p.path, lines: p.content.split(/\r\n|\n|\r/u).map((l) => clean(l, 400)), warnings: p.warnings.map((w) => "L" + String(w.line) + " " + w.code), notice: p.notice },
  };
}

/** IPC 핸들러 등록. 실행 채널이 없다. */
export function registerRelease(ipc: IpcMainLike, session: LifecycleSession, deps: ReleaseDeps): void {
  ipc.handle(RELEASE_CHECK_CHANNEL, (_event: unknown, id: unknown) => releaseCheckForRenderer(session, deps, id));
  ipc.handle(PINOKIO_PREVIEW_CHANNEL, (_event: unknown, toolId: unknown) => pinokioPreviewForRenderer(deps, toolId));
  ipc.handle(PINOKIO_INSPECT_CHANNEL, (_event: unknown, ref: unknown, scriptPath: unknown) => pinokioInspectForRenderer(deps, ref, scriptPath));
}

/** 스모크 전용(AC-057-07, --smoke + OPENHUB_SMOKE_RELEASE일 때만 main이 사용). 가짜 registry·GitHub 응답, 호출 기록. */
export function smokeReleaseDeps(): { fetch: FetchLike; fetched: string[]; authorized: number } {
  const record = { fetched: [] as string[], authorized: 0 };
  const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
  return Object.assign(record, {
    fetch: (async (url: string, init?: RequestInit) => {
      record.fetched.push(url);
      if (Object.keys((init?.headers ?? {}) as Record<string, string>).some((k) => k.toLowerCase() === "authorization")) record.authorized += 1;
      const npm = /^https:\/\/registry\.npmjs\.org\/(.+)\/latest$/u.exec(url);
      if (npm !== null) return json({ name: decodeURIComponent(npm[1]!), version: "9.9.9" });
      if (/^https:\/\/pypi\.org\/pypi\/[^/]+\/json$/u.test(url)) return json({ info: { name: url.split("/")[4], version: "9.9.9" }, releases: { "9.9.9": [{ upload_time_iso_8601: "2026-10-01T00:00:00Z" }] } });
      if (url.includes("/releases?")) return json([{ tag_name: "v9.9.9", name: "9.9.9", body: "- BREAKING: smoke <script>alert(1)</script>", draft: false, prerelease: false, published_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/smoke/smoke/releases/tag/v9.9.9" }]);
      return new Response("missing", { status: 404 });
    }) as FetchLike,
  });
}

