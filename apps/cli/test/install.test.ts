import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { containsAbsolutePath, type BackendProbeReport, type ExecChild, type ExecSpawner } from "@openhub/core";
import { runCli } from "../src/cli";
import type { InstallPrompter } from "../src/install";
import { memoryIO } from "./helpers";

const REPO = path.resolve(import.meta.dirname, "../../..");
const GOLDENS = path.join(import.meta.dirname, "fixtures/install");
const UPDATE = process.env["OPENHUB_UPDATE_GOLDEN"] === "1";
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-cli-install-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "shim-not-executed" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
};

interface Run {
  code: number;
  stdout: string[];
  stderr: string[];
  questions: string[];
  spawns: string[][];
  probes: number;
  project: string;
  home: string;
}

async function setup(packageJson = '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n') {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  await mkdir(project);
  await mkdir(home);
  await writeFile(path.join(project, "package.json"), packageJson);
  return { base, project, home };
}

async function install(args: string[], options: { answers?: string[]; tty?: boolean; probes?: BackendProbeReport; platform?: string; dirs?: Awaited<ReturnType<typeof setup>>; exitCode?: number } = {}): Promise<Run> {
  const dirs = options.dirs ?? (await setup());
  const questions: string[] = [];
  const answers = [...(options.answers ?? [])];
  const prompter: InstallPrompter = { isTTY: options.tty ?? true, ask: async (q) => (questions.push(q), answers.shift() ?? "") };
  const spawns: string[][] = [];
  const spawner: ExecSpawner = (executable, a) => {
    spawns.push([executable, ...a]);
    const events = new EventEmitter();
    queueMicrotask(() => events.emit("close", options.exitCode ?? 0, null));
    return { stdout: null, stderr: null, on: (e: string, l: (...x: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
  };
  let probes = 0;
  const io = Object.assign(memoryIO(REPO), {
    prompter,
    spawner,
    probe: async () => (probes++, options.probes ?? PROBES),
    homeDir: dirs.home,
    hostEnvironment: { homeDir: dirs.home, pathEnv: "", pathExt: "" },
    platform: options.platform ?? "linux",
    isolatedDir: async () => {
      const dir = await mkdtemp(path.join(dirs.base, "iso-"));
      return { path: dir, base: dirs.base, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
  });
  const code = await runCli(["install", ...args, "--project", dirs.project], io);
  return { code, stdout: io.stdout, stderr: io.stderr, questions, spawns, probes, project: dirs.project, home: dirs.home };
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
const previewOf = (r: Run) => r.stdout.slice(0, r.stdout.findIndex((l) => l.startsWith("Plan digest")) + 1).join("\n") + "\n";
const files = async (dir: string) => (await readdir(dir, { recursive: true })).map((f) => f.replace(/\\/gu, "/")).sort();

describe("REQ-034 CLI openhub install", () => {
  it("AC-035-01 Preview(backend·argv·변경 파일·env·warnings·충돌·scope·설치 상태·검사 범위)가 golden과 같다", async () => {
    const linux = await install(["postgres-mcp", "--client", "claude-code", "--client", "codex"], { answers: ["n"] });
    expect(linux.code).toBe(1);
    const text = previewOf(linux);
    for (const part of ["Backend      uvx", "Client 실행 명령  uvx postgres-mcp --access-mode=restricted", ".mcp.json (Claude Code, 프로젝트 범위)", ".codex/config.toml (Codex, 프로젝트 범위)", "DATABASE_URI", "충돌         없음", "Warnings", "설치 상태    프로젝트 범위 기준 미설치", "검사 범위    프로젝트", "Plan digest  sha256:"]) {
      expect(text).toContain(part);
    }
    await golden("preview-postgres-linux.txt", text);
    const windows = await install(["memory-mcp", "--client", "cursor"], { answers: ["n"], platform: "win32" });
    const win = previewOf(windows);
    expect(win).toContain("Client 실행 명령  cmd /d /c npx -y @modelcontextprotocol/server-memory");
    expect(win).toContain("Windows 호환 정책(OpenHub)");
    expect(win).not.toMatch(/공식 권장|officially recommended/u);
    await golden("preview-memory-windows.txt", win);
  });

  it("AC-035-02 toolId를 정확히 입력해야 진행하고 다르면 중단하며 spawn 0회다", async () => {
    const wrong = await install(["github-mcp-server", "--client", "cursor"], { answers: ["y", "github"] });
    expect(wrong.code).toBe(1);
    expect(wrong.stderr.join("\n")).toContain("승인하지 않아 설치를 중단했습니다");
    expect(wrong.spawns).toEqual([]);
    expect(await files(wrong.project)).toEqual(["package.json"]);

    const ok = await install(["github-mcp-server", "--client", "cursor"], { answers: ["y", "github-mcp-server"] });
    expect(ok.code).toBe(0);
    expect(ok.questions.at(-1)).toContain("Tool ID(github-mcp-server)를 정확히 입력하세요");
    expect(ok.spawns).toEqual([["docker", "pull", "ghcr.io/github/github-mcp-server"]]);
    const out = ok.stdout.join("\n");
    expect(out).toContain("결과  succeeded");
    expect(out).toContain("Prepared    pulled");
    expect(out).toContain("Configured  예");
    expect(out).toContain("Detected    예");
    expect(out).not.toMatch(/Installed|설치 완료/u);
    expect(JSON.parse(await readFile(path.join(ok.project, ".cursor", "mcp.json"), "utf8")).mcpServers.github.command).toBe("docker");
  });

  it("AC-035-03 추가 승인 항목마다 따로 y/N을 묻고 하나라도 거절하면 중단한다", async () => {
    const r = await install(["postgres-mcp", "--client", "claude-code"], { answers: ["y", "n"] });
    expect(r.code).toBe(1);
    expect(r.questions).toHaveLength(2);
    expect(r.questions.every((q) => q.includes("(y/N)"))).toBe(true);
    const asked = r.stdout.filter((l) => /^\[[a-z-]+\] /u.test(l)).map((l) => l.slice(1, l.indexOf("]")));
    expect(asked).toEqual(["floating-artifact", "client-env-parse-risk"]);
    expect(await files(r.project)).toEqual(["package.json"]);
    expect(r.spawns).toEqual([]);
  });

  it("AC-035-04 TTY가 아니고 --json도 없으면 exit 3 APPROVAL_REQUIRED이고 probe·spawn 0회다", async () => {
    const r = await install(["memory-mcp", "--client", "claude-code"], { tty: false });
    expect(r.code).toBe(3);
    expect(r.stderr.join("\n")).toContain("APPROVAL_REQUIRED");
    expect(r.probes).toBe(0);
    expect(r.spawns).toEqual([]);
    expect(r.questions).toEqual([]);
  });

  it("AC-035-05 --json은 Plan과 digest만 출력하고 TTY여도 실행하지 않는다", async () => {
    for (const tty of [true, false]) {
      const r = await install(["memory-mcp", "--client", "claude-code", "--json"], { tty, answers: ["y", "memory-mcp"] });
      expect(r.code).toBe(0);
      const doc = JSON.parse(r.stdout.join("\n"));
      expect(Object.keys(doc).sort()).toEqual(["plan", "planDigest"]);
      expect(doc.planDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
      expect(doc.plan.toolId).toBe("memory-mcp");
      expect(r.questions).toEqual([]);
      expect(r.spawns).toEqual([]);
      expect(await files(r.project)).toEqual(["package.json"]);
    }
  });

  it("AC-035-06 --yes, -y, --approve는 exit 2다", async () => {
    for (const flag of [["--yes"], ["-y"], ["--approve"], ["--approve", "sha256:" + "0".repeat(64)], ["--approve=sha256:" + "0".repeat(64)], ["--yes=true"]]) {
      const r = await install(["memory-mcp", "--client", "claude-code", ...flag]);
      expect(r.code, flag.join(" ")).toBe(2);
      expect(r.probes).toBe(0);
      expect(r.questions).toEqual([]);
    }
    const help = memoryIO(REPO);
    await runCli(["--help"], help);
    expect(help.stdout.join("\n")).toContain("install <toolId>");
    expect(help.stdout.join("\n")).not.toMatch(/--yes|--approve/u);
  });

  it("AC-035-07 알 수 없는 toolId는 exit 2, 설치할 수 없는 환경은 exit 1이며 고정 문구만 출력한다", async () => {
    const unknown = await install(["no-such-tool-C:\\evil", "--client", "claude-code"]);
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toEqual(["Registry에 없는 Tool입니다. openhub registry list로 Tool ID를 확인하세요."]);
    const none = { node: PROBES.node, npx: { name: "npx", available: false, version: null, status: "not-found" }, uvx: { name: "uvx", available: false, version: null, status: "not-found" }, docker: { name: "docker", available: false, version: null, status: "not-found" } } as const;
    const blocked = await install(["memory-mcp", "--client", "claude-code"], { probes: none });
    expect(blocked.code).toBe(1);
    expect(blocked.stderr).toEqual(["이 환경에서는 설치할 수 없습니다 (blocked). 위 Warnings를 확인하세요."]);
    expect(blocked.questions).toEqual([]);
    expect(blocked.spawns).toEqual([]);
  });

  it("AC-035-08 출력에 env 값·절대 경로가 0건이다", async () => {
    const secret = "postgresql://admin:Sup3r-Secret@db.internal:5432/app";
    vi.stubEnv("DATABASE_URI", secret);
    const r = await install(["postgres-mcp", "--client", "claude-code", "--client", "cursor"], { answers: ["y", "y", "postgres-mcp"] });
    expect(r.code).toBe(0);
    for (const line of [...r.stdout, ...r.stderr]) {
      expect(line).not.toContain("Sup3r-Secret");
      expect(line).not.toContain(r.project);
      expect(line).not.toContain(r.home);
      expect(containsAbsolutePath(line), line).toBe(false);
    }
  });

  it("AC-035-09 --scope user는 host 검사를 켜고 user-scope-config를 요구하며 host 미검사 Plan은 프로젝트 범위 기준 미설치로 표시한다", async () => {
    const user = await install(["context7", "--client", "cursor", "--scope", "user"], { answers: ["y", "y", "context7"] });
    expect(user.code).toBe(0);
    expect(user.stdout.join("\n")).toContain("검사 범위    프로젝트 + 사용자");
    expect(user.stdout.filter((l) => l.startsWith("[user-scope-config]"))).toHaveLength(1);
    // M5(TASK-038, D-017): 설치 성공 시 Version State(~/.openhub/state/lifecycle.json)를 함께 기록한다.
    // config 쓰기 대상은 여전히 ~/.cursor/mcp.json 하나다.
    expect(await files(user.home)).toEqual([".cursor", ".cursor/mcp.json", ".openhub", ".openhub/state", ".openhub/state/lifecycle.json"]);
    expect(await files(user.project)).toEqual(["package.json"]);
    const project = await install(["context7", "--client", "cursor"], { answers: ["n"] });
    expect(project.stdout.join("\n")).toContain("설치 상태    프로젝트 범위 기준 미설치(사용자 범위 미검사)");
    expect(project.stdout.join("\n")).not.toContain("[user-scope-config]");
  });

  it("AC-035-10 floating 고지문과 env 안내문을 표시하고 floating-artifact·client-env-parse-risk를 각각 따로 확인받는다", async () => {
    const r = await install(["postgres-mcp", "--client", "claude-code"], { answers: ["y", "y", "postgres-mcp"] });
    expect(r.code).toBe(0);
    const out = r.stdout.join("\n");
    expect(out).toContain("이 설치 계획은 실행 명령과 설정을 고정하지만, 원격 패키지 내용 자체는 고정하지 않습니다. 동일한 계획을 나중에 실행하면 다른 artifact가 내려올 수 있습니다.");
    expect(out).toContain("이 도구는 실행 시 DATABASE_URI 환경변수가 필요합니다. OpenHub는 값이나 설정 여부를 확인하거나 저장하지 않습니다.");
    expect(r.questions.filter((q) => q.includes("(y/N)"))).toHaveLength(2);
    expect(r.stdout.filter((l) => l.startsWith("[floating-artifact]") || l.startsWith("[client-env-parse-risk]"))).toHaveLength(2);
    expect(out).toContain("status: unchecked");
  });

  it("AC-035-02 이미 설정된 Tool은 승인 없이 no-op이고 아무것도 실행하지 않는다", async () => {
    const dirs = await setup();
    await writeFile(path.join(dirs.project, ".mcp.json"), '{ "mcpServers": { "memory": { "command": "npx", "args": [] } } }\n');
    const r = await install(["memory-mcp", "--client", "claude-code"], { dirs });
    expect(r.code).toBe(0);
    expect(r.stdout.join("\n")).toContain("결과  no-op");
    expect(r.questions).toEqual([]);
    expect(r.spawns).toEqual([]);
  });
});
