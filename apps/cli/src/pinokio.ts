import { readFile, realpath, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  INSTALL_CLIENTS,
  PINOKIO_APPROVAL_MESSAGES,
  executeWithPinokioApproval,
  fetchThirdPartyScript,
  formatRegistryIssue,
  loadRegistry,
  planPinokio,
  requestPinokioApproval,
  resolveGitHubToken,
  serializePinokioPlan,
  type ExecSpawner,
  type InstallClient,
  type PinokioApprovalRequirement,
  type PinokioPlanRequest,
  type PinokioPlanV1,
  type PinokioPrompter,
  type PinokioProbeEnv,
  type PinokioResultV1,
  type PinokioTimeouts,
} from "@openhub/core";
import { registryDirOf } from "./paths";
import { createTtyPrompter, type InstallPrompter } from "./install";
import { rejectAutoApprove, type ReleaseCommandIO } from "./release";

/**
 * openhub install <toolId> --backend pinokio, openhub pinokio inspect <repo>@<commit>(TASK-056, D-027).
 * - install: PinokioPlan Preview → 대화형 터미널 승인(추가 요구마다 y/N + toolId 입력) → 실행 직전 재생성·digest 비교 → 실행.
 *   --json은 Plan과 digest만 출력하고 실행·쓰기 0회, 비TTY 실행 요청은 exit 3, --yes·-y·--approve는 exit 2.
 * - inspect: 제3자 script는 repo·commit 고정 원문과 static warning만 보여 주고 실행하지 않는다(실행 경로가 없다).
 */

export interface PinokioCommandIO extends ReleaseCommandIO {
  pinokioProbe?: Partial<PinokioProbeEnv>;
  pinokioSpawner?: ExecSpawner;
  pinokioTimeouts?: Partial<PinokioTimeouts>;
}

const nodeProbeFs = { stat: (f: string) => stat(f), readFile: (f: string) => readFile(f, "utf8"), realpath: (f: string) => realpath(f) };

export function formatPinokioPreview(plan: PinokioPlanV1, planDigest: string): string[] {
  const lines = [plan.toolId + " Pinokio " + plan.operation + " 계획", ""];
  lines.push("상태        " + plan.status);
  lines.push("저장소      " + plan.repo + " @ " + plan.commit + (plan.previousCommit === null ? "" : " (현재 " + plan.previousCommit + ")"));
  lines.push("Pinokio app " + plan.appRef + " (ref " + plan.ref + ")");
  lines.push("버전        pterm " + plan.versions.pterm + " · pinokiod " + plan.versions.pinokiod + " · script " + plan.versions.script);
  lines.push("", "생성 script (Pinokio가 shell.run을 셸로 실행합니다)");
  for (const s of plan.scripts) {
    const body = JSON.parse(s.content.slice("module.exports = ".length, -2)) as { run: { method: string; params: Record<string, unknown> }[] };
    lines.push("  " + s.name + "  " + s.digest);
    for (const step of body.run) lines.push("    - " + step.method + (typeof step.params["message"] === "string" ? ": " + step.params["message"] : typeof step.params["path"] === "string" ? " " + step.params["path"] : ""));
  }
  if (plan.recovery !== null) lines.push("  복구용 openhub-update.js(Health 실패 시 이전 commit으로)  " + plan.recovery.digest);
  lines.push("", "실행        " + (plan.run.script ?? "없음(Health만)") + (plan.start.args.length === 0 ? "" : " · start 인자 " + plan.start.args.map((a) => "--" + a.key + "=" + a.value).join(" ")));
  lines.push("Health      " + plan.health.url + " → " + String(plan.health.expectStatus) + " 확인 후 pterm stop(상주하지 않음)");
  if (plan.configTargets.length > 0) {
    lines.push("설정 대상");
    for (const t of plan.configTargets) lines.push("  - " + t.file + " (" + t.client + ", " + t.scope + ") " + (t.mode === "write" ? "mcpServers." + t.serverName + " 추가 " + JSON.stringify(t.entry) : "수동 설정 필요"));
  }
  if (plan.notices.length > 0) {
    lines.push("안내");
    for (const n of plan.notices) lines.push("  - [" + n.code + "] " + n.message);
  }
  lines.push("승인 요구   " + plan.approvalRequirements.join(", "));
  lines.push("Plan digest " + planDigest);
  return lines;
}

function cliPinokioPrompter(toolId: string, prompter: InstallPrompter, io: { out(line: string): void }): PinokioPrompter {
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
      io.out(PINOKIO_APPROVAL_MESSAGES.base);
      const typed = await prompter.ask("  진행하려면 Tool ID(" + toolId + ")를 정확히 입력하세요: ");
      if (typed.trim() !== toolId) return "rejected";
      return ["base", ...extras.map((r) => r.id)] as PinokioApprovalRequirement[];
    },
  };
}

function formatPinokioResult(result: PinokioResultV1): string[] {
  const lines = ["", "결과  " + result.status + (result.code === null ? "" : " (" + result.code + ")")];
  if (result.health !== null) lines.push("Health  " + result.health.status + (result.health.httpStatus === null ? "" : " (HTTP " + String(result.health.httpStatus) + ")"));
  if (result.recovered !== null) lines.push("복구    " + (result.recovered ? "생성 script·이전 commit 복구 완료" : "복구 일부 실패 — Pinokio에서 직접 확인하세요"));
  for (const c of result.config) lines.push("설정    " + c.file + " " + c.status);
  for (const n of result.notices) lines.push("안내    " + n.message);
  if (result.stateRevision !== null) lines.push("Pinokio state revision " + String(result.stateRevision));
  return lines;
}

/** openhub install <toolId> --backend pinokio … (argv에서 --backend pinokio는 이미 뺐다) */
export async function runPinokioInstall(argv: readonly string[], io: PinokioCommandIO, usage: string): Promise<number> {
  if (rejectAutoApprove(argv, io)) return 2;
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { project: { type: "string" }, client: { type: "string", multiple: true }, scope: { type: "string", default: "project" }, arg: { type: "string", multiple: true }, json: { type: "boolean", default: false } }, allowPositionals: true, strict: true });
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    io.err("Tool ID를 하나 지정하세요\n\n" + usage);
    return 2;
  }
  const toolId = parsed.positionals[0] as string;
  const v = parsed.values as { project?: string; client?: string[]; scope: string; arg?: string[]; json: boolean };
  const clients = v.client ?? [];
  if ((v.scope !== "project" && v.scope !== "user") || clients.some((c) => !(INSTALL_CLIENTS as readonly string[]).includes(c))) {
    io.err("--scope는 project|user, --client는 " + INSTALL_CLIENTS.join(", ") + " 중 하나입니다");
    return 2;
  }
  const prompter = io.prompter ?? createTtyPrompter();
  if (!v.json && !prompter.isTTY) {
    io.err("APPROVAL_REQUIRED: Pinokio 설치는 대화형 터미널에서 사람이 승인해야 합니다. 계획만 보려면 --json을 쓰세요.");
    return 3;
  }
  const { entries, issues } = await loadRegistry(registryDirOf(io));
  for (const issue of issues) io.err("경고: " + formatRegistryIssue(issue));
  const manifest = entries.find((e) => e.manifest.name === toolId)?.manifest;
  if (manifest === undefined) {
    io.err("Registry에 없는 Tool입니다. openhub registry list로 Tool ID를 확인하세요.");
    return 2;
  }
  const homeDir = io.homeDir ?? os.homedir();
  const projectRoot = path.resolve(io.cwd, v.project ?? ".");
  const probe: PinokioProbeEnv = {
    pathEnv: io.pinokioProbe?.pathEnv ?? io.hostEnvironment?.pathEnv ?? process.env["PATH"] ?? "",
    platform: (io.pinokioProbe?.platform ?? io.platform ?? process.platform) as NodeJS.Platform,
    fs: io.pinokioProbe?.fs ?? nodeProbeFs,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  };
  const request: PinokioPlanRequest = {
    operation: "install",
    manifest,
    scriptArgs: (v.arg ?? []).map((a) => "--" + a),
    ...(clients.length === 0 ? {} : { configTargets: clients.map((client) => ({ client: client as InstallClient, scope: v.scope as "project" | "user" })) }),
  };
  const plan = () => planPinokio(request, { probe, homeDir });
  const first = await plan();
  if (!first.ok) {
    io.err("Pinokio 계획을 만들지 못했습니다 (" + first.code + "). " + first.message);
    return first.code === "PINOKIO_ARGS_REJECTED" || first.code === "PINOKIO_SCRIPT_PATH_REJECTED" || first.code === "PINOKIO_REF_REJECTED" ? 2 : 1;
  }
  if (v.json) {
    io.out(JSON.stringify({ planDigest: first.planned.planDigest, plan: JSON.parse(serializePinokioPlan(first.planned.plan)) }, null, 2));
    return 0;
  }
  for (const line of formatPinokioPreview(first.planned.plan, first.planned.planDigest)) io.out(line);
  if (first.planned.plan.status !== "ready") {
    io.err("실행할 수 없는 계획입니다 (" + first.planned.plan.status + ")");
    return 1;
  }
  const approval = await requestPinokioApproval(first.planned, cliPinokioPrompter(toolId, prompter, io));
  if (approval.status !== "approved") {
    io.err("승인하지 않았습니다. 아무것도 실행하지 않았습니다.");
    return 1;
  }
  const report = await executeWithPinokioApproval(
    approval.approval,
    async () => {
      const again = await plan();
      if (!again.ok) throw new Error(again.code);
      return again.planned;
    },
    { entry: first.entry, homeDir, projectRoot, ...(io.fetch === undefined ? {} : { fetch: io.fetch }), ...(io.pinokioSpawner === undefined ? {} : { spawner: io.pinokioSpawner }), ...(io.pinokioTimeouts === undefined ? {} : { timeouts: io.pinokioTimeouts }), ...(io.now === undefined ? {} : { now: io.now }) },
  );
  if (!report.ok) {
    io.err("실행하지 않았습니다 (" + report.code + "). " + report.message);
    return 1;
  }
  if (!("result" in report)) return 1;
  for (const line of formatPinokioResult(report.result)) io.out(line);
  return report.result.status === "succeeded" ? 0 : 1;
}

/** openhub pinokio inspect <owner/repo>@<40-hex commit> [--path install.js] [--json] — 실행하지 않는다. */
export async function runPinokio(argv: readonly string[], io: PinokioCommandIO, usage: string): Promise<number> {
  if (rejectAutoApprove(argv, io)) return 2;
  const [sub, ...rest] = argv;
  if (sub !== "inspect") {
    io.err("지원하는 하위 명령: inspect\n\n" + usage);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: rest, options: { path: { type: "string", default: "install.js" }, json: { type: "boolean", default: false }, "no-token": { type: "boolean", default: false } }, allowPositionals: true, strict: true });
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return 2;
  }
  const m = /^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})@([0-9a-f]{40})$/u.exec(parsed.positionals[0] ?? "");
  if (m === null || parsed.positionals.length !== 1) {
    io.err("<owner/repo>@<40자리 commit> 형식으로 고정해야 미리 볼 수 있습니다\n\n" + usage);
    return 2;
  }
  const token = parsed.values["no-token"] ? undefined : (await (io.resolveToken ?? (() => resolveGitHubToken()))().catch(() => undefined))?.token;
  const r = await fetchThirdPartyScript({ repo: m[1]!, commit: m[2]!, path: parsed.values.path }, { ...(io.fetch === undefined ? {} : { fetch: io.fetch }), ...(token === undefined ? {} : { githubToken: token }) });
  if (!r.ok) {
    io.err(r.message);
    return r.code === "THIRD_PARTY_INPUT_INVALID" ? 2 : 1;
  }
  if (parsed.values.json) {
    io.out(JSON.stringify(r.preview, null, 2));
    return 0;
  }
  const p = r.preview;
  io.out("제3자 Pinokio script " + p.repo + " @ " + p.commit + " / " + p.path + " (" + p.contentDigest + ")");
  io.out("");
  for (const line of p.content.split(/\r\n|\n|\r/u)) io.out("  | " + line.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " "));
  io.out("");
  io.out("정적 경고 " + String(p.warnings.length) + "건");
  for (const w of p.warnings) io.out("  - L" + String(w.line) + " " + w.code);
  io.out("");
  io.out(p.notice);
  return 0;
}

