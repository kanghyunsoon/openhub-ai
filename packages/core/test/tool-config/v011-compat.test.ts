import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  installPlanDigest,
  installPlanSchema,
  lifecyclePlanDigest,
  lifecyclePlanSchema,
  lifecycleStateFileSchema,
  parseLifecycleState,
  serializeInstallPlan,
  serializeLifecyclePlan,
  serializeLifecycleState,
} from "../../src/index";
import { REPO_ROOT } from "../recommendation/helpers";

/**
 * v0.2.0 tool config가 추가한 선택 필드(InstallPlan·LifecyclePlan의 tool-config 단계·node command·repair, Version State toolConfig)는
 * schemaVersion 1을 유지한다. v0.1.1 tag의 실제 golden(같은 byte 사본)이 새 코드에서 그대로 해석되고 같은 byte·digest로 다시 직렬화되는지 확인한다.
 */
const dir = path.join(REPO_ROOT, "test", "fixtures", "v0.1.1-compat");
/**
 * v0.1.1 golden은 실행마다 바뀌는 값(projectKey·stateDigest)을 가려 둔 형태다. 가린 자리에 고정된 실제 형식 값을 넣어
 * 실제 저장 데이터로 복원한다(그 밖의 byte는 v0.1.1 그대로).
 */
const PROJECT_KEY = "0123456789abcdef";
const STATE_DIGEST = "sha256:" + "5".repeat(64);
const read = (name: string) =>
  readFileSync(path.join(dir, name), "utf8")
    .replaceAll("<projectKey>", PROJECT_KEY)
    .replace(/<stateDigest:[^>]*>/gu, STATE_DIGEST);

describe("v0.1.1 저장 데이터 호환(schemaVersion 1)", () => {
  it("v0.1.1 InstallPlan은 새 schema를 통과하고 같은 byte·digest로 직렬화된다", () => {
    const text = read("install-plan-memory.json");
    const plan = installPlanSchema.parse(JSON.parse(text));
    expect(serializeInstallPlan(plan)).toBe(text);
    expect(installPlanDigest(plan)).toBe(installPlanDigest(JSON.parse(text)));
    expect(plan.steps.some((s) => s.kind === "tool-config")).toBe(false);
  });

  it("v0.1.1 LifecyclePlan은 새 schema를 통과하고 같은 byte·digest로 직렬화된다", () => {
    const text = read("lifecycle-plan-memory.json");
    const plan = lifecyclePlanSchema.parse(JSON.parse(text));
    expect(serializeLifecyclePlan(plan)).toBe(text);
    expect(lifecyclePlanDigest(plan)).toBe(lifecyclePlanDigest(JSON.parse(text)));
  });

  it("v0.1.1 Version State 파일(toolConfig 없음)은 그대로 읽히고 같은 byte로 다시 쓰인다", () => {
    const text = read("lifecycle-state-memory.json");
    const parsed = parseLifecycleState(Buffer.from(text, "utf8"));
    if (!parsed.ok) throw new Error(parsed.code);
    expect(Object.values(parsed.state.entries).every((e) => e.toolConfig === undefined)).toBe(true);
    expect(serializeLifecycleState(lifecycleStateFileSchema.parse(JSON.parse(text)))).toBe(text);
  });
});

