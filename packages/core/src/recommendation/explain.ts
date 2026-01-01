import type { EvidenceType, ProjectProfile } from "../analyzer/index";
import { EVIDENCE_WEIGHTS } from "../analyzer/index";
import type { RegistryEntry } from "../registry/index";
import type { NeedCandidate, ToolEvaluation } from "./candidates";
import type { GapAssessment, StateReason } from "./gaps";
import type { InstalledTool } from "./installed";
import type { MetadataSnapshot } from "./metadata-snapshot";
import type { OpenScoreResult, RepositorySignals } from "./open-score";
import { capabilityLabel } from "./taxonomy";

/**
 * 추천 이유(§8, CON-004). 고정 code 표와 한국어 템플릿으로만 만든다. LLM·네트워크를 쓰지 않는다.
 * 모든 이유는 refs로 실제 입력(Profile 항목·Evidence, Manifest 필드, metadata 필드, 설치 tool, Detector)을 가리킨다.
 * unknown·likely 상태에 "설치되지 않음" 같은 단정 문구를 쓰지 않는다.
 * OpenScore 관련 문구는 "저장소 활동/유지관리/커뮤니티 신호" 표현만 쓴다(보안·품질 평가가 아니다).
 */

export const REASON_CODES = [
  "need-from-evidence",
  "gap-confirmed",
  "gap-likely-host-unchecked",
  "gap-likely-partial",
  "gap-likely-environment",
  "gap-likely-unresolved",
  "gap-unknown-weak",
  "gap-unknown-detector-failed",
  "stack-match",
  "client-supported",
  "client-unverified",
  "platform-ok",
  "platform-unverified",
  "runtime-ok",
  "runtime-unverified",
  "backend-ok",
  "backend-unverified",
  "installed-unidentified",
  "installation-unknown",
  "capability-overlap",
  "setup-required-env",
  "repo-activity",
  "repo-release",
  "repo-community",
  "repo-shared",
  "repo-archived",
  "license-unknown",
  "no-candidate",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  code: ReasonCode;
  message: string;
  /** profile:<category>/<id>/<scope> · evidence:<category>/<id>/<scope>#<i> · installed:<scope>/<serverName>
   *  · manifest:<toolId>#<field> · metadata:<owner/repo>#<field> · detector:<id> */
  refs: string[];
}

const EVIDENCE_LABEL: Readonly<Record<EvidenceType, string>> = {
  dependency: "의존성",
  "build-plugin": "빌드 플러그인",
  config: "설정",
  manifest: "매니페스트",
  "docker-image": "컨테이너 이미지",
  lockfile: "잠금 파일",
  executable: "실행 파일",
  "file-presence": "파일 존재",
  "extension-count": "확장자 수",
};
const SCOPE_LABEL = { project: "프로젝트 범위", user: "사용자 범위" } as const;
const PLATFORM_LABEL = { windows: "Windows", macos: "macOS", linux: "Linux" } as const;
const RUNTIME_LABEL = { node: "Node.js", python: "Python" } as const;
const ORDER: ReadonlyMap<ReasonCode, number> = new Map(REASON_CODES.map((c, i) => [c, i]));

type Category = "languages" | "frameworks" | "databases" | "packageManagers" | "infrastructure" | "aiClients";

function profileItem(profile: ProjectProfile, category: Category, id: string, scope: string) {
  return profile[category].find((i) => i.id === id && i.scope === scope);
}

const itemRef = (category: string, id: string, scope: string) => `profile:${category}/${id}/${scope}`;
const installedRef = (t: Pick<InstalledTool, "scope" | "serverName">) => `installed:${t.scope}/${t.serverName}`;
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
/** 입력 배열 순서와 무관하게 이유 문장을 만들기 위한 항목 정렬(id → scope). */
const byIdScope = (a: { id: string; scope: string }, b: { id: string; scope: string }) => cmp(a.id, b.id) || cmp(a.scope, b.scope);

function needEvidence(profile: ProjectProfile, gap: GapAssessment): Reason | undefined {
  const source = gap.sources.find((s) => s.strength === gap.strength) ?? gap.sources[0];
  if (source === undefined) return undefined;
  const item = profileItem(profile, source.category, source.itemId, source.scope);
  if (item === undefined) return undefined;
  const ranked = item.evidence
    .map((e, i) => ({ e, i }))
    .sort((a, b) => EVIDENCE_WEIGHTS[b.e.type] - EVIDENCE_WEIGHTS[a.e.type] || a.i - b.i);
  const best = ranked[0];
  if (best === undefined) return undefined;
  return {
    code: "need-from-evidence",
    message: `${item.name}이(가) ${best.e.file}의 ${EVIDENCE_LABEL[best.e.type]}(${best.e.value})에서 탐지됨 → ${capabilityLabel(gap.capability)} 필요`,
    refs: [itemRef(source.category, item.id, item.scope), `evidence:${source.category}/${item.id}/${item.scope}#${best.i}`],
  };
}

function gapReasons(profile: ProjectProfile, gap: GapAssessment, installed: readonly InstalledTool[]): Reason[] {
  const cap = capabilityLabel(gap.capability);
  const out: Reason[] = [];
  const has = (r: StateReason) => gap.stateReasons.includes(r);
  const sourceNames = gap.sources.map((s) => profileItem(profile, s.category, s.itemId, s.scope)?.name ?? s.itemId);
  const sourceRefs = gap.sources.map((s) => itemRef(s.category, s.itemId, s.scope));
  const partialIds = profile.detectors.filter((d) => d.status === "partial").map((d) => d.id).sort(cmp);
  const failedIds = profile.detectors.filter((d) => d.status === "failed").map((d) => d.id).sort(cmp);
  const unresolved = installed.filter((t) => t.kind === "mcp-server" && t.resolution === "unresolved");
  if (gap.state === "confirmed-gap") {
    out.push({ code: "gap-confirmed", message: `${cap}을(를) 제공하는 도구가 프로젝트·사용자 범위 설정에서 탐지되지 않음`, refs: ["detector:ai-environment", "detector:host-probe"] });
  }
  if (has("host-unchecked")) out.push({ code: "gap-likely-host-unchecked", message: `${cap} 도구가 프로젝트 범위에서 탐지되지 않음(사용자 범위 미검사)`, refs: ["detector:ai-environment"] });
  if (has("detector-partial")) out.push({ code: "gap-likely-partial", message: `일부 Detector(${partialIds.join(", ")})가 부분 실패해 ${cap} 판단 수준을 낮춤`, refs: partialIds.map((id) => `detector:${id}`) });
  if (has("environment-evidence")) out.push({ code: "gap-likely-environment", message: `${sourceNames.join(", ")}은(는) 사용자 환경 근거로만 확인됨`, refs: sourceRefs });
  if (has("unresolved-installed-tools")) {
    out.push({ code: "gap-likely-unresolved", message: `식별되지 않은 MCP가 있어 ${cap} 충족 여부를 확정하지 않음`, refs: unresolved.map(installedRef) });
  }
  if (has("weak-evidence")) out.push({ code: "gap-unknown-weak", message: `${sourceNames.join(", ")} 근거가 약해(파일 존재 수준) ${cap} 필요 여부는 판단 보류`, refs: sourceRefs });
  if (has("weak-installed-match")) {
    const weak = installed.filter((t) => t.resolution === "resolved" && t.strength === "weak" && t.capabilities.includes(gap.capability));
    out.push({ code: "gap-unknown-weak", message: `${cap} 도구 설치 근거가 약해 판단 보류`, refs: weak.map(installedRef) });
  }
  if (has("detector-failed") || has("ai-environment-failed")) {
    out.push({ code: "gap-unknown-detector-failed", message: `Detector(${failedIds.join(", ")}) 실패로 ${cap} 판단 보류`, refs: failedIds.map((id) => `detector:${id}`) });
  }
  return out;
}

export interface ExplainInput {
  profile: ProjectProfile;
  evaluation: ToolEvaluation;
  primary: GapAssessment;
  installed: readonly InstalledTool[];
  openScore: OpenScoreResult;
  signals: RepositorySignals | null;
}

/** 추천 하나의 이유 목록. 순서는 REASON_CODES 표 순서다. */
export function explainRecommendation(input: ExplainInput): Reason[] {
  const { profile, evaluation, primary, installed, openScore, signals } = input;
  const toolId = evaluation.entry.manifest.name;
  const m = (field: string) => `manifest:${toolId}#${field}`;
  const c = evaluation.compatibility;
  const reasons: Reason[] = [];
  const need = needEvidence(profile, primary);
  if (need !== undefined) reasons.push(need);
  reasons.push(...gapReasons(profile, primary, installed));

  if (!c.stack.generic && c.stack.matched.length > 0) {
    const items = c.stack.matched.flatMap((id) =>
      ["frameworks", "databases", "languages", "packageManagers", "infrastructure"].flatMap((cat) => profile[cat as Category].filter((i) => i.id === id).sort(byIdScope).map((i) => ({ cat, i }))),
    );
    const names = [...new Set(items.map(({ i }) => i.name))];
    reasons.push({ code: "stack-match", message: `${names.join(", ")} 전용 도구와 프로젝트 스택이 일치`, refs: [m("recommendation.appliesTo.stacks"), ...items.map(({ cat, i }) => itemRef(cat, i.id, i.scope))] });
  }
  if (c.clients.status === "unknown") {
    reasons.push({ code: "client-unverified", message: "AI Client가 탐지되지 않아 지원 여부 미확인", refs: [m("targets")] });
  } else {
    const items = profile.aiClients.filter((i) => c.clients.supported.includes(i.id)).sort(byIdScope);
    const names = [...new Set(items.map((i) => i.name))];
    reasons.push({ code: "client-supported", message: `${names.join(", ")}에서 사용 가능`, refs: [m("targets"), ...items.map((i) => itemRef("aiClients", i.id, i.scope))] });
  }
  if (c.platform.status === "compatible" && c.platform.value !== null) {
    reasons.push({ code: "platform-ok", message: `현재 OS(${PLATFORM_LABEL[c.platform.value]})에서 지원`, refs: [m("platform")] });
  } else {
    reasons.push({ code: "platform-unverified", message: "OS 정보가 없어 지원 여부 미확인", refs: [m("platform")] });
  }
  const runtimes = (Object.entries(c.runtime.requirements) as ["node" | "python", string][]).map(([k, v]) => `${RUNTIME_LABEL[k]} ${v}`);
  if (runtimes.length > 0) {
    const refs = Object.keys(c.runtime.requirements).map((k) => m(`requirements.${k}`));
    if (c.runtime.status === "compatible") reasons.push({ code: "runtime-ok", message: `${runtimes.join(", ")} 요구사항 충족`, refs });
    else reasons.push({ code: "runtime-unverified", message: `${runtimes.join(", ")} 필요(설치된 버전 미확인)`, refs });
  }
  if (c.backend.status === "compatible") reasons.push({ code: "backend-ok", message: `설치 방식 ${c.backend.options.join("·")} 사용 가능`, refs: [m("install")] });
  else reasons.push({ code: "backend-unverified", message: `설치 방식 ${c.backend.options.join("·")}(사용 가능 여부 미확인)`, refs: [m("install")] });

  if (evaluation.installation.status === "unidentified-present") {
    const unresolved = installed.filter((t) => t.kind === "mcp-server" && t.resolution === "unresolved");
    reasons.push({
      code: "installed-unidentified",
      message: `식별되지 않은 MCP(${unresolved.map((t) => t.serverName).join(", ")})가 있어 설치 여부를 단정할 수 없음`,
      refs: unresolved.map(installedRef),
    });
  }
  if (evaluation.installation.status === "unknown") {
    reasons.push({ code: "installation-unknown", message: "설치 여부를 확인하지 못해 판단 보류", refs: ["detector:ai-environment"] });
  }
  for (const conflict of evaluation.conflicts) {
    reasons.push({
      code: "capability-overlap",
      message: `이미 설치된 ${conflict.with.serverName}(${SCOPE_LABEL[conflict.with.scope]})과 ${capabilityLabel(conflict.capability)} 기능이 겹침`,
      refs: [installedRef(conflict.with), m("capabilities")],
    });
  }
  if (evaluation.requiredEnv.length > 0) {
    reasons.push({ code: "setup-required-env", message: `환경변수 ${evaluation.requiredEnv.join(", ")} 설정 필요`, refs: [m("env")] });
  }
  if (signals !== null && openScore.status === "ok") {
    const md = (field: string) => `metadata:${signals.repository}#${field}`;
    reasons.push({
      code: "repo-activity",
      message: signals.pushedDays === null ? "저장소 push 기록 없음(저장소 활동 신호)" : `저장소 최근 push ${signals.pushedDays}일 전(저장소 활동 신호)`,
      refs: [md("pushedAt")],
    });
    reasons.push({
      code: "repo-release",
      message:
        signals.releaseDays === null
          ? "release 없음(유지관리 신호)"
          : signals.releaseDays > 365
            ? `최근 release ${signals.releaseDays}일 전, 1년 이상 지남(유지관리 신호)`
            : `최근 release ${signals.releaseDays}일 전(유지관리 신호)`,
      refs: [md("latestRelease")],
    });
    reasons.push({ code: "repo-community", message: `stars ${signals.stars}·forks ${signals.forks}(커뮤니티 신호)`, refs: [md("stars"), md("forks")] });
    if (signals.sharedRepository) {
      reasons.push({ code: "repo-shared", message: `GitHub 지표는 공유 저장소 ${signals.repository} 기준이라 커뮤니티 신호를 절반만 반영`, refs: [m("recommendation.source"), md("stars")] });
    }
    if (signals.archived) reasons.push({ code: "repo-archived", message: "저장소가 archived 상태(유지관리 신호)", refs: [md("archived")] });
    if (signals.license === null) reasons.push({ code: "license-unknown", message: "저장소 라이선스 정보를 확인할 수 없음", refs: [md("license")] });
  }
  return reasons.sort((a, b) => (ORDER.get(a.code) ?? 0) - (ORDER.get(b.code) ?? 0));
}

const EXCLUSION_LABEL: Readonly<Record<string, string>> = {
  installed: "이미 설치됨",
  "stack-mismatch": "스택 불일치",
  "client-unsupported": "AI Client 미지원",
  "platform-unsupported": "OS 미지원",
  "runtime-unsatisfied": "런타임 요구사항 불충족",
  "backend-unavailable": "설치 방식 사용 불가",
};

/** Gap 단위 이유. 충족되지 않았는데 추천할 수 있는 후보가 없으면 no-candidate. */
export function explainNeed(gap: GapAssessment, candidates: readonly NeedCandidate[]): Reason[] {
  if (gap.state === "satisfied" || candidates.some((c) => c.status === "recommended")) return [];
  const excluded = candidates.map((c) => `${c.toolId}: ${(c.excludedBy ?? []).map((e) => EXCLUSION_LABEL[e] ?? e).join("·")}`);
  return [
    {
      code: "no-candidate",
      message: `등록된 도구 없음: ${capabilityLabel(gap.capability)}을(를) 제공하는 호환 도구가 Registry에 없음${excluded.length > 0 ? ` (제외된 후보 ${excluded.join(", ")})` : ""}`,
      refs: [`need:${gap.capability}`, ...candidates.map((c) => `manifest:${c.toolId}#capabilities`)],
    },
  ];
}

export interface RefContext {
  profile: ProjectProfile;
  entries: readonly RegistryEntry[];
  snapshot: MetadataSnapshot | undefined;
  installed: readonly InstalledTool[];
  needs: readonly { capability: string }[];
}

/** reason ref가 실제 입력을 가리키는지 확인한다(테스트·M4 표시용). */
export function resolveReasonRef(ref: string, ctx: RefContext): boolean {
  const [kind, rest = ""] = ref.split(/:(.*)/su);
  if (kind === "profile" || kind === "evidence") {
    const [pathPart = "", index] = rest.split("#");
    const [category, id, scope] = pathPart.split("/");
    const items = (ctx.profile as unknown as Record<string, { id: string; scope: string; evidence: unknown[] }[]>)[category ?? ""];
    const item = items?.find((i) => i.id === id && i.scope === scope);
    if (item === undefined) return false;
    return kind === "profile" || (index !== undefined && Number(index) < item.evidence.length);
  }
  if (kind === "installed") {
    const slash = rest.indexOf("/");
    return ctx.installed.some((t) => t.scope === rest.slice(0, slash) && t.serverName === rest.slice(slash + 1));
  }
  if (kind === "manifest") {
    const [toolId, field = ""] = rest.split("#");
    const manifest = ctx.entries.find((e) => e.manifest.name === toolId)?.manifest;
    if (manifest === undefined) return false;
    let value: unknown = manifest;
    for (const key of field.split(".")) value = typeof value === "object" && value !== null ? (value as Record<string, unknown>)[key] : undefined;
    return value !== undefined;
  }
  if (kind === "metadata") {
    const [repo = "", field = ""] = rest.split("#");
    const meta = ctx.snapshot?.repositories[repo] as Record<string, unknown> | undefined;
    return meta !== undefined && field in meta;
  }
  if (kind === "detector") return ctx.profile.detectors.some((d) => d.id === rest) || rest === "host-probe";
  if (kind === "need") return ctx.needs.some((n) => n.capability === rest);
  return false;
}
