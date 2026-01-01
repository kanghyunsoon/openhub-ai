import { readFile, rm } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  analyzeUpdateImpact,
  installPlanSchema,
  lifecyclePlanSchema,
  lifecycleStateFileSchema,
  planLifecycle,
  readLifecycleState,
  recordInstallInState,
  releaseSnapshotSchema,
  runInstallTransaction,
  serializeInstallPlan,
  serializeLifecyclePlan,
  serializeUpdateImpact,
  updateImpactSchema,
  type Manifest,
  type ReleaseEntry,
  type ReleaseSnapshotV1,
  type ToolStateCore,
  type UpdateImpactInput,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";

/** TASK-050 UpdateImpact v1. 네트워크·env 값·LLM 없이 고정 입력만 쓴다. */
const seed = await seedEntries();
const scratch = await newScratch("impact-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const SRC = path.resolve(import.meta.dirname, "../../src");
const SHA = (c: string) => "sha256:" + c.repeat(64);
const manifestOf = (name: string): Manifest => structuredClone(seed.find((e) => e.manifest.name === name)!.manifest);
const MEMORY = "@modelcontextprotocol/server-memory";

function npmState(version: string | null, over: Partial<ToolStateCore> = {}): ToolStateCore {
  return {
    toolId: "memory-mcp",
    backend: "npx",
    revision: 2,
    target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "memory", projectName: "demo", projectKey: "0123456789abcdef" },
    artifact: { requested: MEMORY, resolved: version === null ? null : { kind: "npm-package", spec: MEMORY + "@" + version, version, digest: null, integrity: null, source: "npm-registry" } },
    launch: { platform: "linux", clientSpec: { command: "npx", args: ["-y", MEMORY + (version === null ? "" : "@" + version)] } },
    config: { entryDigest: SHA("e"), tomlBlockDigest: null },
    appliedPlanDigest: SHA("a"),
    committedAt: "2026-10-01T00:00:00.000Z",
    ...over,
  };
}
const entry = (version: string, over: Partial<ReleaseEntry> = {}, notes: string | null = null): ReleaseEntry => ({
  version,
  tag: "v" + version,
  publishedAt: null,
  prerelease: /-|rc|a\d|b\d/u.test(version),
  yanked: false,
  deprecated: null,
  title: null,
  notes: notes === null ? null : { text: notes, truncated: false, originalBytes: Buffer.byteLength(notes) },
  url: null,
  digest: null,
  runtime: { node: null, python: null },
  ...over,
});
function snap(current: string | null, between: ReleaseEntry[], over: Partial<ReleaseSnapshotV1> = {}): ReleaseSnapshotV1 {
  return releaseSnapshotSchema.parse({
    schemaVersion: 1,
    toolId: "memory-mcp",
    versionSource: "npm",
    notesSource: "github-release",
    current: { spec: MEMORY + (current === null ? "" : "@" + current), version: current, digest: null },
    target: between[0] ?? null,
    between,
    selection: { includePrerelease: false, comparable: between.length > 0, skippedDrafts: 0, skippedPrereleases: 0, truncated: false },
    collectedAt: "2026-10-07T00:00:00.000Z",
    metadataDigest: SHA("b"),
    ...over,
  });
}
const NODE_OK = { node: "22.11.0" };
const base = (current: string, between: ReleaseEntry[], over: Partial<UpdateImpactInput> = {}): UpdateImpactInput => ({
  state: npmState(current),
  configEnvNames: [],
  manifest: manifestOf("memory-mcp"),
  snapshot: snap(current, between),
  runtimes: NODE_OK,
  ...over,
});
const codes = (input: UpdateImpactInput) => {
  const r = analyzeUpdateImpact(input);
  return { verdict: r.verdict, status: r.status, codes: r.reasons.map((x) => x.code) };
};

describe("REQ-042 Update Impact Analyzer", () => {
  it("AC-050-01 SemVer major 상승은 high, 0.x에서 minor 상승도 high다", () => {
    expect(codes(base("2.0.0", [entry("3.0.0")]))).toEqual({ verdict: "high", status: "WARNING", codes: ["version-major"] });
    expect(codes(base("0.3.1", [entry("0.4.0")]))).toEqual({ verdict: "high", status: "WARNING", codes: ["version-minor-zero"] });
    const pg = manifestOf("postgres-mcp");
    const uvx = npmState("0.3.1", { toolId: "postgres-mcp", backend: "uvx", artifact: { requested: "postgres-mcp", resolved: { kind: "python-package", spec: "postgres-mcp==0.3.1", version: "0.3.1", digest: null, integrity: null, source: "pypi" } }, launch: { platform: "linux", clientSpec: { command: "uvx", args: ["postgres-mcp==0.3.1"] } } });
    const pySnap = snap("0.3.1", [entry("0.4.0")], { toolId: "postgres-mcp", versionSource: "pypi", current: { spec: "postgres-mcp==0.3.1", version: "0.3.1", digest: null } });
    const env = pg.env.filter((e) => e.required).map((e) => e.name);
    expect(codes({ state: uvx, configEnvNames: env, manifest: pg, snapshot: pySnap, runtimes: { python: "3.13.1" } }).codes).toEqual(["version-minor-zero"]);
  });

  it("AC-050-02 minor 상승만 있으면 low다", () => {
    const r = analyzeUpdateImpact(base("2.0.0", [entry("2.1.0")]));
    expect([r.verdict, r.status, r.reasons]).toEqual(["low", "OK", [{ code: "version-minor", level: "low" }]]);
    expect(r.evidence).toEqual([{ kind: "version", source: "npm", ref: "2.0.0 -> 2.1.0" }]);
    expect(r.affectedFiles).toEqual([".mcp.json"]);
  });

  it("AC-050-03 patch 상승만 있으면 low다", () => {
    expect(codes(base("2.0.0", [entry("2.0.1")]))).toEqual({ verdict: "low", status: "OK", codes: ["version-patch"] });
    expect(codes(base("2.0.1", [entry("2.0.1")]))).toEqual({ verdict: "none", status: "OK", codes: [] });
    // prerelease로 전환하면 medium이다.
    expect(codes({ ...base("2.0.0", [entry("2.0.1-rc.1")]), snapshot: snap("2.0.0", [entry("2.0.1-rc.1")], { selection: { includePrerelease: true, comparable: true, skippedDrafts: 0, skippedPrereleases: 0, truncated: false } }) })).toEqual({ verdict: "medium", status: "WARNING", codes: ["version-prerelease", "version-patch"] });
  });

  it("AC-050-04 notes의 BREAKING·removed 키워드는 high이고 근거 줄이 evidence에 있다", () => {
    const notes = "## Changes\n- Added search\n- BREAKING: renamed create_entities\n";
    const r = analyzeUpdateImpact(base("2.0.0", [entry("2.1.0", {}, notes), entry("2.0.5", {}, "- fixed x\n- Removed the --legacy flag")]));
    expect(r.verdict).toBe("high");
    expect(r.reasons.map((x) => x.code)).toEqual(["notes-breaking", "version-minor"]);
    expect(r.evidence.filter((e) => e.kind === "release-note")).toEqual([
      { kind: "release-note", source: "2.0.5", ref: "line 2" },
      { kind: "release-note", source: "2.1.0", ref: "line 3" },
    ]);
  });

  it("AC-050-05 migration·config format 키워드는 medium이다", () => {
    expect(codes(base("2.0.0", [entry("2.1.0", {}, "- See the migration guide")]))).toEqual({ verdict: "medium", status: "WARNING", codes: ["notes-migration", "version-minor"] });
    expect(codes(base("2.0.0", [entry("2.1.0", {}, "- The config format changed to TOML")])).codes).toEqual(["notes-migration", "version-minor"]);
    expect(codes(base("2.0.0", [entry("2.1.0", {}, "- Supports MCP protocol version 2025-06-18")])).codes).toEqual(["notes-mcp-protocol", "version-minor"]);
    const deprecated = analyzeUpdateImpact(base("2.0.0", [entry("2.1.0", { deprecated: "use @mcp/memory" })]));
    expect([deprecated.verdict, deprecated.reasons.map((x) => x.code)]).toEqual(["medium", ["target-deprecated", "version-minor"]]);
  });

  it("AC-050-06 목표 Manifest required env가 현재 config env 이름에 없으면 high다(env 값은 읽지 않는다)", () => {
    const manifest = manifestOf("memory-mcp");
    manifest.env = [{ name: "MEMORY_FILE_PATH", required: true }, { name: "MEMORY_DEBUG", required: false }];
    const original = process.env;
    const touched: PropertyKey[] = [];
    process.env = new Proxy(original, { get: (t, k) => (touched.push(k), Reflect.get(t, k)) });
    try {
      const added = analyzeUpdateImpact(base("2.0.0", [entry("2.1.0")], { manifest, configEnvNames: [] }));
      expect([added.verdict, added.reasons.map((x) => x.code)]).toEqual(["high", ["env-added", "version-minor"]]);
      expect(added.evidence).toContainEqual({ kind: "env", source: "manifest", ref: "MEMORY_FILE_PATH" });
      expect(codes(base("2.0.0", [entry("2.1.0")], { manifest, configEnvNames: ["MEMORY_FILE_PATH"] })).codes).toEqual(["version-minor"]);
      const removed = analyzeUpdateImpact(base("2.0.0", [entry("2.1.0")], { manifest, configEnvNames: ["MEMORY_FILE_PATH", "OLD_TOKEN_NAME"] }));
      expect([removed.verdict, removed.reasons]).toEqual(["low", [{ code: "version-minor", level: "low" }, { code: "env-removed", level: "low" }]]);
    } finally {
      process.env = original;
    }
    expect(touched).toEqual([]);
  });

  it("AC-050-07 backend가 바뀌면 high다", () => {
    const toDocker = { backend: "docker" as const, clientSpec: { command: "docker", args: ["run", "-i", "--rm", "mcp/memory@" + SHA("1")] } };
    expect(codes(base("2.0.0", [entry("2.1.0")], { targetLaunch: toDocker })).codes).toEqual(["backend-changed", "launch-args-changed", "version-minor"]);
    const manifest = manifestOf("memory-mcp");
    manifest.install = { preferredAdapter: "docker", fallback: [] };
    expect(codes(base("2.0.0", [entry("2.1.0")], { manifest }))).toEqual({ verdict: "high", status: "WARNING", codes: ["backend-changed", "version-minor"] });
    // artifact만 바뀐 launch는 변경이 아니고 artifact 외 인자 변경은 medium이다.
    const same = { backend: "npx" as const, clientSpec: { command: "npx", args: ["-y", MEMORY + "@2.1.0"] } };
    expect(codes(base("2.0.0", [entry("2.1.0")], { targetLaunch: same })).codes).toEqual(["version-minor"]);
    const extra = { backend: "npx" as const, clientSpec: { command: "npx", args: ["-y", MEMORY + "@2.1.0", "--port", "3001"] } };
    const r = analyzeUpdateImpact(base("2.0.0", [entry("2.1.0")], { targetLaunch: extra }));
    expect([r.verdict, r.reasons.map((x) => x.code)]).toEqual(["medium", ["launch-args-changed", "version-minor"]]);
    expect(r.evidence).toContainEqual({ kind: "launch", source: "client-spec", ref: "arg 3" });
  });

  it("AC-050-08 목표 최소 runtime이 probe 버전보다 높으면 high, runtime을 확인할 수 없으면 unknown 근거다", () => {
    const t = entry("2.1.0", { runtime: { node: ">=22", python: null } });
    expect(codes(base("2.0.0", [t], { runtimes: { node: "20.11.0" } }))).toEqual({ verdict: "high", status: "WARNING", codes: ["runtime-unsatisfied", "version-minor"] });
    expect(codes(base("2.0.0", [t], { runtimes: {} }))).toEqual({ verdict: "unknown", status: "WARNING", codes: ["runtime-unverified", "version-minor"] });
    expect(codes(base("2.0.0", [t], { runtimes: { node: "22.11.0" } })).codes).toEqual(["version-minor"]);
    expect(codes(base("2.0.0", [entry("2.1.0", { runtime: { node: "^22 || ^24", python: null } })], { runtimes: { node: "22.11.0" } })).codes).toEqual(["runtime-unverified", "version-minor"]);
    // target 문서에 engines가 없으면 Manifest requirements(>=18)를 쓴다.
    expect(codes(base("2.0.0", [entry("2.1.0")], { runtimes: { node: "16.20.0" } })).codes).toEqual(["runtime-unsatisfied", "version-minor"]);
  });

  it("AC-050-09 버전을 비교할 수 없거나 digest만 바뀌면 unknown이다(다른 high 신호가 없을 때)", () => {
    const none = snap("2.0.0", [], { selection: { includePrerelease: false, comparable: false, skippedDrafts: 0, skippedPrereleases: 0, truncated: false } });
    expect(codes(base("2.0.0", [], { snapshot: none }))).toEqual({ verdict: "unknown", status: "WARNING", codes: ["version-incomparable"] });
    const gh = manifestOf("github-mcp-server");
    const dockerState = npmState(null, {
      toolId: "github-mcp-server",
      backend: "docker",
      target: { client: "cursor", scope: "project", file: ".cursor/mcp.json", serverName: "github", projectName: "demo", projectKey: "0123456789abcdef" },
      artifact: { requested: "ghcr.io/github/github-mcp-server", resolved: { kind: "container-image", spec: "ghcr.io/github/github-mcp-server@" + SHA("1"), version: null, digest: SHA("1"), integrity: null, source: "docker-registry" } },
      launch: { platform: "linux", clientSpec: { command: "docker", args: ["run", "-i", "--rm", "ghcr.io/github/github-mcp-server@" + SHA("1")] } },
    });
    const env = gh.env.filter((e) => e.required).map((e) => e.name);
    const dockerSnap = (current: string | null, target: string, digest: string) =>
      snap(current, [entry(target, { digest })], { toolId: "github-mcp-server", versionSource: "docker-tag", current: { spec: "ghcr.io/github/github-mcp-server@" + SHA("1"), version: current, digest: SHA("1") } });
    expect(codes({ state: dockerState, configEnvNames: env, manifest: gh, snapshot: dockerSnap(null, "1.3.0", SHA("2")) })).toEqual({ verdict: "unknown", status: "WARNING", codes: ["digest-only"] });
    expect(codes({ state: dockerState, configEnvNames: env, manifest: gh, snapshot: dockerSnap("1.3.0", "1.3.0", SHA("2")) }).codes).toEqual(["digest-only"]);
    expect(codes({ state: dockerState, configEnvNames: env, manifest: gh, snapshot: dockerSnap("1.3.0", "1.3.0", SHA("1")) }).verdict).toBe("none");
    // 다른 high 신호가 있으면 high다.
    const yanked = snap("2.0.0", [entry("2.0.1", { yanked: true })]);
    expect(codes(base("2.0.0", [], { snapshot: { ...yanked, selection: { ...yanked.selection, comparable: false }, target: yanked.target } })).verdict).toBe("high");
    expect(codes(base("2.0.0", [entry("3.0.0")], { runtimes: {} }))).toEqual({ verdict: "high", status: "WARNING", codes: ["version-major", "runtime-unverified"] });
  });

  it("AC-050-10 입력 순서를 바꿔도 reasons·evidence·판정 byte가 같다", () => {
    const manifest = manifestOf("memory-mcp");
    manifest.env = [{ name: "B_KEY", required: true }, { name: "A_KEY", required: true }];
    const reversed = structuredClone(manifest);
    reversed.env.reverse();
    reversed.targets = [...reversed.targets].reverse();
    const notesA = "- BREAKING: x\n- migration needed\n- removed y";
    const entries = [entry("2.2.0", {}, notesA), entry("2.1.0", {}, "- MCP protocol bump"), entry("2.0.9", {}, "- breaking z")];
    const a = analyzeUpdateImpact(base("2.0.0", entries, { manifest, configEnvNames: ["Z_OLD", "Y_OLD"], runtimes: {} }));
    const b = analyzeUpdateImpact(base("2.0.0", [entries[0]!, entries[2]!, entries[1]!], { manifest: reversed, configEnvNames: ["Y_OLD", "Z_OLD"], runtimes: {} }));
    expect(serializeUpdateImpact(b)).toBe(serializeUpdateImpact(a));
    expect(a.reasons.map((x) => x.code)).toEqual(["notes-breaking", "env-added", "runtime-unverified", "notes-migration", "notes-mcp-protocol", "version-minor", "env-removed"]);
    expect(updateImpactSchema.safeParse({ ...a, extra: 1 }).success).toBe(false);
  });

  it("AC-050-11 Impact를 계산해도 LifecyclePlan v1·InstallPlan v1·LifecycleStateFile v1 byte가 같고 LifecyclePlan에 impact 필드가 없다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }], false);
    const install = await plannedOf(h, request);
    // InstallPlan은 설치 전 상태의 별도 harness에서 Impact 계산 전후로 비교한다.
    const fresh = await createHarness(scratch, { entries: seed });
    const freshRequest = fresh.request("memory-mcp", [{ client: "claude-code", scope: "project" }], false);
    const installBytes = serializeInstallPlan((await plannedOf(fresh, freshRequest)).plan);
    const result = await runInstallTransaction(install, await approveAll(install), request, h.env);
    expect(result.status).toBe("succeeded");
    expect(await recordInstallInState(install, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-07T01:02:03.000Z") })).toMatchObject({ ok: true });
    const stateFile = path.join(h.homeDir, ".openhub", "state", "lifecycle.json");
    const stateBytes = await readFile(stateFile, "utf8");
    const fetch = async (url: string) =>
      url === "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest" ? new Response(JSON.stringify({ name: MEMORY, version: "1.2.3" }), { status: 200 }) : new Response("missing", { status: 404 });
    const options = { operation: "update" as const, toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux" as const, includeUser: false, fetch, ...(h.env.configFs === undefined ? {} : { fs: h.env.configFs }) };
    const before = await planLifecycle(options);
    if (!before.ok) throw new Error(before.code);
    const lifecycleBytes = serializeLifecyclePlan(before.planned.plan);

    const read = await readLifecycleState({ homeDir: h.homeDir });
    if (!read.ok) throw new Error(read.code);
    const state = Object.values(read.state.entries)[0]!;
    const impact = analyzeUpdateImpact({ state, configEnvNames: [], manifest: manifestOf("memory-mcp"), snapshot: snap(null, [entry("1.2.3")]), runtimes: NODE_OK, targetLaunch: { backend: "npx", clientSpec: before.planned.plan.target.clientSpec } });
    expect(impact.affectedFiles).toEqual([".mcp.json"]);

    const after = await planLifecycle(options);
    if (!after.ok) throw new Error(after.code);
    expect(serializeLifecyclePlan(after.planned.plan)).toBe(lifecycleBytes);
    expect(after.planned.planDigest).toBe(before.planned.planDigest);
    expect(serializeInstallPlan((await plannedOf(fresh, freshRequest)).plan)).toBe(installBytes);
    expect(await readFile(stateFile, "utf8")).toBe(stateBytes);
    expect(Object.keys(lifecyclePlanSchema.shape)).not.toContain("impact");
    expect(JSON.stringify(Object.keys(installPlanSchema.shape))).not.toMatch(/impact/u);
    expect(Object.keys(lifecycleStateFileSchema.shape)).not.toContain("impact");
    expect(serializeLifecyclePlan(after.planned.plan)).not.toMatch(/impact/iu);
    // impact 모듈은 Plan builder·LLM 모듈을 import하지 않고, Plan·State 모듈은 impact를 import하지 않는다.
    const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "");
    const impactSrc = readdirSync(path.join(SRC, "impact")).map((f) => stripComments(readFileSync(path.join(SRC, "impact", f), "utf8"))).join("\n");
    expect(impactSrc).not.toMatch(/lifecycle\/plan"|plan-builder|summary-llm|process\.env\[|node:fs|node:child_process/u);
    for (const f of ["lifecycle/plan.ts", "lifecycle/state.ts", "installer/plan.ts", "installer/plan-builder.ts", "lifecycle/transaction.ts"]) expect(readFileSync(path.join(SRC, f), "utf8"), f).not.toContain("impact/");
  });
});

