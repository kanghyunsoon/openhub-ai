import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Registry, loadRegistry } from "../src/index";

const repoRegistry = path.resolve(import.meta.dirname, "../../../registry");
const { entries } = await loadRegistry(repoRegistry);
const registry = new Registry(entries);
const names = (list: { manifest: { name: string } }[]) => list.map((e) => e.manifest.name);

describe("REQ-002 Registry 조회", () => {
  it("AC-004-01 이름으로 단건 조회한다", () => {
    expect(registry.get("playwright-mcp")?.manifest.repository.github).toBe("microsoft/playwright-mcp");
    expect(registry.get("does-not-exist")).toBeUndefined();
  });

  it("AC-004-01 카테고리로 조회하면 해당 카테고리를 가진 Tool만 나온다", () => {
    const browser = registry.list({ category: "browser" });
    expect(names(browser)).toEqual(["chrome-devtools-mcp", "playwright-mcp"]);
  });

  it("AC-004-01 Capability와 Target 조건을 함께 적용한다", () => {
    expect(names(registry.list({ capability: "browser-automation", target: "gemini-cli" }))).toEqual(["chrome-devtools-mcp"]);
    expect(names(registry.list({ capability: "db-schema-access" }))).toEqual(["postgres-mcp"]);
    expect(registry.list({ capability: "browser-automation", target: "vscode" })).toEqual([]);
  });

  it("조건이 없으면 전체를 이름순으로 돌려주고 Capability 집계를 제공한다", () => {
    expect(registry.list()).toHaveLength(registry.size);
    expect(registry.capabilities().get("browser-automation")).toBe(2);
  });

  it("AC-004-02 registry 모듈은 installer 모듈을 import하지 않는다 (CON-003)", async () => {
    const dir = path.resolve(import.meta.dirname, "../src/registry");
    for (const file of await readdir(dir)) {
      const text = await readFile(path.join(dir, file), "utf8");
      expect(text, file).not.toMatch(/from\s+["'][^"']*installer/u);
    }
  });
});
