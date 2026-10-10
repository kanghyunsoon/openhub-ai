import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  INSTALL_CLIENTS,
  LIFECYCLE_APPROVAL_MESSAGES,
  LIFECYCLE_STATE_LOGICAL_PATH,
  defaultHostEnvironment,
  formatLifecyclePlanPreview,
  formatLifecycleResult,
  formatLifecycleStatusItem,
  formatRegistryIssue,
  lifecyclePlanSchema,
  lifecycleStatus,
  loadRegistry,
  locateWindowsNpxLauncher,
  npmChildEnv,
  planLifecycleRequest,
  probeBackends,
  readLifecycleState,
  requestLifecycleApproval,
  runLifecycleTransaction,
  serializeLifecyclePlan,
  stateUnreadableMessage,
  toRecommendPlatform,
  type FetchLike,
  type HealthSpawner,
  type InstallClient,
  type LifecycleApprovalPrompter,
  type LifecycleApprovalRequirement,
  type LifecycleEnvironment,
  type LifecycleOperation,
  type LifecycleRequest,
  type LifecycleResultV1,
  type TreeKiller,
} from "@openhub/core";
import { registryDirOf } from "./paths";
import { createTtyPrompter, type InstallCommandIO, type InstallPrompter } from "./install";
import { updateImpactHeader } from "./release";

/**
 * Lifecycle CLI(TASK-045, D-017~D-020).
 *   openhub lifecycle status [--project <p>] [--include-host] [--check] [--json]
 *   openhub update <toolId> [--project <p>] [--client <id>]… [--scope project|user] [--to <version>] [--skip-health] [--json]
 *   openhub rollback <toolId> [--project <p>] [--client <id>]… [--scope project|user] [--skip-health] [--json]
 *   openhub lifecycle health <toolId> [--project <p>] [--client <id>]… [--scope project|user] [--json]
 *   openhub lifecycle repair <toolId> [--project <p>] [--client <id>]… [--scope project|user] [--json]
 *     (v0.2.0) OpenHub 관리 tool config가 없거나 바뀌었거나 프로젝트를 옮긴 경우, 승인 뒤 다시 만들고 Client 설정 경로를 고친 다음 Health를 실행한다.
 * - 승인 규칙은 openhub install과 같다: 추가 승인 항목마다 y/N, 마지막에 toolId 정확 입력. 비TTY는 exit 3, --json은 Plan만.
 *   --yes·-y·--approve는 exit 2. --skip-health는 Health 생략을 "요청"할 뿐이며 health-gate-skipped 승인을 따로 받는다.
 * - status는 network·spawn·write 0회, --check는 resolver만 호출한다(spawn·write 0회).
 * - 종료 코드: 0 성공·up-to-date·--json, 1 실패·거절·실행 불가, 2 인자 오류·알 수 없는 Tool, 3 APPROVAL_REQUIRED(비대화형).
 */

export interface LifecycleCommandIO extends InstallCommandIO {
  fetch?: FetchLike;
  healthSpawner?: HealthSpawner;
  killTree?: TreeKiller;
  runHealth?: LifecycleEnvironment["runHealth"];
  tempBase?: string;
}

const FORBIDDEN_FLAGS = /^(?:--yes|-y|--approve|--auto-approve|--force)(?:=.*)?$/u;
const STATE_UNREADABLE = new Set(["STATE_CORRUPT", "STATE_VERSION_UNSUPPORTED", "STATE_PATH_ESCAPE"]);
const RESOLVER_CODES = new Set(["RESOLVER_SOURCE_UNSUPPORTED", "RESOLUTION_TIMEOUT", "RESOLUTION_OFFLINE", "RESOLUTION_TOO_LARGE", "RESOLUTION_INVALID"]);

/** CLI lifecycle 승인: base는 toolId 정확 입력, 나머지 요구는 각각 y/N. 하나라도 아니면 거절이다. */
export function cliLifecyclePrompter(toolId: string, prompter: InstallPrompter, io: Pick<InstallCommandIO, "out">): LifecycleApprovalPrompter {
  return {
    channel: "cli-tty",
    async confirm(request) {
      const extras = request.requirements.filter((r) => r.id !== "base");
      for (const r of extras) {
        io.out("");
        io.out("[" + r.id + "] " + r.message);
        const answer = (await prompter.ask("  확인합니까? (y/N) ")).trim().toLowerCase();
        if (answer !== "y" && answer !== "yes") return "rejected";
      }
      io.out("");
      io.out(LIFECYCLE_APPROVAL_MESSAGES.base);
      const typed = await prompter.ask("  진행하려면 Tool ID(" + toolId + ")를 정확히 입력하세요: ");
      if (typed.trim() !== toolId) return "rejected";
      return ["base", ...extras.map((r) => r.id)] as LifecycleApprovalRequirement[];
    },
  };
}

const EXIT_BY_STATUS: Readonly<Record<LifecycleResultV1["status"], number>> = {
  updated: 0,
  "rolled-back": 0,
  "health-checked": 0,
  repaired: 0,
  "up-to-date": 0,
  "resolution-failed": 1,
  "approval-required": 3,
  stale: 1,
  "preparation-failed": 1,
  "config-failed": 1,
  "health-failed": 1,
  "state-commit-failed": 1,
  "rollback-failed": 1,
};

async function registryOf(io: LifecycleCommandIO) {
  const { entries, issues } = await loadRegistry(registryDirOf(io));
  for (const issue of issues) io.err("경고: " + formatRegistryIssue(issue));
  return entries;
}

function environment(io: LifecycleCommandIO, entries: Awaited<ReturnType<typeof registryOf>>): LifecycleEnvironment {
  return {
    loadEntries: async () => entries,
    probe: io.probe ?? (() => probeBackends()),
    tempBase: io.tempBase ?? os.tmpdir(),
    now: io.now ?? (() => new Date()),
    // npx Prepare의 npm 자식 process에는 허용 목록 환경만 넘긴다(API key·token·클라우드 자격증명 제외).
    npmChildEnv: () => npmChildEnv(process.env),
    windowsNpx: async () => {
      const host = { ...defaultHostEnvironment(), ...(io.hostEnvironment ?? {}) };
      return locateWindowsNpxLauncher({ pathEnv: host.pathEnv, fs: host.fs });
    },
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    ...(io.configFs === undefined ? {} : { configFs: io.configFs }),
    ...(io.spawner === undefined ? {} : { spawner: io.spawner }),
    ...(io.isolatedDir === undefined ? {} : { isolatedDir: io.isolatedDir }),
    ...(io.healthSpawner === undefined ? {} : { healthSpawner: io.healthSpawner }),
    ...(io.killTree === undefined ? {} : { killTree: io.killTree }),
    ...(io.runHealth === undefined ? {} : { runHealth: io.runHealth }),
  };
}

const forbidden = (argv: readonly string[], io: LifecycleCommandIO) => {
  if (argv.some((a) => FORBIDDEN_FLAGS.test(a))) {
    io.err("자동 승인 옵션은 지원하지 않습니다. 업데이트·롤백·Health Check는 대화형 터미널에서 사람이 직접 승인해야 합니다.");
    return true;
  }
  return false;
};

/** openhub lifecycle <status|health> … */
export async function runLifecycle(argv: readonly string[], io: LifecycleCommandIO, usage: string): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "status") return runStatus(rest, io, usage);
  if (sub === "health") return runLifecycleOperation("health", rest, io, usage);
  if (sub === "repair") return runLifecycleOperation("repair", rest, io, usage);
  io.err("알 수 없는 lifecycle 하위 명령: " + (sub ?? "(없음)") + "\n\n" + usage);
  return 2;
}

async function runStatus(argv: readonly string[], io: LifecycleCommandIO, usage: string): Promise<number> {
  if (forbidden(argv, io)) return 2;
  let values;
  try {
    values = parseArgs({
      args: [...argv],
      options: { project: { type: "string" }, "include-host": { type: "boolean", default: false }, check: { type: "boolean", default: false }, json: { type: "boolean", default: false } },
      allowPositionals: false,
      strict: true,
    }).values;
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return 2;
  }
  const platform = toRecommendPlatform(io.platform ?? process.platform);
  if (platform === undefined) {
    io.err("이 운영체제에서는 lifecycle을 지원하지 않습니다.");
    return 1;
  }
  const entries = await registryOf(io);
  const projectRoot = path.resolve(io.cwd, values.project ?? ".");
  const homeDir = io.homeDir ?? os.homedir();
  const status = await lifecycleStatus({ projectRoot, homeDir, entries, platform, includeUser: values["include-host"], ...(io.configFs === undefined ? {} : { fs: io.configFs }) });
  if (!status.ok) {
    io.err(STATE_UNREADABLE.has(status.code) ? stateUnreadableMessage(status.code) : "Version State를 읽지 못했습니다 (" + status.code + ")");
    return 1;
  }
  const checks: { serverName: string; client: string; scope: string; toolId: string; result: string; from: string | null; to: string | null }[] = [];
  if (values.check) {
    const env = environment(io, entries);
    for (const item of status.items) {
      if (item.toolId === null || item.revision === null) continue;
      const request: LifecycleRequest = { operation: "update", toolId: item.toolId, projectRoot, homeDir, platform, includeUser: item.scope === "user", targets: [{ client: item.client as InstallClient, scope: item.scope }] };
      const r = await planLifecycleRequest(request, env);
      const row = { serverName: item.serverName, client: item.client, scope: item.scope, toolId: item.toolId };
      if (!r.ok) checks.push({ ...row, result: "check-failed:" + r.code, from: null, to: null });
      else {
        const p = r.planned.plan;
        const result = p.status === "ready" ? "update-available" : p.status === "up-to-date" ? "up-to-date" : p.status + ":" + p.warnings.map((w) => w.code).join(",");
        checks.push({ ...row, result, from: p.current.identity?.spec ?? p.current.requested, to: p.target.identity?.spec ?? null });
      }
    }
  }
  if (values.json) {
    io.out(JSON.stringify({ items: status.items, ...(values.check ? { checks } : {}) }, null, 2));
    return 0;
  }
  if (status.items.length === 0) io.out("OpenHub Version State에 기록된 도구가 없습니다(" + LIFECYCLE_STATE_LOGICAL_PATH + ").");
  for (const item of status.items) {
    for (const line of formatLifecycleStatusItem(item)) io.out(line);
    const check = checks.find((c) => c.serverName === item.serverName && c.client === item.client && c.scope === item.scope);
    if (check !== undefined) {
      io.out(
        "  업데이트   " +
          (check.result === "update-available"
            ? "있음 " + check.from + " → " + check.to + " (openhub update " + check.toolId + ")"
            : check.result === "up-to-date"
              ? "없음(최신)"
              : "확인하지 못함 (" + check.result + ")"),
      );
    }
    io.out("");
  }
  if (!values["include-host"]) io.out("사용자 범위 설정은 확인하지 않았습니다(--include-host로 켭니다).");
  return 0;
}

/** openhub update | rollback | lifecycle health <toolId> … */
export async function runLifecycleOperation(operation: LifecycleOperation, argv: readonly string[], io: LifecycleCommandIO, usage: string): Promise<number> {
  if (forbidden(argv, io)) return 2;
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        project: { type: "string" },
        client: { type: "string", multiple: true },
        scope: { type: "string", default: "project" },
        json: { type: "boolean", default: false },
        ...(operation === "update" ? { to: { type: "string" as const } } : {}),
        ...(operation === "health" || operation === "repair" ? {} : { "skip-health": { type: "boolean" as const, default: false } }),
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    io.err("Tool ID를 하나 지정하세요\n\n" + usage);
    return 2;
  }
  const toolId = parsed.positionals[0] as string;
  const values = parsed.values as { project?: string; client?: string[]; scope: string; json: boolean; to?: string; "skip-health"?: boolean };
  if (values.scope !== "project" && values.scope !== "user") {
    io.err("--scope는 project 또는 user입니다");
    return 2;
  }
  const clients = values.client ?? [];
  if (clients.some((c) => !(INSTALL_CLIENTS as readonly string[]).includes(c))) {
    io.err("--client는 " + INSTALL_CLIENTS.join(", ") + " 중 하나입니다");
    return 2;
  }
  if (values.scope === "user" && clients.length === 0) {
    io.err("--scope user에는 --client를 함께 지정하세요");
    return 2;
  }
  const prompter = io.prompter ?? createTtyPrompter();
  if (!values.json && !prompter.isTTY) {
    io.err("APPROVAL_REQUIRED: 업데이트·롤백·Health Check는 대화형 터미널에서 사람이 승인해야 합니다. 계획만 보려면 --json을 쓰세요.");
    return 3;
  }
  const entries = await registryOf(io);
  if (!entries.some((e) => e.manifest.name === toolId)) {
    io.err("Registry에 없는 Tool입니다. openhub registry list로 Tool ID를 확인하세요.");
    return 2;
  }
  const platform = toRecommendPlatform(io.platform ?? process.platform);
  if (platform === undefined) {
    io.err("이 운영체제에서는 lifecycle을 지원하지 않습니다.");
    return 1;
  }
  const request: LifecycleRequest = {
    operation,
    toolId,
    projectRoot: path.resolve(io.cwd, values.project ?? "."),
    homeDir: io.homeDir ?? os.homedir(),
    platform,
    includeUser: values.scope === "user",
    ...(clients.length === 0 ? {} : { targets: clients.map((client) => ({ client: client as InstallClient, scope: values.scope as "project" | "user" })) }),
    ...(values.to === undefined ? {} : { to: values.to }),
    ...(values["skip-health"] === true ? { skipHealth: true } : {}),
  };
  const env = environment(io, entries);
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) {
    if (STATE_UNREADABLE.has(built.code)) io.err(stateUnreadableMessage(built.code));
    else if (built.code === "NOT_MANAGED") io.err("Version State에 이 프로젝트의 " + toolId + " 기록이 없습니다. openhub install로 설치한 도구만 다룹니다.");
    else if (built.code === "NO_ROLLBACK_TARGET") io.err("되돌릴 직전 버전이 없습니다(update를 한 번 이상 성공한 뒤에만 롤백할 수 있습니다).");
    else if (RESOLVER_CODES.has(built.code)) io.err("registry에서 버전을 확인하지 못했습니다 (" + built.code + "). " + built.message);
    else io.err("계획을 만들지 못했습니다 (" + built.code + "). " + built.message);
    return built.code === "HEALTH_SKIP_NOT_ALLOWED" || built.code === "INVALID_TARGET_VERSION" || built.code === "TOOL_NOT_FOUND" ? 2 : 1;
  }
  const planned = built.planned;
  if (values.json) {
    io.out(JSON.stringify({ planDigest: planned.planDigest, plan: JSON.parse(serializeLifecyclePlan(lifecyclePlanSchema.parse(planned.plan))) }, null, 2));
    return 0;
  }
  if (operation === "update") {
    // M6(D-024): Preview 앞에 Update available·Impact·Reasons·Summary를 붙인다. LifecyclePlan·승인 요구는 그대로다.
    const read = await readLifecycleState({ homeDir: request.homeDir, ...(io.configFs === undefined ? {} : { fs: io.configFs }) });
    const state = read.ok ? (read.state.entries[planned.plan.targets[0]!.entryKey] ?? null) : null;
    const manifest = entries.find((e) => e.manifest.name === toolId)!.manifest;
    for (const line of await updateImpactHeader(planned.plan, manifest, state, io, { projectRoot: request.projectRoot, homeDir: request.homeDir })) io.out(line);
  }
  for (const line of formatLifecyclePlanPreview(planned)) io.out(line);
  if (planned.plan.status === "up-to-date") {
    const result = await runLifecycleTransaction(planned, undefined, request, env);
    for (const line of formatLifecycleResult(result)) io.out(line);
    return EXIT_BY_STATUS[result.status];
  }
  if (planned.plan.status !== "ready") {
    io.err("실행할 수 없는 계획입니다 (" + planned.plan.status + "). 위 Warnings를 확인하세요. 자동으로 고치지 않습니다.");
    return 1;
  }
  const outcome = await requestLifecycleApproval(planned, cliLifecyclePrompter(toolId, prompter, io));
  if (outcome.status !== "approved") {
    io.err(outcome.status === "rejected" ? "승인하지 않아 중단했습니다. 아무것도 바꾸지 않았습니다." : "승인할 수 없는 계획입니다.");
    return 1;
  }
  const result = await runLifecycleTransaction(planned, outcome.approval, request, env);
  for (const line of formatLifecycleResult(result)) io.out(line);
  return EXIT_BY_STATUS[result.status];
}

