import type { ProjectProfile, Scope } from "../analyzer/index";
import type { RegistryEntry } from "../registry/index";
import { evaluateCompatibility, type Compatibility, type ExclusionCode, type RecommendContext } from "./compatibility";
import type { GapAssessment } from "./gaps";
import { installationStatus, isSatisfyingInstall, type InstallationStatus, type InstalledTool } from "./installed";

/**
 * Gap별 Registry 후보 검색(TASK-020).
 * - 충족되지 않은 need: 그 capability를 선언한 Manifest 전체(toolId 오름차순)
 * - 충족된 need: 그 need를 충족한 설치 tool(status installed)
 * 후보 status는 tool 단위다: resolved 설치면 installed, 호환되지 않으면 incompatible, 아니면 recommended.
 */

export const CANDIDATE_STATUSES = ["recommended", "incompatible", "installed"] as const;
export type CandidateStatus = (typeof CANDIDATE_STATUSES)[number];

export interface NeedCandidate {
  toolId: string;
  status: CandidateStatus;
  excludedBy?: ExclusionCode[];
}

export interface Conflict {
  type: "capability-overlap";
  capability: string;
  with: { toolId: string | null; serverName: string; scope: Scope };
}

export interface ToolEvaluation {
  entry: RegistryEntry;
  status: CandidateStatus;
  compatibility: Compatibility;
  installation: { status: InstallationStatus; inspectedScopes: Scope[] };
  /** 이 tool이 덮는 충족되지 않은 Gap(capability ID 오름차순) */
  covers: GapAssessment[];
  conflicts: Conflict[];
  requiredEnv: string[];
}

export interface CandidateMatch {
  /** capability → 후보 목록 */
  candidates: Map<string, NeedCandidate[]>;
  /** 추천 대상(recommended이고 covers가 있는 tool), toolId 오름차순 */
  tools: ToolEvaluation[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function matchCandidates(
  profile: ProjectProfile,
  gaps: readonly GapAssessment[],
  installed: readonly InstalledTool[],
  entries: readonly RegistryEntry[],
  context: RecommendContext = {},
): CandidateMatch {
  const sorted = [...entries].sort((a, b) => cmp(a.manifest.name, b.manifest.name));
  const evaluations = new Map<string, ToolEvaluation>();
  const evaluate = (entry: RegistryEntry): ToolEvaluation => {
    const known = evaluations.get(entry.manifest.name);
    if (known !== undefined) return known;
    const { manifest } = entry;
    const compatibility = evaluateCompatibility(manifest, profile, context);
    const isInstalled = installed.some((t) => t.toolId === manifest.name && isSatisfyingInstall(t));
    const status: CandidateStatus = isInstalled ? "installed" : compatibility.overall === "incompatible" ? "incompatible" : "recommended";
    const conflicts: Conflict[] = [];
    for (const capability of [...manifest.capabilities].sort(cmp)) {
      for (const t of installed) {
        if (t.toolId === manifest.name || !isSatisfyingInstall(t) || !t.capabilities.includes(capability)) continue;
        conflicts.push({ type: "capability-overlap", capability, with: { toolId: t.toolId, serverName: t.serverName, scope: t.scope } });
      }
    }
    const evaluation: ToolEvaluation = {
      entry,
      status,
      compatibility,
      installation: installationStatus(manifest.name, profile, installed),
      covers: [],
      conflicts: conflicts.sort((a, b) => cmp(a.capability, b.capability) || cmp(a.with.serverName, b.with.serverName) || cmp(a.with.scope, b.with.scope)),
      requiredEnv: manifest.env.filter((e) => e.required).map((e) => e.name).sort(cmp),
    };
    evaluations.set(manifest.name, evaluation);
    return evaluation;
  };

  const candidates = new Map<string, NeedCandidate[]>();
  for (const gap of [...gaps].sort((a, b) => cmp(a.capability, b.capability))) {
    const list: NeedCandidate[] = [];
    if (gap.state === "satisfied") {
      const ids = [...new Set(gap.satisfiedBy.map((s) => s.toolId))].sort(cmp);
      for (const id of ids) list.push({ toolId: id, status: "installed", excludedBy: ["installed"] });
    } else {
      for (const entry of sorted) {
        if (!entry.manifest.capabilities.includes(gap.capability)) continue;
        const e = evaluate(entry);
        if (e.status === "recommended") {
          e.covers.push(gap);
          list.push({ toolId: entry.manifest.name, status: "recommended" });
        } else {
          list.push({ toolId: entry.manifest.name, status: e.status, excludedBy: e.status === "installed" ? ["installed"] : [...e.compatibility.excludedBy] });
        }
      }
    }
    candidates.set(gap.capability, list);
  }
  const tools = [...evaluations.values()].filter((e) => e.status === "recommended" && e.covers.length > 0).sort((a, b) => cmp(a.entry.manifest.name, b.entry.manifest.name));
  return { candidates, tools };
}
