import type { DetectorStatus, ProjectProfile, Scope } from "../analyzer/index";
import { detectorStatus, inspectedScopes, isSatisfyingInstall, unresolvedMcpServers, type InstalledTool } from "./installed";
import type { CapabilityNeed, NeedSource } from "./needs";
import type { TechCategory } from "./taxonomy";

/**
 * Gap 상태 모델(§3). need마다 위에서부터 판정한다.
 *   satisfied     resolved MCP(strong·environment)가 capability를 제공(project·user 모두 인정)
 *   unknown       source가 모두 weak / source detector failed / ai-environment failed / weak alias 일치만 있음
 *   likely-gap    source가 environment / 관련 detector partial / host 미검사 / unresolved MCP 존재
 *   confirmed-gap 위 조건이 하나도 없고 충족 도구가 없음
 * weak 근거로 설치됨·미설치를 확정하지 않으며 추천을 제거하지 않는다.
 */

export const GAP_STATES = ["confirmed-gap", "likely-gap", "unknown", "satisfied"] as const;
export type GapState = (typeof GAP_STATES)[number];

export const STATE_REASONS = [
  "satisfied-by-installed",
  "weak-evidence",
  "detector-failed",
  "ai-environment-failed",
  "weak-installed-match",
  "environment-evidence",
  "detector-partial",
  "host-unchecked",
  "unresolved-installed-tools",
  "no-installed-tool",
] as const;
export type StateReason = (typeof STATE_REASONS)[number];

export interface SatisfiedBy {
  toolId: string;
  serverName: string;
  scope: Scope;
}

export interface GapAssessment extends CapabilityNeed {
  state: GapState;
  stateReasons: StateReason[];
  satisfiedBy: SatisfiedBy[];
  /** source detector 또는 ai-environment·host-probe가 partial인지(Project Fit Evidence 보정에 쓴다) */
  partial: boolean;
}

/** Profile 카테고리 → 그 항목을 만든 Detector(project scope). user scope 항목은 host-probe가 만든다. */
export const CATEGORY_DETECTORS: Readonly<Record<TechCategory, string>> = Object.freeze({
  languages: "languages",
  frameworks: "frameworks",
  databases: "databases",
  packageManagers: "package-managers",
  infrastructure: "infrastructure",
  aiClients: "ai-environment",
});

export function sourceDetector(source: Pick<NeedSource, "category" | "scope">): string {
  return source.scope === "user" ? "host-probe" : CATEGORY_DETECTORS[source.category];
}

const statusOf = (profile: ProjectProfile, id: string): DetectorStatus => detectorStatus(profile, id) ?? "failed";
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function classifyGaps(profile: ProjectProfile, needs: readonly CapabilityNeed[], installed: readonly InstalledTool[]): GapAssessment[] {
  const scopes = inspectedScopes(profile);
  const ai = statusOf(profile, "ai-environment");
  const host = detectorStatus(profile, "host-probe");
  const unresolved = unresolvedMcpServers(installed).length;
  return needs.map((need) => {
    const sourceStatuses = need.sources.map((s) => statusOf(profile, sourceDetector(s)));
    const partial = sourceStatuses.includes("partial") || ai === "partial" || host === "partial";
    const satisfiedBy = installed
      .filter((t) => isSatisfyingInstall(t) && t.capabilities.includes(need.capability))
      .map((t) => ({ toolId: t.toolId as string, serverName: t.serverName, scope: t.scope }))
      .sort((a, b) => cmp(a.scope, b.scope) || cmp(a.serverName, b.serverName));
    const base = { ...need, satisfiedBy, partial };
    if (satisfiedBy.length > 0) return { ...base, state: "satisfied" as const, stateReasons: ["satisfied-by-installed" as const] };

    const unknown: StateReason[] = [];
    if (need.strength === "weak") unknown.push("weak-evidence");
    if (sourceStatuses.includes("failed")) unknown.push("detector-failed");
    if (ai === "failed") unknown.push("ai-environment-failed");
    if (installed.some((t) => t.resolution === "resolved" && t.strength === "weak" && t.capabilities.includes(need.capability))) unknown.push("weak-installed-match");
    if (unknown.length > 0) return { ...base, state: "unknown" as const, stateReasons: unknown };

    const likely: StateReason[] = [];
    if (need.strength === "environment") likely.push("environment-evidence");
    if (partial) likely.push("detector-partial");
    if (!scopes.includes("user")) likely.push("host-unchecked");
    if (unresolved > 0) likely.push("unresolved-installed-tools");
    if (likely.length > 0) return { ...base, state: "likely-gap" as const, stateReasons: likely };
    return { ...base, state: "confirmed-gap" as const, stateReasons: ["no-installed-tool" as const] };
  });
}

// ---------------------------------------------------------------- assessment

export interface AssessmentWarning {
  code: string;
  message: string;
}

export interface Assessment {
  inspectedScopes: Scope[];
  coverage: { detector: string; status: DetectorStatus }[];
  unresolvedInstalledTools: number;
  warnings: AssessmentWarning[];
}

const NEED_DETECTORS = ["languages", "frameworks", "databases", "infrastructure", "ai-environment"] as const;

/** 검사 범위·Detector 상태·판단 한계를 요약한다. 경고 문구는 고정이며 파일 내용·경로를 인용하지 않는다. */
export function assessProfile(profile: ProjectProfile, installed: readonly InstalledTool[]): Assessment {
  const warnings: AssessmentWarning[] = [];
  for (const id of NEED_DETECTORS) {
    if (statusOf(profile, id) === "failed") warnings.push({ code: "needs-incomplete", message: `${id} Detector가 실패해 일부 Capability 필요를 판단하지 못했습니다` });
  }
  if (statusOf(profile, "ai-environment") === "failed") warnings.push({ code: "installed-tools-unknown", message: "설치된 AI Tool을 확인하지 못해 Gap 판단을 보류합니다" });
  if (detectorStatus(profile, "host-probe") === "failed") warnings.push({ code: "user-scope-unavailable", message: "사용자 범위 검사가 실패해 프로젝트 범위만 반영했습니다" });
  return {
    inspectedScopes: inspectedScopes(profile),
    coverage: [...profile.detectors].sort((a, b) => cmp(a.id, b.id)).map((d) => ({ detector: d.id, status: d.status })),
    unresolvedInstalledTools: unresolvedMcpServers(installed).length,
    warnings: warnings.sort((a, b) => cmp(a.code, b.code) || cmp(a.message, b.message)),
  };
}
