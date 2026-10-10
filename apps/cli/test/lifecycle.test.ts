import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { containsAbsolutePath, nodeConfigFs, readLifecycleState, type BackendProbeReport, type ConfigFs, type ExecChild, type ExecSpawner, type HealthCheckStatus, type LifecycleEnvironment } from "@openhub/core";
import { runCli } from "../src/cli";
import type { LifecycleCommandIO } from "../src/lifecycle";
import { memoryIO } from "./helpers";
import { fakeNpmSpawner, isNpxPrepareCall } from "../../../packages/core/test/process/fake-npm";

/** TASK-045 CLI lifecycle. openhub install로 만든 실제 설정·Version State 위에서 update·rollback·status·health를 실행한다. */
const REPO = path.resolve(import.meta.dirname, "../../..");
const GOLDENS = path.join(import.meta.dirname, "fixtures/lifecycle");
const UPDATE = process.env["OPENHUB_UPDATE_GOLDEN"] === "1";
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-cli-lifecycle-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "shim-not-executed" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};

interface Dirs {
  base: string;
  project: string;
  home: string;
}
interface Session {
  dirs: Dirs;
  out: string[];
  questions: string[];
  spawns: string[][];
  healthRuns: number;
  fetches: string[];
  writes: string[];
  run(args: string[], opts?: RunOptions): Promise<number>;
}
interface RunOptions {
  tty?: boolean;
  answer?: (question: string) => string;
  health?: HealthCheckStatus;
  memoryVersion?: string;
  platform?: string;
}

async function session(): Promise<Session> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const dirs = { base, project: path.join(base, "project"), home: path.join(base, "home") };
  await mkdir(dirs.project);
  await mkdir(dirs.home);
  await writeFile(path.join(dirs.project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  const s: Session = {
    dirs,
    out: [],
    questions: [],
    spawns: [],
    healthRuns: 0,
    fetches: [],
    writes: [],
    async run(args, opts = {}) {
      const io = memoryIO(REPO);
      const op = args.findIndex((a) => ["install", "update", "rollback", "health"].includes(a));
      const toolId = args[op + 1] ?? "";
      const spawner: ExecSpawner = (exe, a) => {
        s.spawns.push([exe, ...a]);
        // npx Prepare(v0.2.0)는 임시 npm cache에 흉내 낸다.
        if (isNpxPrepareCall(a)) return fakeNpmSpawner({ cacheRoot: path.join(base, "npm-cache") }).spawner(exe, a, { shell: false, cwd: base, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
        const events = new EventEmitter();
        queueMicrotask(() => events.emit("close", 0, null));
        return { stdout: null, stderr: null, on: (e: string, l: (...x: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
      };
      const configFs: ConfigFs = {
        ...nodeConfigFs,
        writeFile: async (f, d) => (s.writes.push(path.relative(base, f).replace(/\\/gu, "/")), nodeConfigFs.writeFile(f, d)),
        rename: async (a, b) => (s.writes.push("rename:" + path.relative(base, b).replace(/\\/gu, "/")), nodeConfigFs.rename(a, b)),
      };
      const runHealth: NonNullable<LifecycleEnvironment["runHealth"]> = async (verified) => {
        s.healthRuns += 1;
        const status = opts.health ?? "healthy";
        return { ok: true, result: { status, reason: status === "healthy" ? null : "tools-list-error", toolCount: status === "healthy" ? 4 : null, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null } };
      };
      const fetch = async (url: string) => {
        s.fetches.push(url);
        const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
        if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: opts.memoryVersion ?? "1.2.3" });
        if (url === "https://pypi.org/pypi/postgres-mcp/json") return json({ info: { name: "postgres-mcp", version: "0.3.0" } });
        return new Response("missing", { status: 404 });
      };
      const full: LifecycleCommandIO & typeof io = Object.assign(io, {
        prompter: { isTTY: opts.tty ?? true, ask: async (q: string) => (s.questions.push(q), opts.answer?.(q) ?? (q.includes("Tool ID") ? toolId : "y")) },
        spawner,
        configFs,
        runHealth,
        fetch,
        probe: async () => PROBES,
        homeDir: dirs.home,
        hostEnvironment: { homeDir: dirs.home, pathEnv: "", pathExt: "" },
        platform: opts.platform ?? "linux",
        tempBase: base,
        now: () => new Date("2026-10-07T09:00:00.000Z"),
        isolatedDir: async () => {
          const dir = await mkdtemp(path.join(base, "iso-"));
          return { path: dir, base, cleanup: () => rm(dir, { recursive: true, force: true }) };
        },
      });
      const code = await runCli([...args, "--project", dirs.project], full);
      s.out.push(...io.stdout, ...io.stderr);
      lastStdout = io.stdout;
      lastStderr = io.stderr;
      return code;
    },
  };
  return s;
}
let lastStdout: string[] = [];
let lastStderr: string[] = [];

async function installed(toolId = "memory-mcp", clients = ["claude-code"], platform = "linux") {
  const s = await session();
  expect(await s.run(["install", toolId, ...clients.flatMap((c) => ["--client", c])], { platform })).toBe(0);
  s.spawns.length = 0;
  s.writes.length = 0;
  s.questions.length = 0;
  s.fetches.length = 0;
  return s;
}
async function golden(name: string, actual: string) {
  const file = path.join(GOLDENS, name);
  if (UPDATE) {
    await mkdir(GOLDENS, { recursive: true });
    await writeFile(file, actual);
  }
  if (!existsSync(file)) throw new Error("golden 없음: " + name + " — OPENHUB_UPDATE_GOLDEN=1로 생성하세요");
  expect(actual).toBe(await readFile(file, "utf8"));
}
// M6 TASK-056(AC-056-03): update Preview 앞에 Impact 머리말이 붙는다. M5 golden(계획 본문)은 제목 줄부터 비교해 byte 그대로 유지한다.
const preview = (lines: string[]) => lines.slice(Math.max(0, lines.findIndex((l) => / 업데이트 계획$/u.test(l))), lines.findIndex((l) => l.startsWith("Plan digest")) + 1).join("\n").replace(/sha256:[0-9a-f]{64}/gu, "sha256:<digest>") + "\n";
async function stateEntry(s: Session) {
  const r = await readLifecycleState({ homeDir: s.dirs.home });
  if (!r.ok) throw new Error(r.code);
  return Object.values(r.state.entries)[0]!;
}
async function setLastHealth(s: Session, lastHealth: unknown) {
  const file = path.join(s.dirs.home, ".openhub", "state", "lifecycle.json");
  const doc = JSON.parse(await readFile(file, "utf8"));
  for (const e of Object.values(doc.entries) as Record<string, unknown>[]) e["lastHealth"] = lastHealth;
  await writeFile(file, JSON.stringify(doc, null, 2) + "\n");
}

describe("REQ-040 REQ-043 REQ-044 REQ-050 CLI lifecycle", () => {
  it("AC-045-01 lifecycle status는 drift·lock·Health를 표시하고 fetch·spawn이 0회이며 skip된 Health는 Not verified다", async () => {
    const s = await installed();
    expect(await s.run(["lifecycle", "status"])).toBe(0);
    const text = lastStdout.join("\n");
    expect(text).toContain("memory · Claude Code · 프로젝트 (.mcp.json)");
    expect(text).toContain("상태       일치");
    expect(text).toContain("unlocked(버전 고정 안 됨)");
    expect(text).toContain("Health: Unknown");
    await setLastHealth(s, { status: "skipped", environmentUnverified: true, checkedAt: null });
    expect(await s.run(["lifecycle", "status"])).toBe(0);
    expect(lastStdout).toContain("  Health: Not verified");
    expect(lastStdout).toContain("  Reason: Required environment is unchecked");
    expect(lastStdout.join("\n")).not.toMatch(/Healthy/u);
    const file = path.join(s.dirs.project, ".mcp.json");
    await writeFile(file, (await readFile(file, "utf8")).replace('"-y"', '"--yes"'));
    expect(await s.run(["lifecycle", "status", "--json"])).toBe(0);
    expect(JSON.parse(lastStdout.join("\n")).items[0]).toMatchObject({ state: "config-drift", health: "not-verified" });
    expect([s.fetches, s.spawns, s.writes, s.healthRuns]).toEqual([[], [], [], 0]);
  });

  it("AC-045-02 --check는 resolver만 호출해 update available을 표시하고 spawn·write가 0회다", async () => {
    const s = await installed();
    expect(await s.run(["lifecycle", "status", "--check"])).toBe(0);
    expect(lastStdout).toContain("  업데이트   있음 @modelcontextprotocol/server-memory → @modelcontextprotocol/server-memory@1.2.3 (openhub update memory-mcp)");
    expect(s.fetches).toEqual(["https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest"]);
    expect([s.spawns, s.writes, s.healthRuns]).toEqual([[], [], 0]);
  });

  it("AC-045-03 openhub update Preview가 golden과 같다(linux·windows)", async () => {
    const linux = await installed();
    expect(await linux.run(["update", "memory-mcp"], { answer: () => "n" })).toBe(1);
    await golden("update-preview-linux.txt", preview(lastStdout));
    const windows = await installed("memory-mcp", ["cursor"], "win32");
    expect(await windows.run(["update", "memory-mcp"], { answer: () => "n", platform: "win32" })).toBe(1);
    await golden("update-preview-windows.txt", preview(lastStdout));
    const pg = await installed("postgres-mcp", ["claude-code"]);
    expect(await pg.run(["update", "postgres-mcp", "--skip-health"], { answer: () => "n" })).toBe(1);
    await golden("update-preview-skip-health.txt", preview(lastStdout));
  });

  it("AC-045-04 추가 승인 항목마다 y/N을 묻고 마지막에 toolId를 입력해야 하며 하나라도 거절하면 spawn·write 0회다", async () => {
    const s = await installed();
    expect(await s.run(["update", "memory-mcp"], { answer: (q) => (q.includes("Tool ID") ? "memory" : "y") })).toBe(1);
    expect(await s.run(["update", "memory-mcp"], { answer: () => "n" })).toBe(1);
    expect(s.questions.filter((q) => q.includes("y/N"))).toHaveLength(2);
    expect([s.spawns, s.writes, s.healthRuns]).toEqual([[], [], 0]);
    expect(await s.run(["update", "memory-mcp"])).toBe(0);
    expect(lastStdout).toContain("결과  updated");
    expect(s.questions.slice(-2)).toEqual(["  확인합니까? (y/N) ", "  진행하려면 Tool ID(memory-mcp)를 정확히 입력하세요: "]);
    expect((await stateEntry(s)).revision).toBe(2);
  });

  it("AC-045-05 TTY가 아니면 exit 3 APPROVAL_REQUIRED, --json은 Plan과 digest만 출력하고 실행 0회다", async () => {
    const s = await installed();
    expect(await s.run(["update", "memory-mcp"], { tty: false })).toBe(3);
    expect(lastStderr.join("\n")).toContain("APPROVAL_REQUIRED");
    expect(await s.run(["update", "memory-mcp", "--json"], { tty: false })).toBe(0);
    const doc = JSON.parse(lastStdout.join("\n"));
    expect(doc.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(doc.plan).toMatchObject({ operation: "update", status: "ready" });
    expect([s.spawns, s.writes, s.healthRuns, s.questions]).toEqual([[], [], 0, []]);
  });

  it("AC-045-06 --yes·-y·--approve는 exit 2다", async () => {
    const s = await installed();
    for (const args of [["update", "memory-mcp", "--yes"], ["update", "memory-mcp", "-y"], ["rollback", "memory-mcp", "--approve=sha256:abc"], ["lifecycle", "health", "memory-mcp", "--approve"], ["lifecycle", "status", "--yes"]]) {
      expect(await s.run(args), args.join(" ")).toBe(2);
    }
    expect([s.spawns, s.writes, s.healthRuns, s.fetches]).toEqual([[], [], 0, []]);
  });

  it("AC-045-07 openhub rollback도 같은 승인 흐름을 거치고 rollback-to-previous를 따로 묻는다", async () => {
    const s = await installed();
    const original = await readFile(path.join(s.dirs.project, ".mcp.json"));
    expect(await s.run(["update", "memory-mcp"])).toBe(0);
    s.questions.length = 0;
    s.writes.length = 0;
    // 추가 승인은 [health-execution] → [rollback-to-previous] 순서로 묻는다. 두 번째(rollback-to-previous)만 거절한다.
    let asked = 0;
    expect(await s.run(["rollback", "memory-mcp"], { answer: (q) => (q.includes("Tool ID") ? "memory-mcp" : ++asked === 2 ? "n" : "y") })).toBe(1);
    expect(lastStdout.filter((l) => l.startsWith("[")).map((l) => l.slice(0, l.indexOf("]") + 1))).toEqual(["[health-execution]", "[rollback-to-previous]"]);
    expect(s.writes).toEqual([]);
    expect(await s.run(["rollback", "memory-mcp"])).toBe(0);
    expect(lastStdout).toContain("결과  rolled-back");
    expect((await readFile(path.join(s.dirs.project, ".mcp.json"))).equals(original)).toBe(true);
    expect((await stateEntry(s)).revision).toBe(3);
  });

  it("AC-045-08 lifecycle health는 승인 전 spawn 0회이고 승인 후 성공하면 lastHealth만 healthy로 갱신한다", async () => {
    const s = await installed();
    const config = await readFile(path.join(s.dirs.project, ".mcp.json"));
    const before = await stateEntry(s);
    expect(await s.run(["lifecycle", "health", "memory-mcp"], { answer: () => "n" })).toBe(1);
    expect([s.healthRuns, s.spawns]).toEqual([0, []]);
    expect(await s.run(["lifecycle", "health", "memory-mcp"])).toBe(0);
    expect(lastStdout).toContain("결과  health-checked");
    expect(s.healthRuns).toBe(1);
    const after = await stateEntry(s);
    expect(after.lastHealth).toEqual({ status: "healthy", environmentUnverified: false, checkedAt: "2026-10-07T09:00:00.000Z" });
    expect({ ...after, lastHealth: null }).toEqual({ ...before, lastHealth: null });
    expect((await readFile(path.join(s.dirs.project, ".mcp.json"))).equals(config)).toBe(true);
  });

  it("AC-045-09 모든 출력에 env 값·절대 경로가 0건이다", async () => {
    const secret = "postgresql://admin:Cli-Lifecycle-Secret@db.internal:5432/app";
    vi.stubEnv("DATABASE_URI", secret);
    const s = await installed("postgres-mcp", ["claude-code", "codex"]);
    s.out.length = 0;
    expect(await s.run(["lifecycle", "status", "--check"])).toBe(0);
    expect(await s.run(["update", "postgres-mcp"])).toBe(0);
    expect(await s.run(["lifecycle", "health", "postgres-mcp"])).toBe(0);
    expect(await s.run(["rollback", "postgres-mcp"], { health: "unhealthy" })).toBe(1);
    expect(await s.run(["update", "postgres-mcp", "--json"], { tty: false })).toBe(0);
    for (const line of s.out) {
      expect(line).not.toContain("Cli-Lifecycle-Secret");
      expect(containsAbsolutePath(line), line).toBe(false);
    }
    expect(s.out.join("\n")).toContain("결과  health-failed");
  });

  it("AC-045-10 state가 STATE_CORRUPT·STATE_VERSION_UNSUPPORTED이면 exit 1과 고정 문구이고 write 0회다", async () => {
    for (const [content, code] of [
      ["{ not json", "STATE_CORRUPT"],
      ['{ "schemaVersion": 2, "kind": "openhub-lifecycle-state", "entries": {} }\n', "STATE_VERSION_UNSUPPORTED"],
    ] as const) {
      const s = await installed();
      const file = path.join(s.dirs.home, ".openhub", "state", "lifecycle.json");
      await writeFile(file, content);
      for (const args of [["lifecycle", "status"], ["update", "memory-mcp"], ["rollback", "memory-mcp"], ["lifecycle", "health", "memory-mcp"]]) {
        expect(await s.run(args), args.join(" ")).toBe(1);
        expect(lastStderr.join("\n")).toBe("Version State(~/.openhub/state/lifecycle.json)를 읽을 수 없습니다 (" + code + "). OpenHub는 이 파일을 자동으로 고치거나 덮어쓰지 않습니다. 파일과 백업(lifecycle.json.bak)을 확인하세요.");
      }
      expect(await readFile(file, "utf8")).toBe(content);
      expect([s.writes, s.spawns, s.healthRuns]).toEqual([[], [], 0]);
    }
  });
});

