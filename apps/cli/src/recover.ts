import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  RECOVERY_APPROVAL_MESSAGES,
  executeRecovery,
  planRecovery,
  requestRecoveryApproval,
  type RecoveryApprovalPrompter,
  type RecoveryApprovalRequirement,
  type RecoveryMode,
  type RecoveryPlanOptions,
} from "@openhub/core";
import { createTtyPrompter, type InstallCommandIO, type InstallPrompter } from "./install";

/**
 * (v0.2.1 P0-3) openhub lifecycle recover <toolId> [--project <p>] [--discard] [--json]
 * 중간에 끝난 update·rollback·repair(Journal)를 보여 주고 승인을 받아 되돌린다(undo). --discard는 이미 변경 전 상태일 때 기록만 지운다.
 * 승인 규칙은 다른 lifecycle 명령과 같다(추가 항목 y/N, 마지막에 Tool ID 정확 입력). 비TTY는 exit 3, --json은 Plan만(쓰기 0).
 */
const FORBIDDEN_FLAGS = /^(?:--yes|-y|--approve|--auto-approve|--force)(?:=.*)?$/u;
const TARGET_LABEL = { after: "OpenHub가 쓰다 만 내용(되돌림 대상)", before: "변경 전과 같음", other: "외부 변경(덮어쓰지 않음)", missing: "항목 없음(덮어쓰지 않음)" } as const;

function prompterFor(toolId: string, prompter: InstallPrompter, io: Pick<InstallCommandIO, "out">): RecoveryApprovalPrompter {
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
      io.out(RECOVERY_APPROVAL_MESSAGES.base);
      const typed = await prompter.ask("  진행하려면 Tool ID(" + toolId + ")를 정확히 입력하세요: ");
      if (typed.trim() !== toolId) return "rejected";
      return ["base", ...extras.map((r) => r.id)] as RecoveryApprovalRequirement[];
    },
  };
}

export async function runRecover(argv: readonly string[], io: InstallCommandIO, usage: string): Promise<number> {
  if (argv.some((a) => FORBIDDEN_FLAGS.test(a))) {
    io.err("자동 승인 옵션은 지원하지 않습니다. 복구는 대화형 터미널에서 사람이 직접 승인해야 합니다.");
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], options: { project: { type: "string" }, discard: { type: "boolean", default: false }, json: { type: "boolean", default: false } }, allowPositionals: true, strict: true });
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    io.err("복구할 Tool ID를 하나 지정하세요\n\n" + usage);
    return 2;
  }
  const toolId = parsed.positionals[0]!;
  const mode: RecoveryMode = parsed.values.discard ? "discard" : "undo";
  const options: RecoveryPlanOptions = { toolId, projectRoot: path.resolve(io.cwd, parsed.values.project ?? "."), homeDir: io.homeDir ?? os.homedir(), mode, ...(io.configFs === undefined ? {} : { fs: io.configFs }) };
  const built = await planRecovery(options);
  if (!built.ok) {
    io.err(built.code === "NO_INTERRUPTED_OPERATION" ? built.message + ". 복구할 것이 없습니다." : "복구 계획을 만들지 못했습니다 (" + built.code + "). " + built.message);
    return built.code === "NO_INTERRUPTED_OPERATION" ? 0 : 1;
  }
  const plan = built.planned.plan;
  if (parsed.values.json) {
    io.out(JSON.stringify({ planDigest: built.planned.planDigest, plan }, null, 2));
    return 0;
  }
  io.out(toolId + " 중간에 끝난 작업 복구 계획 (" + plan.status + ")");
  io.out("  작업        " + plan.operation + " · 단계 " + plan.phase + " · 기록 " + plan.transactionId.slice(0, 12));
  io.out("  방법        " + (mode === "undo" ? "되돌리기(undo): 변경 전 항목으로 교체, Version State는 그대로" : "기록만 지우기(discard)"));
  for (const t of plan.targets) io.out("  - " + t.file + " " + t.serverName + " (" + t.scope + "): " + TARGET_LABEL[t.current]);
  for (const b of plan.blockers) io.out("  차단: " + b.code + " — " + b.message);
  io.out("  Plan digest " + built.planned.planDigest);
  if (plan.status !== "ready") {
    io.err("이 상태에서는 자동으로 복구하지 않습니다. 위 안내에 따라 파일을 확인하세요. 아무것도 바꾸지 않았습니다.");
    return 1;
  }
  const prompter = io.prompter ?? createTtyPrompter();
  if (!prompter.isTTY) {
    io.err("APPROVAL_REQUIRED: 복구는 대화형 터미널에서 사람이 승인해야 합니다. 계획만 보려면 --json을 쓰세요.");
    return 3;
  }
  const outcome = await requestRecoveryApproval(built.planned, prompterFor(toolId, prompter, io));
  if (outcome.status !== "approved") {
    io.err("승인하지 않아 복구를 중단했습니다. 아무것도 바꾸지 않았습니다.");
    return 1;
  }
  const r = await executeRecovery(outcome.approval, { toolId, projectRoot: options.projectRoot, homeDir: options.homeDir, regenerate: () => planRecovery(options), ...(io.configFs === undefined ? {} : { fs: io.configFs }) });
  io.out("");
  io.out("결과  " + r.status + (r.error === null ? "" : " (" + r.error.code + ")"));
  for (const t of r.targets) io.out("  " + t.file + " " + t.serverName + ": " + (t.restored ? "변경 전으로 되돌림" : "바꾸지 않음"));
  for (const a of r.nextActions) io.out("  - " + a);
  return r.status === "recovered" || r.status === "discarded" ? 0 : 1;
}
