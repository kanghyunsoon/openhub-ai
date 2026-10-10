import { createHash, randomBytes } from "node:crypto";
import * as nodeFs from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { Manifest } from "../manifest/schema";

/**
 * OpenHub 관리 tool config(v0.2.0, docs/specs/kubernetes-tool-restriction.md).
 *
 * - 허용 목록의 Tool만 Manifest에 고정 TOML(toolConfig)을 둘 수 있다. 임의 Manifest는 파일을 만들 수 없다.
 * - 위치: ~/.openhub/tool-config/user/<toolId>/config.toml, ~/.openhub/tool-config/project/<projectKey>/<toolId>/config.toml.
 *   projectKey는 Version State와 같은 값(sha256(realpath) 앞 16 hex)이다. 프로젝트 안에는 쓰지 않는다.
 * - Plan·Result에는 논리 ID(tool-config:<scope>:<toolId>)·scope·내용 digest·기대 이전 상태만 남긴다.
 *   절대 경로는 Client 설정의 --config 인자에만 들어가며 그때 계산하고 다시 검사한다.
 * - 쓰기: 승인 뒤, 같은 디렉터리 임시 파일 → rename(원자적), 파일 0600·디렉터리 0700(POSIX), 경로의 모든 단계 symlink·junction 거부.
 * - 실패 보상: 이번에 만든 파일은 지우고, 바꾼 파일은 원래 byte로 되돌린다.
 */

export const TOOL_CONFIG_PLACEHOLDER = "{toolConfig}";
/** Windows Client 직접 실행(v0.2.0): command "node" + 첫 인자 {npxCli}. 쓰는 순간 검증된 node.exe·npx-cli.js로 바꾼다. */
export const NPX_CLI_PLACEHOLDER = "{npxCli}";
export const TOOL_CONFIG_MAX_BYTES = 4096;
export type ToolConfigScope = "user" | "project";

/**
 * 검토된 tool config 정책(허용 목록). 유효한 TOML이라는 것만으로는 통과하지 않는다.
 * - command는 정확히 이 형태여야 한다(검토된 버전, 필수 플래그, --config {toolConfig} 1개, 다른 플래그 없음).
 * - content는 해석한 값이 검토된 값과 정확히 같아야 한다(추가 키·다른 값 거부). 주석·공백 차이만 허용한다.
 */
export interface ReviewedToolConfig {
  toolId: string;
  /** 검토된 정확한 실행 명령들(버전별). */
  commands: readonly string[];
  /** 검토된 TOML(정규 형태). */
  content: string;
  /** 설치 계획 고지(고정 문구). */
  notice: string;
}

export const KUBERNETES_TOOL_CONFIG = 'read_only = true\ntoolsets = ["core"]\n\n[[denied_resources]]\ngroup = ""\nversion = "v1"\nkind = "Secret"\n';

export const REVIEWED_TOOL_CONFIGS: Readonly<Record<string, ReviewedToolConfig>> = Object.freeze({
  "kubernetes-mcp-server": Object.freeze({
    toolId: "kubernetes-mcp-server",
    commands: Object.freeze(["npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config " + TOOL_CONFIG_PLACEHOLDER]),
    content: KUBERNETES_TOOL_CONFIG,
    notice:
      "OpenHub가 ~/.openhub/tool-config 아래에 서버 정책 파일(read_only, core toolset, Secret 조회 거부)을 만들고 Client 설정의 --config로 넘깁니다. 서버는 kubeconfig의 current context 사용자 권한으로 동작하며 OpenHub는 kubeconfig를 읽지 않습니다. Pod·Node 로그에 비밀정보가 있으면 막지 못합니다. 읽기 전용 RBAC 사용자를 쓰세요.",
  }),
});
export const TOOL_CONFIG_ALLOWLIST: readonly string[] = Object.freeze(Object.keys(REVIEWED_TOOL_CONFIGS));

const TOOL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PROJECT_KEY = /^[0-9a-f]{16}$/u;

export function toolConfigFileId(scope: ToolConfigScope, toolId: string): string {
  return "tool-config:" + scope + ":" + toolId;
}

export function toolConfigDigest(content: string): string {
  return "sha256:" + createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");
}

function commandTokens(manifest: Manifest): string[] {
  const command = manifest.install.options?.["command"];
  return typeof command === "string" ? command.trim().split(/\s+/u) : [];
}

/** 값 문자열 안에서 금지하는 형태: 환경변수·명령 치환, 절대 경로, 상위 경로, URL 계정. */
const FORBIDDEN_VALUE = [/\$\{/u, /\$\(/u, /%[A-Za-z_]+%/u, /^[A-Za-z]:[\\/]/u, /^[\\/]/u, /(^|[\\/])\.\.([\\/]|$)/u, /:\/\/[^/\s]*@/u, /^~/u];

function stringValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(stringValues);
  if (value !== null && typeof value === "object") return Object.values(value).flatMap(stringValues);
  return [];
}

/**
 * Manifest toolConfig 정적 검사(Registry fast validation). 문제 목록을 돌려준다(없으면 []).
 * placeholder는 "--config {toolConfig}" 한 쌍으로만, toolConfig가 있을 때만 쓸 수 있다.
 */
export function toolConfigIssues(manifest: Manifest): { path: string; message: string }[] {
  const out: { path: string; message: string }[] = [];
  const tokens = commandTokens(manifest);
  const placeholders = tokens.filter((t) => t.includes(TOOL_CONFIG_PLACEHOLDER));
  const config = manifest.toolConfig;
  if (config === undefined) {
    if (placeholders.length > 0) out.push({ path: "install.options.command", message: "toolConfig 없이 " + TOOL_CONFIG_PLACEHOLDER + "를 쓸 수 없습니다" });
    return out;
  }
  const reviewed = REVIEWED_TOOL_CONFIGS[manifest.name];
  if (reviewed === undefined) {
    out.push({ path: "toolConfig", message: "toolConfig는 허용 목록의 Tool만 쓸 수 있습니다(" + TOOL_CONFIG_ALLOWLIST.join(", ") + ")" });
  } else if (!reviewed.commands.includes(tokens.join(" "))) {
    out.push({ path: "install.options.command", message: "toolConfig Tool의 실행 명령은 검토된 형태(버전·플래그)와 정확히 같아야 합니다" });
  }
  const i = tokens.indexOf(TOOL_CONFIG_PLACEHOLDER);
  if (placeholders.length !== 1 || i < 1 || tokens[i - 1] !== "--config") {
    out.push({ path: "install.options.command", message: "toolConfig가 있으면 명령에 --config " + TOOL_CONFIG_PLACEHOLDER + "가 정확히 한 번 있어야 합니다" });
  }
  if (Buffer.byteLength(config.content, "utf8") > TOOL_CONFIG_MAX_BYTES) out.push({ path: "toolConfig.content", message: "toolConfig는 " + String(TOOL_CONFIG_MAX_BYTES) + " byte 이하여야 합니다" });
  let parsed: unknown;
  try {
    parsed = parseToml(config.content);
  } catch {
    out.push({ path: "toolConfig.content", message: "toolConfig가 올바른 TOML이 아닙니다" });
    return out;
  }
  for (const v of stringValues(parsed)) {
    if (FORBIDDEN_VALUE.some((p) => p.test(v))) out.push({ path: "toolConfig.content", message: "toolConfig 값에 환경변수·명령 치환·경로·URL 계정을 쓸 수 없습니다" });
  }
  if (reviewed !== undefined && !sameToml(parsed, reviewed.content)) {
    out.push({ path: "toolConfig.content", message: "toolConfig 내용은 검토된 정책과 정확히 같아야 합니다(추가 설정·다른 값 거부)" });
  }
  return out;
}

function sameToml(parsed: unknown, reviewedContent: string): boolean {
  return JSON.stringify(canonicalJson(parsed)) === JSON.stringify(canonicalJson(parseToml(reviewedContent)));
}

function canonicalJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonicalJson((value as Record<string, unknown>)[k])]));
  return value;
}

/**
 * 파일을 쓰기 직전·Health 직전에 다시 확인한다. 검토된 정책과 내용이 정확히 같지 않으면 TOOL_CONFIG_REJECTED.
 */
export function assertReviewedToolConfig(toolId: string, content: string): void {
  const reviewed = REVIEWED_TOOL_CONFIGS[toolId];
  let parsed: unknown;
  try {
    parsed = parseToml(content);
  } catch {
    throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config가 올바른 TOML이 아닙니다");
  }
  if (reviewed === undefined || Buffer.byteLength(content, "utf8") > TOOL_CONFIG_MAX_BYTES || !sameToml(parsed, reviewed.content)) {
    throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config가 검토된 정책과 다릅니다");
  }
}

// ---------------------------------------------------------------- 위치

export interface ToolConfigLocation {
  fileId: string;
  scope: ToolConfigScope;
  toolId: string;
  /** ~/.openhub/tool-config(절대 경로, 결과에 남기지 않는다). */
  root: string;
  /** root부터 파일까지의 디렉터리 단계(절대 경로). */
  dirs: string[];
  file: string;
}

/** 위치를 계산한다. toolId·projectKey가 식별자 형식이 아니면 null(상대 경로 조작 불가). */
export function toolConfigLocation(input: { homeDir: string; scope: ToolConfigScope; toolId: string; projectKey?: string }): ToolConfigLocation | null {
  if (!TOOL_ID.test(input.toolId) || !path.isAbsolute(input.homeDir)) return null;
  if (input.scope === "project" && (input.projectKey === undefined || !PROJECT_KEY.test(input.projectKey))) return null;
  const openhub = path.join(input.homeDir, ".openhub");
  const root = path.join(openhub, "tool-config");
  const parts = input.scope === "user" ? ["user", input.toolId] : ["project", input.projectKey!, input.toolId];
  const dirs = [openhub, root];
  for (const p of parts) dirs.push(path.join(dirs[dirs.length - 1]!, p));
  const file = path.join(dirs[dirs.length - 1]!, "config.toml");
  if (path.relative(root, file).startsWith("..")) return null;
  return { fileId: toolConfigFileId(input.scope, input.toolId), scope: input.scope, toolId: input.toolId, root, dirs, file };
}

export interface ToolConfigFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>;
  realpath(p: string): Promise<string>;
  readFile(p: string): Promise<Buffer>;
  writeFile(p: string, data: Buffer, mode: number): Promise<void>;
  rename(a: string, b: string): Promise<void>;
  rm(p: string): Promise<void>;
  /** 빈 디렉터리만 지운다(비어 있지 않으면 실패: 그 사이 생긴 파일을 지우지 않는다). */
  rmdir(p: string): Promise<void>;
  mkdir(p: string, mode: number): Promise<void>;
  chmod(p: string, mode: number): Promise<void>;
}

export const nodeToolConfigFs: ToolConfigFs = {
  lstat: (p) => nodeFs.lstat(p),
  realpath: (p) => nodeFs.realpath(p),
  readFile: (p) => nodeFs.readFile(p),
  writeFile: (p, d, mode) => nodeFs.writeFile(p, d, { flag: "wx", mode }),
  rename: (a, b) => nodeFs.rename(a, b),
  rm: (p) => nodeFs.rm(p, { force: true }),
  rmdir: (p) => nodeFs.rmdir(p),
  mkdir: async (p, mode) => void (await nodeFs.mkdir(p, { mode })),
  chmod: (p, mode) => nodeFs.chmod(p, mode),
};

export type ToolConfigState = { state: "absent" } | { state: "present"; digest: string };
export class ToolConfigError extends Error {
  constructor(
    readonly code: "TOOL_CONFIG_REJECTED" | "TOOL_CONFIG_STALE" | "TOOL_CONFIG_WRITE_FAILED" | "TOOL_CONFIG_RESTORE_CONFLICT" | "TOOL_CONFIG_DRIFT",
    message: string,
  ) {
    super(message);
  }
}

const isMissing = (e: unknown) => (e as { code?: string }).code === "ENOENT";

/** 경로의 모든 단계(~/.openhub부터 파일까지)가 link가 아니고 실제 위치가 root 아래인지 확인한다. */
async function checkLinks(loc: ToolConfigLocation, fs: ToolConfigFs): Promise<void> {
  for (const p of [...loc.dirs, loc.file]) {
    let st;
    try {
      st = await fs.lstat(p);
    } catch (e) {
      if (isMissing(e)) return; // 이 아래는 아직 없다.
      throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config 경로를 확인하지 못했습니다");
    }
    if (st.isSymbolicLink()) throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config 경로에 symlink·junction이 있습니다");
    if (p === loc.file ? !st.isFile() : !st.isDirectory()) throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config 경로의 종류가 예상과 다릅니다");
  }
  const realRoot = await fs.realpath(loc.root).catch(() => null);
  if (realRoot !== null && path.relative(realRoot, await fs.realpath(path.dirname(loc.file)).catch(() => realRoot)).startsWith("..")) {
    throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config 위치가 OpenHub 관리 디렉터리 밖입니다");
  }
}

/** 현재 상태(없음 또는 내용 digest). link·위치 검사를 함께 한다. */
export async function inspectToolConfig(loc: ToolConfigLocation, fs: ToolConfigFs = nodeToolConfigFs): Promise<ToolConfigState> {
  await checkLinks(loc, fs);
  try {
    const data = await fs.readFile(loc.file);
    return { state: "present", digest: "sha256:" + createHash("sha256").update(data).digest("hex") };
  } catch (e) {
    if (isMissing(e)) return { state: "absent" };
    throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config를 읽지 못했습니다");
  }
}

/** 되돌리기 정보(결과에 남기지 않는다). digest는 이번에 쓴 내용이다(복구 전 확인용). */
export type ToolConfigUndo = { kind: "created"; createdDirs: string[]; digest: string } | { kind: "replaced"; original: Buffer; digest: string } | { kind: "unchanged"; digest: string };

const POSIX = process.platform !== "win32";

/**
 * 승인된 내용을 쓴다. 현재 상태가 승인 때 기대한 상태와 다르면 TOOL_CONFIG_STALE(쓰기 0).
 * 쓴 뒤 다시 읽어 digest를 확인한다.
 */
export async function writeToolConfig(loc: ToolConfigLocation, content: string, expected: ToolConfigState, fs: ToolConfigFs = nodeToolConfigFs): Promise<ToolConfigUndo> {
  assertReviewedToolConfig(loc.toolId, content);
  const current = await inspectToolConfig(loc, fs);
  const same = current.state === expected.state && (current.state === "absent" || (expected.state === "present" && current.digest === expected.digest));
  if (!same) throw new ToolConfigError("TOOL_CONFIG_STALE", "승인 뒤 tool config가 바뀌었습니다. 다시 계획하고 승인하세요");
  const digest = toolConfigDigest(content);
  if (current.state === "present" && current.digest === digest) return { kind: "unchanged", digest };
  const original = current.state === "present" ? await fs.readFile(loc.file) : null;
  const createdDirs: string[] = [];
  for (const d of loc.dirs) {
    try {
      await fs.lstat(d);
    } catch (e) {
      if (!isMissing(e)) throw new ToolConfigError("TOOL_CONFIG_REJECTED", "tool config 디렉터리를 확인하지 못했습니다");
      await fs.mkdir(d, 0o700);
      createdDirs.push(d);
    }
  }
  await checkLinks(loc, fs);
  const temp = path.join(path.dirname(loc.file), ".config.toml.openhub-" + randomBytes(6).toString("hex") + ".tmp");
  try {
    await fs.writeFile(temp, Buffer.from(content, "utf8"), 0o600);
    if (POSIX) await fs.chmod(temp, 0o600);
    await fs.rename(temp, loc.file);
  } catch {
    await fs.rm(temp).catch(() => undefined);
    await removeCreated(createdDirs, fs);
    throw new ToolConfigError("TOOL_CONFIG_WRITE_FAILED", "tool config를 쓰지 못했습니다(원본은 그대로입니다)");
  }
  const after = await inspectToolConfig(loc, fs);
  if (after.state !== "present" || after.digest !== digest) {
    if (original === null) await fs.rm(loc.file).catch(() => undefined);
    else await restoreBytes(loc, original, fs).catch(() => undefined);
    await removeCreated(createdDirs, fs);
    throw new ToolConfigError("TOOL_CONFIG_WRITE_FAILED", "쓴 tool config가 승인한 내용과 다릅니다");
  }
  return original === null ? { kind: "created", createdDirs, digest } : { kind: "replaced", original, digest };
}

async function removeCreated(dirs: readonly string[], fs: ToolConfigFs): Promise<void> {
  for (const d of [...dirs].reverse()) await fs.rmdir(d).catch(() => undefined);
}

/**
 * 보상: 이번에 만든 파일·디렉터리는 지우고, 바꾼 파일은 원래 byte로 되돌린다.
 * 지금 파일이 이번에 쓴 내용과 다르면(다른 프로세스가 바꿨으면) 덮어쓰지 않고 TOOL_CONFIG_RESTORE_CONFLICT.
 */
export async function restoreToolConfig(loc: ToolConfigLocation, undo: ToolConfigUndo, fs: ToolConfigFs = nodeToolConfigFs): Promise<void> {
  if (undo.kind === "unchanged") return;
  const now = await inspectToolConfig(loc, fs);
  if (now.state !== "present" || now.digest !== undo.digest) {
    throw new ToolConfigError("TOOL_CONFIG_RESTORE_CONFLICT", "복구하려는 tool config가 이번 실행 뒤 다른 곳에서 바뀌어 덮어쓰지 않았습니다");
  }
  if (undo.kind === "created") {
    await fs.rm(loc.file);
    await removeCreated(undo.createdDirs, fs);
    return;
  }
  await restoreBytes(loc, undo.original, fs);
}

async function restoreBytes(loc: ToolConfigLocation, original: Buffer, fs: ToolConfigFs): Promise<void> {
  const temp = path.join(path.dirname(loc.file), ".config.toml.openhub-" + randomBytes(6).toString("hex") + ".tmp");
  await fs.writeFile(temp, original, 0o600);
  await fs.rename(temp, loc.file);
}

// ---------------------------------------------------------------- placeholder

/**
 * 직접 실행(shell 없음) 인자로 넣을 수 있는 절대 경로인가. tool config Tool은 Windows에서도 cmd 래퍼를 쓰지 않으므로
 * 공백·괄호·&·%·한글 등은 그대로 전달된다(재해석 없음). 따옴표·제어 문자·상위 경로·상대 경로·UNC는 거부한다.
 */
export function isDirectExecPath(file: string, _platform: "windows" | "macos" | "linux"): boolean {
  if (/["\u0000-\u001f\u007f]/u.test(file) || file.split(/[\\/]/u).includes("..")) return false;
  // 경로 자체의 형식으로 판단한다(드라이브 문자 절대 경로 또는 POSIX 절대 경로). UNC·상대 경로는 거부한다.
  if (/^[A-Za-z]:\\/u.test(file)) return !/[*?<>|]/u.test(file) && !file.slice(2).includes(":");
  return file.startsWith("/") && !file.startsWith("//");
}

/**
 * args의 {toolConfig}를 실제 경로로 바꾼다. 직접 실행에 넣을 수 없는 경로면 manual-setup-required(자동으로 쓰지 않는다).
 */
export function substituteToolConfig(args: readonly string[], file: string, platform: "windows" | "macos" | "linux"): { ok: true; args: string[] } | { ok: false; code: "MANUAL_SETUP_REQUIRED"; message: string } {
  if (!isDirectExecPath(file, platform)) {
    return { ok: false, code: "MANUAL_SETUP_REQUIRED", message: "tool config 경로를 Client 설정에 안전하게 넣을 수 없어(따옴표·제어 문자·상대 경로 등) 자동으로 쓰지 않습니다" };
  }
  return { ok: true, args: args.map((a) => (a === TOOL_CONFIG_PLACEHOLDER ? file : a)) };
}


// ---------------------------------------------------------------- Windows Client 직접 실행(node.exe + npx-cli.js)

export interface ClientLauncher {
  node: string;
  npxCli: string;
}

export interface LauncherCheckFs {
  lstat(p: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean; isFile(): boolean }>;
  readFile(p: string): Promise<Buffer>;
}

export const nodeLauncherCheckFs: LauncherCheckFs = { lstat: (p) => nodeFs.lstat(p), readFile: (p) => nodeFs.readFile(p) };

/**
 * Client 설정에 쓸 실행 경로를 검증한다(아무것도 실행하지 않는다).
 * - node.exe와 같은 디렉터리의 node_modules/npm/bin/npx-cli.js만 허용(probe와 같은 규칙), npm/package.json의 name이 "npm".
 * - 드라이브 루트 아래 모든 경로 단계가 symlink·junction이 아니고, 두 파일이 실제 파일이다.
 * - 직접 실행 인자로 넣을 수 있는 절대 경로다(공백·괄호·&·한글 허용, 따옴표·제어 문자 거부).
 */
export async function verifyClientLauncher(launcher: ClientLauncher, fs: LauncherCheckFs = nodeLauncherCheckFs): Promise<{ ok: true } | { ok: false; reason: string }> {
  const w = path.win32;
  if (!isDirectExecPath(launcher.node, "windows") || !isDirectExecPath(launcher.npxCli, "windows")) return { ok: false, reason: "실행 경로를 Client 설정에 안전하게 넣을 수 없습니다" };
  if (w.basename(launcher.node).toLowerCase() !== "node.exe") return { ok: false, reason: "node.exe가 아닙니다" };
  const dir = w.dirname(launcher.node);
  if (w.normalize(launcher.npxCli).toLowerCase() !== w.join(dir, "node_modules", "npm", "bin", "npx-cli.js").toLowerCase()) return { ok: false, reason: "npx-cli.js가 node.exe와 같은 설치의 npm이 아닙니다" };
  const parts = w.normalize(launcher.npxCli).split("\\");
  for (let i = 2; i <= parts.length; i++) {
    const p = parts.slice(0, i).join("\\");
    try {
      const st = await fs.lstat(p);
      if (st.isSymbolicLink()) return { ok: false, reason: "실행 경로에 symlink·junction이 있습니다" };
      if (i === parts.length ? !st.isFile() : !st.isDirectory()) return { ok: false, reason: "실행 경로의 종류가 예상과 다릅니다" };
    } catch {
      return { ok: false, reason: "실행 경로를 확인하지 못했습니다" };
    }
  }
  try {
    const st = await fs.lstat(launcher.node);
    if (st.isSymbolicLink() || !st.isFile()) return { ok: false, reason: "node.exe가 일반 파일이 아닙니다" };
    const pkg = JSON.parse((await fs.readFile(w.join(dir, "node_modules", "npm", "package.json"))).toString("utf8")) as { name?: unknown };
    if (pkg.name !== "npm") return { ok: false, reason: "npx-cli.js가 npm 패키지에 속하지 않습니다" };
  } catch {
    return { ok: false, reason: "node.exe·npm을 확인하지 못했습니다" };
  }
  return { ok: true };
}

/** Client 항목(placeholder 형태) → 실제로 쓸 값. command "node"는 검증된 node.exe, {npxCli}·{toolConfig}는 각 절대 경로. */
export function materializeClientArgs(
  spec: { command: string; args: readonly string[] },
  ctx: { platform: "windows" | "macos" | "linux"; toolConfigFile?: string; launcher?: ClientLauncher | null },
): { ok: true; command: string; args: string[] } | { ok: false; code: "MANUAL_SETUP_REQUIRED"; message: string } {
  const usesConfig = spec.args.includes(TOOL_CONFIG_PLACEHOLDER);
  const usesNode = spec.command === "node";
  if (!usesConfig && !usesNode) return { ok: true, command: spec.command, args: [...spec.args] };
  let args = [...spec.args];
  if (usesConfig) {
    if (ctx.toolConfigFile === undefined) return { ok: false, code: "MANUAL_SETUP_REQUIRED", message: "tool config 위치를 정하지 못했습니다" };
    const sub = substituteToolConfig(args, ctx.toolConfigFile, ctx.platform);
    if (!sub.ok) return sub;
    args = sub.args;
  }
  if (!usesNode) return { ok: true, command: spec.command, args };
  if (ctx.platform !== "windows" || ctx.launcher === undefined || ctx.launcher === null || args[0] !== NPX_CLI_PLACEHOLDER) {
    return { ok: false, code: "MANUAL_SETUP_REQUIRED", message: "검증된 Node.js 실행 경로가 없어 Client 설정을 자동으로 쓰지 않습니다" };
  }
  return { ok: true, command: ctx.launcher.node, args: [ctx.launcher.npxCli, ...args.slice(1)] };
}


// ---------------------------------------------------------------- Client 항목 ↔ Plan 형태

const OPENHUB_TOOL_CONFIG_SEGMENT = /[\\/]\.openhub[\\/]tool-config[\\/]/u;

/**
 * Client 설정에서 다시 읽은 항목을 Plan 형태로 되돌린다(Version State·drift·repair 판정용, 쓰지 않는다).
 * - "--config" 바로 뒤의 OpenHub 관리 경로(…/.openhub/tool-config/…/config.toml) → {toolConfig}
 * - command가 node.exe이고 첫 인자가 npx-cli.js → command "node", 첫 인자 {npxCli}
 * 그 밖의 값은 그대로 둔다(그래서 다른 내용이면 비교에서 다르게 나온다).
 */
export function planFormOfEntry<T extends { command: string; args: readonly string[] }>(entry: T): T {
  const args = entry.args.map((a, i) => (entry.args[i - 1] === "--config" && OPENHUB_TOOL_CONFIG_SEGMENT.test(a) && /config\.toml$/u.test(a) ? TOOL_CONFIG_PLACEHOLDER : a));
  if (/(^|[\\/])node\.exe$/iu.test(entry.command) && /(^|[\\/])npx-cli\.js$/iu.test(args[0] ?? "")) {
    return { ...entry, command: "node", args: [NPX_CLI_PLACEHOLDER, ...args.slice(1)] };
  }
  return { ...entry, args };
}



