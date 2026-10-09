import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";
import {
  DEFAULT_METADATA_CACHE,
  analyzeProject,
  capabilityLabel,
  diagnoseRecommendation,
  fingerprintServers,
  formatRegistryIssue,
  identityHintsFrom,
  loadMetadataSnapshot,
  loadRegistry,
  readConfiguredServers,
  recommend,
  serializeRecommendationReport,
  toRecommendPlatform,
  type HostEnvironment,
  type MetadataSnapshot,
  type ProjectDetector,
  type RecommendationDiagnosis,
  type RecommendationReport,
} from "@openhub/core";
import { metadataOf, registryDirOf } from "./paths";

/**
 * openhub project recommend <path> [--json] [--include-host] (TASK-025)
 * 설치하지 않는다(M4 범위). 네트워크를 호출하지 않으며 OpenScore는 로컬 metadata cache(openhub collect)만 읽는다.
 */

export interface RecommendCommandIO {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  detectors?: readonly ProjectDetector[];
  hostEnvironment?: Partial<HostEnvironment>;
  /** 테스트용 metadata snapshot 주입. null이면 cache 없음으로 취급한다. 생략하면 ./.openhub-cache/metadata.json을 읽는다. */
  metadataSnapshot?: MetadataSnapshot | null;
  /** 테스트용 OS 주입(process.platform 형식). */
  platform?: string;
}

export const OPEN_SCORE_NOTICE = "OpenScore는 저장소 유지관리·활동성·커뮤니티 신호이며 보안·코드 품질 평가가 아닙니다";

const STATE_LABEL: Readonly<Record<string, string>> = {
  "confirmed-gap": "confirmed-gap",
  "likely-gap": "likely-gap",
  unknown: "판단 보류",
  satisfied: "충족",
};
const SCOPE_LABEL: Readonly<Record<string, string>> = { project: "프로젝트", user: "사용자" };
const score = (n: number | null) => (n === null ? "—" : n.toFixed(2));

/** 추천이 비었을 때의 이유(v0.2.0 P0-1). 보고서 계약은 바꾸지 않고 사람용 출력에만 쓴다. */
const EMPTY_REASON_LABEL: Readonly<Record<NonNullable<RecommendationDiagnosis["emptyReason"]>, string>> = {
  "no-stack-detected": "언어·프레임워크·DB·인프라를 인식하지 못했습니다(README 언급은 근거로 쓰지 않습니다)",
  "no-mapped-need": "인식한 기술에 연결된 Capability 규칙이 없습니다",
  "no-verified-tool": "필요한 Capability는 있지만 Verified Registry에 해당 도구가 없습니다",
  "all-satisfied": "필요한 Capability가 모두 설치된 도구로 충족됐습니다",
  "candidates-excluded": "후보 도구가 호환성·설치 상태로 모두 제외됐습니다",
};

export function formatRecommendations(report: RecommendationReport, diagnosis?: RecommendationDiagnosis): string[] {
  const lines = [`OpenHub Recommendations — ${report.project.name}`, ""];
  const userInspected = report.assessment.inspectedScopes.includes("user");
  lines.push(`검사 범위  ${userInspected ? "프로젝트 + 사용자" : "프로젝트 (사용자 범위 미검사 — --include-host로 확인)"}`);
  const installed = report.installedTools.filter((t) => t.kind === "mcp-server");
  lines.push(
    `설치된 MCP  ${installed.length === 0 ? "(탐지 안 됨)" : installed.map((t) => `${t.serverName}${t.toolId === null ? " [식별 안 됨]" : ` → ${t.toolId}`} (${SCOPE_LABEL[t.scope]})`).join(", ")}`,
  );
  if (report.assessment.unresolvedInstalledTools > 0) lines.push(`  식별되지 않은 MCP ${report.assessment.unresolvedInstalledTools}개가 있어 Gap을 confirmed로 단정하지 않습니다`);
  lines.push("", "추천");
  if (report.recommendations.length === 0) {
    const reason = diagnosis?.emptyReason;
    lines.push(reason === undefined || reason === null ? "  (추천할 도구 없음)" : `  (추천할 도구 없음) ${EMPTY_REASON_LABEL[reason]}`);
  }
  for (const r of report.recommendations) {
    const primary = r.covers.find((c) => c.capability === r.primaryCapability);
    lines.push(`${String(r.rank).padStart(2)}. ${r.displayName} (${r.toolId})  [${STATE_LABEL[primary?.state ?? ""]} · ${primary?.priority} · ${capabilityLabel(r.primaryCapability)}]`);
    lines.push(`    Project Fit ${score(r.projectFit.score)} · OpenScore ${score(r.openScore.score)}`);
    lines.push(`    Capability  ${r.covers.map((c) => capabilityLabel(c.capability)).join(", ")}`);
    for (const reason of r.reasons.slice(0, 3)) lines.push(`    - ${reason.message}`);
    if (r.reasons.length > 3) lines.push(`    … 이유 ${r.reasons.length - 3}개 더 (--json)`);
  }
  const satisfied = report.needs.filter((n) => n.state === "satisfied");
  if (satisfied.length > 0) {
    lines.push("", "충족된 Capability");
    for (const n of satisfied) lines.push(`  - ${n.label}: ${n.satisfiedBy.map((s) => `${s.serverName} (${SCOPE_LABEL[s.scope]})`).join(", ")}`);
  }
  const noCandidate = report.needs.filter((n) => n.reasons.some((x) => x.code === "no-candidate"));
  if (noCandidate.length > 0) {
    lines.push("", "후보 없는 Gap");
    for (const n of noCandidate) lines.push(`  - ${n.label} [${STATE_LABEL[n.state]}]: ${n.reasons[0]?.message}`);
  }
  if (diagnosis !== undefined && diagnosis.unmappedTechs.length > 0) {
    lines.push("", "추천으로 연결되지 않은 기술");
    lines.push(`  - ${diagnosis.unmappedTechs.join(", ")}: 연결된 Capability 규칙이 없습니다`);
  }
  if (report.assessment.warnings.length > 0) {
    lines.push("", `Warnings (${report.assessment.warnings.length})`);
    for (const w of report.assessment.warnings) lines.push(`  - [${w.code}] ${w.message}`);
  }
  lines.push("", OPEN_SCORE_NOTICE);
  if (report.generatedFrom.metadataCollectedAt === null) lines.push("OpenScore —: metadata cache가 없어 계산하지 않았습니다(openhub collect로 수집)");
  return lines;
}

/** 종료 코드: 0 성공, 1 분석·추천 불가, 2 인자 오류 */
export async function runRecommend(argv: readonly string[], io: RecommendCommandIO, usage: string): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: { json: { type: "boolean", default: false }, "include-host": { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    io.err(`추천할 프로젝트 경로를 하나 지정하세요\n\n${usage}`);
    return 2;
  }
  const analysis = await analyzeProject(path.resolve(io.cwd, parsed.positionals[0] as string), {
    ...(io.detectors === undefined ? {} : { detectors: io.detectors }),
    // 사용자 범위 탐지는 --include-host를 명시했을 때만 실행한다(D-003).
    ...(parsed.values["include-host"] ? { includeHost: io.hostEnvironment ?? true } : {}),
  });
  if (!analysis.ok) {
    io.err(`추천할 수 없습니다: 프로젝트를 분석하지 못했습니다 (${analysis.error.code})`);
    return 1;
  }
  const { entries, issues } = await loadRegistry(registryDirOf(io));
  for (const issue of issues) io.err(`경고: ${formatRegistryIssue(issue)}`);
  const snapshot = io.metadataSnapshot === undefined ? (await metadataOf(io)).snapshot : (io.metadataSnapshot ?? undefined);
  const platform = toRecommendPlatform(io.platform ?? process.platform);
  // Identity Fingerprint(D-026): project config는 기본, user config는 --include-host일 때만 읽는다. exact·strong만 hint가 된다.
  const includeUser = parsed.values["include-host"];
  const servers = await readConfiguredServers({
    projectRoot: path.resolve(io.cwd, parsed.positionals[0] as string),
    homeDir: io.hostEnvironment?.homeDir ?? os.homedir(),
    includeUser,
  }).catch(() => []);
  const identityHints = identityHintsFrom(fingerprintServers(servers, entries));
  let report: RecommendationReport;
  try {
    report = recommend(analysis.profile, entries, snapshot, platform === undefined ? {} : { platform }, { identityHints });
  } catch {
    io.err("추천할 수 없습니다: 추천 결과가 보고서 계약을 통과하지 못했습니다 (report-invalid)");
    return 1;
  }
  if (parsed.values.json) {
    io.out(serializeRecommendationReport(report).trimEnd());
    return 0;
  }
  for (const line of formatRecommendations(report, diagnoseRecommendation(analysis.profile, report))) io.out(line);
  return 0;
}
