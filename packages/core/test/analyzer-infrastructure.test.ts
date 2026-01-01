import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProject, defaultDetectors, serializeProfile, type ProjectDetector, type ProjectProfile } from "../src/index";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/projects");
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openhub-infra-"));
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
async function profile(dir = root, detectors?: ProjectDetector[]): Promise<ProjectProfile> {
  const r = await analyzeProject(dir, detectors === undefined ? {} : { detectors });
  if (!r.ok) throw new Error(r.error.code);
  return r.profile;
}
const evidenceOf = (p: ProjectProfile, id: string) =>
  p.infrastructure.find((i) => i.id === id)?.evidence.map((e) => `${e.file}|${e.type}|${e.value}`) ?? [];

describe("REQ-010 Infrastructure Detection", () => {
  it("AC-012-01 Dockerfile·Dockerfile.*의 FROM 지시어로 Docker를 탐지한다", async () => {
    await put({
      Dockerfile: "# base\nFROM --platform=linux/amd64 node:22-alpine AS build\nRUN npm ci\nFROM nginx:1.27\n",
      "deploy/Dockerfile.worker": "FROM python:3.12-slim\n",
      "Dockerfile.empty": "# no FROM here\n",
    });
    const p = await profile();
    expect(evidenceOf(p, "docker")).toEqual([
      "Dockerfile|config|FROM nginx:1.27",
      "Dockerfile|config|FROM node:22-alpine",
      "Dockerfile.empty|file-presence|Dockerfile.empty",
      "deploy/Dockerfile.worker|config|FROM python:3.12-slim",
    ]);
    expect(p.infrastructure.find((i) => i.id === "docker")?.confidence).toBe(1);
  });

  it("AC-012-02 compose 파일은 서비스 이름과 image만 쓰고 environment 값은 결과에 남기지 않는다", async () => {
    const p = await profile(path.join(FIXTURES, "docker-project"));
    expect(evidenceOf(p, "docker-compose")).toEqual(["compose.yaml|config|services: app, cache, db, documents"]);
    const json = serializeProfile(p);
    expect(json).not.toContain("FAKE_PG_PASSWORD");
    expect(json).not.toContain("POSTGRES_PASSWORD");
  });

  it("AC-012-03 jobs가 있는 .github/workflows/*.y(a)ml만 GitHub Actions로 탐지한다", async () => {
    await put({
      ".github/workflows/ci.yml": "on: push\njobs:\n  test:\n    runs-on: ubuntu-latest\n  lint:\n    runs-on: ubuntu-latest\n",
      ".github/workflows/empty.yaml": "name: nothing\n",
      ".github/dependabot.yml": "version: 2\n",
      "docs/workflows/ci.yml": "jobs:\n  x: {}\n",
    });
    const p = await profile();
    expect(evidenceOf(p, "github-actions")).toEqual([".github/workflows/ci.yml|config|jobs: lint, test"]);
  });

  it("AC-012-04 Root의 .git(디렉터리 또는 worktree 파일) 존재로 Git을 탐지하고 내부는 읽지 않는다", async () => {
    await put({ ".git/config": "[remote \"origin\"]\n\turl = https://FAKE_TOKEN@github.com/x/y.git\n", "README.md": "x" });
    const dirRepo = await profile();
    expect(evidenceOf(dirRepo, "git")).toEqual([".git|config|.git"]);
    expect(serializeProfile(dirRepo)).not.toContain("FAKE_TOKEN");

    await rm(path.join(root, ".git"), { recursive: true });
    await put({ ".git": "gitdir: C:/somewhere/else/.git/worktrees/x\n" });
    const worktree = await profile();
    expect(evidenceOf(worktree, "git")).toEqual([".git|config|.git"]);
    expect(serializeProfile(worktree)).not.toContain("somewhere");

    await rm(path.join(root, ".git"));
    expect(evidenceOf(await profile(), "git")).toEqual([]);
  });

  it("AC-012-05 테스트 전용 Infrastructure Detector를 주입하면 Analyzer 변경 없이 결과에 나타난다", async () => {
    await put({ "k8s/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\n", Dockerfile: "FROM alpine\n" });
    const kubernetes: ProjectDetector = {
      id: "test-kubernetes",
      supports: (ctx) => ctx.files.some((f) => f.startsWith("k8s/")),
      async detect(ctx) {
        const doc = await ctx.readYaml("k8s/deployment.yaml");
        const kind = typeof doc === "object" && doc !== null ? (doc as { kind?: unknown }).kind : undefined;
        return {
          findings: kind === "Deployment"
            ? [{ category: "infrastructure", id: "kubernetes", name: "Kubernetes", scope: "project", evidence: [{ file: "k8s/deployment.yaml", type: "config", value: "kind: Deployment" }] }]
            : [],
        };
      },
    };
    const p = await profile(root, [...defaultDetectors(), kubernetes]);
    expect(p.infrastructure.map((i) => i.id)).toEqual(["docker", "kubernetes"]);
    expect((await profile()).infrastructure.map((i) => i.id)).toEqual(["docker"]); // 기본 목록에는 없음
  });
});
