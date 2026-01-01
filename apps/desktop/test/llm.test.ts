import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { releaseSnapshotSchema, summarizeReleases, type ReleaseEntry, type ReleaseSnapshotV1 } from "@openhub/core";
import { AI_SUMMARY_CHANNEL, AiSummarySession, aiSummaryConsentLines, registerAiSummary, type AiSummaryDeps, type AiSummaryResponse } from "../src/llm";

/** TASK-063 Desktop AI Summary. 가짜 IPC·가짜 fetch·가짜 대화상자만 쓴다(실제 network·key 없음). */
const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");
const KEY = "sk-proj-" + "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0FeDcBa12";
const ID = "project:claude-code:memory";
const entry = (version: string, notes: string): ReleaseEntry => ({
  version,
  tag: "v" + version,
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
const snapshot: ReleaseSnapshotV1 = releaseSnapshotSchema.parse({
  schemaVersion: 1,
  toolId: "memory-mcp",
  versionSource: "npm",
  notesSource: "github-release",
  current: { spec: "@modelcontextprotocol/server-memory@2.0.3", version: "2.0.3", digest: null },
  target: entry("2.1.0", "- BREAKING: removed --legacy\n- Fixed crash"),
  between: [entry("2.1.0", "- BREAKING: removed --legacy\n- Fixed crash")],
  selection: { includePrerelease: false, comparable: true, skippedDrafts: 0, skippedPrereleases: 0, truncated: false },
  collectedAt: "2026-10-07T00:00:00.000Z",
  metadataDigest: "sha256:" + "a".repeat(64),
});
const summary = summarizeReleases(snapshot);
const responseOf = (text: string) => new Response(JSON.stringify({ id: "r", object: "response", output: [{ type: "message", role: "assistant", content: [{ type: "output_text", text }] }] }), { status: 200 });

function wired(over: Partial<AiSummaryDeps> & { key?: string | null; accept?: boolean; respond?: (url: string, init?: RequestInit) => Response | Promise<Response> } = {}) {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (c: string, fn: (...args: unknown[]) => unknown) => void handlers.set(c, fn) };
  const fetches: { url: string; init: RequestInit | undefined }[] = [];
  const dialogs: string[][] = [];
  let keyReads = 0;
  const session = new AiSummarySession();
  registerAiSummary(ipc, session, {
    readKey: () => (keyReads++, over.key === undefined ? KEY : over.key),
    confirm: async (lines) => (dialogs.push([...lines]), over.accept ?? true),
    fetch: async (url: string, init?: RequestInit) => (fetches.push({ url, init }), (over.respond ?? (() => responseOf("Summary: one breaking change.")))(url, init)),
    ...(over.timeoutMs === undefined ? {} : { timeoutMs: over.timeoutMs }),
  });
  const ask = (id: unknown, model: unknown) => handlers.get(AI_SUMMARY_CHANNEL)!({}, id, model) as Promise<AiSummaryResponse>;
  return { session, ask, fetches, dialogs, keyReads: () => keyReads };
}

describe("REQ-060 REQ-041 Desktop AI Summary", () => {
  it("AC-063-01 앱 시작·프로젝트 선택·릴리스 확인에서는 호출 0이고 [AI Summary] IPC 뒤에만 호출한다", async () => {
    const w = wired();
    expect(w.fetches).toHaveLength(0);
    w.session.remember(ID, snapshot, summary); // [릴리스 확인]이 하는 일
    expect([w.fetches.length, w.keyReads(), w.dialogs.length]).toEqual([0, 0, 0]);
    expect(await w.ask(ID, "gpt-test")).toMatchObject({ status: "ok", text: "Summary: one breaking change." });
    expect(w.fetches.map((f) => f.url)).toEqual(["https://api.openai.com/v1/responses"]);
    // release.ts·lifecycle.ts·install.ts·recommend.ts는 LLM provider·key를 다루지 않는다.
    for (const f of ["src/release.ts", "src/lifecycle.ts", "src/install.ts", "src/recommend.ts", "src/project-scan.ts"]) expect(await read(f), f).not.toMatch(/OPENAI|summary-llm|createOpenAiSummaryProvider|readOpenAiApiKey/u);
    const main = await read("src/main.ts");
    expect(main.match(/readOpenAiApiKey\(process\.env\)/gu)).toHaveLength(1);
    expect(main).toContain("readKey: () => readOpenAiApiKey(process.env)");
  });

  it("AC-063-02 key는 클릭 시점에만 읽고 없으면 안내만 하며 fetch 0이다", async () => {
    const w = wired({ key: null });
    w.session.remember(ID, snapshot, summary);
    expect(w.keyReads()).toBe(0);
    const r = await w.ask(ID, "gpt-test");
    expect(r).toMatchObject({ status: "no-key" });
    expect((r as { message: string }).message).toContain("OPENAI_API_KEY가 설정되지 않았습니다");
    expect([w.keyReads(), w.fetches.length, w.dialogs.length]).toEqual([1, 0, 0]);
  });

  it("AC-063-03 renderer로 가는 응답·preload API에 key 값·key 관련 함수가 없다", async () => {
    const w = wired();
    w.session.remember(ID, snapshot, summary);
    const r = await w.ask(ID, "gpt-test");
    expect(JSON.stringify(r)).not.toContain(KEY);
    const preload = await read("src/preload.ts");
    expect(preload).toContain('aiSummary: (id: unknown, model: unknown) => ipcRenderer.invoke("release:ai-summary", String(id), String(model))');
    expect(preload).not.toMatch(/OPENAI|apiKey|readKey|process\.env/u);
    const js = await read("renderer/llm.js");
    expect([...js.matchAll(/window\.openhubAi\.(\w+)/gu)].map((m) => m[1])).toEqual(["aiSummary"]);
    expect(js).not.toMatch(/OPENAI_API_KEY"|apiKey|localStorage|sessionStorage|indexedDB/u);
  });

  it("AC-063-04 LLM 요약 동안 파일 쓰기 0, log·console에 key 0, analytics 호출이 없다", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m));
    const w = wired();
    w.session.remember(ID, snapshot, summary);
    await w.ask(ID, "gpt-test");
    for (const s of spies) {
      expect(JSON.stringify(s.mock.calls)).not.toContain(KEY);
      s.mockRestore();
    }
    expect(w.fetches.every((f) => f.url === "https://api.openai.com/v1/responses")).toBe(true);
    const src = await read("src/llm.ts");
    expect(src).not.toMatch(/node:fs|writeFile|appendFile|console\./u);
    // key는 provider의 Authorization 헤더에만 들어간다.
    expect(JSON.stringify(w.fetches[0]!.init?.headers)).toContain(KEY);
    expect(String(w.fetches[0]!.init?.body)).not.toContain(KEY);
  });

  it("AC-063-05 model ID는 사용자 입력이 필요하고 세션 메모리에만 있으며 형식이 잘못되면 fetch 전에 거부한다", async () => {
    const w = wired();
    w.session.remember(ID, snapshot, summary);
    for (const bad of ["", "   ", "gpt 4; rm -rf", "-flag", "x".repeat(101), 42]) expect((await w.ask(ID, bad)).status, String(bad)).toBe("invalid-model");
    expect([w.fetches.length, w.keyReads()]).toEqual([0, 0]);
    const js = await read("renderer/llm.js");
    expect(js).toContain('let model = "";');
    const main = await read("src/main.ts");
    expect(main).not.toMatch(/model.*writeFile|store\.set\(/u);
  });

  it("AC-063-06 실패(HTTP·크기·형식·timeout)면 결정론 요약은 그대로이고 오류만 알린다", async () => {
    const hang = (init?: RequestInit) => new Promise<Response>((_, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
    const cases: [string, (init?: RequestInit) => Response | Promise<Response>, number | undefined][] = [
      ["http-error", () => new Response("nope", { status: 500 }), undefined],
      ["too-large", () => new Response("x".repeat(70 * 1024), { status: 200 }), undefined],
      ["invalid-response", () => new Response("{}", { status: 200 }), undefined],
      ["timeout", hang, 50],
    ];
    for (const [reason, respond, timeoutMs] of cases) {
      const before = JSON.stringify(summary);
      const w = wired({ respond: (_u, init) => respond(init), ...(timeoutMs === undefined ? {} : { timeoutMs }) });
      w.session.remember(ID, snapshot, summary);
      const r = await w.ask(ID, "gpt-test");
      expect(r, reason).toMatchObject({ status: "failed", reason });
      expect((r as { message: string }).message).toContain("결정론 요약은 그대로");
      expect(JSON.stringify(w.session.get(ID)!.summary)).toBe(before);
    }
  });

  it("AC-063-07 LLM 응답은 textContent로만 들어간다", async () => {
    const html = "<img src=x onerror=alert(1)><script>alert(2)</script>";
    const w = wired({ respond: () => responseOf(html) });
    w.session.remember(ID, snapshot, summary);
    expect(await w.ask(ID, "gpt-test")).toMatchObject({ status: "ok", text: html });
    const js = await read("renderer/llm.js");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/u);
    expect(js).toContain("out.textContent = r.status === \"ok\"");
  });

  it("AC-063-08 세션 첫 호출 전 보낼 내용과 목적지를 확인하고 취소하면 fetch 0이다", async () => {
    const cancel = wired({ accept: false });
    cancel.session.remember(ID, snapshot, summary);
    expect(await cancel.ask(ID, "gpt-test")).toMatchObject({ status: "cancelled" });
    expect(cancel.fetches).toHaveLength(0);
    expect(cancel.dialogs[0]!.join("\n")).toContain("api.openai.com");
    expect(cancel.dialogs[0]!.join("\n")).toContain("memory-mcp (2.0.3 → 2.1.0)");
    expect(cancel.dialogs[0]!.join("\n")).not.toContain(KEY);
    const ok = wired();
    ok.session.remember(ID, snapshot, summary);
    await ok.ask(ID, "gpt-test");
    await ok.ask(ID, "gpt-test");
    expect([ok.dialogs.length, ok.fetches.length]).toEqual([1, 2]);
    expect(aiSummaryConsentLines({ toolId: "memory-mcp", snapshot })).toContain("보내지 않는 것: 설정 파일, 경로, 환경변수 값, Version State");
  });
});

