import { DetectorRegistry, type ProjectDetector } from "./detector";
import { defaultDetectors } from "./detectors/index";
import { probeHost, type HostEnvironment } from "./host-probe";
import { buildProfile, validateFinding, type DetectorRun } from "./merge";
import { analysisWarningSchema, containsAbsolutePath, type AnalysisWarning, type ProjectProfile } from "./profile";
import { DetectorScanView, scanProject, type ScanErrorCode, type ScanLimits } from "./scanner";

export interface AnalyzeOptions {
  /** 지정하지 않으면 defaultDetectors(). 테스트는 fake Detector를 주입한다. */
  detectors?: readonly ProjectDetector[];
  limits?: Partial<ScanLimits>;
  /**
   * 사용자 범위 Host Probe(D-003). 기본 OFF. true 또는 테스트용 환경을 넘길 때만 실행한다.
   * 결과는 scope "user"로 project 결과와 분리된다.
   */
  includeHost?: boolean | Partial<HostEnvironment>;
}

export type AnalyzeResult =
  | { ok: true; profile: ProjectProfile }
  | { ok: false; error: { code: ScanErrorCode; message: string } };

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Scanner → DetectorRegistry → Detector(격리 실행) → Evidence 병합 → Profile 검증.
 * - Detector는 id 순서로 실행해 등록 순서와 무관하게 같은 결과를 만든다.
 * - 파일 읽기·해석 경고는 파일당 한 번(Detector 미귀속)만 남고, 그 파일을 읽으려던 Detector는 모두 partial이 된다.
 * - 이 파이프라인은 project scope만 받는다. user scope는 Host Probe(TASK-016)만 만든다.
 * - Detector 하나의 예외·계약 위반은 그 Detector만 failed로 만들고 나머지 결과는 유지한다.
 */
export async function analyzeProject(root: string, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
  const scan = await scanProject(root, options.limits === undefined ? {} : { limits: options.limits });
  if (!scan.ok) return { ok: false, error: scan.error };
  const ctx = scan.context;
  const registry = new DetectorRegistry(options.detectors ?? defaultDetectors());
  const runs: DetectorRun[] = [];

  for (const detector of [...registry.list()].sort((a, b) => cmp(a.id, b.id))) {
    const view = new DetectorScanView(ctx);
    const run = await runDetector(detector, view);
    if (run.status === "ok" && view.touchedFailure) run.status = "partial";
    runs.push(run);
  }
  if (options.includeHost !== undefined && options.includeHost !== false) {
    runs.push(await runHostProbe(options.includeHost === true ? {} : options.includeHost));
  }
  return { ok: true, profile: buildProfile(ctx.projectName, runs, ctx.warnings) };
}

async function runHostProbe(env: Partial<HostEnvironment>): Promise<DetectorRun> {
  const id = "host-probe";
  try {
    const result = await probeHost(env);
    const invalid = result.findings.some((f) => f.scope !== "user" || validateFinding(f) !== undefined);
    if (invalid) {
      return { id, status: "failed", findings: [], warnings: [{ code: "detector-invalid-output", detector: id, message: "Host Probe 출력이 Profile 계약을 위반해 결과를 제외했습니다" }] };
    }
    const warnings = result.warnings.map((w) => ({ ...w, detector: id }));
    return { id, status: warnings.length > 0 ? "partial" : "ok", findings: result.findings, warnings };
  } catch {
    return { id, status: "failed", findings: [], warnings: [{ code: "detector-failed", detector: id, message: "Host Probe 실행 중 오류가 발생해 결과를 제외했습니다" }] };
  }
}

async function runDetector(detector: ProjectDetector, ctx: Parameters<ProjectDetector["detect"]>[0]): Promise<DetectorRun> {
  const failed = (code: string, message: string): DetectorRun => ({
    id: detector.id,
    status: "failed",
    findings: [],
    warnings: [{ code, message, detector: detector.id }],
  });
  let result;
  try {
    if (!detector.supports(ctx)) return { id: detector.id, status: "ok", findings: [], warnings: [] };
    result = await detector.detect(ctx);
  } catch {
    // 예외 메시지에는 경로·비밀값이 섞일 수 있어 고정 문구만 남긴다.
    return failed("detector-failed", "Detector 실행 중 오류가 발생해 이 Detector의 결과를 제외했습니다");
  }
  const problems: string[] = [];
  for (const f of result.findings) {
    if (f.scope !== "project") problems.push(`${f.category}/${f.id}: project 분석은 scope "project" 결과만 받을 수 있습니다`);
    const issue = validateFinding(f);
    if (issue !== undefined) problems.push(`${f.category}/${String(f.id)}: ${issue}`);
  }
  const warnings: AnalysisWarning[] = [];
  for (const w of result.warnings ?? []) {
    const parsed = analysisWarningSchema.safeParse({ ...w, detector: detector.id });
    const leaks = [w.message, w.file ?? ""].some(containsAbsolutePath);
    if (!parsed.success || leaks) problems.push("경고 형식이 계약에 맞지 않습니다");
    else warnings.push(parsed.data);
  }
  if (problems.length > 0) {
    return failed("detector-invalid-output", `Detector 출력이 Profile 계약을 위반해 결과를 제외했습니다: ${problems.slice(0, 3).join(" | ")}`);
  }
  return { id: detector.id, status: result.partial === true ? "partial" : "ok", findings: result.findings, warnings };
}
