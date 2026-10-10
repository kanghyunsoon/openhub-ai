import {
  APPROVAL_REQUIREMENT_MESSAGES,
  LIFECYCLE_APPROVAL_MESSAGES,
  TREND_SCORE_MEANING,
  TREND_SCORE_MEANING_EN,
  formatInstallPlanPreview,
  formatTrendItem,
  formatLifecyclePlanPreview,
  formatLifecycleResult,
  formatLifecycleStatusItem,
  healthLines,
  installationStatusLabel,
  stateUnreadableMessage,
  type ApprovalRequirement,
  type InstallPlanV1,
  type InstallResultV1,
  type LifecycleApprovalRequirement,
  type LifecyclePlanV1,
  type LifecycleResultV1,
  type LifecycleToolStatus,
  type PlannedInstall,
  type PlannedLifecycle,
  type TrendItem,
} from "@openhub/core";
import {
  CAPABILITY_EN,
  INSTALL_APPROVAL_EN,
  LIFECYCLE_APPROVAL_EN,
  REASON_EN,
  healthLinesEn,
  installPreviewEn,
  installResultNextEn,
  installWarningEn,
  installationStatusEn,
  lifecyclePreviewEn,
  lifecycleResultEn,
  stateUnreadableEn,
  statusItemEn,
  trendItemEn,
  warningsEn,
} from "./core-en";
import { formatDateTime, getDesktopLocale } from "./index";

/**
 * Core 문장 표시 선택(v0.2.0 P0-3 PR B). 한국어: Core 문장 그대로(CLI와 같은 문장, 기존 golden 유지).
 * English: core-en.ts가 같은 구조에서 만든 영어 문장. 승인 요구 ID·warning code·오류 code는 두 언어 모두 그대로 보인다.
 */
const en = () => getDesktopLocale() === "en";

export const installApprovalText = (id: ApprovalRequirement): string => (en() ? INSTALL_APPROVAL_EN[id] : APPROVAL_REQUIREMENT_MESSAGES[id]);
export const lifecycleApprovalText = (id: LifecycleApprovalRequirement): string => (en() ? LIFECYCLE_APPROVAL_EN[id] : LIFECYCLE_APPROVAL_MESSAGES[id]);
export const installPreviewLines = (planned: PlannedInstall): string[] => (en() ? installPreviewEn(planned) : formatInstallPlanPreview(planned));
export const lifecyclePreviewLines = (planned: PlannedLifecycle): string[] => (en() ? lifecyclePreviewEn(planned) : formatLifecyclePlanPreview(planned));
export const statusItemLines = (item: LifecycleToolStatus): string[] => (en() ? statusItemEn(item, (iso) => formatDateTime(iso)) : formatLifecycleStatusItem(item));
export const lifecycleResultLines = (result: LifecycleResultV1, guide: string | null): string[] => (en() ? lifecycleResultEn(result, guide, (iso) => formatDateTime(iso)) : formatLifecycleResult(result));
export const healthTextLines = (h: Parameters<typeof healthLines>[0]): string[] => (en() ? healthLinesEn(h, (iso) => formatDateTime(iso)) : healthLines(h));
export const installationStatusText = (plan: InstallPlanV1): string => (en() ? installationStatusEn(plan) : installationStatusLabel(plan));
export const stateUnreadableText = (code: string): string => (en() ? stateUnreadableEn(code) : stateUnreadableMessage(code));
export const trendMeaningText = (): string => (en() ? TREND_SCORE_MEANING_EN : TREND_SCORE_MEANING);
export const trendLine = (item: TrendItem, rank: number): string => (en() ? trendItemEn(item, rank) : formatTrendItem(item, rank));

/** Plan warning 하나 이상 → 표시 문장(code와 함께). 한국어는 Core message 그대로. */
export function planWarningTexts(plan: InstallPlanV1 | LifecyclePlanV1, warnings: readonly { code: string; message: string }[]): { code: string; text: string }[] {
  return en() ? warningsEn(plan, warnings) : warnings.map((w) => ({ code: w.code, text: w.message }));
}

export const installNextActionTexts = (result: InstallResultV1, plan: InstallPlanV1): string[] => (en() ? installResultNextEn(result, plan) : [...result.nextActions]);
export const installWarningTexts = (result: InstallResultV1, plan: InstallPlanV1): string[] => result.warnings.map((w) => (en() ? installWarningEn(plan, w) : "[" + w.code + "] " + w.message));

/** 추천 이유. English는 code 의미만(이름·수치 없음). */
export const reasonText = (reason: { code: string; message: string }): string => (en() ? (REASON_EN[reason.code] ?? reason.code) : reason.message);
/** 능력(capability) 이름. English는 taxonomy ID로 고른다. */
export const capabilityText = (id: string, label: string): string => (en() ? (CAPABILITY_EN[id] ?? id) : label);

