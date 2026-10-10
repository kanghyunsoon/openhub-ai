import {
  CAPABILITIES,
  REVIEWED_TOOL_CONFIGS,
  type ApprovalRequirement,
  type InstallPlanV1,
  type InstallResultV1,
  type LifecycleApprovalRequirement,
  type LifecyclePlanV1,
  type LifecycleResultV1,
  type LifecycleToolStatus,
  type PlannedInstall,
  type PlannedLifecycle,
  type TrendItem,
} from "@openhub/core";

/**
 * Core가 만드는 문장의 영어 표시(Desktop English 모드 전용, v0.2.0 P0-3 PR B).
 * - Core 문장(한국어)을 문자열로 찾거나 바꾸지 않는다. Plan·Result·Status의 구조(code·필드)로 영어 문장을 새로 만든다.
 * - 한국어 모드는 Core 문장을 그대로 쓴다(CLI와 같은 문장). 이 파일은 English 모드에서만 쓰인다.
 * - 구조에 없는 정보(Core nextActions 원문, 실패 단계 excerpt)는 옮기지 않고 상태·code 기반 안내로 대신한다(docs/specs/desktop-i18n.md).
 */

const CLIENT = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
const clientName = (c: string) => (CLIENT as Record<string, string>)[c] ?? c;
const PLATFORM = { windows: "Windows", macos: "macOS", linux: "Linux" } as const;

export const INSTALL_APPROVAL_EN: Readonly<Record<ApprovalRequirement, string>> = {
  base: "I reviewed the install plan above (commands to run, configuration files to write, network use) and agree to run it as shown.",
  "installation-unknown": "OpenHub could not determine whether this tool is installed. I proceed knowing it may already be installed.",
  "unidentified-present": "An MCP server that OpenHub could not identify is already configured. I proceed knowing the same tool may end up configured twice.",
  "user-scope-config": "Modifies user configuration files outside the project (home directory). This affects other projects too.",
  "fallback-backend": "Installs with a fallback backend instead of the method the Manifest prefers.",
  "floating-artifact": "The remote package version is not pinned. Running later may download a different artifact.",
  "client-env-parse-risk": "You must prepare the required environment variables in the environment where Claude Code runs. OpenHub does not check their values or whether they exist.",
  "tool-config": "OpenHub creates or replaces a reviewed server policy file under ~/.openhub/tool-config and makes the client configuration use it.",
};

export const LIFECYCLE_APPROVAL_EN: Readonly<Record<LifecycleApprovalRequirement, string>> = {
  base: "I reviewed the lifecycle plan above (artifact changes, configuration files to write, commands to run) and agree to run it as shown.",
  "health-execution": "Health Check runs the MCP server (third-party code) in an isolated temporary directory and may download packages or images.",
  "user-scope-config": "Modifies user configuration files outside the project (home directory). This affects other projects too.",
  "environment-unverified": "This tool needs environment variables to run, but OpenHub does not check their values or whether they are set.",
  "health-gate-skipped": "This tool needs environment variables to run, but OpenHub does not check their values or whether they are set. If Health Check is skipped, whether the MCP server actually works after the update is not verified.",
  "rollback-to-previous": "Rolls back to the previous version recorded in Version State. The current version's configuration changes.",
  "tool-config": "OpenHub creates or replaces a reviewed server policy file under ~/.openhub/tool-config and makes the client configuration use it.",
};

const requiredEnvEn = (names: readonly string[]) =>
  "This tool needs the environment variable" + (names.length > 1 ? "s " : " ") + names.join(", ") + " to run. OpenHub does not check, read or store their values or whether they are set.";

const NOTICE_EN: Readonly<Record<string, string>> = {
  "floating-artifact": "This install plan pins the command and configuration, but not the remote package content itself. Running the same plan later may download a different artifact.",
  "npx-prepare": "Before writing configuration, the npm package of this version is downloaded into the npx cache. The MCP server is not started, but npm may run install scripts of dependencies during installation (as on the client's first start). If an incomplete cache entry of the same package and version exists, only that entry is removed and downloaded again.",
  "database-credential-scope": "This tool acts with the permissions of the database credentials in its environment variable. The MCP server's read-only setting does not reduce database permissions, so use a database account with read permission only.",
  "health-execution": "Health Check runs the MCP server (third-party code) in an isolated temporary directory and may download packages or images.",
  "client-wrapper-not-verified": "Health Check verifies the artifact. It does not verify the cmd /d /c npx wrapper in the client configuration itself.",
  "version-level-lock": "npm and PyPI packages are pinned at the version level. The tarball content of the same version is not pinned.",
  "rollback-artifact-unlocked": "The previous version's artifact was not pinned (unlocked). The previous configuration, launch command and Version State are restored, but the exact same package version or image is not guaranteed. The artifact stays unlocked after the rollback.",
  "health-gate-skipped": "This tool needs environment variables to run, but OpenHub does not check their values or whether they are set. If Health Check is skipped, whether the MCP server actually works after the update is not verified.",
  "health-not-verified": "Health: Not verified / Reason: Required environment is unchecked",
  "client-env-parse-risk": "You must prepare the required environment variables in the environment where Claude Code runs. OpenHub does not check their values or whether they exist; if they are missing, parsing .mcp.json may be affected.",
};

/** 대문자 code(차단·실행 불가 사유)의 영어 문장. 파일·서버 이름이 Core 문장 안에만 있는 경우는 일반 문장으로 쓴다. */
const BLOCKER_EN: Readonly<Record<string, string>> = {
  CONFIG_UNREADABLE: "The configuration file could not be read safely.",
  MISSING_CONFIG: "The entry is missing from the configuration file (it differs from Version State).",
  CONFIG_DRIFT: "The configuration entry differs from what OpenHub recorded (config-drift).",
  TOOL_CONFIG_UNREADABLE: "The tool config could not be checked safely (symlink, junction or permissions).",
  TOOL_CONFIG_MISSING: "The tool config is missing (tool-config-missing). Recreate it with repair.",
  TOOL_CONFIG_DRIFT: "The tool config differs from what OpenHub recorded (tool-config-drift). Recreate it with repair.",
  TOOL_CONFIG_REJECTED: "The tool config was rejected by OpenHub's reviewed policy.",
  TOOL_CONFIG_UNKNOWN: "This tool config is not on OpenHub's reviewed list.",
  TOOL_CONFIG_VERSION_UNREVIEWED: "The target version has no reviewed tool config, so it is blocked.",
  NOTHING_TO_REPAIR: "The tool config and client configuration match Version State; there is nothing to repair.",
  REPAIR_UNSUPPORTED: "Repair is only for tools that use an OpenHub-managed tool config.",
  CLIENT_LAUNCHER_UNAVAILABLE: "The current Node.js installation (node.exe and npm's npx-cli.js) could not be verified, so the client configuration is not changed. Check the Node.js installation and plan again.",
  CLIENT_LAUNCHER_INVALID: "The Node.js launch path recorded in the client configuration is no longer valid (client-launcher-invalid). Fix it with repair.",
  STATE_DIVERGED: "The selected targets have different current versions. Handle each client and scope separately.",
  PLATFORM_UNSUPPORTED: "This platform is not supported.",
  BACKEND_NOT_IN_MANIFEST: "The current Manifest no longer has this install method.",
  BACKEND_UNAVAILABLE: "The install backend was not found.",
  MANUAL_SETUP_REQUIRED: "OpenHub does not write this configuration file. Set it up yourself.",
  NOT_MANAGED: "There is no OpenHub-managed entry for this target.",
  NO_ROLLBACK_TARGET: "There is no previous version to roll back to.",
  ROLLBACK_UNSUPPORTED: "This tool does not support rollback.",
  ROLLBACK_TARGET_INVALID: "The previous version recorded in Version State cannot be used.",
  HEALTH_SKIP_NOT_ALLOWED: "Skipping Health is allowed only for update and rollback of tools that need environment variables.",
  INVALID_TARGET_VERSION: "The target version format is invalid.",
  MANIFEST_COMMAND_REJECTED: "The Manifest command did not pass OpenHub's command policy.",
  MANIFEST_DRAFT: "This Manifest is a draft and cannot be installed.",
  NO_CANONICAL_ALIAS: "The Manifest has no canonical MCP server name.",
  CLIENT_UNSUPPORTED: "This client is not supported by the tool.",
  UNSUPPORTED_BACKEND: "No supported install backend is available.",
  CONFIG_KEY_EXISTS: "An entry with the same name already exists; OpenHub does not overwrite it.",
  PLAN_NOT_EXECUTABLE: "This plan cannot be executed.",
  PLAN_STALE: "The plan changed after approval.",
  TOOL_NOT_FOUND: "This tool is not in the Registry.",
  USER_SCOPE_NOT_APPROVED: "The user-scope configuration change (user-scope-config) was not approved.",
  CONFIG_WRITE_FAILED: "The configuration file could not be changed. The original file was kept.",
  CONFIG_RESTORE_FAILED: "The original configuration could not be fully restored. Check the configuration file before trying again.",
  RESOLUTION_INVALID: "The exact artifact version could not be resolved.",
  STATE_INVALID: "Version State has an invalid format.",
  STATE_CORRUPT: "Version State could not be read (the file is damaged). OpenHub does not overwrite it.",
  STATE_VERSION_UNSUPPORTED: "This Version State file version is not supported.",
  STATE_PATH_ESCAPE: "The Version State path points outside the OpenHub state directory.",
  STATE_WRITE_FAILED: "Version State could not be written. The previous state was kept.",
  STATE_CONFLICT: "Version State was changed by another process, so it was not overwritten.",
  UP_TO_DATE: "The tool is already at the target version.",
};

/** 영어 문장이 있는 모든 warning·blocker code(누락 검사용). */
export const EN_WARNING_CODES: readonly string[] = Object.freeze([
  ...Object.keys(NOTICE_EN),
  ...Object.keys(BLOCKER_EN),
  "required-env",
  "environment-unverified",
  "tool-config",
  "client-launch-unverified",
  "platform-unverified",
  "docker-daemon-unchecked",
  "manual-setup-required",
  "configured-not-detected",
]);

type AnyPlan = InstallPlanV1 | LifecyclePlanV1;
const isInstall = (plan: AnyPlan): plan is InstallPlanV1 => "launch" in plan;
const requiredNames = (plan: AnyPlan) => plan.requiredEnv.filter((e) => e.required).map((e) => e.name);

/** 검토된 tool config의 Client·플랫폼 검증 수준(Core REVIEWED_TOOL_CONFIGS)으로 영어 경고를 만든다. */
function verificationLinesEn(plan: AnyPlan, code: "client-launch-unverified" | "platform-unverified"): string[] {
  const reviewed = REVIEWED_TOOL_CONFIGS[plan.toolId];
  if (reviewed === undefined) return [];
  if (code === "platform-unverified") {
    const platform = isInstall(plan) ? plan.launch?.platform : plan.platform;
    return platform === undefined || reviewed.platformVerified[platform] ? [] : ["OpenHub has not verified installing or running this tool on " + PLATFORM[platform] + "."];
  }
  const clients = [...new Set(plan.targets.map((t) => t.client))];
  const out: string[] = [];
  for (const c of clients) {
    const level = reviewed.clientVerification[c];
    if (level === "spec-launch-verified") out.push(clientName(c) + ": starting the server and calling tools with the command OpenHub writes was verified, but starting it from this client's project configuration file was not verified by OpenHub.");
    if (level === "config-recognized") out.push(clientName(c) + ": only configuration recognition was verified. A real MCP connection and tool calls in this client were not verified by OpenHub.");
    if (level === "not-verified") out.push(clientName(c) + ": running in this client was not verified by OpenHub.");
  }
  return out;
}

/** warning 목록 → 영어 줄. 같은 code가 여러 번 나오는 항목(환경변수·Client 검증)은 구조에서 한 번에 만든다. */
export function warningsEn(plan: AnyPlan, warnings: readonly { code: string; message: string }[]): { code: string; text: string }[] {
  const out: { code: string; text: string }[] = [];
  const done = new Set<string>();
  for (const w of warnings) {
    if (done.has(w.code)) continue;
    const once = (text: string) => (done.add(w.code), out.push({ code: w.code, text }));
    if (w.code === "required-env" || w.code === "environment-unverified") once(requiredEnvEn(requiredNames(plan)));
    else if (w.code === "client-env-parse-risk") once("You must prepare " + requiredNames(plan).join(", ") + " in the environment where Claude Code runs. OpenHub does not check their values or whether they exist; if they are missing, parsing .mcp.json may be affected.");
    // 검토된 정책별 영어 고지는 Core 보안 허용 목록(REVIEWED_TOOL_CONFIGS.noticeEn)에 정책과 함께 둔다(Tool ID 상수를 Desktop에 두지 않는다).
    else if (w.code === "tool-config") once(REVIEWED_TOOL_CONFIGS[plan.toolId]?.noticeEn ?? "OpenHub creates a reviewed server policy file under ~/.openhub/tool-config and passes it to the server through the client configuration.");
    else if (w.code === "client-launch-unverified" || w.code === "platform-unverified") {
      done.add(w.code);
      for (const text of verificationLinesEn(plan, w.code)) out.push({ code: w.code, text });
    } else if (w.code === "docker-daemon-unchecked")
      out.push({ code: w.code, text: "OpenHub did not check whether the docker daemon is reachable. If the daemon is off, the " + (isInstall(plan) ? "preparation step fails." : "preparation and Health steps fail.") });
    else if (w.code === "manual-setup-required") {
      done.add(w.code);
      for (const t of plan.targets.filter((x) => "envReference" in x && x.envReference === "manual")) out.push({ code: w.code, text: clientName(t.client) + " " + t.scope + " configuration (" + t.file + ") is not written by OpenHub. Set it up yourself." });
    } else if (w.code === "CONFIG_KEY_EXISTS" && isInstall(plan)) {
      done.add(w.code);
      for (const t of plan.targets.filter((x) => x.envReference !== "manual" && !x.precondition.keyAbsent)) out.push({ code: w.code, text: t.file + " already has a " + t.serverName + " entry; OpenHub does not overwrite it." });
    } else if (NOTICE_EN[w.code] !== undefined) out.push({ code: w.code, text: NOTICE_EN[w.code]! });
    else if (BLOCKER_EN[w.code] !== undefined) out.push({ code: w.code, text: BLOCKER_EN[w.code]! });
    else out.push({ code: w.code, text: "(" + w.code + ")" });
  }
  return out;
}

const windowsWrapperEn = "Windows compatibility policy (OpenHub): to let the client run npx, the configuration file records cmd /d /c npx. OpenHub does not run this command.";

export function installationStatusEn(plan: InstallPlanV1): string {
  const { installationStatus, inspectedScopes } = plan.source.recommendation;
  if (installationStatus === "installed") return "Already configured";
  if (installationStatus === "unknown") return "Could not determine whether it is installed";
  if (installationStatus === "unidentified-present") return "An unidentified MCP server already exists";
  return inspectedScopes.includes("user") ? "Not installed (project + user scope checked)" : "Not installed in project scope (user scope not checked)";
}

/** InstallPlan Preview(영어). Core formatInstallPlanPreview와 같은 순서·같은 정보를 Plan 구조에서 만든다. */
export function installPreviewEn(planned: PlannedInstall): string[] {
  const { plan, planDigest } = planned;
  const lines = [plan.displayName + " (" + plan.toolId + ") install plan", ""];
  lines.push("Status       " + installationStatusEn(plan));
  lines.push("Inspected    " + (plan.source.recommendation.inspectedScopes.includes("user") ? "project + user" : "project"));
  if (plan.status !== "installable") lines.push("Executable   no (" + plan.status + ")");
  const backend = plan.backend;
  if (backend !== null) {
    const skipped = backend.skipped.length === 0 ? "" : " · skipped: " + backend.skipped.map((s) => s.adapter + "(" + s.reason + ")").join(", ");
    lines.push("Backend      " + backend.adapter + (backend.selection === "fallback" ? " (fallback backend)" : "") + skipped);
  }
  const runSteps = plan.steps.filter((s) => s.kind === "run");
  if (plan.artifact !== null) {
    lines.push(
      "Preparation  " +
        (runSteps.length === 0
          ? "none — OpenHub runs nothing; the client downloads the package on its first start (launch-on-demand)"
          : runSteps.map((s) => s.executable + " " + s.args.join(" ")).join(", ") +
            (plan.artifact.preparation === "npm-cache"
              ? " — OpenHub downloads this version into the npx cache before writing configuration (the MCP server is not started; network, download, dependency install scripts)"
              : " — run by OpenHub (network, download)")),
    );
  }
  if (plan.launch !== null) {
    lines.push("Client command  " + [plan.launch.clientSpec.command, ...plan.launch.clientSpec.args].join(" "));
    if (plan.launch.clientSpec.command === "cmd") lines.push("  " + windowsWrapperEn);
  }
  lines.push("", "Files to change");
  if (plan.targets.length === 0) lines.push("  (none)");
  for (const t of plan.targets) {
    const where = clientName(t.client) + ", " + t.scope + " scope";
    if (t.envReference === "manual") lines.push("  - " + t.file + " (" + where + ") not written — set it up yourself");
    else lines.push("  - " + t.file + " (" + where + ") adds the " + (t.client === "codex" ? "mcp_servers." : "mcpServers.") + t.serverName + " entry · " + (t.precondition.exists ? "existing file" : "new file"));
  }
  lines.push("", "Environment variables");
  if (plan.requiredEnv.length === 0) lines.push("  (none needed)");
  for (const e of plan.requiredEnv) lines.push("  - " + (e.required ? requiredEnvEn([e.name]) : e.name + " (optional; no reference is written to the configuration file)"));
  const conflicts = warningsEn(plan, plan.warnings.filter((w) => w.code === "CONFIG_KEY_EXISTS"));
  lines.push("", "Conflicts    " + (conflicts.length === 0 ? "none" : ""));
  for (const c of conflicts) lines.push("  - " + c.text);
  const shown = new Set(["CONFIG_KEY_EXISTS", "required-env"]);
  const warnings = warningsEn(plan, plan.warnings.filter((w) => !shown.has(w.code)));
  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const w of warnings) lines.push("  - [" + w.code + "] " + w.text);
  }
  lines.push("", "Approval items");
  for (const r of plan.approvalRequirements) lines.push("  - [" + r + "] " + INSTALL_APPROVAL_EN[r]);
  lines.push("", "Plan digest  " + planDigest);
  return lines;
}

const OPERATION_EN = { update: "update", rollback: "rollback", health: "Health Check", repair: "repair" } as const;
const HEALTH_NOT_VERIFIED_EN = ["Health: Not verified", "Reason: Required environment is unchecked"];

/** LifecyclePlan Preview(영어). Core formatLifecyclePlanPreview와 같은 순서·같은 정보. */
export function lifecyclePreviewEn(planned: PlannedLifecycle): string[] {
  const { plan, planDigest } = planned;
  const spec = (s: { command: string; args: readonly string[] }) => [s.command, ...s.args].join(" ");
  const lines = [plan.displayName + " (" + plan.toolId + ") " + OPERATION_EN[plan.operation] + " plan", ""];
  lines.push("Status         " + plan.status);
  lines.push("Backend        " + plan.backend);
  lines.push("Current        " + (plan.current.identity?.spec ?? plan.current.requested + " (not pinned)"));
  if (plan.operation !== "health") {
    lines.push((plan.operation === "rollback" ? "Roll back to   " : "Target         ") + (plan.target.identity?.spec ?? plan.target.requested + " (not pinned)"));
    if (plan.operation === "update") lines.push("Requested spec " + plan.target.requested);
    const run = plan.steps.filter((s) => s.kind === "run");
    lines.push(
      "Preparation    " +
        (run.length === 0
          ? "none — no package manager command runs; only the package arguments in the client configuration change"
          : run.map((s) => s.executable + " " + s.args.join(" ")).join(", ") +
            (run.every((s) => s.executable === "npx")
              ? " — OpenHub downloads this version into the npx cache before changing configuration (the MCP server is not started; network, download, dependency install scripts)"
              : " — run by OpenHub (network, download; downloaded images are not removed)")),
    );
    lines.push("Client command");
    lines.push("  current  " + spec(plan.current.clientSpec));
    lines.push("  new      " + spec(plan.target.clientSpec));
    if (plan.target.clientSpec.command === "cmd") lines.push("  " + windowsWrapperEn);
  }
  lines.push("", "Targets");
  for (const t of plan.targets) {
    const where = clientName(t.client) + ", " + t.scope + " scope";
    const action = plan.operation === "health" ? "checked only (no configuration change)" : "replaces the " + (t.client === "codex" ? "mcp_servers." : "mcpServers.") + t.serverName + " entry";
    lines.push("  - " + t.file + " (" + where + ") " + action + (t.stateRevision === null ? " · no Version State" : " · revision " + t.stateRevision));
    if (t.launcher !== undefined) {
      const recorded = t.launcher.recorded === "invalid" ? "Recorded Node.js launch path is invalid (client-launcher-invalid)" : "Recorded Node.js launch path is valid";
      const next =
        plan.operation === "health"
          ? "the client configuration is not changed"
          : t.launcher.replacementDigest === null
            ? "the Node.js installation found right before running is verified and then written"
            : "only the launch path is rewritten with the Node.js installation verified now (node.exe, npx-cli.js, " + t.launcher.replacementDigest.slice(0, 19) + "…). If it changes after approval, nothing runs";
      lines.push("      " + recorded + " → " + next);
    }
  }
  lines.push("", "Health Check");
  if (plan.healthPolicy.gate === "required") {
    const t = plan.healthPolicy.timeouts;
    lines.push("  Required — runs the MCP server in an isolated temporary directory and checks the initialize and tools/list responses (the client app is not started)");
    lines.push("  Time limits: startup " + t.startupMs / 1000 + " s · handshake " + t.handshakeMs / 1000 + " s · total " + t.totalMs / 1000 + " s");
    if (plan.operation !== "health") lines.push("  If Health fails, the configuration is restored and Version State is not changed");
  } else lines.push("  Skipped (approved in advance) — after applying: " + HEALTH_NOT_VERIFIED_EN.join(" / "));
  lines.push("", "Environment variables");
  if (plan.requiredEnv.length === 0) lines.push("  (none needed)");
  for (const e of plan.requiredEnv) lines.push("  - " + (e.required ? requiredEnvEn([e.name]) : e.name + " (optional)"));
  const warnings = warningsEn(plan, plan.warnings.filter((w) => w.code !== "environment-unverified"));
  if (warnings.length > 0) {
    lines.push("", "Warnings");
    for (const w of warnings) lines.push("  - [" + w.code + "] " + w.text);
  }
  lines.push("", "Approval items");
  for (const r of plan.approvalRequirements) lines.push("  - [" + r + "] " + LIFECYCLE_APPROVAL_EN[r]);
  lines.push("", "Plan digest  " + planDigest);
  return lines;
}

export function healthLinesEn(health: { status: string; environmentUnverified: boolean; checkedAt: string | null } | null, formatTime: (iso: string) => string): string[] {
  if (health === null) return ["Health: Unknown (not checked yet)"];
  if (health.status === "skipped") return [...HEALTH_NOT_VERIFIED_EN];
  const lines = ["Health: " + (health.status === "healthy" ? "Healthy" : health.status) + (health.checkedAt === null ? "" : " (" + formatTime(health.checkedAt) + ")")];
  if (health.environmentUnverified) lines.push("Note: Required environment is unchecked");
  return lines;
}

const STATE_EN: Readonly<Record<LifecycleToolStatus["state"], string>> = {
  "state-consistent": "consistent",
  "config-drift": "config-drift (configuration differs from Version State)",
  "missing-config": "missing-config (configuration entry missing)",
  "tool-config-missing": "tool-config-missing (OpenHub-managed tool config missing — repair)",
  "tool-config-drift": "tool-config-drift (tool config differs from the record — repair)",
  "tool-config-relocated": "tool-config-relocated (moved or copied project — repair)",
  "client-launcher-invalid": "client-launcher-invalid (the Node.js launch path in the client configuration is invalid — repair)",
  "untracked-adoptable": "untracked-adoptable (standard entry, no Version State)",
  "untracked-foreign": "untracked-foreign (configuration not managed by OpenHub)",
  "not-inspected": "not-inspected (user scope not checked)",
};
const LAUNCHER_REASON_EN: Readonly<Record<string, string>> = {};

/** status 한 항목(영어). Core formatLifecycleStatusItem과 같은 줄 구성. launcher 이유는 경로 없는 고정 문장이라 코드가 없어 일반 문장으로 쓴다. */
export function statusItemEn(item: LifecycleToolStatus, formatTime: (iso: string) => string): string[] {
  const head = item.serverName + " · " + clientName(item.client) + " · " + item.scope + " (" + item.file + ")";
  const lines = [head, "  Tool       " + (item.toolId ?? "(not identified)"), "  State      " + STATE_EN[item.state]];
  if (item.diagnostics !== undefined) lines.push("  Also found " + item.diagnostics.slice(1).join(", "));
  if (item.launcher !== undefined) lines.push("  Launch path invalid: " + (LAUNCHER_REASON_EN[item.launcher.reason] ?? "the recorded node.exe or npx-cli.js could not be verified") + " (not fixed automatically)");
  if (item.artifact !== null) {
    lines.push("  artifact   " + (item.artifact.resolved ?? item.artifact.requested) + " · " + (item.artifact.lock === "artifact-locked" ? "locked" : "unlocked (version not pinned)") + (item.artifact.presence === "artifact-unknown" ? " · local image presence unknown" : ""));
  }
  if (item.revision !== null) lines.push("  revision   " + item.revision);
  const health = item.health === "not-verified" ? [...HEALTH_NOT_VERIFIED_EN] : ["Health: " + (item.health === "healthy" ? "Healthy" : item.health === "unknown" ? "Unknown (not checked yet)" : item.health)];
  for (const l of health) lines.push("  " + l);
  void formatTime;
  return lines;
}

/** LifecycleResult 줄(영어). Core nextActions 원문 대신 code 기반 안내를 쓰고, 되돌리지 못한 파일은 targets에서 고른다. */
export function lifecycleResultEn(result: LifecycleResultV1, guide: string | null, formatTime: (iso: string) => string): string[] {
  const lines = ["", "Result  " + result.status + (result.code === undefined ? "" : " (" + result.code + ")")];
  if (result.changed !== undefined) lines.push("  Changed: " + result.changed.join(", "));
  if (result.operation !== "health" && result.artifact.to !== null) lines.push("  artifact  " + (result.artifact.from ?? "-") + " → " + result.artifact.to);
  for (const t of result.targets) {
    const config = t.configRestored ? "restored to the original content" : t.configApplied ? "replaced" : "not changed";
    const revision = t.revisionAfter === null ? "" : " · revision " + (t.revisionBefore ?? "-") + " → " + t.revisionAfter;
    lines.push("  Config " + t.file + " (" + t.scope + "): " + config + revision);
  }
  if (result.health !== null) for (const l of healthLinesEn(result.health, formatTime)) lines.push("  " + l);
  if (result.compensated) lines.push("  After the failure, the configuration files were restored to their original content (compensated)");
  for (const s of result.steps.filter((x) => x.status === "failed")) lines.push("  Failed step " + s.id + (s.code === undefined ? "" : " (" + s.code + ")"));
  for (const w of result.warnings) lines.push("  - [" + w.code + "] " + (NOTICE_EN[w.code] ?? BLOCKER_EN[w.code] ?? "(" + w.code + ")"));
  const notRestored = result.status === "rollback-failed" ? result.targets.filter((t) => t.configApplied && !t.configRestored).map((t) => t.file) : [];
  const next = [...(guide === null ? [] : [guide]), ...(notRestored.length > 0 ? ["Check these files yourself: " + notRestored.join(", ")] : [])];
  if (next.length > 0) {
    lines.push("", "Next steps");
    for (const a of next) lines.push("  - " + a);
  }
  return lines;
}

export const stateUnreadableEn = (code: string) =>
  "Version State (~/.openhub/state/lifecycle.json) cannot be read (" + code + "). OpenHub does not fix or overwrite this file automatically. Check the file and its backup (lifecycle.json.bak).";

/** 설치 후 다음에 할 일(영어). Core installNextActions와 같은 규칙을 Plan 구조로 만든다. */
export function installNextActionsEn(plan: InstallPlanV1): string[] {
  const actions: string[] = [];
  const required = requiredNames(plan);
  for (const name of required) actions.push(requiredEnvEn([name]) + " Prepare " + name + " in the environment where the client runs (status: unchecked).");
  const written = plan.steps.filter((s) => s.kind === "config-patch");
  const serverName = (written[0]?.kind === "config-patch" ? written[0].path[1] : undefined) ?? plan.targets[0]?.serverName ?? plan.toolId;
  if (written.some((s) => s.kind === "config-patch" && s.client === "claude-code" && s.scope === "project")) actions.push("Approve using the " + serverName + " server from the project .mcp.json in Claude Code. OpenHub does not change the approval state.");
  if (written.some((s) => s.kind === "config-patch" && s.client === "codex" && s.scope === "project")) actions.push("Codex reads .codex/config.toml only in trusted projects. Mark this project as trusted in Codex. OpenHub does not change trust settings.");
  if (written.some((s) => s.kind === "config-patch" && s.client === "cursor") && required.length > 0) actions.push("Cursor reads environment variables from its own process environment. " + required.join(", ") + " must be visible where Cursor runs.");
  if (plan.backend?.adapter === "docker") actions.push("The docker daemon must be running for the client to start the server.");
  for (const t of plan.targets.filter((x) => x.envReference === "manual")) {
    actions.push(t.client === "claude-code" && t.scope === "user" ? "OpenHub does not modify the Claude Code user-scope configuration (~/.claude.json). Add the " + t.serverName + " MCP server in user scope from Claude Code yourself." : t.client + " " + t.scope + " configuration is not written because OpenHub could not confirm its format. Add the " + t.serverName + " server yourself.");
  }
  const clients = [...new Set(written.flatMap((s) => (s.kind === "config-patch" ? [s.client] : [])))];
  if (clients.length > 0) actions.push("Restart " + clients.map(clientName).join(", ") + " or refresh its MCP server list.");
  return actions;
}

const INSTALL_CODE_EN: Readonly<Record<string, string>> = {
  ALREADY_INSTALLED: "Already configured; nothing was changed.",
  PLAN_STALE: "The install plan changed. Review the new plan and approve again.",
  APPROVAL_REQUIRED: "Review the install plan and agree to every approval item to run it.",
  APPROVAL_INCOMPLETE: "Review the install plan and agree to every approval item to run it.",
  APPROVAL_CONSUMED: "Review the install plan and agree to every approval item to run it.",
  TOOL_CONFIG_REJECTED: "The tool config location could not be confirmed, so nothing was changed.",
  MANUAL_SETUP_REQUIRED: "The Node.js launch path for the client configuration could not be verified, so nothing was changed.",
  TOOL_CONFIG_STALE: "The tool config changed after approval. Review the new plan and approve again.",
  COMPENSATION_INCOMPLETE: "Some files could not be restored (changed elsewhere after this run, or not writable). They were not overwritten; check them with lifecycle status.",
};

/** InstallResult의 다음에 할 일(영어). Core 원문 대신 code·상태·Plan 구조로 만든다. */
export function installResultNextEn(result: InstallResultV1, plan: InstallPlanV1): string[] {
  if (result.code !== undefined && INSTALL_CODE_EN[result.code] !== undefined) return [INSTALL_CODE_EN[result.code]!];
  if (result.status === "succeeded") return installNextActionsEn(plan);
  if (result.nextActions.length === 0) return [];
  if (result.status === "failed" && result.verification?.prepared === "failed") return ["The preparation step failed, so no configuration file was changed. Check the network and docker daemon, then try again."];
  return [result.verification?.configured === false ? "Writing the configuration failed; files already written were restored to their original content." : "See the result above and try again with a new plan."];
}

export function installWarningEn(plan: InstallPlanV1, w: { code: string; message: string }): string {
  if (w.code === "configured-not-detected") return "[configured-not-detected] The configuration was written, but the " + (plan.targets[0]?.serverName ?? plan.toolId) + " server was not found when analyzing again. The configuration files were not restored.";
  return "[" + w.code + "] " + (warningsEn(plan, [w])[0]?.text ?? "(" + w.code + ")");
}

/** 추천 이유(영어). Core Reason에는 code만 구조화되어 있어 이름·수치 없이 code 의미만 쓴다(추가형 params 제안: docs/specs/desktop-i18n.md). */
export const REASON_EN: Readonly<Record<string, string>> = {
  "need-from-evidence": "Needed: project evidence points to this capability",
  "gap-confirmed": "No tool providing this capability was found in project or user settings",
  "gap-likely-host-unchecked": "No tool for this capability was found in project scope (user scope not checked)",
  "gap-likely-partial": "Some detectors partly failed, so the confidence of this assessment was lowered",
  "gap-likely-environment": "Confirmed only by evidence from the user environment",
  "gap-likely-unresolved": "An unidentified MCP server exists, so whether this need is already met is not confirmed",
  "gap-unknown-weak": "The evidence is weak (file presence only), so this is undetermined",
  "gap-unknown-detector-failed": "A detector failed, so this is undetermined",
  "stack-match": "A dedicated tool that matches the project stack",
  "client-supported": "Usable in the detected AI clients",
  "client-unverified": "No AI client was detected, so support is not confirmed",
  "platform-ok": "Supported on the current OS",
  "platform-unverified": "No OS information, so support is not confirmed",
  "runtime-ok": "Runtime requirements are met",
  "runtime-unverified": "Needs a runtime (installed version not checked)",
  "backend-ok": "An install method is available",
  "backend-unverified": "Install method availability is not confirmed",
  "installed-unidentified": "An unidentified MCP server is configured",
  "installation-unknown": "Installation status could not be determined, so this is undetermined",
  "capability-overlap": "Overlaps with the capability of a tool that is already installed",
  "setup-required-env": "Requires environment variables to be set",
  "repo-activity": "Repository activity signal",
  "repo-release": "Release activity signal",
  "repo-community": "Community signal",
  "repo-shared": "Shared repository (score adjusted)",
  "repo-archived": "The repository is archived",
  "license-unknown": "License is unknown",
  "no-candidate": "No registered tool",
};

export const CAPABILITY_EN: Readonly<Record<string, string>> = {
  "browser-automation": "Browser automation",
  "performance-tracing": "Performance tracing",
  "network-inspection": "Network inspection",
  "e2e-testing": "E2E testing",
  "library-docs": "Library documentation lookup",
  "github-api": "GitHub API",
  "issue-tracking": "Issue tracking",
  "pull-request-review": "Pull request review",
  "knowledge-graph-memory": "Knowledge graph memory",
  "db-schema-access": "Database schema access",
  "sql-query": "SQL queries",
  "query-tuning": "Query tuning",
  "semantic-code-navigation": "Semantic code navigation",
  "code-editing": "Code editing",
  "game-engine-editor": "Game engine editor integration",
  "kubernetes-operations": "Kubernetes cluster operations",
};

/** taxonomy ID 목록(누락 검사용). */
export const CAPABILITY_IDS: readonly string[] = CAPABILITIES.map((c) => c.id);

/** Trending 한 줄(영어). Core formatTrendItem과 같은 정보, 없는 값은 "none". */
export function trendItemEn(item: TrendItem, rank: number): string {
  if (item.score === null || item.components === null || item.evidence === null) return String(rank) + ". " + item.toolId + " — metadata unavailable";
  const c = item.components;
  return (
    String(rank) + ". " + item.toolId + " — Trend " + String(item.score) +
    " (popularity " + String(c.popularity) + " · release " + String(c.releaseFreshness) + " · activity " + String(c.repositoryActivity) +
    "; stars " + String(item.evidence.stars) + ", release " + (item.evidence.latestReleaseAt?.slice(0, 10) ?? "none") + ", push " + (item.evidence.pushedAt?.slice(0, 10) ?? "none") +
    (item.flags.length > 0 ? ", shared-repository" : "") + ")"
  );
}

