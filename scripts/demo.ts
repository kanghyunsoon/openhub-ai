/**
 * pnpm demo(TASK-073, §16). examples/demo-project를 임시 복사본으로 두고 실제 CLI 명령을 같은 프로세스에서 차례로 실행한다.
 * Analyze → Existing tools → Recommend → Install Preview → Adopt(임시 HOME) → Releases → Impact → Update Preview → Discover → Benchmark Preview.
 * - network 0: fetch는 고정 fixture 응답만 돌려주는 가짜다. spawn 0: 실행 함수는 호출되면 기록만 하고, 결과에서 0회를 확인한다.
 * - 결정론: 시계·metadata·release 데이터가 고정이고 임시 경로는 출력에 나오지 않는다(test/demo.test.ts golden).
 * - Install·Update·Benchmark는 계획(Preview)을 보여 준 뒤 데모가 승인 질문을 거절해 아무것도 실행하지 않는다.
 *   Adopt만 데모가 임시 HOME에서 승인 질문에 답한다(설정 파일 변경 0, 실행 0).
 */
import { EventEmitter } from "node:events";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { BackendProbeReport, ExecChild, ExecSpawner, HealthSpawner } from "../packages/core/src/index";
import { runCli, type CliIO } from "../apps/cli/src/cli";

const ROOT = path.resolve(import.meta.dirname, "..");
export const DEMO_PROJECT = path.join(ROOT, "examples", "demo-project");
const METADATA = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const NOW = new Date("2026-10-07T09:00:00.000Z");
const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "24.15.0", status: "ok" },
  npx: { name: "npx", available: true, version: "11.4.2", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.8.3", status: "ok" },
  docker: { name: "docker", available: true, version: "28.3.2", status: "ok" },
};
const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
const RELEASES = [
  { tag_name: "2025.9.25", name: "2025.9.25", body: "## What's Changed\n### Bug Fixes\n- Fixed entity dedupe\n### Features\n- Added search_nodes limit", draft: false, prerelease: false, published_at: "2025-09-25T00:00:00Z", html_url: "https://github.com/modelcontextprotocol/servers/releases/tag/2025.9.25" },
  { tag_name: "2025.9.1", name: "2025.9.1", body: "- BREAKING: renamed open_nodes to read_nodes\n- See the migration guide", draft: false, prerelease: false, published_at: "2025-09-01T00:00:00Z", html_url: "https://github.com/modelcontextprotocol/servers/releases/tag/2025.9.1" },
  { tag_name: "2025.8.4", name: "2025.8.4", body: "- old", draft: false, prerelease: false, published_at: "2025-08-04T00:00:00Z", html_url: "https://github.com/modelcontextprotocol/servers/releases/tag/2025.8.4" },
];

export interface DemoResult {
  lines: string[];
  /** 가짜 fetch가 받은 요청(실제 네트워크 0) */
  fetched: string[];
  /** 실행 함수 호출(0이어야 한다) */
  spawned: string[][];
}

export async function runDemo(): Promise<DemoResult> {
  const base = await mkdtemp(path.join(tmpdir(), "openhub-demo-"));
  const fetched: string[] = [];
  const spawned: string[][] = [];
  const lines: string[] = [];
  try {
    const project = path.join(base, "demo-project");
    const home = path.join(base, "home");
    await cp(DEMO_PROJECT, project, { recursive: true });
    await mkdir(home);
    const fetch = async (url: string) => {
      fetched.push(url);
      if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: "2025.9.25", engines: { node: ">=18" } });
      if (url.startsWith("https://api.github.com/repos/modelcontextprotocol/servers/releases")) return json(RELEASES);
      return new Response("not in demo fixture", { status: 404 });
    };
    const spawner: ExecSpawner = (exe, args) => {
      spawned.push([exe, ...args]);
      const events = new EventEmitter();
      queueMicrotask(() => events.emit("close", 1, null));
      return { stdout: null, stderr: null, on: (e: string, l: (...x: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
    };
    const healthSpawner = ((exe: string, args: readonly string[]) => {
      spawned.push([exe, ...args]);
      throw new Error("demo: MCP 서버를 실행하지 않습니다");
    }) as unknown as HealthSpawner;
    // plan digest에는 프로젝트 위치(projectKey = realpath의 sha256)가 들어가므로 실행마다 다르다. 출력에서만 가리고 그 이유를 적는다.
    const clean = (s: string) =>
      s
        .split(base)
        .join("<tmp>")
        .split(project)
        .join("<demo-project>")
        .replace(/^(\s*plan digest:?\s+)sha256:[0-9a-f]{64}$/imu, "$1sha256:<프로젝트 위치에 따라 달라짐>");
    /** tty: null이면 비대화형, approve가 null이면 승인 질문을 거절한다. */
    const step = async (title: string, args: string[], tty: { approve: string | null } | null) => {
      lines.push("", "== " + title, "$ openhub " + args.map((a) => (a === project ? "examples/demo-project" : a)).join(" "));
      const io: CliIO & Record<string, unknown> = {
        out: (l: string) => lines.push(...clean(l).split("\n")),
        err: (l: string) => lines.push(...clean(l).split("\n").map((x) => "! " + x)),
        cwd: base,
        version: "0.1.0",
        registryDir: path.join(ROOT, "registry"),
        registrySource: "./registry",
        metadataFile: METADATA,
        homeDir: home,
        fetch,
        resolveToken: async () => undefined,
        env: {},
        probe: async () => PROBES,
        spawner,
        healthSpawner,
        killTree: async () => true,
        platform: "linux",
        now: () => NOW,
        tempBase: base,
        hostEnvironment: { homeDir: home, pathEnv: "", pathExt: "" },
        prompter:
          tty === null
            ? { isTTY: false, ask: async () => "" }
            : { isTTY: true, ask: async (q: string) => (tty.approve === null ? "n" : q.includes("Tool ID") || q.includes("toolId") ? tty.approve : "y") },
      };
      const code = await runCli(args, io);
      lines.push("(exit " + code + ")");
    };
    await step("1. Analyze — 프로젝트 분석(읽기만)", ["project", "scan", project], null);
    await step("2. Existing tools — 이미 설정된 MCP 서버", ["lifecycle", "status", "--project", project], null);
    await step("3. Recommend — 맞춤 추천(설치하지 않음)", ["project", "recommend", project], null);
    await step("4. Install preview — 계획을 보여 주고 데모는 승인하지 않음(실행 0)", ["install", "playwright-mcp", "--project", project, "--client", "claude-code"], { approve: null });
    await step("5. Adopt — 기존 설정을 관리 대상으로 등록(데모가 임시 HOME에서 승인 질문에 답함, 설정 파일 변경 없음)", ["adopt", "memory-mcp", "--project", project], { approve: "memory-mcp" });
    await step("6. Releases — 고정 release fixture", ["releases", "memory-mcp", "--project", project, "--no-token"], null);
    await step("7. Impact — 업데이트 영향", ["impact", "memory-mcp", "--project", project, "--no-token"], null);
    await step("8. Update preview — 계획을 보여 주고 데모는 승인하지 않음(실행 0)", ["update", "memory-mcp", "--project", project], { approve: null });
    await step("9. Discover — New for your project", ["discover", "--view", "new", "--project", project], null);
    await step("9. Discover — Trending", ["trending"], null);
    await step("10. Benchmark preview — 계획을 보여 주고 데모는 승인하지 않음(실행 0)", ["benchmark", "memory-mcp", "--project", project], { approve: null });
    lines.push("", "== 요약", "가짜 fetch 응답 " + fetched.length + "회(실제 네트워크 0) · 프로세스 실행 " + spawned.length + "회");
    return { lines, fetched, spawned };
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const r = await runDemo();
  process.stdout.write(r.lines.join("\n") + "\n");
  process.exitCode = r.spawned.length === 0 ? 0 : 1;
}
