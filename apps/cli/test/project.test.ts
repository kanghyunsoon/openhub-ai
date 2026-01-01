import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { projectProfileSchema, type Finding, type ProjectDetector } from "@openhub/core";
import { runCli } from "../src/cli";
import { memoryIO } from "./helpers";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "openhub-cli-project-"));
  await writeFile(path.join(dir, "package.json"), "{}");
  await writeFile(path.join(dir, "bad.json"), "{");
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const detectors: ProjectDetector[] = [
  {
    id: "fake",
    supports: () => true,
    async detect(ctx) {
      await ctx.readJson("bad.json");
      const f = (category: Finding["category"], id: string, name: string): Finding => ({ category, id, name, scope: "project", evidence: [{ file: "package.json", type: "dependency", value: id }] });
      return {
        findings: [
          f("languages", "typescript", "TypeScript"),
          f("frameworks", "react", "React"),
          { category: "aiTools", id: "github", name: "github", scope: "project", kind: "mcp-server", clients: ["claude-code"], evidence: [{ file: "package.json", type: "config", value: "github" }] },
        ],
      };
    },
  },
];

describe("REQ-010 openhub project scan", () => {
  it("AC-014-06 사람이 읽는 출력은 섹션별로 탐지 항목·confidence·Evidence와 경고를 보여준다", async () => {
    const io = Object.assign(memoryIO(dir), { detectors });
    expect(await runCli(["project", "scan", "."], io)).toBe(0);
    const out = io.stdout.join("\n");
    expect(out).toContain(`OpenHub Project Analysis — ${path.basename(dir)}`);
    for (const title of ["Languages", "Frameworks", "Databases", "Package Managers", "Infrastructure", "AI Clients", "AI Tools"]) expect(out).toContain(title);
    expect(out).toMatch(/TypeScript\s+1\.00  package\.json \(dependency: typescript\)/u);
    expect(out).toContain("github [mcp-server; claude-code]");
    expect(out).toContain("(탐지 안 됨)");
    expect(out).toContain("Detectors  fake:partial");
    expect(out).toContain("[parse-failed] bad.json:");
  });

  it("AC-014-06 --json은 검증 가능한 Profile JSON을 그대로 출력하고 두 번 실행해도 같다", async () => {
    const run = async () => {
      const io = Object.assign(memoryIO(dir), { detectors });
      expect(await runCli(["project", "scan", dir, "--json"], io)).toBe(0);
      return io.stdout.join("\n");
    };
    const first = await run();
    expect(await run()).toBe(first);
    const profile = projectProfileSchema.parse(JSON.parse(first));
    expect(profile.frameworks.map((f) => f.id)).toEqual(["react"]);
    expect(first).not.toContain(dir);
  });

  it("AC-014-07 종료 코드: 인자 오류 2, 분석 불가 Root 1, 성공 0(경고가 있어도)", async () => {
    const code = async (argv: string[]) => runCli(argv, Object.assign(memoryIO(dir), { detectors }));
    expect(await code(["project", "scan"])).toBe(2);
    expect(await code(["project", "scan", "a", "b"])).toBe(2);
    expect(await code(["project", "scan", ".", "--yaml"])).toBe(2);
    expect(await code(["project", "inspect", "."])).toBe(2);
    expect(await code(["project", "scan", "./missing"])).toBe(1);
    expect(await code(["project", "scan", "package.json"])).toBe(1);
    expect(await code(["project", "scan", "."])).toBe(0);
  });
  it("AC-016-01 --include-host가 없으면 사용자 범위를 탐지하지 않고, 있으면 (user) 항목을 보여준다", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "openhub-cli-home-"));
    try {
      await writeFile(path.join(home, ".claude.json"), JSON.stringify({ mcpServers: { github: { command: "npx" } }, oauthAccount: { emailAddress: "FAKE@x" } }));
      const hostEnvironment = { homeDir: home, pathEnv: "", pathExt: "", platform: process.platform };
      const off = Object.assign(memoryIO(dir), { hostEnvironment });
      expect(await runCli(["project", "scan", ".", "--json"], off)).toBe(0);
      expect(off.stdout.join("\n")).not.toContain('"scope": "user"');
      const on = Object.assign(memoryIO(dir), { hostEnvironment });
      expect(await runCli(["project", "scan", ".", "--include-host"], on)).toBe(0);
      const out = on.stdout.join("\n");
      expect(out).toContain("github (user) [mcp-server; claude-code]");
      expect(out).toContain("Claude Code (user)");
      expect(out).not.toContain("FAKE@x");
      expect(out).not.toContain(home);
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

