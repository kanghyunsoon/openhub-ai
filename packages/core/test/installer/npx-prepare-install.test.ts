import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  formatInstallPlanPreview,
  installPlanSchema,
  npxPrepareArgs,
  runInstallTransaction,
  type RegistryEntry,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";
import { approveAll, createHarness, plannedOf } from "./harness";

/**
 * v0.2.0 npx Prepare — 설치 경로. 정확한 버전으로 고정된 npx Manifest는 설정을 쓰기 전에 npx cache를 채운다.
 * 버전이 고정되지 않은 Manifest(현재 Registry의 npx 도구 전부)는 launch-on-demand 그대로다.
 */
const seed = await seedEntries();
const scratch = await newScratch("npx-prepare-install-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const PINNED = "@modelcontextprotocol/server-memory@2026.8.31";
const withMemoryCommand = (command: string): RegistryEntry[] =>
  seed.map((e) => (e.manifest.name === "memory-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command } } } } : e));
const pinned = withMemoryCommand("npx -y " + PINNED);
const CLAUDE = [{ client: "claude-code" as const, scope: "project" as const }];

describe("npx Prepare: 설치", () => {
  it("고정 버전 npx는 Prepare 단계가 설정 쓰기 앞에 오고 floating 승인이 없으며 Preview가 설명한다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const planned = await plannedOf(h, h.request("memory-mcp", CLAUDE));
    const { plan } = planned;
    expect(plan.artifact).toEqual({ kind: "npm-package", spec: PINNED, pinned: true, preparation: "npm-cache" });
    expect(plan.steps.map((s) => s.id)).toEqual(["npx-prepare", "config-claude-code-project"]);
    expect(plan.steps[0]).toEqual({ id: "npx-prepare", kind: "run", executable: "npx", args: npxPrepareArgs(PINNED), cwd: "isolated", network: true, timeoutMs: 600_000 });
    expect(plan.approvalRequirements).not.toContain("floating-artifact");
    expect(plan.warnings.map((w) => w.code)).toContain("npx-prepare");
    expect(plan.sideEffects).toEqual(["download", "file-write", "network"]);
    expect(formatInstallPlanPreview(planned).join("\n")).toContain("npx cache에 받습니다");
  });

  it("버전이 고정되지 않은 npx(현재 Registry)는 그대로 launch-on-demand이고 준비 단계가 없다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const { plan } = await plannedOf(h, h.request("memory-mcp", CLAUDE));
    expect(plan.artifact).toMatchObject({ pinned: false, preparation: "launch-on-demand" });
    expect(plan.steps.some((s) => s.kind === "run")).toBe(false);
  });

  it("InstallPlan schema는 고정되지 않았거나 artifact와 다른 spec의 npx 준비 단계를 거부한다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const { plan } = await plannedOf(h, h.request("memory-mcp", CLAUDE));
    expect(installPlanSchema.safeParse(plan).success).toBe(true);
    const withArgs = (args: string[]) => ({ ...plan, steps: plan.steps.map((s) => (s.kind === "run" ? { ...s, args } : s)) });
    expect(installPlanSchema.safeParse(withArgs(npxPrepareArgs("@modelcontextprotocol/server-memory"))).success).toBe(false);
    expect(installPlanSchema.safeParse(withArgs(npxPrepareArgs("@modelcontextprotocol/server-memory@1.0.0"))).success).toBe(false);
    expect(installPlanSchema.safeParse(withArgs(["-y", PINNED])).success).toBe(false);
  });

  it("성공하면 Prepare 다음에 설정을 쓰고 Prepared는 cached다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const request = h.request("memory-mcp", CLAUDE);
    const planned = await plannedOf(h, request);
    h.reset();
    const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(result.status).toBe("succeeded");
    expect(result.verification?.prepared).toBe("cached");
    expect(h.spawns).toEqual([["npm", "config", "get", "cache"], ["npx", ...npxPrepareArgs(PINNED)]]);
    expect(h.log.indexOf("spawn")).toBeLessThan(h.log.indexOf("write"));
    const config = JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8"));
    expect(config.mcpServers.memory.args).toEqual(["-y", PINNED]);
  });

  it("Prepare가 실패하면 Client 설정을 쓰지 않고 다시 시도할 수 있다", async () => {
    for (const mode of ["fail", "wrong-version"] as const) {
      const h = await createHarness(scratch, { entries: pinned, npmPrepare: mode });
      const request = h.request("memory-mcp", CLAUDE);
      const planned = await plannedOf(h, request);
      const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
      expect(result, mode).toMatchObject({ status: "failed", retryable: true, verification: { prepared: "failed", configured: false } });
      expect(existsSync(path.join(h.projectRoot, ".mcp.json")), mode).toBe(false);
      expect(h.writes.filter((w) => w.startsWith("write:") || w.startsWith("rename:")), mode).toEqual([]);
    }
  });

  it("승인 뒤 Manifest의 고정 버전이 바뀌면 PLAN_STALE이고 아무것도 실행하지 않는다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const request = h.request("memory-mcp", CLAUDE);
    const planned = await plannedOf(h, request);
    const approval = await approveAll(planned);
    const moved = withMemoryCommand("npx -y @modelcontextprotocol/server-memory@2026.9.1");
    h.env.loadEntries = async () => moved;
    h.reset();
    const result = await runInstallTransaction(planned, approval, request, h.env);
    expect(result.status).toBe("stale");
    expect(h.spawns).toEqual([]);
    expect(existsSync(path.join(h.projectRoot, ".mcp.json"))).toBe(false);
  });
});
