import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject, diagnoseRecommendation, recommend } from "../src/index";
import { goModulePath } from "../src/analyzer/detectors/languages";
import { seedEntries } from "./recommendation/helpers";

/** v0.2.0 P0-1 보완: go.mod module 지시문 판별과 환경 정보(Docker·Compose) 진단 제외. */
const seed = await seedEntries();
const FIXTURES = path.resolve(import.meta.dirname, "fixtures/projects");

describe("goModulePath: Go module 지시문만 인정한다", () => {
  it.each([
    ["module example.com/app", "example.com/app"],
    ["module example.com/app/sub", "example.com/app/sub"],
    ['module "example.com/quoted"', "example.com/quoted"],
    ["module example.com/app // trailing comment", "example.com/app"],
    ["// header\n\nmodule example.com/app\n\ngo 1.22\n", "example.com/app"],
    ["module\texample.com/tab", "example.com/tab"],
    ["module myapp", "myapp"],
    ["module github.com/acme/v2+build", "github.com/acme/v2+build"],
  ])("유효: %j", (text, expected) => {
    expect(goModulePath(text)).toBe(expected);
  });

  it.each([
    ["modulefoo example.com/app"],
    ["module123"],
    ["modulefoo"],
    ["// module example.com/commented"],
    ["go 1.22\nrequire example.com/x v1.0.0\n"],
    [""],
    ["module"],
    ["module /abs/path"],
    ["module example.com//double"],
    ["module example.com/../escape"],
    ["module example.com/./dot"],
    ["module example.com/app/"],
    ["module .hidden/app"],
    ["module example.com/app extra"],
    ['module "example.com/app'],
    ["module example.com/a b"],
    ["module example.com:8080/app"],
    ["module user@example.com/app"],
    ["module (\n\texample.com/block\n)"],
  ])("무효: %j", (text) => {
    expect(goModulePath(text)).toBeUndefined();
  });

  it("modulefoo 줄 다음의 정상 지시문은 인정한다", () => {
    expect(goModulePath("modulefoo bar\nmodule example.com/real\n")).toBe("example.com/real");
  });

  it("module 지시문이 없거나 잘못된 go.mod는 Go를 file-presence(낮은 신뢰도)로만 남긴다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhub-gomod-"));
    try {
      await writeFile(path.join(root, "go.mod"), "modulefoo example.com/app\ngo 1.22\n");
      const r = await analyzeProject(root);
      if (!r.ok) throw new Error(r.error.code);
      const go = r.profile.languages.find((l) => l.id === "go");
      expect(go?.evidence.map((e) => e.type + "|" + e.value)).toEqual(["file-presence|go.mod"]);
      expect(go?.confidence).toBeLessThan(0.9);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("결과 진단: Docker·Docker Compose는 환경 정보라 '연결 규칙 없음'에 넣지 않는다", () => {
  it("docker-project: docker·docker-compose가 unmappedTechs에 없다", async () => {
    const r = await analyzeProject(path.join(FIXTURES, "docker-project"));
    if (!r.ok) throw new Error(r.error.code);
    expect(r.profile.infrastructure.map((i) => i.id)).toEqual(["docker", "docker-compose"]);
    const d = diagnoseRecommendation(r.profile, recommend(r.profile, seed, undefined, { platform: "linux" }));
    expect(d.unmappedTechs).not.toContain("docker");
    expect(d.unmappedTechs).not.toContain("docker-compose");
  });

  it("Docker만 있는 프로젝트는 목록에서 빠져도 추천이 빈 이유(no-mapped-need)는 숨기지 않는다", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhub-docker-only-"));
    try {
      await writeFile(path.join(root, "Dockerfile"), "FROM alpine:3.20\n");
      await writeFile(path.join(root, "compose.yaml"), "services:\n  app:\n    build: .\n");
      const r = await analyzeProject(root);
      if (!r.ok) throw new Error(r.error.code);
      const report = recommend(r.profile, seed, undefined, { platform: "linux" });
      expect(report.recommendations).toEqual([]);
      expect(diagnoseRecommendation(r.profile, report)).toEqual({ emptyReason: "no-mapped-need", unmappedTechs: [], needsWithoutVerifiedTool: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Docker를 진단 목록에서 빼도 검증 도구가 없는 실제 need는 계속 보인다(Docker + Unity 에디터 프로젝트)", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "openhub-docker-unity-"));
    try {
      await mkdir(path.join(root, "ProjectSettings"), { recursive: true });
      await writeFile(path.join(root, "ProjectSettings", "ProjectVersion.txt"), "m_EditorVersion: 6000.0.23f1\n");
      await writeFile(path.join(root, "Dockerfile"), "FROM alpine:3.20\n");
      const r = await analyzeProject(root);
      if (!r.ok) throw new Error(r.error.code);
      const d = diagnoseRecommendation(r.profile, recommend(r.profile, seed, undefined, { platform: "linux" }));
      expect(d).toEqual({ emptyReason: "no-verified-tool", unmappedTechs: [], needsWithoutVerifiedTool: ["game-engine-editor"] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("Kubernetes need는 Docker와 함께 있어도 그대로 이어지고 이제 검증 도구가 있다(P0-2 batch 1)", async () => {
    const r = await analyzeProject(path.join(FIXTURES, "k8s-deploy"));
    if (!r.ok) throw new Error(r.error.code);
    const d = diagnoseRecommendation(r.profile, recommend(r.profile, seed, undefined, { platform: "linux" }));
    expect(d).toEqual({ emptyReason: null, unmappedTechs: [], needsWithoutVerifiedTool: [] });
  });
});
