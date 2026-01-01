import { canonicalize, type InstallPlanV1 } from "./plan";

/**
 * PLAN_STALE 판정(TASK-028, D-012).
 * 승인한 Plan과 실행 직전에 다시 만든 Plan을 비교해 무엇이 바뀌었는지 changed[]로 알려 준다.
 * digest가 같으면 changed는 비어 있다. digest가 다르면 changed는 최소 1개다.
 */
export const PLAN_CHANGE_KINDS = ["manifest", "registry", "recommendation", "backend", "target", "config-precondition", "env-names", "steps"] as const;
export type PlanChange = (typeof PLAN_CHANGE_KINDS)[number];

const same = (a: unknown, b: unknown) => JSON.stringify(canonicalize(a)) === JSON.stringify(canonicalize(b));
const targetIdentity = (plan: InstallPlanV1) => plan.targets.map(({ precondition: _ignored, ...rest }) => rest);
const preconditions = (plan: InstallPlanV1) => plan.targets.map((t) => ({ client: t.client, scope: t.scope, precondition: t.precondition }));

export function diffInstallPlans(approved: InstallPlanV1, current: InstallPlanV1): PlanChange[] {
  const changed = new Set<PlanChange>();
  if (approved.source.manifestDigest !== current.source.manifestDigest) changed.add("manifest");
  if (approved.source.registryDigest !== current.source.registryDigest) changed.add("registry");
  if (!same(approved.source.recommendation, current.source.recommendation)) changed.add("recommendation");
  if (!same(approved.backend, current.backend) || !same(approved.artifact, current.artifact)) changed.add("backend");
  if (!same(targetIdentity(approved), targetIdentity(current))) changed.add("target");
  if (!same(preconditions(approved), preconditions(current))) changed.add("config-precondition");
  if (!same(approved.requiredEnv, current.requiredEnv)) changed.add("env-names");
  if (!same(approved.steps, current.steps) || !same(approved.launch, current.launch)) changed.add("steps");
  if (changed.size === 0 && !same(approved, current)) {
    // status·warnings·approvalRequirements 같은 파생 값만 달라졌다. 원인을 특정할 수 없으므로 실행 내용 변경으로 본다.
    changed.add(same(approved.toolId, current.toolId) && same(approved.displayName, current.displayName) ? "steps" : "manifest");
  }
  return PLAN_CHANGE_KINDS.filter((k) => changed.has(k));
}
