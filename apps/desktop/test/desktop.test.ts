import "./locale-ko";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { OPENHUB_CORE_VERSION } from "@openhub/core";
import { buildRegistryView } from "../src/registry-view";

const root = path.resolve(import.meta.dirname, "../../..");

describe("REQ-005 Desktop Shell", () => {
  it("AC-007-01 화면 데이터는 Core Registry 전체를 메타데이터와 합쳐 Star 순으로 만든다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openhub-desktop-"));
    try {
      const cache = path.join(dir, "metadata.json");
      await writeFile(cache, JSON.stringify({
        version: 1, collectedAt: "2026-10-06T00:00:00.000Z", mode: "graphql", errors: {},
        repositories: {
          "crystaldba/postgres-mcp": { repository: "crystaldba/postgres-mcp", description: null, stars: 999999, forks: 0, pushedAt: null, archived: true, license: null, topics: [], latestRelease: { tag: "v9", publishedAt: null, url: null } },
        },
      }));
      const view = await buildRegistryView(path.join(root, "registry"), cache);
      expect(view.issues).toEqual([]);
      expect(view.tools.length).toBeGreaterThanOrEqual(5);
      expect(view.tools[0]).toMatchObject({ name: "postgres-mcp", stars: 999999, latestRelease: "v9", archived: true });
      expect(view.tools.slice(1).every((t) => t.stars === null)).toBe(true);
      expect(view.metadataCollectedAt).toBe("2026-10-06T00:00:00.000Z");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AC-007-01 메타데이터 캐시가 없어도 Registry 목록을 만든다", async () => {
    const view = await buildRegistryView(path.join(root, "registry"), path.join(tmpdir(), "openhub-no-such-cache.json"));
    expect(view.tools.length).toBeGreaterThanOrEqual(5);
    expect(view.metadataCollectedAt).toBeNull();
  });

  it("v0.2.1 화면 데이터는 머리글에 보일 OpenHub 버전을 담고, 그 값은 Desktop package 버전과 같다", async () => {
    const view = await buildRegistryView(path.join(root, "registry"), path.join(tmpdir(), "openhub-no-such-cache.json"));
    const pkg = JSON.parse(await readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8")) as { version: string };
    expect(view.appVersion).toBe(OPENHUB_CORE_VERSION);
    expect(view.appVersion).toBe(pkg.version);
    const html = await readFile(path.resolve(import.meta.dirname, "../renderer/index.html"), "utf8");
    const renderer = await readFile(path.resolve(import.meta.dirname, "../renderer/renderer.js"), "utf8");
    expect(html).toContain('id="app-version"');
    expect(renderer).toContain('getElementById("app-version").textContent = i18nRenderer.t("app.version", { version: view.appVersion })');
  });

  it("AC-007-02 Desktop은 Core를 import하고 Manifest 파싱·검증 로직을 복제하지 않는다", async () => {
    const src = path.resolve(import.meta.dirname, "../src");
    const texts = await Promise.all((await readdir(src, { recursive: true })).filter((f) => f.endsWith(".ts")).map((f) => readFile(path.join(src, f), "utf8")));
    expect(texts.some((t) => t.includes('from "@openhub/core"'))).toBe(true);
    for (const t of texts) expect(t).not.toMatch(/from "(zod|yaml)"|parseDocument|safeParse/u);
  });

  it("렌더러는 Node API 없이 preload 브리지만 쓰고 innerHTML을 쓰지 않는다", async () => {
    const js = await readFile(path.resolve(import.meta.dirname, "../renderer/renderer.js"), "utf8");
    expect(js).toContain("window.openhub.listRegistry");
    expect(js).not.toMatch(/\brequire\(|\.(inner|outer)HTML\s*=|insertAdjacentHTML/u);
  });
});
