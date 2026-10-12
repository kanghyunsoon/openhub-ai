import { randomBytes } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { isOfficialServerEntry } from "../installer/config-writer";
import { CONFIG_SCOPES, INSTALL_CLIENTS, canonicalize, serverEntrySchema, sha256Digest, type InstallClient, type ServerEntry } from "../installer/plan";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";
import { PROJECT_KEY_PATTERN } from "./state";

/**
 * (v0.2.1 P0-3) Lifecycle 작업 Journal. update·rollback·repair가 Client 설정을 바꾸기 직전에 ~/.openhub/state/journal/<id>.json을
 * 원자적으로 쓰고(임시 파일 → rename, 0600), 정상 완료(Version State commit)나 보상 성공 뒤 지운다. 보상까지 실패하면 남긴다.
 * 프로세스가 강제 종료되면 Journal이 남아 다음 실행이 "중단된 작업(interrupted-update)"으로 알아본다.
 * - 기록: 작업 ID·종류·Plan digest·Version State digest·대상 EntryKey·Client·scope·projectKey·변경 전/후 항목 digest·진행 단계.
 * - 되돌리기용 변경 전 항목은 Client 공식 형식(env는 이름 참조만)이고 절대 경로·token·credential URL이 없을 때만 남긴다. 아니면 null(수동 복구).
 * - 사용자 설정 파일 전체·env 값·자격증명은 남기지 않는다. Journal 디렉터리는 home 안이어야 하고 symlink·junction이면 쓰지 않는다.
 */

export const JOURNAL_KIND = "openhub-lifecycle-journal";
export const JOURNAL_LOGICAL_DIR = "~/.openhub/state/journal";
export const JOURNAL_PHASES = ["config-applying", "health", "state-commit", "compensation-failed"] as const;
export type JournalPhase = (typeof JOURNAL_PHASES)[number];
export const JOURNAL_OPERATIONS = ["update", "rollback", "repair"] as const;

const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const text = z.string().min(1).max(400);
const stringsOf = (value: unknown): string[] =>
  typeof value === "string" ? [value] : Array.isArray(value) ? value.flatMap(stringsOf) : value !== null && typeof value === "object" ? Object.values(value).flatMap(stringsOf) : [];
const unsafe = (s: string) => containsAbsolutePath(s) || TOKEN_PATTERN.test(s) || URL_CREDENTIAL_PATTERN.test(s);

export const journalTargetSchema = z.strictObject({
  entryKey: text,
  client: z.enum(INSTALL_CLIENTS),
  scope: z.enum(CONFIG_SCOPES),
  /** 논리 경로(.mcp.json, ~/.cursor/mcp.json) */
  file: text,
  serverName: text,
  projectKey: z.string().regex(PROJECT_KEY_PATTERN).nullable(),
  beforeEntryDigest: sha256,
  afterEntryDigest: sha256,
  /** Codex: 교체 후 block digest(되돌릴 때 이 block만 바꾼다). JSON Client는 null. */
  afterTomlBlockDigest: sha256.nullable(),
  /** 되돌리기에 쓰는 변경 전 항목. 표현할 수 없으면 null. */
  before: serverEntrySchema.nullable(),
});
export type JournalTarget = z.output<typeof journalTargetSchema>;

export const journalSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal(JOURNAL_KIND),
    transactionId: z.string().regex(/^[0-9a-f]{32}$/u),
    operation: z.enum(JOURNAL_OPERATIONS),
    toolId: text,
    planDigest: sha256,
    /** 작업 시작 때 lifecycle.json digest(없던 파일이면 null). */
    stateDigest: sha256.nullable(),
    createdAt: z.iso.datetime(),
    phase: z.enum(JOURNAL_PHASES),
    /** OpenHub 관리 tool config도 바꾸는 작업(Kubernetes 등). 되돌리기는 repair로 한다. */
    toolConfig: z.boolean(),
    targets: z.array(journalTargetSchema).min(1),
  })
  .superRefine((j, ctx) => {
    if (stringsOf(j).some(unsafe)) ctx.addIssue({ code: "custom", path: [], message: "Journal에 절대 경로·token·credential URL이 있다" });
  });
export type JournalV1 = z.output<typeof journalSchema>;

export function newTransactionId(): string {
  return randomBytes(16).toString("hex");
}

export function journalDigest(journal: JournalV1): string {
  return sha256Digest(JSON.stringify(canonicalize(journal)));
}

/** 되돌리기에 남겨도 되는 변경 전 항목인가(Client 공식 형식, 값에 절대 경로·token 없음). */
export function journalBeforeValue(client: InstallClient, value: unknown): ServerEntry | null {
  const parsed = serverEntrySchema.safeParse(value);
  if (!parsed.success || !isOfficialServerEntry(client, parsed.data)) return null;
  return stringsOf(parsed.data).some(unsafe) ? null : parsed.data;
}

export class JournalError extends Error {
  readonly code = "JOURNAL_WRITE_FAILED";
}

/** 손상된 Journal 안내(경로는 논리 경로만). 계획·복구·status가 같은 문장을 쓴다. */
export const damagedJournalMessage = (count: number) =>
  "읽을 수 없는 작업 기록(Journal) " + String(count) + "개가 있어 아무것도 계획하지 않았습니다(손상되었거나 이 버전이 읽을 수 없는 형식). OpenHub는 이 파일을 지우지 않습니다. " +
  "~/.openhub/state/journal 폴더에서 해당 파일을 확인해 다른 곳에 백업한 뒤 옮기고, openhub lifecycle status로 설정을 확인한 다음 다시 시도하세요";

const isMissing = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";

/** Journal 디렉터리(없으면 만든다). home 밖·symlink·junction이면 JournalError. */
async function journalDir(homeDir: string, create: boolean): Promise<string | null> {
  const home = path.resolve(homeDir);
  const realHome = await realpath(home);
  const parts = [path.join(home, ".openhub"), path.join(home, ".openhub", "state"), path.join(home, ".openhub", "state", "journal")];
  for (const d of parts) {
    try {
      const info = await lstat(d);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new JournalError("Journal 경로가 일반 디렉터리가 아닙니다");
      const real = await realpath(d);
      const rel = path.relative(realHome, real);
      if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) throw new JournalError("Journal 경로가 home 밖을 가리킵니다");
    } catch (e) {
      if (e instanceof JournalError) throw e;
      if (!isMissing(e)) throw new JournalError("Journal 경로를 확인하지 못했습니다");
      if (!create) return null;
      await mkdir(d, { mode: 0o700 });
    }
  }
  return parts[2]!;
}

/** Journal을 쓴다(같은 id면 덮어쓴다). 임시 파일 → rename. 실패하면 JournalError. */
export async function writeJournal(homeDir: string, journal: JournalV1): Promise<void> {
  const parsed = journalSchema.parse(journal);
  let dir: string;
  try {
    dir = (await journalDir(homeDir, true))!;
  } catch (e) {
    throw e instanceof JournalError ? e : new JournalError("Journal 디렉터리를 만들지 못했습니다");
  }
  const file = path.join(dir, parsed.transactionId + ".json");
  const temp = path.join(dir, "." + parsed.transactionId + "." + randomBytes(4).toString("hex") + ".tmp");
  try {
    await writeFile(temp, JSON.stringify(canonicalize(parsed), null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temp, file);
  } catch {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new JournalError("Journal을 쓰지 못했습니다");
  }
}

/** 진행 단계를 갱신한다. 쓰지 못하면 JournalError다(조용히 성공한 것처럼 넘어가지 않는다). */
export async function setJournalPhase(homeDir: string, journal: JournalV1, phase: JournalPhase): Promise<JournalV1> {
  const next = { ...journal, phase };
  await writeJournal(homeDir, next);
  return next;
}

const ofTransaction = (transactionId: string) => (name: string) => name === transactionId + ".json" || (name.startsWith(transactionId + ".claim-") && name.endsWith(".json"));

/**
 * 이 작업의 Journal(선점 파일 포함)을 지운다. 지운 뒤 다시 확인해 하나도 남지 않았을 때만 true다.
 * 디렉터리를 읽지 못하거나 파일이 남으면 false(호출자가 정리 실패를 보고한다). Journal 디렉터리가 없으면 남은 것이 없으므로 true.
 */
export async function removeJournal(homeDir: string, transactionId: string): Promise<boolean> {
  if (!/^[0-9a-f]{32}$/u.test(transactionId)) return false;
  let dir: string | null;
  try {
    dir = await journalDir(homeDir, false);
  } catch {
    return false;
  }
  if (dir === null) return true;
  const match = ofTransaction(transactionId);
  const names = await readdir(dir).catch(() => null);
  if (names === null) return false;
  for (const name of names.filter(match)) await rm(path.join(dir, name), { force: true }).catch(() => undefined);
  const left = await readdir(dir).catch(() => null);
  return left !== null && !left.some(match);
}

const JOURNAL_FILE = /^([0-9a-f]{32})(?:\.claim-(\d{1,10})-[0-9a-f]{8})?\.json$/u;

/** 같은 host의 pid가 살아 있는가(확인 권한이 없으면 살아 있는 것으로 본다). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return typeof e === "object" && e !== null && (e as { code?: string }).code === "EPERM";
  }
}

/**
 * 살아 있는 다른 프로세스의 복구가 선점한 Journal 파일 이름인가. 강제 종료된 복구가 남긴 선점은 false다(다시 선점할 수 있다).
 * 이 프로세스의 선점도 false다: 복구 실행은 작업 잠금 안에서만 하므로 같은 프로세스에서 동시에 진행 중인 복구는 없다
 * (정리에 실패해 남은 선점 때문에 오래 실행되는 Desktop이 같은 기록을 다시 다루지 못하는 일을 막는다).
 */
export function claimedByLiveRecovery(fileName: string): boolean {
  const pid = JOURNAL_FILE.exec(fileName)?.[2];
  return pid !== undefined && Number(pid) !== process.pid && alive(Number(pid));
}

export type JournalReadResult = { ok: true; journals: JournalV1[]; unreadable: number; files: ReadonlyMap<string, string> } | { ok: false; code: "JOURNAL_PATH_ESCAPE"; message: string };

/** 남아 있는 Journal을 모두 읽는다(만든 순서). 복구가 선점한(.claim-) 파일도 포함한다. 형식이 맞지 않는 파일은 지우지 않고 개수만 센다. 쓰기 0. */
export async function readJournals(homeDir: string): Promise<JournalReadResult> {
  let dir: string | null;
  try {
    dir = await journalDir(homeDir, false);
  } catch (e) {
    return { ok: false, code: "JOURNAL_PATH_ESCAPE", message: e instanceof Error ? e.message : "Journal 경로 오류" };
  }
  if (dir === null) return { ok: true, journals: [], unreadable: 0, files: new Map() };
  const journals: JournalV1[] = [];
  const files = new Map<string, string>();
  let unreadable = 0;
  for (const name of (await readdir(dir)).filter((n) => JOURNAL_FILE.test(n)).sort()) {
    try {
      const info = await lstat(path.join(dir, name));
      if (!info.isFile()) throw new Error("not a file");
      const parsed = journalSchema.safeParse(JSON.parse(await readFile(path.join(dir, name), "utf8")));
      if (parsed.success && JOURNAL_FILE.exec(name)?.[1] === parsed.data.transactionId && !files.has(parsed.data.transactionId)) {
        journals.push(parsed.data);
        files.set(parsed.data.transactionId, name);
      } else unreadable += 1;
    } catch {
      unreadable += 1;
    }
  }
  journals.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  return { ok: true, journals, unreadable, files };
}

/**
 * 복구 실행이 Journal을 선점한다: 지금 이름 → 새 고유 이름(.claim-xxxxxxxx.json). rename은 하나만 성공하므로 같은 Journal을 두 복구가
 * 동시에 처리하지 않는다. 이미 다른 쪽이 선점·삭제했으면 null. 복구가 실패하면 releaseJournalClaim으로 되돌린다.
 */
export async function claimJournal(homeDir: string, transactionId: string, currentName: string): Promise<string | null> {
  const dir = await journalDir(homeDir, false).catch(() => null);
  if (dir === null || JOURNAL_FILE.exec(currentName)?.[1] !== transactionId || claimedByLiveRecovery(currentName)) return null;
  const claimed = transactionId + ".claim-" + String(process.pid) + "-" + randomBytes(4).toString("hex") + ".json";
  try {
    await rename(path.join(dir, currentName), path.join(dir, claimed));
    return claimed;
  } catch {
    return null;
  }
}

export async function releaseJournalClaim(homeDir: string, transactionId: string, claimedName: string): Promise<void> {
  const dir = await journalDir(homeDir, false).catch(() => null);
  if (dir === null) return;
  await rename(path.join(dir, claimedName), path.join(dir, transactionId + ".json")).catch(() => undefined);
}

/** 이 EntryKey들이 남아 있는 Journal의 대상인가. */
export function pendingFor(journals: readonly JournalV1[], entryKeys: Iterable<string>): JournalV1[] {
  const keys = new Set(entryKeys);
  return journals.filter((j) => j.targets.some((t) => keys.has(t.entryKey)));
}
