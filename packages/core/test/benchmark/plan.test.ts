import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  BENCHMARK_NO_TOOL_CALL_NOTICE,
  benchmarkPlanSchema,
  commitLifecycleState,
  executeAdopt,
  formatBenchmarkPlanPreview,
  planAdopt,
  planBenchmark,
  readLifecycleState,
  requestAdoptApproval,
  requestBenchmarkApproval,
  serializeBenchmarkPlan,
  verifyApprovedAdoptPlan,
  verifyApprovedBenchmarkPlan,
  verifyApprovedLifecyclePlan,
  verifyApprovedPlan,
  verifyPinokioApproval,
  type AdoptPlanOptions,
  type BenchmarkPlanOptions,
  type BenchmarkPlanResult,
  type PlannedBenchmark,
  type RegistryEntry,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";
import { MEMORY, adoptOptions, mcp, newCase, plannedOf, type Case } from "../adopt/helpers";

/** TASK-065 BenchmarkPlan v1과 benchmark-plan-v1 승인 종류. Adopt로 Version State를 만들고 임시 project·home만 쓴다(spawn·network 0). */
const seed = await seedEntries();
const scratch = await newScratch("benchmark-plan-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const NOW = () => new Date("2026-10-08T01:00:00.000Z");
const DIGEST = "sha256:" + "e".repeat(64);

async function adopted(files: Record<string, unknown>, over: Partial<AdoptPlanOptions> = {}): Promise<Case> {
  const c = await newCase(scratch, files);
  const options = adoptOptions(seed, c, over);
  const p = plannedOf(await planAdopt(options));
  const outcome = await requestAdoptApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  const r = await executeAdopt(outcome.approval, { toolId: options.toolId, homeDir: c.homeDir, now: NOW, regenerate: () => planAdopt(options) });
  expect(r.status).toBe("adopted");
  return c;
}
const bopts = (c: Case, over: Partial<BenchmarkPlanOptions> = {}): BenchmarkPlanOptions => ({ toolId: "memory-mcp", projectRoot: c.projectRoot, homeDir: c.homeDir, entries: seed, platform: "linux", includeUser: false, ...over });
const planned = (r: BenchmarkPlanResult): PlannedBenchmark => {
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
};
const codes = (p: PlannedBenchmark) => p.plan.blockers.map((b) => b.code);
const pinned = { ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }) };
async function approve(p: PlannedBenchmark) {
  const o = await requestBenchmarkApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (o.status !== "approved") throw new Error(o.status);
  return o.approval;
}
const withManifest = (toolId: string, edit: (m: RegistryEntry["manifest"]) => void): RegistryEntry[] =>
  seed.map((e) => {
    if (e.manifest.name !== toolId) return e;
    const copy = structuredClone(e);
    edit(copy.manifest);
    return copy;
  });

describe("REQ-061 BenchmarkPlan v1", () => {
  it("AC-065-01 관리 + 고정 artifact만 ready이고 unlocked·미관리·Pinokio/HTTP는 blocked다", async () => {
    const ok = planned(await planBenchmark(bopts(await adopted(pinned))));
    expect(ok.plan.status).toBe("ready");
    expect(ok.plan.artifact.resolved?.spec).toBe(MEMORY + "@1.2.3");
    const unlocked = planned(await planBenchmark(bopts(await adopted({ ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY] } }) }))));
    expect(codes(unlocked)).toContain("BENCHMARK_ARTIFACT_UNLOCKED");
    const none = planned(await planBenchmark(bopts(await newCase(scratch, pinned))));
    expect(none.plan).toMatchObject({ status: "blocked", target: null, launch: null });
    expect(codes(none)).toContain("BENCHMARK_NOT_MANAGED");
    const c = await adopted(pinned);
    for (const edit of [(m: RegistryEntry["manifest"]) => void (m.healthCheck = { type: "http", url: "http://127.0.0.1:42000/health", expectStatus: 200 }), (m: RegistryEntry["manifest"]) => void (m.install.preferredAdapter = "pinokio")]) {
      const p = planned(await planBenchmark(bopts(c, { entries: withManifest("memory-mcp", edit) })));
      expect(codes(p)).toContain("BENCHMARK_UNSUPPORTED");
    }
  });

  it("AC-065-02 runs(warmup 1, measured 5)와 timeouts는 고정이며 옵션으로 바꿀 수 없다", async () => {
    const c = await adopted(pinned);
    const p = planned(await planBenchmark({ ...bopts(c), runs: { warmup: 0, measured: 50 }, timeouts: { startupMs: 1 } } as never));
    expect(p.plan.runs).toEqual({ warmup: 1, measured: 5 });
    expect(p.plan.timeouts).toEqual({ startupMs: 20000, handshakeMs: 10000, runTotalMs: 45000, planTotalMs: 300000 });
    expect(benchmarkPlanSchema.safeParse({ ...p.plan, runs: { warmup: 1, measured: 10 } }).success).toBe(false);
    expect(benchmarkPlanSchema.safeParse({ ...p.plan, timeouts: { ...p.plan.timeouts, planTotalMs: 900000 } }).success).toBe(false);
  });

  it("AC-065-03 launch는 고정 artifact로 HealthStep 규칙대로 만들고 cmd wrapper·절대 경로가 없다", async () => {
    const c = await adopted({ ".mcp.json": mcp({ memory: { command: "cmd", args: ["/d", "/c", "npx", "-y", MEMORY + "@1.2.3"] } }) }, { platform: "windows" });
    const p = planned(await planBenchmark(bopts(c, { platform: "windows" })));
    expect(p.plan.launch).toEqual({ executable: "npx", args: ["-y", MEMORY + "@1.2.3"], envNames: [], cwd: "isolated" });
    const bytes = serializeBenchmarkPlan(p.plan);
    expect(bytes).not.toContain(c.projectRoot);
    expect(bytes).not.toContain(c.homeDir);
    expect(benchmarkPlanSchema.safeParse({ ...p.plan, launch: { ...p.plan.launch!, args: ["/d", "/c", "npx"] } }).success).toBe(false);
  });

  it("AC-065-04 승인 요구는 base(+environment-unverified·artifact-fetch)이고 Preview는 tool 호출 없음을 명시한다", async () => {
    const memory = planned(await planBenchmark(bopts(await adopted(pinned))));
    expect(memory.plan.approvalRequirements).toEqual(["base", "artifact-fetch"]);
    const gh = await adopted(
      {
        ".mcp.json": mcp({
          github: { command: "docker", args: ["run", "-i", "--rm", "-e", "GITHUB_PERSONAL_ACCESS_TOKEN", "ghcr.io/github/github-mcp-server@" + DIGEST], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "$" + "{GITHUB_PERSONAL_ACCESS_TOKEN}" } },
        }),
      },
      { toolId: "github-mcp-server" },
    );
    const p = planned(await planBenchmark(bopts(gh, { toolId: "github-mcp-server" })));
    expect(p.plan.status).toBe("ready");
    expect(p.plan.approvalRequirements).toEqual(["base", "environment-unverified", "artifact-fetch"]);
    expect(p.plan.launch?.envNames).toEqual(["GITHUB_PERSONAL_ACCESS_TOKEN"]);
    const preview = formatBenchmarkPlanPreview(p).join("\n");
    expect(preview).toContain(BENCHMARK_NO_TOOL_CALL_NOTICE);
    expect(preview).toContain("tools/call 0");
    expect(p.plan.protocol.methods).toEqual(["initialize", "notifications/initialized", "tools/list"]);
  });

  it("AC-065-05 benchmark-plan-v1 Approval은 install·lifecycle·adopt·pinokio gate를 통과하지 못하고 그 반대도 같다", async () => {
    const c = await adopted(pinned);
    const approval = await approve(planned(await planBenchmark(bopts(c))));
    let regen = 0;
    const never = () => (regen++, Promise.reject(new Error("unused")));
    for (const gate of [verifyApprovedPlan, verifyApprovedLifecyclePlan, verifyApprovedAdoptPlan, verifyPinokioApproval]) {
      expect(await gate(approval as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    }
    const d = await newCase(scratch, pinned);
    const ap = plannedOf(await planAdopt(adoptOptions(seed, d)));
    const adoptApproval = await requestAdoptApproval(ap, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (adoptApproval.status !== "approved") throw new Error("approve");
    expect(await verifyApprovedBenchmarkPlan(adoptApproval.approval as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(regen).toBe(0);
  });

  it("AC-065-06 승인 후 state·artifact·launch·registry·manifest가 바뀌면 PLAN_STALE이고 spawn 0이다", async () => {
    const cases: [string, (c: Case) => Promise<Partial<BenchmarkPlanOptions>>][] = [
      ["state", async (c) => {
        const read = await readLifecycleState({ homeDir: c.homeDir });
        if (!read.ok) throw new Error(read.code);
        const next = structuredClone(read.state);
        for (const e of Object.values(next.entries)) e.revision = 2;
        await commitLifecycleState(next, read.digest, { homeDir: c.homeDir });
        return {};
      }],
      ["artifact", async (c) => {
        const read = await readLifecycleState({ homeDir: c.homeDir });
        if (!read.ok) throw new Error(read.code);
        const next = structuredClone(read.state);
        for (const e of Object.values(next.entries)) e.artifact.resolved = { ...e.artifact.resolved!, version: "1.2.4", spec: MEMORY + "@1.2.4" };
        await commitLifecycleState(next, read.digest, { homeDir: c.homeDir });
        return {};
      }],
      ["launch", async () => ({ platform: "macos" })],
      ["registry", async () => ({ entries: withManifest("context7", (m) => void (m.summary = "changed")) })],
      ["manifest", async () => ({ entries: withManifest("memory-mcp", (m) => void (m.summary = "changed")) })],
    ];
    for (const [kind, change] of cases) {
      const c = await adopted(pinned);
      const approval = await approve(planned(await planBenchmark(bopts(c))));
      const over = await change(c);
      const gate = await verifyApprovedBenchmarkPlan(approval, () => planBenchmark(bopts(c, over)));
      expect(gate, kind).toMatchObject({ ok: false, code: "PLAN_STALE" });
      expect(!gate.ok && gate.changed, kind).toContain(kind);
    }
    const src = await import("node:fs/promises").then((m) => m.readFile(path.join(import.meta.dirname, "../../src/benchmark/plan.ts"), "utf8"));
    expect(src).not.toMatch(new RegExp('from "node:' + "child_" + 'process"|spawn\\(', "u"));
  });

  it("AC-065-07 같은 입력이면 Plan byte가 같다", async () => {
    const c = await adopted(pinned);
    const a = planned(await planBenchmark(bopts(c)));
    const b = planned(await planBenchmark(bopts(c, { entries: [...seed].reverse() })));
    expect(serializeBenchmarkPlan(b.plan)).toBe(serializeBenchmarkPlan(a.plan));
    expect(b.planDigest).toBe(a.planDigest);
  });

  it("AC-065-08 대상 config 항목이 state와 다르면 BENCHMARK_CONFIG_DRIFT다", async () => {
    const c = await adopted(pinned);
    await writeFile(path.join(c.projectRoot, ".mcp.json"), JSON.stringify(mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3", "--x"] } }), null, 2) + "\n");
    expect(codes(planned(await planBenchmark(bopts(c))))).toContain("BENCHMARK_CONFIG_DRIFT");
    await writeFile(path.join(c.projectRoot, ".mcp.json"), JSON.stringify(mcp({}), null, 2) + "\n");
    expect(codes(planned(await planBenchmark(bopts(c))))).toContain("BENCHMARK_CONFIG_DRIFT");
  });
});

