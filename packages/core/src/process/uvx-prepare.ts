import { createHash } from "node:crypto";
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
}

const outcome = (status: StepOutcome["status"], extra: Partial<StepOutcome> = {}): StepOutcome => ({ id: UVX_PREPARE_STEP_ID, status, ...extra });
const lastLines = (text: string) => text.split(/\r?\n/u).filter((l) => l.trim() !== "").slice(-6).join("\n").slice(-900);

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
  return outcome("done", { exitCode: 0, signal: null, excerpt: "uv cache: prepared (" + parsed.target.from + (parsed.target.withPins.length === 0 ? "" : " + " + parsed.target.withPins.join(", ")) + "; offline check passed)" });
}
