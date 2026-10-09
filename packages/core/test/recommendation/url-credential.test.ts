import { describe, expect, it } from "vitest";
import { URL_CREDENTIAL_PATTERN, collectReleaseSnapshot, redactSensitive, type ReleaseRequest } from "../../src/index";

/**
 * URL credential 패턴의 선형 시간 보장과 예전 패턴과의 결과 동등성.
 * 예전 패턴은 짧은 입력의 기준 답(oracle)으로만 쓴다(긴 입력에서 제곱 시간이 걸리는 게 고친 문제다).
 */
const LEGACY = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/u;
const legacyRedact = (text: string) => text.replace(new RegExp(LEGACY.source, "gu"), (m) => m.slice(0, m.indexOf("://") + 3) + "[redacted]@");
const currentRedact = (text: string) => text.replace(new RegExp(URL_CREDENTIAL_PATTERN.source, "gu"), (m) => m.slice(0, m.indexOf("://") + 3) + "[redacted]@");

// scheme 문자(글자·숫자·+·.·-), 구분자(:·/·@), 공백, 비 ASCII 글자.
const ALPHABET = ["a", "Z", "1", "+", ".", "-", ":", "/", "@", " ", "é"];
function* allStrings(maxLen: number): Generator<string> {
  let level = [""];
  yield "";
  for (let n = 1; n <= maxLen; n += 1) {
    const next: string[] = [];
    for (const p of level) for (const c of ALPHABET) next.push(p + c);
    yield* next;
    level = next;
  }
}
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
const best = (fn: () => unknown) => {
  let min = Infinity;
  for (let r = 0; r < 5; r += 1) {
    const t = performance.now();
    fn();
    min = Math.min(min, performance.now() - t);
  }
  return min;
};

describe("URL credential 패턴: 예전 패턴과 같은 결과", () => {
  it("길이 6 이하의 모든 입력(11글자 alphabet)에서 test 결과와 가린 결과가 예전 패턴과 같다", () => {
    let n = 0;
    for (const s of allStrings(6)) {
      if (URL_CREDENTIAL_PATTERN.test(s) !== LEGACY.test(s)) expect(URL_CREDENTIAL_PATTERN.test(s), JSON.stringify(s)).toBe(LEGACY.test(s));
      if (currentRedact(s) !== legacyRedact(s)) expect(currentRedact(s), JSON.stringify(s)).toBe(legacyRedact(s));
      n += 1;
    }
    expect(n).toBe(1_948_717);
  });

  it("모든 4자 이하 앞부분 × URL credential 꼴 뒷부분에서 일치 여부·일치 위치·가린 결과가 같다", () => {
    const tails = ["://u:p@h", "://u:p@", "://:p@", "://u:@", "://u:p", "://u@p:x@", "://u:p:q@h", "://u:p@h/x://v:w@y"];
    let matched = 0;
    for (const head of allStrings(4)) {
      for (const tail of tails) {
        const s = head + tail;
        const want = LEGACY.exec(s);
        const got = URL_CREDENTIAL_PATTERN.exec(s);
        if ((want?.index ?? -1) !== (got?.index ?? -1) || want?.[0] !== got?.[0]) expect([got?.index, got?.[0]], JSON.stringify(s)).toEqual([want?.index, want?.[0]]);
        if (currentRedact(s) !== legacyRedact(s)) expect(currentRedact(s), JSON.stringify(s)).toBe(legacyRedact(s));
        if (want !== null) matched += 1;
      }
    }
    // 대조가 실제 일치 사례를 충분히 포함하는지 확인한다(고정 입력이라 개수가 정해져 있다).
    expect(matched).toBe(29_617);
  });

  it("URL 조각을 섞은 고정 seed 무작위 입력 30,000개에서 test·가린 결과가 같다", () => {
    const parts = ["https", "git+ssh", "1a", "a1", "x", "://", ":", "/", "@", "user", "pa:ss", " ", ".", "-", "+", "host.example", "é", "\n", "x://u:p@", "://u:p@"];
    const rnd = prng(20261009);
    let matched = 0;
    for (let i = 0; i < 30_000; i += 1) {
      let s = "";
      const len = 1 + Math.floor(rnd() * 14);
      for (let k = 0; k < len; k += 1) s += parts[Math.floor(rnd() * parts.length)]!;
      if (URL_CREDENTIAL_PATTERN.test(s) !== LEGACY.test(s)) expect(URL_CREDENTIAL_PATTERN.test(s), JSON.stringify(s)).toBe(LEGACY.test(s));
      if (currentRedact(s) !== legacyRedact(s)) expect(currentRedact(s), JSON.stringify(s)).toBe(legacyRedact(s));
      if (LEGACY.test(s)) matched += 1;
    }
    expect(matched).toBeGreaterThan(5_000);
  });

  it("실제 credential 형태는 그대로 가린다", () => {
    expect(redactSensitive("clone https://alice:s3cret@github.com/acme/x.git now")).toBe("clone https://[redacted]@github.com/acme/x.git now");
    expect(redactSensitive("a git+ssh://u:p@h b 1https://u:p@h")).toBe("a git+ssh://[redacted]@h b 1https://[redacted]@h");
    expect(URL_CREDENTIAL_PATTERN.test("postgres://db:pw@localhost:5432/app")).toBe(true);
    expect(URL_CREDENTIAL_PATTERN.test("https://github.com/acme/x")).toBe(false);
    expect(URL_CREDENTIAL_PATTERN.test("123://u:p@h")).toBe(false);
  });
});

describe("URL credential 패턴: 긴 입력에서 선형 시간", () => {
  const shapes: [string, (n: number) => string][] = [
    ["letters", (n) => "A".repeat(n)],
    ["alnum", (n) => "a1".repeat(n / 2)],
    ["digits-then-letter", (n) => "1".repeat(n) + "a"],
    ["scheme-no-userinfo", (n) => "a://" + "b".repeat(n)],
    ["userinfo-no-at", (n) => "a://b:" + "c".repeat(n)],
    ["repeated-schemes", (n) => "a://b:c ".repeat(n / 8)],
    ["colons", (n) => "a:".repeat(n / 2)],
  ];

  it("1 MiB 공격형 입력도 test·redactSensitive가 끝나고, 입력이 2배가 되어도 시간이 폭발하지 않는다", () => {
    for (const [name, make] of shapes) {
      const big = make(1024 * 1024);
      URL_CREDENTIAL_PATTERN.test(big);
      redactSensitive(big);
      const a = best(() => redactSensitive(make(32_768)));
      const b = best(() => redactSensitive(make(65_536)));
      // 선형이면 약 2배, 제곱이면 약 4배다. 작은 측정값의 흔들림은 고정 여유로 흡수한다.
      expect(b, name + " " + a.toFixed(2) + "ms → " + b.toFixed(2) + "ms").toBeLessThan(3 * a + 50);
    }
  });

  it("npm deprecated가 1 MiB에 가까워도 ReleaseSnapshot 수집이 끝나고 300자로 잘린다(외부 입력 경로)", async () => {
    const latest = "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest";
    const doc = JSON.stringify({ name: "@modelcontextprotocol/server-memory", version: "2.1.0", engines: { node: ">=20" }, deprecated: "A".repeat(1024 * 1024 - 200) });
    expect(doc.length).toBeLessThan(1024 * 1024);
    const request: ReleaseRequest = { toolId: "memory-mcp", versionSource: "npm", backend: "npx", requested: "@modelcontextprotocol/server-memory", resolved: null };
    const fetch = async (url: string) => (url === latest ? new Response(doc, { status: 200, headers: { "content-type": "application/json" } }) : new Response("missing", { status: 404 }));
    const r = await collectReleaseSnapshot(request, { fetch, now: () => new Date("2026-10-07T00:00:00.000Z") });
    if (!r.ok) throw new Error(r.code);
    expect(r.snapshot.target?.deprecated).toBe("A".repeat(300));
  });
});

