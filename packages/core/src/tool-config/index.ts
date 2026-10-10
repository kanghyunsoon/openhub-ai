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

export const TOOL_CONFIG_ALLOWLIST: readonly string[] = Object.freeze(["kubernetes-mcp-server"]);
export const TOOL_CONFIG_PLACEHOLDER = "{toolConfig}";
export const TOOL_CONFIG_MAX_BYTES = 4096;
export type ToolConfigScope = "user" | "project";

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
  if (!TOOL_CONFIG_ALLOWLIST.includes(manifest.name)) {
    out.push({ path: "toolConfig", message: "toolConfig는 허용 목록의 Tool만 쓸 수 있습니다(" + TOOL_CONFIG_ALLOWLIST.join(", ") + ")" });
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
  return out;
}

// ---------------------------------------------------------------- 위치

export interface ToolConfigLocation {
  fileId: string;
  scope: ToolConfigScope;
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
  return { fileId: toolConfigFileId(input.scope, input.toolId), scope: input.scope, root, dirs, file };
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
    readonly code: "TOOL_CONFIG_REJECTED" | "TOOL_CONFIG_STALE" | "TOOL_CONFIG_WRITE_FAILED",
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

/** 되돌리기 정보(결과에 남기지 않는다). */
export type ToolConfigUndo = { kind: "created"; createdDirs: string[] } | { kind: "replaced"; original: Buffer } | { kind: "unchanged" };

const POSIX = process.platform !== "win32";

/**
 * 승인된 내용을 쓴다. 현재 상태가 승인 때 기대한 상태와 다르면 TOOL_CONFIG_STALE(쓰기 0).
 * 쓴 뒤 다시 읽어 digest를 확인한다.
 */
export async function writeToolConfig(loc: ToolConfigLocation, content: string, expected: ToolConfigState, fs: ToolConfigFs = nodeToolConfigFs): Promise<ToolConfigUndo> {
  const current = await inspectToolConfig(loc, fs);
  const same = current.state === expected.state && (current.state === "absent" || (expected.state === "present" && current.digest === expected.digest));
  if (!same) throw new ToolConfigError("TOOL_CONFIG_STALE", "승인 뒤 tool config가 바뀌었습니다. 다시 계획하고 승인하세요");
  const digest = toolConfigDigest(content);
  if (current.state === "present" && current.digest === digest) return { kind: "unchanged" };
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
    await restoreToolConfig(loc, original === null ? { kind: "created", createdDirs } : { kind: "replaced", original }, fs);
    throw new ToolConfigError("TOOL_CONFIG_WRITE_FAILED", "쓴 tool config가 승인한 내용과 다릅니다");
  }
  return original === null ? { kind: "created", createdDirs } : { kind: "replaced", original };
}

async function removeCreated(dirs: readonly string[], fs: ToolConfigFs): Promise<void> {
  for (const d of [...dirs].reverse()) await fs.rmdir(d).catch(() => undefined);
}

/** 보상: 이번에 만든 파일·디렉터리는 지우고, 바꾼 파일은 원래 byte로 되돌린다. */
export async function restoreToolConfig(loc: ToolConfigLocation, undo: ToolConfigUndo, fs: ToolConfigFs = nodeToolConfigFs): Promise<void> {
  if (undo.kind === "unchanged") return;
  await checkLinks(loc, fs);
  if (undo.kind === "created") {
    await fs.rm(loc.file);
    await removeCreated(undo.createdDirs, fs);
    return;
  }
  const temp = path.join(path.dirname(loc.file), ".config.toml.openhub-" + randomBytes(6).toString("hex") + ".tmp");
  await fs.writeFile(temp, undo.original, 0o600);
  await fs.rename(temp, loc.file);
}

// ---------------------------------------------------------------- placeholder

/** Client 설정·Health argv에 넣을 수 있는 경로 문자(cmd /d /c npx 래퍼에서도 다시 해석되지 않는 문자). */
const SAFE_PATH = { windows: /^[A-Za-z]:\\[A-Za-z0-9._\\-]+$/u, posix: /^\/[A-Za-z0-9._/-]+$/u };

/**
 * args의 {toolConfig}를 실제 경로로 바꾼다. 경로에 공백·cmd 특수문자 등 안전하게 표현할 수 없는 문자가 있으면
 * manual-setup-required(자동으로 쓰지 않는다).
 */
export function substituteToolConfig(args: readonly string[], file: string, platform: "windows" | "macos" | "linux"): { ok: true; args: string[] } | { ok: false; code: "MANUAL_SETUP_REQUIRED"; message: string } {
  const safe = platform === "windows" ? SAFE_PATH.windows : SAFE_PATH.posix;
  if (!safe.test(file) || file.split(/[\\/]/u).includes("..")) {
    return { ok: false, code: "MANUAL_SETUP_REQUIRED", message: "tool config 경로에 Client 설정에서 안전하게 표현할 수 없는 문자(공백·특수문자)가 있어 자동으로 쓰지 않습니다" };
  }
  return { ok: true, args: args.map((a) => (a === TOOL_CONFIG_PLACEHOLDER ? file : a)) };
}

