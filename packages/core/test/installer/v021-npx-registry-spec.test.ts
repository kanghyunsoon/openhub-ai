import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  checkRegistryConsistency,
  npmRegistrySpec,
  parseNpxArgs,
  planBenchmark,
  planInstall,
  planLifecycle,
  projectKeyFor,
  tokenizeManifestCommand,
  withdrawnManifestOf,
  type RegistryEntry,
} from "../../src/index";
import { createHarness, listing, newScratch } from "./harness";
import { legacyMemoryEntry, seedEntries } from "../recommendation/helpers";
import { stateOf, toolState } from "../lifecycle/helpers";
import { rm } from "node:fs/promises";

/**
 * v0.2.1 #69 리뷰 P0: npx 패키지 지정은 npm Registry 이름·alias만 허용한다(Agent B 재현: tarball URL로 지원 중단 Memory MCP 설치·Health 성공).
 * 우회 명령은 계획 단계에서 거부되고 실행·다운로드·파일 쓰기가 0이며, Registry 검증·health/repair 재검증·Benchmark가 같은 규칙을 쓴다.
 */
const scratch = await newScratch("v021-npx-registry-spec");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const seed = await seedEntries();
const memory = await legacyMemoryEntry();
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];
const TARBALL = "https://registry.npmjs.org/@modelcontextprotocol/server-memory/-/server-memory-2026.8.31.tgz";

const renamed = (name: string, install: RegistryEntry["manifest"]["install"]): RegistryEntry => ({
  ...memory,
  manifest: {
    ...memory.manifest,
    name,
    repository: { github: "someone/" + name },
    recommendation: { ...memory.manifest.recommendation!, identity: { mcpServerNames: [name.replace(/-mcp$/u, "")] } },
    install,
    update: { source: install.preferredAdapter === "docker" ? "docker-tag" : "npm" },
  },
});
const npxEntry = (name: string, command: string) => renamed(name, { preferredAdapter: "npx", options: { command }, fallback: [] });

describe("npx 인자 해석: npm Registry 이름만", () => {
  it("실제 Registry의 npx 명령과 지원하는 형식은 통과한다", () => {
    const npx = seed.filter((e) => e.manifest.install.preferredAdapter === "npx");
    expect(npx.length).toBeGreaterThan(0);
    for (const e of npx) {
      const command = String(e.manifest.install.options?.["command"]).replace("{toolConfig}", "openhub-tool-config-placeholder");
      expect(tokenizeManifestCommand(command, "npx").ok, command).toBe(true);
    }
    for (const args of [
      ["-y", "pkg"],
      ["--yes", "pkg@1.2.3"],
      ["@scope/pkg@latest"],
      ["-y", "@scope/pkg@1.2.3-rc.1"],
      ["-y", "pkg@^1.2.0"],
      ["-y", "pkg@1.x"],
      ["-p", "@scope/pkg@1.0.0", "pkg-bin"],
      ["--package=@scope/pkg", "pkg-bin", "--flag", "value"],
      ["--package", "@scope/pkg", "pkg-bin"],
      ["-y", "--", "@scope/pkg"],
      ["-y", "alias@npm:@scope/pkg@1.0.0"],
      ["-y", "npm:@scope/pkg"],
      ["-y", "pkg", "https://example.com/argument-for-the-server"],
    ]) expect(parseNpxArgs(args).ok, args.join(" ")).toBe(true);
    expect(npmRegistrySpec("alias@npm:@scope/pkg@1.0.0")).toEqual({ name: "@scope/pkg", version: "1.0.0" });
  });

  it("URL·tarball·Git·file:·경로·출처를 바꾸는 옵션은 거부한다(이름이 문자열에 들어 있어도 추측하지 않는다)", () => {
    for (const args of [
      ["-y", TARBALL],
      ["-y", "http://registry.npmjs.org/pkg/-/pkg-1.0.0.tgz"],
      ["-y", "--package=" + TARBALL, "mcp-server-memory"],
      ["-y", "-p", TARBALL, "mcp-server-memory"],
      ["-y", "git+https://github.com/modelcontextprotocol/servers.git"],
      ["-y", "github:modelcontextprotocol/servers"],
      ["-y", "gitlab:owner/repo"],
      ["-y", "bitbucket:owner/repo"],
      ["-y", "gist:0123abcd"],
      ["-y", "modelcontextprotocol/servers"],
      ["-y", "file:server-memory-2026.8.31.tgz"],
      ["-y", "server-memory-2026.8.31.tgz"],
      ["-y", "./server-memory"],
      ["-y", "pkg@" + TARBALL],
      ["-y", "pkg@github:owner/repo"],
      ["-y", "notes@npm:" + TARBALL],
      ["-y", "notes@npm:npm:@scope/pkg"],
      ["-y", "--registry=https://registry.npmjs.org/", "pkg"],
      ["--registry", "https://registry.npmjs.org/", "pkg"],
      ["-c", "pkg"],
      ["--call", "pkg"],
      ["--prefix", "x", "pkg"],
      ["-y", "Pkg"],
      ["-y"],
      ["-p", "@scope/pkg"],
      ["-p", "@scope/pkg", "@scope/pkg"],
      ["-p"],
    ]) expect(parseNpxArgs(args).ok, args.join(" ")).toBe(false);
    expect(tokenizeManifestCommand("npx -y " + TARBALL, "npx")).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
  });
});

describe("Memory MCP 우회 차단(Agent B 재현 형식 포함): 실행·다운로드·쓰기 0", () => {
  const bypass = [
    "npx -y " + TARBALL,
    "npx -y --package=" + TARBALL + " mcp-server-memory",
    "npx -y -p " + TARBALL + " mcp-server-memory",
    "npx -y git+https://github.com/modelcontextprotocol/servers.git",
    "npx -y github:modelcontextprotocol/servers",
    "npx -y modelcontextprotocol/servers",
    "npx -y file:server-memory-2026.8.31.tgz",
    "npx -y notes@npm:" + TARBALL,
  ];
  it("사용자 Registry의 다른 이름 Manifest: 설치 계획이 만들어지지 않는다", async () => {
    for (const command of bypass) {
      const entry = npxEntry("notes-mcp", command);
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      const before = await listing(h.base);
      const built = await planInstall(h.request("notes-mcp", CLAUDE), h.env);
      expect(built.result.ok, command).toBe(false);
      if (!built.result.ok) expect(["MANIFEST_COMMAND_REJECTED", "TOOL_WITHDRAWN"], command).toContain(built.result.code);
      expect(h.spawns, command).toEqual([]);
      expect(h.writes, command).toEqual([]);
      expect(await listing(h.base), command).toEqual(before);
    }
  });

  it("Registry 검증도 같은 명령을 거부한다", () => {
    for (const command of bypass) {
      const entry = npxEntry("notes-mcp", command);
      const checked = checkRegistryConsistency([entry]);
      expect(checked.entries, command).toEqual([]);
      expect(checked.issues.some((i) => i.path === "install.options"), command).toBe(true);
    }
  });
});

describe("Docker 이미지 동일성(mcp/memory는 같은 Memory 서버)", () => {
  const docker = (image: string) => renamed("notes-mcp", { preferredAdapter: "docker", options: { image }, fallback: [] });
  it("Docker Hub mcp/memory는 태그·digest·docker.io 접두사와 상관없이 지원 중단으로 식별하고 설치 계획을 만들지 않는다", async () => {
    for (const image of ["mcp/memory", "mcp/memory:latest", "docker.io/mcp/memory:latest", "index.docker.io/mcp/memory", "mcp/memory@sha256:" + "a".repeat(64)]) {
      const entry = docker(image);
      expect(withdrawnManifestOf(entry.manifest)?.toolId, image).toBe("memory-mcp");
      const h = await createHarness(scratch, { entries: [...seed, entry] });
      const built = await planInstall(h.request("notes-mcp", CLAUDE), h.env);
      expect(built.result, image).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      expect(h.spawns).toEqual([]);
      expect(h.writes).toEqual([]);
    }
    const fallback = renamed("notes-mcp", { preferredAdapter: "npx", options: { command: "npx -y @someone/notes-mcp" }, fallback: [{ adapter: "docker", image: "mcp/memory" }] });
    expect(withdrawnManifestOf(fallback.manifest)?.toolId).toBe("memory-mcp");
  });

  it("다른 이미지는 막지 않는다(동일성을 확인하지 않은 다른 레지스트리 포함)", () => {
    for (const image of ["mcp/memory-plus", "someone/memory", "mcp/filesystem", "memory", "ghcr.io/mcp/memory"]) {
      expect(withdrawnManifestOf(docker(image).manifest), image).toBeUndefined();
    }
    const npxArg = npxEntry("notes-mcp", "npx -y @someone/notes-mcp mcp/memory");
    expect(withdrawnManifestOf(npxArg.manifest)).toBeUndefined();
  });
});

describe("기록된 실행 인자 재검증: health·repair·Benchmark", () => {
  it("Version State에 Registry 이름이 아닌 npx 인자가 기록돼 있으면 health·repair 계획과 Benchmark가 실행하지 않는다", async () => {
    const entry = npxEntry("url-mcp", "npx -y url-mcp@1.0.0");
    const h = await createHarness(scratch, { entries: [...seed, entry] });
    const args = ["-y", "https://registry.npmjs.org/url-mcp/-/url-mcp-1.0.0.tgz"];
    const state = toolState({
      toolId: "url-mcp",
      target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "url", projectName: "project", projectKey: await projectKeyFor(h.projectRoot) },
      artifact: { requested: "url-mcp@1.0.0", resolved: null },
      launch: { platform: "linux", clientSpec: { command: "npx", args } },
    });
    await mkdir(path.join(h.homeDir, ".openhub", "state"), { recursive: true });
    await writeFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), JSON.stringify(stateOf(state), null, 2) + "\n");
    await writeFile(path.join(h.projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { url: { command: "npx", args } } }, null, 2) + "\n");
    const health = await planLifecycle({ operation: "health", toolId: "url-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: [...seed, entry], platform: "linux", includeUser: false });
    expect(health).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
    // repair는 tool config를 쓰지 않는 도구에서 그 전에 REPAIR_UNSUPPORTED로 끝난다. 어느 쪽이든 계획(실행)은 없다.
    const repair = await planLifecycle({ operation: "repair", toolId: "url-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: [...seed, entry], platform: "linux", includeUser: false });
    expect(repair.ok).toBe(false);
    if (!repair.ok) expect(["MANIFEST_COMMAND_REJECTED", "REPAIR_UNSUPPORTED"]).toContain(repair.code);
    const bench = await planBenchmark({ toolId: "url-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: [...seed, entry], platform: "linux", includeUser: false, mcpSourceEnv: () => ({}) });
    expect(bench.ok).toBe(true);
    if (bench.ok) {
      expect(bench.planned.plan.status).toBe("blocked");
      expect(bench.planned.plan.blockers.some((b) => b.code === "BENCHMARK_UNSUPPORTED" && b.message.includes("기록된 실행 인자"))).toBe(true);
    }
    expect(h.spawns).toEqual([]);
  });
});
