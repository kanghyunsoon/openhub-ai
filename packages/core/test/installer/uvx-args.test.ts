import { describe, expect, it } from "vitest";
import { parseUvxArgs, pythonRequirementName, uvxAdapter, type InstallStep } from "../../src/index";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.1 #39 2차 리뷰: uvx 인자 해석(uvx 0.12.3 clap 규칙, 실측)과 설치기의 형식 거부.
 * - 식별: --from=X·-wX·-w=X·-qw X·--with a,b·위치 인자 name@ver·-- 뒤 명령까지 패키지를 정확히 꺼낸다.
 * - 설치기: 식별할 수 없는 형식(URL·경로·VCS·파일·--with-editable·--with-requirements·알 수 없는 옵션)과 OpenHub가 다루지 않는
 *   형식(=로 붙여 쓰기·쉼표 목록·짧은 옵션 붙여 쓰기·플래그 묶음·--)은 MANIFEST_COMMAND_REJECTED. 띄어 쓴 형식은 그대로다.
 */
const postgres = (await seedEntries()).find((e) => e.manifest.name === "postgres-mcp")!.manifest;
const planWith = (command: string) => {
  const step: InstallStep = { adapter: "uvx", options: { command } };
  return uvxAdapter.planLaunch({ ...postgres, install: { preferredAdapter: "uvx", options: { command }, fallback: [] } }, step, "linux");
};

describe("v0.2.1 #39: uvx 인자 해석", () => {
  it("uvx가 받는 형식에서 패키지를 정확히 꺼낸다", () => {
    const cases: [string[], string[], boolean][] = [
      [["--from", "a==1.0.0", "--with", "b==2.0.0", "a"], ["a==1.0.0", "b==2.0.0"], true],
      [["--no-build", "--from", "a==1.0.0", "a"], ["a==1.0.0"], true],
      [["--from=a==1.0.0", "a"], ["a==1.0.0"], false],
      [["--with=b==2.0.0", "a"], ["a", "b==2.0.0"], false],
      [["-w", "b", "a"], ["a", "b"], true],
      [["-wb==2.0.0", "a"], ["a", "b==2.0.0"], false],
      [["-w=b", "a"], ["a", "b"], false],
      [["-qw", "b", "a"], ["a", "b"], false],
      [["-qwb", "a"], ["a", "b"], false],
      [["--with", "b,c==1.0.0", "a"], ["a", "b", "c==1.0.0"], false],
      [["a@1.0.0"], ["a@1.0.0"], true],
      [["--", "a"], ["a"], false],
      [["-p", "3.12", "--from", "a==1.0.0", "a", "--with", "not-a-package"], ["a==1.0.0"], true],
      [["--python=3.12", "a"], ["a"], false],
    ];
    for (const [args, packages, canonical] of cases) {
      const r = parseUvxArgs(args);
      expect(r, args.join(" ")).toMatchObject({ ok: true, packages, canonical });
    }
  });

  it("식별할 수 없는 형식은 해석 실패다", () => {
    for (const args of [
      ["--from", "git+https://github.com/x/y", "y"],
      ["--from", "y@https://example.invalid/y.whl", "y"],
      ["--from", "./y", "y"],
      ["--with", "y-1.0.0-py3-none-any.whl", "a"],
      ["--with-editable", "y", "a"],
      ["--with-requirements=req.txt", "a"],
      ["--fro", "a==1.0.0", "a"],
      ["-x", "a"],
      ["--from"],
      ["--no-build=yes", "a"],
      [],
    ]) {
      expect(parseUvxArgs(args), args.join(" ")).toMatchObject({ ok: false });
    }
    expect(pythonRequirementName("Serena_Agent[x]==1.7.0")).toBe("Serena_Agent");
    expect(pythonRequirementName("serena-agent@1.7.0")).toBe("serena-agent");
    expect(pythonRequirementName("serena-agent @ git+https://x")).toBeNull();
  });
});

describe("v0.2.1 #39: 설치기는 해석할 수 없거나 표준이 아닌 uvx 형식을 거부한다", () => {
  it("띄어 쓴 형식(실제 Registry 명령 포함)은 그대로 계획한다", () => {
    expect(planWith(String(postgres.install.options!["command"]))).toMatchObject({ ok: true });
    expect(planWith("uvx --from code-nav==1.0.0 --with dep==2.0.0 code-nav --access-mode=restricted")).toMatchObject({ ok: true });
    expect(planWith("uvx code-nav")).toMatchObject({ ok: true });
    expect(planWith("uvx -p 3.12 --from code-nav==1.0.0 code-nav")).toMatchObject({ ok: true });
  });

  it("붙여 쓰기·쉼표 목록·플래그 묶음·--·식별 불가 형식·알 수 없는 옵션은 MANIFEST 거부(rejected)다", () => {
    for (const command of [
      "uvx --from=code-nav==1.0.0 code-nav",
      "uvx --with=dep==2.0.0 code-nav",
      "uvx -wdep code-nav",
      "uvx -w=dep code-nav",
      "uvx -qw dep code-nav",
      "uvx --with dep,dep2 code-nav",
      "uvx -- code-nav",
      "uvx --from git+https://github.com/x/code-nav code-nav",
      "uvx --with-editable dep code-nav",
      "uvx --with-requirements req.txt code-nav",
      "uvx --unknown-option code-nav",
    ]) {
      expect(planWith(command), command).toMatchObject({ ok: false, kind: "rejected" });
    }
  });
});
