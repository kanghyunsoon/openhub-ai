/**
 * 지원 중단 도구(v0.2.1 #39, D1). Registry에서 신규 설치 대상을 뺀 도구의 식별 정보만 둔다.
 * - Manifest·실행 명령·설치 옵션은 없다. 이 목록으로 무엇을 실행하거나 설치·편입할 수 없다(새 실행 경로·권한 우회 없음).
 * - 기존 사용자의 Client 설정·Version State·Journal은 지우지 않는다. 상태 조회와 Journal Recovery는 Manifest 없이 그대로 동작한다.
 * - 설치·update·rollback·health·repair·adopt·benchmark 진입점은 TOOL_NOT_FOUND 대신 TOOL_WITHDRAWN과 이 사유를 돌려준다.
 * - Registry에 같은 name의 Manifest가 있으면 검증 오류다(validateRegistry). 범용 Registry 확장 기능이 아니며, 항목 추가·삭제는 코드 리뷰 대상이다.
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
}

export const WITHDRAWN_TOOLS: readonly WithdrawnTool[] = [
  {
    toolId: "serena",
    displayName: "Serena",
    since: "0.2.1",
    reason: "실행에 필요한 의존성(proxy-tools)이 소스 빌드만 제공되고, OpenHub가 그 빌드 입력을 검증할 수 없어 검토되지 않은 빌드 코드를 실행하게 됩니다",
    reasonEn: "a dependency it needs (proxy-tools) is published only as a source distribution, and OpenHub cannot verify the inputs of that build, so it would run unreviewed build code",
    issue: "https://github.com/kanghyunsoon/openhub-ai/issues/59",
  },
];

export function withdrawnToolOf(toolId: string): WithdrawnTool | undefined {
  return WITHDRAWN_TOOLS.find((t) => t.toolId === toolId);
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
