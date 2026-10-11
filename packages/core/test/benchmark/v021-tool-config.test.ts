import { realpath, rm, unlink, writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";
import {
  KUBERNETES_TOOL_CONFIG,
  planBenchmark,
  projectKeyFromRealpath,
  recordInstallInState,
  runInstallTransaction,
  toolConfigLocation,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";

/**
 * v0.2.1 PR D: tool config(Kubernetes 정책 파일)를 쓰는 도구의 Benchmark 계획. 임시 project·home, 가짜 npm, spawn·network 0.
 * 수정 전: 정책 파일이 바뀌거나 없어도 ready였고, 실행 인자에는 {toolConfig}가 그대로 남아 실제 서버는 시작하지 못했다
 * (kubernetes-mcp-server 0.0.67: "failed to read config {toolConfig}").
 */
const scratch = await newScratch("benchmark-tool-config");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const entries: RegistryEntry[] = await seedEntries();
const K8S = "kubernetes-mcp-server";

async function installed(): Promise<{ h: Harness; file: string }> {
  const h = await createHarness(scratch, { entries });
  const request = { ...h.request(K8S, [{ client: "claude-code" as const, scope: "project" as const }]), platform: "linux" as const };
  const planned = await plannedOf(h, request);
  const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
  expect(result.status).toBe("succeeded");
  expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 1 });
  const loc = toolConfigLocation({ homeDir: h.homeDir, scope: "project", toolId: K8S, projectKey: projectKeyFromRealpath(await realpath(h.projectRoot)) })!;
  return { h, file: loc.file };
}
const bench = (h: Harness) => planBenchmark({ toolId: K8S, projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "linux", includeUser: false, client: "claude-code", scope: "project" });

const statusOf = async (h: Harness) => {
  const r = await bench(h);
  if (!r.ok) throw new Error(r.code);
  return { status: r.planned.plan.status, codes: r.planned.plan.blockers.map((b) => b.code) };
};

describe("v0.2.1 Benchmark와 tool config", () => {
  it("정책 파일이 검토된 내용 그대로여도 blocked(BENCHMARK_UNSUPPORTED)다: Benchmark는 정책 파일을 확인해 전달하지 못한다", async () => {
    const { h } = await installed();
    expect(await statusOf(h)).toEqual({ status: "blocked", codes: ["BENCHMARK_UNSUPPORTED"] });
  });

  it("read_only·denied_resources를 바꾼 정책 파일이면 blocked다(승인할 수 없다)", async () => {
    const { h, file } = await installed();
    for (const edited of [KUBERNETES_TOOL_CONFIG.replace("read_only = true", "read_only = false"), KUBERNETES_TOOL_CONFIG.replace('kind = "Secret"', 'kind = "ConfigMap"')]) {
      await writeFile(file, edited);
      expect((await statusOf(h)).status).toBe("blocked");
    }
  });

  it("정책 파일이 없어도 blocked다", async () => {
    const { h, file } = await installed();
    await unlink(file);
    expect(await statusOf(h)).toMatchObject({ status: "blocked" });
  });
});
