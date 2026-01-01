import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { nodeConfigFs, type ConfigFs } from "../installer/config-writer";
import { LIFECYCLE_STATE_SCHEMA_VERSION, emptyLifecycleState, lifecycleStateFileSchema, projectKeyFromRealpath, serializeLifecycleState, type LifecycleStateFile } from "./state";

/**
 * Version State 저장소(TASK-037, D-017). ~/.openhub/state/lifecycle.json, 직전 정상 파일은 lifecycle.json.bak(1세대).
 * - 쓰기: 같은 디렉터리 임시 파일 → rename. 쓰기 직전 현재 파일 digest가 읽을 때와 다르면 STATE_CONFLICT.
 * - 읽기 실패: 해석 실패·schema 위반·unknown field → STATE_CORRUPT, schemaVersion ≠ 1 → STATE_VERSION_UNSUPPORTED. 자동으로 덮어쓰지 않는다.
 * - 저장소 경로가 home 밖을 가리키는 symlink·junction이면 STATE_PATH_ESCAPE.
 */

export const LIFECYCLE_STATE_LOGICAL_PATH = "~/.openhub/state/lifecycle.json";
const STATE_SEGMENTS = [".openhub", "state"] as const;
const STATE_FILE = "lifecycle.json";
const BACKUP_FILE = "lifecycle.json.bak";

export type StateErrorCode = "STATE_CORRUPT" | "STATE_VERSION_UNSUPPORTED" | "STATE_CONFLICT" | "STATE_PATH_ESCAPE" | "STATE_INVALID" | "STATE_WRITE_FAILED";

export interface StateStoreOptions {
  homeDir: string;
  fs?: ConfigFs;
}

export type StateReadResult = { ok: true; state: LifecycleStateFile; digest: string | null } | { ok: false; code: StateErrorCode; message: string };
export type StateCommitResult = { ok: true; digest: string } | { ok: false; code: StateErrorCode; message: string };

/** 파일 byte의 sha256. 파일이 없으면 null. */
export function stateBytesDigest(bytes: Buffer | null): string | null {
  return bytes === null ? null : "sha256:" + createHash("sha256").update(bytes).digest("hex");
}

const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
const isMissing = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";

interface StatePaths {
  home: string;
  dir: string;
  file: string;
  backup: string;
}

function statePaths(homeDir: string): StatePaths {
  const home = path.resolve(homeDir);
  const dir = path.join(home, ...STATE_SEGMENTS);
  return { home, dir, file: path.join(dir, STATE_FILE), backup: path.join(dir, BACKUP_FILE) };
}

/** 저장소 파일·상위 디렉터리 중 존재하는 것이 home 밖으로 해석되면 거부한다. */
async function checkContainment(p: StatePaths, fs: ConfigFs): Promise<string | undefined> {
  let realHome: string;
  try {
    realHome = await fs.realpath(p.home);
  } catch {
    return "home 디렉터리를 확인하지 못했습니다";
  }
  for (const target of [p.file, p.dir, path.dirname(p.dir)]) {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (e) {
      if (isMissing(e)) continue;
      return "상태 저장소 경로를 확인하지 못했습니다";
    }
    const real = await fs.realpath(target).catch(() => "");
    if (real === "" || !inside(real, realHome)) return "상태 저장소가 home 밖을 가리킵니다";
    if (target === p.file && stat.isSymbolicLink()) return "상태 파일이 symlink입니다";
  }
  return undefined;
}

async function readOptional(fs: ConfigFs, file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
}

/** bytes → state. 실패는 STATE_CORRUPT 또는 STATE_VERSION_UNSUPPORTED. */
export function parseLifecycleState(bytes: Buffer): StateReadResult {
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, code: "STATE_CORRUPT", message: "상태 파일을 해석하지 못했습니다(JSON 오류). 자동으로 덮어쓰지 않습니다" };
  }
  const version = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>)["schemaVersion"] : undefined;
  if (typeof version === "number" && version !== LIFECYCLE_STATE_SCHEMA_VERSION) {
    return { ok: false, code: "STATE_VERSION_UNSUPPORTED", message: "지원하지 않는 상태 파일 schemaVersion입니다(" + String(version) + ")" };
  }
  const parsed = lifecycleStateFileSchema.safeParse(doc);
  if (!parsed.success) return { ok: false, code: "STATE_CORRUPT", message: "상태 파일이 schema를 통과하지 못했습니다. 자동으로 덮어쓰지 않습니다" };
  return { ok: true, state: parsed.data, digest: stateBytesDigest(bytes) };
}

/** 저장소를 읽는다. 파일이 없으면 빈 state와 digest null. */
export async function readLifecycleState(options: StateStoreOptions): Promise<StateReadResult> {
  const fs = options.fs ?? nodeConfigFs;
  const p = statePaths(options.homeDir);
  const escape = await checkContainment(p, fs);
  if (escape !== undefined) return { ok: false, code: "STATE_PATH_ESCAPE", message: escape };
  let bytes: Buffer | null;
  try {
    bytes = await readOptional(fs, p.file);
  } catch {
    return { ok: false, code: "STATE_CORRUPT", message: "상태 파일을 읽지 못했습니다" };
  }
  if (bytes === null) return { ok: true, state: emptyLifecycleState(), digest: null };
  return parseLifecycleState(bytes);
}

async function atomicWrite(fs: ConfigFs, file: string, data: Buffer): Promise<void> {
  const temp = path.join(path.dirname(file), "." + path.basename(file) + ".openhub-" + randomBytes(6).toString("hex") + ".tmp");
  try {
    await fs.writeFile(temp, data);
    await fs.rename(temp, file);
  } catch (e) {
    await fs.rm(temp).catch(() => undefined);
    throw e;
  }
}

async function ensureDir(fs: ConfigFs, p: StatePaths): Promise<void> {
  for (const d of [path.dirname(p.dir), p.dir]) {
    try {
      await fs.lstat(d);
    } catch (e) {
      if (!isMissing(e)) throw e;
      await fs.mkdir(d);
    }
  }
}

/**
 * 새 state를 쓴다. expectedDigest는 읽을 때의 파일 digest(없던 파일이면 null)다.
 * 현재 파일이 그와 다르면 STATE_CONFLICT로 쓰지 않는다. 쓰기 전 현재 정상 파일을 .bak으로 남긴다.
 */
export async function commitLifecycleState(next: LifecycleStateFile, expectedDigest: string | null, options: StateStoreOptions): Promise<StateCommitResult> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(serializeLifecycleState(next), "utf8");
  } catch {
    return { ok: false, code: "STATE_INVALID", message: "Version State가 schema를 통과하지 못했습니다(secret·절대 경로 포함 여부 확인)" };
  }
  const fs = options.fs ?? nodeConfigFs;
  const p = statePaths(options.homeDir);
  const escape = await checkContainment(p, fs);
  if (escape !== undefined) return { ok: false, code: "STATE_PATH_ESCAPE", message: escape };
  let current: Buffer | null;
  try {
    current = await readOptional(fs, p.file);
  } catch {
    return { ok: false, code: "STATE_WRITE_FAILED", message: "상태 파일을 읽지 못했습니다" };
  }
  if (stateBytesDigest(current) !== expectedDigest) {
    return { ok: false, code: "STATE_CONFLICT", message: "읽은 뒤 다른 OpenHub 실행이 상태 파일을 바꿨습니다. 다시 시도하세요" };
  }
  try {
    await ensureDir(fs, p);
    if (current !== null) await atomicWrite(fs, p.backup, current);
    await atomicWrite(fs, p.file, bytes);
  } catch {
    return { ok: false, code: "STATE_WRITE_FAILED", message: "상태 파일을 쓰지 못했습니다(원본은 그대로입니다)" };
  }
  return { ok: true, digest: stateBytesDigest(bytes) as string };
}

/** projectKey = sha256(realpath(projectRoot)) 앞 16 hex. */
export async function projectKeyFor(projectRoot: string, fs: ConfigFs = nodeConfigFs): Promise<string> {
  return projectKeyFromRealpath(await fs.realpath(path.resolve(projectRoot)));
}
