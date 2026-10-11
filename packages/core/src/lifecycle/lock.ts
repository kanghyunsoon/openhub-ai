import { randomBytes } from "node:crypto";
import { link, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import os from "node:os";

/**
 * (v0.2.1 B) 소유권 기반 파일 잠금. ~/.openhub/state 아래 잠금 파일을 배타적으로 게시한 쪽만 소유자다.
 * - 잠금 파일: { token, pid, host, purpose, startedAt }. token은 생성할 때마다 새로 만든 무작위 값이다.
 * - 게시: 내용을 모두 쓴 임시 파일("<잠금>.<pid>.<token>.tmp")을 hard link로 잠금 경로에 건다. link는 대상이 있으면 EEXIST로 실패하고
 *   대상 symlink를 따라가지 않으므로 "있으면 실패"가 원자적이다. 그래서 잠금 경로에는 내용이 완전한 파일만 나타나고, 생성과 쓰기 사이에
 *   멈춘 살아 있는 소유자의 빈 잠금이 회수되는 경우가 없다(open "wx" 뒤 writeFile 방식의 빈 파일 구간을 없앴다).
 *   hard link를 지원하지 않는 파일 시스템이면 잠금을 만들지 못한 것으로 보고 실행하지 않는다(fail closed).
 * - 해제: 파일의 token이 내 token일 때만 지운다(남의 잠금을 지우지 않는다).
 *   살아 있는 소유자의 잠금은 다른 누구도 지우거나 바꾸지 않으므로(회수는 소유자가 죽었을 때만) 읽은 뒤 지우는 사이에 바뀌지 않는다.
 * - 회수: 같은 host에서 pid가 살아 있지 않을 때만 버려진 잠금이다. 시간이 오래 지났다는 이유만으로는 회수하지 않는다
 *   (일시 정지·느린 Health 중인 살아 있는 소유자를 보호한다). 다른 host의 잠금은 확인할 수 없으므로 회수하지 않는다.
 *   내용이 잠금 형식이 아닌 파일(이 방식으로는 생기지 않는다: 손상·이전 빌드가 남긴 빈 파일)은 LOCK_INCOMPLETE_MS가 지나야 버려진 것으로 본다.
 * - 회수자끼리는 "<잠금>.reclaim" 보조 잠금으로 직렬화하고, 보조 잠금 안에서 다시 읽은 token이 처음 관찰한 버려진 잠금과
 *   같을 때만 지운다. 그 사이 다른 소유자가 만든 새 잠금은 token이 달라 지우지 않는다.
 * - 잠금 경로가 일반 파일이 아니면(symlink·junction·디렉터리) LockPathError다. open "wx"는 기존 symlink를 따라가지 않는다.
 */

export interface LockRecord {
  token: string;
  pid: number;
  host: string;
  purpose: string;
  startedAt: string;
}

export interface LockHooks {
  /** pid 생존 확인(테스트 주입용). 기본은 process.kill(pid, 0). */
  isAlive?: (pid: number) => boolean;
  /** 임시 파일을 쓴 뒤 잠금 경로에 게시하기 직전(테스트에서 "생성과 게시 사이 정지"를 만든다). */
  beforePublish?: () => Promise<void>;
}

export const LOCK_INCOMPLETE_MS = 30_000;
const RECLAIM_GUARD_STALE_MS = 30_000;

export class LockPathError extends Error {
  readonly code = "LOCK_PATH_INVALID";
}

const errorCode = (e: unknown) => (typeof e === "object" && e !== null ? (e as { code?: unknown }).code : undefined);

/** 같은 host의 pid가 살아 있는가. 권한이 없어 확인할 수 없는 경우(EPERM)도 살아 있는 것으로 본다. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return errorCode(e) === "EPERM";
  }
}

interface Observed {
  record: LockRecord | null;
  mtimeMs: number;
  /** 파일은 있는데 읽지 못했다(Windows 삭제 대기 EPERM·백신 EBUSY 등). 내용을 모르므로 버려진 잠금으로 보지 않는다. */
  unreadable?: boolean;
}

const isRecord = (v: unknown): v is LockRecord => {
  if (typeof v !== "object" || v === null) return false;
  const r = v as Record<string, unknown>;
  return typeof r["token"] === "string" && /^[0-9a-f]{32}$/u.test(r["token"]) && Number.isInteger(r["pid"]) && typeof r["host"] === "string" && typeof r["purpose"] === "string" && typeof r["startedAt"] === "string";
};

/**
 * 잠금 파일을 읽는다. 없으면(읽는 사이 지워진 경우 포함) null. 일반 파일이 아니면 LockPathError.
 * 읽기 자체가 실패하면 unreadable(회수 대상 아님), 읽었지만 잠금 형식이 아니면 record null.
 */
export async function readLock(file: string): Promise<Observed | null> {
  let info;
  try {
    info = await lstat(file);
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    throw e;
  }
  if (!info.isFile()) throw new LockPathError("잠금 경로가 일반 파일이 아닙니다(symlink·junction·디렉터리)");
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (e) {
    if (errorCode(e) === "ENOENT") return null;
    return { record: null, mtimeMs: info.mtimeMs, unreadable: true };
  }
  let record: LockRecord | null = null;
  try {
    const doc: unknown = JSON.parse(text);
    if (isRecord(doc)) record = doc;
  } catch {
    record = null;
  }
  return { record, mtimeMs: info.mtimeMs };
}

/** 배타 게시. 내용을 모두 쓴 임시 파일을 hard link로 건다. 이미 있으면 null. */
async function create(file: string, purpose: string, hooks: LockHooks = {}): Promise<string | null> {
  const token = randomBytes(16).toString("hex");
  const record: LockRecord = { token, pid: process.pid, host: os.hostname(), purpose, startedAt: new Date().toISOString() };
  const temp = file + "." + String(process.pid) + "." + token + ".tmp";
  await writeFile(temp, JSON.stringify(record) + "\n", { flag: "wx", mode: 0o600 });
  try {
    if (hooks.beforePublish !== undefined) await hooks.beforePublish();
    try {
      await link(temp, file);
    } catch (e) {
      if (errorCode(e) === "EEXIST") return null;
      throw e;
    }
  } finally {
    await unlink(temp).catch(() => undefined);
  }
  return token;
}

/** 내 token일 때만 지운다. */
async function release(file: string, token: string): Promise<void> {
  const now = await readLock(file).catch(() => null);
  if (now?.record?.token === token) await unlink(file).catch(() => undefined);
}

/** 버려진 잠금인가: 같은 host에서 pid가 죽었거나, 잠금 형식이 아닌 내용으로 LOCK_INCOMPLETE_MS가 지났다. 읽지 못한 잠금은 아니다. */
export function isAbandoned(observed: Observed, hooks: LockHooks = {}, now = Date.now()): boolean {
  if (observed.unreadable === true) return false;
  if (observed.record === null) return now - observed.mtimeMs > LOCK_INCOMPLETE_MS;
  if (observed.record.host !== os.hostname()) return false;
  if (observed.record.pid === process.pid) return false;
  return !(hooks.isAlive ?? processAlive)(observed.record.pid);
}

const sameLock = (a: Observed, b: Observed) =>
  a.unreadable !== true && b.unreadable !== true && (a.record !== null && b.record !== null ? a.record.token === b.record.token : a.record === null && b.record === null && a.mtimeMs === b.mtimeMs);

/**
 * 관찰한 버려진 잠금을 회수한다. 보조 잠금(.reclaim)을 얻은 회수자만, 다시 읽은 잠금이 관찰한 것과 같을 때만 지운다.
 * 회수하지 못하면(다른 회수자 진행 중 등) 아무것도 지우지 않는다.
 */
export async function reclaimLock(file: string, observed: Observed, hooks: LockHooks = {}): Promise<boolean> {
  const guard = file + ".reclaim";
  const token = await create(guard, "reclaim");
  if (token === null) {
    // 회수 중 종료되어 남은 보조 잠금: 소유자가 죽었고 충분히 오래됐을 때만 지운다(보조 잠금은 수 ms만 잡는다).
    const g = await readLock(guard);
    if (g !== null && isAbandoned(g, hooks) && Date.now() - g.mtimeMs > RECLAIM_GUARD_STALE_MS) {
      const again = await readLock(guard);
      if (again !== null && sameLock(again, g)) await unlink(guard).catch(() => undefined);
    }
    return false;
  }
  try {
    const current = await readLock(file);
    if (current === null || !sameLock(current, observed)) return false;
    await unlink(file);
    return true;
  } finally {
    await release(guard, token);
  }
}

export type LockAcquire = { ok: true; release: () => Promise<void> } | { ok: false; holder: LockRecord | null };

/**
 * 잠금을 얻는다. 살아 있는 소유자가 있으면 waitMs까지 기다리고(0이면 바로) 실패를 돌려준다(holder 정보 포함).
 * 버려진 잠금은 회수한 뒤 다시 시도한다.
 */
export async function acquireLock(file: string, purpose: string, options: { waitMs: number } & LockHooks): Promise<LockAcquire> {
  const deadline = Date.now() + options.waitMs;
  let reclaims = 0;
  for (;;) {
    const token = await create(file, purpose, options);
    if (token !== null) return { ok: true, release: () => release(file, token) };
    const holder = await readLock(file);
    if (holder === null) continue; // 그 사이 해제됐다
    if (isAbandoned(holder, options) && reclaims < 5) {
      reclaims += 1;
      await reclaimLock(file, holder, options);
      continue;
    }
    if (Date.now() >= deadline) return { ok: false, holder: holder.record };
    await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 30)));
  }
}
