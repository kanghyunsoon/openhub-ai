import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as core from "../../src/index";
import {
  executeWithApproval,
  isVerifiedPlan,
  requestApproval,
  verifyApprovedPlan,
  type ApprovalPrompter,
  type ApprovalRequirement,
  type InstallApproval,
  type PlanAssemblyInput,
  type PlannedInstall,
  type RegistryEntry,
} from "../../src/index";
import { item, seedEntries, tool } from "../recommendation/helpers";
import { clientProfile, entryOf, launchSpec, planFor, reportFor, target } from "./helpers";

const seed = await seedEntries();
afterEach(() => vi.unstubAllEnvs());

const postgresProfile = () => clientProfile({ databases: [item("postgresql", "PostgreSQL", "dependency", { file: "pyproject.toml" })] });
const uvx = {
  backend: { adapter: "uvx" as const, selection: "preferred" as const, skipped: [], probe: { name: "uvx", available: true, version: "0.5.0", status: "ok" as const } },
  artifact: { kind: "python-package" as const, spec: "postgres-mcp", pinned: false, preparation: "launch-on-demand" as const },
  launch: launchSpec("uvx", ["postgres-mcp", "--access-mode=restricted"]),
};
const npx = {
  backend: { adapter: "npx" as const, selection: "preferred" as const, skipped: [], probe: { name: "npx", available: true, version: "10.9.0", status: "ok" as const } },
};

/** 실행 직전 재생성: 같은 입력(entries·report·probe·target)으로 Plan을 다시 만든다. */
function scenario(toolId: string, over: Partial<PlanAssemblyInput> = {}, entries: RegistryEntry[] = seed) {
  const profile = toolId === "postgres-mcp" ? postgresProfile() : clientProfile();
  const build = (e: RegistryEntry[] = entries, more: Partial<PlanAssemblyInput> = {}): PlannedInstall => planFor(e, reportFor(profile, e), toolId, { ...over, ...more });
  return { planned: build(), build };
}

function human(answer: "all" | readonly ApprovalRequirement[] | "rejected" = "all"): ApprovalPrompter & { seen: number } {
  const prompter = {
    channel: "cli-tty" as const,
    seen: 0,
    async confirm(req: Parameters<ApprovalPrompter["confirm"]>[0]) {
      prompter.seen += 1;
      if (answer === "rejected") return "rejected" as const;
      return answer === "all" ? req.requirements.map((r) => r.id) : answer;
    },
  };
  return prompter;
}

async function approve(planned: PlannedInstall, answer: Parameters<typeof human>[0] = "all"): Promise<InstallApproval> {
  const outcome = await requestApproval(planned, human(answer));
  if (outcome.status !== "approved") throw new Error("승인 실패: " + outcome.status);
  return outcome.approval;
}

/** fake spawner·fake 파일 쓰기. effect 안에서만 호출된다. */
function effects() {
  const spawner = vi.fn();
  const writeFile = vi.fn();
  return { spawner, writeFile, effect: async () => (spawner("docker", ["pull", "x"], { shell: false }), writeFile(".mcp.json"), "done") };
}

const digestOf = (text: string) => "sha256:" + createHash("sha256").update(text).digest("hex");

describe("REQ-034 Approval과 PLAN_STALE", () => {
  it("AC-028-01 승인 없이 실행하면 APPROVAL_REQUIRED이고 spawn·파일 쓰기·재생성이 0회다", async () => {
    const { planned, build } = scenario("memory-mcp");
    const regenerate = vi.fn(() => build());
    for (const approval of [undefined, { planDigest: planned.planDigest, acknowledgements: planned.plan.approvalRequirements, channel: "cli-tty" } as InstallApproval]) {
      const fx = effects();
      const result = await executeWithApproval(approval, regenerate, fx.effect);
      expect(result).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
      expect(fx.spawner).not.toHaveBeenCalled();
      expect(fx.writeFile).not.toHaveBeenCalled();
    }
    expect(regenerate).not.toHaveBeenCalled();
  });

  it("AC-028-02 acknowledgements가 approvalRequirements를 정확히 덮지 않으면 APPROVAL_INCOMPLETE이고 spawn 0회다", async () => {
    const { planned, build } = scenario("memory-mcp");
    expect(planned.plan.approvalRequirements).toEqual(["base", "floating-artifact"]);
    for (const answer of [["base"], ["base", "floating-artifact", "user-scope-config"]] as ApprovalRequirement[][]) {
      const approval = await approve(planned, answer);
      const fx = effects();
      const result = await executeWithApproval(approval, () => build(), fx.effect);
      expect(result).toMatchObject({ ok: false, code: "APPROVAL_INCOMPLETE" });
      expect(fx.spawner).not.toHaveBeenCalled();
    }
  });

  it("AC-028-02 사람이 거부하거나 base를 확인하지 않으면 Approval이 생기지 않는다", async () => {
    const { planned } = scenario("memory-mcp");
    expect(await requestApproval(planned, human("rejected"))).toEqual({ status: "rejected" });
    expect(await requestApproval(planned, human(["floating-artifact"]))).toEqual({ status: "rejected" });
    // (v0.2.0 대상별 판정) 고른 대상에 같은 항목이 이미 있는 Plan은 승인할 것이 없다.
    const memoryLaunch = launchSpec("npx", ["-y", "memory-mcp@latest"]);
    const sameEntry = { exists: true, fileDigest: "sha256:" + "b".repeat(64), keyAbsent: false, entryDigest: core.entryPlanDigest(core.serverEntry("claude-code", memoryLaunch, [])) };
    const installed = planFor(seed, reportFor(clientProfile({ aiTools: [tool("memory")] }), seed), "memory-mcp", { launch: memoryLaunch, targets: [target("claude-code", "project", { precondition: sameEntry })] });
    expect(installed.plan.status).toBe("already-installed");
    const prompter = human();
    expect(await requestApproval(installed, prompter)).toMatchObject({ status: "not-approvable", code: "PLAN_NOT_EXECUTABLE" });
    expect(prompter.seen).toBe(0);
    const tampered = { plan: { ...planned.plan, displayName: "다른 이름" }, planDigest: planned.planDigest };
    expect(await requestApproval(tampered, human())).toMatchObject({ status: "not-approvable", code: "PLAN_INVALID" });
  });

  it("AC-028-03 승인 후 Manifest 실행 인자가 바뀌면 PLAN_STALE{manifest, steps}이고 spawn 0회다", async () => {
    const { planned, build } = scenario("postgres-mcp", uvx);
    const approval = await approve(planned);
    const pg = entryOf(seed, "postgres-mcp");
    const changed: RegistryEntry = { ...pg, manifest: { ...pg.manifest, install: { ...pg.manifest.install, options: { command: "uvx postgres-mcp --access-mode=unrestricted" } } } };
    const entries = seed.map((e) => (e === pg ? changed : e));
    const fx = effects();
    const result = await executeWithApproval(approval, () => build(entries, { launch: launchSpec("uvx", ["postgres-mcp", "--access-mode=unrestricted"]) }), fx.effect);
    expect(result).toEqual({ ok: false, code: "PLAN_STALE", message: expect.any(String), changed: ["manifest", "steps"] });
    expect(fx.spawner).not.toHaveBeenCalled();
  });

  it("AC-028-04 승인 후 Registry에 manifest가 추가되면 PLAN_STALE{registry}다", async () => {
    const { planned, build } = scenario("postgres-mcp", uvx);
    const approval = await approve(planned);
    const memory = entryOf(seed, "memory-mcp");
    const added: RegistryEntry = { ...memory, file: "memory/extra-memory.yaml", manifest: { ...memory.manifest, name: "extra-memory", recommendation: { ...memory.manifest.recommendation!, identity: { mcpServerNames: ["extra-memory"] } } } };
    const result = await verifyApprovedPlan(approval, () => build([...seed, added]));
    expect(result).toMatchObject({ ok: false, code: "PLAN_STALE", changed: ["registry"] });
  });

  it("AC-028-05 승인 후 probe에서 npx가 unavailable이 되면 PLAN_STALE{backend}다", async () => {
    const { planned, build } = scenario("memory-mcp", npx);
    const approval = await approve(planned);
    const gone = { backend: { ...npx.backend, probe: { name: "npx", available: false, version: null, status: "not-found" as const } }, blockers: [{ code: "BACKEND_UNAVAILABLE", message: "npx를 찾지 못했습니다" }] };
    const result = await verifyApprovedPlan(approval, () => build(seed, gone));
    expect(result).toMatchObject({ ok: false, code: "PLAN_STALE", changed: ["backend"] });
  });

  it("AC-028-06 승인 후 대상 config 파일이 1 byte라도 바뀌면 PLAN_STALE{config-precondition}다", async () => {
    const original = '{\n  "mcpServers": {}\n}\n';
    const withFile = (text: string) => ({ targets: [target("claude-code", "project", { precondition: { exists: true, fileDigest: digestOf(text), keyAbsent: true } })] });
    const { planned, build } = scenario("memory-mcp", withFile(original));
    const approval = await approve(planned);
    const result = await verifyApprovedPlan(approval, () => build(seed, withFile(original + " ")));
    expect(result).toMatchObject({ ok: false, code: "PLAN_STALE", changed: ["config-precondition"] });
  });

  it("AC-028-07 대상 client가 바뀌면 target, requiredEnv 이름이 바뀌면 env-names로 stale 판정한다", async () => {
    const first = scenario("memory-mcp");
    const clientChange = await verifyApprovedPlan(await approve(first.planned), () => first.build(seed, { targets: [target("cursor")] }));
    expect(clientChange).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(clientChange.ok === false && clientChange.changed).toContain("target");

    const second = scenario("postgres-mcp", uvx);
    const pg = entryOf(seed, "postgres-mcp");
    const renamed: RegistryEntry = { ...pg, manifest: { ...pg.manifest, env: [{ name: "POSTGRES_URL", required: true, description: "접속 문자열" }] } };
    const envChange = await verifyApprovedPlan(await approve(second.planned), () => second.build(seed.map((e) => (e === pg ? renamed : e))));
    expect(envChange).toMatchObject({ ok: false, code: "PLAN_STALE" });
    expect(envChange.ok === false && envChange.changed).toContain("env-names");
  });

  it("AC-028-08 Approval은 1회 사용이고 두 번째 실행은 APPROVAL_CONSUMED다(PLAN_STALE도 소모한다)", async () => {
    const { planned, build } = scenario("memory-mcp");
    const approval = await approve(planned);
    const fx = effects();
    const first = await executeWithApproval(approval, () => build(), fx.effect);
    expect(first).toEqual({ ok: true, value: "done" });
    const second = await executeWithApproval(approval, () => build(), fx.effect);
    expect(second).toMatchObject({ ok: false, code: "APPROVAL_CONSUMED" });
    expect(fx.spawner).toHaveBeenCalledTimes(1);

    const stale = await approve(planned);
    expect(await verifyApprovedPlan(stale, () => build(seed, { targets: [target("cursor")] }))).toMatchObject({ code: "PLAN_STALE" });
    expect(await verifyApprovedPlan(stale, () => build())).toMatchObject({ code: "APPROVAL_CONSUMED" });
  });

  it("AC-028-08 검증을 통과한 Plan만 VerifiedPlan이고 승인한 Plan과 byte가 같다", async () => {
    const { planned, build } = scenario("memory-mcp");
    const result = await verifyApprovedPlan(await approve(planned), () => build());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(isVerifiedPlan(result.verified)).toBe(true);
    expect(isVerifiedPlan({ ...result.verified })).toBe(false);
    expect(JSON.stringify(core.canonicalize(result.verified.plan))).toBe(JSON.stringify(core.canonicalize(planned.plan)));
    expect(result.verified.planDigest).toBe(planned.planDigest);
  });

  it("AC-028-09 사람 확인 없이 Approval을 만드는 Core API가 없고 환경변수·설정으로 acknowledgement를 채울 수 없다", async () => {
    const forbidden = Object.keys(core).filter((name) => /^(?:create|make|issue|grant|forge|auto|force|skip)\w*Approv|autoApprove|approveDigest|yes/iu.test(name));
    expect(forbidden).toEqual([]);
    // M6 TASK-058(D-028): M1 approvePlan은 삭제했다. Core가 발급하지 않은(직접 만든) 승인 객체로는 M4 실행 게이트를 통과할 수 없다.
    const { planned, build } = scenario("memory-mcp");
    const m1 = { planDigest: planned.planDigest, approvedBy: "someone", approvedAt: new Date(0).toISOString() } as unknown as InstallApproval;
    expect(await verifyApprovedPlan(m1, () => build())).toMatchObject({ code: "APPROVAL_REQUIRED" });
    const lookalike = { planDigest: planned.planDigest, acknowledgements: ["base", "floating-artifact"], channel: "cli-tty" } as unknown as InstallApproval;
    expect(await verifyApprovedPlan(lookalike, () => build())).toMatchObject({ code: "APPROVAL_REQUIRED" });

    vi.stubEnv("OPENHUB_AUTO_APPROVE", "1");
    vi.stubEnv("OPENHUB_ACKNOWLEDGE", "base,floating-artifact");
    vi.stubEnv("OPENHUB_APPROVE", planned.planDigest);
    const approval = await approve(planned, ["base"]);
    expect(approval.acknowledgements).toEqual(["base"]);
    expect(await verifyApprovedPlan(approval, () => build())).toMatchObject({ code: "APPROVAL_INCOMPLETE", missing: ["floating-artifact"] });

    const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
    for (const file of ["approval-v1.ts", "stale.ts", "plan.ts"]) {
      const src = stripComments(await readFile(path.resolve(import.meta.dirname, "../../src/installer", file), "utf8"));
      for (const banned of ["process.env", "readFile", "--yes", "autoApprove", "--approve"]) expect(src, file + " " + banned).not.toContain(banned);
    }
  });

  it("AC-028-10 floating-artifact 또는 client-env-parse-risk acknowledgement가 빠지면 APPROVAL_INCOMPLETE이고 spawn 0회다", async () => {
    const { planned, build } = scenario("postgres-mcp", uvx);
    expect(planned.plan.approvalRequirements).toEqual(["base", "floating-artifact", "client-env-parse-risk"]);
    for (const [answer, missing] of [
      [["base", "client-env-parse-risk"], ["floating-artifact"]],
      [["base", "floating-artifact"], ["client-env-parse-risk"]],
    ] as [ApprovalRequirement[], ApprovalRequirement[]][]) {
      const fx = effects();
      const result = await executeWithApproval(await approve(planned, answer), () => build(), fx.effect);
      expect(result).toMatchObject({ ok: false, code: "APPROVAL_INCOMPLETE", missing });
      expect(fx.spawner).not.toHaveBeenCalled();
      expect(fx.writeFile).not.toHaveBeenCalled();
    }
    const fx = effects();
    expect(await executeWithApproval(await approve(planned), () => build(), fx.effect)).toEqual({ ok: true, value: "done" });
  });
});
