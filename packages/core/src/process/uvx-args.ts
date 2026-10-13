/**
 * uvx 인자 해석(v0.2.1 #39 리뷰). 의존성이 없는 순수 함수다. 설치기(installer)와 지원 중단 판정(registry)이 함께 쓴다.
 * registry 모듈은 installer 모듈을 import하지 않는다(CON-003)는 규칙 때문에 process 아래에 둔다.
 */

/**
 * uvx 0.12.3 `uvx --help`의 옵션 표. uvx는 clap 규칙을 따르므로 `--from=X`·`-wX`·`-w=X`·`-qw X`(짧은 플래그 묶음)·`--with a,b`(쉼표 목록)·
 * `--` 뒤 명령도 받는다(실측: docs/specs/v0.2.1-registry-verification.md). 표에 없는 옵션은 값을 받는지 알 수 없으므로 거부한다.
 */
const UVX_LONG_VALUE = new Set([
  "from", "with", "constraints", "build-constraints", "overrides", "env-file", "python-platform", "torch-backend",
  "index", "default-index", "index-url", "extra-index-url", "find-links", "index-strategy", "keyring-provider",
  "upgrade-package", "upgrade-group", "resolution", "prerelease", "prerelease-package", "fork-strategy", "exclude-newer", "exclude-newer-package",
  "no-sources-package", "reinstall-package", "link-mode", "config-setting", "config-settings-package", "no-build-isolation-package",
  "no-build-package", "no-binary-package", "cache-dir", "refresh-package", "python", "color", "allow-insecure-host", "directory", "project", "config-file",
]);
const UVX_LONG_FLAG = new Set([
  "isolated", "no-env-file", "lfs", "version", "no-index", "upgrade", "no-sources", "reinstall", "compile-bytecode", "no-build-isolation",
  "no-build", "no-binary", "no-cache", "refresh", "managed-python", "no-managed-python", "no-python-downloads", "quiet", "verbose",
  "system-certs", "offline", "no-progress", "no-config", "help",
]);
/** 패키지를 더하지만 Manifest만 보고는 무엇인지 알 수 없는 옵션(로컬 경로·요구사항 파일). */
const UVX_LONG_UNIDENTIFIABLE = new Set(["with-editable", "with-requirements"]);
const UVX_SHORT_VALUE: Readonly<Record<string, string>> = { w: "with", c: "constraints", b: "build-constraints", i: "index-url", f: "find-links", P: "upgrade-package", C: "config-setting", p: "python" };
const UVX_SHORT_FLAG = new Set(["U", "n", "q", "v", "V", "h"]);

/** 이름 기반 Python 요구사항(이름, extras, 버전 지정자 또는 uvx의 `이름@버전`)에서 이름만 꺼낸다. URL·경로·VCS·파일이면 null. */
export function pythonRequirementName(spec: string): string | null {
  const m = /^([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)(?:\[[A-Za-z0-9._,-]*\])?(?:@[A-Za-z0-9._+!-]+|(?:===|==|~=|!=|<=|>=|<|>)[A-Za-z0-9._*+!-]+)?$/u.exec(spec);
  if (m === null) return null;
  const name = m[1]!;
  // uv는 PEP 508로 읽을 수 없거나 배포 파일 이름처럼 보이는 값을 경로로 다룬다. 그런 값은 식별할 수 없으므로 받지 않는다.
  if (/\.(?:whl|zip|tar|tgz|gz|bz2|xz|egg)$/iu.test(name)) return null;
  return name;
}

export type UvxArgsParse =
  | {
      ok: true;
      /** --from 값(없으면 null) */
      from: string | null;
      /** --with·-w 값(쉼표 목록은 나눈다) */
      with: string[];
      /** 실행할 명령(첫 위치 인자). --from이 없으면 uvx가 이 값으로 패키지를 정한다. */
      command: string | null;
      /** 환경에 들어가는 패키지 요구사항 전부 */
      packages: string[];
      /** OpenHub가 다루는 띄어 쓴 형식(`--from X`·`--with Y`·`-w Y`; 쉼표 목록·`=` 붙여 쓰기·짧은 옵션 붙여 쓰기·플래그 묶음·`--` 없음)인지 */
      canonical: boolean;
    }
  | { ok: false; reason: string };

/** uvx 인자(실행 파일 이름 제외)를 clap 규칙대로 해석한다. 명령 뒤의 인자는 그 명령의 인자이므로 보지 않는다. 실행하지 않는다. */
export function parseUvxArgs(args: readonly string[]): UvxArgsParse {
  let from: string | null = null;
  const withs: string[] = [];
  let command: string | null = null;
  let canonical = true;
  const take = (name: string, value: string | undefined): string | undefined => {
    if (value === undefined || value === "") return "uvx --" + name + " 값이 없습니다";
    if (name === "from") {
      if (from !== null) return "uvx --from을 두 번 줄 수 없습니다";
      from = value;
    } else if (name === "with") {
      const parts = value.split(",");
      if (parts.length > 1) canonical = false;
      withs.push(...parts);
    }
    return undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--") {
      command = args[i + 1] ?? null;
      if (command === null) return { ok: false, reason: "uvx -- 뒤에 실행할 명령이 없습니다" };
      canonical = false;
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq < 0 ? a.slice(2) : a.slice(2, eq);
      if (UVX_LONG_UNIDENTIFIABLE.has(name)) return { ok: false, reason: "uvx --" + name + "는 Manifest만으로 패키지를 식별할 수 없어 지원하지 않습니다" };
      if (UVX_LONG_VALUE.has(name)) {
        let value: string | undefined;
        if (eq < 0) value = args[++i];
        else {
          value = a.slice(eq + 1);
          canonical = false;
        }
        const err = take(name, value);
        if (err !== undefined) return { ok: false, reason: err };
        continue;
      }
      if (UVX_LONG_FLAG.has(name) && eq < 0) continue;
      return { ok: false, reason: "지원하지 않는 uvx 옵션입니다(" + (eq < 0 ? a : a.slice(0, eq)) + ")" };
    }
    if (a.startsWith("-") && a.length > 1) {
      if (a.length > 2) canonical = false;
      for (let j = 1; j < a.length; j++) {
        const c = a[j]!;
        if (UVX_SHORT_FLAG.has(c)) continue;
        const long = UVX_SHORT_VALUE[c];
        if (long === undefined) return { ok: false, reason: "지원하지 않는 uvx 옵션입니다(-" + c + ")" };
        let rest = a.slice(j + 1);
        if (rest.startsWith("=")) rest = rest.slice(1);
        const err = take(long, rest === "" ? args[++i] : rest);
        if (err !== undefined) return { ok: false, reason: err };
        break;
      }
      continue;
    }
    command = a;
    break;
  }
  if (command === null && from === null) return { ok: false, reason: "uvx로 실행할 명령이 없습니다" };
  const packages = [...(from === null ? (command === null ? [] : [command]) : [from]), ...withs];
  for (const spec of packages) {
    if (pythonRequirementName(spec) === null) return { ok: false, reason: "uvx 패키지 " + spec + "를 이름 기반 요구사항으로 식별할 수 없습니다(URL·경로·VCS·파일은 지원하지 않습니다)" };
  }
  return { ok: true, from, with: withs, command, packages, canonical };
}
