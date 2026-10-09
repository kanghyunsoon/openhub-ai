import type { ProjectDetector } from "../detector";
import { aiEnvironmentDetector } from "./ai-environment";
import { databaseDetector, frameworkDetector } from "./frameworks";
import { infrastructureDetector } from "./infrastructure";
import { kubernetesDetector } from "./kubernetes";
import { languageDetector, packageManagerDetector } from "./languages";

/**
 * 기본 Project Detector 목록. 새 Detector는 파일을 추가하고 여기에 등록만 한다.
 * Analyzer(analyze.ts)는 개별 Detector 구현을 알지 못한다.
 */
export function defaultDetectors(): ProjectDetector[] {
  return [languageDetector, packageManagerDetector, frameworkDetector, databaseDetector, infrastructureDetector, kubernetesDetector, aiEnvironmentDetector];
}
