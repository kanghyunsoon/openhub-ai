import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { isPinnedPythonSpec } from "../installer/command";
import type { RecommendPlatform } from "../recommendation/index";
import type { StepOutcome } from "./executor";
import type { TreeKiller } from "./health";
import { capture, type NpxSpawner } from "./npx-prepare";

/**
 * uvx Prepare(v0.2.1, docs/specs/uvx-prepare.md D1–D9). 승인된 Plan의 uvx 준비 단계만 실행한다.
 *
 * 왜: uvx 도구는 launch-on-demand라 처음 실행할 때 uv가 Python 패키지를 내려받아 설치한다. Windows 빈 cache에서는 이 시간이
 * Health 시작 한도(20 s)를 넘는다(postgres-mcp·serena 측정 2/2 startup-timeout).
 *
 * 무엇을 하나:
 * - 정확한 버전만: `--from pkg==X.Y.Z`와 모든 `--with dep==A.B.C`. 그 밖의 uv 플래그가 command 앞에 있으면 준비하지 않는다.
 * - `uvx [--no-build] --compile-bytecode --from … --with … python -c pass`: 도구 환경을 만들고 빈 Python 프로그램만 실행한다.
 *   도구 패키지를 import하지 않으므로 MCP 서버 코드는 실행하지 않는다. 기본은 --no-build(wheel만, 제3자 빌드 코드 없음).
 *   검토된 Manifest(source-build-reviewed)만 --no-build 없이 실행하고, 그때는 Plan에 source-build 승인이 있다. 자동 전환은 없다.
 * - 끝나면 `uvx --offline … python -c pass`로 네트워크 없이 같은 환경을 찾는지 확인한다(Client의 다음 실행이 재사용한다).
 * - Client와 같은 uv cache를 써야 하므로 UV_CACHE_DIR를 바꾸지 않는다. uv cache 항목을 지우지 않는다.
 * - 준비 전용 timeout(최대 10분). 시간이 지나면 process tree 종료를 요청하고 종료를 확인한다(확인하지 못하면 결과에 남긴다).
 * - shell을 쓰지 않는다. uv 자식 process에는 호출 측이 넘긴 허용 목록 환경(uvChildEnv)만 준다.
 * - 결과에는 절대 경로·cache 위치·자격증명을 남기지 않는다(executor가 excerpt를 다시 가린다).
 */

export const UVX_PREPARE_STEP_ID = "uvx-prepare";
export const UVX_PREPARE_TIMEOUT_MS = 600_000;
export const UVX_VERIFY_TIMEOUT_MS = 60_000;
export const UVX_BUILD_POLICIES = ["wheels-only", "source-build-reviewed"] as const;
export type UvxBuildPolicy = (typeof UVX_BUILD_POLICIES)[number];

export interface UvxPrepareTarget {
  /** `pkg==X.Y.Z` */
  from: string;
  /** `dep==A.B.C` (Manifest 순서 유지) */
  withPins: string[];
}

/**
 * Client launch 인자에서 준비할 환경을 찾는다. `--from <정확한 버전>` + 0개 이상의 `--with <정확한 버전>` + command 형식만 받는다.
 * 그 밖(떠 있는 버전, 다른 uv 플래그, --from 없음)은 null이다(launch-on-demand 유지).
 */
export function uvxPrepareTarget(launchArgs: readonly string[]): UvxPrepareTarget | null {
  if (launchArgs[0] !== "--from") return null;
  const from = launchArgs[1];
  if (from === undefined || !isPinnedPythonSpec(from)) return null;
  const withPins: string[] = [];
  let i = 2;
  while (launchArgs[i] === "--with") {
    const dep = launchArgs[i + 1];
    if (dep === undefined || !isPinnedPythonSpec(dep)) return null;
    withPins.push(dep);
    i += 2;
  }
  const command = launchArgs[i];
  return command === undefined || command.startsWith("-") ? null : { from, withPins };
}

const envArgs = (t: UvxPrepareTarget) => ["--from", t.from, ...t.withPins.flatMap((w) => ["--with", w])];

/** 준비 단계 인자(고정 형식). */
export function uvxPrepareArgs(target: UvxPrepareTarget, policy: UvxBuildPolicy): string[] {
  return [...(policy === "wheels-only" ? ["--no-build"] : []), "--compile-bytecode", ...envArgs(target), "python", "-c", "pass"];
}

/** 준비 단계 인자가 고정 형식이면 target·policy를, 아니면 null을 돌려준다. */
export function parseUvxPrepareArgs(args: readonly string[]): { target: UvxPrepareTarget; policy: UvxBuildPolicy } | null {
  const policy: UvxBuildPolicy = args[0] === "--no-build" ? "wheels-only" : "source-build-reviewed";
  const rest = policy === "wheels-only" ? args.slice(1) : [...args];
  if (rest[0] !== "--compile-bytecode") return null;
  const tail = rest.slice(-3);
  if (JSON.stringify(tail) !== JSON.stringify(["python", "-c", "pass"])) return null;
  const env = rest.slice(1, -3);
  const target = uvxPrepareTarget([...env, "python"]);
  if (target === null || JSON.stringify(envArgs(target)) !== JSON.stringify(env)) return null;
  return { target, policy };
}

/** 같은 환경을 네트워크 없이 찾는지 확인하는 인자. */
export function uvxVerifyArgs(target: UvxPrepareTarget, policy: UvxBuildPolicy): string[] {
  return ["--offline", ...(policy === "wheels-only" ? ["--no-build"] : []), ...envArgs(target), "python", "-c", "pass"];
}

// ---------------------------------------------------------------- uv 자식 process 환경(허용 목록)

const ENV_EXACT = [
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS",
  "USER", "USERNAME", "LOGNAME", "LANG", "LANGUAGE", "TERM", "SHELL", "TZ",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_RUNTIME_DIR", "XDG_BIN_HOME",
  // 네트워크 경로(프록시·사내 CA)
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
  // uv가 cache·Python·index를 고르는 설정(Client 실행과 같은 환경을 만들기 위해)
  "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "UV_PYTHON", "UV_TOOL_DIR", "UV_NATIVE_TLS", "UV_INDEX_STRATEGY", "UV_INSECURE_HOST",
  // uv 설정 파일 선택(Client의 uvx와 같은 설정을 읽게 한다. 값은 fingerprint에만 쓴다)
  "UV_CONFIG_FILE", "UV_NO_CONFIG", "XDG_CONFIG_DIRS",
  ...["UV_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL"],
] as const;
const EXACT = new Set<string>(ENV_EXACT);
/** 사용자가 uv에 이미 설정한 index 인증(이름 있는 index). 값은 넘기기만 하고 기록하지 않는다. */
const INDEX_CREDENTIAL = /^UV_INDEX_[A-Z0-9_]+_(?:USERNAME|PASSWORD)$/u;
const LOCALE = /^LC_[A-Z_]+$/u;

/**
 * uv 자식 process에 넘길 환경(허용 목록). core는 process.env를 읽지 않으므로 호출 측(CLI·Desktop)이 원본을 넘긴다.
 * 넘기지 않는 예: AI·API key, GITHUB_TOKEN·GH_TOKEN, 클라우드 자격증명, DATABASE_URI 같은 접속 문자열, PYTHONPATH·PYTHONSTARTUP,
 * 그 밖에 목록에 없는 사용자 변수. Windows 환경변수 이름은 대소문자를 구분하지 않는다.
 */
export function uvChildEnv(source: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (EXACT.has(upper) || INDEX_CREDENTIAL.test(upper) || LOCALE.test(upper)) out[name] = value;
  }
  return out;
}

const INDEX_VARS = new Set(["UV_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX", "UV_INDEX_STRATEGY", "UV_INSECURE_HOST", "PIP_INDEX_URL", "PIP_EXTRA_INDEX_URL"]);
const stripUserinfo = (value: string) => value.replace(/([A-Za-z][A-Za-z0-9+.-]*:\/\/)[^/@\s]*@/gu, "$1");

/**
 * 패키지 index 설정 fingerprint(D8). 사용자 지정 index가 없으면 null. 있으면 index 변수 이름과 URL(계정·비밀번호 제거)의 sha256.
 * 인증 변수(USERNAME·PASSWORD)는 이름만 넣는다. 승인 뒤 index 설정이 바뀌면 Plan digest가 달라져 PLAN_STALE이다.
 */
export function uvIndexFingerprint(env: Readonly<Record<string, string>>): string | null {
  const parts: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (INDEX_VARS.has(upper)) parts.push(upper + "=" + stripUserinfo(value));
    else if (INDEX_CREDENTIAL.test(upper)) parts.push(upper);
  }
  if (parts.length === 0) return null;
  return "sha256:" + createHash("sha256").update(parts.sort().join("\n")).digest("hex");
}

// ---------------------------------------------------------------- uv 설정 파일(uv.toml)

/**
 * uvx(uv tool run)는 현재 폴더의 uv.toml·pyproject.toml은 읽지 않지만 사용자·시스템 uv.toml은 읽는다(실측 uv 0.12.3, 문서
 * docs.astral.sh/uv/configuration/files). 그 파일의 index 설정이 Client 실행과 Prepare가 받는 패키지 출처를 정한다.
 * - 읽는 위치(환경은 uvChildEnv 결과에서만 얻는다. core는 process.env를 읽지 않는다):
 *   Windows: %APPDATA%/uv/uv.toml, %PROGRAMDATA%/uv/uv.toml. 그 밖: $XDG_CONFIG_HOME(없으면 ~/.config)/uv/uv.toml,
 *   $XDG_CONFIG_DIRS 각 항목/uv/uv.toml, /etc/uv/uv.toml. UV_CONFIG_FILE이 있으면 그 파일도 읽는다(어느 쪽이 쓰이든 바뀌면 PLAN_STALE).
 * - 패키지 출처·해석에 영향을 주는 설정만 본다. 실패 시 안전 쪽: 아래 HARMLESS 목록(cache 위치·동시성·Python 선택 등) 밖의 키는
 *   모두 출처 설정으로 본다(index·find-links·constraint/override·no-build/no-binary·exclude-newer·sources, 앞으로 생길 키 포함).
 * - fingerprint: 그 설정을 TOML로 읽고 URL의 계정 정보를 지우고, 이름에 password·token·secret·credential이 들어간 키의 값은 버린 뒤
 *   정규화한 JSON의 sha256. 원문·경로·자격증명은 Plan·로그에 남기지 않는다.
 * - customIndex: 그런 설정이 하나라도 있으면 true(Plan에 index fingerprint와 고지가 붙고, 검토된 소스 빌드는 막는다).
 * - 읽을 수 없거나(권한·크기) TOML이 아니면 unsupported: uvx 준비 단계 Plan을 막는다(uv 자체도 그 파일을 쓰지 못한다).
 */
export interface UvSourceSettings {
  /** 환경변수 index 설정과 uv.toml 설정 fingerprint. 아무것도 없으면 null(기본 PyPI, 기존 Plan과 같다). */
  fingerprint: string | null;
  /** 사용자 지정 패키지 출처가 있다. */
  customIndex: boolean;
  /** 설정 파일을 확인하지 못한 이유(없으면 null). */
  unsupported: string | null;
}

export type UvConfigReader = (file: string) => Promise<string | null>;
const UV_CONFIG_MAX = 1024 * 1024;
/** 패키지 출처·해석에 영향이 없는 uv.toml 키. 이 밖의 키는 모두 출처 설정으로 본다. */
const HARMLESS_KEYS = new Set([
  "cache-dir", "no-cache", "cache-keys", "native-tls", "concurrent-downloads", "concurrent-builds", "concurrent-installs",
  "link-mode", "compile-bytecode", "preview", "python-preference", "python-downloads", "required-version", "managed", "package",
]);
const SECRET_KEY = /password|token|secret|credential/iu;

const defaultUvConfigReader: UvConfigReader = async (file) => {
  try {
    const buf = await readFile(file);
    if (buf.length > UV_CONFIG_MAX) throw new Error("too large");
    return buf.toString("utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw error;
  }
};

const envOf = (env: Readonly<Record<string, string>>, name: string) => {
  const hit = Object.keys(env).find((k) => k.toUpperCase() === name);
  const value = hit === undefined ? undefined : env[hit];
  return value === undefined || value === "" ? undefined : value;
};

/** 이 플랫폼에서 uv가 읽을 수 있는 설정 파일 후보(논리 이름 → 경로). */
export function uvConfigCandidates(env: Readonly<Record<string, string>>, platform: RecommendPlatform): { kind: string; file: string }[] {
  const out: { kind: string; file: string }[] = [];
  const custom = envOf(env, "UV_CONFIG_FILE");
  if (custom !== undefined) out.push({ kind: "config-file", file: custom });
  if (platform === "windows") {
    const appData = envOf(env, "APPDATA");
    const programData = envOf(env, "PROGRAMDATA");
    if (appData !== undefined) out.push({ kind: "user", file: path.win32.join(appData, "uv", "uv.toml") });
    if (programData !== undefined) out.push({ kind: "system", file: path.win32.join(programData, "uv", "uv.toml") });
    return out;
  }
  const home = envOf(env, "HOME");
  const xdg = envOf(env, "XDG_CONFIG_HOME") ?? (home === undefined ? undefined : path.posix.join(home, ".config"));
  if (xdg !== undefined) out.push({ kind: "user", file: path.posix.join(xdg, "uv", "uv.toml") });
  for (const [i, dir] of (envOf(env, "XDG_CONFIG_DIRS") ?? "").split(":").filter((d) => d.startsWith("/")).entries()) out.push({ kind: "system-xdg-" + String(i), file: path.posix.join(dir, "uv", "uv.toml") });
  out.push({ kind: "system", file: "/etc/uv/uv.toml" });
  return out;
}

function sanitizeConfig(value: unknown): unknown {
  if (typeof value === "string") return stripUserinfo(value);
  if (Array.isArray(value)) return value.map(sanitizeConfig);
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) out[key] = SECRET_KEY.test(key) ? "<omitted>" : sanitizeConfig((value as Record<string, unknown>)[key]);
    return out;
  }
  return value;
}

/** uv.toml에서 패키지 출처·해석 설정만 남긴다([pip] 표 안도 같은 규칙). 없으면 null. */
function sourceRelevant(doc: Record<string, unknown>): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(doc)) {
    if (HARMLESS_KEYS.has(key)) continue;
    if (key === "pip" && typeof value === "object" && value !== null && !Array.isArray(value)) {
      const pip = sourceRelevant(value as Record<string, unknown>);
      if (pip !== null) out[key] = pip;
      continue;
    }
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/** 패키지 출처 설정(환경변수 + uv.toml)을 확인한다. 실행 직전 Plan 재생성에도 같은 함수를 쓰므로 승인 뒤 바뀌면 PLAN_STALE이다. */
export async function uvSourceSettings(env: Readonly<Record<string, string>>, platform: RecommendPlatform, read: UvConfigReader = defaultUvConfigReader): Promise<UvSourceSettings> {
  const parts: string[] = [];
  let customIndex = false;
  for (const [name, value] of Object.entries(env)) {
    const upper = name.toUpperCase();
    if (INDEX_VARS.has(upper)) {
      parts.push(upper + "=" + stripUserinfo(value));
      customIndex = true;
    } else if (INDEX_CREDENTIAL.test(upper)) {
      parts.push(upper);
      customIndex = true;
    } else if (upper === "UV_NO_CONFIG") parts.push(upper + "=" + value);
  }
  for (const { kind, file } of uvConfigCandidates(env, platform)) {
    let raw: string | null;
    try {
      raw = await read(file);
    } catch {
      return { fingerprint: null, customIndex, unsupported: "uv 설정 파일(" + kind + ")을 읽지 못했습니다" };
    }
    if (raw === null) continue;
    let doc: Record<string, unknown>;
    try {
      doc = parseToml(raw) as Record<string, unknown>;
    } catch {
      return { fingerprint: null, customIndex, unsupported: "uv 설정 파일(" + kind + ")이 올바른 TOML이 아닙니다" };
    }
    const relevant = sourceRelevant(doc);
    if (relevant === null) continue;
    customIndex = true;
    parts.push("config:" + kind + "=" + JSON.stringify(sanitizeConfig(relevant)));
  }
  const fingerprint = parts.length === 0 ? null : "sha256:" + createHash("sha256").update(parts.sort().join("\n")).digest("hex");
  return { fingerprint, customIndex, unsupported: null };
}

// ---------------------------------------------------------------- 실행

export interface UvxPrepareContext {
  platform: RecommendPlatform;
  spawner: NpxSpawner;
  killTree?: TreeKiller;
  /** 준비 timeout(최대 UVX_PREPARE_TIMEOUT_MS). Plan의 timeoutMs를 넘긴다. */
  timeoutMs?: number;
  /** uv 자식 process 환경. 보통 uvChildEnv(원본 환경). 생략하면 OS 기본 상속이다(테스트). */
  childEnv?: Record<string, string>;
  graceMs?: number;
  /** source-build-reviewed 준비 단계의 검토 목록(Plan의 run step sourceBuild). 소스 빌드는 이 목록의 패키지만 허용한다. */
  sourceBuild?: readonly UvxSourceBuildEntry[] | undefined;
  /** 검토한 sdist 확인용 HTTP(PyPI JSON·files.pythonhosted.org만). 기본 globalThis.fetch. */
  fetch?: (url: string, init?: RequestInit) => Promise<Response>;
  /** uv 설정 파일 읽기(테스트 주입용). 기본은 실제 파일. */
  readUvConfig?: UvConfigReader;
}

/** 검토된 소스 빌드 패키지 하나(Manifest install.options.prepare.sourceBuild, Plan run step sourceBuild). */
export interface UvxSourceBuildEntry {
  package: string;
  version: string;
  /** PyPI sdist 파일의 sha256(64 hex). */
  sha256: string;
}

const outcome = (status: StepOutcome["status"], extra: Partial<StepOutcome> = {}): StepOutcome => ({ id: UVX_PREPARE_STEP_ID, status, ...extra });
const lastLines = (text: string) => text.split(/\r?\n/u).filter((l) => l.trim() !== "").slice(-6).join("\n").slice(-900);
/** Python 패키지 이름 정규화(PEP 503). */
export const normalizePyName = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");
const PYPI_JSON_MAX = 8 * 1024 * 1024;
const SDIST_MAX = 64 * 1024 * 1024;
const HTTP_TIMEOUT_MS = 30_000;
const SDIST_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:tar\.gz|zip)$/u;
/** 환경의 배포 목록을 출력하는 고정 Python 코드(도구 패키지를 import하지 않는다). */
const LIST_CODE = "import importlib.metadata as m;print(chr(10).join(sorted(set(d.metadata['Name'].lower().replace('_','-').replace('.','-')+'=='+d.version for d in m.distributions()))))";

/** wheel만으로 풀리지 않을 때 uv가 알려 준 패키지 이름(두 메시지 형식). 찾지 못하면 null. */
export function unbuildablePackage(text: string): string | null {
  const a = /Wheels are required for `([^`]+)`/u.exec(text);
  if (a !== null) return a[1]!;
  const b = /Because ([A-Za-z0-9][A-Za-z0-9._-]*)(?:==\S+)? has no usable wheels/u.exec(text);
  return b === null ? null : b[1]!;
}

/** uv가 이번 실행에서 빌드한 패키지("Built name==version" 줄). */
export function builtPackages(text: string): string[] {
  return [...text.matchAll(/^\s*Built ([A-Za-z0-9][A-Za-z0-9._-]*)==(\S+)\s*$/gmu)].map((m) => normalizePyName(m[1]!) + "==" + m[2]!);
}

async function fetchBounded(fetchFn: NonNullable<UvxPrepareContext["fetch"]>, url: string, max: number): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    const res = await fetchFn(url, { signal: controller.signal, redirect: "error", headers: { accept: "application/json, application/octet-stream" } });
    if (!res.ok) throw new Error("HTTP " + String(res.status));
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > max) throw new Error("too large");
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

type Phase = { ok: true; excerpt: string } | { ok: false; outcome: StepOutcome };
const fail = (code: string, excerpt: string, extra: Partial<StepOutcome> = {}): Phase => ({ ok: false, outcome: outcome("failed", { code, excerpt: excerpt + " 설정 파일은 바꾸지 않았습니다.", ...extra }) });

/**
 * 검토된 소스 빌드(D3, v0.2.1 보완). uv에는 "이 패키지만 빌드 허용" 옵션이 없으므로(--no-build·--no-build-package만 있다) 두 단계로 강제한다.
 * A. 검토 목록의 sdist를 PyPI에서 받아 sha256을 확인하고 그 파일만 `uv build --wheel`로 빌드한다. 그 wheel을 --find-links로 주고
 *    `uvx --no-build`로 환경을 푼다. 성공하면 목록 밖의 어떤 패키지도 소스 빌드가 필요 없다는 증명이고, 전체 패키지·버전 목록을 얻는다.
 *    목록 밖 sdist가 필요하면 여기서 멈춘다(UVX_UNREVIEWED_SOURCE_BUILD, 그 패키지는 빌드하지 않는다).
 * B. Client와 같은 cache 항목을 만들기 위해 uv가 PyPI sdist에서 직접 빌드하게 하되, A의 전체 버전을 constraints로 고정하고
 *    목록 밖 모든 패키지에 --no-build-package를 준다. uv가 빌드했다고 알린 패키지가 목록과 다르면 실패다.
 * 사용자 지정 index에서는 소스 빌드를 계획 단계에서 막는다(검증한 PyPI 파일과 uv가 받는 파일이 같다는 보장이 없다).
 */
async function runSourceBuild(target: UvxPrepareTarget, entries: readonly UvxSourceBuildEntry[], cwd: string, remaining: () => number, ctx: UvxPrepareContext, cctx: Parameters<typeof capture>[3]): Promise<Phase> {
  // 실행 직전 다시 확인한다(Plan 재생성과 별개의 방어). 사용자 지정 index가 있으면 PyPI에서 확인한 파일과 uv가 받는 파일이 같다는 보장이 없다.
  const settings = await uvSourceSettings(ctx.childEnv ?? {}, ctx.platform, ctx.readUvConfig);
  if (settings.unsupported !== null) return fail("UVX_CONFIG_UNSUPPORTED", settings.unsupported + ". 빌드하지 않았습니다.");
  if (settings.customIndex) return fail("UVX_SOURCE_BUILD_CUSTOM_INDEX", "사용자 지정 패키지 index가 설정되어 있어 검토된 소스 빌드를 실행하지 않았습니다(PyPI 기본 index에서만 허용).");
  const fetchFn = ctx.fetch ?? ((url, init) => globalThis.fetch(url, init));
  const wheels = path.join(cwd, "reviewed-wheels");
  await mkdir(wheels, { recursive: true });
  const allowed = new Set(entries.map((e) => normalizePyName(e.package) + "==" + e.version));
  for (const [i, e] of entries.entries()) {
    let file: { url: string; filename: string } | undefined;
    try {
      const doc = JSON.parse((await fetchBounded(fetchFn, "https://pypi.org/pypi/" + encodeURIComponent(e.package) + "/" + encodeURIComponent(e.version) + "/json", PYPI_JSON_MAX)).toString("utf8")) as { urls?: { packagetype?: string; filename?: string; url?: string; digests?: { sha256?: string } }[] };
      const hit = (doc.urls ?? []).find((u) => u.packagetype === "sdist" && u.digests?.sha256 === e.sha256);
      if (hit !== undefined && typeof hit.url === "string" && typeof hit.filename === "string") file = { url: hit.url, filename: hit.filename };
    } catch {
      return fail("UVX_SOURCE_UNVERIFIED", "PyPI에서 " + e.package + "==" + e.version + " 정보를 확인하지 못했습니다(네트워크).");
    }
    if (file === undefined || !SDIST_FILE.test(file.filename) || !file.url.startsWith("https://files.pythonhosted.org/")) {
      return fail("UVX_SOURCE_UNVERIFIED", "PyPI의 " + e.package + "==" + e.version + " sdist가 검토한 sha256과 다르거나 없습니다. 빌드하지 않았습니다.");
    }
    let bytes: Buffer;
    try {
      bytes = await fetchBounded(fetchFn, file.url, SDIST_MAX);
    } catch {
      return fail("UVX_SOURCE_UNVERIFIED", e.package + " sdist를 내려받지 못했습니다(네트워크).");
    }
    if (createHash("sha256").update(bytes).digest("hex") !== e.sha256) return fail("UVX_SOURCE_UNVERIFIED", "내려받은 " + e.package + " sdist의 sha256이 검토한 값과 다릅니다. 빌드하지 않았습니다.");
    const sdist = path.join(cwd, file.filename);
    await writeFile(sdist, bytes);
    const buildDir = path.join(cwd, "build-" + String(i));
    await mkdir(buildDir, { recursive: true });
    const built = await capture({ executable: "uv", args: ["build", "--wheel", "--out-dir", wheels, sdist] }, buildDir, remaining(), cctx);
    if (built.status !== "done") return fail(built.terminated ? "STEP_FAILED" : "STEP_TIMEOUT_UNCONFIRMED", "검토한 " + e.package + "==" + e.version + " sdist를 wheel로 빌드하지 못했습니다.\n" + lastLines(built.stderr || built.stdout), { exitCode: built.exitCode, signal: built.signal });
  }
  // 빌드 결과는 검토 목록과 정확히 같아야 한다(이름·버전, 다른 wheel 없음).
  const made = (await readdir(wheels)).filter((n) => n.endsWith(".whl")).map((n) => {
    const [name, version] = n.split("-");
    return normalizePyName(name ?? "") + "==" + (version ?? "");
  });
  if (made.length !== allowed.size || made.some((m) => !allowed.has(m))) return fail("UVX_SOURCE_BUILD_MISMATCH", "빌드한 wheel(" + made.join(", ") + ")이 검토 목록과 다릅니다.");

  const envArgs = ["--from", target.from, ...target.withPins.flatMap((w) => ["--with", w])];
  const check = await capture({ executable: "uvx", args: ["--no-build", "--find-links", wheels, ...envArgs, "python", "-c", LIST_CODE] }, cwd, remaining(), cctx);
  if (check.status !== "done") {
    const pkg = unbuildablePackage(check.stderr + check.stdout);
    if (pkg !== null) return fail("UVX_UNREVIEWED_SOURCE_BUILD", "검토 목록에 없는 패키지(" + pkg + ")가 소스 빌드를 요구합니다. 그 패키지는 빌드하지 않았습니다. Manifest 검토가 필요합니다.", { exitCode: check.exitCode });
    return fail(check.terminated ? "STEP_FAILED" : "STEP_TIMEOUT_UNCONFIRMED", "wheel만으로 환경을 확인하지 못했습니다.\n" + lastLines(check.stderr || check.stdout), { exitCode: check.exitCode, signal: check.signal });
  }
  const packages = check.stdout.split(/\r?\n/u).map((l) => l.trim()).filter((l) => /^[a-z0-9][a-z0-9-]*==\S+$/u.test(l));
  for (const a of allowed) if (!packages.includes(a)) return fail("UVX_SOURCE_BUILD_MISMATCH", "검토 목록의 " + a + "가 이 환경에서 쓰이지 않습니다. Manifest 검토가 필요합니다.");

  const constraints = path.join(cwd, "constraints.txt");
  await writeFile(constraints, packages.join("\n") + "\n");
  const blocked = packages.map((p) => p.split("==")[0]!).filter((n) => ![...allowed].some((a) => a.startsWith(n + "=="))).flatMap((n) => ["--no-build-package", n]);
  const run = await capture({ executable: "uvx", args: ["--compile-bytecode", "--constraints", constraints, ...blocked, ...envArgs, "python", "-c", "pass"] }, cwd, remaining(), cctx);
  const built = builtPackages(run.stderr + "\n" + run.stdout);
  if (built.some((b) => !allowed.has(b))) return fail("UVX_SOURCE_BUILD_MISMATCH", "uv가 검토 목록 밖의 패키지를 빌드했다고 알렸습니다(" + built.join(", ") + ").");
  if (run.status !== "done") {
    const pkg = unbuildablePackage(run.stderr + run.stdout);
    if (pkg !== null) return fail("UVX_UNREVIEWED_SOURCE_BUILD", "검토 목록에 없는 패키지(" + pkg + ")가 소스 빌드를 요구합니다. 빌드하지 않았습니다.", { exitCode: run.exitCode });
    return fail(run.terminated ? (run.code ?? "STEP_FAILED") : "STEP_TIMEOUT_UNCONFIRMED", "uv가 패키지를 준비하지 못했습니다.\n" + lastLines(run.stderr || run.stdout), { exitCode: run.exitCode, signal: run.signal });
  }
  return { ok: true, excerpt: "source build: " + [...allowed].join(", ") + " (PyPI sdist sha256 verified; " + String(packages.length - allowed.size) + " other packages wheels only)" };
}

/**
 * 준비 단계 하나를 실행한다. step 검증(고정 인자·정확한 버전)은 여기서 다시 한다. cwd는 executor가 만든 격리 임시 디렉터리다.
 * 어떤 실패도 uv cache를 지우지 않는다.
 */
export async function prepareUvxPackage(stepArgs: readonly string[], cwd: string, ctx: UvxPrepareContext): Promise<StepOutcome> {
  const parsed = parseUvxPrepareArgs(stepArgs);
  if (parsed === null) return outcome("failed", { code: "UVX_PREPARE_REJECTED", excerpt: "준비 단계는 정확한 버전의 Python 패키지(--from pkg==X.Y.Z, --with dep==A.B.C)만 받습니다" });
  const started = Date.now();
  const budget = Math.min(ctx.timeoutMs ?? UVX_PREPARE_TIMEOUT_MS, UVX_PREPARE_TIMEOUT_MS);
  const remaining = () => Math.max(1, started + budget - Date.now());
  const cctx = { platform: ctx.platform, spawner: ctx.spawner, ...(ctx.killTree === undefined ? {} : { killTree: ctx.killTree }), ...(ctx.graceMs === undefined ? {} : { graceMs: ctx.graceMs }), ...(ctx.childEnv === undefined ? {} : { childEnv: ctx.childEnv }) };

  let sourceNote = "";
  if (parsed.policy === "source-build-reviewed") {
    // 검토 목록이 없으면 소스 빌드를 시작하지 않는다(--no-build 없는 인자만으로는 무엇이 빌드될지 제한할 수 없다).
    if (ctx.sourceBuild === undefined || ctx.sourceBuild.length === 0) return outcome("failed", { code: "UVX_PREPARE_REJECTED", excerpt: "소스 빌드 준비 단계에 검토 목록(sourceBuild)이 없어 실행하지 않았습니다" });
    const phase = await runSourceBuild(parsed.target, ctx.sourceBuild, cwd, remaining, ctx, cctx);
    if (!phase.ok) return phase.outcome;
    sourceNote = "; " + phase.excerpt;
  } else {
    const run = await capture({ executable: "uvx", args: [...stepArgs] }, cwd, remaining(), cctx);
    if (run.status !== "done") {
      const tail = lastLines(run.stderr || run.stdout);
      if (/wheels are required|building from source is disabled/iu.test(run.stderr + run.stdout)) {
        return outcome("failed", {
          code: "UVX_WHEEL_UNAVAILABLE",
          exitCode: run.exitCode,
          signal: run.signal,
          excerpt: "일부 패키지가 wheel로 제공되지 않아 소스 빌드가 필요합니다. OpenHub는 검토된 Manifest(source-build-reviewed)와 별도 승인 없이는 소스를 빌드하지 않습니다. 설정 파일은 바꾸지 않았습니다." + (tail === "" ? "" : "\n" + tail),
        });
      }
      const code = !run.terminated ? "STEP_TIMEOUT_UNCONFIRMED" : (run.code ?? "STEP_FAILED");
      const head =
        code === "STEP_TIMEOUT"
          ? "준비 시간이 지나 uv process tree를 종료했습니다. 설정 파일은 바꾸지 않았습니다."
          : code === "STEP_TIMEOUT_UNCONFIRMED"
            ? "준비 시간이 지나 uv process 종료를 요청했지만 종료를 확인하지 못했습니다. 설정 파일은 바꾸지 않았습니다. 잠시 뒤 다시 시도하세요."
            : "uv가 패키지를 준비하지 못했습니다. 설정 파일은 바꾸지 않았습니다. 네트워크·index 설정을 확인한 뒤 새 계획으로 다시 시도하세요.";
      return outcome("failed", { code, exitCode: run.exitCode, signal: run.signal, excerpt: head + (tail === "" ? "" : "\n" + tail) });
    }
  }

  const verify = await capture({ executable: "uvx", args: uvxVerifyArgs(parsed.target, parsed.policy) }, cwd, Math.min(UVX_VERIFY_TIMEOUT_MS, remaining()), cctx);
  if (verify.status !== "done") {
    const tail = lastLines(verify.stderr || verify.stdout);
    return outcome("failed", {
      code: verify.terminated ? "UVX_PREPARE_VERIFY_FAILED" : "STEP_TIMEOUT_UNCONFIRMED",
      exitCode: verify.exitCode,
      signal: verify.signal,
      excerpt: "준비한 환경을 네트워크 없이 다시 찾지 못했습니다(--offline 확인 실패). 설정 파일은 바꾸지 않았습니다." + (tail === "" ? "" : "\n" + tail),
    });
  }
  return outcome("done", { exitCode: 0, signal: null, excerpt: "uv cache: prepared (" + parsed.target.from + (parsed.target.withPins.length === 0 ? "" : " + " + parsed.target.withPins.join(", ")) + sourceNote + "; offline check passed)" });
}
