import type { Manifest } from "../manifest/index";

/**
 * 지원 중단 도구(v0.2.1 #39, D1). Registry에서 신규 설치 대상을 뺀 도구의 식별 정보만 둔다.
 * - Manifest·실행 명령·설치 옵션은 없다. 이 목록으로 무엇을 실행하거나 설치·편입할 수 없다(새 실행 경로·권한 우회 없음).
 * - 기존 사용자의 Client 설정·Version State·Journal은 지우지 않는다. 상태 조회와 Journal Recovery는 Manifest 없이 그대로 동작한다.
 * - 설치·update·rollback·health·repair·adopt·benchmark·Pinokio 계획은 TOOL_NOT_FOUND 대신 TOOL_WITHDRAWN과 이 사유를 돌려준다.
 *   판정은 Core의 계획 생성 단계에서 한다(resolveRegistryTool·withdrawnManifestOf). Registry에 같은 Manifest가 있어도(사용자 Registry,
 *   직접 넘긴 Manifest) 막는다. 이름이 달라도 identity(저장소·canonical MCP alias·PyPI 패키지)가 같으면 같은 도구로 본다.
 * - Registry 검증(validateRegistry)도 다시 들어온 Manifest를 거부하지만, 안전성은 이 계획 단계 판정이 보장한다.
 * - 범용 Registry 확장 기능이 아니며, 항목 추가·삭제는 코드 리뷰 대상이다.
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
  /** 다른 이름의 Manifest를 같은 도구로 식별하는 정보(식별만 한다. 실행·설치에 쓰지 않는다). */
  readonly identity: {
    /** GitHub owner/repo(대소문자 무시) */
    readonly repositories: readonly string[];
    /** canonical MCP alias(recommendation.identity.mcpServerNames) */
    readonly mcpServerNames: readonly string[];
    /** PyPI 패키지 이름(PEP 503 정규화로 비교) */
    readonly pypiPackages: readonly string[];
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
    identity: { repositories: ["oraios/serena"], mcpServerNames: ["serena"], pypiPackages: ["serena-agent"] },
  },
];

export function withdrawnToolOf(toolId: string): WithdrawnTool | undefined {
  return WITHDRAWN_TOOLS.find((t) => t.toolId === toolId);
}

const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");

/** 설치 정보의 문자열(명령·패키지·image·옵션 값)을 공백으로 나눈 token. Manifest 형식을 해석하거나 실행하지 않는다. */
function installTokens(manifest: Manifest): string[] {
  const strings: string[] = [];
  const collect = (value: unknown) => {
    if (typeof value === "string") strings.push(value);
    else if (Array.isArray(value)) for (const v of value) collect(v);
    else if (typeof value === "object" && value !== null) for (const v of Object.values(value)) collect(v);
  };
  collect(manifest.install.options);
  for (const step of manifest.install.fallback) collect([step.command, step.package, step.image, step.options]);
  return strings.flatMap((s) => s.split(/\s+/u)).filter((t) => t !== "");
}

/** PEP 508 요구사항 앞부분의 패키지 이름("serena-agent==1.7.0", "serena_agent[x]>=1")만 꺼낸다. */
const requirementName = (token: string) => /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[^\]]*\])?(?:[=<>!~@;].*)?$/u.exec(token)?.[1];

/**
 * 이 Manifest가 지원 중단 도구인가. name, GitHub 저장소, canonical MCP alias, 설치 정보의 PyPI 패키지·git 저장소 중 하나라도 같으면 그렇다.
 * 결과는 사유 안내와 차단에만 쓴다.
 */
export function withdrawnManifestOf(manifest: Manifest): WithdrawnTool | undefined {
  const repo = manifest.repository.github?.toLowerCase();
  const aliases = manifest.recommendation?.identity?.mcpServerNames ?? [];
  const tokens = installTokens(manifest);
  return WITHDRAWN_TOOLS.find((t) => {
    if (t.toolId === manifest.name) return true;
    const repos = t.identity.repositories.map((r) => r.toLowerCase());
    if (repo !== undefined && repos.includes(repo)) return true;
    if (aliases.some((a) => t.identity.mcpServerNames.includes(a))) return true;
    const pkgs = t.identity.pypiPackages.map(pep503);
    return tokens.some((token) => {
      const lower = token.toLowerCase();
      if (repos.some((r) => lower.includes("github.com/" + r))) return true;
      const name = requirementName(token);
      return name !== undefined && pkgs.includes(pep503(name));
    });
  });
}

/** 사용자 안내(한국어). 기존 설정·State를 지우지 않았다는 것과 복구·수동 제거 경로를 함께 알린다. */
export function toolWithdrawnMessage(tool: WithdrawnTool): string {
  return (
    tool.displayName + "(" + tool.toolId + ")는 v" + tool.since + "부터 새 설치·업데이트·rollback·Health·repair·편입(adopt)·Benchmark를 지원하지 않습니다: " + tool.reason + ". " +
    "기존 Client 설정과 Version State는 지우지 않았습니다. 중단된 작업은 openhub lifecycle recover로 복구할 수 있고, 직접 제거하려면 README의 수동 제거 절차를 따르세요. 재지원 진행: " + tool.issue
  );
}

export function toolWithdrawnMessageEn(tool: WithdrawnTool): string {
  return (
    tool.displayName + " (" + tool.toolId + ") is no longer supported for new installs, updates, rollback, Health, repair, adopt or Benchmark since v" + tool.since + ": " + tool.reasonEn + ". " +
    "Your client configuration and Version State were not changed. An interrupted operation can still be recovered with openhub lifecycle recover; to remove the tool yourself, follow the manual removal steps in the README. Re-support: " + tool.issue
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
