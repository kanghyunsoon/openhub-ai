import type { ProjectProfile } from "../analyzer/index";
import type { Manifest } from "../manifest/index";
import { strengthOf, strengthRank, type Strength } from "./needs";
import { STACK_CATEGORIES } from "./taxonomy";

/**
 * 후보 Tool과 현재 프로젝트·환경의 호환성(TASK-020).
 * 입력은 Profile·Manifest·RecommendContext(plain data)뿐이다. installer를 import하지 않고(CON-003)
 * process.env를 읽지 않는다. 사용 가능한 설치 backend와 runtime 버전은 호출자가 넘길 때만 판정한다.
 */

export const COMPATIBILITY_STATUSES = ["compatible", "unknown", "incompatible"] as const;
export type CompatibilityStatus = (typeof COMPATIBILITY_STATUSES)[number];

export const RECOMMEND_PLATFORMS = ["windows", "macos", "linux"] as const;
export type RecommendPlatform = (typeof RECOMMEND_PLATFORMS)[number];

export interface RecommendContext {
  platform?: RecommendPlatform;
  runtimes?: { node?: string; python?: string };
  /** 사용 가능한 설치 backend(Manifest Adapter ID). 넘기지 않으면 unknown이다. */
  availableBackends?: readonly string[];
}

/** Node.js process.platform → RecommendPlatform. 모르는 값은 undefined(unknown). */
export function toRecommendPlatform(nodePlatform: string): RecommendPlatform | undefined {
  return nodePlatform === "win32" ? "windows" : nodePlatform === "darwin" ? "macos" : nodePlatform === "linux" ? "linux" : undefined;
}

export const EXCLUSION_CODES = ["installed", "stack-mismatch", "client-unsupported", "platform-unsupported", "runtime-unsatisfied", "backend-unavailable"] as const;
export type ExclusionCode = (typeof EXCLUSION_CODES)[number];

export interface StackMatch {
  /** appliesTo.stacks가 없는 범용 tool */
  generic: boolean;
  status: CompatibilityStatus;
  matched: string[];
  strength: Strength | null;
}

export interface Compatibility {
  overall: "compatible" | "unverified" | "incompatible";
  stack: StackMatch;
  clients: { status: CompatibilityStatus; detected: string[]; supported: string[] };
  platform: { status: CompatibilityStatus; value: RecommendPlatform | null };
  runtime: { status: CompatibilityStatus; requirements: { node?: string; python?: string } };
  backend: { status: CompatibilityStatus; options: string[] };
  excludedBy: ExclusionCode[];
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function stackMatch(manifest: Manifest, profile: ProjectProfile): StackMatch {
  const stacks = manifest.recommendation?.appliesTo?.stacks;
  if (stacks === undefined) return { generic: true, status: "compatible", matched: [], strength: null };
  const items = STACK_CATEGORIES.flatMap((c) => profile[c]).filter((i) => stacks.includes(i.id));
  if (items.length === 0) return { generic: false, status: "incompatible", matched: [], strength: null };
  const strength = items.map((i) => strengthOf(i.confidence)).reduce<Strength>((best, s) => (strengthRank(s) > strengthRank(best) ? s : best), "weak");
  return { generic: false, status: "compatible", matched: [...new Set(items.map((i) => i.id))].sort(cmp), strength };
}

type Version = [number, number, number];

function parseVersion(text: string): Version | undefined {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/u.exec(text.trim());
  if (m === null) return undefined;
  return [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)];
}

function compareVersion(a: Version, b: Version): number {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** ">=20.19", ">=3.11,<3.15" 같은 범위 검사. 해석할 수 없으면 undefined(unknown). */
export function satisfiesRange(version: string, range: string): boolean | undefined {
  const v = parseVersion(version);
  if (v === undefined) return undefined;
  const parts = range.split(/[\s,]+/u).filter(Boolean);
  if (parts.length === 0) return undefined;
  for (const part of parts) {
    const m = /^(>=|<=|>|<|=)?(\d+(?:\.\d+){0,2})$/u.exec(part);
    if (m === null) return undefined;
    const target = parseVersion(m[2] as string) as Version;
    const c = compareVersion(v, target);
    const op = m[1] ?? "=";
    const ok = op === ">=" ? c >= 0 : op === "<=" ? c <= 0 : op === ">" ? c > 0 : op === "<" ? c < 0 : c === 0;
    if (!ok) return false;
  }
  return true;
}

function combine(statuses: readonly CompatibilityStatus[]): CompatibilityStatus {
  if (statuses.includes("incompatible")) return "incompatible";
  if (statuses.includes("unknown")) return "unknown";
  return "compatible";
}

/** Manifest install 데이터에서 설치 backend 후보를 읽는다(installer 모듈을 쓰지 않는다). */
export function installBackends(manifest: Manifest): string[] {
  return [...new Set([manifest.install.preferredAdapter, ...manifest.install.fallback.map((s) => s.adapter)])];
}

export function evaluateCompatibility(manifest: Manifest, profile: ProjectProfile, context: RecommendContext = {}): Compatibility {
  const stack = stackMatch(manifest, profile);

  const detected = [...new Set(profile.aiClients.map((c) => c.id))].sort(cmp);
  const supported = detected.filter((c) => (manifest.targets as readonly string[]).includes(c));
  const clientStatus: CompatibilityStatus = detected.length === 0 ? "unknown" : supported.length === 0 ? "incompatible" : "compatible";

  const platform = context.platform ?? null;
  const platformStatus: CompatibilityStatus = platform === null ? "unknown" : manifest.platform[platform] ? "compatible" : "incompatible";

  const requirements: { node?: string; python?: string } = {};
  const runtimeStatuses: CompatibilityStatus[] = [];
  for (const key of ["node", "python"] as const) {
    const range = manifest.requirements[key];
    if (range === undefined) continue;
    requirements[key] = range;
    const version = context.runtimes?.[key];
    const ok = version === undefined ? undefined : satisfiesRange(version, range);
    runtimeStatuses.push(ok === undefined ? "unknown" : ok ? "compatible" : "incompatible");
  }
  const runtimeStatus = combine(runtimeStatuses);

  const options = installBackends(manifest);
  const backendStatus: CompatibilityStatus =
    context.availableBackends === undefined ? "unknown" : options.some((o) => context.availableBackends?.includes(o)) ? "compatible" : "incompatible";

  const excludedBy: ExclusionCode[] = [];
  if (stack.status === "incompatible") excludedBy.push("stack-mismatch");
  if (clientStatus === "incompatible") excludedBy.push("client-unsupported");
  if (platformStatus === "incompatible") excludedBy.push("platform-unsupported");
  if (runtimeStatus === "incompatible") excludedBy.push("runtime-unsatisfied");
  if (backendStatus === "incompatible") excludedBy.push("backend-unavailable");
  const all = combine([stack.status, clientStatus, platformStatus, runtimeStatus, backendStatus]);
  return {
    overall: all === "incompatible" ? "incompatible" : all === "unknown" ? "unverified" : "compatible",
    stack,
    clients: { status: clientStatus, detected, supported },
    platform: { status: platformStatus, value: platform },
    runtime: { status: runtimeStatus, requirements },
    backend: { status: backendStatus, options },
    excludedBy,
  };
}
