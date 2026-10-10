import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  APPROVAL_REQUIREMENT_MESSAGES,
  INSTALL_CLIENTS,
  LIFECYCLE_STATE_LOGICAL_PATH,
  analyzeProject,
  defaultHostEnvironment,
  formatInstallPlanPreview,
  formatRegistryIssue,
  installPlanSchema,
  loadRegistry,
  locateWindowsNpxLauncher,
  npmChildEnv,
  planInstall,
  probeBackends,
  recordInstallInState,
  requestApproval,
  runInstallTransaction,
  serializeInstallPlan,
  toRecommendPlatform,
  verifyInstallation,
  type ApprovalPrompter,
  type ApprovalRequirement,
  type BackendProbeReport,
  type ConfigFs,
  type ExecSpawner,
  type HostEnvironment,
  type InstallClient,
  type InstallEnvironment,
  type InstallRequest,
  type InstallResultV1,
  type IsolatedDir,
  type PlannedInstall,
  type ProjectDetector,
} from "@openhub/core";
import { registryDirOf } from "./paths";

/**
 * openhub install <toolId> [--project <path>] [--client <id>]… [--scope project|user] [--json] (TASK-035, D-012)
 * - Recommendation은 승인이 아니다. 대화형 터미널(TTY)에서 사람이 toolId를 정확히 입력하고,
 *   추가 승인 항목마다 따로 y/N에 답해야만 실행한다.
 * - auto approve, --yes, -y, --approve <digest>는 없다(exit 2). TTY가 아니면 --json(Plan만 출력) 외에는 exit 3.
 * - 종료 코드: 0 성공·no-op·--json, 1 설치 불가·사람이 거절·실패, 2 인자 오류·알 수 없는 Tool, 3 APPROVAL_REQUIRED(비대화형).
 */

/** 터미널 질문 한 개. 사람이 입력한 문자열을 돌려준다. */
export interface InstallPrompter {
  readonly isTTY: boolean;
  ask(question: string): Promise<string>;
}

export interface InstallCommandIO {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  prompter?: InstallPrompter;
  detectors?: readonly ProjectDetector[];
  hostEnvironment?: Partial<HostEnvironment>;
  probe?: () => Promise<BackendProbeReport>;
  spawner?: ExecSpawner;
  configFs?: ConfigFs;
  isolatedDir?: () => Promise<IsolatedDir>;
  homeDir?: string;
  /** 테스트용 시계(Version State committedAt). */
  now?: () => Date;
  /** 테스트용 OS 주입(process.platform 형식). */
  platform?: string;
}

const FORBIDDEN_FLAGS = /^(?:--yes|-y|--approve|--auto-approve|--force)(?:=.*)?$/u;

/** 실제 터미널 prompter. stdin·stdout이 모두 TTY일 때만 isTTY다. */
export function createTtyPrompter(): InstallPrompter {
  const isTTY = process.stdin.isTTY === true && process.stdout.isTTY === true;
  return {
    isTTY,
    async ask(question) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}

/** CLI 승인: base는 toolId 정확 입력, 나머지 요구는 각각 y/N. 하나라도 아니면 거절이다. */
export function cliApprovalPrompter(toolId: string, prompter: InstallPrompter, io: Pick<InstallCommandIO, "out">): ApprovalPrompter {
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
      io.out(APPROVAL_REQUIREMENT_MESSAGES.base);
      const typed = await prompter.ask("  진행하려면 Tool ID(" + toolId + ")를 정확히 입력하세요: ");
      if (typed.trim() !== toolId) return "rejected";
      return ["base", ...extras.map((r) => r.id)] as ApprovalRequirement[];
    },
  };
}

const VERIFICATION_LABEL = { "launch-on-demand": "launch-on-demand(Client 첫 실행 때 받음)", pulled: "pulled", cached: "cached(npx cache에 미리 받음)", failed: "failed" } as const;

export function formatInstallResult(result: InstallResultV1): string[] {
  const lines = ["", "결과  " + result.status + (result.code === undefined ? "" : " (" + result.code + ")")];
  if (result.changed !== undefined) lines.push("  바뀐 항목: " + result.changed.join(", "));
  if (result.verification !== null) {
    const v = result.verification;
    lines.push("  Prepared    " + VERIFICATION_LABEL[v.prepared]);
    lines.push("  Configured  " + (v.configured ? "예" : "아니오"));
    lines.push("  Detected    " + (v.detected === "skipped" ? "확인 안 함" : v.detected ? "예" : "아니오"));
    lines.push("  (Prepared·Configured·Detected는 서버가 실행 중이거나 정상임을 뜻하지 않습니다)");
  }
  for (const c of result.configChanges) lines.push("  설정 " + c.file + " (" + c.scope + "): " + (c.restored ? "원래 내용으로 되돌림" : c.applied ? "기록함" : "쓰지 않음"));
  for (const s of result.steps.filter((x) => x.status === "failed")) lines.push("  실패 단계 " + s.id + (s.excerpt === undefined ? "" : ": " + s.excerpt.split("\n").slice(-3).join(" / ")));
  for (const w of result.warnings) lines.push("  - [" + w.code + "] " + w.message);
  if (result.nextActions.length > 0) {
    lines.push("", "다음에 할 일");
    for (const a of result.nextActions) lines.push("  - " + a);
  }
  return lines;
}

const EXIT_BY_STATUS: Readonly<Record<InstallResultV1["status"], number>> = {
  succeeded: 0,
  "no-op": 0,
  failed: 1,
  "partial-compensated": 1,
  stale: 1,
  rejected: 1,
  "approval-required": 3,
};

/** 설치가 succeeded이면 Version State(~/.openhub/state/lifecycle.json)에 기록한다(TASK-038). 실패해도 설치 결과는 바꾸지 않는다. */
async function recordInState(planned: PlannedInstall, result: InstallResultV1, request: InstallRequest, io: InstallCommandIO): Promise<void> {
  if (result.status !== "succeeded") return;
  const recorded = await recordInstallInState(planned, result, {
    projectRoot: request.projectRoot,
    homeDir: request.homeDir,
    ...(io.configFs === undefined ? {} : { fs: io.configFs }),
    now: io.now ?? (() => new Date()),
  });
  if (recorded.ok && recorded.recorded > 0) io.out("Version State  " + LIFECYCLE_STATE_LOGICAL_PATH + "에 " + recorded.recorded + "개 기록");
  else if (!recorded.ok) io.err("경고: Version State를 기록하지 못했습니다 (" + recorded.code + "). 설치 결과는 그대로입니다.");
}

export async function runInstall(argv: readonly string[], io: InstallCommandIO, usage: string): Promise<number> {
  const forbidden = argv.find((a) => FORBIDDEN_FLAGS.test(a));
  if (forbidden !== undefined) {
    io.err("자동 승인 옵션은 지원하지 않습니다. 설치는 대화형 터미널에서 사람이 직접 승인해야 합니다.");
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        project: { type: "string" },
        client: { type: "string", multiple: true },
        scope: { type: "string", default: "project" },
        json: { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    io.err("설치할 Tool ID를 하나 지정하세요\n\n" + usage);
    return 2;
  }
  const toolId = parsed.positionals[0] as string;
  const scope = parsed.values.scope;
  if (scope !== "project" && scope !== "user") {
    io.err("--scope는 project 또는 user입니다");
    return 2;
  }
  const clients = parsed.values.client ?? [];
  if (clients.some((c) => !(INSTALL_CLIENTS as readonly string[]).includes(c))) {
    io.err("--client는 " + INSTALL_CLIENTS.join(", ") + " 중 하나입니다");
    return 2;
  }
  const json = parsed.values.json;
  const prompter = io.prompter ?? createTtyPrompter();
  if (!json && !prompter.isTTY) {
    io.err("APPROVAL_REQUIRED: 설치는 대화형 터미널에서 사람이 승인해야 합니다. 계획만 보려면 --json을 쓰세요.");
    return 3;
  }

  const { entries, issues } = await loadRegistry(registryDirOf(io));
  for (const issue of issues) io.err("경고: " + formatRegistryIssue(issue));
  if (!entries.some((e) => e.manifest.name === toolId)) {
    io.err("Registry에 없는 Tool입니다. openhub registry list로 Tool ID를 확인하세요.");
    return 2;
  }
  const platform = toRecommendPlatform(io.platform ?? process.platform);
  if (platform === undefined) {
    io.err("이 운영체제에서는 설치를 지원하지 않습니다.");
    return 1;
  }
  const projectRoot = path.resolve(io.cwd, parsed.values.project ?? ".");
  // user scope 설치는 사용자 범위 설정을 확인해야 하므로 host 검사를 자동으로 켠다(AC-035-09).
  const includeHost = scope === "user";
  const env: InstallEnvironment = {
    loadEntries: async () => entries,
    analyze: async (root, host) => {
      const result = await analyzeProject(root, {
        ...(io.detectors === undefined ? {} : { detectors: io.detectors }),
        ...(host ? { includeHost: io.hostEnvironment ?? true } : {}),
      });
      if (!result.ok) throw new Error(result.error.code);
      return result.profile;
    },
    probe: io.probe ?? (() => probeBackends()),
    verify: verifyInstallation,
    // npx Prepare(정확한 버전 npx 패키지)는 Windows에서 cmd 없이 node.exe + npx-cli.js로 실행한다.
    // npx Prepare의 npm 자식 process에는 허용 목록 환경만 넘긴다(API key·token·클라우드 자격증명 제외).
    npmChildEnv: () => npmChildEnv(process.env),
    windowsNpx: async () => {
      const host = { ...defaultHostEnvironment(), ...(io.hostEnvironment ?? {}) };
      return locateWindowsNpxLauncher({ pathEnv: host.pathEnv, fs: host.fs });
    },
    ...(io.spawner === undefined ? {} : { spawner: io.spawner }),
    ...(io.configFs === undefined ? {} : { configFs: io.configFs }),
    ...(io.isolatedDir === undefined ? {} : { isolatedDir: io.isolatedDir }),
  };

  let targetClients = clients as InstallClient[];
  if (targetClients.length === 0) {
    let profile;
    try {
      profile = await env.analyze(projectRoot, includeHost);
    } catch {
      io.err("설치할 수 없습니다: 프로젝트를 분석하지 못했습니다.");
      return 1;
    }
    targetClients = INSTALL_CLIENTS.filter((c) => profile.aiClients.some((a) => a.id === c));
    if (targetClients.length === 0) {
      io.err("프로젝트에서 Agent Client를 찾지 못했습니다. --client로 지정하세요(" + INSTALL_CLIENTS.join(", ") + ").");
      return 2;
    }
  }
  const request: InstallRequest = {
    toolId,
    projectRoot,
    homeDir: io.homeDir ?? os.homedir(),
    targets: targetClients.map((client) => ({ client, scope })),
    includeHost,
    platform,
  };

  let built;
  try {
    built = (await planInstall(request, env)).result;
  } catch {
    io.err("설치할 수 없습니다: 설치 계획을 만들지 못했습니다.");
    return 1;
  }
  if (!built.ok) {
    io.err(built.code === "TOOL_NOT_FOUND" ? "Registry에 없는 Tool입니다." : "설치할 수 없습니다: Manifest가 설치 정책을 통과하지 못했습니다 (" + built.code + ")");
    return built.code === "TOOL_NOT_FOUND" ? 2 : 1;
  }
  const planned = built.planned;
  if (json) {
    io.out(JSON.stringify({ planDigest: planned.planDigest, plan: JSON.parse(serializeInstallPlan(installPlanSchema.parse(planned.plan))) }, null, 2));
    return 0;
  }
  for (const line of formatInstallPlanPreview(planned)) io.out(line);
  if (planned.plan.status === "already-installed") {
    const result = await runInstallTransaction(planned, undefined, request, env);
    for (const line of formatInstallResult(result)) io.out(line);
    return EXIT_BY_STATUS[result.status];
  }
  if (planned.plan.status !== "installable") {
    io.err("이 환경에서는 설치할 수 없습니다 (" + planned.plan.status + "). 위 Warnings를 확인하세요.");
    return 1;
  }
  const outcome = await requestApproval(planned, cliApprovalPrompter(toolId, prompter, io));
  if (outcome.status !== "approved") {
    io.err(outcome.status === "rejected" ? "승인하지 않아 설치를 중단했습니다. 아무것도 바꾸지 않았습니다." : "승인할 수 없는 계획입니다.");
    return 1;
  }
  const result = await runInstallTransaction(planned, outcome.approval, request, env);
  for (const line of formatInstallResult(result)) io.out(line);
  await recordInState(planned, result, request, io);
  return EXIT_BY_STATUS[result.status];
}
