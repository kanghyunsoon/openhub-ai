import type { Manifest } from "../manifest/index";
import { parseUvxArgs, pythonRequirementName } from "../process/uvx-args";

/**
 * 지원 중단 도구(v0.2.1 #39, D1). Registry에서 신규 설치 대상을 뺀 도구의 식별 정보만 둔다.
 * - Manifest·실행 명령·설치 옵션은 없다. 이 목록으로 무엇을 실행하거나 설치·편입할 수 없다(새 실행 경로·권한 우회 없음).
 * - 기존 사용자의 Client 설정·Version State·Journal은 지우지 않는다. 상태 조회와 Journal Recovery는 Manifest 없이 그대로 동작한다.
 * - 설치·update·rollback·health·repair·adopt·benchmark·Pinokio 계획은 TOOL_NOT_FOUND 대신 TOOL_WITHDRAWN과 이 사유를 돌려준다.
 *   판정은 Core의 계획 생성 단계에서 한다(resolveRegistryTool·withdrawnManifestOf). Registry에 같은 Manifest가 있어도(사용자 Registry,
 *   직접 넘긴 Manifest) 막는다. 이름이 달라도 identity(전용 저장소·전용 canonical MCP alias·PyPI·npm 패키지)가 같으면 같은 도구로 본다.
 * - Registry 검증(validateRegistry)도 다시 들어온 Manifest를 거부하지만, 안전성은 이 계획 단계 판정이 보장한다.
 * - 범용 Registry 확장 기능이 아니며, 항목 추가·삭제는 코드 리뷰 대상이다.
 * - 저장소(repositories)는 그 저장소가 이 도구만 담을 때만 쓴다. 여러 서버가 함께 쓰는 저장소(예: modelcontextprotocol/servers)는
 *   저장소로 식별하지 않는다. alias도 그 도구만의 이름일 때만 넣는다: "memory"처럼 흔한 alias는 무관한 패키지도 쓸 수 있으므로
 *   Memory MCP는 Tool ID와 정확한 npm 패키지로만 식별한다(v0.2.1 #72 리뷰, 다른 도구 오탐 방지).
 */
export interface WithdrawnTool {
  readonly toolId: string;
  readonly displayName: string;
  /** 신규 설치를 중단한 OpenHub 버전. */
  readonly since: string;
  readonly reason: string;
  readonly reasonEn: string;
  /** 재지원 추적 Issue. */
  readonly issue: string;
  /** 사용자가 지금 할 일(선택). 안내 끝에 붙인다. */
  readonly advice?: string;
  readonly adviceEn?: string;
  /** 다른 이름의 Manifest를 같은 도구로 식별하는 정보(식별만 한다. 실행·설치에 쓰지 않는다). */
  readonly identity: {
    /** GitHub owner/repo(대소문자 무시). 이 도구만 담은 저장소일 때만 넣는다. */
    readonly repositories: readonly string[];
    /** canonical MCP alias(recommendation.identity.mcpServerNames). 그 도구만 쓰는 이름일 때만 넣는다(흔한 이름은 비운다). */
    readonly mcpServerNames: readonly string[];
    /** PyPI 패키지 이름(PEP 503 정규화로 비교) */
    readonly pypiPackages: readonly string[];
    /** npm 패키지 이름(정확히 같은 이름만, 소문자 비교). 같은 scope의 다른 패키지는 해당하지 않는다. */
    readonly npmPackages: readonly string[];
    /**
     * Docker image 저장소 이름(Docker Hub 기준, 태그·digest·docker.io/ 접두사를 뗀 정확한 이름). docker 설치 단계의 image 값만 본다.
     * 같은 서버임을 확인한 이미지만 넣는다(다른 레지스트리의 이미지는 동일성을 알 수 없어 넣지 않는다).
     */
    readonly dockerImages: readonly string[];
  };
}

export const WITHDRAWN_TOOLS: readonly WithdrawnTool[] = [
  {
    toolId: "serena",
    displayName: "Serena",
    since: "0.2.1",
    reason: "실행에 필요한 의존성(proxy-tools)이 소스 빌드만 제공되고, OpenHub가 그 빌드 입력을 검증할 수 없어 검토되지 않은 빌드 코드를 실행하게 됩니다",
    reasonEn: "a dependency it needs (proxy-tools) is published only as a source distribution, and OpenHub cannot verify the inputs of that build, so it would run unreviewed build code",
    issue: "https://github.com/kanghyunsoon/openhub-ai/issues/59",
    identity: { repositories: ["oraios/serena"], mcpServerNames: ["serena"], pypiPackages: ["serena-agent"], npmPackages: [], dockerImages: [] },
  },
  {
    toolId: "memory-mcp",
    displayName: "Memory MCP",
    since: "0.2.1",
    reason:
      "기억을 저장하는 기본 파일(memory.jsonl)이 npx cache 안의 패키지 폴더에 있어, 새 버전이 나오면 그 파일이 지워지고 다른 버전으로 업데이트·롤백하면 저장한 기억이 보이지 않습니다(재현됨). 안전한 저장 경로와 승인된 데이터 이전이 준비될 때까지 OpenHub가 설치·관리하지 않습니다",
    reasonEn:
      "its default storage file (memory.jsonl) lives in the package folder inside the npx cache, so a new upstream version deletes it and an update or rollback to another version hides the stored memories (reproduced). OpenHub does not install or manage it until a stable storage path and an approved data copy are available",
    issue: "https://github.com/kanghyunsoon/openhub-ai/issues/69",
    advice: "Client(Claude Code·Codex·Cursor)는 기존 설정으로 이 서버를 계속 시작할 수 있습니다. 다음 실행 전에 memory.jsonl을 npm cache 밖으로 백업하고 MEMORY_FILE_PATH에 그 절대 경로를 지정하세요(README·알려진 문제 참고)",
    adviceEn: "Your client (Claude Code, Codex, Cursor) can still start this server from its existing configuration. Before its next start, back up memory.jsonl outside the npm cache and set MEMORY_FILE_PATH to that absolute path (see the README and known issues)",
    // 저장소 modelcontextprotocol/servers는 여러 MCP 서버가 함께 쓰므로 저장소로 식별하지 않는다. alias "memory"는 무관한 패키지도
    // 쓸 수 있는 흔한 이름이라 식별에 쓰지 않는다(#72 리뷰). Tool ID memory-mcp와 실제 설치 패키지만 본다.
    // Docker Hub mcp/memory는 modelcontextprotocol/servers의 src/memory Dockerfile로 빌드한 같은 서버다(Docker Hub 설명, 2026-10-14 확인).
    // OpenHub의 docker 실행(docker run -i --rm)에서는 기억 파일이 컨테이너와 함께 사라지므로 더 위험하다.
    identity: { repositories: [], mcpServerNames: [], pypiPackages: [], npmPackages: ["@modelcontextprotocol/server-memory"], dockerImages: ["mcp/memory"] },
  },
];

export function withdrawnToolOf(toolId: string): WithdrawnTool | undefined {
  return WITHDRAWN_TOOLS.find((t) => t.toolId === toolId);
}

const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");

/** 설치 정보의 문자열(명령·패키지·image·옵션 값). Manifest 형식을 해석하거나 실행하지 않는다. */
function installStrings(manifest: Manifest): string[] {
  const strings: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) for (const v of value) collect(v);
    else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) collect(v);
  };
  collect(manifest.install.options);
  for (const step of manifest.install.fallback) collect([step.command, step.package, step.image, step.options]);
  return strings;
}

const tokensOf = (s: string) => s.split(/\s+/u).filter((t) => t !== "");

/** PEP 508 요구사항 앞부분의 패키지 이름("serena-agent==1.7.0", "serena_agent[x]>=1")만 꺼낸다. */
const requirementName = (token: string) => /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:[=<>!~@;].*)?$/u.exec(token)?.[1];

/** 짧은 플래그 묶음 뒤 값을 받는 uvx 짧은 옵션(`-wX`·`-w=X`·`-qwX`)의 값. */
const SHORT_ATTACHED = /^-[UnqvVh]*[wcbifPCp]=?(.+)$/u;

/**
 * 설치 정보에서 패키지 이름 후보를 모은다(v0.2.1 #39 리뷰).
 * 1) uvx 명령은 설치기와 같은 해석기(parseUvxArgs, uvx clap 규칙: `--from=X`·`-wX`·`-w=X`·쉼표 목록·`--`)로 실제 패키지를 꺼낸다.
 *    해석에 성공한 명령은 그 패키지만 본다(명령 뒤 인자는 패키지가 아니다).
 * 2) 해석기가 거부한 명령과 그 밖의 문자열(fallback package 등)은 token을 옵션=값·짧은 옵션 붙여 쓰기·쉼표로 나눠 이름을 본다.
 *    해석기가 거부한 형식은 설치기도 실행하지 않으므로, 이 검사는 사유 안내를 정확히 하기 위한 보조다.
 */
function installPackageNames(manifest: Manifest): string[] {
  const names: string[] = [];
  for (const s of installStrings(manifest)) {
    const tokens = tokensOf(s);
    if (tokens[0] === "uvx") {
      const parsed = parseUvxArgs(tokens.slice(1));
      if (parsed.ok) {
        for (const spec of parsed.packages) names.push(pythonRequirementName(spec) ?? spec);
        continue;
      }
    }
    for (const token of tokens) {
      let value = token;
      if (token.startsWith("--")) value = token.includes("=") ? token.slice(token.indexOf("=") + 1) : "";
      else if (token.startsWith("-")) value = SHORT_ATTACHED.exec(token)?.[1]?.replace(/^=/u, "") ?? "";
      for (const piece of value.split(",")) {
        const name = requirementName(piece);
        if (name !== undefined) names.push(name);
      }
    }
  }
  return names;
}

/**
 * npm spec의 패키지 이름("@scope/name@1.0.0" → "@scope/name", "name@latest" → "name"). 이름 규칙에 맞지 않으면 undefined.
 * registry 모듈은 installer를 import하지 않으므로(CON-003) 여기서 작게 해석한다. 식별에만 쓴다.
 */
function npmSpecName(spec: string): string | undefined {
  const NAME = /^[a-z0-9][a-z0-9._-]*$/u;
  const lower = spec.toLowerCase();
  let scope = "";
  let rest = lower;
  if (lower.startsWith("@")) {
    const slash = lower.indexOf("/");
    if (slash <= 1 || !NAME.test(lower.slice(1, slash))) return undefined;
    scope = lower.slice(0, slash + 1);
    rest = lower.slice(slash + 1);
  }
  const at = rest.indexOf("@");
  const name = at === -1 ? rest : rest.slice(0, at);
  return NAME.test(name) ? scope + name : undefined;
}

/**
 * 설치 정보의 npm 패키지 이름 후보(v0.2.1 #69). 모든 문자열의 token을 npm spec으로 해석해 이름만 꺼낸다.
 * - 옵션 값(`--package=X`, `--package X`, `-p X`)과 npx의 첫 위치 인자, fallback package가 모두 token이라 함께 본다.
 * - npm alias(`이름@npm:실제패키지@버전`, `npm:실제패키지`)는 실제 패키지 이름으로 본다.
 * - 이름은 정확히 비교한다(`@modelcontextprotocol/server-memory-plus`는 다른 패키지).
 */
function installNpmPackageNames(manifest: Manifest): string[] {
  const names: string[] = [];
  for (const token of installStrings(manifest).flatMap(tokensOf)) {
    let value = token.startsWith("--") && token.includes("=") ? token.slice(token.indexOf("=") + 1) : token;
    const alias = value.lastIndexOf("npm:");
    if (alias !== -1) value = value.slice(alias + "npm:".length);
    const name = npmSpecName(value);
    if (name !== undefined) names.push(name);
  }
  return names;
}

/**
 * docker 설치 단계(우선 adapter와 fallback)의 image를 Docker Hub 저장소 이름으로 정규화한다(v0.2.1 #69 리뷰).
 * "docker.io/mcp/memory:latest", "mcp/memory@sha256:…", "index.docker.io/mcp/memory" → "mcp/memory". 명령 문자열의 다른 token은 보지 않는다.
 */
function installDockerImages(manifest: Manifest): string[] {
  const images: string[] = [];
  const imageOf = (step: { image?: unknown; options?: Record<string, unknown> | undefined }) => (typeof step.image === "string" ? step.image : typeof step.options?.["image"] === "string" ? (step.options["image"] as string) : undefined);
  const steps = [{ adapter: manifest.install.preferredAdapter, options: manifest.install.options }, ...manifest.install.fallback];
  for (const step of steps) {
    if (step.adapter !== "docker") continue;
    const raw = imageOf(step as { image?: unknown; options?: Record<string, unknown> });
    if (raw === undefined) continue;
    let ref = raw.toLowerCase().split("@")[0]!;
    const slash = ref.lastIndexOf("/");
    const colon = ref.lastIndexOf(":");
    if (colon > slash) ref = ref.slice(0, colon);
    ref = ref.replace(/^(?:docker\.io|index\.docker\.io|registry-1\.docker\.io)\//u, "");
    images.push(ref);
  }
  return images;
}

/**
 * 이 Manifest가 지원 중단 도구인가. name, GitHub 저장소(그 도구 전용일 때만), canonical MCP alias(그 도구 전용일 때만),
 * 설치 정보의 PyPI·npm 패키지·docker image·git 저장소 중 하나라도 같으면 그렇다.
 * 결과는 사유 안내와 차단에만 쓴다.
 */
export function withdrawnManifestOf(manifest: Manifest): WithdrawnTool | undefined {
  const repo = manifest.repository.github?.toLowerCase();
  const aliases = manifest.recommendation?.identity?.mcpServerNames ?? [];
  const tokens = installStrings(manifest).flatMap(tokensOf);
  const names = installPackageNames(manifest).map(pep503);
  const npmNames = installNpmPackageNames(manifest);
  const images = installDockerImages(manifest);
  return WITHDRAWN_TOOLS.find((t) => {
    if (t.toolId === manifest.name) return true;
    const repos = t.identity.repositories.map((r) => r.toLowerCase());
    if (repo !== undefined && repos.includes(repo)) return true;
    if (aliases.some((a) => t.identity.mcpServerNames.includes(a))) return true;
    if (npmNames.some((n) => t.identity.npmPackages.some((p) => p.toLowerCase() === n))) return true;
    if (images.some((image) => t.identity.dockerImages.includes(image))) return true;
    const pkgs = t.identity.pypiPackages.map(pep503);
    if (tokens.some((token) => repos.some((r) => token.toLowerCase().includes("github.com/" + r)))) return true;
    return names.some((n) => pkgs.includes(n));
  });
}

/** 사용자 안내(한국어). 기존 설정·State를 지우지 않았다는 것과 복구·수동 제거 경로를 함께 알린다. */
export function toolWithdrawnMessage(tool: WithdrawnTool): string {
  return (
    tool.displayName + "(" + tool.toolId + ")는 v" + tool.since + "부터 새 설치·업데이트·rollback·Health·repair·편입(adopt)·Benchmark를 지원하지 않습니다: " + tool.reason + ". " +
    "기존 Client 설정과 Version State는 지우지 않았습니다. 중단된 작업은 openhub lifecycle recover로 복구할 수 있고, 직접 제거하려면 README의 수동 제거 절차를 따르세요. " +
    (tool.advice === undefined ? "" : tool.advice + ". ") +
    "재지원 진행: " + tool.issue
  );
}

export function toolWithdrawnMessageEn(tool: WithdrawnTool): string {
  return (
    tool.displayName + " (" + tool.toolId + ") is no longer supported for new installs, updates, rollback, Health, repair, adopt or Benchmark since v" + tool.since + ": " + tool.reasonEn + ". " +
    "Your client configuration and Version State were not changed. An interrupted operation can still be recovered with openhub lifecycle recover; to remove the tool yourself, follow the manual removal steps in the README. " +
    (tool.adviceEn === undefined ? "" : tool.adviceEn + ". ") +
    "Re-support: " + tool.issue
  );
}

/** Registry에 없는 Tool 오류. 지원 중단 도구면 TOOL_WITHDRAWN과 사유, 아니면 TOOL_NOT_FOUND. */
export function unknownToolError(toolId: string): { ok: false; code: "TOOL_NOT_FOUND" | "TOOL_WITHDRAWN"; message: string } {
  const withdrawn = withdrawnToolOf(toolId);
  return withdrawn === undefined ? { ok: false, code: "TOOL_NOT_FOUND", message: "Registry에 없는 Tool입니다" } : { ok: false, code: "TOOL_WITHDRAWN", message: toolWithdrawnMessage(withdrawn) };
}

export type WithdrawnBlock = { ok: false; code: "TOOL_WITHDRAWN"; message: string };

/** 지원 중단 Manifest를 막는 오류. 이름이 다른 Manifest면 무엇으로 식별했는지 앞에 붙인다. */
export function withdrawnManifestError(manifest: Manifest): WithdrawnBlock | undefined {
  const tool = withdrawnManifestOf(manifest);
  if (tool === undefined) return undefined;
  const prefix = manifest.name === tool.toolId ? "" : "이 Manifest(" + manifest.name + ")는 지원 중단 도구 " + tool.displayName + "로 식별됩니다. ";
  return { ok: false, code: "TOOL_WITHDRAWN", message: prefix + toolWithdrawnMessage(tool) };
}

/**
 * 계획 생성 진입점의 공통 판정(v0.2.1 #39 리뷰). Registry 항목이 있어도 지원 중단 도구(toolId 또는 Manifest identity)면 TOOL_WITHDRAWN이다.
 * 없는 도구는 TOOL_NOT_FOUND. 상태 조회·Journal Recovery는 이 함수를 쓰지 않는다(기존 사용자 보존).
 */
export function resolveRegistryTool<E extends { manifest: Manifest }>(entries: readonly E[], toolId: string): { ok: true; entry: E } | { ok: false; code: "TOOL_NOT_FOUND" | "TOOL_WITHDRAWN"; message: string } {
  const byId = withdrawnToolOf(toolId);
  if (byId !== undefined) return { ok: false, code: "TOOL_WITHDRAWN", message: toolWithdrawnMessage(byId) };
  const entry = entries.find((e) => e.manifest.name === toolId);
  if (entry === undefined) return unknownToolError(toolId);
  return withdrawnManifestError(entry.manifest) ?? { ok: true, entry };
}
