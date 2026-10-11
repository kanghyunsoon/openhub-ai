import { createHash, randomBytes } from "node:crypto";
import { mkdir, rmdir } from "node:fs/promises";
import path from "node:path";
import { nodeConfigFs, type ConfigFs } from "../installer/config-writer";
import { LockPathError, acquireLock, type LockHooks } from "./lock";
import { LIFECYCLE_STATE_SCHEMA_VERSION, emptyLifecycleState, lifecycleStateFileSchema, projectKeyFromRealpath, serializeLifecycleState, type LifecycleStateFile } from "./state";

/**
 * Version State 저장소(TASK-037, D-017). ~/.openhub/state/lifecycle.json, 직전 정상 파일은 lifecycle.json.bak(1세대).
 * - 쓰기: 같은 디렉터리 임시 파일 → rename. 쓰기 직전 현재 파일 digest가 읽을 때와 다르면 STATE_CONFLICT.
 * - (v0.2.1) digest 확인부터 rename까지는 lifecycle.json.lock(소유권 잠금, lock.ts)으로 프로세스 간 직렬화한다. 그래서 같은 digest로
 *   동시에 커밋하면 정확히 하나만 성공하고 나머지는 STATE_CONFLICT다(이전에는 둘 다 ok인데 하나가 사라질 수 있었다).
 * - (v0.2.1) 설정·Version State를 바꾸는 작업 전체(install·update·rollback·repair·health 기록·adopt)는 operation.lock으로
 *   한 번에 하나만 실행한다(withOperationLock). 이미 다른 작업이 진행 중이면 기다리지 않고 OPERATION_IN_PROGRESS다.
 * - 읽기 실패: 해석 실패·schema 위반·unknown field → STATE_CORRUPT, schemaVersion ≠ 1 → STATE_VERSION_UNSUPPORTED. 자동으로 덮어쓰지 않는다.
 * - 저장소 경로가 home 밖을 가리키는 symlink·junction이면 STATE_PATH_ESCAPE.
 */

export const LIFECYCLE_STATE_LOGICAL_PATH = "~/.openhub/state/lifecycle.json";
const STATE_SEGMENTS = [".openhub", "state"] as const;
const STATE_FILE = "lifecycle.json";
const BACKUP_FILE = "lifecycle.json.bak";
const LOCK_FILE = "lifecycle.json.lock";
const OPERATION_LOCK_FILE = "operation.lock";
/** 커밋 잠금을 기다리는 최대 시간. 커밋 구간은 파일 2개 쓰기뿐이라 보통 수 ms다. */
export const STATE_LOCK_WAIT_MS = 3_000;

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

/** (v0.2.1 P0-4) 커밋 구간 잠금. 살아 있는 소유자가 있으면 STATE_LOCK_WAIT_MS까지 기다린 뒤 busy()(쓰기 0). */
async function withCommitLock<T>(dir: string, fn: () => Promise<T>, busy: () => T, hooks: LockHooks = {}): Promise<T> {
  const lock = await acquireLock(path.join(dir, LOCK_FILE), "state-commit", { waitMs: STATE_LOCK_WAIT_MS, ...hooks });
  if (!lock.ok) return busy();
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

export type OperationLockCode = "OPERATION_IN_PROGRESS" | "OPERATION_LOCK_FAILED" | "STATE_PATH_ESCAPE";
export type OperationLockResult<T> = { ok: true; value: T } | { ok: false; code: OperationLockCode; message: string };

/**
 * (v0.2.1 B) 설정·Version State를 바꾸는 작업 하나를 operation.lock 안에서 실행한다(CLI·Desktop·같은 프로세스의 다른 작업 공통).
 * 다른 작업이 진행 중이면 fn을 실행하지 않고 OPERATION_IN_PROGRESS를 돌려준다(쓰기 0, 기다리지 않는다).
 * 잠금 디렉터리(~/.openhub/state)는 저장소와 같은 경로 검사를 거친다. 메시지에 경로를 넣지 않는다.
 */
export async function withOperationLock<T>(options: StateStoreOptions & { purpose: string } & LockHooks, fn: () => Promise<T>): Promise<OperationLockResult<T>> {
  const fs = options.fs ?? nodeConfigFs;
  const p = statePaths(options.homeDir);
  const escape = await checkContainment(p, fs);
  if (escape !== undefined) return { ok: false, code: "STATE_PATH_ESCAPE", message: escape };
  let lock;
  // 잠금 때문에 새로 만든 디렉터리(~/.openhub, ~/.openhub/state)는 작업 뒤 비어 있으면 지운다(잠금만으로 home에 흔적을 남기지 않는다).
  const created: string[] = [];
  try {
    // 잠금 디렉터리는 기록용 ConfigFs가 아니라 직접 만든다(잠금은 사용자 설정·Version State 쓰기가 아니다).
    for (const d of [path.dirname(p.dir), p.dir]) {
      try {
        await mkdir(d);
        created.push(d);
      } catch (e) {
        if (!(typeof e === "object" && e !== null && (e as { code?: unknown }).code === "EEXIST")) throw e;
      }
    }
    lock = await acquireLock(path.join(p.dir, OPERATION_LOCK_FILE), options.purpose, {
      waitMs: 0,
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
      ...(options.beforePublish === undefined ? {} : { beforePublish: options.beforePublish }),
    });
  } catch (e) {
    for (const d of created.reverse()) await rmdir(d).catch(() => undefined);
    return { ok: false, code: "OPERATION_LOCK_FAILED", message: e instanceof LockPathError ? "작업 잠금 경로가 일반 파일이 아니어서 실행하지 않았습니다" : "작업 잠금을 만들지 못해 실행하지 않았습니다" };
  }
  if (!lock.ok) {
    for (const d of created.reverse()) await rmdir(d).catch(() => undefined);
    const who = lock.holder === null ? "다른 OpenHub 작업" : "다른 OpenHub 작업(" + lock.holder.purpose + ", pid " + String(lock.holder.pid) + ")";
    return { ok: false, code: "OPERATION_IN_PROGRESS", message: who + "이 진행 중이라 실행하지 않았습니다. 아무것도 바꾸지 않았습니다. 끝난 뒤 다시 시도하세요" };
  }
  try {
    return { ok: true, value: await fn() };
  } finally {
    await lock.release();
    // rmdir은 빈 디렉터리만 지운다. 작업 중 Version State 등이 생겼으면 그대로 둔다.
    for (const d of created.reverse()) await rmdir(d).catch(() => undefined);
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
  const writeFailed: StateCommitResult = { ok: false, code: "STATE_WRITE_FAILED", message: "상태 파일을 쓰지 못했습니다(원본은 그대로입니다)" };
  try {
    await ensureDir(fs, p);
  } catch {
    return writeFailed;
  }
  try {
    return await withCommitLock<StateCommitResult>(
      p.dir,
      async () => {
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
          if (current !== null) await atomicWrite(fs, p.backup, current);
          await atomicWrite(fs, p.file, bytes);
        } catch {
          return writeFailed;
        }
        return { ok: true, digest: stateBytesDigest(bytes) as string };
      },
      () => ({ ok: false, code: "STATE_CONFLICT", message: "다른 OpenHub 실행이 Version State를 쓰는 중입니다. 잠시 뒤 다시 시도하세요" }),
    );
  } catch {
    return writeFailed;
  }
}

/** projectKey = sha256(realpath(projectRoot)) 앞 16 hex. */
export async function projectKeyFor(projectRoot: string, fs: ConfigFs = nodeConfigFs): Promise<string> {
  return projectKeyFromRealpath(await fs.realpath(path.resolve(projectRoot)));
}
