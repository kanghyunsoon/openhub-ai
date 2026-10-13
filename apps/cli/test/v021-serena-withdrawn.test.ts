import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { runCli } from "../src/cli";
import { memoryIO } from "./helpers";

/**
 * v0.2.1 #39 독립 리뷰: CLI가 Registry 존재 여부를 먼저 검사해 TOOL_WITHDRAWN 사유가 사용자에게 전달되지 않던 문제의 회귀 테스트.
 * 실제 Registry(Serena 없음)와 사용자 Registry(v0.2.0 Serena Manifest 포함) 모두에서 install·install --backend pinokio·update·rollback·
 * lifecycle health·repair가 중단 사유와 Issue #59를 보여 주고, 질문·실행·network·파일 쓰기는 0건이어야 한다.
 */
const REPO = path.resolve(import.meta.dirname, "../../..");
const ISSUE = "https://github.com/kanghyunsoon/openhub-ai/issues/59";
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-cli-serena-withdrawn-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));

/** 사용자 정의 Registry: 실제 Registry 복사본 + 테스트 전용 v0.2.0 Serena Manifest. */
async function userRegistry(): Promise<string> {
  const dir = path.join(scratch, "user-registry");
  await cp(path.join(REPO, "registry"), dir, { recursive: true });
  await mkdir(path.join(dir, "coding-agent"), { recursive: true });
  await writeFile(path.join(dir, "coding-agent", "serena.yaml"), await readFile(path.join(REPO, "packages", "core", "test", "fixtures", "registry-legacy", "coding-agent", "serena.yaml"), "utf8"));
  return dir;
}

const listAll = async (dir: string): Promise<string[]> =>
  (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).map((e) => path.relative(dir, path.join(e.parentPath, e.name)).replace(/\\/gu, "/")).sort();

async function run(registryDir: string, args: (project: string) => string[]) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "package.json"), '{ "name": "app", "dependencies": { "react": "^19.0.0" } }\n');
  const before = await listAll(base);
  const questions: string[] = [];
  const calls: string[] = [];
  const io = Object.assign(memoryIO(project), {
    registryDir,
    homeDir: home,
    platform: "linux",
    hostEnvironment: { homeDir: home, pathEnv: "", pathExt: "" },
    prompter: { isTTY: true, ask: async (q: string) => (questions.push(q), "y") },
    probe: async () => (calls.push("probe"), { node: { name: "node", available: true, version: "22.11.0", status: "ok" }, npx: { name: "npx", available: true, version: "10.9.2", status: "ok" }, uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" }, docker: { name: "docker", available: false, version: null, status: "not-found" } }),
    spawner: () => {
      calls.push("spawn");
      throw new Error("spawn");
    },
    fetch: async () => {
      calls.push("fetch");
      throw new Error("network");
    },
    runHealth: async () => {
      calls.push("health");
      throw new Error("health");
    },
  });
  const code = await runCli(args(project), io as Parameters<typeof runCli>[1]);
  return { code, stdout: io.stdout, stderr: io.stderr.join("\n"), questions, calls, writes: (await listAll(base)).filter((f) => !before.includes(f)) };
}

const COMMANDS: [string, (p: string) => string[]][] = [
  ["install", (p) => ["install", "serena", "--project", p, "--client", "cursor"]],
  ["install --backend pinokio", (p) => ["install", "serena", "--backend", "pinokio", "--project", p]],
  ["update", (p) => ["update", "serena", "--project", p]],
  ["rollback", (p) => ["rollback", "serena", "--project", p]],
  ["lifecycle health", (p) => ["lifecycle", "health", "serena", "--project", p]],
  ["lifecycle repair", (p) => ["lifecycle", "repair", "serena", "--project", p]],
];

describe("v0.2.1 #39 리뷰: CLI가 Serena 지원 중단 사유를 그대로 보여 준다", () => {
  for (const [registry, dirOf] of [
    ["실제 Registry(Serena 없음)", async () => path.join(REPO, "registry")],
    ["사용자 Registry(Serena Manifest 있음)", userRegistry],
  ] as const) {
    it(registry + ": install·update·rollback·health·repair가 중단 사유·#59를 보여 주고 질문·실행·쓰기 0", async () => {
      const dir = await dirOf();
      for (const [label, args] of COMMANDS) {
        const r = await run(dir, args);
        expect(r.code, label).toBe(2);
        expect(r.stderr, label).toContain("Serena(serena)는 v0.2.1부터 새 설치·업데이트·rollback·Health·repair");
        expect(r.stderr, label).toContain("proxy-tools");
        expect(r.stderr, label).toContain(ISSUE);
        expect(r.stderr, label).not.toContain("Registry에 없는 Tool");
        expect(r.stdout, label).toEqual([]);
        expect(r.questions, label).toEqual([]);
        expect(r.calls, label).toEqual([]);
        expect(r.writes, label).toEqual([]);
      }
    });
  }

  it("Registry에 없는 다른 도구는 예전처럼 TOOL_NOT_FOUND 안내다(지원 중단 문구 없음)", async () => {
    const r = await run(path.join(REPO, "registry"), (p) => ["install", "no-such-tool", "--project", p, "--client", "cursor"]);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("Registry에 없는 Tool입니다");
    expect(r.stderr).not.toContain(ISSUE);
    expect(r.writes).toEqual([]);
  });
});
