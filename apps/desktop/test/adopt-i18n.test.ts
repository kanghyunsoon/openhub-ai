import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ADOPT_APPROVAL_MESSAGES,
  ADOPT_APPROVAL_REQUIREMENTS,
  ADOPT_BLOCKER_CODES,
  BENCHMARK_APPROVAL_MESSAGES,
  BENCHMARK_APPROVAL_REQUIREMENTS,
  BENCHMARK_BLOCKER_CODES,
  type HealthChild,
  type HealthSpawner,
} from "@openhub/core";
import { ADOPT_CANDIDATES_CHANNEL, ADOPT_RUN_CHANNEL, BENCHMARK_RUN_CHANNEL, registerAdopt, type AdoptCandidatesResponse, type AdoptRunResponse, type BenchmarkRunResponse } from "../src/adopt";
import { ADOPT_APPROVAL_EN, ADOPT_BENCHMARK_ERROR_EN, ADOPT_BLOCKER_EN, BENCHMARK_APPROVAL_EN, BENCHMARK_BLOCKER_EN, adoptBenchmarkErrorEn } from "../src/i18n/adopt-en";
import { setDesktopLocale } from "../src/i18n/index";
import { InstallSession, type NativeDialogLike } from "../src/install";
import { PROJECT_SCAN_CHANNEL, fixedDirectory, registerProjectScan } from "../src/project-scan";
import { RecommendSession } from "../src/recommend";

/**
 * v0.2.0 P0-3 PR B 보완: Adopt·Benchmark 실행 승인 화면의 English 표시. 실제 Core Plan·승인 kernel·네이티브 대화상자 자리(가짜)로
 * 지나간다(임시 project·home, 가짜 MCP 서버, network·실제 spawn 0). 한국어 모드는 Core 문장 그대로인지 같이 본다.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY = path.join(ROOT, "registry");
const MEMORY = "@modelcontextprotocol/server-memory";
const HANGUL = /[\uac00-\ud7a3]/u;
const NOW = () => new Date("2026-10-08T01:00:00.000Z");
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-adopt-i18n-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
beforeEach(() => setDesktopLocale("en"));
afterEach(() => setDesktopLocale("en"));

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

type Dialog = { title: string; message: string; detail: string; buttons: string[] };

async function wired(mcpServers: Record<string, unknown>, options: { accept?: boolean } = {}) {
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
  const dialogs: Dialog[] = [];
  const dialog: NativeDialogLike = {
    showMessageBox: async (o) => (dialogs.push({ title: o.title ?? "", message: o.message, detail: o.detail ?? "", buttons: [...(o.buttons ?? [])] }), { response: options.accept === false ? 0 : 1 }),
  };
  const spawns: string[][] = [];
  const healthSpawner: HealthSpawner = (exe, args, o) => {
    spawns.push([exe, ...args, "shell=" + String(o.shell)]);
    return new FakeServer();
  };
  registerAdopt(ipc, { registryDir: REGISTRY, homeDir: home, platform: "linux", projectDir: () => is.projectDir, dialog, now: NOW, healthSpawner, killTree: async () => true, tempBase: await mkdtemp(path.join(base, "tmp-")) });
  const call = <T>(channel: string, ...args: unknown[]) => handlers.get(channel)!({}, ...args) as Promise<T>;
  await call(PROJECT_SCAN_CHANNEL);
  return { project, home, mcpText, dialogs, spawns, call };
}

describe("v0.2.0 PR B Adopt·Benchmark English 승인", () => {
  it("모든 Adopt·Benchmark 승인 요구 ID·blocker code·Core 오류 code에 영어 문장이 있다", async () => {
    for (const id of ADOPT_APPROVAL_REQUIREMENTS) expect(ADOPT_APPROVAL_EN[id], id).toBeTruthy();
    for (const id of BENCHMARK_APPROVAL_REQUIREMENTS) expect(BENCHMARK_APPROVAL_EN[id], id).toBeTruthy();
    for (const c of ADOPT_BLOCKER_CODES) expect(ADOPT_BLOCKER_EN[c], c).toBeTruthy();
    for (const c of BENCHMARK_BLOCKER_CODES) expect(BENCHMARK_BLOCKER_EN[c], c).toBeTruthy();
    for (const v of [...Object.values(ADOPT_APPROVAL_EN), ...Object.values(BENCHMARK_APPROVAL_EN), ...Object.values(ADOPT_BLOCKER_EN), ...Object.values(BENCHMARK_BLOCKER_EN), ...Object.values(ADOPT_BENCHMARK_ERROR_EN)]) expect(v).not.toMatch(HANGUL);
    // Core adopt·benchmark 소스가 돌려주는 오류 code(Plan 생성·실행 전 확인)는 모두 영어 문장이 있다.
    const codes = new Set<string>();
    for (const d of ["packages/core/src/adopt", "packages/core/src/benchmark"]) {
      for (const f of (await readdir(path.join(ROOT, d))).filter((x) => x.endsWith(".ts"))) {
        const text = await readFile(path.join(ROOT, d, f), "utf8");
        for (const m of text.matchAll(/code: "([A-Z][A-Z_]+)"/gu)) codes.add(m[1]!);
      }
    }
    const blockers = new Set<string>([...ADOPT_BLOCKER_CODES, ...BENCHMARK_BLOCKER_CODES]);
    const missing = [...codes].filter((c) => !blockers.has(c) && adoptBenchmarkErrorEn(c, "원문").startsWith("(not translated)"));
    expect(missing).toEqual([]);
    expect(adoptBenchmarkErrorEn("FUTURE_CODE", "새 오류 원문")).toBe("(not translated) 새 오류 원문");
  });

  it("Adopt(exact): 후보 Preview·네이티브 승인 대화상자·결과가 영어이고 승인 요구 ID가 모두 보이며 설정 파일은 그대로다", async () => {
    const c = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } });
    const list = await c.call<AdoptCandidatesResponse>(ADOPT_CANDIDATES_CHANNEL);
    if (list.status !== "ok") throw new Error(list.status);
    const preview = list.items[0]!.lines.join("\n");
    expect(preview).not.toMatch(HANGUL);
    expect(preview).toContain("Identification: exact");
    expect(preview).toContain("Effects: 1 Version State write · 0 configuration file changes · 0 processes run · 0 network use");
    expect(preview).toContain("Health: Not verified (adopt does not run the MCP server)");
    expect(preview).toMatch(/Plan digest: sha256:[0-9a-f]{64}/u);
    const done = await c.call<AdoptRunResponse>(ADOPT_RUN_CHANNEL, "project:claude-code:memory");
    expect(done).toMatchObject({ status: "done", adopted: true });
    expect(c.dialogs).toHaveLength(1);
    const d = c.dialogs[0]!;
    expect(d.title).toBe("OpenHub Adopt approval");
    expect(d.buttons).toEqual(["Cancel", "Approve"]);
    for (const s of [d.title, d.message, d.detail]) expect(s).not.toMatch(HANGUL);
    expect(d.detail).toContain("• [base] " + ADOPT_APPROVAL_EN.base);
    expect(d.detail).toContain("Approval items:");
    if (done.status !== "done") return;
    expect(done.lines.join("\n")).not.toMatch(HANGUL);
    expect(done.lines[0]).toBe("Adopt completed: memory-mcp (Version State revision 1). Configuration files were not changed.");
    expect(await readFile(path.join(c.project, ".mcp.json"), "utf8")).toBe(c.mcpText);
  });

  it("Adopt(strong·unlocked): strong 판정과 artifact-unlocked 승인 요구가 영어로 대화상자에 보인다. 거부하면 아무것도 기록하지 않는다", async () => {
    const c = await wired({ "my-memory": { command: "npx", args: ["-y", MEMORY] } }, { accept: false });
    expect(await c.call(ADOPT_RUN_CHANNEL, "project:claude-code:my-memory")).toEqual({ status: "rejected" });
    const d = c.dialogs[0]!;
    expect(d.detail).not.toMatch(HANGUL);
    expect(d.detail).toContain("Identification: strong");
    expect(d.detail).toContain("Current server name: my-memory");
    expect(d.detail).toContain("• [identity-strong-match] " + ADOPT_APPROVAL_EN["identity-strong-match"]);
    expect(d.detail).toContain("• [artifact-unlocked] " + ADOPT_APPROVAL_EN["artifact-unlocked"]);
    expect(d.detail).toContain("artifact-unlocked: the version is not pinned, so no exact artifact is recorded");
    expect(await readdir(c.home)).toEqual([]);
  });

  it("Benchmark: unlocked 차단 이유, Preview(실행 6회·제한 시간·외부 코드·Health와 별개), 승인 대화상자, 결과가 영어다", async () => {
    const unlocked = await wired({ memory: { command: "npx", args: ["-y", MEMORY] } });
    await unlocked.call(ADOPT_RUN_CHANNEL, "project:claude-code:memory");
    const blocked = await unlocked.call<AdoptCandidatesResponse>(ADOPT_CANDIDATES_CHANNEL);
    expect(blocked).toMatchObject({ status: "ok", benchmark: [{ ready: false, reasons: ["BENCHMARK_ARTIFACT_UNLOCKED — " + BENCHMARK_BLOCKER_EN.BENCHMARK_ARTIFACT_UNLOCKED] }] });
    const blockedRun = await unlocked.call<BenchmarkRunResponse>(BENCHMARK_RUN_CHANNEL, "project:claude-code:memory");
    if (blockedRun.status !== "blocked") throw new Error(blockedRun.status);
    expect(blockedRun.lines.join("\n")).not.toMatch(HANGUL);
    expect(blockedRun.lines).toContain("Blocked: BENCHMARK_ARTIFACT_UNLOCKED — " + BENCHMARK_BLOCKER_EN.BENCHMARK_ARTIFACT_UNLOCKED);
    expect(unlocked.spawns).toEqual([]);

    const c = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } });
    await c.call(ADOPT_RUN_CHANNEL, "project:claude-code:memory");
    const r = await c.call<BenchmarkRunResponse>(BENCHMARK_RUN_CHANNEL, "project:claude-code:memory");
    if (r.status !== "done") throw new Error(JSON.stringify(r));
    const d = c.dialogs[1]!;
    expect(d.title).toBe("OpenHub Benchmark approval");
    for (const s of [d.title, d.message, d.detail]) expect(s).not.toMatch(HANGUL);
    expect(d.message).toContain("6 times");
    expect(d.detail).toContain("Runs: 1 warm-up + 5 measured — the MCP server is started 6 times · limits: startup 20 s · handshake 10 s · 45 s per run · 300 s total");
    expect(d.detail).toContain("Each run starts the MCP server (third-party code) and measures only initialize and tools/list response times. No MCP tool is called (tools/call 0).");
    expect(d.detail).toContain("This is not a Health Check: Version State and the recorded Health status do not change.");
    expect(d.detail).toContain("(isolated temporary directory, no shell)");
    expect(d.detail).toContain("• [base] " + BENCHMARK_APPROVAL_EN.base);
    expect(d.detail).toContain("• [artifact-fetch] " + BENCHMARK_APPROVAL_EN["artifact-fetch"]);
    expect(c.spawns).toHaveLength(6);
    expect(r.lines.join("\n")).not.toMatch(HANGUL);
    expect(r.lines[0]).toMatch(/^Benchmark memory-mcp — \d of 5 measured runs succeeded · \d failed$/u);
    for (const l of r.lines.slice(1, 6)) expect(l).toMatch(/median \d+ ms · min \d+ · max \d+|measurement failed/u);

    const deny = await wired({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }, { accept: false });
    await deny.call(ADOPT_RUN_CHANNEL, "project:claude-code:memory");
    expect(deny.spawns).toEqual([]);
  }, 30_000);

  it("한국어 모드: Adopt·Benchmark 대화상자 승인 문장과 Preview는 Core 문장 그대로다(기존 동작 유지)", async () => {
    setDesktopLocale("ko");
    const c = await wired({ "my-memory": { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } });
    await c.call(ADOPT_RUN_CHANNEL, "project:claude-code:my-memory");
    const d = c.dialogs[0]!;
    expect(d.title).toBe("OpenHub Adopt 승인");
    expect(d.detail).toContain("• [base] " + ADOPT_APPROVAL_MESSAGES.base);
    expect(d.detail).toContain("• [identity-strong-match] " + ADOPT_APPROVAL_MESSAGES["identity-strong-match"]);
    expect(d.detail).toContain("Adopt 계획: memory-mcp (ready)");
    await c.call(BENCHMARK_RUN_CHANNEL, "project:claude-code:my-memory");
    const b = c.dialogs[1]!;
    expect(b.title).toBe("OpenHub Benchmark 승인");
    expect(b.detail).toContain("• [base] " + BENCHMARK_APPROVAL_MESSAGES.base);
    expect(b.detail).toContain("Benchmark 계획: memory-mcp (ready)");
  }, 30_000);
});

