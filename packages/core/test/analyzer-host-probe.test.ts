import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_HOST_FILE_BYTES, analyzeProject, probeHost, serializeProfile, type HostEnvironment, type HostFs, type ProjectProfile } from "../src/index";

let base: string;
let home: string;
let bin: string;
let project: string;
let accessed: { op: "stat" | "read"; file: string }[];

beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "openhub-host-"));
  home = path.join(base, "home-alice");
  bin = path.join(base, "bin");
  project = path.join(base, "project");
  await mkdir(home);
  await mkdir(bin);
  await mkdir(project);
  accessed = [];
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

async function put(dir: string, rel: string, text: string | Buffer) {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), text);
}

const recordingFs: HostFs = {
  async stat(file) {
    accessed.push({ op: "stat", file });
    return stat(file);
  },
  async readFile(file) {
    accessed.push({ op: "read", file });
    return readFile(file, "utf8");
  },
};

function env(extra: Partial<HostEnvironment> = {}): Partial<HostEnvironment> {
  return { homeDir: home, pathEnv: bin, pathExt: ".EXE;.CMD", platform: process.platform, fs: recordingFs, ...extra };
}

const CLAUDE_JSON = {
  numStartups: 42,
  userID: "FAKE_USER_ID_aaaa",
  oauthAccount: { emailAddress: "FAKE_alice@example.com", accountUuid: "FAKE_ACCOUNT_UUID", organizationName: "FAKE_ORG" },
  primaryApiKey: "FAKE_PRIMARY_API_KEY",
  mcpServers: {
    github: { command: "npx", args: ["-y", "server-github", "--token", "FAKE_ARG_TOKEN"], env: { GITHUB_TOKEN: "FAKE_ENV_TOKEN" } },
    "remote-docs": { type: "http", url: "https://docs.example/mcp?apiKey=FAKE_URL_KEY", headers: { Authorization: "Bearer FAKE_BEARER" } },
  },
  projects: { "C:/Users/alice/secret-project": { mcpServers: { "local-only": { command: "node", args: ["FAKE_LOCAL_ARG"] } }, history: ["FAKE_HISTORY"] } },
};

async function analyze(includeHost: boolean | Partial<HostEnvironment>): Promise<ProjectProfile> {
  const r = await analyzeProject(project, { includeHost });
  if (!r.ok) throw new Error(r.error.code);
  return r.profile;
}

describe("REQ-011 Host Agent Client Probe (user scope, D-003)", () => {
  it("AC-016-01 기본 OFF이며 includeHost일 때만 실행된다", async () => {
    await put(home, ".claude.json", JSON.stringify(CLAUDE_JSON));
    await put(project, "package.json", "{}");
    const off = await analyzeProject(project);
    if (!off.ok) throw new Error();
    expect(off.profile.detectors.map((d) => d.id)).not.toContain("host-probe");
    expect(JSON.stringify(off.profile)).not.toContain('"scope":"user"');
    expect(accessed).toEqual([]);
    const on = await analyze(env());
    expect(on.detectors).toContainEqual({ id: "host-probe", status: "ok" });
    expect(on.aiTools.filter((t) => t.scope === "user").map((t) => t.id)).toEqual(["github", "remote-docs"]);
  });

  it("AC-016-02 허용 목록 세 파일과 PATH 후보만 접근하고 ~/.claude/settings.json 등은 접근하지 않는다", async () => {
    await put(home, ".claude.json", JSON.stringify(CLAUDE_JSON));
    await put(home, ".claude/settings.json", JSON.stringify({ env: { ANTHROPIC_API_KEY: "FAKE_SETTINGS_KEY" } }));
    await put(home, ".codex/config.toml", "[mcp_servers.playwright]\ncommand='npx'\n");
    await put(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: {} }));
    await put(home, ".ssh/id_rsa", "FAKE_SSH_KEY");
    await probeHost(env());
    const allowed = new Set([".claude.json", path.join(".codex", "config.toml"), path.join(".cursor", "mcp.json")].map((r) => path.join(home, r)));
    for (const a of accessed) {
      const inHome = a.file.startsWith(home);
      if (inHome) expect(allowed.has(a.file), a.file).toBe(true);
      else {
        expect(path.dirname(a.file), a.file).toBe(bin);
        expect(path.basename(a.file).toLowerCase(), a.file).toMatch(/^(claude|codex|cursor)(\.exe|\.cmd)?$/u);
        expect(a.op).toBe("stat");
      }
    }
    expect(accessed.filter((a) => a.op === "read").map((a) => a.file).sort()).toEqual([...allowed].sort());
  });

  it("AC-016-03 ~/.claude.json은 최상위 mcpServers 이름만 쓰고 local scope·계정 정보는 쓰지 않으며 8 MiB를 넘으면 읽지 않는다", async () => {
    await put(home, ".claude.json", JSON.stringify(CLAUDE_JSON));
    const r = await probeHost(env());
    const tools = r.findings.filter((f) => f.category === "aiTools");
    expect(tools.map((t) => [t.name, t.clients, t.scope])).toEqual([["github", ["claude-code"], "user"], ["remote-docs", ["claude-code"], "user"]]);
    expect(JSON.stringify(r)).not.toContain("local-only");

    accessed = [];
    await put(home, ".claude.json", Buffer.alloc(MAX_HOST_FILE_BYTES + 1, 0x20));
    const big = await probeHost(env());
    expect(big.warnings).toEqual([{ code: "host-file-too-large", file: "~/.claude.json", message: expect.any(String) }]);
    expect(accessed.some((a) => a.op === "read")).toBe(false);
  });

  it("AC-016-04 ~/.codex/config.toml의 [mcp_servers.<name>]과 ~/.cursor/mcp.json의 mcpServers 키 이름만 추출한다", async () => {
    await put(home, ".codex/config.toml", 'model = "x"\n[mcp_servers.github]\ncommand = "npx"\nenv = { T = "FAKE_CODEX_ENV" }\n[mcp_servers.Context_7]\nurl = "https://x.example/FAKE_PATH"\n');
    await put(home, ".cursor/mcp.json", JSON.stringify({ mcpServers: { playwright: { command: "npx", args: ["FAKE_CURSOR_ARG"] } } }));
    const r = await probeHost(env());
    expect(r.findings.filter((f) => f.category === "aiTools").map((f) => [f.id, f.name, f.clients])).toEqual([
      ["context-7", "Context_7", ["codex"]],
      ["github", "github", ["codex"]],
      ["playwright", "playwright", ["cursor"]],
    ]);
    expect(JSON.stringify(r)).not.toMatch(/FAKE_|x\.example|npx/u);
  });

  it("AC-016-05 PATH에서는 실행 파일 존재만 확인하고 실행하지 않는다", async () => {
    await put(bin, process.platform === "win32" ? "codex.cmd" : "codex", "echo FAKE_SHOULD_NOT_RUN > ran.txt");
    const r = await probeHost(env());
    expect(r.findings).toEqual([{ category: "aiClients", id: "codex", name: "Codex", scope: "user", evidence: [{ file: "PATH", type: "executable", value: "codex" }] }]);
    expect(accessed.filter((a) => a.file.startsWith(bin)).every((a) => a.op === "stat")).toBe(true);
    await expect(stat(path.join(bin, "ran.txt"))).rejects.toThrow();
    const source = await readFile(path.resolve(import.meta.dirname, "../src/analyzer/host-probe.ts"), "utf8");
    expect(source).not.toMatch(/child_process|spawn|execFile|\bexec\(/u);
  });

  it("AC-016-06 결과는 { name, clients, scope: user } 수준이고 비밀값·계정·실제 홈 경로가 없으며 project 항목과 분리된다", async () => {
    await put(home, ".claude.json", JSON.stringify(CLAUDE_JSON));
    await put(project, ".mcp.json", JSON.stringify({ mcpServers: { github: { command: "npx" } } }));
    const p = await analyze(env());
    const github = p.aiTools.filter((t) => t.id === "github").map((t) => [t.scope, t.clients, t.confidence, t.evidence.map((e) => `${e.file}|${e.value}`)]);
    expect(github).toEqual([
      ["project", ["claude-code"], 1, [".mcp.json|github (stdio, npx)"]],
      ["user", ["claude-code"], 1, ["~/.claude.json|github"]],
    ]);
    const json = serializeProfile(p);
    for (const leak of ["FAKE_", "alice@", "Bearer", "docs.example", "secret-project", "userID", "oauthAccount", "primaryApiKey", "local-only", home, "home-alice"]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("AC-016-07 사용자 설정이 없거나 깨져도 내용 없는 경고만 남고 project 결과는 그대로다", async () => {
    await put(project, "package.json", JSON.stringify({ dependencies: { react: "19" } }));
    const off = await analyze(false);
    const missing = await analyze(env());
    expect(missing.warnings).toEqual([]);
    await put(home, ".claude.json", '{ "mcpServers": { "x": { "env": { "K": "FAKE_BROKEN_SECRET" } } }, ');
    await put(home, ".codex/config.toml", "[mcp_servers.ok]\ncommand='npx'\n");
    const broken = await analyze(env());
    expect(broken.warnings).toEqual([{ code: "host-config-unreadable", file: "~/.claude.json", detector: "host-probe", message: expect.any(String) }]);
    expect(broken.detectors).toContainEqual({ id: "host-probe", status: "partial" });
    expect(broken.aiTools.map((t) => `${t.scope}:${t.id}`)).toEqual(["user:ok"]);
    expect(serializeProfile(broken)).not.toContain("FAKE_BROKEN_SECRET");
    for (const key of ["languages", "frameworks", "databases", "packageManagers", "infrastructure"] as const) expect(broken[key]).toEqual(off[key]);
  });
});

