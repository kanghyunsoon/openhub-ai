/**
 * OpenHub Core 공개 API. 하위 모듈을 다시 내보내기만 한다.
 * 각 기능의 설명과 계약은 하위 모듈 파일에 있다.
 */
export const OPENHUB_CORE_VERSION = "0.2.0";

export * from "./manifest/index";
export * from "./registry/index";
export * from "./installer/index";
export * from "./discovery/index";
export * from "./analyzer/index";
export * from "./recommendation/index";
export * from "./installer/plan";
export * from "./installer/stale";
export * from "./installer/approval-v1";
export * from "./installer/command";
export * from "./installer/plan-builder";
export * from "./installer/backends";
export * from "./installer/config-writer";
export * from "./installer/result";
export * from "./installer/transaction";
export * from "./installer/verify";
export * from "./installer/preview";
export * from "./lifecycle/state";
export * from "./lifecycle/store";
export * from "./lifecycle/status";
export * from "./lifecycle/resolver";
export * from "./lifecycle/plan";
export * from "./lifecycle/config-replace";
export * from "./lifecycle/result";
export * from "./lifecycle/transaction";
export * from "./lifecycle/preview";
export * from "./process/probe";
export * from "./process/executor";
export * from "./process/health";
export * from "./process/npx-prepare";
export * from "./process/pterm";
export * from "./release/index";
export * from "./impact/index";
export * from "./identity/index";
export * from "./pinokio/index";
export * from "./registry-ci/fast-checks";
export * from "./registry-ci/remote-checks";
export * from "./discovery/candidates";
export * from "./adopt/index";
export * from "./catalog/index";
export * from "./discover/index";
export * from "./contribution/index";
export * from "./benchmark/index";
export * from "./metrics/index";
export * from "./pinokio/compat";
export * from "./packaging/paths";
// 선택적 LLM 요약(CLI opt-in 표시 전용, D-023). 내부 모듈은 이 파일을 import하지 않는다.
export * from "./release/summary-llm";
export * from "./tool-config/index";
