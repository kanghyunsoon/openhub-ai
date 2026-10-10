import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { WINDOWS_CMD_EXTRA_METACHARACTERS, tokenizeManifestCommand } from "./command";
import { NPX_CLI_PLACEHOLDER, TOOL_CONFIG_PLACEHOLDER, planFormOfEntry } from "../tool-config/index";
import { canonicalize, entryPlanDigest, type ApprovalRequirement, type ConfigPatchStep, type ConfigScope, type EnvReferenceStyle, type InstallClient, type PlanTargetInput, type ServerEntry } from "./plan";

/**
 * Agent Client Config Writer(TASK-032, D-013·D-014).
 * - 쓸 수 있는 파일은 allowlist 5개뿐이다. ~/.claude.json 등 그 밖은 manual-setup-required이고 쓰지 않는다.
 * - JSON: mcpServers.<alias>만 추가한다. 다른 key·서버·unknown field를 그대로 두고 들여쓰기·줄바꿈 형식을 유지한다.
 * - TOML: 원본 byte 뒤에 [mcp_servers.<alias>] 블록만 덧붙이고 smol-toml로 다시 parse해 검증한다.
 * - 같은 key가 있으면 CONFIG_KEY_EXISTS. 같은 디렉터리 임시 파일 → rename(atomic). 원본 byte를 영수증에 담아 복구할 수 있다.
 * - 대상 파일·상위 디렉터리가 project root·home 밖으로 해석되는 symlink·junction이면 거부한다.
 * - env는 공식 reference만 쓴다(Claude Code "${NAME}", Cursor "${env:NAME}", Codex env_vars). process.env를 읽지 않는다.
 * - Codex trust, Claude Code project MCP 승인 상태는 수정하지 않는다(안내만).
 */

export type ConfigFormat = "json" | "codex-toml";

interface WritableTarget {
  writable: true;
  client: InstallClient;
  scope: ConfigScope;
  logical: string;
  relative: string;
  format: ConfigFormat;
  envReference: Exclude<EnvReferenceStyle, "manual">;
}
interface ManualTarget {
  writable: false;
  client: InstallClient;
  scope: ConfigScope;
  logical: string;
  reason: string;
}
export type ConfigTarget = WritableTarget | ManualTarget;

const W = (client: InstallClient, scope: ConfigScope, relative: string, format: ConfigFormat, envReference: WritableTarget["envReference"]): WritableTarget => ({
  writable: true,
  client,
  scope,
  logical: scope === "user" ? "~/" + relative : relative,
  relative,
  format,
  envReference,
});

/** D-013 allowlist. 이 표에 없는 파일은 쓰지 않는다. */
export const CONFIG_WRITE_ALLOWLIST: readonly WritableTarget[] = Object.freeze([
  W("claude-code", "project", ".mcp.json", "json", "claude-dollar-brace"),
  W("cursor", "project", ".cursor/mcp.json", "json", "cursor-env"),
  W("codex", "project", ".codex/config.toml", "codex-toml", "codex-env-vars"),
  W("cursor", "user", ".cursor/mcp.json", "json", "cursor-env"),
  W("codex", "user", ".codex/config.toml", "codex-toml", "codex-env-vars"),
]);

export function configTargetFor(client: InstallClient, scope: ConfigScope): ConfigTarget {
  const found = CONFIG_WRITE_ALLOWLIST.find((t) => t.client === client && t.scope === scope);
  if (found !== undefined) return found;
  return { writable: false, client, scope, logical: client === "claude-code" && scope === "user" ? "~/.claude.json" : "(unsupported)", reason: "OpenHub가 쓰지 않는 설정 파일입니다(D-013)" };
}

/** manual-setup-required 안내(값은 넣지 않는다). */
export function manualSetupInstructions(client: InstallClient, scope: ConfigScope, serverName: string): string {
  if (client === "claude-code" && scope === "user") {
    return "Claude Code 사용자 범위 설정(~/.claude.json)은 OpenHub가 수정하지 않습니다. Claude Code에서 직접 " + serverName + " MCP 서버를 사용자 범위로 추가하세요.";
  }
  return client + " " + scope + " 설정은 OpenHub가 형식을 확인하지 못해 쓰지 않습니다. " + serverName + " 서버를 직접 추가하세요.";
}

export interface ConfigFs {
  readFile(file: string): Promise<Buffer>;
  writeFile(file: string, data: Buffer): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  rm(file: string): Promise<void>;
  rmdir(dir: string): Promise<void>;
  mkdir(dir: string): Promise<void>;
  lstat(file: string): Promise<{ isSymbolicLink(): boolean; isFile(): boolean; isDirectory(): boolean }>;
  realpath(file: string): Promise<string>;
}

export const nodeConfigFs: ConfigFs = {
  readFile: (f) => nodeFs.readFile(f),
  writeFile: (f, d) => nodeFs.writeFile(f, d, { flag: "wx" }),
  rename: (a, b) => nodeFs.rename(a, b),
  rm: (f) => nodeFs.rm(f, { force: true }),
  rmdir: (d) => nodeFs.rmdir(d),
  mkdir: async (d) => {
    await nodeFs.mkdir(d);
  },
  lstat: (f) => nodeFs.lstat(f),
  realpath: (f) => nodeFs.realpath(f),
};

export interface ConfigRoots {
  projectRoot: string;
  homeDir: string;
  fs?: ConfigFs;
}

export type ConfigErrorCode = "MANUAL_SETUP_REQUIRED" | "CONFIG_KEY_EXISTS" | "CONFIG_UNPARSEABLE" | "CONFIG_PATH_ESCAPE" | "CONFIG_WRITE_FAILED" | "USER_SCOPE_NOT_APPROVED";

export class ConfigWriteError extends Error {
  constructor(
    readonly code: ConfigErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "ConfigWriteError";
  }
}

const sameOrInside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const isMissing = (error: unknown) => typeof error === "object" && error !== null && (error as { code?: string }).code === "ENOENT";

/** root 기준 절대 경로와, 대상·상위 디렉터리가 root 밖으로 해석되지 않는지 확인한다. */
export async function resolveInside(target: WritableTarget, roots: ConfigRoots, fs: ConfigFs): Promise<{ file: string; root: string }> {
  const root = path.resolve(target.scope === "user" ? roots.homeDir : roots.projectRoot);
  const file = path.join(root, ...target.relative.split("/"));
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    throw new ConfigWriteError("CONFIG_PATH_ESCAPE", "기준 디렉터리를 확인하지 못했습니다");
  }
  // 대상 파일부터 root까지 존재하는 경로를 확인한다. symlink·junction이면 실제 위치가 root 안이어야 한다.
  for (let current = file; sameOrInside(current, root); current = path.dirname(current)) {
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (isMissing(error)) {
        if (current === root) break;
        continue;
      }
      throw new ConfigWriteError("CONFIG_PATH_ESCAPE", "설정 경로를 확인하지 못했습니다");
    }
    const real = await fs.realpath(current).catch(() => "");
    if (real === "" || !sameOrInside(real, realRoot)) throw new ConfigWriteError("CONFIG_PATH_ESCAPE", target.logical + " 경로가 " + (target.scope === "user" ? "home" : "project root") + " 밖을 가리킵니다");
    if (current === file && stat.isSymbolicLink()) throw new ConfigWriteError("CONFIG_PATH_ESCAPE", target.logical + "이(가) symlink·junction입니다");
    if (current === root) break;
  }
  return { file, root };
}

export async function readOptional(fs: ConfigFs, file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new ConfigWriteError("CONFIG_WRITE_FAILED", "설정 파일을 읽지 못했습니다");
  }
}

interface TextShape {
  bom: boolean;
  eol: "\n" | "\r\n";
  text: string;
}
export function decode(bytes: Buffer): TextShape {
  let text = bytes.toString("utf8");
  const bom = text.startsWith("\uFEFF");
  if (bom) text = text.slice(1);
  return { bom, eol: text.includes("\r\n") ? "\r\n" : "\n", text };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function detectIndent(text: string): string | number {
  const line = text.split(/\r?\n/u).find((l) => /^[ \t]+\S/u.test(l));
  if (line === undefined) return 2;
  const lead = /^[ \t]+/u.exec(line)![0];
  return lead.startsWith("\t") ? "\t" : lead.length;
}

/** 서버 항목을 찾는다. 없으면 { present: false }. 해석할 수 없는 파일은 예외다. */
function findServerEntry(bytes: Buffer | null, format: ConfigFormat, serverName: string): { present: false } | { present: true; value: unknown } {
  if (bytes === null) return { present: false };
  const { text } = decode(bytes);
  if (text.trim() === "") return { present: false };
  const doc: unknown = format === "json" ? JSON.parse(text) : parseToml(text);
  const servers = isRecord(doc) ? doc[format === "json" ? "mcpServers" : "mcp_servers"] : undefined;
  return isRecord(servers) && Object.prototype.hasOwnProperty.call(servers, serverName) ? { present: true, value: servers[serverName] } : { present: false };
}

/**
 * Client 설정에서 읽은 항목 → Plan 형태(비교용). 기본은 planFormOfEntry(OpenHub 관리 tool config 경로·Windows node 실행 경로를
 * placeholder로 되돌린다). undefined를 돌려주면 "같은 항목인지 판정할 수 없음"이고 그 대상은 충돌로 막힌다.
 */
export type EntryPlanForm = (entry: unknown) => unknown;

export const defaultEntryPlanForm: EntryPlanForm = (entry) =>
  isRecord(entry) && typeof entry.command === "string" && Array.isArray(entry.args) && entry.args.every((a) => typeof a === "string")
    ? planFormOfEntry(entry as { command: string; args: string[] })
    : entry;

/**
 * Plan에 넣을 대상 정보(논리 경로·precondition). 파일 내용은 digest로만 남긴다.
 * 같은 서버 이름 항목이 있으면 그 항목을 Plan 형태로 되돌린 값의 digest(entryDigest)도 넣는다(v0.2.0 범위별 설치 판정).
 * 항목 값 자체(경로·인자)는 Plan에 남기지 않는다.
 */
export async function inspectConfigTarget(client: InstallClient, scope: ConfigScope, serverName: string, roots: ConfigRoots, planForm: EntryPlanForm = defaultEntryPlanForm): Promise<PlanTargetInput> {
  const target = configTargetFor(client, scope);
  if (!target.writable) return { client, scope, file: target.logical, envReference: "manual", precondition: { exists: false, fileDigest: null, keyAbsent: true } };
  const fs = roots.fs ?? nodeConfigFs;
  const { file } = await resolveInside(target, roots, fs);
  const bytes = await readOptional(fs, file);
  let keyAbsent = true;
  let entryDigest: string | undefined;
  try {
    const found = findServerEntry(bytes, target.format, serverName);
    keyAbsent = !found.present;
    if (found.present) {
      const form = planForm(found.value);
      if (form !== undefined) entryDigest = entryPlanDigest(form);
    }
  } catch {
    keyAbsent = true; // 해석 불가 파일은 쓰기 단계에서 CONFIG_UNPARSEABLE로 멈춘다. digest가 내용 변화를 잡는다.
  }
  return {
    client,
    scope,
    file: target.logical,
    envReference: target.envReference,
    precondition: { exists: bytes !== null, fileDigest: bytes === null ? null : fileSha256(bytes), keyAbsent, ...(entryDigest === undefined ? {} : { entryDigest }) },
  };
}

/** 파일 byte의 sha256(인코딩 해석 없이). */
export function fileSha256(bytes: Buffer): string {
  return "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

const CLIENT_COMMANDS = ["npx", "uvx", "docker", "cmd", "node"];

/**
 * D-016 Windows npx wrapper 검증. args가 정확히 ["/d", "/c", "npx", ...]이고 나머지 인자가 strict tokenizer와
 * Windows cmd 추가 금지 문자(%·!·^)를 통과해야 한다. 아니면 자동 완화하지 않고 manual-setup-required다.
 */
function isSafeWindowsNpxWrapper(args: readonly string[]): boolean {
  if (args.length < 4 || args[0] !== "/d" || args[1] !== "/c" || args[2] !== "npx") return false;
  const rest = args.slice(3);
  if (rest.some((a) => /[ \t]/u.test(a) || WINDOWS_CMD_EXTRA_METACHARACTERS.some((c) => a.includes(c)))) return false;
  return tokenizeManifestCommand(["npx", ...rest].join(" "), "npx", { windowsCmdWrapper: true }).ok;
}

/**
 * v0.2.0 tool config Tool의 Windows 직접 실행 형태(placeholder): command "node", args ["{npxCli}", ...npx 인자],
 * {toolConfig}가 정확히 한 번, "--config" 바로 뒤. 실제 절대 경로는 쓰는 순간 materialize가 넣는다.
 */
function isToolConfigNodeEntry(args: readonly string[]): boolean {
  if (args[0] !== NPX_CLI_PLACEHOLDER) return false;
  const rest = args.slice(1);
  const i = rest.indexOf(TOOL_CONFIG_PLACEHOLDER);
  if (i < 1 || rest[i - 1] !== "--config" || rest.filter((a) => a === TOOL_CONFIG_PLACEHOLDER).length !== 1) return false;
  const tokens = rest.map((a) => (a === TOOL_CONFIG_PLACEHOLDER ? "openhub-tool-config-placeholder" : a));
  return tokenizeManifestCommand(["npx", ...tokens].join(" "), "npx").ok;
}

/** Client별 공식 형식(과 D-016 Windows compatibility policy)인지 확인한다. 확인되지 않은 필드·reference·command는 쓰지 않는다. */
export function isOfficialServerEntry(client: InstallClient, value: ServerEntry): boolean {
  const keys = Object.keys(value).sort();
  const allowed = client === "codex" ? ["args", "command", "env_vars"] : ["args", "command", "env"];
  if (keys.some((k) => !allowed.includes(k))) return false;
  if (typeof value.command !== "string" || !Array.isArray(value.args)) return false;
  if (!CLIENT_COMMANDS.includes(value.command)) return false;
  if (value.command === "cmd" && !isSafeWindowsNpxWrapper(value.args)) return false;
  if (value.command === "node" && !isToolConfigNodeEntry(value.args)) return false;
  if (value.command !== "node" && value.args.includes(NPX_CLI_PLACEHOLDER)) return false;
  if (client === "codex") return value.env === undefined;
  for (const [name, ref] of Object.entries(value.env ?? {})) {
    const expected = client === "cursor" ? "$" + "{env:" + name + "}" : "$" + "{" + name + "}";
    if (ref !== expected) return false;
  }
  return value.env_vars === undefined;
}

const tomlKey = (key: string) => (/^[A-Za-z0-9_-]+$/u.test(key) ? key : JSON.stringify(key));
const tomlString = (value: string) => JSON.stringify(value);
const tomlArray = (values: readonly string[]) => "[" + values.map(tomlString).join(", ") + "]";

/** Codex config에 덧붙이는 [mcp_servers.<alias>] block. M5 Version State는 이 block의 digest로 교체 대상을 확인한다. */
export function codexBlock(serverName: string, value: ServerEntry, eol: string): string {
  const lines = ["[mcp_servers." + tomlKey(serverName) + "]", "command = " + tomlString(value.command), "args = " + tomlArray(value.args)];
  if (value.env_vars !== undefined) lines.push("env_vars = " + tomlArray(value.env_vars));
  return lines.join(eol) + eol;
}

/** 원본과 새 내용. 같은 key·해석 불가·형식 오류면 예외. */
export function patchConfigText(original: Buffer | null, format: ConfigFormat, serverName: string, value: ServerEntry): Buffer {
  if (format === "json") {
    const shape = original === null ? { bom: false, eol: "\n" as const, text: "" } : decode(original);
    let doc: unknown = {};
    if (shape.text.trim() !== "") {
      try {
        doc = JSON.parse(shape.text);
      } catch {
        throw new ConfigWriteError("CONFIG_UNPARSEABLE", "JSON 설정 파일을 해석하지 못했습니다");
      }
    }
    if (!isRecord(doc)) throw new ConfigWriteError("CONFIG_UNPARSEABLE", "JSON 설정 파일의 최상위가 객체가 아닙니다");
    const servers = doc["mcpServers"];
    if (servers !== undefined && !isRecord(servers)) throw new ConfigWriteError("CONFIG_UNPARSEABLE", "mcpServers가 객체가 아닙니다");
    if (isRecord(servers) && Object.prototype.hasOwnProperty.call(servers, serverName)) throw new ConfigWriteError("CONFIG_KEY_EXISTS", "이미 " + serverName + " 서버 항목이 있습니다");
    const next = { ...doc, mcpServers: { ...(servers ?? {}), [serverName]: canonicalize(value) } };
    let text = JSON.stringify(next, null, detectIndent(shape.text));
    const trailing = original === null || /\r?\n$/u.test(shape.text) ? shape.eol : "";
    text = (shape.eol === "\r\n" ? text.replace(/\n/gu, "\r\n") : text) + trailing;
    return Buffer.from((shape.bom ? "\uFEFF" : "") + text, "utf8");
  }
  const originalBytes = original ?? Buffer.alloc(0);
  const shape = decode(originalBytes);
  let doc: unknown = {};
  try {
    doc = shape.text.trim() === "" ? {} : parseToml(shape.text);
  } catch {
    throw new ConfigWriteError("CONFIG_UNPARSEABLE", "TOML 설정 파일을 해석하지 못했습니다");
  }
  const servers = isRecord(doc) ? doc["mcp_servers"] : undefined;
  if (servers !== undefined && !isRecord(servers)) throw new ConfigWriteError("CONFIG_UNPARSEABLE", "mcp_servers가 테이블이 아닙니다");
  if (isRecord(servers) && Object.prototype.hasOwnProperty.call(servers, serverName)) throw new ConfigWriteError("CONFIG_KEY_EXISTS", "이미 " + serverName + " 서버 항목이 있습니다");
  // 원본 byte는 그대로 앞에 둔다. 끝에 줄바꿈이 없으면 하나 붙이고, 빈 줄 하나 뒤에 블록을 덧붙인다.
  const sep = originalBytes.length === 0 ? "" : (shape.text.endsWith("\n") ? "" : shape.eol) + shape.eol;
  const appended = Buffer.concat([originalBytes, Buffer.from(sep + codexBlock(serverName, value, shape.eol), "utf8")]);
  let reparsed: unknown;
  try {
    reparsed = parseToml(decode(appended).text);
  } catch {
    throw new ConfigWriteError("CONFIG_UNPARSEABLE", "덧붙인 TOML을 다시 해석하지 못했습니다(기존 mcp_servers 형식과 충돌)");
  }
  const written = isRecord(reparsed) && isRecord(reparsed["mcp_servers"]) ? reparsed["mcp_servers"][serverName] : undefined;
  if (JSON.stringify(canonicalize(written)) !== JSON.stringify(canonicalize(value))) throw new ConfigWriteError("CONFIG_UNPARSEABLE", "덧붙인 TOML 항목이 Plan 값과 다릅니다");
  return appended;
}

/** 복구용 영수증. 원본 byte(없던 파일이면 null)와 만든 디렉터리를 담는다. 절대 경로는 결과에 내보내지 않는다. */
export interface ConfigWriteReceipt {
  readonly client: InstallClient;
  readonly scope: ConfigScope;
  readonly file: string;
  readonly serverName: string;
  readonly absolutePath: string;
  readonly original: Buffer | null;
  /** 이번에 쓴 byte. 복구 직전 파일이 이것과 다르면(다른 프로세스가 바꿨으면) 덮어쓰지 않는다. */
  readonly written: Buffer;
  readonly createdDirs: readonly string[];
}

export async function atomicWrite(fs: ConfigFs, file: string, data: Buffer): Promise<void> {
  const temp = path.join(path.dirname(file), "." + path.basename(file) + ".openhub-" + randomBytes(6).toString("hex") + ".tmp");
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  } catch {
    await fs.rm(temp).catch(() => undefined);
    throw new ConfigWriteError("CONFIG_WRITE_FAILED", "설정 파일을 쓰지 못했습니다(원본은 그대로입니다)");
  }
}

export interface ApplyConfigOptions extends ConfigRoots {
  /** VerifiedPlan의 acknowledgements. user scope는 user-scope-config가 있어야 쓴다. */
  acknowledgements: readonly ApprovalRequirement[];
  /**
   * placeholder 형태({toolConfig}·node+{npxCli})를 실제로 쓸 값으로 바꾼다(v0.2.0 tool config). 검증은 placeholder 형태로 하고
   * 파일에는 바꾼 값을 쓴다. 바꿀 수 없으면 ConfigWriteError(MANUAL_SETUP_REQUIRED)를 던진다.
   */
  materialize?: (value: ServerEntry) => ServerEntry;
}

/** config-patch 단계 하나를 적용한다. 실패하면 파일을 바꾸지 않는다. */
export async function applyConfigPatch(step: ConfigPatchStep, options: ApplyConfigOptions): Promise<ConfigWriteReceipt> {
  const target = configTargetFor(step.client, step.scope);
  const serverName = step.path[1]!;
  const expectedPath = [target.client === "codex" ? "mcp_servers" : "mcpServers", serverName];
  if (!target.writable || step.file !== target.logical || step.path.length !== 2 || step.path[0] !== expectedPath[0]) {
    throw new ConfigWriteError("MANUAL_SETUP_REQUIRED", manualSetupInstructions(step.client, step.scope, serverName));
  }
  if (!isOfficialServerEntry(step.client, step.value)) throw new ConfigWriteError("MANUAL_SETUP_REQUIRED", manualSetupInstructions(step.client, step.scope, serverName));
  if (step.scope === "user" && !options.acknowledgements.includes("user-scope-config")) {
    throw new ConfigWriteError("USER_SCOPE_NOT_APPROVED", "사용자 범위 설정 변경(user-scope-config)을 승인하지 않았습니다");
  }
  const fs = options.fs ?? nodeConfigFs;
  const { file, root } = await resolveInside(target, options, fs);
  const original = await readOptional(fs, file);
  const next = patchConfigText(original, target.format, serverName, options.materialize === undefined ? step.value : options.materialize(step.value));
  const missing: string[] = [];
  for (let dir = path.dirname(file); dir !== root && sameOrInside(dir, root); dir = path.dirname(dir)) {
    try {
      await fs.lstat(dir);
      break;
    } catch (error) {
      if (!isMissing(error)) throw new ConfigWriteError("CONFIG_WRITE_FAILED", "설정 디렉터리를 확인하지 못했습니다");
      missing.push(dir);
    }
  }
  const createdDirs: string[] = [];
  try {
    for (const d of missing.reverse()) {
      await fs.mkdir(d);
      createdDirs.push(d);
    }
    await atomicWrite(fs, file, next);
  } catch (error) {
    for (const d of [...createdDirs].reverse()) await fs.rmdir(d).catch(() => undefined);
    throw error instanceof ConfigWriteError ? error : new ConfigWriteError("CONFIG_WRITE_FAILED", "설정 디렉터리를 만들지 못했습니다");
  }
  return Object.freeze({ client: step.client, scope: step.scope, file: target.logical, serverName, absolutePath: file, original, written: next, createdDirs: Object.freeze(createdDirs) });
}

/**
 * 영수증대로 원본 byte를 되돌린다(없던 파일은 지우고 만든 디렉터리를 비어 있으면 지운다).
 * 지금 파일이 이번에 쓴 byte와 다르면(그 사이 다른 프로세스가 바꿨으면) 덮어쓰지 않고 false다.
 */
export async function restoreConfig(receipt: ConfigWriteReceipt, fs: ConfigFs = nodeConfigFs): Promise<boolean> {
  try {
    const now = await readOptional(fs, receipt.absolutePath);
    if (now === null || !now.equals(receipt.written)) return false;
    if (receipt.original === null) {
      await fs.rm(receipt.absolutePath);
      for (const d of [...receipt.createdDirs].reverse()) await fs.rmdir(d).catch(() => undefined);
    } else {
      await atomicWrite(fs, receipt.absolutePath, receipt.original);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * HTTP MCP loopback 항목(D-027, D-013 확장). Client가 공식 문서로 지원하는 형식만 쓴다:
 * Claude Code project `.mcp.json` `{ "type": "http", "url" }`, Cursor `.cursor/mcp.json`·`~/.cursor/mcp.json` `{ "url" }`.
 * URL은 `http://127.0.0.1:<port>/<path>`만, token·header는 쓰지 않는다. 그 밖의 Client·범위는 MANUAL_SETUP_REQUIRED다.
 */
export async function applyLoopbackHttpEntry(
  target: { client: InstallClient; scope: ConfigScope; serverName: string; url: string },
  options: ConfigRoots & { userScopeApproved: boolean },
): Promise<ConfigWriteReceipt> {
  const configTarget = configTargetFor(target.client, target.scope);
  const supported = (target.client === "claude-code" && target.scope === "project") || target.client === "cursor";
  if (!configTarget.writable || !supported || configTarget.format !== "json") throw new ConfigWriteError("MANUAL_SETUP_REQUIRED", manualSetupInstructions(target.client, target.scope, target.serverName));
  if (!/^http:\/\/127\.0\.0\.1:\d{1,5}(?:\/[A-Za-z0-9._/-]*)?$/u.test(target.url) || target.url.includes("..")) throw new ConfigWriteError("MANUAL_SETUP_REQUIRED", "loopback http URL만 쓸 수 있습니다");
  if (target.scope === "user" && !options.userScopeApproved) throw new ConfigWriteError("USER_SCOPE_NOT_APPROVED", "사용자 범위 설정 변경(user-scope-config)을 승인하지 않았습니다");
  const value = (target.client === "claude-code" ? { type: "http", url: target.url } : { url: target.url }) as unknown as ServerEntry;
  const fs = options.fs ?? nodeConfigFs;
  const { file, root } = await resolveInside(configTarget, options, fs);
  const original = await readOptional(fs, file);
  const next = patchConfigText(original, "json", target.serverName, value);
  const missing: string[] = [];
  for (let dir = path.dirname(file); dir !== root && sameOrInside(dir, root); dir = path.dirname(dir)) {
    try {
      await fs.lstat(dir);
      break;
    } catch (error) {
      if (!isMissing(error)) throw new ConfigWriteError("CONFIG_WRITE_FAILED", "설정 디렉터리를 확인하지 못했습니다");
      missing.push(dir);
    }
  }
  const createdDirs: string[] = [];
  try {
    for (const d of missing.reverse()) {
      await fs.mkdir(d);
      createdDirs.push(d);
    }
    await atomicWrite(fs, file, next);
  } catch (error) {
    for (const d of [...createdDirs].reverse()) await fs.rmdir(d).catch(() => undefined);
    throw error instanceof ConfigWriteError ? error : new ConfigWriteError("CONFIG_WRITE_FAILED", "설정 디렉터리를 만들지 못했습니다");
  }
  return Object.freeze({ client: target.client, scope: target.scope, file: configTarget.logical, serverName: target.serverName, absolutePath: file, original, written: next, createdDirs: Object.freeze(createdDirs) });
}

/** 설정 파일을 다시 읽어 서버 항목을 돌려준다(Configured 확인용). */
export async function readConfiguredEntry(client: InstallClient, scope: ConfigScope, serverName: string, roots: ConfigRoots): Promise<unknown> {
  const target = configTargetFor(client, scope);
  if (!target.writable) return undefined;
  const fs = roots.fs ?? nodeConfigFs;
  const { file } = await resolveInside(target, roots, fs);
  const bytes = await readOptional(fs, file);
  if (bytes === null) return undefined;
  const { text } = decode(bytes);
  try {
    const doc: unknown = target.format === "json" ? JSON.parse(text) : parseToml(text);
    const servers = isRecord(doc) ? doc[target.format === "json" ? "mcpServers" : "mcp_servers"] : undefined;
    return isRecord(servers) ? servers[serverName] : undefined;
  } catch {
    return undefined;
  }
}
