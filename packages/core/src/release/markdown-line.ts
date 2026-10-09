/**
 * Release note 한 줄의 Markdown 제목·목록 표지를 backtracking 없이 읽는다.
 *
 * 예전에는 아래 두 정규식을 썼다.
 *   HEADING  /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u
 *   BULLET   /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.+?)\s*$/u
 * `\s+`, lazy `(.+?)`, 꼬리의 `\s*`(와 `#*`)가 같은 공백을 두고 경쟁해서, 표지 뒤 공백이 긴 줄에서
 * 실행 시간이 줄 길이에 대해 다항식으로 늘었다(제목은 공백 4,000자에 수십 초). Release note는 제3자 입력이다.
 *
 * 이 모듈은 같은 정규식의 match 여부와 capture를 그대로 만들되, 줄을 앞에서 한 번·뒤에서 한 번만 훑는다.
 * - 공백 판정은 정규식과 같은 `\s`(u 플래그)다.
 * - capture `(.+?)`는 줄 끝 문자(\n·\r·U+2028·U+2029)를 포함할 수 없고 code point 하나 이상이다.
 * - `\s+(.+?)<꼬리>$`의 lazy capture는 "꼬리가 맞기 시작하는 가장 이른 위치"까지다. 그 위치를 오른쪽에서 한 번 훑어 구한다.
 * 결과가 옛 정규식과 같은지는 테스트가 짧은 입력 전체와 무작위 입력으로 대조한다.
 */

const WHITESPACE = /^\s$/u;
const isWs = (c: string | undefined): boolean => c !== undefined && WHITESPACE.test(c);
const isLineTerminator = (c: string): boolean => c === "\n" || c === "\r" || c === "\u2028" || c === "\u2029";
const isDigit = (c: string | undefined): boolean => c !== undefined && c >= "0" && c <= "9";

/** `.`(u 플래그)가 i에서 소비하는 code unit 수: surrogate pair면 2, 아니면 1. */
function codePointLength(s: string, i: number): number {
  const hi = s.charCodeAt(i);
  if (hi >= 0xd800 && hi <= 0xdbff && i + 1 < s.length) {
    const lo = s.charCodeAt(i + 1);
    if (lo >= 0xdc00 && lo <= 0xdfff) return 2;
  }
  return 1;
}

function skipWhitespace(s: string, i: number): number {
  let j = i;
  while (j < s.length && isWs(s[j])) j += 1;
  return j;
}

/** end 왼쪽으로 이어지는 공백 연속이 시작하는 위치. */
function whitespaceRunStart(s: string, end: number): number {
  let j = end;
  while (j > 0 && isWs(s[j - 1])) j -= 1;
  return j;
}

/**
 * 표지 바로 뒤(p)에서 `\s+(.+?)<꼬리>$`를 맞춘다. tailStart는 그 위치부터 줄 끝까지가 꼬리에 맞는 가장 이른 위치다.
 * 정규식처럼 `\s+`를 가장 길게 잡고, 그 뒤가 비어 있을 때만 하나씩 줄여 capture에 공백 한 글자를 넘긴다.
 */
function lazyCapture(s: string, p: number, tailStart: number): string | null {
  const spaces = skipWhitespace(s, p) - p;
  if (spaces === 0) return null;
  const captureFrom = (start: number): string | null => {
    const end = Math.max(start + codePointLength(s, start), tailStart);
    for (let i = start; i < end; i += 1) if (isLineTerminator(s[i]!)) return null;
    return s.slice(start, end);
  };
  // 공백 뒤에 내용이 있으면 capture는 그 내용에서 시작한다. 여기서 실패(줄 끝 문자)하면 \s+를 줄여도 같은 문자를 지나야 해서 실패한다.
  if (p + spaces < s.length) return captureFrom(p + spaces);
  // 표지 뒤가 모두 공백이면 \s+를 줄여 뒤쪽 공백 한 글자를 capture한다(줄 끝 문자는 capture할 수 없다).
  for (let k = spaces - 1; k >= 1; k -= 1) {
    const c = captureFrom(p + k);
    if (c !== null) return c;
  }
  return null;
}

/** `/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u`의 capture 1. 제목 줄이 아니면 null. */
export function markdownHeadingText(line: string): string | null {
  const lead = skipWhitespace(line, 0);
  if (lead > 3 || line[lead] !== "#") return null;
  let p = lead;
  while (line[p] === "#") p += 1;
  if (p - lead > 6) return null;
  // 꼬리 \s*#*\s*$: 뒤 공백, 그 앞 # 연속, 그 앞 공백.
  let tail = whitespaceRunStart(line, line.length);
  while (tail > 0 && line[tail - 1] === "#") tail -= 1;
  tail = whitespaceRunStart(line, tail);
  return lazyCapture(line, p, tail);
}

/** `/^\s*(?:[-*+]|\d{1,3}[.)])\s+(.+?)\s*$/u`의 capture 1. 목록 줄이 아니면 null. */
export function markdownBulletText(line: string): string | null {
  let p = skipWhitespace(line, 0);
  const c = line[p];
  if (c === "-" || c === "*" || c === "+") p += 1;
  else {
    const digits = p;
    while (isDigit(line[p])) p += 1;
    if (p === digits || p - digits > 3 || (line[p] !== "." && line[p] !== ")")) return null;
    p += 1;
  }
  return lazyCapture(line, p, whitespaceRunStart(line, line.length));
}

