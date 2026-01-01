import { containsAbsolutePath } from "../analyzer/index";

/**
 * Manifest install.options.command strict tokenizer와 floating-artifact 판정(TASK-030, D-012 §7·§8).
 * - shell로 해석하지 않는다. 공백(스페이스·탭)으로만 나누고, 셸 metacharacter·따옴표·줄바꿈·절대 경로 token·".."가 있으면 거부한다.
 * - 첫 token은 선택된 Adapter(npx·uvx)와 같아야 한다.
 * - 모호하면 floating이다. 버전 자동 고정·digest resolution은 하지 않는다(M5 이후).
 */

export const COMMAND_METACHARACTERS = [";", "&", "|", "<", ">", "$", "`", "(", ")", "{", "}", "'", '"', "\\"] as const;

export type CommandTokens = { ok: true; tokens: string[] } | { ok: false; code: "MANIFEST_COMMAND_REJECTED"; reason: string };

const reject = (reason: string): CommandTokens => ({ ok: false, code: "MANIFEST_COMMAND_REJECTED", reason });

/**
 * D-016: native Windows에서 npx launch를 Client config에 cmd /d /c npx로 감쌀 때 cmd.exe가 인자를 다시 해석하므로
 * 기존 금지 문자에 더해 %·!·^를 거부한다. OpenHub는 이 cmd를 실행하지 않는다(Client launch config 전용).
 */
export const WINDOWS_CMD_EXTRA_METACHARACTERS = ["%", "!", "^"] as const;

export interface TokenizeOptions {
  /** Windows cmd wrapper로 기록될 인자인지(D-016). */
  windowsCmdWrapper?: boolean;
}

export function tokenizeManifestCommand(command: string, adapter: "npx" | "uvx", options: TokenizeOptions = {}): CommandTokens {
  if (/[\r\n\0]/u.test(command)) return reject("줄바꿈·제어 문자가 있습니다");
  const meta = COMMAND_METACHARACTERS.find((c) => command.includes(c));
  if (meta !== undefined) return reject("셸 metacharacter(" + meta + ")가 있습니다");
  if (options.windowsCmdWrapper === true) {
    const cmdMeta = WINDOWS_CMD_EXTRA_METACHARACTERS.find((c) => command.includes(c));
    if (cmdMeta !== undefined) return reject("Windows cmd가 다시 해석하는 문자(" + cmdMeta + ")가 있습니다");
  }
  const tokens = command.split(/[ \t]+/u).filter((t) => t !== "");
  if (tokens.length < 2) return reject("실행할 패키지가 없습니다");
  if (tokens[0] !== adapter) return reject("첫 token이 선택된 Adapter(" + adapter + ")와 다릅니다");
  for (const token of tokens.slice(1)) {
    if (token.includes("..")) return reject("상위 경로(..) token이 있습니다");
    if (containsAbsolutePath(token) || token.startsWith("/") || token.startsWith("~") || /^[A-Za-z]:/u.test(token)) return reject("절대 경로 token이 있습니다");
  }
  return { ok: true, tokens };
}

/** docker image reference. 선행 "-"(옵션 주입)·공백·metacharacter를 허용하지 않는다. */
export const DOCKER_IMAGE_PATTERN =
  /^(?:[a-z0-9]+(?:[._-][a-z0-9]+)*(?::[0-9]{1,5})?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?(?:@sha256:[0-9a-f]{64})?$/u;

export function isValidDockerImage(image: string): boolean {
  return image.length <= 255 && DOCKER_IMAGE_PATTERN.test(image);
}

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/u;
const NPM_NAME = /^[a-z0-9][a-z0-9._-]*$/u;

/** npm 패키지 spec 해석: 선행 "@scope/"를 먼저 떼고 나머지에서 마지막 "@"로 버전을 나눈다. */
export function parseNpmSpec(spec: string): { name: string; version: string | null } | null {
  let scope = "";
  let rest = spec;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash <= 1) return null;
    scope = spec.slice(0, slash + 1);
    rest = spec.slice(slash + 1);
    if (!NPM_NAME.test(scope.slice(1, -1))) return null;
  }
  const at = rest.lastIndexOf("@");
  const name = at === -1 ? rest : rest.slice(0, at);
  const version = at === -1 ? null : rest.slice(at + 1);
  if (!NPM_NAME.test(name)) return null;
  return { name: scope + name, version };
}

export function isPinnedNpmSpec(spec: string): boolean {
  const parsed = parseNpmSpec(spec);
  return parsed !== null && parsed.version !== null && EXACT_SEMVER.test(parsed.version);
}

export function isPinnedPythonSpec(spec: string): boolean {
  const match = /^([A-Za-z0-9][A-Za-z0-9._-]*)==(.+)$/u.exec(spec);
  return match !== null && EXACT_SEMVER.test(match[2]!);
}

export function isPinnedDockerImage(image: string): boolean {
  return isValidDockerImage(image) && /@sha256:[0-9a-f]{64}$/u.test(image);
}

export interface ArtifactRef {
  spec: string;
  /** 패키지 token을 모호하지 않게 찾았는지. 모호하면 floating이다. */
  unambiguous: boolean;
}

/** npx args에서 패키지 token: 앞쪽 플래그(-y, --yes)를 건너뛴 첫 token. -p·--package가 있으면 모호하다. */
export function npxArtifact(args: readonly string[]): ArtifactRef | null {
  let unambiguous = true;
  for (const arg of args) {
    if (arg === "-y" || arg === "--yes") continue;
    if (arg.startsWith("-")) {
      unambiguous = false;
      continue;
    }
    return { spec: arg, unambiguous };
  }
  return null;
}

/** uvx args에서 패키지 token: --from <pkg>가 있으면 그것, 없으면 첫 비플래그 token. 다른 플래그가 앞에 있으면 모호하다. */
export function uvxArtifact(args: readonly string[]): ArtifactRef | null {
  const from = args.indexOf("--from");
  if (from !== -1) {
    const spec = args[from + 1];
    return spec === undefined || spec.startsWith("-") ? null : { spec, unambiguous: args.slice(0, from).every((a) => !a.startsWith("-")) };
  }
  for (const [i, arg] of args.entries()) {
    if (arg.startsWith("-")) continue;
    return { spec: arg, unambiguous: args.slice(0, i).length === 0 };
  }
  return null;
}

/** §8 표. 모호하거나 해석할 수 없으면 floating(pinned=false)이다. */
export function isPinnedArtifact(backend: "npx" | "uvx" | "docker", ref: ArtifactRef | null): boolean {
  if (ref === null || !ref.unambiguous) return false;
  if (backend === "npx") return isPinnedNpmSpec(ref.spec);
  if (backend === "uvx") return isPinnedPythonSpec(ref.spec);
  return isPinnedDockerImage(ref.spec);
}
