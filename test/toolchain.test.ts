import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const rootPkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
  engines?: { node?: string };
  devDependencies?: Record<string, string>;
};
const ci = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");

describe("REQ-002 TASK-001 toolchain", () => {
  it("AC-001-02 engines.node가 >=24.15다(개발 도구 버전 고정 검사는 internal-truth.internal.test.ts)", () => {
    expect(rootPkg.engines?.node).toBe(">=24.15");
  });

  it("AC-001-03 CI가 push와 pull_request에서 typecheck, test, registry validate를 실행한다", () => {
    expect(ci).toMatch(/push:/);
    expect(ci).toMatch(/pull_request:/);
    for (const step of ["pnpm typecheck", "pnpm test", "pnpm registry:validate"]) expect(ci).toContain(step);
  });
});
