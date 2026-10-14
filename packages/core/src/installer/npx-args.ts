/**
 * npx 인자 해석(v0.2.1, #69 리뷰 P0). npm이 받는 패키지 지정 형식 가운데 OpenHub가 패키지 이름과 버전을 확정할 수 있는
 * npm Registry 형식만 허용하고 나머지는 거부한다(fail-closed). uvx의 parseUvxArgs와 같은 원칙이다.
 * - 패키지 앞 옵션: -y, --yes, -p <spec>, --package <spec>, --만. 그 밖의 옵션(--registry, -c/--call, --prefix,
 *   --userconfig, --node-options 등)은 출처나 실행 내용을 바꿀 수 있어 거부한다.
 * - 패키지는 하나만 받는다. OpenHub는 Tool마다 artifact 하나(Version State·Prepare·update·rollback)를 관리하므로, -p를 여러 번 쓰면
 *   두 번째 패키지부터 버전 관리 밖에 남는다(#74 리뷰). --package=<spec> 붙여 쓰기도 update가 artifact token을 바꿀 수 없어 거부한다
 *   (uvx의 --from= 붙여 쓰기 거부와 같은 원칙). 이 형식들은 지원 범위 밖이며 실행할 수 없다(fail-closed).
 * - 패키지 spec: [@scope/]name[@version|@tag|@range] 또는 npm alias(alias@npm:<위 형식>, npm:<위 형식>). 이름은 npm 규칙의 소문자만.
 *   URL(http·https·tarball), Git(git+…, github:·gitlab:·bitbucket:·gist:, owner/repo 줄임), file:·link:, 상대·절대 경로, .tgz 파일은
 *   이름을 확정할 수 없거나 Registry 밖 출처라 거부한다. 문자열에 들어 있는 이름으로 추측하지 않는다.
 * - -p/--package를 쓰면 첫 위치 인자는 실행할 bin 이름이고, 쓰지 않으면 첫 위치 인자가 패키지다. 그 뒤 인자는 MCP 서버 인자다.
 * - registry 모듈은 installer를 import하지 않으므로(CON-003) 이 파일은 다른 모듈에 의존하지 않는다.
 */

export type NpxArgsResult =
  | { ok: true; packages: string[]; packageNames: string[]; command: string | null; serverArgs: string[] }
  | { ok: false; reason: string };

const NAME = /^[a-z0-9][a-z0-9._-]*$/u;
const BIN = /^[a-z0-9][a-z0-9._-]*$/u;
const VERSION =
  /^(?:\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?|[~^]?\d+(?:\.(?:\d+|x|\*)){0,2}(?:-[0-9A-Za-z.-]+)?|x|\*|[A-Za-z][A-Za-z0-9._-]*)$/u;
const MAX_NAME = 214;
/** npm은 .tgz·.tar.gz·.tar로 끝나는 인자를 로컬 tarball 파일로 해석한다(이름 규칙을 통과해도 Registry 이름이 아니다). */
const TARBALL_FILE = /\.(?:tgz|tar\.gz|tar)$/iu;

const SPEC_REJECTED = "npx 패키지는 npm Registry 이름([@scope/]name[@version])이나 npm alias만 쓸 수 있습니다. URL·tarball·Git·file:·경로 형식은 지원하지 않습니다";

/** alias 없는 Registry spec 해석. 형식이 아니면 null. */
function plainRegistrySpec(spec: string): { name: string; version: string | null } | null {
  let scope = "";
  let rest = spec;
  if (spec.startsWith("@")) {
    const slash = spec.indexOf("/");
    if (slash <= 1 || !NAME.test(spec.slice(1, slash))) return null;
    scope = spec.slice(0, slash + 1);
    rest = spec.slice(slash + 1);
  }
  const at = rest.indexOf("@");
  const name = at === -1 ? rest : rest.slice(0, at);
  const version = at === -1 ? null : rest.slice(at + 1);
  if (!NAME.test(name) || TARBALL_FILE.test(name) || scope.length + name.length > MAX_NAME) return null;
  if (version !== null && !VERSION.test(version)) return null;
  return { name: scope + name, version };
}

/**
 * npm Registry 패키지 spec이면 실제 패키지 이름과 버전을 돌려준다(alias면 대상 패키지). 아니면 null.
 * 예: "@a/b@1.2.3" → @a/b, "x@npm:@a/b@1.0.0" → @a/b, "npm:@a/b" → @a/b. "https://…", "github:o/r", "o/r", "./x", "x.tgz" → null.
 */
export function npmRegistrySpec(spec: string): { name: string; version: string | null } | null {
  if (spec.length === 0 || spec.length > 512) return null;
  if (spec.startsWith("npm:")) return plainRegistrySpec(spec.slice("npm:".length));
  const marker = spec.indexOf("@npm:", spec.startsWith("@") ? 1 : 0);
  if (marker !== -1) {
    const alias = plainRegistrySpec(spec.slice(0, marker));
    if (alias === null || alias.version !== null) return null;
    const target = spec.slice(marker + "@npm:".length);
    return target.includes("npm:") ? null : plainRegistrySpec(target);
  }
  return plainRegistrySpec(spec);
}

/** npx 인자(npx 다음부터) 해석. 지원하지 않는 형식은 ok:false와 이유(값은 넣지 않는다). */
export function parseNpxArgs(args: readonly string[]): NpxArgsResult {
  const packages: string[] = [];
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i]!;
    if (a === "-y" || a === "--yes") continue;
    if (a === "--") {
      i++;
      break;
    }
    if (a === "-p" || a === "--package") {
      const value = args[i + 1];
      if (value === undefined) return { ok: false, reason: a + " 뒤에 패키지가 없습니다" };
      if (packages.length > 0) return { ok: false, reason: "npx 패키지는 하나만 쓸 수 있습니다(-p·--package를 여러 번 쓰면 OpenHub가 버전을 관리할 수 없습니다)" };
      packages.push(value);
      i++;
      continue;
    }
    if (a.startsWith("--package=")) return { ok: false, reason: "--package=<패키지> 붙여 쓰기는 지원하지 않습니다. --package <패키지>처럼 띄어 쓰세요" };
    if (a.startsWith("-")) return { ok: false, reason: "npx 옵션(" + a.split("=")[0] + ")은 지원하지 않습니다. 패키지 앞에는 -y, --yes, -p, --package, --만 쓸 수 있습니다" };
    break;
  }
  const first = args[i];
  if (first === undefined) return { ok: false, reason: "실행할 패키지가 없습니다" };
  const specs = packages.length > 0 ? packages : [first];
  const names: string[] = [];
  for (const spec of specs) {
    const parsed = npmRegistrySpec(spec);
    if (parsed === null) return { ok: false, reason: SPEC_REJECTED };
    names.push(parsed.name);
  }
  if (packages.length > 0 && !BIN.test(first)) return { ok: false, reason: "-p·--package를 쓸 때 실행할 명령은 bin 이름이어야 합니다" };
  return { ok: true, packages: specs, packageNames: names, command: packages.length > 0 ? first : null, serverArgs: args.slice(i + 1) };
}
