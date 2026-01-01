import { createHash } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import type { FetchLike } from "../discovery/github";
import {
  isKernelVerified,
  requestKernelApproval,
  verifyKernelApproval,
  type ApprovalPlanKind,
  type KernelApproval,
  type KernelApprovalOutcome,
  type KernelGateFailure,
  type KernelPrompter,
  type KernelVerified,
} from "../installer/approval-v1";
import { nodeConfigFs, type ConfigFs } from "../installer/config-writer";
import { CONFIG_SCOPES, INSTALL_CLIENTS, canonicalize, type ConfigScope, type InstallClient } from "../installer/plan";
import type { Manifest } from "../manifest/index";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";
import { PINOKIO_SCRIPT_NAMES, compilePinokioScripts, parseScriptArgs, pinokioAppId, pinokioRef, readPinokioTemplate, validateScriptPath, type PinokioScriptArg, type PinokioScriptName, type PinokioTemplateSpec } from "./compiler";
import { loopbackGet } from "./http";
import { PINOKIO_BASE_URL, PTERM_SUPPORTED_VERSION, isSupportedPinokioVersion, probePinokio, type PinokioProbeEnv, type PinokioVersions, type PtermEntry } from "./probe";
import { pinokioInstalledReader } from "./state";

/**
 * PinokioPlan v1(TASK-052, D-027). 공통 Approval kernel 위의 `pinokio-plan-v1` 종류다(InstallPlan·LifecyclePlan은 바꾸지 않는다).
 * - 내용: operation, toolId, repo, commit, 생성 script 3개의 내용·digest, pterm·pinokiod·script 버전, app ref(논리), script args,
 *   app 폴더 상태 digest, Health 정책, config 대상, 승인 요구. 절대 경로·token·env 값은 없다(schema가 거부).
 * - 승인 요구: base·pinokio-delegated-shell·health-execution (+ user scope config 쓰기면 user-scope-config, rollback이면 rollback-to-previous).
 * - 실행 직전 재생성 결과(script 내용·버전·commit·app 폴더 상태)가 다르면 PLAN_STALE다.
 * - 입력 경계(인자 key·value, script_path, ref)를 어기면 Plan을 만들지 않고 probe·파일 읽기 전에 멈춘다.
 */

export const PINOKIO_PLAN_SCHEMA_VERSION = 1 as const;
export const PINOKIO_OPERATIONS = ["install", "update", "rollback", "health"] as const;
export type PinokioOperation = (typeof PINOKIO_OPERATIONS)[number];
export const PINOKIO_APPROVAL_REQUIREMENTS = ["base", "pinokio-delegated-shell", "health-execution", "user-scope-config", "rollback-to-previous"] as const;
export type PinokioApprovalRequirement = (typeof PINOKIO_APPROVAL_REQUIREMENTS)[number];
export const PINOKIO_APPROVAL_MESSAGES: Readonly<Record<PinokioApprovalRequirement, string>> = {
  base: "위 Pinokio 계획(생성 script 내용 전체, app 폴더, 버전, 설정 대상)을 확인했고 이대로 실행하는 데 동의합니다.",
  "pinokio-delegated-shell": "생성 script의 shell.run 명령은 OpenHub가 아니라 Pinokio(pinokiod)가 셸로 실행합니다. 위 명령 전체를 확인했습니다.",
  "health-execution": "실행 뒤 앱을 잠시 시작해 loopback Health를 확인하고 pterm stop으로 종료합니다.",
  "user-scope-config": "프로젝트 밖의 사용자 설정 파일(홈 디렉터리)을 수정합니다. 다른 프로젝트에도 영향을 줍니다.",
  "rollback-to-previous": "이전 commit으로 되돌립니다. venv·설치된 패키지가 이전 상태로 정확히 복구된다고 보장하지 않습니다.",
};
export const PINOKIO_PLAN_CHANGES = ["operation", "status", "commit", "scripts", "versions", "app-state", "args", "health", "config", "approvals"] as const;
export type PinokioPlanChange = (typeof PINOKIO_PLAN_CHANGES)[number];
export const VENV_NOT_RESTORED_NOTICE = "이전 commit으로 되돌리지만 venv·설치된 패키지가 이전 상태로 정확히 복구된다고 보장하지 않습니다.";

const hex40 = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const text = z.string().min(1).max(300);

const strings = (value: unknown, p: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path: p, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...p, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...p, k]));
  return [];
};

export const pinokioPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(PINOKIO_PLAN_SCHEMA_VERSION),
    kind: z.literal("pinokio-plan"),
    operation: z.enum(PINOKIO_OPERATIONS),
    status: z.enum(["ready", "up-to-date"]),
    toolId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u),
    commit: hex40,
    previousCommit: hex40.nullable(),
    appRef: z.string().regex(/^api\/openhub-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    ref: z.string().regex(/^pinokio:\/\/127\.0\.0\.1:42000\/api\/openhub-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    scripts: z.array(z.strictObject({ name: z.enum(PINOKIO_SCRIPT_NAMES), content: z.string().min(1).max(16384), digest: sha256, marker: sha256 })).length(3),
    /** update·rollback의 Health 실패 시 이전 commit으로 되돌리는 update script(승인 대상). install·health는 null. */
    recovery: z.strictObject({ name: z.literal("openhub-update.js"), content: z.string().min(1).max(16384), digest: sha256, marker: sha256 }).nullable(),
    run: z.strictObject({ script: z.enum(["openhub-install.js", "openhub-update.js"]).nullable() }),
    start: z.strictObject({ script: z.literal("openhub-start.js"), args: z.array(z.strictObject({ key: text, value: text })) }),
    versions: z.strictObject({ pterm: z.literal(PTERM_SUPPORTED_VERSION), pinokiod: text, script: text }),
    appState: z.strictObject({ exists: z.boolean(), digest: sha256 }),
    health: z.strictObject({ type: z.literal("http"), url: text, expectStatus: z.number().int().min(100).max(599), required: z.literal(true) }),
    configTargets: z.array(
      z.strictObject({
        client: z.enum(INSTALL_CLIENTS),
        scope: z.enum(CONFIG_SCOPES),
        file: text,
        serverName: text,
        mode: z.enum(["write", "manual-setup-required"]),
        entry: z.union([z.strictObject({ type: z.literal("http"), url: text }), z.strictObject({ url: text })]).nullable(),
      }),
    ),
    approvalRequirements: z.array(z.enum(PINOKIO_APPROVAL_REQUIREMENTS)),
    notices: z.array(z.strictObject({ code: text, message: z.string().min(1).max(500) })),
  })
  .superRefine((plan, ctx) => {
    for (const found of strings(plan)) {
      // 생성 script 내용에는 Pinokio on.event 정규식 문자열("/…/")과 JSON escape(\\)가 있어 일반 경로 휴리스틱 대신
      // 드라이브 경로·홈 경로 형태만 검사한다(내용의 값은 모두 형식 검사를 통과한 token이다).
      const isScript = found.path[0] === "scripts" && found.path[2] === "content";
      const isRecovery = found.path[0] === "recovery" && found.path[1] === "content";
      const absolute = isScript || isRecovery ? /(?<![A-Za-z])[A-Za-z]:(?:\\\\|\/)|(?:^|["\s])(?:~\/|\/(?:Users|home|root|var|tmp|etc|opt|mnt|private)\/)/u.test(found.value) : containsAbsolutePath(found.value);
      const problem = absolute ? "절대 경로" : URL_CREDENTIAL_PATTERN.test(found.value) ? "URL credential" : TOKEN_PATTERN.test(found.value) ? "token" : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: "PinokioPlan에 " + problem + "이(가) 포함될 수 없습니다" });
    }
    const urls = [plan.health.url, ...plan.configTargets.flatMap((t) => (t.entry === null ? [] : [t.entry.url]))];
    for (const url of urls) if (!/^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}(?:\/[A-Za-z0-9._/-]*)?$/u.test(url)) ctx.addIssue({ code: "custom", path: ["health"], message: "loopback http URL만 허용합니다" });
  });
export type PinokioPlanV1 = z.output<typeof pinokioPlanSchema>;
export interface PlannedPinokio {
  readonly plan: PinokioPlanV1;
  readonly planDigest: string;
}

export function pinokioPlanDigest(plan: PinokioPlanV1): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(canonicalize(plan))).digest("hex");
}
export function serializePinokioPlan(plan: PinokioPlanV1): string {
  return JSON.stringify(canonicalize(pinokioPlanSchema.parse(plan)), null, 2) + "\n";
}

// ---------------------------------------------------------------- PINOKIO_HOME·app 폴더

export type PinokioPathCode = "PINOKIO_HOME_INVALID" | "PINOKIO_PATH_ESCAPE";
const isMissing = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
const insideOrSame = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

/** GET /pinokio/home → {path}. 절대 로컬 경로(UNC·원격 금지)이고 realpath가 디렉터리여야 한다. 결과 경로는 메모리에만 둔다. */
export async function resolvePinokioHome(options: { fetch?: FetchLike; fs?: ConfigFs; timeoutMs?: number } = {}): Promise<{ ok: true; home: string } | { ok: false; code: PinokioPathCode; message: string }> {
  const fs = options.fs ?? nodeConfigFs;
  const res = await loopbackGet(PINOKIO_BASE_URL + "/pinokio/home", { ...(options.fetch === undefined ? {} : { fetch: options.fetch }), ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }) });
  const bad = { ok: false as const, code: "PINOKIO_HOME_INVALID" as const, message: "Pinokio home이 절대 로컬 경로가 아닙니다" };
  if (!res.ok || res.status !== 200) return { ok: false, code: "PINOKIO_HOME_INVALID", message: "Pinokio home을 확인하지 못했습니다" };
  let raw: unknown;
  try {
    raw = (JSON.parse(res.body) as Record<string, unknown>)["path"];
  } catch {
    return bad;
  }
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 1024 || /[\u0000-\u001f]/u.test(raw)) return bad;
  if (!path.isAbsolute(raw) || raw.startsWith("\\\\") || raw.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//iu.test(raw)) return bad;
  try {
    const real = await fs.realpath(raw);
    if (!(await fs.lstat(real)).isDirectory()) return bad;
    return { ok: true, home: real };
  } catch {
    return bad;
  }
}

/** <home>/api/openhub-<toolId>. api·app 폴더가 symlink·junction이거나 home 밖으로 해석되면 거부한다. */
export async function resolveAppFolder(home: string, appId: string, fs: ConfigFs = nodeConfigFs): Promise<{ ok: true; dir: string; exists: boolean } | { ok: false; code: PinokioPathCode; message: string }> {
  if (!/^openhub-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(appId)) return { ok: false, code: "PINOKIO_PATH_ESCAPE", message: "app 폴더 이름이 올바르지 않습니다" };
  let realHome: string;
  try {
    realHome = await fs.realpath(home);
  } catch {
    return { ok: false, code: "PINOKIO_HOME_INVALID", message: "Pinokio home을 확인하지 못했습니다" };
  }
  const api = path.join(realHome, "api");
  const dir = path.join(api, appId);
  for (const current of [api, dir]) {
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isMissing(error)) return { ok: true, dir, exists: false };
      return { ok: false, code: "PINOKIO_PATH_ESCAPE", message: "app 폴더를 확인하지 못했습니다" };
    }
    const real = await fs.realpath(current).catch(() => "");
    if (stat.isSymbolicLink() || real === "" || !insideOrSame(real, current === api ? realHome : api) || real !== current) {
      return { ok: false, code: "PINOKIO_PATH_ESCAPE", message: "Pinokio app 폴더가 symlink·junction이거나 home 밖을 가리킵니다" };
    }
    if (!stat.isDirectory()) return { ok: false, code: "PINOKIO_PATH_ESCAPE", message: "Pinokio app 경로가 폴더가 아닙니다" };
  }
  return { ok: true, dir, exists: true };
}

const APP_FILES = [...PINOKIO_SCRIPT_NAMES, ...PINOKIO_SCRIPT_NAMES.map((n) => n.replace(/\.js$/u, ".done"))].sort();

/** app 폴더의 OpenHub 파일 상태 digest(실행 직전 비교용). 다른 파일은 읽지 않는다. */
export async function readAppState(folder: { dir: string; exists: boolean }, fs: ConfigFs = nodeConfigFs): Promise<{ exists: boolean; digest: string }> {
  const rows: [string, string | null][] = [];
  for (const name of APP_FILES) {
    let digest: string | null = null;
    if (folder.exists) {
      try {
        digest = "sha256:" + createHash("sha256").update(await fs.readFile(path.join(folder.dir, name))).digest("hex");
      } catch {
        digest = null;
      }
    }
    rows.push([name, digest]);
  }
  return { exists: folder.exists, digest: "sha256:" + createHash("sha256").update(JSON.stringify({ exists: folder.exists, rows })).digest("hex") };
}

// ---------------------------------------------------------------- 순수 builder

export interface PinokioInstalled {
  commit: string;
  previousCommit: string | null;
}
export interface PinokioPlanRequest {
  operation: PinokioOperation;
  manifest: Manifest;
  /** update 목표 commit(없으면 Manifest commit) */
  targetCommit?: string;
  /** start template 인자(`--key=value`). scriptPath를 주면 그 template의 허용 key로 검사한다. */
  scriptArgs?: readonly string[];
  /** 사용자가 지정한 실행 script(세 이름 중 하나만, operation과 맞아야 한다) */
  scriptPath?: string;
  /** 사용자 ref는 쓰지 않는다(항상 OpenHub가 만든 ref). 다른 값을 줘도 결과는 고정 ref다. */
  ref?: string;
  /** HTTP MCP config 대상(install에서만) */
  configTargets?: readonly { client: InstallClient; scope: ConfigScope }[];
}
export interface PinokioPlanFacts {
  versions: PinokioVersions;
  appState: { exists: boolean; digest: string };
  installed: PinokioInstalled | null;
}
export type PinokioPlanErrorCode =
  | "PINOKIO_ARGS_REJECTED"
  | "PINOKIO_SCRIPT_PATH_REJECTED"
  | "PINOKIO_REF_REJECTED"
  | "PINOKIO_TEMPLATE_REJECTED"
  | "PINOKIO_HEALTH_UNSUPPORTED"
  | "PINOKIO_NOT_SUPPORTED"
  | "PINOKIO_UNAVAILABLE"
  | "PINOKIO_VERSION_UNSUPPORTED"
  | "PINOKIO_HOME_INVALID"
  | "PINOKIO_PATH_ESCAPE"
  | "PINOKIO_ALREADY_INSTALLED"
  | "PINOKIO_NOT_INSTALLED"
  | "PINOKIO_NO_PREVIOUS"
  | "PINOKIO_CONFIG_UNSUPPORTED"
  | "PINOKIO_STATE_INVALID";
export type PinokioPlanResult = { ok: true; planned: PlannedPinokio } | { ok: false; code: PinokioPlanErrorCode; message: string };

const RUN_SCRIPT: Readonly<Record<PinokioOperation, PinokioScriptName>> = { install: "openhub-install.js", update: "openhub-update.js", rollback: "openhub-update.js", health: "openhub-start.js" };

interface Prechecked {
  spec: PinokioTemplateSpec;
  appId: string;
  ref: string;
  startArgs: PinokioScriptArg[];
}

/** 입력 경계만 검사한다(I/O 없음). 실패하면 이후 probe·파일 읽기·Plan 생성이 없다. */
export function precheckPinokioRequest(request: PinokioPlanRequest): { ok: true; value: Prechecked } | { ok: false; code: PinokioPlanErrorCode; message: string } {
  const app = pinokioAppId(request.manifest.name);
  if (!app.ok) return { ok: false, code: app.code, message: app.reason };
  const ref = pinokioRef(request.manifest.name);
  if (!ref.ok) return { ok: false, code: ref.code, message: ref.reason };
  let script: PinokioScriptName = "openhub-start.js";
  if (request.scriptPath !== undefined) {
    const valid = validateScriptPath(request.scriptPath);
    if (!valid.ok) return { ok: false, code: valid.code, message: valid.reason };
    if (valid.value !== RUN_SCRIPT[request.operation]) return { ok: false, code: "PINOKIO_SCRIPT_PATH_REJECTED", message: request.operation + " 작업은 " + RUN_SCRIPT[request.operation] + "만 실행합니다" };
    script = valid.value;
  }
  const args = parseScriptArgs(script, request.scriptArgs ?? []);
  if (!args.ok) return { ok: false, code: args.code, message: args.reason };
  const spec = readPinokioTemplate(request.manifest);
  if (!spec.ok) return { ok: false, code: spec.code, message: spec.reason };
  const port = args.value.find((a) => a.key === "port");
  if (port !== undefined && Number(port.value) !== spec.value.health.port) return { ok: false, code: "PINOKIO_ARGS_REJECTED", message: "port는 healthCheck port(" + String(spec.value.health.port) + ")와 같아야 합니다(동적 port 미지원)" };
  if (request.targetCommit !== undefined && !/^[0-9a-f]{40}$/u.test(request.targetCommit)) return { ok: false, code: "PINOKIO_TEMPLATE_REJECTED", message: "목표 commit은 40자리 hex여야 합니다" };
  return { ok: true, value: { spec: spec.value, appId: app.value, ref: ref.value, startArgs: script === "openhub-start.js" ? args.value : [] } };
}

function configTarget(client: InstallClient, scope: ConfigScope, serverName: string, url: string): PinokioPlanV1["configTargets"][number] {
  if (client === "claude-code" && scope === "project") return { client, scope, file: ".mcp.json", serverName, mode: "write", entry: { type: "http", url } };
  if (client === "cursor") return { client, scope, file: scope === "user" ? "~/.cursor/mcp.json" : ".cursor/mcp.json", serverName, mode: "write", entry: { url } };
  const file = client === "codex" ? (scope === "user" ? "~/.codex/config.toml" : ".codex/config.toml") : "~/.claude.json";
  return { client, scope, file, serverName, mode: "manual-setup-required", entry: null };
}

/** 입력과 사실(versions·appState·installed)로 PinokioPlan v1을 만든다. 같은 입력이면 같은 byte·digest다. */
export function buildPinokioPlan(request: PinokioPlanRequest, facts: PinokioPlanFacts): PinokioPlanResult {
  const pre = precheckPinokioRequest(request);
  if (!pre.ok) return pre;
  const { spec, appId, ref, startArgs } = pre.value;
  if (!isSupportedPinokioVersion(facts.versions)) return { ok: false, code: "PINOKIO_VERSION_UNSUPPORTED", message: "지원하지 않는 Pinokio 버전입니다(pterm " + PTERM_SUPPORTED_VERSION + " 정확히, pinokiod·script는 지원 표 안)" };
  const installed = facts.installed;
  let commit: string;
  let previousCommit: string | null = null;
  if (request.operation === "install") {
    if (installed !== null) return { ok: false, code: "PINOKIO_ALREADY_INSTALLED", message: "이미 OpenHub가 설치한 Pinokio 앱입니다(update를 쓰세요)" };
    commit = request.targetCommit ?? spec.commit;
  } else {
    if (installed === null) return { ok: false, code: "PINOKIO_NOT_INSTALLED", message: "OpenHub가 설치한 Pinokio 앱이 아닙니다" };
    if (request.operation === "update") {
      commit = request.targetCommit ?? spec.commit;
      previousCommit = installed.commit;
    } else if (request.operation === "rollback") {
      if (installed.previousCommit === null) return { ok: false, code: "PINOKIO_NO_PREVIOUS", message: "되돌릴 이전 commit이 없습니다" };
      commit = installed.previousCommit;
      previousCommit = installed.commit;
    } else commit = installed.commit;
  }
  const requested = request.configTargets ?? [];
  if (requested.length > 0 && (request.operation !== "install" || spec.mcpUrl === null)) return { ok: false, code: "PINOKIO_CONFIG_UNSUPPORTED", message: "HTTP MCP config는 mcp.path를 선언한 도구의 install에서만 씁니다" };
  const serverName = request.manifest.recommendation?.identity?.mcpServerNames?.[0] ?? request.manifest.name;
  const seen = new Set<string>();
  const configTargets = requested
    .filter((t) => (seen.has(t.client + ":" + t.scope) ? false : (seen.add(t.client + ":" + t.scope), true)))
    .map((t) => configTarget(t.client, t.scope, serverName, spec.mcpUrl!))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) || (a.client < b.client ? -1 : a.client > b.client ? 1 : 0));

  const scripts = compilePinokioScripts(spec, commit, startArgs.map((a) => a.key));
  const recoveryScript = previousCommit === null || request.operation === "health" ? null : compilePinokioScripts(spec, previousCommit, startArgs.map((a) => a.key))[2]!;
  const status: PinokioPlanV1["status"] = request.operation === "update" && installed !== null && commit === installed.commit ? "up-to-date" : "ready";
  const approvals: PinokioApprovalRequirement[] = ["base", "pinokio-delegated-shell", "health-execution"];
  if (configTargets.some((t) => t.scope === "user" && t.mode === "write")) approvals.push("user-scope-config");
  if (request.operation === "rollback") approvals.push("rollback-to-previous");
  const notices: PinokioPlanV1["notices"] = [
    { code: "delegated-shell", message: "생성 script의 shell.run 명령은 Pinokio(pinokiod)가 셸로 실행합니다. OpenHub는 script 내용 전체를 고정하고 실행 직전에 다시 비교합니다." },
    { code: "health-required", message: "실행 뒤 " + spec.health.url + " 로 Health를 확인하고 앱을 종료합니다(OpenHub는 앱을 상주시키지 않습니다)." },
  ];
  if (request.operation === "rollback") notices.push({ code: "venv-not-restored", message: VENV_NOT_RESTORED_NOTICE });
  for (const t of configTargets.filter((x) => x.mode === "manual-setup-required")) notices.push({ code: "manual-setup-required", message: t.file + " 은(는) OpenHub가 HTTP MCP 항목을 쓰지 않습니다. " + t.serverName + " 서버(" + spec.mcpUrl + ")를 직접 추가하세요." });

  const plan = pinokioPlanSchema.parse({
    schemaVersion: PINOKIO_PLAN_SCHEMA_VERSION,
    kind: "pinokio-plan",
    operation: request.operation,
    status,
    toolId: spec.toolId,
    repo: spec.repo,
    commit,
    previousCommit,
    appRef: "api/" + appId,
    ref,
    scripts: scripts.map((s) => ({ name: s.name, content: s.content, digest: s.digest, marker: s.marker })),
    recovery: recoveryScript === null ? null : { name: "openhub-update.js", content: recoveryScript.content, digest: recoveryScript.digest, marker: recoveryScript.marker },
    run: { script: request.operation === "health" ? null : (RUN_SCRIPT[request.operation] as "openhub-install.js" | "openhub-update.js") },
    start: { script: "openhub-start.js", args: startArgs },
    versions: { pterm: facts.versions.pterm, pinokiod: facts.versions.pinokiod, script: facts.versions.script },
    appState: facts.appState,
    health: { type: "http", url: spec.health.url, expectStatus: spec.health.expectStatus, required: true },
    configTargets,
    approvalRequirements: approvals,
    notices,
  });
  return { ok: true, planned: { plan, planDigest: pinokioPlanDigest(plan) } };
}

// ---------------------------------------------------------------- orchestrator

export interface PinokioPlanDeps {
  probe: PinokioProbeEnv;
  fs?: ConfigFs;
  /** OpenHub가 설치한 상태. 주지 않으면 homeDir의 Pinokio state(~/.openhub/state/pinokio.json)를 읽고, homeDir도 없으면 미설치로 본다. */
  installed?: (toolId: string) => Promise<PinokioInstalled | null>;
  homeDir?: string;
}
/** 입력 경계 → 비실행 probe → PINOKIO_HOME·app 폴더 상태 → 설치 상태 → Plan. 쓰기·실행이 없다. */
export async function planPinokio(request: PinokioPlanRequest, deps: PinokioPlanDeps): Promise<{ ok: true; planned: PlannedPinokio; entry: PtermEntry; appDir: string } | { ok: false; code: PinokioPlanErrorCode; message: string }> {
  const pre = precheckPinokioRequest(request);
  if (!pre.ok) return pre;
  const probe = await probePinokio(deps.probe);
  if (!probe.available || probe.entry === null) {
    const unsupported = probe.status === "pterm-version-unsupported" || probe.status === "pinokio-version-unsupported";
    return { ok: false, code: unsupported ? "PINOKIO_VERSION_UNSUPPORTED" : "PINOKIO_UNAVAILABLE", message: "Pinokio를 사용할 수 없습니다(" + probe.status + ")" };
  }
  const fs = deps.fs ?? nodeConfigFs;
  const home = await resolvePinokioHome({ fs, ...(deps.probe.fetch === undefined ? {} : { fetch: deps.probe.fetch }) });
  if (!home.ok) return home;
  const folder = await resolveAppFolder(home.home, pre.value.appId, fs);
  if (!folder.ok) return folder;
  const appState = await readAppState(folder, fs);
  let installed: PinokioInstalled | null;
  try {
    const reader = deps.installed ?? (deps.homeDir === undefined ? undefined : pinokioInstalledReader({ homeDir: deps.homeDir, fs }));
    installed = reader === undefined ? null : await reader(request.manifest.name);
  } catch {
    return { ok: false, code: "PINOKIO_STATE_INVALID", message: "Pinokio state를 읽지 못했습니다" };
  }
  const built = buildPinokioPlan(request, { versions: probe.versions, appState, installed });
  return built.ok ? { ok: true, planned: built.planned, entry: probe.entry, appDir: folder.dir } : built;
}

// ---------------------------------------------------------------- 공통 kernel 종류

const topDiff = (a: PinokioPlanV1, b: PinokioPlanV1): PinokioPlanChange[] => {
  const same = (x: unknown, y: unknown) => JSON.stringify(canonicalize(x)) === JSON.stringify(canonicalize(y));
  const out: PinokioPlanChange[] = [];
  if (a.operation !== b.operation) out.push("operation");
  if (a.status !== b.status) out.push("status");
  if (a.commit !== b.commit || a.previousCommit !== b.previousCommit || a.repo !== b.repo) out.push("commit");
  if (!same(a.scripts, b.scripts) || !same(a.recovery, b.recovery)) out.push("scripts");
  if (!same(a.versions, b.versions)) out.push("versions");
  if (!same(a.appState, b.appState)) out.push("app-state");
  if (!same(a.start, b.start)) out.push("args");
  if (!same(a.health, b.health)) out.push("health");
  if (!same(a.configTargets, b.configTargets)) out.push("config");
  if (!same(a.approvalRequirements, b.approvalRequirements)) out.push("approvals");
  return out;
};

export const PINOKIO_PLAN_KIND: ApprovalPlanKind<PinokioPlanV1, PinokioApprovalRequirement, PinokioPlanChange> = {
  kind: "pinokio-plan-v1",
  parse: (plan) => {
    const parsed = pinokioPlanSchema.safeParse(plan);
    return parsed.success ? parsed.data : null;
  },
  digest: pinokioPlanDigest,
  status: (plan) => plan.status,
  executableStatus: "ready",
  requirements: (plan) => plan.approvalRequirements,
  knownRequirements: PINOKIO_APPROVAL_REQUIREMENTS,
  messages: PINOKIO_APPROVAL_MESSAGES,
  diff: topDiff,
  fallbackChange: "scripts",
  staleMessage: "승인 후 Pinokio 계획(script·버전·commit·app 폴더 상태)이 바뀌었습니다. 다시 확인하고 승인하세요",
};

export type PinokioApproval = KernelApproval<PinokioApprovalRequirement>;
export type PinokioPrompter = KernelPrompter<PinokioPlanV1, PinokioApprovalRequirement>;
export type VerifiedPinokioPlan = KernelVerified<PinokioPlanV1, PinokioApprovalRequirement>;
export type PinokioGateFailure = KernelGateFailure<PinokioApprovalRequirement, PinokioPlanChange>;

export function requestPinokioApproval(planned: PlannedPinokio, prompter: PinokioPrompter): Promise<KernelApprovalOutcome<PinokioApprovalRequirement>> {
  return requestKernelApproval(PINOKIO_PLAN_KIND, planned, prompter);
}
export function verifyPinokioApproval(approval: PinokioApproval | undefined, regenerate: () => PlannedPinokio | Promise<PlannedPinokio>): Promise<{ ok: true; verified: VerifiedPinokioPlan } | PinokioGateFailure> {
  return verifyKernelApproval(PINOKIO_PLAN_KIND, approval, regenerate);
}
export function isVerifiedPinokioPlan(value: unknown): value is VerifiedPinokioPlan {
  return isKernelVerified(value, PINOKIO_PLAN_KIND.kind);
}

