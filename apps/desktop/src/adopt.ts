import os from "node:os";
import {
  buildFingerprintIndex,
  defaultHostEnvironment,
  executeAdopt,
  formatAdoptPlanPreview,
  formatAdoptResult,
  formatBenchmarkPlanPreview,
  formatBenchmarkReport,
  gradeServer,
  loadRegistry,
  locateWindowsNpxLauncher,
  planAdopt,
  planBenchmark,
  projectKeyFor,
  readConfiguredServers,
  readLifecycleState,
  requestAdoptApproval,
  requestBenchmarkApproval,
  runBenchmark,
  toRecommendPlatform,
  type AdoptApprovalPrompter,
  type AdoptPlanOptions,
  type BenchmarkApprovalPrompter,
  type BenchmarkPlanOptions,
  type ConfigFs,
  type HealthSpawner,
  type InstallClient,
  type TreeKiller,
} from "@openhub/core";
import type { NativeDialogLike } from "./install";
import { tr } from "./i18n/index";

/**
 * Desktop INSTALLED의 Adopt·Benchmark(TASK-070, D-029·D-032).
 * - adopt:candidates는 인자를 받지 않는다. 고른 프로젝트의 project scope 설정에서 아직 관리되지 않고 exact·strong으로 식별되며
 *   표현 가능한(AdoptPlan ready) 항목만 돌려준다. weak·unresolved에는 Adopt가 없다(user scope는 Desktop에서 읽지 않는다, D-003).
 * - adopt:run·benchmark:run은 항목 id 하나만 받는다. 승인은 main process 네이티브 대화상자에서만 만들어진다.
 * - Benchmark는 MCP 서버를 6번 실행하는 승인 실행이며 tool 호출은 없다. 결과는 median·min·max·실패 수뿐이다.
 */

export const ADOPT_CANDIDATES_CHANNEL = "adopt:candidates";
export const ADOPT_RUN_CHANNEL = "adopt:run";
export const BENCHMARK_RUN_CHANNEL = "benchmark:run";

type Listener = (...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
}

export interface AdoptDeps {
  registryDir: string;
  homeDir: string;
  platform: string;
  projectDir: () => string | undefined;
  dialog: NativeDialogLike;
  now?: () => Date;
  configFs?: ConfigFs;
  healthSpawner?: HealthSpawner;
  killTree?: TreeKiller;
  tempBase?: string;
}

export interface AdoptCandidateView {
  id: string;
  toolId: string;
  grade: "exact" | "strong";
  title: string;
  lines: string[];
}
/** INSTALLED 관리 항목의 Benchmark 가능 여부(계획만 만든다. spawn 0). blocked면 버튼을 끄고 이유를 보여 준다. */
export interface BenchmarkTargetView {
  id: string;
  toolId: string;
  ready: boolean;
  reasons: string[];
}
export type AdoptCandidatesResponse = { status: "ok"; items: AdoptCandidateView[]; benchmark: BenchmarkTargetView[] } | { status: "no-project" } | { status: "error"; code: string; message: string };
export type AdoptRunResponse = { status: "done"; lines: string[]; adopted: boolean } | { status: "rejected" } | { status: "blocked"; lines: string[] } | { status: "no-project" } | { status: "error"; code: string; message: string };
export type BenchmarkRunResponse = { status: "done"; lines: string[] } | { status: "rejected" } | { status: "blocked"; lines: string[] } | { status: "no-project" } | { status: "error"; code: string; message: string };

const CLIENTS: readonly InstallClient[] = ["claude-code", "codex", "cursor"];
const parseId = (id: unknown): { client: InstallClient; serverName: string } | null => {
  if (typeof id !== "string") return null;
  const [scope, client, ...rest] = id.split(":");
  const serverName = rest.join(":");
  return scope === "project" && CLIENTS.includes(client as InstallClient) && serverName !== "" ? { client: client as InstallClient, serverName } : null;
};

/** kernel 승인 요청을 네이티브 대화상자 하나로 묻는다(모든 요구를 목록으로 보여 주고 승인/취소). */
function dialogPrompter<R extends string>(dialog: NativeDialogLike, title: string, message: string, lines: readonly string[]): { channel: "desktop-native-dialog"; confirm(request: { requirements: readonly { id: R; message: string }[] }): Promise<readonly R[] | "rejected"> } {
  return {
    channel: "desktop-native-dialog",
    async confirm(request) {
      const detail = [...lines, "", ...request.requirements.map((r) => "• [" + r.id + "] " + r.message)].join("\n");
      const { response } = await dialog.showMessageBox({ type: "warning", title, message, detail, buttons: [tr("dialog.cancel"), tr("dialog.approve")], defaultId: 0, cancelId: 0, noLink: true });
      return response === 1 ? request.requirements.map((r) => r.id) : "rejected";
    },
  };
}

async function adoptOptions(deps: AdoptDeps, dir: string, client: InstallClient, serverName: string, toolId: string): Promise<AdoptPlanOptions> {
  const { entries } = await loadRegistry(deps.registryDir);
  return { toolId, projectRoot: dir, homeDir: deps.homeDir, entries, platform: toRecommendPlatform(deps.platform) ?? "linux", client, scope: "project", serverName, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) };
}

export async function adoptCandidatesForRenderer(deps: AdoptDeps): Promise<AdoptCandidatesResponse> {
  const dir = deps.projectDir();
  if (dir === undefined) return { status: "no-project" };
  try {
    const { entries } = await loadRegistry(deps.registryDir);
    const index = buildFingerprintIndex(entries);
    const servers = await readConfiguredServers({ projectRoot: dir, homeDir: deps.homeDir, includeUser: false, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) });
    const items: AdoptCandidateView[] = [];
    for (const s of servers) {
      const m = gradeServer(s, index);
      if ((m.grade !== "exact" && m.grade !== "strong") || m.toolId === null) continue;
      const planned = await planAdopt(await adoptOptions(deps, dir, s.client, s.serverName, m.toolId));
      if (!planned.ok || planned.planned.plan.status !== "ready") continue;
      items.push({ id: "project:" + s.client + ":" + s.serverName, toolId: m.toolId, grade: m.grade, title: tr(m.grade === "strong" ? "adopt.titleStrong" : "adopt.titleExact", { server: s.serverName, toolId: m.toolId }), lines: formatAdoptPlanPreview(planned.planned) });
    }
    const benchmark: BenchmarkTargetView[] = [];
    const state = await readLifecycleState({ homeDir: deps.homeDir, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) });
    const key = await projectKeyFor(dir).catch(() => null);
    if (state.ok) {
      const managed = Object.values(state.state.entries)
        .filter((e) => e.target.scope === "project" && e.target.projectKey === key)
        .sort((a, b) => (a.target.client + ":" + a.target.serverName < b.target.client + ":" + b.target.serverName ? -1 : 1));
      for (const e of managed) {
        const id = "project:" + e.target.client + ":" + e.target.serverName;
        const planned = await planBenchmark({ toolId: e.toolId, projectRoot: dir, homeDir: deps.homeDir, entries, platform: toRecommendPlatform(deps.platform) ?? "linux", includeUser: false, client: e.target.client as InstallClient, scope: "project", ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) });
        if (!planned.ok) benchmark.push({ id, toolId: e.toolId, ready: false, reasons: [planned.message] });
        else benchmark.push({ id, toolId: e.toolId, ready: planned.planned.plan.status === "ready", reasons: planned.planned.plan.blockers.map((b) => b.code + " — " + b.message) });
      }
    }
    return { status: "ok", items, benchmark };
  } catch {
    return { status: "error", code: "adopt-candidates-failed", message: tr("adopt.candidatesFailed") };
  }
}

export async function adoptRunForRenderer(deps: AdoptDeps, id: unknown): Promise<AdoptRunResponse> {
  const dir = deps.projectDir();
  if (dir === undefined) return { status: "no-project" };
  const parsed = parseId(id);
  if (parsed === null) return { status: "error", code: "invalid-id", message: tr("adopt.chooseTarget") };
  const { entries } = await loadRegistry(deps.registryDir);
  const server = (await readConfiguredServers({ projectRoot: dir, homeDir: deps.homeDir, includeUser: false, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) })).find((s) => s.client === parsed.client && s.serverName === parsed.serverName);
  const match = server === undefined ? undefined : gradeServer(server, buildFingerprintIndex(entries));
  if (match === undefined || match.toolId === null) return { status: "error", code: "ADOPT_TARGET_NOT_FOUND", message: tr("adopt.notFound") };
  const options = await adoptOptions(deps, dir, parsed.client, parsed.serverName, match.toolId);
  const first = await planAdopt(options);
  if (!first.ok) return { status: "error", code: first.code, message: first.message };
  const preview = formatAdoptPlanPreview(first.planned);
  if (first.planned.plan.status !== "ready") return { status: "blocked", lines: preview };
  const outcome = await requestAdoptApproval(first.planned, dialogPrompter(deps.dialog, tr("adopt.dialog.title"), tr("adopt.dialog.message", { toolId: match.toolId }), preview) as AdoptApprovalPrompter);
  if (outcome.status !== "approved") return { status: "rejected" };
  const result = await executeAdopt(outcome.approval, { toolId: options.toolId, homeDir: deps.homeDir, now: deps.now ?? (() => new Date()), regenerate: () => planAdopt(options), ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) });
  return { status: "done", lines: formatAdoptResult(result), adopted: result.status === "adopted" };
}

export async function benchmarkRunForRenderer(deps: AdoptDeps, id: unknown): Promise<BenchmarkRunResponse> {
  const dir = deps.projectDir();
  if (dir === undefined) return { status: "no-project" };
  const parsed = parseId(id);
  if (parsed === null) return { status: "error", code: "invalid-id", message: tr("benchmark.chooseEntry") };
  const { entries } = await loadRegistry(deps.registryDir);
  const state = await readLifecycleState({ homeDir: deps.homeDir, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) });
  const key = await projectKeyFor(dir).catch(() => null);
  const entry = state.ok ? Object.values(state.state.entries).find((e) => e.target.scope === "project" && e.target.projectKey === key && e.target.client === parsed.client && e.target.serverName === parsed.serverName) : undefined;
  if (entry === undefined) return { status: "blocked", lines: [tr("benchmark.notManaged")] };
  const options: BenchmarkPlanOptions = { toolId: entry.toolId, projectRoot: dir, homeDir: deps.homeDir, entries, platform: toRecommendPlatform(deps.platform) ?? "linux", includeUser: false, client: parsed.client, scope: "project", ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) };
  const first = await planBenchmark(options);
  if (!first.ok) return { status: "error", code: first.code, message: first.message };
  const preview = formatBenchmarkPlanPreview(first.planned);
  if (first.planned.plan.status !== "ready") return { status: "blocked", lines: preview };
  const outcome = await requestBenchmarkApproval(first.planned, dialogPrompter(deps.dialog, tr("benchmark.dialog.title"), tr("benchmark.dialog.message", { toolId: entry.toolId }), preview) as BenchmarkApprovalPrompter);
  if (outcome.status !== "approved") return { status: "rejected" };
  const host = defaultHostEnvironment();
  const windowsNpx = first.planned.plan.platform === "windows" && first.planned.plan.launch?.executable === "npx" ? await locateWindowsNpxLauncher({ pathEnv: host.pathEnv, fs: host.fs }) : null;
  const r = await runBenchmark(outcome.approval, {
    regenerate: () => planBenchmark(options),
    tempBase: deps.tempBase ?? os.tmpdir(),
    windowsNpx,
    host: { arch: process.arch, nodeVersion: process.versions.node },
    ...(deps.healthSpawner === undefined ? {} : { spawner: deps.healthSpawner }),
    ...(deps.killTree === undefined ? {} : { killTree: deps.killTree }),
  });
  if (!r.ok) return { status: "error", code: r.code, message: r.message };
  return { status: "done", lines: formatBenchmarkReport(r.report) };
}

export function registerAdopt(ipc: IpcMainLike, deps: AdoptDeps): void {
  ipc.handle(ADOPT_CANDIDATES_CHANNEL, () => adoptCandidatesForRenderer(deps));
  ipc.handle(ADOPT_RUN_CHANNEL, (_event: unknown, id: unknown) => adoptRunForRenderer(deps, id));
  ipc.handle(BENCHMARK_RUN_CHANNEL, (_event: unknown, id: unknown) => benchmarkRunForRenderer(deps, id));
}

