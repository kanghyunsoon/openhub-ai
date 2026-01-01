import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProject, type ProjectProfile } from "../src/index";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openhub-lang-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}

async function analyze(): Promise<ProjectProfile> {
  const r = await analyzeProject(root);
  if (!r.ok) throw new Error(r.error.code);
  return r.profile;
}

const ids = (items: { id: string; confidence: number }[]) => Object.fromEntries(items.map((i) => [i.id, i.confidence]));
const ev = (items: { id: string; evidence: { file: string; type: string; value: string }[] }[], id: string) =>
  items.find((i) => i.id === id)?.evidence.map((e) => `${e.file}|${e.type}|${e.value}`);

describe("REQ-010 Language · Package Manager Detection", () => {
  it("AC-010-01 Manifest·Build 설정으로 7개 언어를 탐지하고 확장자 개수는 보조 Evidence로만 쓴다", async () => {
    await put({
      "web/package.json": JSON.stringify({ devDependencies: { typescript: "5" } }),
      "web/tsconfig.base.json": "{ /* jsonc */ }",
      "api/pyproject.toml": "[project]\nname='api'\n",
      "api/requirements-dev.txt": "pytest\n",
      "svc/pom.xml": "<project><modelVersion>4.0.0</modelVersion></project>",
      "svc2/build.gradle.kts": "plugins { java }",
      "tool/Tool.csproj": "<Project Sdk=\"Microsoft.NET.Sdk\"></Project>",
      "native/Cargo.toml": "[package]\nname='n'\n",
      "game/Game.uproject": JSON.stringify({ Modules: [{ Name: "Game" }] }),
      "blueprint/Only.uproject": JSON.stringify({ Plugins: [] }),
      "scripts/loose.py": "print(1)",
    });
    const p = await analyze();
    expect(ids(p.languages)).toEqual({ cpp: 1, csharp: 1, java: 1, javascript: 1, python: 1, rust: 1, typescript: 1 });
    expect(ev(p.languages, "typescript")).toEqual(["web/package.json|dependency|typescript", "web/tsconfig.base.json|config|tsconfig.base.json"]);
    expect(ev(p.languages, "cpp")).toEqual(["game/Game.uproject|config|Modules: Game"]);
    expect(ev(p.languages, "python")).toContain("scripts/loose.py|extension-count|.py 파일 1개");
  });

  it("AC-010-01 확장자만 있는 언어는 confidence 0.4로만 보고되고 1.0이 되지 않는다", async () => {
    await put({ "scripts/a.py": "", "scripts/b.py": "", "README.md": "pom.xml Cargo.toml package.json" });
    const p = await analyze();
    expect(ids(p.languages)).toEqual({ python: 0.4 });
    expect(ev(p.languages, "python")).toEqual(["scripts/a.py|extension-count|.py 파일 2개"]);
  });

  it("AC-010-02 packageManager 필드를 우선 근거로 쓰고 lockfile 충돌은 모두 보고하며 경고한다", async () => {
    await put({
      "package.json": JSON.stringify({ packageManager: "pnpm@10.18.0" }),
      "pnpm-lock.yaml": "lockfileVersion: '9.0'\n",
      "package-lock.json": "{}",
    });
    const p = await analyze();
    expect(ids(p.packageManagers)).toEqual({ npm: 0.9, pnpm: 1 });
    expect(ev(p.packageManagers, "pnpm")).toEqual(["package.json|config|pnpm@10.18.0", "pnpm-lock.yaml|lockfile|pnpm-lock.yaml"]);
    expect(p.warnings).toContainEqual(expect.objectContaining({ code: "package-manager-conflict", detector: "package-managers", message: expect.stringContaining("npm, pnpm") }));
  });

  it("AC-010-02 packageManager와 다른 lockfile 하나만 있어도 충돌 경고를 남긴다", async () => {
    await put({ "package.json": JSON.stringify({ packageManager: "yarn@4.0.0" }), "package-lock.json": "{}" });
    const p = await analyze();
    expect(ids(p.packageManagers)).toEqual({ npm: 0.9, yarn: 1 });
    expect(p.warnings.map((w) => w.code)).toContain("package-manager-conflict");
  });

  it("AC-010-03 pip·uv·Maven·Gradle(wrapper)·Cargo를 탐지한다", async () => {
    await put({
      "py/requirements.txt": "fastapi\n",
      "py2/uv.lock": "version = 1\n",
      "py3/pyproject.toml": "[project]\nname='x'\n[tool.uv]\ndev-dependencies=[]\n",
      "jvm/pom.xml": "<project></project>",
      "jvm/mvnw": "#!/bin/sh",
      "gr/build.gradle": "plugins { id 'java' }",
      "gr/gradlew": "#!/bin/sh",
      "gr/gradle/wrapper/gradle-wrapper.properties": "distributionUrl=x",
      "rs/Cargo.toml": "[package]\nname='r'\n",
    });
    const p = await analyze();
    expect(ids(p.packageManagers)).toEqual({ cargo: 1, gradle: 1, maven: 1, pip: 1, uv: 1 });
    expect(ev(p.packageManagers, "gradle")).toEqual([
      "gr/build.gradle|manifest|build.gradle",
      "gr/gradle/wrapper/gradle-wrapper.properties|config|gradle-wrapper.properties",
      "gr/gradlew|config|gradlew",
    ]);
    expect(ev(p.packageManagers, "uv")).toEqual(["py2/uv.lock|lockfile|uv.lock", "py3/pyproject.toml|config|[tool.uv]"]);
  });

  it("AC-010-04 pnpm workspace·npm workspaces의 하위 패키지 Manifest가 하위 경로 Evidence로 나타난다", async () => {
    await put({
      "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
      "package.json": JSON.stringify({ private: true, workspaces: ["libs/*"] }),
      "apps/web/package.json": JSON.stringify({ dependencies: { typescript: "5" } }),
      "libs/ui/package.json": JSON.stringify({ name: "ui" }),
    });
    const p = await analyze();
    expect(ev(p.languages, "typescript")).toEqual(["apps/web/package.json|dependency|typescript"]);
    expect(ev(p.languages, "javascript")).toEqual([
      "apps/web/package.json|manifest|package.json",
      "libs/ui/package.json|manifest|package.json",
      "package.json|manifest|package.json",
    ]);
    expect(ev(p.packageManagers, "pnpm")).toEqual(["pnpm-workspace.yaml|config|pnpm-workspace.yaml"]);
  });

  it("AC-010-05 깨진 package.json·pyproject.toml·pom.xml은 경고를 남기고 다른 Evidence로 계속 분석한다", async () => {
    await put({
      "package.json": "{ broken",
      "pyproject.toml": "[project\nname=",
      "pom.xml": "<project><dependencies>",
      "Cargo.toml": "[package]\nname='ok'\n",
      "tsconfig.json": "{}",
    });
    const p = await analyze();
    expect(ids(p.languages)).toEqual({ java: 0.6, javascript: 0.6, python: 0.6, rust: 1, typescript: 1 });
    const parse = p.warnings.filter((w) => w.code === "parse-failed").map((w) => w.file).sort();
    expect(parse).toEqual(["package.json", "pom.xml", "pyproject.toml"]);
    expect(p.detectors).toContainEqual({ id: "languages", status: "partial" });
  });

  it("테스트용 예제 디렉터리(fixtures·testdata)의 매니페스트는 프로젝트 스택 근거로 쓰지 않는다", async () => {
    await put({
      "package.json": "{}",
      "test/fixtures/spring/pom.xml": "<project></project>",
      "testdata/py/pyproject.toml": "[project]\nname='x'\n",
    });
    const p = await analyze();
    expect(ids(p.languages)).toEqual({ javascript: 1 });
    expect(p.packageManagers).toEqual([]);
  });
});

