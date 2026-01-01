import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { artifactKeyFromEntry, buildFingerprintIndex, dockerImageArg, gradeServer, readConfiguredServers, FINGERPRINT_GRADES, FINGERPRINT_REASONS } from "../identity/fingerprint";
import {
  isKernelVerified,
  requestKernelApproval,
  verifyKernelApproval,
  type ApprovalChannel,
  type ApprovalPlanKind,
  type KernelApproval,
  type KernelApprovalOutcome,
  type KernelApprovalRequest,
  type KernelGateFailure,
  type KernelPrompter,
  type KernelVerified,
} from "../installer/approval-v1";
import { COMMAND_METACHARACTERS, isPinnedArtifact, isValidDockerImage, npxArtifact, tokenizeManifestCommand, uvxArtifact, type ArtifactRef } from "../installer/command";
import { ConfigWriteError, codexBlock, configTargetFor, decode, fileSha256, isOfficialServerEntry, nodeConfigFs, readOptional, resolveInside, type ConfigFs } from "../installer/config-writer";
import {
  CONFIG_SCOPES,
  INSTALL_BACKENDS,
  INSTALL_CLIENTS,
  canonicalize,
  manifestDigest,
  registryDigestExcluding,
  serverEntrySchema,
  sha256Digest,
  type ConfigScope,
  type InstallBackend,
  type InstallClient,
} from "../installer/plan";
import { RECOMMEND_PLATFORMS, TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, type RecommendPlatform } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { CLIENT_COMMANDS, PROJECT_KEY_PATTERN, artifactIdentitySchema, entryKeyOf } from "../lifecycle/state";
import { configEntryDigest, identityFromPinnedArtifact, tomlBlockDigest } from "../lifecycle/status";
import { projectKeyFor, readLifecycleState, type StateErrorCode } from "../lifecycle/store";

/**
 * AdoptPlan v1(TASK-059, D-029). Client config에 이미 있지만 Version State에 없는 도구를 관리 대상으로 등록하는 계획.
 * - LifecyclePlan v1·InstallPlan v1·PinokioPlan v1을 확장하지 않는다. 승인은 공통 kernel의 새 종류 adopt-plan-v1이다.
 * - Identity Fingerprint(D-026) exact·strong만 ready가 될 수 있다. weak·unresolved는 blocked다. 자동 adopt는 없다.
 * - Adopt의 효과는 Version State write 1회뿐이다. config write·spawn·network는 0이다(실행은 adopt/execute.ts).
 * - M4 공식 항목 형식(D-016 Windows wrapper 포함)으로 표현되고 인자가 strict 검사를 통과하는 항목만 다룬다.
 *   Codex 항목은 OpenHub 표준 block 형태가 파일에 정확히 1회 있어야 한다(이후 M5 update가 그 block을 교체한다).
 * - ~/.claude.json은 D-003대로 서버 이름만 본다(값을 읽지 않으므로 adopt 불가).
 * - Plan에는 env 값·token·credential URL·절대 경로가 없다. process.env를 읽지 않는다.
 */

export const ADOPT_PLAN_SCHEMA_VERSION = 1;
export const ADOPT_PLAN_KIND = "openhub-adopt-plan";
export const ADOPT_APPROVAL_REQUIREMENTS = ["base", "identity-strong-match", "artifact-unlocked", "user-scope-target"] as const;
export type AdoptApprovalRequirement = (typeof ADOPT_APPROVAL_REQUIREMENTS)[number];
export const ADOPT_PLAN_CHANGE_KINDS = ["config-file", "config-entry", "identity", "registry", "manifest", "state-present", "target"] as const;
export type AdoptPlanChange = (typeof ADOPT_PLAN_CHANGE_KINDS)[number];
export const ADOPT_BLOCKER_CODES = ["ADOPT_IDENTITY_WEAK", "ADOPT_IDENTITY_UNRESOLVED", "ADOPT_IDENTITY_MISMATCH", "ADOPT_ALREADY_MANAGED", "ADOPT_ENTRY_UNSUPPORTED"] as const;
export type AdoptBlockerCode = (typeof ADOPT_BLOCKER_CODES)[number];

export const ADOPT_APPROVAL_MESSAGES: Readonly<Record<AdoptApprovalRequirement, string>> = {
  base: "위 adopt 계획(관리 대상으로 등록할 설정 항목과 Version State 기록 1회)을 확인했고 등록하는 데 동의합니다. 설정 파일은 바뀌지 않고 아무것도 실행하지 않습니다.",
  "identity-strong-match":
    "서버 이름이 Registry 이름과 다르지만 package·image가 정확히 일치하고 후보가 하나뿐이어서 같은 도구로 판정했습니다(strong). 이 판정을 확인했습니다.",
  "artifact-unlocked": "설정의 artifact 버전이 고정되어 있지 않습니다. OpenHub는 정확한 버전을 기록하지 않고 artifact-unlocked로 관리합니다.",
  "user-scope-target": "프로젝트 밖의 사용자 설정(홈 디렉터리)에 있는 항목을 관리 대상으로 등록합니다. 다른 프로젝트에서도 같은 항목입니다.",
};

const text = z.string().min(1).max(300);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const blockerSchema = z.strictObject({ code: z.enum(ADOPT_BLOCKER_CODES), message: z.string().min(1).max(400) });

const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : [];

export const adoptPlanSchema = z
  .strictObject({
    schemaVersion: z.literal(ADOPT_PLAN_SCHEMA_VERSION),
    kind: z.literal(ADOPT_PLAN_KIND),
    status: z.enum(["ready", "blocked"]),
    toolId: text,
    registryDigest: sha256,
    manifestDigest: sha256,
    platform: z.enum(RECOMMEND_PLATFORMS),
    identity: z.strictObject({
      grade: z.enum(FINGERPRINT_GRADES),
      reason: z.enum(FINGERPRINT_REASONS),
      artifactKey: text.nullable(),
      /** Registry canonical MCP alias(D-008). 없으면 null. */
      canonicalAlias: text.nullable(),
      /** 지금 config에 있는 서버 이름 */
      serverName: text,
    }),
    target: z.strictObject({
      client: z.enum(INSTALL_CLIENTS),
      scope: z.enum(CONFIG_SCOPES),
      /** 논리 경로(.mcp.json, ~/.cursor/mcp.json) */
      file: text,
      serverName: text,
      projectName: text.nullable(),
      projectKey: z.string().regex(PROJECT_KEY_PATTERN).nullable(),
      entryKey: z.string().min(1).max(400),
    }),
    precondition: z.strictObject({
      fileDigest: sha256.nullable(),
      entryDigest: sha256.nullable(),
      tomlBlockDigest: sha256.nullable(),
      stateEntry: z.enum(["absent", "present"]),
    }),
    backend: z.enum(INSTALL_BACKENDS).nullable(),
    launch: z.strictObject({ platform: z.enum(RECOMMEND_PLATFORMS), clientSpec: z.strictObject({ command: z.enum(CLIENT_COMMANDS), args: z.array(text) }) }).nullable(),
    artifact: z.strictObject({ requested: text, resolved: artifactIdentitySchema.nullable(), lock: z.enum(["locked", "unlocked"]) }).nullable(),
    approvalRequirements: z.array(z.enum(ADOPT_APPROVAL_REQUIREMENTS)).min(1),
    blockers: z.array(blockerSchema),
    effects: z.strictObject({ stateWrite: z.literal(1), configWrite: z.literal(0), spawn: z.literal(0), network: z.literal(0) }),
  })
  .superRefine((plan, ctx) => {
    if (plan.status === "ready") {
      if (plan.blockers.length > 0) ctx.addIssue({ code: "custom", path: ["blockers"], message: "ready Plan에는 blocker가 없다" });
      if (plan.identity.grade !== "exact" && plan.identity.grade !== "strong") ctx.addIssue({ code: "custom", path: ["identity", "grade"], message: "exact·strong만 ready다" });
      if (plan.backend === null || plan.launch === null || plan.artifact === null || plan.precondition.entryDigest === null) {
        ctx.addIssue({ code: "custom", path: ["status"], message: "ready Plan은 backend·launch·artifact·entryDigest가 있어야 한다" });
      }
      if (plan.precondition.stateEntry !== "absent") ctx.addIssue({ code: "custom", path: ["precondition"], message: "이미 관리 중인 항목은 ready가 아니다" });
    } else if (plan.blockers.length === 0) ctx.addIssue({ code: "custom", path: ["blockers"], message: "blocked Plan에는 blocker가 있다" });
    if (plan.target.scope === "project" ? plan.target.projectKey === null : plan.target.projectKey !== null) {
      ctx.addIssue({ code: "custom", path: ["target", "projectKey"], message: "project scope만 projectKey를 가진다" });
    }
    for (const s of stringsOf(plan)) {
      if (containsAbsolutePath(s) || TOKEN_PATTERN.test(s) || URL_CREDENTIAL_PATTERN.test(s)) {
        ctx.addIssue({ code: "custom", path: [], message: "Plan에 절대 경로·token·credential URL이 있다" });
        break;
      }
    }
  });
export type AdoptPlanV1 = z.output<typeof adoptPlanSchema>;

export interface PlannedAdopt {
  readonly plan: AdoptPlanV1;
  readonly planDigest: string;
}

export function adoptPlanDigest(plan: AdoptPlanV1): string {
  return sha256Digest(JSON.stringify(canonicalize(plan)));
}

/** 사람이 읽고 비교하는 안정 직렬화(키 정렬, 2칸 들여쓰기, 끝 개행). */
export function serializeAdoptPlan(plan: AdoptPlanV1): string {
  return JSON.stringify(canonicalize(adoptPlanSchema.parse(plan)), null, 2) + "\n";
}

export interface AdoptPlanOptions {
  toolId: string;
  projectRoot: string;
  homeDir: string;
  entries: readonly RegistryEntry[];
  platform: RecommendPlatform;
  client: InstallClient;
  scope: ConfigScope;
  /** config의 서버 이름. 없으면 이 Tool로 식별되는 항목(exact·strong)이 하나일 때 그것, 아니면 canonical alias. */
  serverName?: string;
  fs?: ConfigFs;
}

export type AdoptPlanErrorCode =
  | "TOOL_NOT_FOUND"
  | "ADOPT_TARGET_NOT_FOUND"
  | "ADOPT_TARGET_AMBIGUOUS"
  | "ADOPT_INVALID_SERVER_NAME"
  | "ADOPT_CONFIG_UNPARSEABLE"
  | "CONFIG_PATH_ESCAPE"
  | StateErrorCode;
export type AdoptPlanResult = { ok: true; planned: PlannedAdopt } | { ok: false; code: AdoptPlanErrorCode; message: string };

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const safeText = (s: string) => s.length > 0 && s.length <= 300 && !containsAbsolutePath(s) && !TOKEN_PATTERN.test(s) && !URL_CREDENTIAL_PATTERN.test(s) && !/[\u0000-\u001f\u007f]/u.test(s);
const validServerName = (name: string) => name.length <= 100 && safeText(name);
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

type Representation = { ok: true; backend: InstallBackend; clientSpec: { command: (typeof CLIENT_COMMANDS)[number]; args: string[] }; ref: ArtifactRef } | { ok: false; reason: string };

/** 설정 항목을 OpenHub가 관리할 수 있는 launch 형식으로 표현할 수 있는지. 값(env 등)은 결과에 넣지 않는다. */
export function representAdoptEntry(client: InstallClient, entry: unknown, serverName: string, fileText: string | null, eol: string): Representation {
  const no = (reason: string): Representation => ({ ok: false, reason });
  if (!isRecord(entry) || typeof entry["command"] !== "string") return no("command·args 형식의 stdio 항목이 아닙니다(HTTP·Pinokio 항목 포함)");
  const parsed = serverEntrySchema.safeParse(entry);
  if (!parsed.success || !isOfficialServerEntry(client, parsed.data)) return no("Client 공식 형식(command·args·env 참조)이 아닌 필드나 값이 있습니다");
  const value = parsed.data;
  if (value.args.some((a) => !safeText(a))) return no("인자에 secret·credential URL·절대 경로가 있습니다");
  const command = value.command as (typeof CLIENT_COMMANDS)[number];
  const backend: InstallBackend = command === "cmd" ? "npx" : (command as InstallBackend);
  const rest = command === "cmd" ? value.args.slice(3) : [...value.args];
  let ref: ArtifactRef | null;
  if (backend === "npx" || backend === "uvx") {
    if (rest.some((a) => /[ \t]/u.test(a))) return no("공백이 들어간 인자가 있습니다");
    const tokens = tokenizeManifestCommand([backend, ...rest].join(" "), backend, { windowsCmdWrapper: command === "cmd" });
    if (!tokens.ok) return no("인자가 strict 검사를 통과하지 못했습니다: " + tokens.reason);
    ref = backend === "npx" ? npxArtifact(rest) : uvxArtifact(rest);
  } else {
    if (rest.some((a) => a.includes("..") || /[ \t\r\n]/u.test(a) || COMMAND_METACHARACTERS.some((c) => a.includes(c)))) return no("docker 인자가 strict 검사를 통과하지 못했습니다");
    const image = dockerImageArg(rest);
    ref = image !== null && isValidDockerImage(image) ? { spec: image, unambiguous: true } : null;
  }
  if (ref === null) return no("실행 artifact(package·image)를 찾지 못했습니다");
  if (client === "codex") {
    const block = codexBlock(serverName, value, eol);
    let count = 0;
    if (fileText !== null) for (let i = fileText.indexOf(block); i !== -1; i = fileText.indexOf(block, i + 1)) if (i === 0 || fileText[i - 1] === "\n") count += 1;
    if (count !== 1) return no("OpenHub 표준 형식의 Codex block이 아니어서 이후 update가 이 항목을 교체할 수 없습니다");
  }
  return { ok: true, backend, clientSpec: { command, args: [...value.args] }, ref };
}

const KIND_OF: Record<InstallBackend, "npm-package" | "python-package" | "container-image"> = { npx: "npm-package", uvx: "python-package", docker: "container-image" };

/**
 * config·Version State·Registry를 읽어 AdoptPlan을 만든다. 실행 직전 재생성도 같은 함수를 쓴다.
 * network·spawn·write 0회. 대상 항목이 없으면 Plan을 만들지 않는다(ADOPT_TARGET_NOT_FOUND).
 */
export async function planAdopt(options: AdoptPlanOptions): Promise<AdoptPlanResult> {
  const fs = options.fs ?? nodeConfigFs;
  // Registry entry 모양(manifest.name·repository)이 아닌 값(예: Discovery Candidate)은 입력에서 거부한다(D-035).
  const registry = options.entries.filter((e): e is RegistryEntry => isRecord(e) && isRecord(e.manifest) && typeof e.manifest.name === "string" && isRecord(e.manifest.repository));
  const entry = registry.find((e) => e.manifest.name === options.toolId);
  if (entry === undefined) return { ok: false, code: "TOOL_NOT_FOUND", message: "Registry에 없는 Tool입니다" };
  const manifest = entry.manifest;
  const canonicalAlias = manifest.recommendation?.identity?.mcpServerNames?.[0] ?? null;
  const read = await readLifecycleState({ homeDir: options.homeDir, fs });
  if (!read.ok) return read;
  const index = buildFingerprintIndex(registry);
  const target = configTargetFor(options.client, options.scope);

  let serverName = options.serverName;
  if (serverName !== undefined && !validServerName(serverName)) return { ok: false, code: "ADOPT_INVALID_SERVER_NAME", message: "서버 이름 형식이 올바르지 않습니다" };
  const configured = (await readConfiguredServers({ projectRoot: options.projectRoot, homeDir: options.homeDir, includeUser: options.scope === "user", fs })).filter(
    (s) => s.client === options.client && s.scope === options.scope,
  );
  if (serverName === undefined) {
    const matches = configured.map((s) => gradeServer(s, index)).filter((m) => (m.grade === "exact" || m.grade === "strong") && m.toolId === options.toolId);
    if (matches.length > 1) return { ok: false, code: "ADOPT_TARGET_AMBIGUOUS", message: "이 Tool로 식별되는 항목이 여러 개입니다. 서버 이름을 지정하세요(" + matches.map((m) => m.serverName).sort(cmp).join(", ") + ")" };
    serverName = matches[0]?.serverName ?? canonicalAlias ?? undefined;
  }
  if (serverName === undefined || !configured.some((s) => s.serverName === serverName)) {
    return { ok: false, code: "ADOPT_TARGET_NOT_FOUND", message: target.logical + "에 adopt할 서버 항목이 없습니다" };
  }
  const name = serverName;

  const projectKey = options.scope === "project" ? await projectKeyFor(options.projectRoot, fs) : null;
  const projectName = options.scope === "project" ? path.basename(path.resolve(options.projectRoot)) : null;
  const targetOut = { client: options.client, scope: options.scope, file: target.logical, serverName: name, projectName: safeText(projectName ?? "x") ? projectName : "project", projectKey };
  const entryKey = entryKeyOf(targetOut);
  const statePresent = read.state.entries[entryKey] !== undefined;

  let fileDigest: string | null = null;
  let value: unknown;
  let fileText: string | null = null;
  let eol = "\n";
  if (target.writable) {
    try {
      const { file } = await resolveInside(target, { projectRoot: options.projectRoot, homeDir: options.homeDir, fs }, fs);
      const bytes = await readOptional(fs, file);
      if (bytes === null) return { ok: false, code: "ADOPT_TARGET_NOT_FOUND", message: target.logical + " 파일이 없습니다" };
      fileDigest = fileSha256(bytes);
      const shape = decode(bytes);
      fileText = shape.text;
      eol = shape.eol;
      const doc: unknown = target.format === "json" ? JSON.parse(shape.text) : parseToml(shape.text);
      const servers = isRecord(doc) ? doc[target.format === "json" ? "mcpServers" : "mcp_servers"] : undefined;
      value = isRecord(servers) ? servers[name] : undefined;
    } catch (error) {
      if (error instanceof ConfigWriteError) return { ok: false, code: "CONFIG_PATH_ESCAPE", message: error.message };
      return { ok: false, code: "ADOPT_CONFIG_UNPARSEABLE", message: target.logical + "을(를) 해석하지 못했습니다" };
    }
    if (value === undefined) return { ok: false, code: "ADOPT_TARGET_NOT_FOUND", message: target.logical + "에 " + name + " 항목이 없습니다" };
  }

  const match = gradeServer({ client: options.client, scope: options.scope, file: target.logical, serverName: name, artifact: target.writable ? artifactKeyFromEntry(value) : null }, index);
  const blockers: { code: AdoptBlockerCode; message: string }[] = [];
  if (match.grade === "weak") blockers.push({ code: "ADOPT_IDENTITY_WEAK", message: "이름만 비슷하고 package·image 근거가 없습니다(weak). adopt할 수 없습니다" });
  else if (match.grade === "unresolved") blockers.push({ code: "ADOPT_IDENTITY_UNRESOLVED", message: "이 항목을 Registry Tool로 식별하지 못했습니다(unresolved, " + match.reason + ")" });
  else if (match.toolId !== options.toolId) blockers.push({ code: "ADOPT_IDENTITY_MISMATCH", message: "이 항목은 다른 Registry Tool(" + String(match.toolId) + ")로 식별됩니다" });
  if (statePresent) blockers.push({ code: "ADOPT_ALREADY_MANAGED", message: target.logical + "의 " + name + " 항목은 이미 Version State로 관리 중입니다" });

  let backend: InstallBackend | null = null;
  let launch: AdoptPlanV1["launch"] = null;
  let artifact: AdoptPlanV1["artifact"] = null;
  let tomlDigest: string | null = null;
  if (!target.writable) {
    blockers.push({ code: "ADOPT_ENTRY_UNSUPPORTED", message: target.logical + "은(는) OpenHub가 서버 이름만 읽는 파일이라(D-003) adopt할 수 없습니다" });
  } else {
    const rep = representAdoptEntry(options.client, value, name, fileText, eol);
    if (!rep.ok) blockers.push({ code: "ADOPT_ENTRY_UNSUPPORTED", message: rep.reason });
    else {
      backend = rep.backend;
      launch = { platform: rep.clientSpec.command === "cmd" ? "windows" : options.platform, clientSpec: rep.clientSpec };
      const pinned = isPinnedArtifact(rep.backend, rep.ref);
      const resolved = pinned ? identityFromPinnedArtifact(rep.backend, { kind: KIND_OF[rep.backend], spec: rep.ref.spec, pinned: true, preparation: rep.backend === "docker" ? "pull" : "launch-on-demand" }) : null;
      artifact = { requested: rep.ref.spec, resolved, lock: resolved === null ? "unlocked" : "locked" };
      if (options.client === "codex") tomlDigest = tomlBlockDigest(name, serverEntrySchema.parse(value));
    }
  }

  const requirements: AdoptApprovalRequirement[] = ["base"];
  if (match.grade === "strong") requirements.push("identity-strong-match");
  if (artifact !== null && artifact.lock === "unlocked") requirements.push("artifact-unlocked");
  if (options.scope === "user") requirements.push("user-scope-target");

  const plan = adoptPlanSchema.parse({
    schemaVersion: ADOPT_PLAN_SCHEMA_VERSION,
    kind: ADOPT_PLAN_KIND,
    status: blockers.length === 0 ? "ready" : "blocked",
    toolId: options.toolId,
    registryDigest: registryDigestExcluding(registry, options.toolId),
    manifestDigest: manifestDigest(manifest),
    platform: options.platform,
    identity: { grade: match.grade, reason: match.reason, artifactKey: match.artifact, canonicalAlias, serverName: name },
    target: { ...targetOut, entryKey },
    precondition: { fileDigest, entryDigest: value === undefined ? null : configEntryDigest(value), tomlBlockDigest: tomlDigest, stateEntry: statePresent ? "present" : "absent" },
    backend,
    launch,
    artifact,
    approvalRequirements: requirements,
    blockers,
    effects: { stateWrite: 1, configWrite: 0, spawn: 0, network: 0 },
  });
  return { ok: true, planned: { plan, planDigest: adoptPlanDigest(plan) } };
}

const same = (a: unknown, b: unknown) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));

/** 승인한 AdoptPlan과 실행 직전 Plan을 비교한다. */
export function diffAdoptPlans(approved: AdoptPlanV1, current: AdoptPlanV1): AdoptPlanChange[] {
  const changed = new Set<AdoptPlanChange>();
  if (approved.registryDigest !== current.registryDigest) changed.add("registry");
  if (approved.manifestDigest !== current.manifestDigest) changed.add("manifest");
  if (!same(approved.identity, current.identity)) changed.add("identity");
  if (!same(approved.target, current.target) || approved.platform !== current.platform) changed.add("target");
  if (approved.precondition.fileDigest !== current.precondition.fileDigest) changed.add("config-file");
  if (approved.precondition.entryDigest !== current.precondition.entryDigest || approved.precondition.tomlBlockDigest !== current.precondition.tomlBlockDigest) changed.add("config-entry");
  if (approved.precondition.stateEntry !== current.precondition.stateEntry) changed.add("state-present");
  if (changed.size === 0 && !same(approved, current)) changed.add("config-entry");
  return ADOPT_PLAN_CHANGE_KINDS.filter((k) => changed.has(k));
}

// ---------------------------------------------------------------- Approval(공통 kernel)

const ADOPT_KIND: ApprovalPlanKind<AdoptPlanV1, AdoptApprovalRequirement, AdoptPlanChange> = {
  kind: "adopt-plan-v1",
  parse: (plan) => {
    const parsed = adoptPlanSchema.safeParse(plan);
    return parsed.success ? parsed.data : null;
  },
  digest: adoptPlanDigest,
  status: (plan) => plan.status,
  executableStatus: "ready",
  requirements: (plan) => plan.approvalRequirements,
  knownRequirements: ADOPT_APPROVAL_REQUIREMENTS,
  messages: ADOPT_APPROVAL_MESSAGES,
  diff: diffAdoptPlans,
  fallbackChange: "config-entry",
  staleMessage: "승인 후 adopt 계획이 바뀌었습니다(설정·식별·Registry·Version State). 다시 확인하고 승인하세요",
};

export type AdoptApprovalRequest = KernelApprovalRequest<AdoptPlanV1, AdoptApprovalRequirement>;
export interface AdoptApprovalPrompter {
  readonly channel: ApprovalChannel;
  confirm(request: AdoptApprovalRequest): Promise<readonly AdoptApprovalRequirement[] | "rejected">;
}
export type AdoptApproval = KernelApproval<AdoptApprovalRequirement>;
export type AdoptApprovalOutcome = KernelApprovalOutcome<AdoptApprovalRequirement>;
export type VerifiedAdoptPlan = KernelVerified<AdoptPlanV1, AdoptApprovalRequirement>;
export type AdoptGateFailure = KernelGateFailure<AdoptApprovalRequirement, AdoptPlanChange> & { cause?: AdoptPlanErrorCode };

export function isVerifiedAdoptPlan(value: unknown): value is VerifiedAdoptPlan {
  return isKernelVerified(value, ADOPT_KIND.kind);
}

/** AdoptPlan을 사람에게 보여 주고 Approval을 받는다. ready Plan만 승인할 수 있다. */
export function requestAdoptApproval(planned: PlannedAdopt, prompter: AdoptApprovalPrompter): Promise<AdoptApprovalOutcome> {
  return requestKernelApproval(ADOPT_KIND, planned, prompter as KernelPrompter<AdoptPlanV1, AdoptApprovalRequirement>);
}

/** 실행 직전 검증. regenerate는 planAdopt를 같은 옵션으로 다시 부른다(config·state·Registry 재조회). */
export async function verifyApprovedAdoptPlan(approval: AdoptApproval | undefined, regenerate: () => Promise<AdoptPlanResult>): Promise<{ ok: true; verified: VerifiedAdoptPlan } | AdoptGateFailure> {
  let cause: { code: AdoptPlanErrorCode; message: string } | undefined;
  const gate = await verifyKernelApproval(ADOPT_KIND, approval, async () => {
    const result = await regenerate();
    if (!result.ok) {
      cause = { code: result.code, message: result.message };
      throw new Error(result.code);
    }
    return result.planned;
  });
  if (!gate.ok && gate.code === "PLAN_REGENERATION_FAILED" && cause !== undefined) {
    return { ...gate, message: "실행 직전 adopt 계획을 다시 만들지 못했습니다: " + cause.message, cause: cause.code };
  }
  return gate;
}

