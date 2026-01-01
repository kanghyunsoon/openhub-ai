import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  artifactKeyFromLaunch,
  dockerKey,
  fingerprintServers,
  gradeServer,
  buildFingerprintIndex,
  identityHintsFrom,
  lifecycleStatus,
  npmKey,
  pypiKey,
  readConfiguredServers,
  recommend,
  recommendationReportSchema,
  resolveInstalledTools,
  serializeRecommendationReport,
  type ConfiguredServer,
  type IdentityHint,
  type RegistryEntry,
} from "../../src/index";
import { expectGolden, item, profile, seedEntries, tool } from "../recommendation/helpers";

/** TASK-051 Identity Fingerprint. 임시 project·home과 seed Registry만 쓴다. network·spawn 없음. */
const seed = await seedEntries();
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-identity-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
let n = 0;
async function roots(files: Record<string, unknown> = {}) {
  n += 1;
  const base = path.join(scratch, "case-" + String(n));
  const projectRoot = path.join(base, "project");
  const homeDir = path.join(base, "home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  for (const [rel, doc] of Object.entries(files)) {
    const [root, ...rest] = rel.split("/");
    const file = path.join(root === "~" ? homeDir : projectRoot, ...(root === "~" ? rest : [root!, ...rest]));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, typeof doc === "string" ? doc : JSON.stringify(doc, null, 2));
  }
  return { projectRoot, homeDir };
}
const server = (serverName: string, command: string, args: string[], scope: "project" | "user" = "project"): ConfiguredServer => ({ client: "claude-code", scope, file: ".mcp.json", serverName, artifact: artifactKeyFromLaunch(command, args) });
const index = buildFingerprintIndex(seed);
const grade = (s: ConfiguredServer, idx = index) => {
  const m = gradeServer(s, idx);
  return [m.grade, m.toolId, m.reason];
};
const MEMORY = "@modelcontextprotocol/server-memory";
const withEntry = (base: string, name: string, install: RegistryEntry["manifest"]["install"]): RegistryEntry => {
  const e = structuredClone(seed.find((x) => x.manifest.name === base)!);
  e.manifest.name = name;
  e.manifest.recommendation = { ...e.manifest.recommendation, identity: { mcpServerNames: [name] } };
  e.manifest.install = install;
  return e;
};

describe("REQ-046 Identity Fingerprint", () => {
  it("AC-051-01 alias가 다른 서버라도 npx package가 같고 후보가 하나면 strong·resolved, alias까지 같으면 exact다", async () => {
    expect(grade(server("my-memory", "npx", ["-y", MEMORY]))).toEqual(["strong", "memory-mcp", "artifact-only"]);
    expect(grade(server("memory", "npx", ["-y", MEMORY]))).toEqual(["exact", "memory-mcp", "alias-and-artifact"]);
    const r = await roots({ ".mcp.json": { mcpServers: { "my-memory": { command: "npx", args: ["-y", MEMORY] }, memory: { command: "npx", args: ["-y", MEMORY] } } } });
    const matches = fingerprintServers(await readConfiguredServers({ ...r, includeUser: false }), seed);
    expect(matches.map((m) => [m.serverName, m.grade, m.toolId])).toEqual([
      ["memory", "exact", "memory-mcp"],
      ["my-memory", "strong", "memory-mcp"],
    ]);
    const hints = identityHintsFrom(matches);
    const p = profile({ aiTools: [tool("my-memory")] });
    expect(resolveInstalledTools(p, seed).map((t) => [t.serverName, t.resolution, t.toolId])).toEqual([["my-memory", "unresolved", null]]);
    expect(resolveInstalledTools(p, seed, hints).map((t) => [t.serverName, t.resolution, t.toolId])).toEqual([["my-memory", "resolved", "memory-mcp"]]);
  });

  it("AC-051-02 scoped npm이 버전·tag를 떼고 정확히 매칭된다", () => {
    for (const spec of ["@upstash/context7-mcp@1.0.17", "@upstash/context7-mcp@latest", "@upstash/context7-mcp", "@upstash/context7-mcp@^1.0.0"]) {
      expect(npmKey(spec), spec).toBe("npm:@upstash/context7-mcp");
      expect(grade(server("ctx", "npx", ["-y", spec])), spec).toEqual(["strong", "context7", "artifact-only"]);
    }
    expect(npmKey("chrome-devtools-mcp@latest")).toBe("npm:chrome-devtools-mcp");
    // 정확히 같은 이름만 인정한다(접두·접미 유사는 artifact 일치가 아니다).
    for (const spec of ["@upstash/context7-mcp-extra", "@upstash/context7", "@Upstash/context7-mcp", "context7-mcp"]) expect(gradeServer(server("x", "npx", [spec]), index).grade, spec).not.toMatch(/exact|strong/u);
  });

  it("AC-051-03 uvx --from <pkg>와 첫 token을 근거로 매칭된다", () => {
    expect(grade(server("my-serena", "uvx", ["--from", "serena-agent", "serena", "start-mcp-server"]))).toEqual(["strong", "serena", "artifact-only"]);
    expect(grade(server("pg", "uvx", ["postgres-mcp==0.3.0", "--access-mode=restricted"]))).toEqual(["strong", "postgres-mcp", "artifact-only"]);
    expect(grade(server("pg", "uvx", ["--from", "Postgres_MCP>=0.3", "postgres-mcp"]))).toEqual(["strong", "postgres-mcp", "artifact-only"]);
    expect(pypiKey("serena-agent[extra]==1.0")).toBe("pypi:serena-agent");
    for (const spec of ["git+https://github.com/oraios/serena", "./local/pkg", "https://example.com/x.whl"]) expect(pypiKey(spec), spec).toBeNull();
  });

  it("AC-051-04 docker image repo가 digest·tag를 떼고 매칭된다(Docker Hub library/ 규칙 포함)", () => {
    const D = "sha256:" + "a".repeat(64);
    for (const image of ["ghcr.io/github/github-mcp-server", "ghcr.io/github/github-mcp-server:v1.3.0", "ghcr.io/github/github-mcp-server@" + D, "ghcr.io/github/github-mcp-server:v1@" + D]) {
      expect(grade(server("gh", "docker", ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "--env=OTHER", "-v", "data:/data", image])), image).toEqual(["strong", "github-mcp-server", "artifact-only"]);
    }
    expect(grade(server("pg", "docker", ["run", "-i", "--rm", "crystaldba/postgres-mcp:latest"]))).toEqual(["strong", "postgres-mcp", "artifact-only"]);
    expect(grade(server("pg", "docker", ["run", "-i", "--rm", "docker.io/crystaldba/postgres-mcp"]))).toEqual(["strong", "postgres-mcp", "artifact-only"]);
    expect([dockerKey("hello-mcp"), dockerKey("docker.io/library/hello-mcp:1.0"), dockerKey("index.docker.io/library/hello-mcp@" + D)]).toEqual(Array(3).fill("docker:docker.io/library/hello-mcp"));
    const hub = buildFingerprintIndex([...seed, withEntry("github-mcp-server", "hello-mcp", { preferredAdapter: "docker", options: { image: "hello-mcp" }, fallback: [] })]);
    expect(grade(server("hello", "docker", ["run", "-i", "--rm", "library/hello-mcp:2"]), hub)).toEqual(["strong", "hello-mcp", "artifact-only"]);
    expect(dockerKey("quay.io/org/tool:1")).toBe("docker:quay.io/org/tool");
  });

  it("AC-051-05 Windows cmd /d /c npx -y <pkg> 항목도 같은 package로 매칭된다", () => {
    expect(grade(server("mem", "cmd", ["/d", "/c", "npx", "-y", MEMORY]))).toEqual(["strong", "memory-mcp", "artifact-only"]);
    expect(grade(server("memory", "cmd", ["/c", "npx", "-y", MEMORY + "@2025.9.1"]))).toEqual(["exact", "memory-mcp", "alias-and-artifact"]);
    expect(grade(server("mem", "C:\\Windows\\System32\\cmd.exe", ["/d", "/c", "npx.cmd", "-y", MEMORY]))).toEqual(["strong", "memory-mcp", "artifact-only"]);
    expect(artifactKeyFromLaunch("cmd", ["/d", "npx", "-y", MEMORY])).toBeNull();
    expect(artifactKeyFromLaunch("npx.cmd", ["-y", MEMORY])).toBe("npm:" + MEMORY);
  });

  it("AC-051-06 같은 package·image를 가진 Registry 후보가 둘 이상이면 unresolved(ambiguous)다", () => {
    const twin = withEntry("memory-mcp", "memory-twin", { preferredAdapter: "npx", options: { command: "npx -y " + MEMORY }, fallback: [] });
    const idx = buildFingerprintIndex([...seed, twin]);
    const m = gradeServer(server("mem", "npx", ["-y", MEMORY]), idx);
    expect([m.grade, m.reason, m.toolId, m.candidates]).toEqual(["unresolved", "ambiguous", null, ["memory-mcp", "memory-twin"]]);
    expect(identityHintsFrom([m])).toEqual([]);
    // alias가 가리키는 Tool과 artifact가 다른 Tool이면 확정하지 않는다.
    expect(grade(server("memory", "npx", ["-y", "@upstash/context7-mcp"]))).toEqual(["unresolved", null, "alias-artifact-conflict"]);
  });

  it("AC-051-07 weak 일치는 resolved가 아니며 Version State 편입·untracked-adoptable 판정이 0건이다", async () => {
    const weak = gradeServer(server("servers", "node", ["dist/index.js"]), index);
    expect([weak.grade, weak.reason, weak.toolId, weak.candidates]).toEqual(["weak", "name-only", null, ["memory-mcp"]]);
    const weakByArtifact = gradeServer(server("x", "npx", ["-y", "@someone/memory-mcp"]), index);
    expect([weakByArtifact.grade, weakByArtifact.toolId]).toEqual(["weak", null]);
    expect(identityHintsFrom([weak, weakByArtifact])).toEqual([]);
    const forged = [{ serverName: "servers", scope: "project", toolId: "memory-mcp", grade: "weak", artifact: "npm:x" }] as unknown as IdentityHint[];
    expect(resolveInstalledTools(profile({ aiTools: [tool("servers")] }), seed, forged)[0]).toMatchObject({ resolution: "unresolved", toolId: null });
    const r = await roots({ ".mcp.json": { mcpServers: { servers: { command: "node", args: ["dist/index.js"] }, memory: { command: "node", args: ["memory.js"] } } } });
    const st = await lifecycleStatus({ ...r, entries: seed, platform: "linux", includeUser: false });
    if (!st.ok) throw new Error(st.code);
    expect(st.items.map((i) => [i.serverName, i.state, i.toolId, i.identity])).toEqual([["memory", "untracked-foreign", null, "unresolved"]]);
    expect(st.items.filter((i) => i.state === "untracked-adoptable")).toEqual([]);
    await expect(readFile(path.join(r.homeDir, ".openhub", "state", "lifecycle.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("AC-051-08 fingerprint 결과·로그에 env 값·token·args의 다른 값·절대 경로가 0건이다", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((m) => vi.spyOn(console, m).mockImplementation(() => undefined));
    const secret = "ghp_" + "S3cr3tT0k3nValue1234567890abcd";
    const r = await roots({
      ".mcp.json": {
        mcpServers: {
          github: { command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN=" + secret, "-v", "/home/alice/.ssh:/root/.ssh", "ghcr.io/github/github-mcp-server"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: secret } },
          ctx: { command: "npx", args: ["-y", "@upstash/context7-mcp", "--api-key=sk-proj-abcdefghijklmnopqrstuvwxyz", "--config", "C:\\Users\\alice\\ctx.json"], url: "https://alice:pw@example.com/mcp" },
          leak: { command: "npx", args: ["-y", "sk-abcdefghijklmnopqrstuvwxyz0123"] },
          [secret]: { command: "npx", args: ["-y", MEMORY] },
        },
      },
      ".cursor/mcp.json": { mcpServers: { pg: { command: "/usr/local/bin/uvx", args: ["postgres-mcp", "--dsn", "postgresql://u:p@db/x"] } } },
    });
    const out = JSON.stringify(fingerprintServers(await readConfiguredServers({ ...r, includeUser: false }), seed));
    expect(JSON.parse(out).map((m: { serverName: string; artifact: string | null; grade: string }) => [m.serverName, m.artifact, m.grade])).toEqual([
      ["pg", "pypi:postgres-mcp", "strong"],
      ["ctx", "npm:@upstash/context7-mcp", "strong"],
      ["github", "docker:ghcr.io/github/github-mcp-server", "exact"],
      ["leak", null, "unresolved"],
    ]);
    for (const banned of [secret, "sk-proj", "sk-abc", "alice", "/home/", "C:\\\\", "postgresql://", "pw@", "--api-key", "--dsn", "GITHUB_PERSONAL_ACCESS_TOKEN", "/usr/local"]) expect(out, banned).not.toContain(banned);
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });

  it("AC-051-09 ~/.claude.json에서는 서버 이름 외 필드를 결과에 담지 않는다(D-003)", async () => {
    const r = await roots({
      "~/.claude.json": { oauthAccount: { emailAddress: "alice@example.com" }, projects: { "/home/alice/work": { mcpServers: { inner: {} } } }, mcpServers: { github: { command: "docker", args: ["run", "ghcr.io/github/github-mcp-server"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_" + "x".repeat(36) } }, "my-mem": { command: "npx", args: ["-y", MEMORY] } } },
      "~/.cursor/mcp.json": { mcpServers: { cmem: { command: "npx", args: ["-y", MEMORY] } } },
    });
    expect(await readConfiguredServers({ ...r, includeUser: false })).toEqual([]);
    const servers = await readConfiguredServers({ ...r, includeUser: true });
    expect(servers).toEqual([
      { client: "cursor", scope: "user", file: "~/.cursor/mcp.json", serverName: "cmem", artifact: "npm:" + MEMORY },
      { client: "claude-code", scope: "user", file: "~/.claude.json", serverName: "github", artifact: null },
      { client: "claude-code", scope: "user", file: "~/.claude.json", serverName: "my-mem", artifact: null },
    ]);
    const out = JSON.stringify(fingerprintServers(servers, seed));
    for (const banned of ["alice", "ghp_", "inner", "docker", "oauth", "/home"]) expect(out, banned).not.toContain(banned);
    expect(fingerprintServers(servers, seed).find((m) => m.serverName === "github")).toMatchObject({ grade: "unresolved", reason: "alias-only" });
  });

  it("AC-051-10 RecommendationReport v1 schema가 그대로이고 strong 일치가 resolved로 나오는 시나리오 골든이 고정된다", async () => {
    const r = await roots({ ".mcp.json": { mcpServers: { "team-memory": { command: "npx", args: ["-y", MEMORY + "@2025.9.1"] }, ctx: { command: "node", args: ["ctx.js"] } } } });
    const hints = identityHintsFrom(fingerprintServers(await readConfiguredServers({ ...r, includeUser: false }), seed));
    expect(hints).toEqual([{ serverName: "team-memory", scope: "project", toolId: "memory-mcp", grade: "strong", artifact: "npm:" + MEMORY }]);
    const p = profile({ name: "identity-strong", aiClients: [item("claude-code", "Claude Code", "config", { file: ".mcp.json" })], aiTools: [tool("team-memory"), tool("ctx")] });
    const report = recommend(p, seed, undefined, { platform: "linux" }, { identityHints: hints });
    expect(report.installedTools.map((t) => [t.serverName, t.resolution, t.toolId])).toEqual([
      ["ctx", "unresolved", null],
      ["team-memory", "resolved", "memory-mcp"],
    ]);
    expect(report.assessment.warnings).toContainEqual({ code: "identity-strong-match", message: "team-memory(project) 서버를 alias 대신 실행 artifact(npm:" + MEMORY + ")로 memory-mcp로 식별했습니다(후보 1개)" });
    expect(report.recommendations.map((x) => x.toolId)).not.toContain("memory-mcp");
    expect(Object.keys(recommendationReportSchema.shape)).toEqual(["schemaVersion", "generatedFrom", "project", "assessment", "installedTools", "needs", "recommendations"]);
    expect(recommendationReportSchema.safeParse(report).success).toBe(true);
    // hint가 없으면 M3와 byte가 같다.
    expect(serializeRecommendationReport(recommend(p, seed, undefined, { platform: "linux" }, {}))).toBe(serializeRecommendationReport(recommend(p, seed, undefined, { platform: "linux" })));
    await expectGolden("identity-strong.report.json", serializeRecommendationReport(report));
  });
});

