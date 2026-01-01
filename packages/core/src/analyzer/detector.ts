import type { AiClientId, AiToolKind, AnalysisWarning, Evidence, ProfileCategory, Scope } from "./profile";

/**
 * Detector가 읽는 Scan 결과. Root 밖 접근·비밀 파일·크기 제한 같은 안전 규칙은 구현체(TASK-009 Scanner)가 책임진다.
 * Detector는 이 인터페이스만 보고 파일 시스템을 직접 만지지 않는다.
 */
export interface ScanContext {
  /** Root 기준 POSIX 상대 경로, 정렬됨. 제외 디렉터리·Root 밖 링크는 이미 빠져 있다. */
  readonly files: readonly string[];
  /** Root 바로 아래에 있었지만 제외 규칙으로 탐색하지 않은 항목 이름(예: ".git"). 내용은 읽지 않는다. */
  readonly rootExcluded: readonly string[];
  hasFile(file: string): boolean;
  /** 안전하게 읽을 수 있으면 텍스트, 아니면 undefined(사유는 경고로 남는다). */
  readText(file: string): Promise<string | undefined>;
  /** 구조화 파서 결과. 읽기·해석에 실패하면 undefined이며 원문은 경고에 남기지 않는다. */
  readJson(file: string): Promise<unknown>;
  readYaml(file: string): Promise<unknown>;
  readToml(file: string): Promise<unknown>;
  readXml(file: string): Promise<unknown>;
}

/** Detector가 내는 탐지 하나. confidence는 Detector가 정하지 않고 Evidence에서 계산된다. */
export interface Finding {
  category: ProfileCategory;
  id: string;
  name: string;
  scope: Scope;
  evidence: Evidence[];
  /** aiTools 전용 */
  kind?: AiToolKind;
  /** aiTools 전용 */
  clients?: AiClientId[];
}

export interface DetectionResult {
  findings: Finding[];
  warnings?: AnalysisWarning[];
  /** 일부 입력을 해석하지 못했지만 나머지는 탐지했다면 true → status "partial". */
  partial?: boolean;
}

export interface ProjectDetector {
  readonly id: string;
  supports(ctx: ScanContext): boolean;
  detect(ctx: ScanContext): Promise<DetectionResult>;
}

/** Detector 등록부. 등록 순서와 무관하게 결과는 Profile 단계에서 정렬된다. */
export class DetectorRegistry {
  readonly #detectors: readonly ProjectDetector[];

  constructor(detectors: readonly ProjectDetector[]) {
    const seen = new Set<string>();
    for (const d of detectors) {
      if (seen.has(d.id)) throw new Error(`Detector '${d.id}'가 두 번 등록되었습니다`);
      seen.add(d.id);
    }
    this.#detectors = [...detectors];
  }

  list(): readonly ProjectDetector[] {
    return this.#detectors;
  }

  get size(): number {
    return this.#detectors.length;
  }
}
