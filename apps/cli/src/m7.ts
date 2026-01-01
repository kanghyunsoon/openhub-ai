import { readdir, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  ADOPT_APPROVAL_MESSAGES,
  BENCHMARK_APPROVAL_MESSAGES,
  CANDIDATES_DIR,
  CONTRIBUTION_DIR,
  INSTALL_CLIENTS,
  LIFECYCLE_STATE_LOGICAL_PATH,
  PINOKIO_SUPPORT_NOTICE_KO,
  TREND_SCORE_MEANING,
  analyzeProject,
  buildDiscoverView,
  defaultHostEnvironment,
  executeAdopt,
  formatAdoptPlanPreview,
  formatAdoptResult,
  formatBenchmarkPlanPreview,
  formatBenchmarkReport,
  formatRegistryIssue,
  formatTrendItem,
  loadCatalog,
  loadRegistry,
  locatePterm,
  locateWindowsNpxLauncher,
  planAdopt,
  planBenchmark,
  prepareContribution,
  probeBackends,
  projectKeyFor,
  readCandidateFile,
  readLifecycleState,
  recommend,
  requestAdoptApproval,
  requestBenchmarkApproval,
  runBenchmark,
  serializeAdoptPlan,
  serializeBenchmarkPlan,
  toRecommendPlatform,
  writeContributionPackage,
  type AdoptApprovalPrompter,
  type AdoptApprovalRequirement,
  type AdoptPlanOptions,
  type BenchmarkApprovalPrompter,
  type BenchmarkApprovalRequirement,
  type BenchmarkPlanOptions,
  type ConfigScope,
  type DiscoveryCandidate,
  type InstallClient,
} from "@openhub/core";
import type { LifecycleCommandIO } from "./lifecycle";
import { metadataOf, registryDirOf, type PathsIO } from "./paths";

/**
 * M7 CLI(TASK-069). 기존 명령과 충돌하지 않는 새 명령만 둔다.
 *   openhub adopt <toolId> [--project] [--client] [--scope] [--server-name] [--json]
 *   openhub discover --view new|trending|verified|candidates [--project] [--candidates-dir] [--include-host] [--json]
 *   openhub trending [--json]
 *   openhub candidate prepare <candidateId> [--candidates-dir] [--out contrib] [--remote]
 *   openhub benchmark <toolId> [--project] [--client] [--scope] [--include-host] [--json]
 *   openhub doctor [--json]
 * - 변경·실행 명령(adopt·benchmark)은 TTY + Preview + kernel 승인(추가 요구마다 y/N, 마지막에 Tool ID 정확 입력)이다. 비TTY는 exit 3.
 *   --json은 Plan·digest만 출력하고 실행하지 않는다. --yes·-y·--approve 같은 자동 승인 옵션은 없다(exit 2).
 * - discover --view·trending·doctor는 network 0, write 0이다(doctor는 D-011 probe의 --version만 실행하고 MCP 서버는 실행하지 않는다).
 * - candidate prepare는 local 파일만 쓰고 GitHub write·git·gh 실행이 0이다.
 * - 출력에 절대 경로·token·env 값이 없다. 종료 코드: 0 성공, 1 실패·차단·거절, 2 인자 오류·알 수 없는 Tool, 3 비대화형 승인 필요.
 */

export interface M7CommandIO extends LifecycleCommandIO {
  version: string;
}

const FORBIDDEN_FLAGS = /^(?:--yes|-y|--approve|--auto-approve|--force)(?:=.*)?$/u;
const VIEWS = ["new", "trending", "verified", "candidates"] as const;
type View = (typeof VIEWS)[number];

function forbidden(argv: readonly string[], io: M7CommandIO): boolean {
  if (argv.some((a) => FORBIDDEN_FLAGS.test(a))) {
    io.err("자동 승인 옵션은 지원하지 않습니다. adopt·benchmark는 대화형 터미널에서 사람이 직접 승인해야 합니다.");
    return true;
  }
  return false;
}
type Options = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>["options"]>;
function parse(argv: readonly string[], options: Options, io: M7CommandIO, usage: string): { values: Record<string, string | boolean | undefined>; positionals: string[] } | null {
  try {
    const r = parseArgs({ args: [...argv], options, allowPositionals: true, strict: true });
    return { values: r.values as Record<string, string | boolean | undefined>, positionals: r.positionals };
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return null;
  }
}
const platformOf = (io: M7CommandIO) => toRecommendPlatform(io.platform ?? process.platform) ?? "linux";
const homeOf = (io: M7CommandIO) => io.homeDir ?? os.homedir();
const clientOf = (v: string | undefined): InstallClient | null | undefined => (v === undefined ? undefined : (INSTALL_CLIENTS as readonly string[]).includes(v) ? (v as InstallClient) : null);
const scopeOf = (v: string | undefined): ConfigScope | null | undefined => (v === undefined ? undefined : v === "project" || v === "user" ? v : null);

async function registryOf(io: M7CommandIO) {
  const { entries, issues } = await loadRegistry(registryDirOf(io));
  for (const issue of issues) io.err("경고: " + formatRegistryIssue(issue));
  return entries;
}

/** 승인 프롬프트: 추가 요구마다 y/N, 마지막에 Tool ID 정확 입력. */
function ttyPrompter<R extends string>(toolId: string, io: M7CommandIO, messages: Readonly<Record<R, string>>): { channel: "cli-tty"; confirm(request: { requirements: readonly { id: R; message: string }[] }): Promise<readonly R[] | "rejected"> } {
  return {
    channel: "cli-tty",
    async confirm(request) {
      const p = io.prompter!;
      const extras = request.requirements.filter((r) => r.id !== "base");
      for (const r of extras) {
        io.out("");
        io.out("[" + r.id + "] " + r.message);
        const answer = (await p.ask("  확인합니까? (y/N) ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") return "rejected";
      }
      io.out("");
      io.out(messages["base" as R]);
      const typed = await p.ask("  진행하려면 Tool ID(" + toolId + ")를 정확히 입력하세요: ");
      if (typed.trim() !== toolId) return "rejected";
      return ["base" as R, ...extras.map((r) => r.id)];
    },
  };
}

// ---------------------------------------------------------------- adopt

export async function runAdopt(argv: readonly string[], io: M7CommandIO, usage: string): Promise<number> {
  if (forbidden(argv, io)) return 2;
  const parsed = parse(argv, { project: { type: "string" }, client: { type: "string" }, scope: { type: "string" }, "server-name": { type: "string" }, json: { type: "boolean", default: false } }, io, usage);
  if (parsed === null) return 2;
  const { values, positionals } = parsed as { values: Record<string, string | boolean | undefined>; positionals: string[] };
  const toolId = positionals[0];
  const client = clientOf(values["client"] as string | undefined);
  const scope = scopeOf(values["scope"] as string | undefined);
  if (toolId === undefined || positionals.length > 1 || client === null || scope === null) {
    io.err("사용법: openhub adopt <toolId> [--project <path>] [--client claude-code|codex|cursor] [--scope project|user] [--server-name <name>] [--json]");
    return 2;
  }
  const entries = await registryOf(io);
  const options: AdoptPlanOptions = {
    toolId,
    projectRoot: path.resolve(io.cwd, (values["project"] as string | undefined) ?? "."),
    homeDir: homeOf(io),
    entries,
    platform: platformOf(io),
    client: client ?? "claude-code",
    scope: scope ?? "project",
    ...(values["server-name"] === undefined ? {} : { serverName: values["server-name"] as string }),
    ...(io.configFs === undefined ? {} : { fs: io.configFs }),
  };
  const first = await planAdopt(options);
  if (!first.ok) {
    io.err("adopt 계획을 만들 수 없습니다: " + first.code + " — " + first.message);
    return first.code === "TOOL_NOT_FOUND" ? 2 : 1;
  }
  if (values["json"] === true) {
    io.out(JSON.stringify({ plan: JSON.parse(serializeAdoptPlan(first.planned.plan)), planDigest: first.planned.planDigest }, null, 2));
    return 0;
  }
  for (const l of formatAdoptPlanPreview(first.planned)) io.out(l);
  if (first.planned.plan.status !== "ready") return 1;
  if (io.prompter === undefined || !io.prompter.isTTY) {
    io.err("APPROVAL_REQUIRED: adopt는 대화형 터미널에서 사람이 승인해야 합니다(--json은 계획만 출력합니다)");
    return 3;
  }
  const outcome = await requestAdoptApproval(first.planned, ttyPrompter<AdoptApprovalRequirement>(toolId, io, ADOPT_APPROVAL_MESSAGES) as AdoptApprovalPrompter);
  if (outcome.status !== "approved") {
    io.out("adopt를 취소했습니다. Version State와 설정 파일은 바뀌지 않았습니다.");
    return 1;
  }
  const result = await executeAdopt(outcome.approval, { toolId, homeDir: options.homeDir, now: io.now ?? (() => new Date()), regenerate: () => planAdopt(options), ...(io.configFs === undefined ? {} : { fs: io.configFs }) });
  for (const l of formatAdoptResult(result)) io.out(l);
  return result.status === "adopted" ? 0 : 1;
}

// ---------------------------------------------------------------- discover --view·trending

async function readCandidates(dir: string): Promise<DiscoveryCandidate[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/u.test(f)).sort();
  } catch {
    return [];
  }
  const out: DiscoveryCandidate[] = [];
  for (const f of files) {
    const r = await readCandidateFile(dir, f.slice(0, -5));
    if (r.ok) out.push(r.candidate);
  }
  return out;
}

export async function runDiscoverView(argv: readonly string[], io: M7CommandIO, usage: string): Promise<number> {
  if (forbidden(argv, io)) return 2;
  const parsed = parse(argv, { view: { type: "string" }, project: { type: "string" }, "candidates-dir": { type: "string" }, "include-host": { type: "boolean", default: false }, json: { type: "boolean", default: false } }, io, usage);
  if (parsed === null) return 2;
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const view = values["view"] as View;
  if (!(VIEWS as readonly string[]).includes(view) || parsed.positionals.length > 0) {
    io.err("--view는 " + VIEWS.join("|") + " 중 하나입니다");
    return 2;
  }
  const entries = await registryOf(io);
  const registryRoot = registryDirOf(io);
  const catalog = await loadCatalog(registryRoot);
  if (!catalog.ok) io.err("경고: catalog.yaml을 읽지 못해 NEW 판정을 하지 않습니다");
  const { snapshot } = await metadataOf(io);
  let report;
  const managed: string[] = [];
  if (view === "new") {
    const projectRoot = path.resolve(io.cwd, (values["project"] as string | undefined) ?? ".");
    const analyzed = await analyzeProject(projectRoot, { ...(io.detectors === undefined ? {} : { detectors: io.detectors }) });
    if (!analyzed.ok) {
      io.err("프로젝트를 분석할 수 없습니다: " + analyzed.error.code);
      return 1;
    }
    report = recommend(analyzed.profile, entries, snapshot);
    const state = await readLifecycleState({ homeDir: homeOf(io), ...(io.configFs === undefined ? {} : { fs: io.configFs }) });
    if (state.ok) {
      const key = await projectKeyFor(projectRoot).catch(() => null);
      for (const e of Object.values(state.state.entries)) if ((e.target.scope === "project" && e.target.projectKey === key) || (e.target.scope === "user" && values["include-host"] === true)) managed.push(e.toolId);
    }
  }
  const candidates = view === "candidates" ? await readCandidates(path.resolve(io.cwd, (values["candidates-dir"] as string | undefined) ?? CANDIDATES_DIR)) : [];
  const v = buildDiscoverView({ entries, catalog: catalog.ok ? catalog.catalog : undefined, snapshot, report, managedToolIds: managed, candidates, asOf: (io.now ?? (() => new Date()))() });
  if (values["json"] === true) {
    const section = view === "new" ? v.sections.newForProject : view === "trending" ? v.sections.trending : view === "verified" ? v.sections.verified : v.sections.candidates;
    io.out(JSON.stringify({ view, asOf: v.asOf, metadataCollectedAt: v.metadataCollectedAt, ...(view === "trending" ? { meaning: v.trendMeaning } : {}), items: section }, null, 2));
    return 0;
  }
  if (view === "trending") {
    io.out("TRENDING — OpenHub Trend Score (" + TREND_SCORE_MEANING + ")");
    io.out("기준: metadata " + (v.metadataCollectedAt ?? "없음(openhub collect)") + " · 보안·품질 점수가 아닙니다");
    v.sections.trending.forEach((t, i) => io.out("  " + formatTrendItem(t, i + 1)));
  } else if (view === "verified") {
    io.out("VERIFIED REGISTRY — 사람이 검토한 Registry Tool " + String(v.sections.verified.length) + "개");
    for (const t of v.sections.verified) io.out("  " + t.toolId + " · " + t.verification + " · " + (t.addedAt ?? "등록일 미상") + " · " + (t.summary ?? ""));
  } else if (view === "new") {
    io.out("NEW FOR YOUR PROJECT — 최근 90일 안에 Registry에 들어왔고 이 프로젝트의 Gap을 채우는 도구(" + v.asOf + " 기준)");
    if (v.sections.newForProject.length === 0) io.out("  (없음)");
    for (const t of v.sections.newForProject) io.out("  " + String(t.rank) + ". " + t.toolId + " · " + t.addedAt + " · " + t.primaryCapability + " (" + t.gapStates.join(", ") + ")");
  } else {
    io.out("UNVERIFIED CANDIDATES — Registry entry가 아닙니다. 설치·adopt·추천 대상이 아닙니다");
    if (v.sections.candidates.length === 0) io.out("  (없음 — openhub discover로 만들 수 있습니다)");
    for (const c of v.sections.candidates) io.out("  [" + c.badges.join("·") + "] " + c.id + " · " + c.confidence + (c.repository === null ? "" : " · " + c.repository) + " → openhub candidate prepare " + c.id);
  }
  return 0;
}

// ---------------------------------------------------------------- candidate prepare

export async function runCandidate(argv: readonly string[], io: M7CommandIO, usage: string): Promise<number> {
  if (forbidden(argv, io)) return 2;
  const [sub, ...rest] = argv;
  if (sub !== "prepare") {
    io.err("지원하는 하위 명령: prepare\n\n" + usage);
    return 2;
  }
  const parsed = parse(rest, { "candidates-dir": { type: "string" }, out: { type: "string" }, remote: { type: "boolean", default: false } }, io, usage);
  if (parsed === null) return 2;
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const id = parsed.positionals[0];
  if (id === undefined || parsed.positionals.length > 1) {
    io.err("사용법: openhub candidate prepare <candidateId> [--candidates-dir registry-candidates] [--out contrib] [--remote]");
    return 2;
  }
  const read = await readCandidateFile(path.resolve(io.cwd, (values["candidates-dir"] as string | undefined) ?? CANDIDATES_DIR), id);
  if (!read.ok) {
    io.err(read.code + ": " + read.message);
    return read.code === "CONTRIBUTION_INVALID_ID" ? 2 : 1;
  }
  const catalogText = await readFile(path.join(registryDirOf(io), "catalog.yaml"), "utf8").catch(() => null);
  const prepared = await prepareContribution(read.candidate, {
    asOf: (io.now ?? (() => new Date()))(),
    catalogText,
    toolVersion: io.version,
    ...(values["remote"] === true ? { remote: io.fetch === undefined ? {} : { fetch: io.fetch } } : {}),
  });
  if (!prepared.ok) {
    io.err(prepared.code + ": " + prepared.message);
    return 1;
  }
  const outArg = (values["out"] as string | undefined) ?? CONTRIBUTION_DIR;
  const written = await writeContributionPackage(path.resolve(io.cwd, outArg), prepared);
  if (!written.ok) {
    io.err(written.code + ": " + written.message);
    return 1;
  }
  io.out("Contribution package " + (prepared.status === "ready" ? "준비 완료" : "(근거 부족)") + ": " + path.posix.join(outArg.replace(/\\/gu, "/"), written.dir) + "/");
  for (const f of written.files) io.out("  " + f);
  io.out("OpenHub는 GitHub에 쓰지 않았습니다(branch·push·PR 0). 검토한 뒤 COMMANDS.md의 명령을 직접 실행하세요.");
  return 0;
}

// ---------------------------------------------------------------- benchmark

export async function runBenchmarkCommand(argv: readonly string[], io: M7CommandIO, usage: string): Promise<number> {
  if (forbidden(argv, io)) return 2;
  const parsed = parse(argv, { project: { type: "string" }, client: { type: "string" }, scope: { type: "string" }, "include-host": { type: "boolean", default: false }, json: { type: "boolean", default: false } }, io, usage);
  if (parsed === null) return 2;
  const values = parsed.values as Record<string, string | boolean | undefined>;
  const toolId = parsed.positionals[0];
  const client = clientOf(values["client"] as string | undefined);
  const scope = scopeOf(values["scope"] as string | undefined);
  if (toolId === undefined || parsed.positionals.length > 1 || client === null || scope === null) {
    io.err("사용법: openhub benchmark <toolId> [--project <path>] [--client <id>] [--scope project|user] [--include-host] [--json]");
    return 2;
  }
  const entries = await registryOf(io);
  const options: BenchmarkPlanOptions = {
    toolId,
    projectRoot: path.resolve(io.cwd, (values["project"] as string | undefined) ?? "."),
    homeDir: homeOf(io),
    entries,
    platform: platformOf(io),
    includeUser: values["include-host"] === true,
    ...(client === undefined ? {} : { client }),
    ...(scope === undefined ? {} : { scope }),
    ...(io.configFs === undefined ? {} : { fs: io.configFs }),
  };
  const first = await planBenchmark(options);
  if (!first.ok) {
    io.err("Benchmark 계획을 만들 수 없습니다: " + first.code + " — " + first.message);
    return first.code === "TOOL_NOT_FOUND" ? 2 : 1;
  }
  if (values["json"] === true) {
    io.out(JSON.stringify({ plan: JSON.parse(serializeBenchmarkPlan(first.planned.plan)), planDigest: first.planned.planDigest }, null, 2));
    return 0;
  }
  for (const l of formatBenchmarkPlanPreview(first.planned)) io.out(l);
  if (first.planned.plan.status !== "ready") return 1;
  if (io.prompter === undefined || !io.prompter.isTTY) {
    io.err("APPROVAL_REQUIRED: Benchmark는 MCP 서버를 실행하므로 대화형 터미널에서 사람이 승인해야 합니다(--json은 계획만 출력합니다)");
    return 3;
  }
  const outcome = await requestBenchmarkApproval(first.planned, ttyPrompter<BenchmarkApprovalRequirement>(toolId, io, BENCHMARK_APPROVAL_MESSAGES) as BenchmarkApprovalPrompter);
  if (outcome.status !== "approved") {
    io.out("Benchmark를 취소했습니다. 아무것도 실행하지 않았습니다.");
    return 1;
  }
  const host = { ...defaultHostEnvironment(), ...(io.hostEnvironment ?? {}) };
  const windowsNpx = first.planned.plan.platform === "windows" && first.planned.plan.launch?.executable === "npx" ? await locateWindowsNpxLauncher({ pathEnv: host.pathEnv, fs: host.fs }) : null;
  const r = await runBenchmark(outcome.approval, {
    regenerate: () => planBenchmark(options),
    tempBase: io.tempBase ?? os.tmpdir(),
    windowsNpx,
    host: { arch: process.arch, nodeVersion: process.versions.node },
    ...(io.healthSpawner === undefined ? {} : { spawner: io.healthSpawner }),
    ...(io.killTree === undefined ? {} : { killTree: io.killTree }),
  });
  if (!r.ok) {
    io.err("Benchmark를 실행하지 않았습니다: " + r.code + " — " + r.message);
    return 1;
  }
  for (const l of formatBenchmarkReport(r.report)) io.out(l);
  return r.report.summary.succeeded > 0 ? 0 : 1;
}

// ---------------------------------------------------------------- doctor

export async function runDoctor(argv: readonly string[], io: M7CommandIO, usage: string): Promise<number> {
  const parsed = parse(argv, { json: { type: "boolean", default: false } }, io, usage);
  if (parsed === null || parsed.positionals.length > 0) return 2;
  const node = process.versions.node;
  const [major, minor] = node.split(".").map(Number) as [number, number];
  const probes = await (io.probe ?? (() => probeBackends()))().catch(() => null);
  const host = { ...defaultHostEnvironment(), ...(io.hostEnvironment ?? {}) };
  const pterm = await locatePterm({ pathEnv: host.pathEnv, platform: io.platform === undefined ? process.platform : (io.platform as NodeJS.Platform), fs: host.fs as never }).catch(() => ({ ok: false as const, status: "pterm-not-found" as const }));
  const { entries, issues } = await loadRegistry(registryDirOf(io));
  const { snapshot, choice } = await metadataOf(io);
  const now = (io.now ?? (() => new Date()))();
  const ageDays = snapshot === undefined ? null : Math.max(0, Math.floor((now.getTime() - Date.parse(snapshot.collectedAt)) / 86_400_000));
  const state = await readLifecycleState({ homeDir: homeOf(io), ...(io.configFs === undefined ? {} : { fs: io.configFs }) });
  const doc = {
    node: { version: node, supported: major > 24 || (major === 24 && minor >= 15), required: ">=24.15" },
    backends: probes === null ? null : Object.fromEntries(Object.entries(probes).map(([k, p]) => [k, { available: p.available, version: p.version, status: p.status }])),
    pinokio: { pterm: pterm.ok ? "found " + pterm.entry.version : pterm.status, supported: "pterm 0.0.25", notice: PINOKIO_SUPPORT_NOTICE_KO },
    registry: { source: (io as PathsIO).registrySource ?? "./registry", manifests: entries.length, issues: issues.length },
    metadata: { source: choice.label, collectedAt: snapshot?.collectedAt ?? null, ageDays },
    versionState: { file: LIFECYCLE_STATE_LOGICAL_PATH, status: state.ok ? "ok" : state.code, entries: state.ok ? Object.keys(state.state.entries).length : null },
    support: { os: ["Windows x64 (NSIS installer, unsigned)", "Linux x64 (AppImage)", "macOS: source build only"], clients: ["claude-code", "codex", "cursor"], backends: ["npx", "uvx", "docker", "pinokio (pterm 0.0.25)"] },
  };
  if (parsed.values["json"] === true) {
    io.out(JSON.stringify(doc, null, 2));
    return 0;
  }
  io.out("OpenHub doctor (쓰기 0 · MCP 서버 실행 0)");
  io.out("  Node " + node + (doc.node.supported ? " (지원)" : " (지원 안 됨, >=24.15 필요)"));
  for (const [k, p] of Object.entries(doc.backends ?? {})) io.out("  " + k.padEnd(7) + (p.available ? "있음 " + (p.version ?? "") : "없음") + " [" + p.status + "]");
  io.out("  pterm  " + doc.pinokio.pterm + " · " + PINOKIO_SUPPORT_NOTICE_KO);
  io.out("  Registry " + String(entries.length) + "개 (./registry" + (issues.length > 0 ? ", 오류 " + String(issues.length) + "건" : "") + ")");
  io.out("  metadata " + (snapshot === undefined ? "없음 — openhub collect로 수집하세요(OpenScore·Trending에 필요)" : snapshot.collectedAt + " (" + String(ageDays) + "일 전)"));
  io.out("  Version State " + LIFECYCLE_STATE_LOGICAL_PATH + " · " + doc.versionState.status + (doc.versionState.entries === null ? "" : " · 관리 항목 " + String(doc.versionState.entries) + "개"));
  io.out("  지원 범위: " + doc.support.os.join(" · ") + " / Client " + doc.support.clients.join(", ") + " / backend " + doc.support.backends.join(", "));
  return 0;
}

