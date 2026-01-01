import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  ADOPT_APPROVAL_REQUIREMENTS,
  APPROVAL_REQUIREMENTS,
  LIFECYCLE_APPROVAL_REQUIREMENTS,
  LIFECYCLE_PLAN_CHANGE_KINDS,
  PLAN_CHANGE_KINDS,
  adoptPlanSchema,
  codexBlock,
  commitLifecycleState,
  formatAdoptPlanPreview,
  planAdopt,
  projectKeyFor,
  requestAdoptApproval,
  serializeAdoptPlan,
  verifyApprovedAdoptPlan,
  verifyApprovedLifecyclePlan,
  verifyApprovedPlan,
  verifyPinokioApproval,
  type AdoptPlanOptions,
  type AdoptPlanResult,
  type PlannedAdopt,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch, stateOf, toolState } from "../lifecycle/helpers";

/** TASK-059 AdoptPlan v1·adopt-plan-v1 승인 종류·Preview. 임시 project·home만 쓰고 network·spawn이 없다. */
const seed = await seedEntries();
const scratch = await newScratch("adopt-plan-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));

const MEMORY = "@modelcontextprotocol/server-memory";
const IMAGE_DIGEST = "sha256:" + "e".repeat(64);
interface Case {
  projectRoot: string;
  homeDir: string;
}
async function newCase(files: Record<string, unknown> = {}, home: Record<string, unknown> = {}): Promise<Case> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const projectRoot = path.join(base, "project");
  const homeDir = path.join(base, "home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  const put = async (root: string, rel: string, content: unknown) => {
    await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
    await writeFile(path.join(root, rel), typeof content === "string" ? content : JSON.stringify(content, null, 2) + "\n");
  };
  for (const [rel, c] of Object.entries(files)) await put(projectRoot, rel, c);
  for (const [rel, c] of Object.entries(home)) await put(homeDir, rel, c);
  return { projectRoot, homeDir };
}
const mcp = (servers: Record<string, unknown>) => ({ mcpServers: servers });
const opts = (c: Case, over: Partial<AdoptPlanOptions> = {}): AdoptPlanOptions => ({
  toolId: "memory-mcp",
  projectRoot: c.projectRoot,
  homeDir: c.homeDir,
  entries: seed,
  platform: "linux",
  client: "claude-code",
  scope: "project",
  ...over,
});
const planned = (r: AdoptPlanResult): PlannedAdopt => {
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
};
const codes = (p: PlannedAdopt) => p.plan.blockers.map((b) => b.code);

describe("REQ-063 AdoptPlan v1과 승인 종류", () => {
  it("AC-059-01 exact 등급이고 표현 가능한 항목이면 ready이고 승인 요구는 base(+조건부)다", async () => {
    const pinned = await newCase({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }) });
    const p = planned(await planAdopt(opts(pinned)));
    expect(p.plan.status).toBe("ready");
    expect(p.plan.identity).toMatchObject({ grade: "exact", reason: "alias-and-artifact", serverName: "memory", canonicalAlias: "memory" });
    expect(p.plan.approvalRequirements).toEqual(["base"]);
    expect(p.plan.effects).toEqual({ stateWrite: 1, configWrite: 0, spawn: 0, network: 0 });
    expect(p.plan.backend).toBe("npx");
    const unpinned = await newCase({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] } }) });
    expect(planned(await planAdopt(opts(unpinned))).plan.approvalRequirements).toEqual(["base", "artifact-unlocked"]);
  });

  it("AC-059-02 strong 등급은 ready이고 identity-strong-match가 필수이며 Preview에 판정 근거가 모두 나온다", async () => {
    const c = await newCase({ ".mcp.json": mcp({ "my-memory": { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }) });
    const p = planned(await planAdopt(opts(c)));
    expect(p.plan.status).toBe("ready");
    expect(p.plan.identity).toMatchObject({ grade: "strong", reason: "artifact-only", artifactKey: "npm:" + MEMORY, serverName: "my-memory", canonicalAlias: "memory" });
    expect(p.plan.target.serverName).toBe("my-memory");
    expect(p.plan.approvalRequirements).toEqual(["base", "identity-strong-match"]);
    const preview = formatAdoptPlanPreview(p).join("\n");
    for (const s of ["strong", "artifact-only", "npm:" + MEMORY, "현재 서버 이름: my-memory", "Registry 이름: memory-mcp", "identity-strong-match"]) expect(preview).toContain(s);
    let asked: string[] = [];
    const outcome = await requestAdoptApproval(p, { channel: "cli-tty", confirm: async (r) => ((asked = r.requirements.map((x) => x.id)), ["base"]) });
    expect(asked).toEqual(["base", "identity-strong-match"]);
    expect(outcome.status).toBe("approved");
  });

  it("AC-059-03 weak·unresolved는 blocked이고 승인 요청은 PLAN_NOT_EXECUTABLE이다", async () => {
    const c = await newCase({ ".mcp.json": mcp({ "memory-mcp": { command: "npx", args: ["-y", "unrelated-pkg"] }, foo: { command: "npx", args: ["-y", "unknown-pkg"] } }) });
    const weak = planned(await planAdopt(opts(c, { serverName: "memory-mcp" })));
    expect(weak.plan).toMatchObject({ status: "blocked", identity: { grade: "weak" } });
    expect(codes(weak)).toContain("ADOPT_IDENTITY_WEAK");
    const unresolved = planned(await planAdopt(opts(c, { serverName: "foo" })));
    expect(unresolved.plan).toMatchObject({ status: "blocked", identity: { grade: "unresolved" } });
    expect(codes(unresolved)).toContain("ADOPT_IDENTITY_UNRESOLVED");
    for (const p of [weak, unresolved]) {
      expect(await requestAdoptApproval(p, { channel: "cli-tty", confirm: async () => ["base"] })).toMatchObject({ status: "not-approvable", code: "PLAN_NOT_EXECUTABLE" });
    }
  });

  it("AC-059-04 Version State에 같은 EntryKey가 있으면 ADOPT_ALREADY_MANAGED다", async () => {
    const c = await newCase({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] } }) });
    const projectKey = await projectKeyFor(c.projectRoot);
    const managed = toolState({ target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "memory", projectName: "project", projectKey } });
    expect(await commitLifecycleState(stateOf(managed), null, { homeDir: c.homeDir })).toMatchObject({ ok: true });
    const p = planned(await planAdopt(opts(c)));
    expect(p.plan.status).toBe("blocked");
    expect(p.plan.precondition.stateEntry).toBe("present");
    expect(codes(p)).toContain("ADOPT_ALREADY_MANAGED");
  });

  it("AC-059-05 표현할 수 없는 항목(명령·인자·~/.claude.json·HTTP)은 ADOPT_ENTRY_UNSUPPORTED다", async () => {
    const c = await newCase(
      {
        ".mcp.json": mcp({
          memory: { command: "bash", args: ["-c", "npx -y " + MEMORY] },
          "mem-meta": { command: "npx", args: ["-y", MEMORY, "a;b"] },
          "mem-http": { type: "http", url: "http://127.0.0.1:42000/api/openhub-memory-mcp" },
          "mem-parent": { command: "npx", args: ["-y", MEMORY, "../x"] },
          "mem-cmd": { command: "cmd", args: ["/d", "/c", "npx", "-y", MEMORY, "%COMSPEC%"] },
        }),
      },
      { ".claude.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] } }) },
    );
    for (const serverName of ["memory", "mem-meta", "mem-http", "mem-parent", "mem-cmd"]) {
      const p = planned(await planAdopt(opts(c, { serverName })));
      expect(p.plan.status, serverName).toBe("blocked");
      expect(codes(p), serverName).toContain("ADOPT_ENTRY_UNSUPPORTED");
    }
    const claude = planned(await planAdopt(opts(c, { scope: "user", serverName: "memory" })));
    expect(claude.plan).toMatchObject({ status: "blocked", target: { file: "~/.claude.json" }, launch: null, precondition: { fileDigest: null, entryDigest: null } });
    expect(codes(claude)).toContain("ADOPT_ENTRY_UNSUPPORTED");
  });

  it("AC-059-06 고정 spec은 locked ArtifactIdentity, 그 밖은 unlocked이며 Preview가 unlocked를 고정으로 표현하지 않는다", async () => {
    const c = await newCase({
      ".mcp.json": mcp({
        memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] },
        github: { command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server@" + IMAGE_DIGEST], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$" + "{GITHUB_PERSONAL_ACCESS_TOKEN}" } },
        postgres: { command: "uvx", args: ["postgres-mcp==0.3.0", "--access-mode=restricted"], env: { DATABASE_URI: "$" + "{DATABASE_URI}" } },
      }),
    });
    const npm = planned(await planAdopt(opts(c)));
    expect(npm.plan.artifact).toEqual({ requested: MEMORY + "@1.2.3", lock: "locked", resolved: { kind: "npm-package", spec: MEMORY + "@1.2.3", version: "1.2.3", digest: null, integrity: null, source: "npm-registry" } });
    const docker = planned(await planAdopt(opts(c, { toolId: "github-mcp-server" })));
    expect(docker.plan.status).toBe("ready");
    expect(docker.plan.artifact).toMatchObject({ lock: "locked", resolved: { kind: "container-image", digest: IMAGE_DIGEST, source: "docker-registry" } });
    const py = planned(await planAdopt(opts(c, { toolId: "postgres-mcp" })));
    expect(py.plan.artifact).toMatchObject({ lock: "locked", resolved: { kind: "python-package", version: "0.3.0" } });

    const floating = await newCase({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@latest"] } }) });
    const f = planned(await planAdopt(opts(floating)));
    expect(f.plan.artifact).toEqual({ requested: MEMORY + "@latest", resolved: null, lock: "unlocked" });
    expect(f.plan.approvalRequirements).toContain("artifact-unlocked");
    const preview = formatAdoptPlanPreview(f).join("\n");
    expect(preview).toContain("artifact-unlocked");
    expect(preview).not.toMatch(/locked\)|pinned|고정된 spec/u);
  });

  it("AC-059-07 user scope는 user-scope-target이 붙고 project는 projectKey만 담으며 절대 경로가 없다", async () => {
    const c = await newCase({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] } }) }, { ".cursor/mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] } }) });
    const user = planned(await planAdopt(opts(c, { client: "cursor", scope: "user" })));
    expect(user.plan.status).toBe("ready");
    expect(user.plan.target).toMatchObject({ file: "~/.cursor/mcp.json", projectKey: null, projectName: null });
    expect(user.plan.approvalRequirements).toContain("user-scope-target");
    const project = planned(await planAdopt(opts(c)));
    expect(project.plan.target.projectKey).toMatch(/^[0-9a-f]{16}$/u);
    expect(project.plan.approvalRequirements).not.toContain("user-scope-target");
    for (const p of [user, project]) {
      const bytes = serializeAdoptPlan(p.plan) + formatAdoptPlanPreview(p).join("\n");
      expect(bytes).not.toContain(c.projectRoot);
      expect(bytes).not.toContain(c.homeDir);
      expect(bytes).not.toContain(scratch);
    }
  });

  it("AC-059-08 같은 입력이면 Plan byte·digest가 같고 Registry 순서·항목 키 순서와 무관하다", async () => {
    const a = await newCase({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] }, other: { command: "npx", args: ["-y", "x-pkg"] } }) });
    const p1 = planned(await planAdopt(opts(a)));
    const p2 = planned(await planAdopt(opts(a, { entries: [...seed].reverse() })));
    expect(serializeAdoptPlan(p2.plan)).toBe(serializeAdoptPlan(p1.plan));
    expect(p2.planDigest).toBe(p1.planDigest);
    // 같은 내용을 키 순서만 바꿔 적은 파일: 파일 byte digest(precondition.fileDigest)만 다르고 나머지는 같다(구현 중 조정).
    const b = await newCase({ ".mcp.json": mcp({ other: { args: ["-y", "x-pkg"], command: "npx" }, memory: { args: ["-y", MEMORY], command: "npx" } }) });
    const p3 = planned(await planAdopt(opts(b)));
    const strip = (p: PlannedAdopt) => ({ ...p.plan, precondition: { ...p.plan.precondition, fileDigest: null }, target: { ...p.plan.target, projectKey: null, entryKey: "" } });
    expect(strip(p3)).toEqual(strip(p1));
    expect(p3.plan.precondition.entryDigest).toBe(p1.plan.precondition.entryDigest);
  });

  it("AC-059-09 config의 env 값·token·credential URL·절대 경로가 Plan·Preview에 없고 args에 secret이 있으면 blocked다", async () => {
    const TOKEN = "ghp_" + "S3cr3tT0k3nValue1234567890abcd";
    const KEY = "sk-" + "abcdefghijklmnopqrstuvwx";
    const c = await newCase({
      ".mcp.json": mcp({
        memory: { command: "npx", args: ["-y", MEMORY, "--token", TOKEN] },
        "mem-env": { command: "npx", args: ["-y", MEMORY], env: { MEMORY_KEY: KEY } },
        "mem-url": { command: "npx", args: ["-y", MEMORY, "https://user:pw@example.com/x"] },
        "mem-path": { command: "npx", args: ["-y", MEMORY, "/home/alice/data"] },
      }),
    });
    for (const serverName of ["memory", "mem-env", "mem-url", "mem-path"]) {
      const p = planned(await planAdopt(opts(c, { serverName })));
      expect(p.plan.status, serverName).toBe("blocked");
      const all = serializeAdoptPlan(p.plan) + formatAdoptPlanPreview(p).join("\n");
      for (const banned of [TOKEN, KEY, "user:pw", "/home/alice"]) expect(all, serverName).not.toContain(banned);
    }
    expect(adoptPlanSchema.safeParse({ ...planned(await planAdopt(opts(c, { serverName: "mem-env" }))).plan, toolId: TOKEN }).success).toBe(false);
  });

  it("AC-059-10 adopt-plan-v1 승인은 다른 종류 gate와 서로 통과하지 못하고 기존 Plan 계약은 그대로다", async () => {
    const c = await newCase({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] } }) });
    const p = planned(await planAdopt(opts(c)));
    const outcome = await requestAdoptApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    let regen = 0;
    const never = () => (regen++, Promise.reject(new Error("unused")));
    expect(await verifyApprovedPlan(outcome.approval as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(await verifyApprovedLifecyclePlan(outcome.approval as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(await verifyPinokioApproval(outcome.approval as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const h = await createHarness(scratch, { entries: seed });
    const install = await approveAll(await plannedOf(h, h.request("memory-mcp", [{ client: "claude-code", scope: "project" }])));
    expect(await verifyApprovedAdoptPlan(install as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const forged = { planDigest: p.planDigest, acknowledgements: ["base", "artifact-unlocked"], channel: "cli-tty" };
    expect(await verifyApprovedAdoptPlan(forged as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(regen).toBe(0);
    // 새 종류는 기존 enum을 넓히지 않는다(골든 byte는 AC-058-04가 함께 확인한다).
    expect(PLAN_CHANGE_KINDS).not.toContain("identity");
    expect(LIFECYCLE_PLAN_CHANGE_KINDS).not.toContain("state-present");
    expect([...APPROVAL_REQUIREMENTS, ...LIFECYCLE_APPROVAL_REQUIREMENTS]).not.toContain("identity-strong-match");
    expect(ADOPT_APPROVAL_REQUIREMENTS).toEqual(["base", "identity-strong-match", "artifact-unlocked", "user-scope-target"]);
  });

  it("AC-059-05 Codex 항목은 OpenHub 표준 block 형태일 때만 adopt 대상이다(이후 update가 block을 교체한다)", async () => {
    const value = { command: "npx", args: ["-y", MEMORY + "@1.2.3"] };
    const standard = await newCase({ ".codex/config.toml": "model = \"x\"\n\n" + codexBlock("memory", value, "\n") });
    const ok = planned(await planAdopt(opts(standard, { client: "codex" })));
    expect(ok.plan.status).toBe("ready");
    expect(ok.plan.precondition.tomlBlockDigest).toMatch(/^sha256:/u);
    const custom = await newCase({ ".codex/config.toml": "[mcp_servers.memory]\ncommand = \"npx\"\nargs = [\n  \"-y\",\n  \"" + MEMORY + "@1.2.3\",\n]\n" });
    const no = planned(await planAdopt(opts(custom, { client: "codex" })));
    expect(no.plan.status).toBe("blocked");
    expect(codes(no)).toContain("ADOPT_ENTRY_UNSUPPORTED");
  });

  it("AC-059-01 Windows D-016 wrapper 항목은 windows launch로 표현된다", async () => {
    const c = await newCase({ ".mcp.json": mcp({ memory: { command: "cmd", args: ["/d", "/c", "npx", "-y", MEMORY + "@1.2.3"] } }) });
    const p = planned(await planAdopt(opts(c, { platform: "windows" })));
    expect(p.plan.status).toBe("ready");
    expect(p.plan.launch).toEqual({ platform: "windows", clientSpec: { command: "cmd", args: ["/d", "/c", "npx", "-y", MEMORY + "@1.2.3"] } });
    expect(p.plan.backend).toBe("npx");
  });
});

