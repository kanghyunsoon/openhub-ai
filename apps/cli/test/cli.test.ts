import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCli } from "../src/cli";
import { memoryIO } from "./helpers";

describe("REQ-002 openhub CLI", () => {
  it("--version은 버전을 출력하고 0으로 끝난다", async () => {
    const io = memoryIO();
    expect(await runCli(["--version"], io)).toBe(0);
    expect(io.stdout).toEqual(["0.0.0-test"]);
  });

  it("알 수 없는 명령은 종료 코드 2", async () => {
    const io = memoryIO();
    expect(await runCli(["nope"], io)).toBe(2);
    expect(io.stderr.join("\n")).toContain("알 수 없는 명령");
  });

  it("AC-003-04 registry validate는 저장소 Registry에서 0으로 끝난다", async () => {
    const io = memoryIO(path.resolve(import.meta.dirname, "../../.."));
    expect(await runCli(["registry", "validate"], io)).toBe(0);
    expect(io.stdout.join("\n")).toMatch(/검증 통과: Manifest \d+개/);
  });

  it("AC-003-04 registry validate는 오류가 있으면 0이 아닌 코드와 파일·필드 경로를 출력한다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openhub-cli-"));
    try {
      await mkdir(path.join(dir, "mcp"));
      await writeFile(path.join(dir, "mcp", "bad-tool.yaml"), "name: bad-tool\ninstall:\n  preferredAdapter: brew\n");
      const io = memoryIO(dir);
      expect(await runCli(["registry", "validate", "--dir", dir], io)).toBe(1);
      const err = io.stderr.join("\n");
      expect(err).toContain("mcp/bad-tool.yaml: install.preferredAdapter:");
      expect(err).toContain("mcp/bad-tool.yaml: repository:");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AC-004-03 registry list --category mcp는 mcp 카테고리 Tool만 출력한다", async () => {
    const io = memoryIO(path.resolve(import.meta.dirname, "../../.."));
    expect(await runCli(["registry", "list", "--category", "mcp", "--json"], io)).toBe(0);
    const list = JSON.parse(io.stdout.join("\n")) as { name: string; category: string[] }[];
    expect(list.length).toBeGreaterThan(0);
    for (const m of list) expect(m.category).toContain("mcp");
    const io2 = memoryIO(path.resolve(import.meta.dirname, "../../.."));
    expect(await runCli(["registry", "list", "--category", "database"], io2)).toBe(0);
    expect(io2.stdout.join("\n")).toContain("postgres-mcp");
    expect(io2.stdout.join("\n")).not.toContain("playwright-mcp");
  });

  it("registry list는 알 수 없는 카테고리에 종료 코드 2", async () => {
    const io = memoryIO();
    expect(await runCli(["registry", "list", "--category", "games"], io)).toBe(2);
  });

  it("REQ-003 AC-006-03 collect는 Registry 저장소를 수집해 캐시에 쓰고 토큰은 출력하지 않는다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openhub-collect-"));
    try {
      const io = memoryIO(path.resolve(import.meta.dirname, "../../.."));
      const token = "ghp_DO_NOT_PRINT";
      io.resolveToken = async () => ({ token, source: "GITHUB_TOKEN" });
      io.fetch = async (_url, init) => {
        const { variables } = JSON.parse(String(init?.body)) as { variables: Record<string, string> };
        const data: Record<string, unknown> = {};
        for (const [k, owner] of Object.entries(variables)) {
          if (!k.startsWith("o")) continue;
          const i = k.slice(1);
          data[`r${i}`] = {
            nameWithOwner: `${owner}/${variables[`n${i}`]}`,
            description: null, stargazerCount: 100, forkCount: 1, pushedAt: null, isArchived: false,
            licenseInfo: null, repositoryTopics: { nodes: [] }, latestRelease: null,
          };
        }
        return new Response(JSON.stringify({ data }), { status: 200 });
      };
      const out = path.join(dir, "metadata.json");
      expect(await runCli(["collect", "--out", out], io)).toBe(0);
      const all = [...io.stdout, ...io.stderr].join("\n");
      expect(all).not.toContain(token);
      expect(all).toContain("GraphQL");
      const cache = JSON.parse(await readFile(out, "utf8")) as { repositories: Record<string, { stars: number }> };
      expect(cache.repositories["microsoft/playwright-mcp"]?.stars).toBe(100);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
