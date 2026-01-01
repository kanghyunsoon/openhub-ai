import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const root = new URL("..", import.meta.url);
const notices = readFileSync(new URL("THIRD_PARTY_NOTICES.md", root), "utf8");

describe("REQ-010 TASK-009 제3자 라이선스 고지 (D-006)", () => {
  // pnpm licenses 호출은 환경에 따라 5~10초 걸리므로 제한 시간을 명시한다(내용 검사는 그대로).
  it("AC-009-09 THIRD_PARTY_NOTICES.md가 현재 런타임 의존성과 정확히 일치한다", { timeout: 60_000 }, () => {
    const out = execFileSync(process.execPath, ["scripts/third-party-notices.mjs", "--check"], { cwd: root, encoding: "utf8" });
    expect(out).toContain("최신");
  });

  it("AC-009-09 새 파서와 기존 런타임 의존성, 전이 의존성, Electron 방침이 모두 고지된다", () => {
    for (const name of ["smol-toml", "fast-xml-parser", "zod", "yaml", "strnum", "@nodable/entities"]) {
      expect(notices).toMatch(new RegExp(`^### ${name.replace("/", "\\/")}@`, "mu"));
    }
    expect(notices).toContain("| smol-toml | 1.9.0 | BSD-3-Clause | 직접 |");
    expect(notices).toContain("LICENSES.chromium.html");
    expect(notices).not.toMatch(/[A-Za-z]:\\Users/u);
  });
});

