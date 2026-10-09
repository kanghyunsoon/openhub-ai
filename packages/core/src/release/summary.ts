import { z } from "zod";
import { canonicalize } from "../installer/plan";
import { markdownBulletText, markdownHeadingText } from "./markdown-line";
import type { ReleaseEntry, ReleaseSnapshotV1 } from "./snapshot";

/**
 * 결정론 Release Summary(TASK-049, D-023).
 * - release note의 제목 줄과 고정 키워드 표로 Breaking·Security·Compatibility·Performance·Fix·Other로 나눈다.
 * - 항목마다 {version, line} 근거(notes 안의 1-based 줄 번호)를 붙인다. 원문은 ReleaseSnapshot의 notes에 그대로 있다.
 * - LLM·network·clock·디스크를 쓰지 않는다. 같은 Snapshot이면 같은 요약 byte다.
 * - 분류 우선순위: 줄 자체의 Breaking·Security 키워드 > 제목 줄 분류 > 줄의 Compatibility·Performance·Fix 키워드 > Other.
 * - notes 안의 문장은 데이터일 뿐이다. 지시문처럼 보여도 분류 규칙 외의 동작을 바꾸지 않는다.
 */

export const RELEASE_SUMMARY_SCHEMA_VERSION = 1 as const;
export const SUMMARY_CATEGORIES = ["breaking", "security", "compatibility", "performance", "fix", "other"] as const;
export type SummaryCategory = (typeof SUMMARY_CATEGORIES)[number];
export const SUMMARY_ITEM_MAX_CHARS = 300;
export const SUMMARY_ITEMS_PER_CATEGORY = 50;

const HEADING_RULES: readonly (readonly [SummaryCategory, RegExp])[] = [
  ["breaking", /\bbreaking\b|\bremoved\b|\bremovals?\b|\bmajor changes?\b/iu],
  ["security", /\bsecurity\b|\bvulnerab|\bcve\b|\badvisor/iu],
  ["compatibility", /\bcompatib|\bdeprecat|\bmigrat|\bupgrade (?:guide|notes?)\b|\brequirements?\b/iu],
  ["performance", /\bperformance\b|\bperf\b|\boptimi[sz]/iu],
  ["fix", /\bfix(?:es|ed)?\b|\bbugs?\b|\bbug ?fix/iu],
];
const STRONG_LINE_RULES: readonly (readonly [SummaryCategory, RegExp])[] = [
  ["breaking", /\bbreaking\b|^[a-z]+(?:\([^)]*\))?!:/iu],
  ["security", /\bsecurity\b|\bCVE-\d{4}-\d{4,}\b|\bGHSA-[0-9a-z]{4}-|\bvulnerab|\bXSS\b|\bCSRF\b|\bSSRF\b/iu],
];
const WEAK_LINE_RULES: readonly (readonly [SummaryCategory, RegExp])[] = [
  ["compatibility", /\bcompatib|\bdeprecat|\bmigrat|\bdrop(?:s|ped)? support\b|\bnode(?:\.js)? ?(?:>=|v?\d{2})|\bpython ?(?:>=|3\.\d+)|\bconfig(?:uration)? format\b/iu],
  ["performance", /^perf(?:\([^)]*\))?:|\bperformance\b|\bfaster\b|\bspeed ?up\b|\boptimi[sz]|\blatency\b|\bmemory usage\b/iu],
  ["fix", /^fix(?:\([^)]*\))?:|\bfix(?:es|ed)?\b|\bbugs?\b|\bcrash(?:es|ed)?\b|\bregression\b/iu],
];

const item = z.strictObject({ version: z.string().min(1).max(300), line: z.number().int().min(1), text: z.string().min(1).max(SUMMARY_ITEM_MAX_CHARS) });
export type SummaryItem = z.output<typeof item>;

export const releaseSummarySchema = z.strictObject({
  schemaVersion: z.literal(RELEASE_SUMMARY_SCHEMA_VERSION),
  toolId: z.string().min(1).max(300),
  /** 요약에 들어간 버전(Snapshot between 순서, 없으면 target). */
  versions: z.array(z.string().min(1).max(300)),
  categories: z.strictObject(Object.fromEntries(SUMMARY_CATEGORIES.map((c) => [c, z.array(item).max(SUMMARY_ITEMS_PER_CATEGORY)])) as Record<SummaryCategory, z.ZodArray<typeof item>>),
  /** 카테고리당 상한 때문에 빠진 항목 수 */
  omitted: z.strictObject(Object.fromEntries(SUMMARY_CATEGORIES.map((c) => [c, z.number().int().min(0)])) as Record<SummaryCategory, z.ZodNumber>),
  /** notes가 없는 버전 / 64 KiB에서 잘린 notes의 버전 */
  notesMissing: z.array(z.string()),
  notesTruncated: z.array(z.string()),
});
export type ReleaseSummaryV1 = z.output<typeof releaseSummarySchema>;

const firstMatch = (rules: readonly (readonly [SummaryCategory, RegExp])[], text: string): SummaryCategory | null => {
  for (const [category, re] of rules) if (re.test(text)) return category;
  return null;
};

// ATX 제목(#)과 목록 표지는 markdown-line.ts가 선형 시간으로 읽는다(제3자 입력의 긴 공백 줄에서 정규식 backtracking이 폭주했다).
const BOLD_HEADING = /^\s{0,3}(?:\*\*|__)([^*_]{1,120})(?:\*\*|__):?\s*$/u;
const COLON_HEADING = /^\s{0,3}([A-Za-z][A-Za-z '’&/-]{1,60}):\s*$/u;
const FENCE = /^\s{0,3}(?:\u0060{3,}|~{3,})/u;

interface Line {
  line: number;
  text: string;
  heading: SummaryCategory | null;
  bullet: boolean;
}

function scanNotes(notes: string): Line[] {
  const out: Line[] = [];
  let heading: SummaryCategory | null = null;
  let fenced = false;
  notes.split(/\r\n|\n|\r/u).forEach((raw, i) => {
    if (FENCE.test(raw)) {
      fenced = !fenced;
      return;
    }
    if (fenced || raw.trim() === "") return;
    const h = markdownHeadingText(raw) ?? BOLD_HEADING.exec(raw)?.[1] ?? COLON_HEADING.exec(raw)?.[1] ?? null;
    if (h !== null) {
      heading = firstMatch(HEADING_RULES, h);
      return;
    }
    if (/^\s*(?:<!--.*-->|[-=*_]{3,})\s*$/u.test(raw)) return;
    const b = markdownBulletText(raw);
    out.push({ line: i + 1, text: (b === null ? raw.trim() : b).slice(0, SUMMARY_ITEM_MAX_CHARS), heading, bullet: b !== null });
  });
  // 목록이 있으면 목록 항목만, 없으면 일반 줄을 항목으로 쓴다.
  return out.some((l) => l.bullet) ? out.filter((l) => l.bullet) : out;
}

export function classifyLine(text: string, heading: SummaryCategory | null): SummaryCategory {
  return firstMatch(STRONG_LINE_RULES, text) ?? heading ?? firstMatch(WEAK_LINE_RULES, text) ?? "other";
}

/** Snapshot의 target·between notes로 결정론 요약을 만든다. */
export function summarizeReleases(snapshot: ReleaseSnapshotV1): ReleaseSummaryV1 {
  const entries: ReleaseEntry[] = snapshot.between.length > 0 ? snapshot.between : snapshot.target === null ? [] : [snapshot.target];
  const categories = Object.fromEntries(SUMMARY_CATEGORIES.map((c) => [c, [] as SummaryItem[]])) as Record<SummaryCategory, SummaryItem[]>;
  const omitted = Object.fromEntries(SUMMARY_CATEGORIES.map((c) => [c, 0])) as Record<SummaryCategory, number>;
  const notesMissing: string[] = [];
  const notesTruncated: string[] = [];
  const seen = new Set<string>();
  const versions: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.version)) continue;
    seen.add(entry.version);
    versions.push(entry.version);
    if (entry.notes === null) {
      notesMissing.push(entry.version);
      continue;
    }
    if (entry.notes.truncated) notesTruncated.push(entry.version);
    for (const l of scanNotes(entry.notes.text)) {
      const category = classifyLine(l.text, l.heading);
      if (categories[category].length >= SUMMARY_ITEMS_PER_CATEGORY) omitted[category] += 1;
      else categories[category].push({ version: entry.version, line: l.line, text: l.text });
    }
  }
  return releaseSummarySchema.parse({ schemaVersion: RELEASE_SUMMARY_SCHEMA_VERSION, toolId: snapshot.toolId, versions, categories, omitted, notesMissing, notesTruncated });
}

export function serializeReleaseSummary(summary: ReleaseSummaryV1): string {
  return JSON.stringify(canonicalize(releaseSummarySchema.parse(summary)), null, 2) + "\n";
}

