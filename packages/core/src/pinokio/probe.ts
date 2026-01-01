import path from "node:path";
import type { FetchLike } from "../discovery/github";
import { PINOKIO_CONTROL_HOST, PINOKIO_CONTROL_PORT } from "./compiler";
import { loopbackGet } from "./http";

/**
 * Pinokio 비실행 availability probe(TASK-052, D-027).
 * - PATH에서 pterm launcher가 있는지(존재만), `GET http://127.0.0.1:42000/pinokio/version` 응답으로만 판단한다. 프로세스 실행 0회.
 *   (이 모듈은 spawner를 받지 않고 child_process를 import하지 않는다.)
 * - pterm 버전은 package.json에서 읽는다(`pterm version terminal`과 같은 값). name·bin·version을 확인하고
 *   `realpath(index.js)`가 `realpath(package 디렉터리)` 안이어야 한다.
 * - Windows: PATH의 `pterm.cmd` 디렉터리 → `node_modules/pterm`, node는 그 디렉터리의 `node.exe` 또는 PATH의 `node.exe`.
 *   POSIX: PATH의 `pterm` → `<prefix>/lib/node_modules/pterm`, node는 PATH의 `node`. `.cmd`를 실행하지 않는다.
 * - 절대 경로(PtermEntry)는 메모리에만 있고 Plan·state·결과에 남기지 않는다(Plan에는 pterm@<version>만).
 */

export const PTERM_SUPPORTED_VERSION = "0.0.25";
export const PINOKIO_BASE_URL = "http://" + PINOKIO_CONTROL_HOST + ":" + String(PINOKIO_CONTROL_PORT);
/** control plane 응답 버전의 지원 표(major). 표 밖이면 PINOKIO_VERSION_UNSUPPORTED다. */
export const PINOKIO_SUPPORTED_MAJORS = Object.freeze({ pinokiod: Object.freeze([3, 4, 5]), script: Object.freeze([2, 3, 4]) });

export interface PinokioProbeFs {
  stat(file: string): Promise<{ isFile(): boolean; isDirectory(): boolean }>;
  readFile(file: string): Promise<string>;
  realpath(file: string): Promise<string>;
}
export interface PinokioProbeEnv {
  pathEnv: string;
  platform: NodeJS.Platform;
  fs: PinokioProbeFs;
  fetch?: FetchLike;
  timeoutMs?: number;
}

/** 실행 시점에만 쓰는 절대 경로. 직렬화하지 않는다. */
export interface PtermEntry {
  readonly node: string;
  readonly indexJs: string;
  readonly version: string;
}

export const PINOKIO_PROBE_STATUSES = ["ok", "pterm-not-found", "pterm-invalid", "node-not-found", "pterm-version-unsupported", "pinokiod-unreachable", "pinokio-version-unsupported"] as const;
export type PinokioProbeStatus = (typeof PINOKIO_PROBE_STATUSES)[number];
export interface PinokioVersions {
  pterm: string | null;
  pinokiod: string | null;
  script: string | null;
}
export interface PinokioProbeResult {
  status: PinokioProbeStatus;
  available: boolean;
  versions: PinokioVersions;
  /** status ok일 때만 있다. */
  entry: PtermEntry | null;
}

const exists = async (fs: PinokioProbeFs, file: string, kind: "file" | "dir") => {
  try {
    const s = await fs.stat(file);
    return kind === "file" ? s.isFile() : s.isDirectory();
  } catch {
    return false;
  }
};
const inside = (child: string, parent: string, p: typeof path.win32 | typeof path.posix) => {
  const rel = p.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !p.isAbsolute(rel);
};

/** PATH에서 pterm package와 node를 찾는다(존재 확인만). */
export async function locatePterm(env: PinokioProbeEnv): Promise<{ ok: true; entry: PtermEntry } | { ok: false; status: Exclude<PinokioProbeStatus, "ok"> }> {
  const win = env.platform === "win32";
  const p = win ? path.win32 : path.posix;
  const dirs = env.pathEnv.split(win ? ";" : ":").filter((d) => d.trim() !== "" && p.isAbsolute(d));
  let packageDir: string | undefined;
  let launcherDir: string | undefined;
  for (const dir of dirs) {
    if (await exists(env.fs, p.join(dir, win ? "pterm.cmd" : "pterm"), "file")) {
      launcherDir = dir;
      packageDir = win ? p.join(dir, "node_modules", "pterm") : p.join(p.dirname(dir), "lib", "node_modules", "pterm");
      break;
    }
  }
  if (packageDir === undefined || launcherDir === undefined) return { ok: false, status: "pterm-not-found" };
  let pkg: unknown;
  try {
    pkg = JSON.parse(await env.fs.readFile(p.join(packageDir, "package.json")));
  } catch {
    return { ok: false, status: "pterm-invalid" };
  }
  const doc = pkg !== null && typeof pkg === "object" ? (pkg as Record<string, unknown>) : {};
  const bin = doc["bin"];
  const binPath = typeof bin === "string" ? bin : bin !== null && typeof bin === "object" ? (bin as Record<string, unknown>)["pterm"] : undefined;
  const version = doc["version"];
  if (doc["name"] !== "pterm" || (binPath !== "./index.js" && binPath !== "index.js") || typeof version !== "string" || !/^\d+\.\d+\.\d+$/u.test(version)) return { ok: false, status: "pterm-invalid" };
  const indexJs = p.join(packageDir, "index.js");
  let realIndex: string;
  let realPackage: string;
  try {
    realIndex = await env.fs.realpath(indexJs);
    realPackage = await env.fs.realpath(packageDir);
  } catch {
    return { ok: false, status: "pterm-invalid" };
  }
  if (!inside(realIndex, realPackage, p) || !(await exists(env.fs, realIndex, "file"))) return { ok: false, status: "pterm-invalid" };
  if (version !== PTERM_SUPPORTED_VERSION) return { ok: false, status: "pterm-version-unsupported" };
  let node: string | undefined;
  if (win && (await exists(env.fs, p.join(launcherDir, "node.exe"), "file"))) node = p.join(launcherDir, "node.exe");
  for (const dir of dirs) {
    if (node !== undefined) break;
    const candidate = p.join(dir, win ? "node.exe" : "node");
    if (await exists(env.fs, candidate, "file")) node = candidate;
  }
  if (node === undefined) return { ok: false, status: "node-not-found" };
  return { ok: true, entry: Object.freeze({ node, indexJs: realIndex, version }) };
}

const VERSION_TEXT = /^\d+(?:\.\d+){1,2}$/u;
const majorOf = (v: string) => Number(v.split(".")[0]);

/** control plane 버전(`pterm version pinokiod|script`가 내부에서 하는 요청과 같다). */
export async function fetchPinokioVersions(options: { fetch?: FetchLike; timeoutMs?: number } = {}): Promise<{ pinokiod: string | null; script: string | null } | null> {
  const res = await loopbackGet(PINOKIO_BASE_URL + "/pinokio/version", options);
  if (!res.ok || res.status !== 200) return null;
  try {
    const doc = JSON.parse(res.body) as Record<string, unknown>;
    const pick = (v: unknown) => (typeof v === "string" && VERSION_TEXT.test(v.trim()) ? v.trim() : null);
    return { pinokiod: pick(doc["pinokiod"]), script: pick(doc["script"]) };
  } catch {
    return null;
  }
}

export function isSupportedPinokioVersion(versions: PinokioVersions): boolean {
  return (
    versions.pterm === PTERM_SUPPORTED_VERSION &&
    versions.pinokiod !== null &&
    versions.script !== null &&
    PINOKIO_SUPPORTED_MAJORS.pinokiod.includes(majorOf(versions.pinokiod)) &&
    PINOKIO_SUPPORTED_MAJORS.script.includes(majorOf(versions.script))
  );
}

/** availability: launcher 존재 + package.json + control plane 응답. 실행 0회. */
export async function probePinokio(env: PinokioProbeEnv): Promise<PinokioProbeResult> {
  const located = await locatePterm(env);
  const ptermVersion = located.ok ? located.entry.version : null;
  if (!located.ok) return { status: located.status, available: false, versions: { pterm: null, pinokiod: null, script: null }, entry: null };
  const remote = await fetchPinokioVersions({ ...(env.fetch === undefined ? {} : { fetch: env.fetch }), ...(env.timeoutMs === undefined ? {} : { timeoutMs: env.timeoutMs }) });
  if (remote === null) return { status: "pinokiod-unreachable", available: false, versions: { pterm: ptermVersion, pinokiod: null, script: null }, entry: null };
  const versions = { pterm: ptermVersion, ...remote };
  if (!isSupportedPinokioVersion(versions)) return { status: "pinokio-version-unsupported", available: false, versions, entry: null };
  return { status: "ok", available: true, versions, entry: located.entry };
}

