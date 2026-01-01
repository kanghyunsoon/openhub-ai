import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildInstallPlan, executeVerifiedPlan, nodeExecSpawner, probeBackends, toRecommendPlatform, type RegistryEntry } from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { clientProfile, reportFor, target, verifiedPlanOf } from "./helpers";

/** 실제 프로세스를 실행하는 e2e. 기본 테스트·CI에서는 건너뛰고 OPENHUB_E2E=1일 때만 실행한다(AC-031-09). */
describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("REQ-033 실제 docker pull e2e", () => {
  it("AC-031-09 실제 docker로 작은 이미지를 pull한다", async () => {
    const seed = await seedEntries();
    const base = seed.find((e) => e.manifest.name === "github-mcp-server")!;
    const hello: RegistryEntry = { ...base, manifest: { ...base.manifest, env: [], install: { preferredAdapter: "docker", options: { image: "hello-world" }, fallback: [] } } };
    const entries = seed.map((e) => (e === base ? hello : e));
    const probes = await probeBackends();
    const built = buildInstallPlan({ toolId: "github-mcp-server", entries, report: reportFor(clientProfile(), entries), probes, targets: [target("cursor")], platform: toRecommendPlatform(process.platform) ?? "linux" });
    if (!built.ok) throw new Error(built.code);
    const project = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-"));
    try {
      const report = await executeVerifiedPlan(await verifiedPlanOf(built.planned), { projectRoot: project, spawner: nodeExecSpawner });
      expect(report).toMatchObject({ ok: true, prepared: true });
    } finally {
      await rm(project, { recursive: true, force: true });
    }
  }, 600_000);
});
