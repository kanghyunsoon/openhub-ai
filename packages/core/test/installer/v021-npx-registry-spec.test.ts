import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildInstallPlan,
  checkRegistryConsistency,
  npmRegistrySpec,
  npxArtifact,
  parseNpxArgs,
  planBenchmark,
  planInstall,
  planLifecycle,
  projectKeyFor,
  runInstallTransaction,
  recordInstallInState,
  tokenizeManifestCommand,
  withdrawnManifestOf,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, listing, newScratch, plannedOf } from "./harness";
import { legacyMemoryEntry, seedEntries, seedWithNpxFixture } from "../recommendation/helpers";
import { ALL_AVAILABLE, clientProfile, reportFor, target } from "./helpers";
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
  const ACCEPTED = [
    ["-y", "pkg"],
    ["--yes", "pkg@1.2.3"],
    ["@scope/pkg@latest"],
    ["-y", "@scope/pkg@1.2.3-rc.1"],
    ["-y", "pkg@^1.2.0"],
    ["-y", "pkg@1.x"],
    ["-p", "@scope/pkg@1.0.0", "pkg-bin"],
    ["--package", "@scope/pkg", "pkg-bin", "--flag", "value"],
    ["-y", "--", "@scope/pkg"],
    ["-y", "alias@npm:@scope/pkg@1.0.0"],
    ["-y", "npm:@scope/pkg"],
    ["-y", "pkg", "https://example.com/argument-for-the-server"],
  ];
  it("실제 Registry의 npx 명령과 지원하는 형식은 통과한다", () => {
    const npx = seed.filter((e) => e.manifest.install.preferredAdapter === "npx");
    expect(npx.length).toBeGreaterThan(0);
    for (const e of npx) {
      const command = String(e.manifest.install.options?.["command"]).replace("{toolConfig}", "openhub-tool-config-placeholder");
      expect(tokenizeManifestCommand(command, "npx").ok, command).toBe(true);
    }
    for (const args of ACCEPTED) expect(parseNpxArgs(args).ok, args.join(" ")).toBe(true);
    expect(npmRegistrySpec("alias@npm:@scope/pkg@1.0.0")).toEqual({ name: "@scope/pkg", version: "1.0.0" });
  });

  it("#74 리뷰: npxArtifact는 parseNpxArgs와 같은 패키지를 식별한다(-p의 bin 이름을 패키지로 잡지 않는다)", () => {
    for (const args of ACCEPTED) {
      const parsed = parseNpxArgs(args);
      if (!parsed.ok) throw new Error(args.join(" "));
      expect(npxArtifact(args), args.join(" ")).toEqual({ spec: parsed.packages[0], unambiguous: parsed.command === null });
    }
    expect(npxArtifact(["-y", "-p", "@scope/pkg@1.0.0", "pkg-bin"])).toEqual({ spec: "@scope/pkg@1.0.0", unambiguous: false });
    // 지원하지 않는 형식은 식별하지 않는다(이전에는 --package= 다음 bin 이름을 패키지로 돌려줬다).
    for (const args of [["--package=@scope/pkg", "pkg-bin"], ["-p", "a@1.0.0", "-p", "b@1.0.0", "a-bin"], ["--registry", "https://example.com/", "pkg"], ["-y", TARBALL]]) {
      expect(npxArtifact(args), args.join(" ")).toBeNull();
    }
  });

  it("#74 리뷰: 여러 패키지와 --package= 붙여 쓰기는 버전 관리를 일관되게 할 수 없어 지원 범위에서 뺀다", () => {
    for (const args of [
      ["-p", "a@1.0.0", "-p", "b@1.0.0", "a-bin"],
      ["--package", "a", "--package", "b", "a-bin"],
      ["-y", "-p", "@scope/pkg@1.0.0", "--package", "@modelcontextprotocol/server-memory", "pkg-bin"],
      ["--package=@scope/pkg", "pkg-bin"],
      ["-y", "--package=@scope/pkg@1.0.0", "pkg-bin"],
    ]) expect(parseNpxArgs(args), args.join(" ")).toMatchObject({ ok: false });
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

describe("#74 리뷰: -p·--package와 alias의 설치 대상·버전·Prepare·update 일관성", () => {
  const base = async () => (await seedWithNpxFixture()).find((e) => e.manifest.name === "fixture-npx-mcp")!;
  const withCommand = (entry: RegistryEntry, command: string): RegistryEntry => ({ ...entry, manifest: { ...entry.manifest, install: { preferredAdapter: "npx", options: { command }, fallback: [] } } });
  const build = async (command: string) => {
    const entries = (await seedWithNpxFixture()).map((e) => (e.manifest.name === "fixture-npx-mcp" ? withCommand(e, command) : e));
    return buildInstallPlan({ toolId: "fixture-npx-mcp", entries, report: reportFor(clientProfile(), entries), probes: ALL_AVAILABLE, targets: [target("claude-code")], platform: "linux" });
  };

  it("고정 버전 위치 인자: Prepare와 Client 설정이 같은 정확한 버전이다", async () => {
    const built = await build("npx -y @openhub-fixture/npx-mcp@1.2.3");
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.artifact).toMatchObject({ spec: "@openhub-fixture/npx-mcp@1.2.3", pinned: true, preparation: "npm-cache" });
    expect(built.planned.plan.steps[0]).toMatchObject({ args: ["--yes", "--package=@openhub-fixture/npx-mcp@1.2.3", "--", "node", "--version"] });
    expect(built.planned.plan.launch?.args).toEqual(["-y", "@openhub-fixture/npx-mcp@1.2.3"]);
  });

  it("-p <패키지> <bin>: artifact는 패키지(bin 아님)이고 floating이라 Prepare하지 않는다", async () => {
    const built = await build("npx -y -p @openhub-fixture/npx-mcp@1.2.3 npx-mcp");
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.artifact).toMatchObject({ spec: "@openhub-fixture/npx-mcp@1.2.3", pinned: false, preparation: "launch-on-demand" });
    expect(built.planned.plan.steps.map((s) => s.kind)).not.toContain("run");
  });

  it("npm alias: 대상 패키지를 실행하지만 정확한 버전으로 관리하지 않는다(floating, Prepare 없음)", async () => {
    const built = await build("npx -y fixture@npm:@openhub-fixture/npx-mcp@1.2.3");
    if (!built.ok) throw new Error(built.code);
    expect(built.planned.plan.artifact).toMatchObject({ spec: "fixture@npm:@openhub-fixture/npx-mcp@1.2.3", pinned: false, preparation: "launch-on-demand" });
  });

  it("--package= 붙여 쓰기와 여러 패키지는 설치 계획을 만들지 않는다(이전에는 bin 이름이 artifact로 기록됐다)", async () => {
    for (const command of ["npx -y --package=@openhub-fixture/npx-mcp@1.2.3 npx-mcp", "npx -y -p @openhub-fixture/npx-mcp@1.2.3 -p other-pkg@1.0.0 npx-mcp"]) {
      const built = await build(command);
      expect(built.ok, command).toBe(false);
    }
  });

  it("-p로 설치한 Tool의 update는 bin이 아닌 패키지 token만 정확한 버전으로 바꾼다", async () => {
    const entry = withCommand(await base(), "npx -y -p @openhub-fixture/npx-mcp npx-mcp");
    const entries = (await seedWithNpxFixture()).map((e) => (e.manifest.name === "fixture-npx-mcp" ? entry : e));
    const h = await createHarness(scratch, { entries });
    const request = h.request("fixture-npx-mcp", CLAUDE);
    const planned = await plannedOf(h, request);
    const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(result.status).toBe("succeeded");
    expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-14T00:00:00.000Z") })).toMatchObject({ ok: true });
    const fetch = async (url: string) =>
      url === "https://registry.npmjs.org/@openhub-fixture%2fnpx-mcp/latest" ? new Response(JSON.stringify({ name: "@openhub-fixture/npx-mcp", version: "1.2.4" }), { status: 200 }) : new Response("missing", { status: 404 });
    const update = await planLifecycle({ operation: "update", toolId: "fixture-npx-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "linux", includeUser: false, fetch, ...(h.env.configFs === undefined ? {} : { fs: h.env.configFs }) });
    if (!update.ok) throw new Error(update.code + " " + update.message);
    expect(update.planned.plan.target.clientSpec).toEqual({ command: "npx", args: ["-y", "-p", "@openhub-fixture/npx-mcp@1.2.4", "npx-mcp"] });
    expect(update.planned.plan.steps.map((s) => s.kind)).not.toContain("run");
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
