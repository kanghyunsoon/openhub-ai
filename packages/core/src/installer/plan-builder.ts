import type { RecommendPlatform, RecommendationReport } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";
import { UVX_SOURCE_BUILD_DISABLED_TEXT, type UvSourceSettings } from "../process/uvx-prepare";
import { BACKEND_ADAPTERS, type BackendLaunch } from "./backends";
import { INSTALL_BACKENDS, assembleInstallPlan, registryDigestExcluding, type InstallBackend, type PlanAssemblyInput, type PlanBlocker, type PlanTargetInput, type PlannedInstall, type ProbeSnapshot } from "./plan";
import { installCandidates } from "./router";

/**
 * Plan Builder와 Router 연동(TASK-030, D-012·D-015).
 * - Manifest install 데이터와 probe 결과만으로 Adapter를 고른다. toolId로 분기하지 않는다.
 * - 후보 순서는 M1 installCandidates(preferred → fallback[0] → …)를 그대로 쓴다(CON-002).
 * - launch spec·준비 단계는 각 Adapter(backends.ts)가 만든다.
 * - fallback은 여기서만 고른다. 실행 중 backend를 바꾸지 않는다(바뀌면 재생성한 Plan digest가 달라져 PLAN_STALE).
 * - draft Manifest와 악성 command는 Plan을 만들지 않고 거부한다(CON-005).
 * - spawn·파일 읽기·process.env 접근이 없다. 입력은 모두 plain data다.
 */

export type ProbeSnapshots = Readonly<Partial<Record<InstallBackend, ProbeSnapshot>>>;

export interface PlanBuildInput {
  toolId: string;
  entries: readonly RegistryEntry[];
  report: RecommendationReport;
  probes: ProbeSnapshots;
  /** 대상 Client config(논리 경로·precondition). Config Writer(TASK-032)가 만든다. */
  targets: readonly PlanTargetInput[];
  /** Client가 실행될 플랫폼. launch spec이 플랫폼별로 달라진다(D-016). */
  platform: RecommendPlatform;
  /** tool config Tool이면 scope별 현재 상태(v0.2.0, 승인 전 확인). */
  toolConfigs?: PlanAssemblyInput["toolConfigs"];
  /** v0.2.1 uvx Prepare: 사용자 지정 패키지 index fingerprint(uvIndexFingerprint). null·생략이면 기본 index. */
  uvIndex?: string | null;
  /** v0.2.1 uvx Prepare: 환경변수와 uv.toml의 패키지 출처 설정(uvSourceSettings). 있으면 uvIndex 대신 fingerprint를 쓴다. */
  uvSource?: UvSourceSettings;
}

export type PlanBuildResult =
  | { ok: true; planned: PlannedInstall }
  | { ok: false; code: "TOOL_NOT_FOUND" | "MANIFEST_DRAFT" | "MANIFEST_COMMAND_REJECTED"; message: string };

const isSupported = (adapter: string): adapter is InstallBackend => (INSTALL_BACKENDS as readonly string[]).includes(adapter);

const probeReason = (probe: ProbeSnapshot | undefined) =>
  probe === undefined ? "not-probed" : probe.available === false ? "not-found" : probe.available === "unknown" ? "probe-" + probe.status : undefined;

export function buildInstallPlan(input: PlanBuildInput): PlanBuildResult {
  const entry = input.entries.find((e) => e.manifest.name === input.toolId);
  if (entry === undefined) return { ok: false, code: "TOOL_NOT_FOUND", message: "Registry에 없는 Tool입니다" };
  const manifest = entry.manifest;
  if (manifest.verification === "draft") return { ok: false, code: "MANIFEST_DRAFT", message: "검증되지 않은 draft Manifest는 설치하지 않습니다(CON-005)" };

  const blockers: PlanBlocker[] = [];
  if (!manifest.platform[input.platform]) blockers.push({ code: "PLATFORM_UNSUPPORTED", message: input.platform + " 플랫폼을 지원하지 않습니다" });
  for (const t of input.targets) {
    if (!(manifest.targets as readonly string[]).includes(t.client)) blockers.push({ code: "CLIENT_UNSUPPORTED", message: t.client + "는 이 Tool의 지원 대상이 아닙니다" });
  }

  const skipped: { adapter: string; reason: string }[] = [];
  let chosen: { launchable: BackendLaunch; selection: "preferred" | "fallback" } | undefined;
  let anySupported = false;
  for (const { step, source } of installCandidates(manifest)) {
    if (!isSupported(step.adapter)) {
      skipped.push({ adapter: step.adapter, reason: "unsupported-in-m4" });
      continue;
    }
    anySupported = true;
    const result = BACKEND_ADAPTERS[step.adapter].planLaunch(manifest, step, input.platform);
    if (!result.ok && result.kind === "rejected") return { ok: false, code: "MANIFEST_COMMAND_REJECTED", message: step.adapter + ": " + result.reason };
    if (!result.ok) {
      skipped.push({ adapter: step.adapter, reason: "invalid-install-data" });
      continue;
    }
    const reason = probeReason(input.probes[step.adapter]);
    if (reason !== undefined) {
      skipped.push({ adapter: step.adapter, reason });
      continue;
    }
    chosen = { launchable: result.value, selection: source };
    break;
  }

  if (chosen === undefined) {
    blockers.push(
      anySupported
        ? { code: "BACKEND_UNAVAILABLE", message: "이 PC에서 사용할 수 있는 설치 backend가 없습니다(" + skipped.map((s) => s.adapter + ": " + s.reason).join(", ") + ")" }
        : { code: "UNSUPPORTED_BACKEND", message: "M4가 지원하지 않는 설치 방식입니다(" + skipped.map((s) => s.adapter).join(", ") + ")" },
    );
  }

  const uvIndex = input.uvSource !== undefined ? input.uvSource.fingerprint : (input.uvIndex ?? null);
  const uvxSteps = (chosen?.launchable.preparation ?? []).filter((s) => s.executable === "uvx");
  blockers.push(...uvSourceBlockers(uvxSteps, input.uvSource));

  const planned = assembleInstallPlan({
    toolId: input.toolId,
    manifest,
    report: input.report,
    registryDigest: registryDigestExcluding(input.entries, input.toolId),
    backend:
      chosen === undefined
        ? null
        : { adapter: chosen.launchable.backend, selection: chosen.selection, skipped, probe: { ...(input.probes[chosen.launchable.backend] as ProbeSnapshot) } },
    artifact: chosen?.launchable.artifact ?? null,
    launch: chosen?.launchable.launch ?? null,
    preparation: (chosen?.launchable.preparation ?? []).map((s) => (s.executable === "uvx" && uvIndex !== null ? { ...s, index: { custom: true as const, digest: uvIndex } } : s)),
    targets: [...input.targets],
    blockers,
    ...(input.toolConfigs === undefined ? {} : { toolConfigs: input.toolConfigs }),
  });
  return { ok: true, planned };
}

/**
 * uvx 준비 단계의 패키지 출처 차단(v0.2.1, InstallPlan·LifecyclePlan 공통).
 * - uv 설정 파일을 확인하지 못하면 준비하지 않는다(UVX_CONFIG_UNSUPPORTED).
 * - 검토된 소스 빌드(sourceBuild 단계)는 일시 차단한다(UVX_SOURCE_BUILD_DISABLED, #45 리뷰). docs/specs/uvx-prepare.md 참고.
 */
export function uvSourceBlockers(uvxSteps: readonly { sourceBuild?: readonly unknown[] | undefined }[], source: UvSourceSettings | undefined): PlanBlocker[] {
  if (uvxSteps.length === 0) return [];
  const out: PlanBlocker[] = [];
  if (uvxSteps.some((s) => s.sourceBuild !== undefined)) out.push({ code: "UVX_SOURCE_BUILD_DISABLED", message: UVX_SOURCE_BUILD_DISABLED_TEXT });
  if (source !== undefined && source.unsupported !== null) out.push({ code: "UVX_CONFIG_UNSUPPORTED", message: source.unsupported + ". uv 설정 파일을 고친 뒤 새 계획을 만드세요" });
  return out;
}
