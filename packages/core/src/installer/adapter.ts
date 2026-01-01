import type { AdapterId, InstallStep, Manifest } from "../manifest/index";

export type HostPlatform = "windows" | "macos" | "linux";

/** 설치를 판단·실행할 환경. `availableAdapters`는 이 PC에서 런타임이 확인된 Adapter다. */
export interface InstallContext {
  platform: HostPlatform;
  availableAdapters: ReadonlySet<AdapterId>;
  projectDir?: string;
}

/** Router가 고른 설치 대상: Manifest와 그중 실제로 사용할 설치 단계. */
export interface InstallTarget {
  manifest: Manifest;
  step: InstallStep;
}

/** Permission Preview에 표시할 실제 수행 작업(기획서 §22). */
export type PlannedAction =
  | { kind: "run-command"; command: string; cwd?: string }
  | { kind: "clone"; repository: string }
  | { kind: "runtime"; runtime: string; version?: string }
  | { kind: "download"; what: string; approxBytes?: number }
  | { kind: "network"; host: string; purpose: string }
  | { kind: "create-file"; path: string }
  | { kind: "open-port"; port: number }
  | { kind: "config-change"; target: string; description: string }
  | { kind: "env-required"; name: string };

export type Operation = "install" | "update" | "uninstall";

/** 실행 전 사용자에게 보여줄 설치 계획. 실행은 이 계획에 대한 승인이 있어야만 가능하다(CON-006). */
export interface InstallPlan {
  operation: Operation;
  tool: string;
  adapter: AdapterId;
  actions: PlannedAction[];
  warnings: string[];
}

/**
 * 사용자가 특정 계획을 승인했다는 기록(Adapter 인터페이스 형식, REQ-004). M6부터 이 형식의 객체를 만드는 Core API는 없고,
 * 실행 gate는 공통 Approval kernel이 발급한 승인만 받는다(직접 만든 객체는 APPROVAL_REQUIRED).
 */
export interface Approval {
  planDigest: string;
  approvedBy: string;
  approvedAt: string;
}

export interface ValidationResult {
  ok: boolean;
  problems: string[];
}

export interface InstallResult {
  ok: boolean;
  version?: string;
  message?: string;
}

export interface UpdateResult extends InstallResult {
  previousVersion?: string;
}

export interface HealthResult {
  healthy: boolean;
  detail?: string;
}

/**
 * 설치 엔진 공통 계약(기획서 §8).
 * Recommendation·Registry는 이 Interface만 알고 구체 엔진(Pinokio, npm, uv, Docker)은 모른다(CON-003).
 * 상태를 바꾸는 메서드는 모두 `Approval`을 요구한다(CON-005, CON-006).
 */
export interface InstallerAdapter {
  readonly id: AdapterId;
  canHandle(target: InstallTarget, ctx: InstallContext): boolean;
  validate(target: InstallTarget, ctx: InstallContext): Promise<ValidationResult>;
  plan(target: InstallTarget, operation: Operation, ctx: InstallContext): Promise<InstallPlan>;
  install(target: InstallTarget, approval: Approval, ctx: InstallContext): Promise<InstallResult>;
  update(target: InstallTarget, approval: Approval, ctx: InstallContext): Promise<UpdateResult>;
  healthCheck(target: InstallTarget, ctx: InstallContext): Promise<HealthResult>;
  uninstall(target: InstallTarget, approval: Approval, ctx: InstallContext): Promise<void>;
}
