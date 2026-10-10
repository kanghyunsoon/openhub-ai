import { resolveInstalledTools } from "../recommendation/index";
import { manualSetupInstructions, readConfiguredEntry } from "./config-writer";
import { canonicalize, requiredEnvNotice, type ConfigPatchStep, type InstallClient, type InstallPlanV1 } from "./plan";
import type { InstallVerifier, VerifierOutput } from "./transaction";
import { preparedStateOf } from "./result";

/**
 * Post-install Verification(TASK-034, D-015 §11). 확인 상태는 Prepared / Configured / Detected다.
 * - Prepared: npx·uvx는 launch-on-demand(OpenHub가 아무것도 실행하지 않음), docker는 pull exit 0일 때 pulled, 아니면 failed.
 * - Configured: 승인한 config 파일을 다시 읽은 항목이 Plan 값과 같다.
 * - Detected: analyzeProject를 다시 실행(user scope면 host 포함)하고 M3 resolver가 서버 이름을 해당 toolId로 resolved한다.
 * - 셋 다 running·healthy를 뜻하지 않는다(Health Check는 M5). 이 단계에서 network·spawn·MCP handshake를 하지 않는다.
 * - Detected만 실패하면 configured-not-detected 경고만 남기고 복구하지 않는다. Configured 실패는 Transaction이 원본으로 복구한다.
 */

const CLIENT_LABEL: Readonly<Record<InstallClient, string>> = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" };

/** 설치 뒤 사용자가 할 일. 상태 이름으로 "Installed"·"설치 완료"를 쓰지 않는다. */
export function installNextActions(plan: InstallPlanV1): string[] {
  const actions: string[] = [];
  const required = plan.requiredEnv.filter((e) => e.required).map((e) => e.name);
  for (const name of required) actions.push(requiredEnvNotice(name) + " Client가 실행되는 환경에 " + name + "을(를) 준비하세요(status: unchecked).");
  const written = plan.steps.filter((s): s is ConfigPatchStep => s.kind === "config-patch");
  const serverName = written[0]?.path[1] ?? plan.targets[0]?.serverName ?? plan.toolId;
  if (written.some((s) => s.client === "claude-code" && s.scope === "project")) {
    actions.push("Claude Code에서 프로젝트 .mcp.json의 " + serverName + " 서버 사용을 승인해야 합니다. OpenHub는 승인 상태를 바꾸지 않습니다.");
  }
  if (written.some((s) => s.client === "codex" && s.scope === "project")) {
    actions.push("Codex는 신뢰된(trusted) 프로젝트에서만 .codex/config.toml을 읽습니다. 이 프로젝트를 Codex에서 trusted로 지정하세요. OpenHub는 trust 설정을 바꾸지 않습니다.");
  }
  if (written.some((s) => s.client === "cursor") && required.length > 0) {
    actions.push("Cursor는 자신의 프로세스 환경에서 환경변수를 읽습니다. Cursor를 실행하는 환경에 " + required.join(", ") + "이(가) 보여야 합니다.");
  }
  if (plan.backend?.adapter === "docker") actions.push("Client가 서버를 시작하려면 docker 데몬이 실행 중이어야 합니다.");
  for (const t of plan.targets.filter((x) => x.envReference === "manual")) actions.push(manualSetupInstructions(t.client, t.scope, t.serverName));
  const clients = [...new Set(written.map((s) => s.client))];
  if (clients.length > 0) actions.push(clients.map((c) => CLIENT_LABEL[c]).join(", ") + "을(를) 다시 시작하거나 MCP 서버 목록을 새로 고치세요.");
  return actions;
}

/** TASK-034 확인기. Transaction의 env.verify로 넘긴다. */
export const verifyInstallation: InstallVerifier = async ({ verified, request, steps, env }): Promise<VerifierOutput> => {
  const plan = verified.plan;
  const runSteps = plan.steps.filter((s) => s.kind === "run");
  const prepared = runSteps.every((s) => steps.find((o) => o.id === s.id)?.status === "done") ? preparedStateOf(plan.artifact?.preparation) : "failed";
  const nextActions = installNextActions(plan);
  if (prepared === "failed") return { verification: { prepared, configured: false, detected: "skipped" }, warnings: [], nextActions };

  const roots = { projectRoot: request.projectRoot, homeDir: request.homeDir, ...(env.configFs === undefined ? {} : { fs: env.configFs }) };
  const configSteps = plan.steps.filter((s): s is ConfigPatchStep => s.kind === "config-patch");
  let configured = configSteps.length > 0;
  for (const step of configSteps) {
    const entry = await readConfiguredEntry(step.client, step.scope, step.path[1]!, roots);
    if (JSON.stringify(canonicalize(entry)) !== JSON.stringify(canonicalize(step.value))) configured = false;
  }
  if (!configured) return { verification: { prepared, configured, detected: "skipped" }, warnings: [], nextActions };

  const includeHost = request.includeHost || configSteps.some((s) => s.scope === "user");
  const serverName = configSteps[0]!.path[1]!;
  let detected = false;
  try {
    const profile = await env.analyze(request.projectRoot, includeHost);
    const entries = await env.loadEntries();
    detected = resolveInstalledTools(profile, entries).some((t) => t.toolId === plan.toolId && t.resolution === "resolved" && t.serverName === serverName);
  } catch {
    detected = false;
  }
  const warnings = detected
    ? []
    : [{ code: "configured-not-detected", message: "설정은 기록됐지만 다시 분석했을 때 " + serverName + " 서버를 찾지 못했습니다. 설정 파일은 되돌리지 않았습니다." }];
  return { verification: { prepared, configured, detected }, warnings, nextActions };
};
