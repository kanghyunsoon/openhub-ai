import { createHash } from "node:crypto";
import { z } from "zod";
import { containsAbsolutePath } from "../analyzer/index";
import { WINDOWS_CMD_EXTRA_METACHARACTERS, tokenizeManifestCommand } from "../installer/command";
import { canonicalize } from "../installer/plan";
import type { InstallStep, Manifest } from "../manifest/index";

/**
 * Pinokio 제한 Script Compiler와 입력 경계(TASK-052, D-027 A).
 * - OpenHub가 만드는 script는 `openhub-install.js`·`openhub-start.js`·`openhub-update.js` 세 개뿐이고
 *   내용은 `module.exports = <JSON>;` 한 줄 데이터다(코드 없음). 같은 Manifest·commit·인자 key면 byte가 같다.
 * - template은 allowlist만: git clone --no-checkout, 40-hex commit checkout, uv venv, 고정 uv pip install, python -m <module>.
 *   자유 message·sudo·환경변수 값 삽입·임의 URL을 요구하는 Manifest는 거부한다.
 * - script 인자: `--key=value`만, key는 형식 regex와 template별 선언 목록 양쪽을 통과해야 하고(null-prototype으로 다룬다),
 *   value는 M4 strict tokenizer + D-016 Windows 금지 문자(% ! ^) + 셸 문자·줄바꿈·절대 경로·`..`를 거부한다.
 * - script_path는 세 이름 중 하나만, ref는 항상 `pinokio://127.0.0.1:42000/api/openhub-<toolId>`로 OpenHub가 만든다.
 */

export const PINOKIO_CONTROL_HOST = "127.0.0.1";
export const PINOKIO_CONTROL_PORT = 42000;
export const PINOKIO_REF_SCOPE = "api";
export const PINOKIO_SCRIPT_NAMES = ["openhub-install.js", "openhub-start.js", "openhub-update.js"] as const;
export type PinokioScriptName = (typeof PINOKIO_SCRIPT_NAMES)[number];
/** template별 허용 script 인자 key(AC-052-10). */
export const PINOKIO_SCRIPT_ARG_KEYS: Readonly<Record<PinokioScriptName, readonly string[]>> = Object.freeze({
  "openhub-install.js": Object.freeze([]),
  "openhub-start.js": Object.freeze(["name", "port"]),
  "openhub-update.js": Object.freeze([]),
});
export const PINOKIO_ARG_KEY_PATTERN = /^[a-z][a-z0-9_-]{0,31}$/u;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const TOOL_ID = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const HEX40 = /^[0-9a-f]{40}$/u;
const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/u;
const PY_PACKAGE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u;
const PY_VERSION = /^\d+(?:\.\d+){0,3}(?:(?:a|b|rc)\d+)?(?:\.post\d+)?(?:\.dev\d+)?$/u;
const PY_MODULE = /^[A-Za-z_][A-Za-z0-9_]{0,63}(?:\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,5}$/u;
const SHELL_CHARS = [";", "&", "|", "<", ">", "$", "\u0060", "(", ")", "{", "}", "'", '"', "\\"] as const;

export type PinokioInputCode = "PINOKIO_ARGS_REJECTED" | "PINOKIO_SCRIPT_PATH_REJECTED" | "PINOKIO_REF_REJECTED" | "PINOKIO_TEMPLATE_REJECTED" | "PINOKIO_HEALTH_UNSUPPORTED" | "PINOKIO_NOT_SUPPORTED";
export type PinokioInputResult<T> = { ok: true; value: T } | { ok: false; code: PinokioInputCode; reason: string };
const fail = <T>(code: PinokioInputCode, reason: string): PinokioInputResult<T> => ({ ok: false, code, reason });

// ---------------------------------------------------------------- app id·ref·script_path

const hasTraversal = (s: string) => {
  let decoded = s;
  try {
    decoded = decodeURIComponent(s);
  } catch {
    return true;
  }
  return [s, decoded].some((v) => /[/\\?#%\s]|\.\./u.test(v)) || /%(?:2e|2f|5c)/iu.test(s);
};

/** normalized-app-id = openhub-<toolId>. toolId는 Manifest kebab-case이고 traversal·인코딩 문자를 거부한다. */
export function pinokioAppId(toolId: string): PinokioInputResult<string> {
  if (typeof toolId !== "string" || toolId.length === 0 || toolId.length > 64 || hasTraversal(toolId) || !TOOL_ID.test(toolId)) return fail("PINOKIO_REF_REJECTED", "Pinokio app id로 쓸 수 없는 도구 ID입니다");
  return { ok: true, value: "openhub-" + toolId };
}

/** 항상 OpenHub가 만든다. 사용자 ref는 쓰지 않는다. 만든 ref를 다시 parse해 고정값을 확인한다. */
export function pinokioRef(toolId: string): PinokioInputResult<string> {
  const app = pinokioAppId(toolId);
  if (!app.ok) return app;
  const ref = "pinokio://" + PINOKIO_CONTROL_HOST + ":" + String(PINOKIO_CONTROL_PORT) + "/" + PINOKIO_REF_SCOPE + "/" + app.value;
  let u: URL;
  try {
    u = new URL(ref);
  } catch {
    return fail("PINOKIO_REF_REJECTED", "Pinokio ref를 만들지 못했습니다");
  }
  const segments = u.pathname.split("/").filter(Boolean);
  const okRef =
    u.protocol === "pinokio:" && u.hostname === PINOKIO_CONTROL_HOST && u.port === String(PINOKIO_CONTROL_PORT) && u.search === "" && u.hash === "" && u.username === "" && u.password === "" &&
    segments.length === 2 && segments[0] === PINOKIO_REF_SCOPE && segments[1] === app.value;
  return okRef ? { ok: true, value: ref } : fail("PINOKIO_REF_REJECTED", "Pinokio ref가 고정 형식과 다릅니다");
}

/** script_path: compiler가 만든 세 이름 중 하나와 정확히 같아야 한다(경로·query·fragment·URL·임의 이름 금지). */
export function validateScriptPath(value: unknown): PinokioInputResult<PinokioScriptName> {
  return typeof value === "string" && (PINOKIO_SCRIPT_NAMES as readonly string[]).includes(value)
    ? { ok: true, value: value as PinokioScriptName }
    : fail("PINOKIO_SCRIPT_PATH_REJECTED", "실행할 수 있는 script는 openhub-install.js·openhub-start.js·openhub-update.js뿐입니다");
}

// ---------------------------------------------------------------- script 인자

export interface PinokioScriptArg {
  key: string;
  value: string;
}

/** value 검증(AC-052-09): 한 token, strict tokenizer, % ! ^, 셸 문자, 줄바꿈, 절대 경로, .. 거부. */
export function validateArgValue(value: string): boolean {
  if (value.length === 0 || value.length > 200 || value.startsWith("-")) return false;
  if (/[\s\u0000-\u001f\u007f]/u.test(value) || value.includes("..")) return false;
  if ([...SHELL_CHARS, ...WINDOWS_CMD_EXTRA_METACHARACTERS].some((c) => value.includes(c))) return false;
  if (containsAbsolutePath(value) || value.startsWith("/") || /^[A-Za-z]:/u.test(value) || value.startsWith("~")) return false;
  const tokens = tokenizeManifestCommand("uvx " + value, "uvx", { windowsCmdWrapper: true });
  return tokens.ok && tokens.tokens.length === 2 && tokens.tokens[1] === value;
}

const VALUE_RULES: Readonly<Record<string, RegExp>> = { port: /^(?:[1-9]\d{0,4})$/u, name: /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u };

/** `--key=value` 목록을 template의 허용 key와 대조한다(AC-052-10). 결과는 key 오름차순이다. */
export function parseScriptArgs(script: PinokioScriptName, argv: readonly string[]): PinokioInputResult<PinokioScriptArg[]> {
  const allowed = PINOKIO_SCRIPT_ARG_KEYS[script];
  const seen: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const raw of argv) {
    if (typeof raw !== "string") return fail("PINOKIO_ARGS_REJECTED", "script 인자는 문자열이어야 합니다");
    const m = /^--([^=]*)=([\s\S]*)$/u.exec(raw);
    if (m === null) return fail("PINOKIO_ARGS_REJECTED", "script 인자는 --key=value 형식만 받습니다");
    const key = m[1]!;
    const value = m[2]!;
    if (key === "") return fail("PINOKIO_ARGS_REJECTED", "빈 key는 허용하지 않습니다");
    if (FORBIDDEN_KEYS.has(key) || /[.[\]\s]/u.test(key) || !PINOKIO_ARG_KEY_PATTERN.test(key)) return fail("PINOKIO_ARGS_REJECTED", "허용하지 않는 key 형식입니다");
    if (!allowed.includes(key)) return fail("PINOKIO_ARGS_REJECTED", script + "에 선언되지 않은 key입니다");
    if (Object.prototype.hasOwnProperty.call(seen, key)) return fail("PINOKIO_ARGS_REJECTED", "같은 key를 두 번 줄 수 없습니다");
    if (!validateArgValue(value) || !(VALUE_RULES[key]?.test(value) ?? true)) return fail("PINOKIO_ARGS_REJECTED", key + " 값이 허용 형식이 아닙니다");
    if (key === "port" && Number(value) > 65535) return fail("PINOKIO_ARGS_REJECTED", "port 범위를 벗어났습니다");
    seen[key] = value;
  }
  return { ok: true, value: Object.keys(seen).sort().map((key) => ({ key, value: seen[key]! })) };
}

// ---------------------------------------------------------------- Manifest template

const optionsSchema = z.strictObject({
  template: z.literal("uv-pip"),
  commit: z.string().regex(HEX40),
  package: z.string().regex(PY_PACKAGE),
  version: z.string().regex(PY_VERSION),
  start: z.strictObject({ module: z.string().regex(PY_MODULE) }),
  /** 앱이 MCP를 HTTP로 노출할 때의 경로(loopback URL = http://127.0.0.1:<health port><path>) */
  mcp: z.strictObject({ path: z.string().regex(/^\/[A-Za-z0-9._/-]{0,100}$/u) }).optional(),
});
const FORBIDDEN_OPTION_KEYS = ["message", "sudo", "env", "url", "run", "script", "shell", "command", "download"];

export interface PinokioTemplateSpec {
  toolId: string;
  repo: string;
  commit: string;
  package: string;
  version: string;
  module: string;
  health: { url: string; port: number; expectStatus: number };
  /** HTTP MCP loopback URL(없으면 config 항목을 쓰지 않는다) */
  mcpUrl: string | null;
}

function pinokioStep(manifest: Manifest): InstallStep | undefined {
  if (manifest.install.preferredAdapter === "pinokio") return { adapter: "pinokio", ...(manifest.install.options === undefined ? {} : { options: manifest.install.options }) };
  return manifest.install.fallback.find((s) => s.adapter === "pinokio");
}

const deepStrings = (v: unknown): string[] => (typeof v === "string" ? [v] : Array.isArray(v) ? v.flatMap(deepStrings) : v !== null && typeof v === "object" ? Object.values(v).flatMap(deepStrings) : []);

/** Manifest에서 허용 template 입력만 읽는다. 그 밖의 요구(자유 message·sudo·env 값·임의 URL·동적 port)는 Plan을 만들지 않는다. */
export function readPinokioTemplate(manifest: Manifest): PinokioInputResult<PinokioTemplateSpec> {
  const step = pinokioStep(manifest);
  if (step === undefined) return fail("PINOKIO_NOT_SUPPORTED", "이 도구는 Pinokio 설치 단계가 없습니다");
  const options: Record<string, unknown> = { ...(step.options ?? {}) };
  for (const k of ["command", "package", "version", "image"] as const) if (step[k] !== undefined) options[k] = step[k];
  const forbidden = Object.keys(options).filter((k) => FORBIDDEN_OPTION_KEYS.includes(k));
  if (forbidden.length > 0) return fail("PINOKIO_TEMPLATE_REJECTED", "허용 template 밖의 입력(" + forbidden.sort().join(", ") + ")을 요구합니다");
  if (deepStrings(options).some((s) => /\bsudo\b|:\/\//iu.test(s))) return fail("PINOKIO_TEMPLATE_REJECTED", "sudo·URL을 template 값으로 쓸 수 없습니다");
  const parsed = optionsSchema.safeParse(options);
  if (!parsed.success) return fail("PINOKIO_TEMPLATE_REJECTED", "Pinokio template 입력이 허용 형식이 아닙니다");
  if (manifest.env.some((e) => e.required)) return fail("PINOKIO_TEMPLATE_REJECTED", "환경변수 값 삽입이 필요한 도구는 Pinokio template으로 만들지 않습니다");
  if (!REPO.test(manifest.repository.github)) return fail("PINOKIO_TEMPLATE_REJECTED", "repository.github 형식이 올바르지 않습니다");
  if (!pinokioAppId(manifest.name).ok) return fail("PINOKIO_REF_REJECTED", "Pinokio app id로 쓸 수 없는 도구 ID입니다");
  const hc = manifest.healthCheck;
  if (hc.type !== "http") return fail("PINOKIO_HEALTH_UNSUPPORTED", "Pinokio Health는 healthCheck: http만 지원합니다");
  let url: URL;
  try {
    url = new URL(hc.url);
  } catch {
    return fail("PINOKIO_HEALTH_UNSUPPORTED", "healthCheck url을 해석하지 못했습니다");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.port === "" || url.username !== "" || url.password !== "") {
    return fail("PINOKIO_HEALTH_UNSUPPORTED", "Health url은 고정 port의 loopback(127.0.0.1·localhost) http만 지원합니다");
  }
  const mcpPath = parsed.data.mcp?.path;
  if (mcpPath !== undefined && (mcpPath.includes("..") || mcpPath.includes("//"))) return fail("PINOKIO_TEMPLATE_REJECTED", "mcp.path 형식이 올바르지 않습니다");
  return {
    ok: true,
    value: {
      toolId: manifest.name,
      repo: manifest.repository.github,
      commit: parsed.data.commit,
      package: parsed.data.package,
      version: parsed.data.version,
      module: parsed.data.start.module,
      health: { url: url.toString(), port: Number(url.port), expectStatus: hc.expectStatus },
      mcpUrl: mcpPath === undefined ? null : "http://127.0.0.1:" + url.port + mcpPath,
    },
  };
}

// ---------------------------------------------------------------- 생성 script

export interface CompiledScript {
  name: PinokioScriptName;
  /** module.exports = <JSON>; 한 줄 */
  content: string;
  digest: string;
  /** 완료 표시 파일(openhub-*.done)에 쓰일 값 */
  marker: string;
}

const sha256 = (s: string) => "sha256:" + createHash("sha256").update(s).digest("hex");
const shellStep = (message: string, extra: Record<string, unknown> = {}) => ({ method: "shell.run", params: { message, path: ".", ...extra } });

function finish(name: PinokioScriptName, body: { daemon?: boolean; steps: unknown[] }): CompiledScript {
  const marker = sha256("openhub:" + name + ":" + JSON.stringify(canonicalize(body.steps)));
  const doc = { ...(body.daemon === true ? { daemon: true } : {}), run: [...body.steps, { method: "fs.write", params: { path: name.replace(/\.js$/u, ".done"), text: marker } }] };
  const content = "module.exports = " + JSON.stringify(canonicalize(doc)) + ";\n";
  return { name, content, digest: sha256(content), marker };
}

/** 세 script를 만든다. commit은 이 Plan이 설치할 commit, startKeys는 실제로 넘길 start 인자 key(정렬)다. */
export function compilePinokioScripts(spec: PinokioTemplateSpec, commit: string, startKeys: readonly string[]): CompiledScript[] {
  if (!HEX40.test(commit)) throw new Error("commit은 40자리 hex여야 합니다");
  const pin = spec.package + "==" + spec.version;
  const install = finish("openhub-install.js", {
    steps: [
      shellStep("git clone --no-checkout https://github.com/" + spec.repo + " app"),
      shellStep("git -C app checkout " + commit),
      shellStep("uv venv env"),
      shellStep("uv pip install --python env " + pin),
    ],
  });
  const keys = [...startKeys].filter((k) => PINOKIO_SCRIPT_ARG_KEYS["openhub-start.js"].includes(k)).sort();
  const start = finish("openhub-start.js", {
    daemon: true,
    steps: [
      shellStep("python -m " + spec.module + keys.map((k) => " --" + k + " {{args." + k + "}}").join(""), {
        venv: "env",
        on: [{ event: "/(127\\.0\\.0\\.1|localhost):" + String(spec.health.port) + "/", done: true }],
      }),
    ],
  });
  const update = finish("openhub-update.js", {
    steps: [shellStep("git -C app fetch origin " + commit), shellStep("git -C app checkout " + commit), shellStep("uv pip install --python env " + pin)],
  });
  return [install, start, update];
}

