import { PINOKIO_SUPPORTED_MAJORS, PTERM_SUPPORTED_VERSION } from "./probe";
import { ReleaseError, boundedRequest, parseJsonObject, type ReleaseFetchOptions } from "../release/fetch";

/**
 * Pinokio 호환성 재확인(TASK-068, D-033). 지원 범위는 pterm 0.0.25 정확히이며 이 모듈은 그 상수를 바꾸지 않는다.
 * - npm registry의 pterm·pinokiod 최신 버전만 읽어 보고서를 만든다(GET, registry.npmjs.org만, 1 MiB·timeout 상한, retry 없음).
 * - 지원 범위를 넓히려면 실제 protocol·entrypoint 호환성 확인과 새 Decision이 필요하다. 추측으로 넓히지 않는다.
 * - 실제 Pinokio E2E는 OPENHUB_E2E=1일 때만 실행한다(일반 CI 필수 gate 아님).
 */

export const PINOKIO_SUPPORT_NOTICE = "Pinokio support targets pterm 0.0.25. Default tests use a fake pinokiod; real Pinokio integration runs only when OPENHUB_E2E=1.";
export const PINOKIO_SUPPORT_NOTICE_KO = "Pinokio 지원은 pterm 0.0.25 기준입니다. 기본 테스트는 가짜 pinokiod를 쓰고 실제 Pinokio 연동은 OPENHUB_E2E=1일 때만 실행합니다.";
const NPM_HOSTS = ["registry.npmjs.org"] as const;
const MAX_BYTES = 1024 * 1024;

export interface PinokioCompatReport {
  schemaVersion: 1;
  kind: "openhub-pinokio-compat-report";
  checkedAt: string;
  supported: { pterm: string; pinokiodMajors: number[]; scriptMajors: number[] };
  latest: { pterm: string | null; pinokiod: string | null };
  /** npm 최신 pterm이 지원 버전과 같은지(조회 실패면 null). */
  ptermLatestIsSupported: boolean | null;
  errors: string[];
  notice: string;
}

async function latestVersion(name: string, options: ReleaseFetchOptions): Promise<{ version: string | null; error: string | null }> {
  try {
    const res = await boundedRequest("https://registry.npmjs.org/" + name + "/latest", { method: "GET", maxBytes: MAX_BYTES, allowedHosts: NPM_HOSTS }, options);
    if (res.status !== 200) return { version: null, error: name + ": HTTP " + String(res.status) };
    const v = parseJsonObject(res.body)["version"];
    return typeof v === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(v) ? { version: v, error: null } : { version: null, error: name + ": invalid version" };
  } catch (error) {
    return { version: null, error: name + ": " + (error instanceof ReleaseError ? error.code : "request-failed") };
  }
}

/** pterm·pinokiod 최신 버전 보고서. 지원 상수를 바꾸지 않는다. */
export async function pinokioCompatReport(options: ReleaseFetchOptions & { now: () => Date }): Promise<PinokioCompatReport> {
  const [pterm, pinokiod] = [await latestVersion("pterm", options), await latestVersion("pinokiod", options)];
  return {
    schemaVersion: 1,
    kind: "openhub-pinokio-compat-report",
    checkedAt: options.now().toISOString(),
    supported: { pterm: PTERM_SUPPORTED_VERSION, pinokiodMajors: [...PINOKIO_SUPPORTED_MAJORS.pinokiod], scriptMajors: [...PINOKIO_SUPPORTED_MAJORS.script] },
    latest: { pterm: pterm.version, pinokiod: pinokiod.version },
    ptermLatestIsSupported: pterm.version === null ? null : pterm.version === PTERM_SUPPORTED_VERSION,
    errors: [pterm.error, pinokiod.error].filter((e): e is string => e !== null),
    notice: "지원 범위 변경에는 실제 protocol·entrypoint 호환성 확인과 새 Decision이 필요합니다. " + PINOKIO_SUPPORT_NOTICE,
  };
}

