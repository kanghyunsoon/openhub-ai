import { describe, expect, it } from "vitest";
import { releaseSnapshotSchema, summarizeReleases, type ReleaseEntry, type ReleaseSnapshotV1, type ReleaseSummaryV1 } from "../../src/index";
import { markdownBulletText, markdownHeadingText } from "../../src/release/markdown-line";

/**
 * Release note 줄 parser의 선형 시간 보장과 옛 정규식과의 결과 동등성.
 * 옛 정규식은 여기서 짧은 입력의 기준 답(oracle)으로만 쓴다. 긴 입력에는 쓰지 않는다(그게 고친 문제다).
 */
const LEGACY_HEADING = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u;
const LEGACY_BULLET = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.+?)\s*$/u;
const legacy = (re: RegExp, s: string) => re.exec(s)?.[1] ?? null;

// 공백 종류(일반·탭·NBSP·U+2028 줄 끝), 표지 문자, 일반 글자, surrogate pair를 섞는다.
const ALPHABET = [" ", "\t", "\u00a0", "\u2028", "#", "-", "*", "1", ".", ")", "a", "\u{1F600}"];
const NOTES_MAX = 64 * 1024;

function* allStrings(maxLen: number): Generator<string> {
  yield "";
  let level = [""];
  for (let n = 1; n <= maxLen; n += 1) {
    const next: string[] = [];
    for (const prefix of level) for (const c of ALPHABET) next.push(prefix + c);
    yield* next;
    level = next;
  }
}
/** 고정 seed PRNG(mulberry32): 실행마다 같은 입력이다. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const entry = (notes: string): ReleaseEntry => ({
  version: "2.1.0",
  tag: "v2.1.0",
  publishedAt: "2026-09-01T00:00:00.000Z",
  prerelease: false,
  yanked: false,
  deprecated: null,
  title: null,
  notes: { text: notes, truncated: false, originalBytes: Buffer.byteLength(notes, "utf8") },
  url: null,
  digest: null,
  runtime: { node: null, python: null },
});
function summaryOf(notes: string): ReleaseSummaryV1 {
  expect(notes.length).toBeLessThanOrEqual(NOTES_MAX);
  const snap: ReleaseSnapshotV1 = releaseSnapshotSchema.parse({
    schemaVersion: 1,
    toolId: "memory-mcp",
    versionSource: "npm",
    notesSource: "github-release",
    current: { spec: "@modelcontextprotocol/server-memory@2.0.3", version: "2.0.3", digest: null },
    target: entry(notes),
    between: [entry(notes)],
    selection: { includePrerelease: false, comparable: true, skippedDrafts: 0, skippedPrereleases: 0, truncated: false },
    collectedAt: "2026-10-07T00:00:00.000Z",
    metadataDigest: "sha256:" + "a".repeat(64),
  });
  return summarizeReleases(snap);
}
const items = (s: ReleaseSummaryV1) => Object.fromEntries(Object.entries(s.categories).filter(([, v]) => v.length > 0).map(([k, v]) => [k, v.map((i) => [i.line, i.text])]));
const spaces = (n: number) => " ".repeat(n);

describe("Release note 줄 parser: 옛 정규식과 같은 결과", () => {
  it("길이 5 이하의 모든 입력(12글자 alphabet)에서 제목·목록 match와 capture가 옛 정규식과 같다", () => {
    let checked = 0;
    for (const s of allStrings(5)) {
      if (markdownHeadingText(s) !== legacy(LEGACY_HEADING, s)) expect(markdownHeadingText(s), JSON.stringify(s)).toBe(legacy(LEGACY_HEADING, s));
      if (markdownBulletText(s) !== legacy(LEGACY_BULLET, s)) expect(markdownBulletText(s), JSON.stringify(s)).toBe(legacy(LEGACY_BULLET, s));
      checked += 1;
    }
    expect(checked).toBe(271_453);
  });

  it("표지로 시작하는 고정 seed 무작위 입력 20,000개(길이 40 이하)에서 옛 정규식과 같다", () => {
    const rnd = prng(20261009);
    const prefixes = ["", " ", "   ", "    ", "#", "## ", "###### ", "####### ", "- ", "* ", "+", "1. ", "12)", "123.", "1234.", "\t-"];
    for (let n = 0; n < 20_000; n += 1) {
      let s = prefixes[Math.floor(rnd() * prefixes.length)]!;
      const len = Math.floor(rnd() * 40);
      for (let i = 0; i < len; i += 1) s += ALPHABET[Math.floor(rnd() * ALPHABET.length)]!;
      if (markdownHeadingText(s) !== legacy(LEGACY_HEADING, s)) expect(markdownHeadingText(s), JSON.stringify(s)).toBe(legacy(LEGACY_HEADING, s));
      if (markdownBulletText(s) !== legacy(LEGACY_BULLET, s)) expect(markdownBulletText(s), JSON.stringify(s)).toBe(legacy(LEGACY_BULLET, s));
    }
  });

  it("(F) 정상 제목·목록 표기는 예전과 같은 텍스트를 돌려준다", () => {
    const cases = ["# Title", "  ## Bug Fixes ##", "### ⚠ BREAKING CHANGES", "###### Six", "- item", "  * nested item  ", "+ plus", "1. first", "12) twelfth", "## Spaced  #  ", "#  ", "- \u{1F600} emoji"];
    for (const s of cases) {
      expect(markdownHeadingText(s), s).toBe(legacy(LEGACY_HEADING, s));
      expect(markdownBulletText(s), s).toBe(legacy(LEGACY_BULLET, s));
    }
    expect(cases.map(markdownHeadingText).slice(0, 4)).toEqual(["Title", "Bug Fixes", "⚠ BREAKING CHANGES", "Six"]);
    expect(cases.map(markdownBulletText).slice(4, 9)).toEqual(["item", "nested item", "plus", "first", "twelfth"]);
  });
});

describe("Release note 줄 parser: 64 KiB 공격형 줄", () => {
  it("(A) 제목 표지 뒤 공백 수만 자: 제목으로 읽고 분류도 예전 규칙대로다", () => {
    expect(markdownHeadingText("# a" + spaces(60_000) + "x")).toBe("a" + spaces(60_000) + "x");
    expect(items(summaryOf("# Security" + spaces(60_000) + "x\n- faster startup"))).toEqual({ security: [[2, "faster startup"]] });
    expect(items(summaryOf("### Performance" + spaces(60_000) + "\n- cache manifests"))).toEqual({ performance: [[2, "cache manifests"]] });
    expect(markdownHeadingText("#" + spaces(60_000))).toBe(" ");
  });

  it("(B) 목록 표지 뒤 공백 수만 자: 목록 항목이고 항목 텍스트는 300자에서 잘린다", () => {
    expect(markdownBulletText("-" + spaces(60_000) + "fix crash")).toBe("fix crash");
    const s = summaryOf("- fix crash" + spaces(60_000) + "x");
    expect(items(s)).toEqual({ fix: [[1, ("fix crash" + spaces(60_000)).slice(0, 300)]] });
    expect(markdownBulletText("*" + spaces(60_000))).toBe(" ");
  });

  it("(C) 64 KiB에 가까운 단일 줄도 끝난다", () => {
    const line = "1." + spaces(NOTES_MAX - 2 - "security fix".length) + "security fix";
    expect(line.length).toBe(NOTES_MAX);
    expect(items(summaryOf(line))).toEqual({ security: [[1, "security fix"]] });
    const heading = "## " + spaces(NOTES_MAX - 4) + "x";
    expect(heading.length).toBe(NOTES_MAX);
    expect(markdownHeadingText(heading)).toBe("x");
  });

  it("(D) 닫는 #이 많거나 잘못된 제목: 정규식과 같은 경계로 읽는다", () => {
    expect(markdownHeadingText("## Breaking " + "#".repeat(60_000))).toBe("Breaking");
    expect(markdownHeadingText("## Breaking" + " #".repeat(30_000))).toBe("Breaking" + " #".repeat(29_999));
    expect(items(summaryOf("## Breaking" + " #".repeat(30_000) + "\n- rename option"))).toEqual({ breaking: [[2, "rename option"]] });
    // # 7개는 제목이 아니다(일반 줄 항목).
    expect(markdownHeadingText("####### " + spaces(60_000) + "fix")).toBeNull();
    expect(items(summaryOf("####### " + spaces(60_000) + "fix"))).toEqual({ other: [[1, ("####### " + spaces(60_000)).slice(0, 300)]] });
  });

  it("(E) 숫자 목록처럼 시작하지만 잘못된 긴 줄은 목록이 아니다", () => {
    expect(markdownBulletText("1234." + spaces(60_000) + "fix crash")).toBeNull();
    expect(markdownBulletText("12" + spaces(60_000) + "fix crash")).toBeNull();
    expect(markdownBulletText("1." + "x".repeat(60_000))).toBeNull();
    expect(items(summaryOf("1234." + spaces(60_000) + "fix crash"))).toEqual({ other: [[1, ("1234." + spaces(60_000)).slice(0, 300)]] });
  });

  it("(G) code fence 안의 긴 줄은 무시한다", () => {
    const notes = "\u0060\u0060\u0060\n# Security" + spaces(30_000) + "x\n- fix" + spaces(30_000) + "\n\u0060\u0060\u0060\n- faster startup";
    expect(items(summaryOf(notes))).toEqual({ performance: [[5, "faster startup"]] });
  });

  it("(H) HTML 주석·구분선의 긴 줄은 건너뛴다", () => {
    const notes = "<!--" + spaces(30_000) + "-->\n---" + spaces(30_000) + "\n- fixed crash";
    expect(items(summaryOf(notes))).toEqual({ fix: [[3, "fixed crash"]] });
  });

  it("입력이 2배가 되어도 시간이 폭발하지 않는다(선형)", () => {
    const shapes: [string, (n: number) => string, (s: string) => unknown][] = [
      ["heading", (n) => "# a" + spaces(n) + "x", markdownHeadingText],
      ["heading-hashes", (n) => "## a" + " #".repeat(n / 2) + "x", markdownHeadingText],
      ["bullet", (n) => "- a" + spaces(n) + "x", markdownBulletText],
      ["bullet-trailing", (n) => "1. a" + spaces(n), markdownBulletText],
      ["summary", (n) => "## Fixes" + spaces(n) + "x\n- a" + spaces(n) + "x", (s) => summaryOf(s)],
    ];
    const best = (fn: () => unknown) => {
      let min = Infinity;
      for (let r = 0; r < 5; r += 1) {
        const t = performance.now();
        fn();
        min = Math.min(min, performance.now() - t);
      }
      return min;
    };
    for (const [name, make, run] of shapes) {
      const small = make(16_000);
      const large = make(32_000);
      const a = best(() => run(small));
      const b = best(() => run(large));
      // 선형이면 약 2배다. 2차 이상이면 4배 이상이 된다. 작은 측정값의 흔들림은 고정 여유로 흡수한다.
      expect(b, name + " " + a.toFixed(2) + "ms → " + b.toFixed(2) + "ms").toBeLessThan(3 * a + 50);
    }
  });
});

