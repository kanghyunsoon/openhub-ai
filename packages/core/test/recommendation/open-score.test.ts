import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  OPEN_SCORE_KIND,
  computeOpenScore,
  loadMetadataSnapshot,
  openScoreSchema,
  starsStep,
  type Manifest,
} from "../../src/index";
import { RECOMMENDATION_FIXTURES, REPO_ROOT, snapshotPath, syntheticEntries, syntheticSnapshot } from "./helpers";

const entries = await syntheticEntries();
const snapshot = await syntheticSnapshot();
const manifest = (name: string): Manifest => {
  const m = entries.find((e) => e.manifest.name === name)?.manifest;
  if (m === undefined) throw new Error(name);
  return m;
};
const open = (name: string) => computeOpenScore(manifest(name), snapshot).openScore;

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("REQ-023 OpenScore (Repository Health Heuristic)", () => {
  it("AC-022-01 OpenScore는 floor((35M+20R+30Cm+15L+50)/100) 정수 연산이다", () => {
    expect(open("tool-b")).toEqual({ kind: OPEN_SCORE_KIND, score: 63, status: "ok", components: { maintenance: 80, release: 20, community: 54, license: 100 }, flags: ["stale-release"] });
    expect(open("tool-f").score).toBe(Math.floor((35 * 80 + 20 * 40 + 30 * 74 + 15 * 100 + 50) / 100));
    expect(open("tool-e")).toMatchObject({ score: 34, components: { maintenance: 50, release: 10, community: 32, license: 30 } });
  });

  it("AC-022-01 기준 시각은 snapshot collectedAt이며 시스템 시계를 바꿔도 결과가 같다", () => {
    const before = entries.map((e) => computeOpenScore(e.manifest, snapshot));
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-06-01T00:00:00Z"));
    expect(entries.map((e) => computeOpenScore(e.manifest, snapshot))).toEqual(before);
    const shifted = { ...snapshot, collectedAt: "2027-01-01T00:00:00Z" };
    expect(computeOpenScore(manifest("tool-b"), shifted).openScore.components?.maintenance).toBe(0);
  });

  it("AC-022-02 starsStep 경계값을 단계표대로 바꾼다", () => {
    const cases: [number, number][] = [[99, 15], [100, 35], [999, 35], [1000, 55], [4999, 55], [5000, 70], [9999, 70], [10000, 80], [19999, 80], [20000, 90], [49999, 90], [50000, 100]];
    for (const [stars, step] of cases) expect(starsStep(stars), String(stars)).toBe(step);
  });

  it("AC-022-02 stars가 10배여도 Community는 10배가 되지 않는다", () => {
    for (const [low, high] of [[1000, 10000], [5000, 50000], [100, 1000]] as const) {
      expect(starsStep(high)).toBeLessThan(starsStep(low) * 2);
    }
  });

  it("AC-022-03 tool-a(stars 100000, shared-repo)의 Community는 50 이하이고 같은 값의 dedicated 저장소보다 낮다(시나리오 14)", () => {
    const shared = computeOpenScore(manifest("tool-a"), snapshot).openScore;
    expect(shared.components?.community).toBe(50);
    expect(shared.flags).toEqual(["shared-repository"]);
    const dedicated = { ...manifest("tool-a"), recommendation: { ...manifest("tool-a").recommendation, source: { type: "dedicated" as const } } };
    const alone = computeOpenScore(dedicated, snapshot).openScore;
    expect(alone.components?.community).toBe(100);
    expect(alone.flags).toEqual([]);
    expect((shared.components?.community ?? 0) < (alone.components?.community ?? 0)).toBe(true);
  });

  it("AC-022-04 tool-c(archived)는 score 0이고 archived flag가 붙는다", () => {
    const c = open("tool-c");
    expect(c.score).toBe(0);
    expect(c.flags).toContain("archived");
  });

  it("AC-022-05 latestRelease 365일은 stale이 아니고 366일은 stale-release, release 없음은 no-release다", () => {
    expect(open("tool-f").flags).not.toContain("stale-release");
    expect(open("tool-f").components?.release).toBe(40);
    expect(open("tool-b").flags).toContain("stale-release");
    expect(open("tool-b").components?.release).toBe(20);
    expect(open("tool-e").flags).toContain("no-release");
    expect(open("tool-e").flags).not.toContain("stale-release");
  });

  it("AC-022-06 license가 null이면 License component는 30이고 license-unknown flag가 붙는다", () => {
    expect(open("tool-e").components?.license).toBe(30);
    expect(open("tool-e").flags).toContain("license-unknown");
    expect(open("tool-b").components?.license).toBe(100);
  });

  it("AC-022-07 tool-d(metadata 없음)와 snapshot 없음은 score null·unavailable·components null이며 예외가 없다", () => {
    expect(open("tool-d")).toEqual({ kind: OPEN_SCORE_KIND, score: null, status: "unavailable", components: null, flags: [] });
    expect(computeOpenScore(manifest("tool-b"), undefined).openScore.status).toBe("unavailable");
    expect(computeOpenScore(manifest("tool-b"), { collectedAt: "not-a-date", repositories: snapshot.repositories }).openScore.score).toBeNull();
  });

  it("AC-022-08 OpenScore는 Profile을 입력으로 받지 않아 프로젝트가 달라도 같은 tool의 값이 같다", () => {
    expect(computeOpenScore.length).toBe(2);
    expect(computeOpenScore(manifest("tool-b"), snapshot)).toEqual(computeOpenScore(manifest("tool-b"), snapshot));
  });

  it("AC-022-09 snapshot loader는 파일만 읽고 네트워크를 호출하지 않으며 없거나 깨진 파일은 undefined다", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect((await loadMetadataSnapshot(snapshotPath("metadata.synthetic.json")))?.collectedAt).toBe("2026-01-01T00:00:00Z");
    expect(await loadMetadataSnapshot(path.join(RECOMMENDATION_FIXTURES, "does-not-exist.json"))).toBeUndefined();
    expect(await loadMetadataSnapshot(path.join(RECOMMENDATION_FIXTURES, "registry/memory/tool-a.yaml"))).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(computeOpenScore(manifest("tool-b"), undefined).openScore.status).toBe("unavailable");
  });

  it("AC-022-10 openScore.kind는 repository-health-heuristic이고 schema에 trust·security·quality·safety 필드가 없다", () => {
    for (const e of entries) {
      const o = computeOpenScore(e.manifest, snapshot).openScore;
      expect(o.kind).toBe("repository-health-heuristic");
      expect(openScoreSchema.safeParse({ ...o, score: o.score === null ? null : o.score / 100, components: o.components === null ? null : Object.fromEntries(Object.entries(o.components).map(([k, v]) => [k, v / 100])) }).success).toBe(true);
    }
    const keys = JSON.stringify(openScoreSchema.toJSONSchema());
    expect(keys).not.toMatch(/trust|security|quality|safety|safe/iu);
  });

  it("AC-022-11 recommendation 테스트는 .openhub-cache를 읽지 않는다", async () => {
    expect(() => snapshotPath("../../../../../.openhub-cache/metadata.json")).toThrow();
    const dir = path.join(REPO_ROOT, "packages/core/test/recommendation");
    for (const file of await readdir(dir)) {
      if (!file.endsWith(".test.ts") || file === "open-score.test.ts") continue;
      expect(await readFile(path.join(dir, file), "utf8"), file).not.toMatch(/openhub-cache|DEFAULT_METADATA_CACHE/u);
    }
  });
});
