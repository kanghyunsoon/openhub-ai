import type { InstallPlan, PlannedAction } from "./adapter";

/*
 * M1 Permission Preview 문구(REQ-004). M1 legacy 승인 API(approvePlan·assertApproved·ApprovalMismatchError·M1 planDigest)는
 * M6 TASK-058(D-028)에서 삭제했다. 승인은 공통 Approval kernel(requestApproval·requestLifecycleApproval·requestPinokioApproval)로만
 * 받고, 승인 후 계획이 바뀌면 실행 직전 재생성·digest 비교에서 PLAN_STALE이다(CON-006). Approval 타입과 InstallerAdapter는 유지한다.
 */

function describe(action: PlannedAction): string {
  switch (action.kind) {
    case "run-command":
      return `명령 실행: ${action.command}${action.cwd === undefined ? "" : ` (위치: ${action.cwd})`}`;
    case "clone":
      return `저장소 Clone: ${action.repository}`;
    case "runtime":
      return `런타임 설치: ${action.runtime}${action.version === undefined ? "" : ` ${action.version}`}`;
    case "download":
      return `다운로드: ${action.what}${action.approxBytes === undefined ? "" : ` (약 ${formatBytes(action.approxBytes)})`}`;
    case "network":
      return `네트워크 접근: ${action.host} — ${action.purpose}`;
    case "create-file":
      return `파일 생성: ${action.path}`;
    case "open-port":
      return `로컬 포트 열기: ${action.port}`;
    case "config-change":
      return `설정 변경: ${action.target} — ${action.description}`;
    case "env-required":
      return `환경변수 필요: ${action.name}`;
  }
}

function formatBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)}${units[i]}`;
}

/** Permission Preview 문구(기획서 §22 "This installation will"). */
export function formatPlanPreview(plan: InstallPlan): string[] {
  const verb = { install: "설치", update: "업데이트", uninstall: "제거" }[plan.operation];
  return [
    `${plan.tool} ${verb} (${plan.adapter})는 다음 작업을 수행합니다:`,
    ...plan.actions.map((a) => `- ${describe(a)}`),
    ...plan.warnings.map((w) => `! ${w}`),
  ];
}
