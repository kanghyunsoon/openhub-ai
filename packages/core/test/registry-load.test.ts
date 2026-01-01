import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CATEGORIES, loadRegistry } from "../src/index";

const fixture = await readFile(new URL("./fixtures/plan-section-10.yaml", import.meta.url), "utf8");
const repoRegistry = path.resolve(import.meta.dirname, "../../../registry");

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openhub-registry-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(file: string, text: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), text);
}

describe("REQ-002 Registry 적재와 검증", () => {
  it("AC-003-01 registry/<category>/<name>.yaml 구조의 올바른 Manifest를 적재한다", async () => {
    await put("mcp/playwright-mcp.yaml", fixture);
    const r = await loadRegistry(root);
    expect(r.issues).toEqual([]);
    expect(r.entries.map((e) => [e.file, e.directory, e.manifest.name])).toEqual([["mcp/playwright-mcp.yaml", "mcp", "playwright-mcp"]]);
  });

  it("AC-003-01 파일 이름과 name이 다르면 실패한다", async () => {
    await put("mcp/playwright.yaml", fixture);
    const r = await loadRegistry(root);
    expect(r.entries).toEqual([]);
    expect(r.issues).toEqual([expect.objectContaining({ file: "mcp/playwright.yaml", path: "name" })]);
  });

  it("AC-003-01 카테고리 밖 위치·알 수 없는 카테고리·디렉터리와 category 불일치를 거부한다", async () => {
    await put("playwright-mcp.yaml", fixture);
    await put("tools/playwright-mcp.yaml", fixture);
    await put("memory/playwright-mcp.yaml", fixture);
    const r = await loadRegistry(root);
    expect(r.entries).toEqual([]);
    expect(r.issues.map((i) => [i.file, i.path])).toEqual([
      ["memory/playwright-mcp.yaml", "category"],
      ["playwright-mcp.yaml", ""],
      ["tools", ""],
    ]);
  });

  it("AC-003-02 Tool 이름이 중복되면 실패한다", async () => {
    await put("mcp/playwright-mcp.yaml", fixture);
    await put("testing/playwright-mcp.yaml", fixture);
    const r = await loadRegistry(root);
    expect(r.entries).toHaveLength(1);
    expect(r.issues).toEqual([expect.objectContaining({ path: "name", message: expect.stringContaining("중복") })]);
  });

  it("AC-003-03 저장소의 시드 Registry는 5개 이상이고 여러 MVP 카테고리에 걸쳐 모두 통과한다", async () => {
    const r = await loadRegistry(repoRegistry);
    expect(r.issues).toEqual([]);
    expect(r.entries.length).toBeGreaterThanOrEqual(5);
    const dirs = new Set(r.entries.map((e) => e.directory));
    expect(dirs.size).toBeGreaterThanOrEqual(5);
    for (const d of dirs) expect(CATEGORIES).toContain(d);
    for (const e of r.entries) expect(e.manifest.verification).not.toBe("draft");
  });
});
