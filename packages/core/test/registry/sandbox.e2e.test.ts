import os from "node:os";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { locateWindowsNpxLauncher, planLifecycle, recordInstallInState, requestLifecycleApproval, runHealthCheck, runInstallTransaction, verifyApprovedLifecyclePlan } from "../../src/index";
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

  /**
   * v0.2.0 P0-2 batch 1. 새 Manifest를 실제 설정 파일에 적고, 실제 npx로 Health handshake(initialize + tools/list)를 실행한다.
   * 실제 클러스터·자격증명은 쓰지 않는다. 접속할 수 없는 주소와 빈 user를 가진 합성 kubeconfig만 쓴다
   * (서버는 시작할 때 클러스터에 접속하지 않는다). Health는 OS 환경을 상속하므로 이 테스트만 KUBECONFIG를 합성 파일로 바꿨다가 되돌린다.
   */
  const platform = process.platform === "win32" ? "windows" : "linux";
  const cases = [
    { toolId: "kubernetes-mcp-server", clients: ["claude-code", "cursor", "codex"] as const, flag: "--read-only" },
  ];
  for (const c of cases) {
    it("P0-2 batch 1 sandbox: " + c.toolId + "를 설치 계획대로 적고 실제 npx로 Health handshake를 통과한다", async () => {
      const seed = await seedEntries();
      const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-sandbox-"));
      const kubeconfig = path.join(scratch, "synthetic-kubeconfig.yaml");
      await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster: { server: 'https://127.0.0.1:1' }\ncontexts:\n- name: fake\n  context: { cluster: fake, user: fake }\ncurrent-context: fake\nusers:\n- name: fake\n  user: {}\n");
      const previous = process.env["KUBECONFIG"];
      process.env["KUBECONFIG"] = kubeconfig;
      try {
        const h = await createHarness(scratch, { entries: seed });
        const request = { ...h.request(c.toolId, c.clients.map((client) => ({ client, scope: "project" as const }))), platform } as const;
        const planned = await plannedOf(h, request);
        const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
        expect(result.status).toBe("succeeded");
        // 세 Client 설정 모두 OpenHub가 고정한 안전 플래그를 담고, 합성 kubeconfig 경로·주소는 담지 않는다.
        for (const file of [".mcp.json", ".cursor/mcp.json", ".codex/config.toml"]) {
          const written = await readFile(path.join(h.projectRoot, file), "utf8");
          expect(written, file).toContain(c.flag);
          expect(written, file).not.toMatch(/127\.0\.0\.1|synthetic-kubeconfig/u);
        }
        expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
        const regen = () => planLifecycle({ operation: "health", toolId: c.toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform, includeUser: false });
        const first = await regen();
        if (!first.ok) throw new Error(first.code);
        const outcome = await requestLifecycleApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
        if (outcome.status !== "approved") throw new Error(outcome.status);
        const gate = await verifyApprovedLifecyclePlan(outcome.approval, regen);
        if (!gate.ok) throw new Error(gate.code);
        // Windows npx는 cmd를 거치지 않고 node.exe + npx-cli.js로 실행한다(D-016). 경로는 probe 단계처럼 PATH에서 찾는다.
        const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
        const health = await runHealthCheck(gate.verified, { healthCheckType: "mcp-handshake", tempBase: os.tmpdir(), windowsNpx });
        expect(health).toMatchObject({ ok: true, result: { status: "healthy" } });
        if (health.ok) console.log(c.toolId + " health: " + JSON.stringify({ status: health.result.status, toolCount: health.result.toolCount, environmentUnverified: health.result.environmentUnverified }));
      } finally {
        if (previous === undefined) delete process.env["KUBECONFIG"];
        else process.env["KUBECONFIG"] = previous;
        await rm(scratch, { recursive: true, force: true });
      }
    }, 600_000);
  }
});

