import type { InstallBackend } from "../installer/plan";
import { npmChildEnv } from "./npx-prepare";
import { uvChildEnv } from "./uvx-prepare";

/**
 * MCP 서버 자식 process 환경(v0.2.1 보안 보완). Health·Benchmark가 외부 MCP 서버를 실행할 때 부모 환경 전체를 상속하지 않는다.
 *
 * 왜: Node의 spawn은 env를 주지 않으면 부모 process.env를 그대로 넘긴다. OpenHub CLI·Desktop 환경에 OPENAI_API_KEY·GITHUB_TOKEN·
 * 클라우드 자격증명이 있으면, 실행한 제3자 MCP 서버가 그 값을 읽을 수 있었다.
 *
 * 넘기는 것(허용 목록, 값은 기록하지 않는다):
 * - OS·실행에 필요한 변수: PATH·PATHEXT·SYSTEMROOT 등 시스템 디렉터리, HOME·USERPROFILE·APPDATA 등 사용자 디렉터리, TEMP·TMP,
 *   USER·USERNAME, 로캘(LANG·LC_*), TERM·SHELL·TZ, XDG 디렉터리.
 * - 네트워크 경로: HTTP(S)_PROXY·NO_PROXY·ALL_PROXY, 사내 CA(NODE_EXTRA_CA_CERTS·SSL_CERT_FILE·SSL_CERT_DIR·REQUESTS_CA_BUNDLE).
 *   프록시 URL에 계정이 들어 있으면 MCP 서버도 볼 수 있다(문서화된 한계).
 * - backend 실행기 설정: npx는 npm cache·registry 위치(npm_config_* 중 인증 값 제외), uvx는 uv cache·Python·index 위치(인증 제외),
 *   docker는 DOCKER_HOST·DOCKER_CONTEXT·DOCKER_CONFIG·DOCKER_CERT_PATH·DOCKER_TLS_VERIFY.
 * - Manifest가 선언한 환경변수 이름(env[].name, required·optional): Plan에 이름이 있고 승인 화면이 보여 준다. 값이 있으면 그대로 넘긴다
 *   (OpenHub는 값을 읽어 기록하거나 존재를 확인하지 않는다).
 *
 * 넘기지 않는 것: 위에 없는 모든 변수. 예: OPENAI_API_KEY·ANTHROPIC_API_KEY 등 AI key, GITHUB_TOKEN·GH_TOKEN, AWS_*·AZURE_*·
 * GOOGLE_APPLICATION_CREDENTIALS, Manifest가 선언하지 않은 DB 접속 문자열, NPM_TOKEN·NODE_AUTH_TOKEN·npm 인증 설정,
 * UV_INDEX_*_USERNAME/PASSWORD, NODE_OPTIONS·PYTHONPATH·PYTHONSTARTUP 같은 코드 주입 경로.
 *
 * core는 process.env를 읽지 않는다. 호출 측(CLI·Desktop)이 원본을 넘긴다. Windows 환경변수 이름은 대소문자를 구분하지 않는다.
 * Client(Claude Code·Codex·Cursor)가 나중에 MCP 서버를 실행할 때 넘기는 환경은 각 Client가 정하며 OpenHub가 제한하지 않는다.
 *
 * 기본값은 닫힘(fail-closed): 원본이 없으면 빈 원본으로 거른다. 부모 환경을 그대로 상속하는 경로는 없다(health.ts는 항상 이 결과로 spawn한다).
 * 코드 주입 변수(NODE_OPTIONS·PYTHONPATH·LD_PRELOAD·DYLD_* 등)는 Manifest가 선언해도 넘기지 않고, Registry 검증에서 선언 자체를 거부한다.
 * 이 제한은 sandbox가 아니다: MCP 서버는 여전히 사용자 권한으로 홈 폴더 파일·네트워크·다른 프로그램에 접근할 수 있다.
 *
 * 패키지 출처 불변성(v0.2.1 #46 리뷰, A안): Prepare가 uv·npm에 넘기는 index·registry 설정을 여기서 같은 값으로 넘길 수 없으면
 * (인증 정보·query가 든 URL, uv 이름 있는 index 인증, 환경변수로만 둔 npm scope registry) Health·Benchmark를 실행하지 않는다
 * (mcpPackageSourceMismatch, spawn 0). 공개 index로 fallback하지 않고 offline 모드로 우회하지 않는다(cache가 index URL로 나뉘어 출처를 증명하지 못함).
 */

const BASE = new Set([
  "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "SYSTEMDRIVE", "COMSPEC", "TEMP", "TMP", "TMPDIR",
  "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
  "COMMONPROGRAMFILES", "COMMONPROGRAMFILES(X86)", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS",
  "USER", "USERNAME", "LOGNAME", "LANG", "LANGUAGE", "TERM", "SHELL", "TZ",
  "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_CONFIG_DIRS", "XDG_DATA_HOME", "XDG_DATA_DIRS", "XDG_RUNTIME_DIR", "XDG_BIN_HOME",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "ALL_PROXY", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
]);
const LOCALE = /^LC_[A-Z_]+$/u;
const BACKEND: Readonly<Record<InstallBackend, ReadonlySet<string>>> = {
  npx: new Set(["NPM_CONFIG_CACHE", "NPM_CONFIG_PREFIX", "NPM_CONFIG_REGISTRY", "NPM_CONFIG_USERCONFIG", "NPM_CONFIG_GLOBALCONFIG", "NPM_CONFIG_STRICT_SSL", "NPM_CONFIG_CAFILE", "NPM_CONFIG_UPDATE_NOTIFIER", "NPM_CONFIG_FUND", "NPM_CONFIG_AUDIT"]),
  uvx: new Set([
    "UV_CACHE_DIR", "UV_PYTHON_INSTALL_DIR", "UV_PYTHON", "UV_TOOL_DIR", "UV_NATIVE_TLS", "UV_INDEX_STRATEGY", "UV_INSECURE_HOST",
    "UV_CONFIG_FILE", "UV_NO_CONFIG", "UV_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX",
  ]),
  docker: new Set(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_CERT_PATH", "DOCKER_TLS_VERIFY"]),
};
/** 이름만으로 자격증명으로 보이는 변수. 허용 목록에 있어도 넘기지 않는다(선언된 이름은 예외: Manifest 검토·승인 대상). */
const CREDENTIAL_NAME = /(?:TOKEN|SECRET|PASSWORD|PASSWD|_AUTH|AUTH_|API_?KEY|CREDENTIAL|PRIVATE_KEY)/u;
const URL_USERINFO = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/@\s]+@/u;
/** query·fragment가 붙은 URL. token·key 같은 인증 값이 들어 있을 수 있어 MCP 서버에 넘기지 않는다(v0.2.1 #46 리뷰). */
const URL_QUERY_OR_FRAGMENT = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s]*[?#]/u;

/** 실행할 코드·라이브러리·모듈 경로를 바꾸는 변수. Manifest가 선언해도 넘기지 않는다. */
export const MCP_ENV_CODE_INJECTION_NAMES: readonly string[] = [
  "NODE_OPTIONS", "NODE_PATH", "NODE_REPL_EXTERNAL_MODULE", "ELECTRON_RUN_AS_NODE",
  "PYTHONPATH", "PYTHONSTARTUP", "PYTHONHOME", "PYTHONUSERBASE", "PYTHONINSPECT", "PYTHONBREAKPOINT", "PYTHONEXECUTABLE",
  "PERL5OPT", "PERL5LIB", "PERLLIB", "RUBYOPT", "RUBYLIB",
  "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "CLASSPATH",
  "BASH_ENV", "ENV", "ZDOTDIR", "PROMPT_COMMAND", "SHELLOPTS", "BASHOPTS", "PS4", "IFS",
  "GIT_SSH_COMMAND", "GIT_EXEC_PATH", "GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM",
];
const CODE_INJECTION = new Set(MCP_ENV_CODE_INJECTION_NAMES);
/** LD_PRELOAD·LD_LIBRARY_PATH·LD_AUDIT 등, DYLD_INSERT_LIBRARIES·DYLD_LIBRARY_PATH 등. */
const CODE_INJECTION_PREFIX = /^(?:LD_|DYLD_)/u;

/** Manifest가 선언해도 MCP 서버에 넘기지 않는 코드 주입 변수인가(대소문자 무관). */
export function isCodeInjectionEnvName(name: string): boolean {
  const upper = name.toUpperCase();
  return CODE_INJECTION.has(upper) || CODE_INJECTION_PREFIX.test(upper);
}

export interface McpChildEnvInput {
  backend: InstallBackend;
  /** Manifest가 선언한 환경변수 이름(Plan의 requiredEnv·envNames). */
  declaredNames: readonly string[];
}

/** MCP 서버 process에 넘길 환경. 호출 측이 원본(process.env)을 넘긴다. */
export function mcpServerChildEnv(source: Readonly<Record<string, string | undefined>>, input: McpChildEnvInput): Record<string, string> {
  const declared = new Set(input.declaredNames.map((n) => n.toUpperCase()));
  const backend = BACKEND[input.backend];
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    if (isCodeInjectionEnvName(upper)) continue;
    if (declared.has(upper)) {
      out[name] = value;
      continue;
    }
    const allowed = BASE.has(upper) || LOCALE.test(upper) || backend.has(upper);
    if (!allowed || CREDENTIAL_NAME.test(upper)) continue;
    // index·registry URL에 계정·query·fragment가 들어 있으면 넘기지 않는다(프록시는 네트워크 경로라 예외, 문서화된 한계).
    // 넘기지 않은 출처 설정은 mcpPackageSourceMismatch가 잡아 Health·Benchmark를 실행하지 않는다(다른 출처로 fallback 없음).
    if (backend.has(upper) && upper !== "UV_CONFIG_FILE" && (URL_USERINFO.test(value) || URL_QUERY_OR_FRAGMENT.test(value))) continue;
    out[name] = value;
  }
  return out;
}

// ---------------------------------------------------------------- 패키지 출처 불변성(v0.2.1 #46 리뷰, A안)

/** uv가 패키지를 받을 출처·인증을 정하는 환경변수(이름은 대문자). */
const UV_SOURCE = new Set(["UV_INDEX", "UV_INDEX_URL", "UV_EXTRA_INDEX_URL", "UV_DEFAULT_INDEX", "UV_INDEX_STRATEGY", "UV_INSECURE_HOST", "UV_CONFIG_FILE", "UV_NO_CONFIG"]);
const UV_INDEX_AUTH = /^UV_INDEX_[A-Z0-9_]+_(?:USERNAME|PASSWORD)$/u;
/** npm이 패키지를 받을 registry를 정하는 환경변수: npm_config_registry, npm_config_@scope:registry(대소문자 무관). */
const isNpmRegistryName = (name: string) => {
  const lower = name.toLowerCase();
  if (!lower.startsWith("npm_config_")) return false;
  const key = lower.slice("npm_config_".length);
  return key === "registry" || key.endsWith(":registry");
};
const isSourceSetting = (backend: InstallBackend, name: string) =>
  backend === "uvx" ? UV_SOURCE.has(name.toUpperCase()) || UV_INDEX_AUTH.test(name.toUpperCase()) : backend === "npx" ? isNpmRegistryName(name) : false;

/**
 * Prepare가 uv·npm에 넘기는 패키지 출처 설정 중 MCP 서버(Health·Benchmark) 환경에 같은 값으로 들어가지 않는 변수 이름(대문자, 정렬).
 * 빈 배열이 아니면 Health·Benchmark가 Prepare와 같은 출처의 패키지를 쓴다고 확인할 수 없으므로 실행하지 않는다(spawn 0).
 * 예: 계정·query가 든 UV_INDEX_URL·NPM_CONFIG_REGISTRY, UV_INDEX_<NAME>_PASSWORD, 환경변수로만 둔 npm scope registry.
 * 값은 돌려주지 않는다. uv.toml·.npmrc의 설정은 uv·npm이 직접 읽어 양쪽이 같으므로 여기에 해당하지 않는다.
 */
export function mcpPackageSourceMismatch(source: Readonly<Record<string, string | undefined>>, backend: InstallBackend): string[] {
  if (backend !== "uvx" && backend !== "npx") return [];
  const prepared = backend === "uvx" ? uvChildEnv(source) : npmChildEnv(source);
  const child = mcpServerChildEnv(source, { backend, declaredNames: [] });
  const childUpper = new Map(Object.entries(child).map(([k, v]) => [k.toUpperCase(), v]));
  const out = new Set<string>();
  for (const [name, value] of Object.entries(prepared)) {
    if (!isSourceSetting(backend, name)) continue;
    if (childUpper.get(name.toUpperCase()) !== value) out.add(name.toUpperCase());
  }
  return [...out].sort();
}

/** 원본 함수가 없거나 예외를 던지면 빈 원본(불일치 없음; 이때 MCP 서버 환경도 비어 출처 설정이 없다). */
export function mcpPackageSourceMismatchOf(sourceEnv: McpSourceEnv | undefined, backend: InstallBackend): string[] {
  let source: Readonly<Record<string, string | undefined>> = {};
  try {
    source = sourceEnv?.() ?? {};
  } catch {
    source = {};
  }
  return mcpPackageSourceMismatch(source, backend);
}

/** 사용자 안내(이름만, 값 없음). */
export function packageSourceMismatchMessage(names: readonly string[]): string {
  return (
    "패키지 출처 설정(" + names.join(", ") + ")에 인증 정보가 든 URL 등 MCP 서버에 넘길 수 없는 값이 있어, Health·Benchmark가 준비(Prepare)와 같은 출처의 패키지를 쓴다고 확인할 수 없습니다. " +
    "실행하지 않았습니다. 인증 정보는 uv.toml·.npmrc로 옮기고 환경변수에서 지운 뒤 새 계획을 만드세요"
  );
}

export type McpSourceEnv = () => Readonly<Record<string, string | undefined>>;

/**
 * 실제 MCP 실행 경계에서 쓰는 단 하나의 진입점. 원본(sourceEnv)이 없거나 빈 값이면 빈 원본으로 거른다(부모 환경 상속 없음).
 * 원본 함수가 예외를 던져도 빈 원본으로 간다.
 */
export function mcpProcessEnv(sourceEnv: McpSourceEnv | undefined, input: McpChildEnvInput): Record<string, string> {
  let source: Readonly<Record<string, string | undefined>> = {};
  try {
    source = sourceEnv?.() ?? {};
  } catch {
    source = {};
  }
  return mcpServerChildEnv(source, input);
}
