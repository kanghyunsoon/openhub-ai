import { z } from "zod";
import { parseImageRef } from "../lifecycle/resolver";
import type { ToolStateCore } from "../lifecycle/state";
import { parseNpmSpec } from "../installer/command";
import { INSTALL_BACKENDS, canonicalize } from "../installer/plan";
import type { Manifest } from "../manifest/index";
import { satisfiesRange } from "../recommendation/compatibility";
import type { ReleaseEntry, ReleaseSnapshotV1 } from "../release/snapshot";
import { comparePep440, compareSemver, isPep440Prerelease, parsePep440, parseSemver, type Pep440, type SemVer } from "../release/version";

/**
 * UpdateImpact v1(TASK-050, D-024). "current → target으로 올릴 때 무엇이 변하는가"를 결정론 규칙으로만 판정한다.
 * - 판정: none < low < medium < unknown < high. 가장 높은 단계를 쓰되 unknown은 high가 없을 때만이다.
 *   REQ-042의 OK/WARNING: none·low = OK, medium·unknown·high = WARNING.
 * - 입력은 Version State 항목, 현재 config 항목의 env 이름, 현재(목표) Manifest, 목표 ReleaseSnapshot, probe runtime 버전,
 *   (있으면) 업데이트 Plan이 만들 목표 launch뿐이다. project 소스·env 값은 읽지 않는다(env는 이름만).
 * - LLM 요약을 쓰지 않는다(summary-llm import 0). LifecyclePlan에 들어가지 않으며 Plan byte·승인 요구를 바꾸지 않는다.
 * - M3 evaluateCompatibility(ProjectCompatibility: Tool이 프로젝트에 맞는가)와 이름·모듈을 분리한다.
 * - 같은 입력이면 입력 배열 순서와 무관하게 같은 byte다(reasons·evidence 정렬).
 */

export const UPDATE_IMPACT_SCHEMA_VERSION = 1 as const;
export const IMPACT_VERDICTS = ["none", "low", "medium", "unknown", "high"] as const;
export type ImpactVerdict = (typeof IMPACT_VERDICTS)[number];
export const IMPACT_REASON_CODES = [
  "version-major",
  "version-minor-zero",
  "version-minor",
  "version-patch",
  "version-prerelease",
  "version-incomparable",
  "digest-only",
  "target-yanked",
  "target-deprecated",
  "notes-breaking",
  "notes-migration",
  "notes-mcp-protocol",
  "env-added",
  "env-removed",
  "backend-changed",
  "launch-args-changed",
  "runtime-unsatisfied",
  "runtime-unverified",
  "client-dropped",
] as const;
export type ImpactReasonCode = (typeof IMPACT_REASON_CODES)[number];
export const IMPACT_EVIDENCE_KINDS = ["version", "registry", "release-note", "env", "backend", "launch", "runtime", "client"] as const;
/** release note 근거는 코드마다 이 수까지만 남긴다. */
export const IMPACT_NOTE_EVIDENCE_LIMIT = 20;

const LEVEL: Readonly<Record<ImpactReasonCode, ImpactVerdict>> = {
  "version-major": "high",
  "version-minor-zero": "high",
  "version-minor": "low",
  "version-patch": "low",
  "version-prerelease": "medium",
  "version-incomparable": "unknown",
  "digest-only": "unknown",
  "target-yanked": "high",
  "target-deprecated": "medium",
  "notes-breaking": "high",
  "notes-migration": "medium",
  "notes-mcp-protocol": "medium",
  "env-added": "high",
  "env-removed": "low",
  "backend-changed": "high",
  "launch-args-changed": "medium",
  "runtime-unsatisfied": "high",
  "runtime-unverified": "unknown",
  "client-dropped": "high",
};
const RANK: Readonly<Record<ImpactVerdict, number>> = { none: 0, low: 1, medium: 2, unknown: 3, high: 4 };

const NOTE_RULES: readonly (readonly [ImpactReasonCode, RegExp])[] = [
  ["notes-breaking", /\bbreaking\b|\bremov(?:ed|es|al)\b/iu],
  ["notes-migration", /\bmigrat(?:e|es|ed|ion|ions|ing)\b|\bconfig(?:uration)?(?: file)? format\b/iu],
  ["notes-mcp-protocol", /\bmcp protocol\b|\bmodel context protocol\b|\bprotocol ?version\b|\bprotocolversion\b|\bmcp spec(?:ification)?\b/iu],
];

const text = z.string().min(1).max(300);
const evidenceSchema = z.strictObject({ kind: z.enum(IMPACT_EVIDENCE_KINDS), source: text, ref: text });
export type ImpactEvidence = z.output<typeof evidenceSchema>;
const side = z.strictObject({ version: z.string().min(1).max(100).nullable(), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/u).nullable() });

export const updateImpactSchema = z.strictObject({
  schemaVersion: z.literal(UPDATE_IMPACT_SCHEMA_VERSION),
  toolId: text,
  from: side,
  to: side,
  verdict: z.enum(IMPACT_VERDICTS),
  /** REQ-042 표시: none·low = OK, 그 밖 = WARNING */
  status: z.enum(["OK", "WARNING"]),
  reasons: z.array(z.strictObject({ code: z.enum(IMPACT_REASON_CODES), level: z.enum(IMPACT_VERDICTS) })),
  evidence: z.array(evidenceSchema),
  /** 영향받는 설정 파일(Version State target의 논리 경로) */
  affectedFiles: z.array(text),
});
export type UpdateImpactV1 = z.output<typeof updateImpactSchema>;

export interface UpdateImpactInput {
  /** 현재 Version State 항목(ArtifactIdentity·requested·clientSpec·backend·target) */
  state: ToolStateCore;
  /** 현재 config 항목에 있는 env 이름(값은 받지 않는다) */
  configEnvNames: readonly string[];
  /** 현재 Registry Manifest(업데이트 후 적용될 Manifest) */
  manifest: Manifest;
  /** 목표 ReleaseSnapshot */
  snapshot: ReleaseSnapshotV1;
  /** probe runtime 버전(없으면 확인 불가) */
  runtimes?: { node?: string | null; python?: string | null };
  /** 업데이트 Plan이 만들 목표 launch(없으면 Manifest 기준으로 backend만 본다) */
  targetLaunch?: { backend: (typeof INSTALL_BACKENDS)[number]; clientSpec: { command: string; args: readonly string[] } } | null;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

interface Signal {
  code: ImpactReasonCode;
  evidence: ImpactEvidence[];
}

type Parsed = { kind: "semver"; v: SemVer } | { kind: "pep440"; v: Pep440 };
function parseFor(snapshot: ReleaseSnapshotV1, backend: string, version: string | null): Parsed | null {
  if (version === null) return null;
  const pep = snapshot.versionSource === "pypi" || (snapshot.versionSource === "github-release" && backend === "uvx");
  if (pep) {
    const v = parsePep440(version);
    return v === null ? null : { kind: "pep440", v };
  }
  const v = parseSemver(version);
  return v === null ? null : { kind: "semver", v };
}
const parts = (p: Parsed): [number, number, number] => (p.kind === "semver" ? [p.v.major, p.v.minor, p.v.patch] : [p.v.release[0] ?? 0, p.v.release[1] ?? 0, p.v.release[2] ?? 0]);
const isPre = (p: Parsed) => (p.kind === "semver" ? p.v.pre.length > 0 : isPep440Prerelease(p.v));
const compareParsed = (a: Parsed, b: Parsed) => (a.kind === "semver" && b.kind === "semver" ? compareSemver(a.v, b.v) : a.kind === "pep440" && b.kind === "pep440" ? comparePep440(a.v, b.v) : 0);

function versionSignals(input: UpdateImpactInput): Signal[] {
  const { snapshot, state } = input;
  const target = snapshot.target;
  const ref = (v: string | null) => v ?? "unknown";
  const ev = (code: ImpactReasonCode): Signal => ({ code, evidence: [{ kind: "version", source: snapshot.versionSource, ref: ref(snapshot.current.version) + " -> " + ref(target?.version ?? null) }] });
  if (target === null || !snapshot.selection.comparable) return [ev("version-incomparable")];
  const cur = parseFor(snapshot, state.backend, snapshot.current.version);
  const tgt = parseFor(snapshot, state.backend, target.version);
  if (cur === null || tgt === null) {
    const digestChanged = snapshot.current.digest !== null && target.digest !== null && snapshot.current.digest !== target.digest;
    return [ev(digestChanged ? "digest-only" : "version-incomparable")];
  }
  const c = compareParsed(cur, tgt);
  if (c === 0) {
    const digestChanged = snapshot.current.digest !== null && target.digest !== null && snapshot.current.digest !== target.digest;
    return digestChanged ? [ev("digest-only")] : [];
  }
  if (c > 0) return [];
  const out: Signal[] = [];
  const [cm, cn, cp] = parts(cur);
  const [tm, tn, tp] = parts(tgt);
  if (tm !== cm) out.push(ev("version-major"));
  else if (tn !== cn) out.push(ev(cm === 0 ? "version-minor-zero" : "version-minor"));
  else out.push(ev("version-patch"));
  if (isPre(tgt) && !isPre(cur)) out.push(ev("version-prerelease"));
  return out;
}

function entriesOf(snapshot: ReleaseSnapshotV1): ReleaseEntry[] {
  const list = snapshot.between.length > 0 ? snapshot.between : snapshot.target === null ? [] : [snapshot.target];
  const seen = new Set<string>();
  return list.filter((e) => (seen.has(e.version) ? false : (seen.add(e.version), true)));
}

function registrySignals(snapshot: ReleaseSnapshotV1): Signal[] {
  const t = snapshot.target;
  if (t === null) return [];
  const out: Signal[] = [];
  if (t.yanked) out.push({ code: "target-yanked", evidence: [{ kind: "registry", source: snapshot.versionSource, ref: t.version + " yanked" }] });
  if (t.deprecated !== null) out.push({ code: "target-deprecated", evidence: [{ kind: "registry", source: snapshot.versionSource, ref: t.version + " deprecated" }] });
  return out;
}

function noteSignals(snapshot: ReleaseSnapshotV1): Signal[] {
  const found = new Map<ImpactReasonCode, ImpactEvidence[]>();
  for (const entry of entriesOf(snapshot)) {
    if (entry.notes === null) continue;
    entry.notes.text.split(/\r\n|\n|\r/u).forEach((line, i) => {
      for (const [code, re] of NOTE_RULES) {
        if (!re.test(line)) continue;
        const list = found.get(code) ?? [];
        list.push({ kind: "release-note", source: entry.version, ref: "line " + String(i + 1) });
        found.set(code, list);
      }
    });
  }
  return [...found].map(([code, evidence]) => ({ code, evidence: sortEvidence(evidence).slice(0, IMPACT_NOTE_EVIDENCE_LIMIT) }));
}

function envSignals(input: UpdateImpactInput): Signal[] {
  const config = new Set(input.configEnvNames);
  const declared = new Set(input.manifest.env.map((e) => e.name));
  const required = input.manifest.env.filter((e) => e.required).map((e) => e.name);
  const added = [...new Set(required.filter((n) => !config.has(n)))].sort(cmp);
  const removed = [...config].filter((n) => !declared.has(n)).sort(cmp);
  const out: Signal[] = [];
  if (added.length > 0) out.push({ code: "env-added", evidence: added.map((n) => ({ kind: "env", source: "manifest", ref: n })) });
  if (removed.length > 0) out.push({ code: "env-removed", evidence: removed.map((n) => ({ kind: "env", source: "config", ref: n })) });
  return out;
}

/** artifact 토큰(패키지·이미지 spec)을 같은 자리표시로 바꿔 artifact 외 인자만 비교한다. */
function normalizeArgs(state: ToolStateCore, command: string, args: readonly string[]): string[] {
  const requested = state.artifact.requested;
  const npmName = parseNpmSpec(requested)?.name ?? null;
  const pyName = requested.split("==")[0]!.trim();
  const imageRepo = parseImageRef(requested)?.repo ?? null;
  const isArtifact = (token: string) => {
    if (token === requested || token === state.artifact.resolved?.spec) return true;
    if (state.backend === "npx") return npmName !== null && parseNpmSpec(token)?.name === npmName;
    if (state.backend === "uvx") return token === pyName || token.startsWith(pyName + "==");
    return imageRepo !== null && parseImageRef(token)?.repo === imageRepo;
  };
  return [command, ...args.map((a) => (isArtifact(a) ? "<artifact>" : a))];
}

function launchSignals(input: UpdateImpactInput): Signal[] {
  const { state, manifest, targetLaunch } = input;
  const out: Signal[] = [];
  const adapters = [manifest.install.preferredAdapter, ...manifest.install.fallback.map((s) => s.adapter)] as string[];
  const targetBackend = targetLaunch?.backend ?? (adapters.includes(state.backend) ? state.backend : manifest.install.preferredAdapter);
  if (targetBackend !== state.backend) out.push({ code: "backend-changed", evidence: [{ kind: "backend", source: "manifest", ref: state.backend + " -> " + targetBackend }] });
  if (targetLaunch !== undefined && targetLaunch !== null) {
    const before = normalizeArgs(state, state.launch.clientSpec.command, state.launch.clientSpec.args);
    const after = normalizeArgs(state, targetLaunch.clientSpec.command, targetLaunch.clientSpec.args);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      let i = 0;
      while (i < Math.min(before.length, after.length) && before[i] === after[i]) i += 1;
      out.push({ code: "launch-args-changed", evidence: [{ kind: "launch", source: "client-spec", ref: i === 0 ? "command" : "arg " + String(i) }] });
    }
  }
  return out;
}

function runtimeSignals(input: UpdateImpactInput): Signal[] {
  const key = input.state.backend === "npx" ? "node" : input.state.backend === "uvx" ? "python" : null;
  if (key === null) return [];
  const range = input.snapshot.target?.runtime[key] ?? input.manifest.requirements[key] ?? null;
  if (range === null) return [];
  const probe = input.runtimes?.[key] ?? null;
  const ok = probe === null ? undefined : satisfiesRange(probe, range);
  const evidence: ImpactEvidence[] = [{ kind: "runtime", source: key, ref: (range + " vs " + (probe ?? "unknown")).slice(0, 300) }];
  if (ok === false) return [{ code: "runtime-unsatisfied", evidence }];
  if (ok === undefined) return [{ code: "runtime-unverified", evidence }];
  return [];
}

function clientSignals(input: UpdateImpactInput): Signal[] {
  const client = input.state.target.client;
  return (input.manifest.targets as readonly string[]).includes(client) ? [] : [{ code: "client-dropped", evidence: [{ kind: "client", source: "manifest", ref: client }] }];
}

function sortEvidence(list: readonly ImpactEvidence[]): ImpactEvidence[] {
  const key = (e: ImpactEvidence) => [e.kind, e.source, e.ref.replace(/\d+/gu, (d) => d.padStart(8, "0"))].join("\u0000");
  const seen = new Set<string>();
  return [...list].sort((a, b) => cmp(key(a), key(b))).filter((e) => {
    const k = e.kind + "\u0000" + e.source + "\u0000" + e.ref;
    return seen.has(k) ? false : (seen.add(k), true);
  });
}

/** 업데이트 영향을 결정론 규칙으로 판정한다. LifecyclePlan을 바꾸지 않는다. */
export function analyzeUpdateImpact(input: UpdateImpactInput): UpdateImpactV1 {
  const signals = [...versionSignals(input), ...registrySignals(input.snapshot), ...noteSignals(input.snapshot), ...envSignals(input), ...launchSignals(input), ...runtimeSignals(input), ...clientSignals(input)];
  const codes = [...new Set(signals.map((s) => s.code))];
  const verdict = codes.reduce<ImpactVerdict>((best, code) => (RANK[LEVEL[code]] > RANK[best] ? LEVEL[code] : best), "none");
  const order = (code: ImpactReasonCode) => IMPACT_REASON_CODES.indexOf(code);
  const reasons = codes.map((code) => ({ code, level: LEVEL[code] })).sort((a, b) => RANK[b.level] - RANK[a.level] || order(a.code) - order(b.code));
  const target = input.snapshot.target;
  return updateImpactSchema.parse({
    schemaVersion: UPDATE_IMPACT_SCHEMA_VERSION,
    toolId: input.state.toolId,
    from: { version: input.snapshot.current.version, digest: input.snapshot.current.digest },
    to: { version: target?.version ?? null, digest: target?.digest ?? null },
    verdict,
    status: RANK[verdict] <= RANK.low ? "OK" : "WARNING",
    reasons,
    evidence: sortEvidence(signals.flatMap((s) => s.evidence)),
    affectedFiles: [input.state.target.file],
  });
}

export function serializeUpdateImpact(impact: UpdateImpactV1): string {
  return JSON.stringify(canonicalize(updateImpactSchema.parse(impact)), null, 2) + "\n";
}

