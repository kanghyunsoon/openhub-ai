import path from "node:path";
import { describe, expect, it } from "vitest";
import { recommendationReportSchema } from "@openhub/core";
import { runCli } from "../src/cli";
import { memoryIO } from "./helpers";

/**
 * v0.2.0 P0-1: project recommend 사람용 출력이 "추천 없음"의 이유와 추천으로 이어지지 않은 기술을 설명한다.
 * --json 보고서(RecommendationReport v1)에는 진단을 넣지 않는다.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const PROJECTS = path.join(REPO, "packages/core/test/fixtures/projects");

async function human(name: string): Promise<string> {
  const x = Object.assign(memoryIO(REPO), { metadataSnapshot: null, platform: "linux" });
  expect(await runCli(["project", "recommend", path.join(PROJECTS, name)], x)).toBe(0);
  return x.stdout.join("\n");
}

describe("project recommend 결과 진단(v0.2.0 P0-1)", () => {
  it("README 언급만 있으면 스택을 인식하지 못했다고 설명한다", async () => {
    expect(await human("readme-mentions")).toContain("(추천할 도구 없음) 언어·프레임워크·DB·인프라를 인식하지 못했습니다");
  });

  it("Verified 도구가 없는 need만 있으면 그렇게 설명한다(C# 소스 없는 Unity 에디터 프로젝트)", async () => {
    const out = await human("unity-editor-only");
    expect(out).toContain("(추천할 도구 없음) 필요한 Capability는 있지만 Verified Registry에 해당 도구가 없습니다");
    expect(out).toContain("후보 없는 Gap");
  });

  it("Kubernetes 프로젝트는 read-only로 설치되는 Kubernetes MCP Server를 추천한다(v0.2.0 P0-2 batch 1)", async () => {
    const out = await human("k8s-deploy");
    expect(out).toMatch(/Kubernetes MCP Server \(kubernetes-mcp-server\)/u);
    expect(out).not.toContain("(추천할 도구 없음)");
  });

  it("Jest만 있으면 연결 규칙이 없는 기술로 보여준다", async () => {
    const out = await human("jest-app");
    expect(out).toContain("추천으로 연결되지 않은 기술");
    expect(out).toMatch(/- jest: 연결된 Capability 규칙이 없습니다/u);
  });

  it("Go·Express·NestJS·Unity·Unreal을 분석해 추천 또는 이유를 보여준다", async () => {
    expect(await human("go-service")).toMatch(/Serena \(serena\)/u);
    expect(await human("express-postgres-ts")).toMatch(/postgres-mcp/u);
    expect(await human("nestjs-app")).toMatch(/context7/u);
    for (const name of ["unity-game", "unreal-game"]) expect(await human(name)).toContain("후보 없는 Gap");
  });

  it("--json 보고서는 RecommendationReport v1 그대로이며 진단 필드가 없다", async () => {
    const x = Object.assign(memoryIO(REPO), { metadataSnapshot: null, platform: "linux" });
    expect(await runCli(["project", "recommend", path.join(PROJECTS, "readme-mentions"), "--json"], x)).toBe(0);
    const json = JSON.parse(x.stdout.join("\n")) as Record<string, unknown>;
    expect(recommendationReportSchema.parse(json).schemaVersion).toBe(1);
    expect(Object.keys(json)).not.toContain("diagnosis");
    expect(x.stdout.join("\n")).not.toContain("emptyReason");
  });
});
