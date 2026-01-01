/**
 * 버전 비교(TASK-047, D-022). npm·Docker tag는 SemVer 2.0, PyPI는 PEP 440 공개 버전 규칙을 쓴다.
 * 비교할 수 없는 문자열은 null을 돌려준다(추측하지 않는다).
 */

export interface SemVer {
  major: number;
  minor: number;
  patch: number;
  pre: readonly string[];
}

const SEMVER = /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

export function parseSemver(text: string): SemVer | null {
  const m = SEMVER.exec(text.trim());
  if (m === null) return null;
  const nums = [m[1], m[2], m[3]].map(Number);
  if (nums.some((n) => !Number.isSafeInteger(n))) return null;
  return { major: nums[0]!, minor: nums[1]!, patch: nums[2]!, pre: m[4] === undefined ? [] : m[4].split(".") };
}

/** SemVer 정규 문자열(앞 v·build metadata 제거). */
export function semverText(v: SemVer): string {
  return v.major + "." + v.minor + "." + v.patch + (v.pre.length === 0 ? "" : "-" + v.pre.join("."));
}

function cmpIdent(a: string, b: string): number {
  const an = /^\d+$/u.test(a);
  const bn = /^\d+$/u.test(b);
  if (an && bn) return Math.sign(Number(a) - Number(b));
  if (an) return -1;
  if (bn) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

export function compareSemver(a: SemVer, b: SemVer): number {
  const core = Math.sign(a.major - b.major) || Math.sign(a.minor - b.minor) || Math.sign(a.patch - b.patch);
  if (core !== 0) return core;
  if (a.pre.length === 0 || b.pre.length === 0) return a.pre.length === b.pre.length ? 0 : a.pre.length === 0 ? 1 : -1;
  for (let i = 0; i < Math.max(a.pre.length, b.pre.length); i += 1) {
    if (a.pre[i] === undefined) return -1;
    if (b.pre[i] === undefined) return 1;
    const c = cmpIdent(a.pre[i]!, b.pre[i]!);
    if (c !== 0) return c;
  }
  return 0;
}

export interface Pep440 {
  release: readonly number[];
  pre: { phase: "a" | "b" | "rc"; n: number } | null;
  post: number | null;
  dev: number | null;
}

const PEP440 = /^v?(\d+(?:\.\d+)*)(?:[-_.]?(a|b|rc|alpha|beta|c|pre|preview)[-_.]?(\d*))?(?:(?:[-_.]?(?:post|rev|r)[-_.]?(\d*))|-(\d+))?(?:[-_.]?dev[-_.]?(\d*))?$/iu;

export function parsePep440(text: string): Pep440 | null {
  const m = PEP440.exec(text.trim());
  if (m === null) return null;
  const release = m[1]!.split(".").map(Number);
  if (release.some((n) => !Number.isSafeInteger(n))) return null;
  const phaseRaw = m[2]?.toLowerCase();
  const phase = phaseRaw === undefined ? null : phaseRaw === "alpha" ? "a" : phaseRaw === "beta" ? "b" : phaseRaw === "a" || phaseRaw === "b" ? phaseRaw : "rc";
  return {
    release,
    pre: phase === null ? null : { phase, n: Number(m[3] || "0") },
    post: m[4] !== undefined ? Number(m[4] || "0") : m[5] !== undefined ? Number(m[5]) : null,
    dev: m[6] !== undefined ? Number(m[6] || "0") : null,
  };
}

const PHASE = { a: 1, b: 2, rc: 3 } as const;

export function comparePep440(a: Pep440, b: Pep440): number {
  const len = Math.max(a.release.length, b.release.length);
  for (let i = 0; i < len; i += 1) {
    const c = Math.sign((a.release[i] ?? 0) - (b.release[i] ?? 0));
    if (c !== 0) return c;
  }
  // dev만 있는 버전(X.devN) < pre < 정식 < post
  const phase = (v: Pep440) => (v.pre !== null ? PHASE[v.pre.phase] : v.post === null && v.dev !== null ? 0 : 4);
  const p = Math.sign(phase(a) - phase(b));
  if (p !== 0) return p;
  if (a.pre !== null && b.pre !== null) {
    const n = Math.sign(a.pre.n - b.pre.n);
    if (n !== 0) return n;
  }
  const post = Math.sign((a.post ?? -1) - (b.post ?? -1));
  if (post !== 0) return post;
  if (a.dev === null || b.dev === null) return a.dev === b.dev ? 0 : a.dev === null ? 1 : -1;
  return Math.sign(a.dev - b.dev);
}

export const isPep440Prerelease = (v: Pep440) => v.pre !== null || v.dev !== null;

