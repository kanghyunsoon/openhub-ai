import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { planLifecycle, recordInstallInState, requestLifecycleApproval, runHealthCheck, runInstallTransaction, verifyApprovedLifecyclePlan } from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * Registry sandbox install test(TASK-054, D-025 §9). registry-remote.yml의 sandbox job에서만 실행한다(OPENHUB_E2E=1).
 * CI runner 안에서 secret 없이 seed 도구(memory-mcp, npx)를 실제 설정에 적고 M5 Health(MCP handshake)를 실제로 실행한다.
 * 기본 테스트·PR CI에서는 skip이다.
 */
describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("REQ-051 Registry sandbox install", () => {
  it("AC-054-08 sandbox: memory-mcp를 설치 계획대로 적고 실제 npx로 Health handshake를 통과한다", async () => {
    const seed = await seedEntries();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-sandbox-"));
    try {
      const h = await createHarness(scratch, { entries: seed });
      const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
      const planned = await plannedOf(h, request);
      const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
      expect(result.status).toBe("succeeded");
      expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
      const regen = () => planLifecycle({ operation: "health", toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false });
      const first = await regen();
      if (!first.ok) throw new Error(first.code);
      const outcome = await requestLifecycleApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (outcome.status !== "approved") throw new Error(outcome.status);
      const gate = await verifyApprovedLifecyclePlan(outcome.approval, regen);
      if (!gate.ok) throw new Error(gate.code);
      const health = await runHealthCheck(gate.verified, { healthCheckType: "mcp-handshake", tempBase: os.tmpdir() });
      expect(health).toMatchObject({ ok: true, result: { status: "healthy" } });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }, 600_000);
});

