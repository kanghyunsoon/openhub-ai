import { readdirSync, readFileSync } from "node:fs";
import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { runCli } from "../../../../apps/cli/src/cli";
import {
  RELEASE_FRESHNESS_TABLE,
  TREND_SCORE_MEANING,
  TREND_SCORE_MEANING_EN,
  formatTrendItem,
  loadCatalog,
  parseCatalogText,
  popularityPoints,
  trendingTools,
  validateRegistry,
  type MetadataSnapshot,
  type RegistryEntry,
} from "../../src/index";
import { REPO_ROOT, seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";

/** TASK-061 Catalog Metadata v1·OpenHub Trend Score. 임시 Registry 사본과 synthetic metadata만 쓴다(network 0). */
const seed = await seedEntries();
const scratch = await newScratch("catalog-trend-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
// 기준일은 Registry catalog의 가장 최근 addedAt 이후여야 한다(v0.2.0 P0-2 batch 1이 2026-10-09에 등록).
const ASOF = new Date("2026-10-09T00:00:00.000Z");
let n = 0;
async function registryCopy(edit: (root: string) => Promise<void> = async () => {}): Promise<string> {
  const root = path.join(scratch, "registry-" + String(n++));
  await cp(path.join(REPO_ROOT, "registry"), root, { recursive: true });
  await edit(root);
  return root;
}
const setCatalog = async (root: string, tools: string) => writeFile(path.join(root, "catalog.yaml"), "schemaVersion: 1\nkind: openhub-registry-catalog\ntools:\n" + tools);
/** 실제 Registry의 Tool ID 전체(이름순). Registry 확장마다 늘어나므로 목록을 박지 않는다. */
const TOOLS = seed.map((e) => e.manifest.name).sort();
const nullLines = (ids: readonly string[]) => ids.map((id) => "  " + id + ": { addedAt: null }\n").join("");
const catalogIssues = async (root: string) => (await validateRegistry(root, { catalog: { asOf: ASOF } })).issues.filter((i) => i.file === "catalog.yaml");

const DAY = 86_400_000;
const daysAgo = (d: number) => new Date(ASOF.getTime() - d * DAY).toISOString();
const meta = (stars: number, over: Partial<{ pushedAt: string | null; releaseAt: string | null; archived: boolean }> = {}) => ({
  repository: "x/y",
  description: null,
  stars,
  forks: 0,
  pushedAt: over.pushedAt === undefined ? daysAgo(400) : over.pushedAt,
  archived: over.archived ?? false,
  license: "MIT",
  topics: [],
  latestRelease: over.releaseAt === null || over.releaseAt === undefined ? null : { tag: "v1", publishedAt: over.releaseAt, url: null },
});
const snapshotOf = (repos: Record<string, ReturnType<typeof meta>>): MetadataSnapshot => ({ collectedAt: ASOF.toISOString(), repositories: repos });
const dedicated = seed.find((e) => e.manifest.name === "playwright-mcp")!;
const repoOf = (id: string) => seed.find((e) => e.manifest.name === id)!.manifest.repository.github;
const componentsFor = (m: ReturnType<typeof meta>) => trendingTools([dedicated], snapshotOf({ [dedicated.manifest.repository.github]: m }))[0]!.components!;

const NEW_TOOL = String.raw`schemaVersion: 1
name: weather-mcp
displayName: Weather MCP
summary: 날씨 조회 MCP 서버(테스트 fixture)
repository:
  github: acme/weather-mcp
category: [mcp]
capabilities: []
targets: [claude-code]
platform: { windows: true, macos: true, linux: true }
install:
  preferredAdapter: npx
  options:
    command: "npx -y weather-mcp"
healthCheck:
  type: mcp-handshake
update:
  source: npm
rollback:
  supported: true
verification: community
`;

describe("REQ-060 Catalog Metadata v1과 Trend Score", () => {
  it("AC-061-01 catalog는 Manifest와 1:1이며 누락 entry와 orphan entry는 각각 fast validation 오류다", async () => {
    expect(await catalogIssues(await registryCopy())).toEqual([]);
    const missing = await registryCopy((r) => setCatalog(r, nullLines(TOOLS.filter((t) => t !== "serena"))));
    expect((await catalogIssues(missing)).map((i) => i.path)).toEqual(["tools.serena"]);
    const orphan = await registryCopy((r) => setCatalog(r, nullLines([...TOOLS, "ghost-mcp"])));
    const o = await catalogIssues(orphan);
    expect(o.map((i) => i.path)).toEqual(["tools.ghost-mcp"]);
    expect(o[0]!.message).toContain("orphan");
    const none = await registryCopy((r) => rm(path.join(r, "catalog.yaml")));
    expect((await catalogIssues(none)).length).toBe(1);
    // CLI registry validate(= CI fast validation)가 catalog 오류로 실패한다.
    const out: string[] = [];
    const io = { out: (l: string) => out.push(l), err: (l: string) => out.push(l), cwd: REPO_ROOT, version: "test", now: () => ASOF };
    expect(await runCli(["registry", "validate", "--dir", missing], io)).toBe(1);
    expect(out.join("\n")).toContain("catalog.yaml: tools.serena");
    expect(await runCli(["registry", "validate", "--dir", path.join(REPO_ROOT, "registry")], { ...io, out: () => {}, err: () => {} })).toBe(0);
  });

  it("AC-061-02 날짜 형식 오류와 asOf보다 미래인 날짜는 거부하고 null은 어떤 entry에도 허용한다", async () => {
    const lines = (date: string) => nullLines(TOOLS.filter((t) => t !== "context7")) + "  context7: { addedAt: " + date + " }\n";
    for (const bad of ['"2026-13-01"', '"2026-02-30"', '"07-10-2026"', '"2026-10-07T00:00:00Z"', '"yesterday"']) {
      const root = await registryCopy((r) => setCatalog(r, lines(bad)));
      expect((await catalogIssues(root)).map((i) => i.path), bad).toEqual(["tools.context7.addedAt"]);
    }
    const future = await registryCopy((r) => setCatalog(r, lines('"2026-10-10"')));
    expect((await catalogIssues(future))[0]!.message).toContain("미래");
    expect(await catalogIssues(await registryCopy((r) => setCatalog(r, lines('"2026-10-09"'))))).toEqual([]);
    expect(await catalogIssues(await registryCopy((r) => setCatalog(r, nullLines(TOOLS))))).toEqual([]);
  });

  it("AC-061-03 catalog·trend 모듈은 Git·자식 프로세스를 쓰지 않고 .git 없는 디렉터리에서도 같은 결과다", async () => {
    const files = [...readdirSync(path.join(REPO_ROOT, "packages/core/src/catalog")).map((f) => "catalog/" + f), "discover/trend.ts"];
    for (const f of files) {
      const src = readFileSync(path.join(REPO_ROOT, "packages/core/src", f), "utf8");
      expect(src, f).not.toMatch(new RegExp('from "node:' + "child_" + 'process"|\\bexeca\\b|\\.git\\b|git log', "u"));
    }
    const root = await registryCopy();
    const a = await loadCatalog(root);
    const b = await loadCatalog(path.join(REPO_ROOT, "registry"));
    expect(a).toEqual(b);
  });

  it("AC-061-04 Popularity는 min(50, floor(10 × log10(stars + 1)))이다", () => {
    expect([0, 9, 999, 9999, 99999, 10_000_000].map((s) => popularityPoints(s, false))).toEqual([0, 10, 30, 40, 50, 50]);
  });

  it("AC-061-05 Release freshness와 Repository activity 경계가 포함 규칙대로이고 release가 없으면 0이다", () => {
    const rel = [30, 31, 90, 91, 180, 181, 365, 366].map((d) => componentsFor(meta(0, { releaseAt: daysAgo(d) })).releaseFreshness);
    expect(rel).toEqual([25, 18, 18, 10, 10, 5, 5, 0]);
    expect(componentsFor(meta(0, { releaseAt: null })).releaseFreshness).toBe(0);
    const act = [7, 8, 30, 31, 90, 91, 180, 181].map((d) => componentsFor(meta(0, { pushedAt: daysAgo(d) })).repositoryActivity);
    expect(act).toEqual([25, 18, 18, 10, 10, 5, 5, 0]);
    expect(componentsFor(meta(0, { pushedAt: null })).repositoryActivity).toBe(0);
    expect(RELEASE_FRESHNESS_TABLE.map(([d]) => d)).toEqual([30, 90, 180, 365]);
  });

  it("AC-061-06 archived는 빠지고 metadata가 없으면 score null로 목록 끝에 metadata unavailable로 표시된다", () => {
    const items = trendingTools(seed, snapshotOf({ [repoOf("context7")]: meta(5000, { archived: true }), [repoOf("serena")]: meta(10) }));
    expect(items.map((i) => i.toolId)).not.toContain("context7");
    expect(items[0]!.toolId).toBe("serena");
    expect(items.slice(1).every((i) => i.score === null && i.status === "metadata-unavailable")).toBe(true);
    expect(formatTrendItem(items[1]!, 2)).toContain("metadata unavailable");
  });

  it("AC-061-07 shared-repo는 Popularity가 절반(내림)이고 shared-repository flag가 붙는다", () => {
    const [m] = trendingTools(seed.filter((e) => e.manifest.name === "memory-mcp"), snapshotOf({ [repoOf("memory-mcp")]: meta(99999) }));
    expect(m!.components!.popularity).toBe(25);
    expect(m!.flags).toEqual(["shared-repository"]);
    expect(popularityPoints(999, true)).toBe(15);
  });

  it("AC-061-08 정렬은 score → stars → toolId이고 입력 순서를 바꿔도 같은 byte다", () => {
    const snap = snapshotOf({
      [repoOf("context7")]: meta(999, { pushedAt: daysAgo(1) }),
      [repoOf("serena")]: meta(999, { pushedAt: daysAgo(1) }),
      [repoOf("chrome-devtools-mcp")]: meta(1000, { pushedAt: daysAgo(1) }),
      [repoOf("playwright-mcp")]: meta(99999, { releaseAt: daysAgo(3), pushedAt: daysAgo(1) }),
    });
    const a = trendingTools(seed, snap);
    expect(a.slice(0, 4).map((i) => [i.toolId, i.score])).toEqual([["playwright-mcp", 100], ["chrome-devtools-mcp", 55], ["context7", 55], ["serena", 55]]);
    expect(JSON.stringify(trendingTools([...seed].reverse(), snap))).toBe(JSON.stringify(a));
  });

  it("AC-061-09 trend 계산은 fetch 0·LLM import 0이고 evidence에 stars·release·push·구성 점수·asOf가 있다", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const [item] = trendingTools([dedicated], snapshotOf({ [dedicated.manifest.repository.github]: meta(1234, { releaseAt: daysAgo(10), pushedAt: daysAgo(2) }) }));
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(item!.evidence).toEqual({ stars: 1234, latestReleaseAt: daysAgo(10), pushedAt: daysAgo(2), asOf: ASOF.toISOString() });
    expect(item!.components).toEqual({ popularity: 30, releaseFreshness: 25, repositoryActivity: 25 });
    const src = readFileSync(path.join(REPO_ROOT, "packages/core/src/discover/trend.ts"), "utf8");
    expect(src).not.toContain("summary-llm");
    expect(formatTrendItem(item!, 1)).toContain("popularity 30 · release 25 · activity 25");
  });

  it("AC-061-10 설명 문구는 star 증가율이 아님을 밝히고 보안·품질·신뢰 점수로 표현하지 않는다", () => {
    expect(TREND_SCORE_MEANING).toBe("historical star growth가 아니라 현재 popularity와 최근 release/activity를 조합한 점수");
    for (const s of [TREND_SCORE_MEANING, TREND_SCORE_MEANING_EN]) expect(s).not.toMatch(/(security|quality|trust)[ -]score|보안 점수|품질 점수|신뢰 점수/iu);
    expect(TREND_SCORE_MEANING_EN).toContain("Not historical star growth");
  });

  it("AC-061-11 같은 toolId가 catalog에 두 번 있으면 fast validation 오류다", async () => {
    const dup = parseCatalogText("schemaVersion: 1\nkind: openhub-registry-catalog\ntools:\n  serena: { addedAt: null }\n  serena: { addedAt: \"2026-01-01\" }\n");
    expect(dup.ok).toBe(false);
    const root = await registryCopy((r) => setCatalog(r, nullLines(TOOLS) + "  serena: { addedAt: null }\n"));
    const issues = await catalogIssues(root);
    expect(issues.length).toBe(1);
    expect(issues[0]!.message).toContain("두 번");
  });

  it("AC-061-12 Registry Tool ID 목록 상수가 소스에 없고 Manifest + catalog entry만으로 새 Tool이 동작한다", async () => {
    const dirs = ["packages/core/src", "apps/cli/src", "apps/desktop/src", "apps/desktop/renderer"];
    const offenders: string[] = [];
    for (const d of dirs) {
      for (const f of readdirSync(path.join(REPO_ROOT, d), { recursive: true }) as string[]) {
        if (!/\.(ts|js|mjs)$/u.test(f)) continue;
        const src = readFileSync(path.join(REPO_ROOT, d, f), "utf8");
        if (TOOLS.some((id) => src.includes('"' + id + '"') || src.includes("'" + id + "'"))) offenders.push(d + "/" + f);
      }
    }
    expect(offenders).toEqual([]);
    const root = await registryCopy(async (r) => {
      await writeFile(path.join(r, "mcp", "weather-mcp.yaml"), NEW_TOOL);
      await writeFile(path.join(r, "catalog.yaml"), (await readFile(path.join(r, "catalog.yaml"), "utf8")) + "  weather-mcp: { addedAt: \"2026-09-30\" }\n");
    });
    const v = await validateRegistry(root, { catalog: { asOf: ASOF } });
    expect(v.issues).toEqual([]);
    expect(v.entries.map((e) => e.manifest.name)).toContain("weather-mcp");
    const items = trendingTools(v.entries as RegistryEntry[], snapshotOf({ "acme/weather-mcp": meta(50, { pushedAt: daysAgo(3) }) }));
    expect(items[0]).toMatchObject({ toolId: "weather-mcp", score: 17 + 25 });
    const cat = await loadCatalog(root);
    expect(cat.ok && cat.catalog.tools["weather-mcp"]).toEqual({ addedAt: "2026-09-30" });
  });
});

