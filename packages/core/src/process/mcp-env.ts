import type { InstallBackend } from "../installer/plan";

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
    if (declared.has(upper)) {
      out[name] = value;
      continue;
    }
    const allowed = BASE.has(upper) || LOCALE.test(upper) || backend.has(upper);
    if (!allowed || CREDENTIAL_NAME.test(upper)) continue;
    // index·registry URL에 계정이 들어 있으면 넘기지 않는다(프록시는 네트워크 경로라 예외, 문서화된 한계).
    if ((backend.has(upper) && upper !== "UV_CONFIG_FILE") && URL_USERINFO.test(value)) continue;
    out[name] = value;
  }
  return out;
}
