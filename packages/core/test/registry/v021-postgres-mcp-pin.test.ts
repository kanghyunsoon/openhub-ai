import path from "node:path";
import { describe, expect, it } from "vitest";
import { isPinnedArtifact, loadRegistry, uvxArtifact } from "../../src/index";

/**
 * v0.2.1 P0-7: postgres-mcp는 mcp[cli]>=1.5.0(상한 없음)이라 빈 uv 캐시에서 mcp 2.x가 설치되어 import 오류로 시작하지 못했다
 * (Windows·Linux 실측, docs/specs/v0.2.1-registry-verification.md). Manifest는 mcp를 1.x 정확한 버전으로 고정하고,
 * artifact(--from 값)는 그대로 postgres-mcp(버전 미고정)다.
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

  it("artifact는 --from 값 postgres-mcp이고 버전 미고정(floating)이며 restricted 모드를 유지한다", () => {
    const args = tokens.slice(1);
    expect(uvxArtifact(args)).toEqual({ spec: "postgres-mcp", unambiguous: true });
    expect(isPinnedArtifact("uvx", uvxArtifact(args))).toBe(false);
    expect(tokens.slice(-2)).toEqual(["postgres-mcp", "--access-mode=restricted"]);
  });
});
