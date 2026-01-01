import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProject, serializeProfile, type ProjectProfile } from "../src/index";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/projects");
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openhub-ai-env-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function put(files: Record<string, string>) {
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), text);
  }
}
async function profile(dir = root): Promise<ProjectProfile> {
  const r = await analyzeProject(dir);
  if (!r.ok) throw new Error(r.error.code);
  return r.profile;
}
const clientEvidence = (p: ProjectProfile, id: string) =>
  p.aiClients.find((c) => c.id === id)?.evidence.map((e) => `${e.file}|${e.type}|${e.value}`) ?? [];
const tools = (p: ProjectProfile) => p.aiTools.map((t) => `${t.kind}:${t.id}:${t.clients.join("+")}`);

describe("REQ-011 REQ-012 AI Environment Detection (project scope)", () => {
  it("AC-013-01 CLAUDE.md·.claude 설정·.mcp.json으로 Claude Code를 탐지한다", async () => {
    const p = await profile(path.join(FIXTURES, "claude-mcp"));
    expect(clientEvidence(p, "claude-code")).toEqual([
      ".claude/settings.json|config|settings.json",
      ".claude/skills/release-notes/SKILL.md|config|skills",
      ".mcp.json|config|mcpServers",
      "CLAUDE.md|config|CLAUDE.md",
    ]);
    expect(p.aiClients.every((c) => c.scope === "project")).toBe(true);
  });

  it("AC-013-02 .codex/config.toml로 Codex를 탐지하고 AGENTS.md만 있으면 약한 근거(0.6)로만 쓴다", async () => {
    const p = await profile(path.join(FIXTURES, "claude-mcp"));
    expect(clientEvidence(p, "codex")).toEqual([".codex/config.toml|config|config.toml", "AGENTS.md|file-presence|AGENTS.md"]);
    await put({ "AGENTS.md": "# shared agent instructions" });
    const onlyAgents = await profile();
    expect(onlyAgents.aiClients.map((c) => [c.id, c.confidence])).toEqual([["codex", 0.6]]);
  });

  it("AC-013-03 .cursor/mcp.json으로 Cursor를 탐지한다", async () => {
    await put({ ".cursor/mcp.json": JSON.stringify({ mcpServers: { playwright: { command: "npx" } } }) });
    const p = await profile();
    expect(clientEvidence(p, "cursor")).toEqual([".cursor/mcp.json|config|mcpServers"]);
    expect(tools(p)).toEqual(["mcp-server:playwright:cursor"]);
  });

  it("AC-013-04 세 설정의 MCP 서버 이름을 추출하고 같은 이름은 Client 목록을 합친 하나의 항목이 된다", async () => {
    const p = await profile(path.join(FIXTURES, "claude-mcp"));
    const servers = p.aiTools.filter((t) => t.kind === "mcp-server");
    expect(servers.map((s) => [s.id, s.clients])).toEqual([
      ["context7", ["claude-code"]],
      ["github", ["claude-code", "codex"]],
      ["playwright", ["codex", "cursor"]],
      ["postgres", ["claude-code"]],
    ]);
    expect(servers.find((s) => s.id === "github")?.evidence.map((e) => e.file)).toEqual([".codex/config.toml", ".mcp.json"]);
  });

  it("AC-013-05 Claude Code 프로젝트 Skill(디렉터리 이름)과 활성화된 Plugin을 aiTools로 탐지한다", async () => {
    const p = await profile(path.join(FIXTURES, "claude-mcp"));
    expect(tools(p).filter((t) => !t.startsWith("mcp-server"))).toEqual([
      "plugin:code-review-claude-plugins-official:claude-code",
      "skill:release-notes:claude-code",
    ]);
    expect(serializeProfile(p)).not.toContain("disabled-plugin");
  });

  it("AC-013-06 서버 이름·전송 방식·명령 기본 이름만 남고 env·headers·args·URL·토큰은 결과에 없다", async () => {
    const json = serializeProfile(await profile(path.join(FIXTURES, "claude-mcp")));
    expect(json).toContain('"value": "github (stdio, npx)"');
    expect(json).toContain('"value": "context7 (http)"');
    expect(json).toContain('"value": "postgres (stdio, uvx)"');
    for (const leak of ["FAKE_", "Bearer", "mcp.context7.example", "db.internal", "--token", "server-github", "someone", "uvx.exe", "Authorization", "GITHUB_PERSONAL_ACCESS_TOKEN", "DATABASE_URI", "ANTHROPIC_API_KEY", "permissions"]) {
      expect(json, leak).not.toContain(leak);
    }
  });

  it("AC-013-06 테스트 중 만든 비밀값 포함 설정도 결과에 새지 않는다", async () => {
    await put({
      ".mcp.json": JSON.stringify({ mcpServers: { "secret-server": { url: "https://user:RUNTIME_PW@host.example/mcp?token=RUNTIME_TOKEN", headers: { "X-Api-Key": "RUNTIME_KEY" } } } }),
      ".codex/config.toml": '[mcp_servers.local]\ncommand = "/home/alice/bin/my-server --api-key RUNTIME_ARG"\nenv = { API_KEY = "RUNTIME_ENV" }\n',
    });
    const json = serializeProfile(await profile());
    for (const leak of ["RUNTIME_", "host.example", "alice", "X-Api-Key", "API_KEY", "/home"]) expect(json, leak).not.toContain(leak);
    expect(json).toContain('"value": "secret-server (http)"');
    expect(json).toContain('"value": "local (stdio, my-server)"');
  });

  it("AC-013-07 깨진 .mcp.json은 경고만 남기고 다른 Client 탐지는 유지된다", async () => {
    const p = await profile(path.join(FIXTURES, "malformed-config"));
    expect(clientEvidence(p, "claude-code")).toEqual([".mcp.json|file-presence|.mcp.json", "CLAUDE.md|config|CLAUDE.md"]);
    expect(tools(p)).toEqual(["mcp-server:context7:codex"]);
    expect(p.warnings).toContainEqual({ code: "parse-failed", file: ".mcp.json", message: expect.any(String) });
    expect(p.detectors).toContainEqual({ id: "ai-environment", status: "partial" });
    expect(serializeProfile(p)).not.toContain("FAKE_MALFORMED_SECRET");
  });
});

