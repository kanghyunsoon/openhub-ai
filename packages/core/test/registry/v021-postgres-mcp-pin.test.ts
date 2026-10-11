import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPinnedArtifact, loadRegistry, uvxArtifact, uvxPrepareTarget } from "../../src/index";

/**
 * v0.2.1 P0-7: postgres-mcp는 mcp[cli]>=1.5.0(상한 없음)이라 빈 uv 캐시에서 mcp 2.x가 설치되어 import 오류로 시작하지 못했다
 * (Windows·Linux 실측, docs/specs/v0.2.1-registry-verification.md). Manifest는 postgres-mcp 0.3.0과 mcp 1.30.0을 정확한 버전으로
 * 고정한다. 모두 정확한 버전이라 uvx Prepare(wheel만)가 설정 쓰기 전에 uv cache를 채운다(docs/specs/uvx-prepare.md D1·D2).
 */
const { entries } = await loadRegistry(path.resolve(import.meta.dirname, "../../../../registry"));
const postgres = entries.find((e) => e.manifest.name === "postgres-mcp")!.manifest;
const tokens = String(postgres.install.options?.["command"]).split(" ");

describe("v0.2.1 postgres-mcp Manifest", () => {
  it("mcp SDK를 1.x 정확한 버전으로 고정한다(--with mcp==1.X.Y)", () => {
    const i = tokens.indexOf("--with");
    expect(i).toBeGreaterThan(0);
    expect(tokens[i + 1]).toMatch(/^mcp==1\.\d+\.\d+$/u);
  });

  it("artifact는 --from 값 postgres-mcp==0.3.0(pinned)이고 restricted 모드를 유지하며 Prepare 대상이다", () => {
    const args = tokens.slice(1);
    expect(uvxArtifact(args)).toEqual({ spec: "postgres-mcp==0.3.0", unambiguous: true });
    expect(isPinnedArtifact("uvx", uvxArtifact(args))).toBe(true);
    expect(uvxPrepareTarget(args)).toEqual({ from: "postgres-mcp==0.3.0", withPins: ["mcp==1.30.0"] });
    expect(postgres.install.options?.["prepare"]).toBeUndefined(); // wheel만(--no-build)
    expect(tokens.slice(-2)).toEqual(["postgres-mcp", "--access-mode=restricted"]);
  });

  it("serena는 serena-agent==1.7.0이고 소스 빌드는 proxy-tools 0.1.0 하나만 검토 목록에 있다", () => {
    const serena = entries.find((e) => e.manifest.name === "serena")!.manifest;
    const args = String(serena.install.options?.["command"]).split(" ").slice(1);
    expect(uvxPrepareTarget(args)).toEqual({ from: "serena-agent==1.7.0", withPins: [] });
    expect(serena.install.options?.["prepare"]).toEqual({ build: "source-build-reviewed", sourceBuild: [{ package: "proxy-tools", version: "0.1.0", source: "pypi-sdist" }] });
  });
});
