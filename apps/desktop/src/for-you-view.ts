import {
  INSTALL_CLIENTS,
  clientVerificationLevel,
  diagnoseRecommendation,
  type EmptyReason,
  type ExclusionCode,
  type ProjectProfile,
  type RecommendPlatform,
  type RecommendationReport,
  type RegistryEntry,
} from "@openhub/core";
import { capabilityText, reasonText } from "./i18n/core-text";
import { tr } from "./i18n/index";

/**
 * FOR YOU 카드 화면 데이터(TASK-026). Core RecommendationReport를 화면용으로 줄인다(Electron에 의존하지 않아 테스트 가능).
 * Project Fit과 OpenScore는 따로 표시하고 합치지 않는다. 설치 동작은 없다(M4).
 */

/** OpenScore 의미 문구(현재 Desktop 언어). */
export const openScoreNotice = (): string => tr("forYou.openNotice");
export const MAX_REASONS = 3;

export type BadgeKind = "confirmed" | "likely" | "unknown" | "host-unchecked" | "unidentified";

export interface ForYouItem {
  rank: number;
  toolId: string;
  name: string;
  capability: string;
  projectFit: string;
  openScore: string;
  badges: { kind: BadgeKind; label: string }[];
  reasons: string[];
  moreReasons: number;
  /** Registry 등록과 OpenHub 실제 실행 검증을 구분한 한 줄(v0.2.0 C3). 맥락(Registry·OS)이 없으면 null. */
  verification: string | null;
}

/**
 * 추천 진단(v0.2.0 P0-3 C3). Core diagnoseRecommendation과 RecommendationReport의 후보 제외 코드(excludedBy)만 옮긴다.
 * 새 점수나 후보를 만들지 않는다. 검증 수준은 Core가 추천 제외 사유로 쓰지 않으므로 제외 사유가 아니라 정보로만 보인다.
 */
export interface ForYouDiagnosis {
  /** 추천이 0개일 때만: Core emptyReason과 그 문장. */
  empty: { code: EmptyReason; text: string } | null;
  /** 인식했지만 연결된 Capability 규칙이 없는 기술 ID. */
  unmappedTechs: string[];
  /** 후보였지만 제외된 도구(이미 설치됨·스택·Client·OS·런타임·설치 방식). 추천 목록에 있는 도구는 넣지 않는다. */
  /**
   * addable: 제외 이유가 "이 프로젝트에서 이미 사용 중"뿐이라 다른 Client·범위에 추가를 시도할 수 있다(가능 여부는 고른 대상의
   * Core InstallPlan이 판단한다). 다른 제외 이유가 있으면 false.
   */
  excluded: { toolId: string; name: string; capabilities: string[]; codes: ExclusionCode[]; text: string; addable: boolean }[];
}

export interface ForYouView {
  projectName: string;
  scope: string;
  items: ForYouItem[];
  noCandidate: { capability: string; label: string; message: string }[];
  notice: string;
  /** metadata cache가 없을 때 한 줄 안내 */
  openScoreUnavailable: string | null;
  /** 진단(Profile이 있을 때만). */
  diagnosis: ForYouDiagnosis | null;
  /** "Registry 등록 ≠ 실행 검증" 안내. */
  verificationNotice: string;
}

const score = (n: number | null) => (n === null ? "—" : n.toFixed(2));

/** 진단·검증 표시에 쓰는 맥락. 없으면 기존 화면 데이터만 만든다. */
export interface ForYouContext {
  profile?: ProjectProfile;
  entries?: readonly RegistryEntry[];
  platform?: RecommendPlatform;
}

const OS_LABEL = { windows: "Windows", macos: "macOS", linux: "Linux" } as const;
const CLIENT_LABEL = { "claude-code": "Claude Code", codex: "Codex", cursor: "Cursor" } as const;
const VERIFY_SHORT = {
  "launch-verified": "forYou.verify.launchVerified",
  "spec-launch-verified": "forYou.verify.specLaunchVerified",
  "config-recognized": "forYou.verify.configRecognized",
  "not-verified": "forYou.verify.notVerified",
  "platform-unverified": "forYou.verify.platformUnverified",
} as const;
const EXCLUSION_KEY = {
  installed: "forYou.exclusion.installed",
  "stack-mismatch": "forYou.exclusion.stackMismatch",
  "client-unsupported": "forYou.exclusion.clientUnsupported",
  "platform-unsupported": "forYou.exclusion.platformUnsupported",
  "runtime-unsatisfied": "forYou.exclusion.runtimeUnsatisfied",
  "backend-unavailable": "forYou.exclusion.backendUnavailable",
} as const satisfies Readonly<Record<ExclusionCode, string>>;
const EMPTY_KEY = {
  "no-stack-detected": "forYou.empty.noStackDetected",
  "no-mapped-need": "forYou.empty.noMappedNeed",
  "no-verified-tool": "forYou.empty.noVerifiedTool",
  "all-satisfied": "forYou.empty.allSatisfied",
  "candidates-excluded": "forYou.empty.candidatesExcluded",
} as const satisfies Readonly<Record<EmptyReason, string>>;

/** Registry 도구 하나의 검증 한 줄. Manifest targets의 Client별 OpenHub 실행 검증 기록(검토된 tool config 표)을 그대로 쓴다. */
export function verificationLine(entry: RegistryEntry, platform: RecommendPlatform): string {
  const clients = INSTALL_CLIENTS.filter((c) => (entry.manifest.targets as readonly string[]).includes(c));
  const levels = clients.map((c) => [c, clientVerificationLevel(entry.manifest.name, c, platform)] as const);
  if (levels.length === 0 || levels.every(([, l]) => l === null)) return tr("forYou.verify.none", { os: OS_LABEL[platform] });
  const parts = levels.map(([c, l]) => CLIENT_LABEL[c] + " " + tr(l === null ? "forYou.verify.notRecorded" : VERIFY_SHORT[l]));
  return tr("forYou.verify.line", { os: OS_LABEL[platform], levels: parts.join(", ") });
}

function diagnosisOf(report: RecommendationReport, profile: ProjectProfile, entries: readonly RegistryEntry[] | undefined): ForYouDiagnosis {
  const d = diagnoseRecommendation(profile, report);
  const recommended = new Set(report.recommendations.map((r) => r.toolId));
  const byTool = new Map<string, { capabilities: string[]; codes: ExclusionCode[] }>();
  for (const need of report.needs) {
    for (const c of need.candidates) {
      if (c.excludedBy === undefined || c.excludedBy.length === 0 || recommended.has(c.toolId)) continue;
      const slot = byTool.get(c.toolId) ?? { capabilities: [], codes: [] };
      const label = capabilityText(need.capability, need.label);
      if (!slot.capabilities.includes(label)) slot.capabilities.push(label);
      for (const code of c.excludedBy) if (!slot.codes.includes(code)) slot.codes.push(code);
      byTool.set(c.toolId, slot);
    }
  }
  const excluded = [...byTool.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([toolId, slot]) => {
      const name = entries?.find((e) => e.manifest.name === toolId)?.manifest.displayName ?? toolId;
      const codes = [...slot.codes].sort((a, b) => Object.keys(EXCLUSION_KEY).indexOf(a) - Object.keys(EXCLUSION_KEY).indexOf(b));
      return {
        toolId,
        name,
        capabilities: slot.capabilities,
        codes,
        text: tr("forYou.diag.excludedLine", { name, capabilities: slot.capabilities.join(", "), reasons: codes.map((c) => tr(EXCLUSION_KEY[c])).join(" · ") }),
        addable: codes.length === 1 && codes[0] === "installed",
      };
    });
  return {
    empty: d.emptyReason === null ? null : { code: d.emptyReason, text: tr(EMPTY_KEY[d.emptyReason]) },
    unmappedTechs: d.unmappedTechs,
    excluded,
  };
}

export function buildForYouView(report: RecommendationReport, context: ForYouContext = {}): ForYouView {
  const needs = new Map(report.needs.map((n) => [n.capability, n]));
  const entryOf = (toolId: string) => context.entries?.find((e) => e.manifest.name === toolId);
  const items = report.recommendations.map((r): ForYouItem => {
    const primary = needs.get(r.primaryCapability);
    const badges: ForYouItem["badges"] = [];
    const add = (kind: BadgeKind, label: string) => {
      if (!badges.some((b) => b.label === label)) badges.push({ kind, label });
    };
    if (primary?.state === "confirmed-gap") add("confirmed", tr("forYou.badge.confirmed"));
    if (primary?.state === "likely-gap") add("likely", tr("forYou.badge.likely"));
    if (primary?.state === "unknown" || r.installation.status === "unknown") add("unknown", tr("forYou.badge.unknown"));
    if (primary?.stateReasons.includes("host-unchecked")) add("host-unchecked", tr("forYou.badge.hostUnchecked"));
    if (r.installation.status === "unidentified-present") add("unidentified", tr("forYou.badge.unidentified"));
    const entry = entryOf(r.toolId);
    return {
      rank: r.rank,
      toolId: r.toolId,
      name: r.displayName,
      capability: capabilityText(r.primaryCapability, primary?.label ?? r.primaryCapability),
      projectFit: score(r.projectFit.score),
      openScore: score(r.openScore.score),
      badges,
      reasons: r.reasons.slice(0, MAX_REASONS).map((x) => reasonText(x)),
      moreReasons: Math.max(0, r.reasons.length - MAX_REASONS),
      verification: entry === undefined || context.platform === undefined ? null : verificationLine(entry, context.platform),
    };
  });
  return {
    projectName: report.project.name,
    scope: tr(report.assessment.inspectedScopes.includes("user") ? "forYou.scope.both" : "forYou.scope.project"),
    items,
    noCandidate: report.needs
      .filter((n) => n.reasons.some((x) => x.code === "no-candidate"))
      .map((n) => ({ capability: n.capability, label: capabilityText(n.capability, n.label), message: tr("forYou.noTool") })),
    notice: openScoreNotice(),
    openScoreUnavailable: report.generatedFrom.metadataCollectedAt === null ? tr("forYou.openUnavailable") : null,
    diagnosis: context.profile === undefined ? null : diagnosisOf(report, context.profile, context.entries),
    verificationNotice: tr("forYou.verify.notice"),
  };
}
