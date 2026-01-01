import { randomBytes } from "node:crypto";
import path from "node:path";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { nodeConfigFs, type ConfigFs } from "../installer/config-writer";
import { canonicalize } from "../installer/plan";
import { stateBytesDigest, type StateErrorCode } from "../lifecycle/store";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/index";

/**
 * Pinokio state(TASK-053, D-027). `~/.openhub/state/pinokio.json` v1, 직전 정상 파일은 `pinokio.json.bak`.
 * - LifecycleStateFile v1과 별도 파일이며 같은 저장소 규칙을 쓴다: strict schema, 결정적 직렬화, atomic rename, CAS(digest), .bak 1세대,
 *   손상 시 자동으로 덮어쓰지 않음, home 밖 symlink·junction 거부.
 * - 절대 경로·env 값·token·credential URL을 저장하지 않는다(schema가 거부). appRef는 논리값 api/openhub-<toolId>다.
 */

export const PINOKIO_STATE_SCHEMA_VERSION = 1 as const;
export const PINOKIO_STATE_KIND = "openhub-pinokio-state";
export const PINOKIO_STATE_LOGICAL_PATH = "~/.openhub/state/pinokio.json";
export const PINOKIO_HEALTH_STATUSES = ["healthy", "unhealthy", "timeout", "cleanup-failed", "launch-failed"] as const;
export type PinokioHealthStatus = (typeof PINOKIO_HEALTH_STATUSES)[number];

const hex40 = z.string().regex(/^[0-9a-f]{40}$/u);
const sha256 = z.string().regex(/^sha256:[0-9a-f]{64}$/u);
const text = z.string().min(1).max(300);

export const pinokioToolCoreSchema = z.strictObject({
  toolId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  appRef: z.string().regex(/^api\/openhub-[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  repo: z.string().regex(/^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u),
  commit: hex40,
  revision: z.number().int().min(1),
  scriptDigests: z.strictObject({ install: sha256, start: sha256, update: sha256 }),
  versions: z.strictObject({ pterm: text, pinokiod: text, script: text }),
  appliedPlanDigest: sha256,
  committedAt: z.iso.datetime(),
});
export type PinokioToolCore = z.output<typeof pinokioToolCoreSchema>;
export const pinokioToolStateSchema = pinokioToolCoreSchema.extend({
  lastHealth: z.strictObject({ status: z.enum(PINOKIO_HEALTH_STATUSES), checkedAt: z.iso.datetime() }).nullable(),
  previous: pinokioToolCoreSchema.nullable(),
});
export type PinokioToolState = z.output<typeof pinokioToolStateSchema>;

const strings = (value: unknown, p: (string | number)[] = []): { path: (string | number)[]; value: string }[] => {
  if (typeof value === "string") return [{ path: p, value }];
  if (Array.isArray(value)) return value.flatMap((v, i) => strings(v, [...p, i]));
  if (value !== null && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => strings(v, [...p, k]));
  return [];
};

export const pinokioStateFileSchema = z
  .strictObject({
    schemaVersion: z.literal(PINOKIO_STATE_SCHEMA_VERSION),
    kind: z.literal(PINOKIO_STATE_KIND),
    entries: z.record(z.string().min(1).max(64), pinokioToolStateSchema),
  })
  .superRefine((file, ctx) => {
    for (const [key, entry] of Object.entries(file.entries)) {
      if (entry.toolId !== key || (entry.previous !== null && entry.previous.toolId !== key)) ctx.addIssue({ code: "custom", path: ["entries", key], message: "entry key가 toolId와 다르다" });
      if (entry.appRef !== "api/openhub-" + key) ctx.addIssue({ code: "custom", path: ["entries", key, "appRef"], message: "appRef가 toolId와 다르다" });
    }
    for (const found of strings(file)) {
      const problem = containsAbsolutePath(found.value) ? "절대 경로" : URL_CREDENTIAL_PATTERN.test(found.value) ? "URL credential" : TOKEN_PATTERN.test(found.value) ? "token" : undefined;
      if (problem !== undefined) ctx.addIssue({ code: "custom", path: found.path, message: "Pinokio state에 " + problem + "이(가) 포함될 수 없습니다" });
    }
  });
export type PinokioStateFile = z.output<typeof pinokioStateFileSchema>;

export function emptyPinokioState(): PinokioStateFile {
  return { schemaVersion: PINOKIO_STATE_SCHEMA_VERSION, kind: PINOKIO_STATE_KIND, entries: {} };
}
export function serializePinokioState(state: PinokioStateFile): string {
  return JSON.stringify(canonicalize(pinokioStateFileSchema.parse(state)), null, 2) + "\n";
}

export type PinokioStateRead = { ok: true; state: PinokioStateFile; digest: string | null } | { ok: false; code: StateErrorCode; message: string };
export type PinokioStateCommit = { ok: true; digest: string } | { ok: false; code: StateErrorCode; message: string };

const isMissing = (e: unknown) => typeof e === "object" && e !== null && (e as { code?: string }).code === "ENOENT";
const inside = (child: string, parent: string) => {
  const rel = path.relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};
function paths(homeDir: string) {
  const home = path.resolve(homeDir);
  const dir = path.join(home, ".openhub", "state");
  return { home, dir, file: path.join(dir, "pinokio.json"), backup: path.join(dir, "pinokio.json.bak") };
}
async function contained(p: ReturnType<typeof paths>, fs: ConfigFs): Promise<boolean> {
  let realHome: string;
  try {
    realHome = await fs.realpath(p.home);
  } catch {
    return false;
  }
  for (const target of [p.file, p.dir, path.dirname(p.dir)]) {
    let stat;
    try {
      stat = await fs.lstat(target);
    } catch (e) {
      if (isMissing(e)) continue;
      return false;
    }
    const real = await fs.realpath(target).catch(() => "");
    if (real === "" || !inside(real, realHome) || (target === p.file && stat.isSymbolicLink())) return false;
  }
  return true;
}
async function readOptional(fs: ConfigFs, file: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(file);
  } catch (e) {
    if (isMissing(e)) return null;
    throw e;
  }
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

export async function readPinokioState(options: { homeDir: string; fs?: ConfigFs }): Promise<PinokioStateRead> {
  const fs = options.fs ?? nodeConfigFs;
  const p = paths(options.homeDir);
  if (!(await contained(p, fs))) return { ok: false, code: "STATE_PATH_ESCAPE", message: "Pinokio state 저장소가 home 밖을 가리킵니다" };
  let bytes: Buffer | null;
  try {
    bytes = await readOptional(fs, p.file);
  } catch {
    return { ok: false, code: "STATE_CORRUPT", message: "Pinokio state를 읽지 못했습니다" };
  }
  if (bytes === null) return { ok: true, state: emptyPinokioState(), digest: null };
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString("utf8"));
  } catch {
    return { ok: false, code: "STATE_CORRUPT", message: "Pinokio state를 해석하지 못했습니다. 자동으로 덮어쓰지 않습니다" };
  }
  const version = doc !== null && typeof doc === "object" ? (doc as Record<string, unknown>)["schemaVersion"] : undefined;
  if (typeof version === "number" && version !== PINOKIO_STATE_SCHEMA_VERSION) return { ok: false, code: "STATE_VERSION_UNSUPPORTED", message: "지원하지 않는 Pinokio state schemaVersion입니다" };
  const parsed = pinokioStateFileSchema.safeParse(doc);
  return parsed.success ? { ok: true, state: parsed.data, digest: stateBytesDigest(bytes) } : { ok: false, code: "STATE_CORRUPT", message: "Pinokio state가 schema를 통과하지 못했습니다. 자동으로 덮어쓰지 않습니다" };
}

/** expectedDigest(읽을 때의 digest, 없던 파일이면 null)와 현재 파일이 다르면 STATE_CONFLICT로 쓰지 않는다. */
export async function commitPinokioState(next: PinokioStateFile, expectedDigest: string | null, options: { homeDir: string; fs?: ConfigFs }): Promise<PinokioStateCommit> {
  let bytes: Buffer;
  try {
    bytes = Buffer.from(serializePinokioState(next), "utf8");
  } catch {
    return { ok: false, code: "STATE_INVALID", message: "Pinokio state가 schema를 통과하지 못했습니다" };
  }
  const fs = options.fs ?? nodeConfigFs;
  const p = paths(options.homeDir);
  if (!(await contained(p, fs))) return { ok: false, code: "STATE_PATH_ESCAPE", message: "Pinokio state 저장소가 home 밖을 가리킵니다" };
  let current: Buffer | null;
  try {
    current = await readOptional(fs, p.file);
  } catch {
    return { ok: false, code: "STATE_WRITE_FAILED", message: "Pinokio state를 읽지 못했습니다" };
  }
  if (stateBytesDigest(current) !== expectedDigest) return { ok: false, code: "STATE_CONFLICT", message: "읽은 뒤 Pinokio state가 바뀌었습니다. 다시 시도하세요" };
  try {
    for (const d of [path.dirname(p.dir), p.dir]) {
      try {
        await fs.lstat(d);
      } catch (e) {
        if (!isMissing(e)) throw e;
        await fs.mkdir(d);
      }
    }
    if (current !== null) await atomicWrite(fs, p.backup, current);
    await atomicWrite(fs, p.file, bytes);
  } catch {
    return { ok: false, code: "STATE_WRITE_FAILED", message: "Pinokio state를 쓰지 못했습니다(원본은 그대로입니다)" };
  }
  return { ok: true, digest: stateBytesDigest(bytes) as string };
}

/** planPinokio의 installed 입력. */
export function pinokioInstalledReader(options: { homeDir: string; fs?: ConfigFs }) {
  return async (toolId: string): Promise<{ commit: string; previousCommit: string | null } | null> => {
    const read = await readPinokioState(options);
    if (!read.ok) throw new Error(read.code);
    const entry = read.state.entries[toolId];
    return entry === undefined ? null : { commit: entry.commit, previousCommit: entry.previous?.commit ?? null };
  };
}

