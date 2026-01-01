import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readConfiguredEntry, recommend, runInstallTransaction, serializeInstallResult, type ConfigFs } from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { approveAll, createHarness, listing, newScratch, plannedOf } from "./harness";

const seed = await seedEntries();
const scratch = await newScratch("verify-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllGlobals());

describe("REQ-035 Post-install Verification", () => {
  it("AC-034-01 Prepared: npx·uvx는 spawn 0회로 launch-on-demand, docker는 pull 성공 시 pulled", async () => {
    for (const toolId of ["memory-mcp", "serena"]) {
      const h = await createHarness(scratch, { entries: seed });
      const request = h.request(toolId, [{ client: "claude-code", scope: "project" }]);
      const p = await plannedOf(h, request);
      const result = await runInstallTransaction(p, await approveAll(p), request, h.env);
      expect(result.verification?.prepared, toolId).toBe("launch-on-demand");
      expect(h.spawns).toEqual([]);
    }
    const h = await createHarness(scratch, { entries: seed });
    const request = h.request("github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const p = await plannedOf(h, request);
    const result = await runInstallTransaction(p, await approveAll(p), request, h.env);
    expect(result.verification).toEqual({ prepared: "pulled", configured: true, detected: true });
    expect(h.spawns).toEqual([["docker", "pull", "ghcr.io/github/github-mcp-server"]]);
  });

  it("AC-034-01 pull이 실패하면 Prepared는 failed이고 Configured를 시도하지 않는다", async () => {
    const h = await createHarness(scratch, { entries: seed, exitCode: 1 });
    const request = h.request("github-mcp-server", [{ client: "cursor", scope: "project" }]);
    const p = await plannedOf(h, request);
    const approval = await approveAll(p);
    h.reset();
    const result = await runInstallTransaction(p, approval, request, h.env);
    expect(result.verification).toEqual({ prepared: "failed", configured: false, detected: "skipped" });
    expect(h.writes).toEqual([]);
    // pull 뒤에는 config를 읽지도 쓰지도 않는다(앞선 read는 실행 직전 Plan 재생성의 precondition 확인이다).
    expect(h.log.slice(h.log.indexOf("spawn") + 1).filter((e) => e === "read" || e === "write")).toEqual([]);
    expect(h.log).not.toContain("verify");
  });

  it("AC-034-02 Configured: 다시 읽은 항목이 Plan 값과 같다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const request = h.request("postgres-mcp", [{ client: "claude-code", scope: "project" }, { client: "codex", scope: "project" }]);
    const p = await plannedOf(h, request);
    const result = await runInstallTransaction(p, await approveAll(p), request, h.env);
    expect(result.verification?.configured).toBe(true);
    for (const step of p.plan.steps) {
      if (step.kind !== "config-patch") continue;
      expect(await readConfiguredEntry(step.client, step.scope, "postgres", { projectRoot: h.projectRoot, homeDir: h.homeDir })).toEqual(step.value);
    }
  });

  it("AC-034-03 Detected: analyzeProject 재실행 후 resolver가 해당 toolId로 resolved하고 user scope면 host를 포함한다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const project = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const p1 = await plannedOf(h, project);
    h.reset();
    expect((await runInstallTransaction(p1, await approveAll(p1), project, h.env)).verification?.detected).toBe(true);
    expect(h.analyzeCalls.at(-1)).toBe(false);

    const u = await createHarness(scratch, { entries: seed });
    const user = u.request("context7", [{ client: "cursor", scope: "user" }]);
    const p2 = await plannedOf(u, user);
    expect(p2.plan.approvalRequirements).toContain("user-scope-config");
    u.reset();
    const result = await runInstallTransaction(p2, await approveAll(p2), user, u.env);
    expect(result.verification).toEqual({ prepared: "launch-on-demand", configured: true, detected: true });
    expect(u.analyzeCalls.at(-1)).toBe(true);
    expect(await listing(u.homeDir)).toEqual([".cursor", ".cursor/mcp.json"]);
  });

  it("AC-034-04 재추천하면 그 toolId는 recommendations에서 빠지고 해당 need는 satisfied가 된다", async () => {
    const h = await createHarness(scratch, { entries: seed, packageJson: '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n' });
    const report = async () => recommend(await h.env.analyze(h.projectRoot, false), seed, undefined, { platform: "linux" });
    const before = await report();
    expect(before.recommendations.map((r) => r.toolId)).toContain("postgres-mcp");
    const capability = before.recommendations.find((r) => r.toolId === "postgres-mcp")!.primaryCapability;
    const request = h.request("postgres-mcp", [{ client: "claude-code", scope: "project" }]);
    const p = await plannedOf(h, request);
    expect((await runInstallTransaction(p, await approveAll(p), request, h.env)).status).toBe("succeeded");
    const after = await report();
    expect(after.recommendations.map((r) => r.toolId)).not.toContain("postgres-mcp");
    const need = after.needs.find((n) => n.capability === capability)!;
    expect(need.state).toBe("satisfied");
    expect(need.satisfiedBy).toContainEqual({ toolId: "postgres-mcp", serverName: "postgres", scope: "project" });
  });

  it("AC-034-05 확인 단계 전체에서 fetch 0회, spawn 0회, probe 0회다(MCP handshake 없음)", async () => {
    const fetchSpy = vi.fn(async () => new Response("{}"));
    vi.stubGlobal("fetch", fetchSpy);
    const h = await createHarness(scratch, { entries: seed });
    const request = h.request("github-mcp-server", [{ client: "codex", scope: "project" }]);
    const p = await plannedOf(h, request);
    const approval = await approveAll(p);
    h.reset();
    await runInstallTransaction(p, approval, request, h.env);
    const afterVerify = h.log.slice(h.log.indexOf("verify"));
    expect(afterVerify.length).toBeGreaterThan(1);
    expect(afterVerify.filter((e) => e === "spawn" || e === "probe-call" || e === "write")).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("AC-034-06 Configured 실패는 원본을 복구하고 Detected만 실패하면 configured-not-detected 경고만 남긴다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const file = path.join(h.projectRoot, ".mcp.json");
    const original = '{ "mcpServers": { "keep": { "command": "x", "args": [] } } }\n';
    await writeFile(file, original);
    const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const p = await plannedOf(h, request);
    const approval = await approveAll(p);
    let verifying = false;
    const tampered: ConfigFs = { ...h.env.configFs!, readFile: async (f) => (verifying && f.endsWith(".mcp.json") ? Buffer.from('{ "mcpServers": { "memory": { "command": "other", "args": [] } } }') : h.env.configFs!.readFile(f)) };
    const result = await runInstallTransaction(p, approval, request, { ...h.env, configFs: tampered, trace: (phase) => (verifying = phase === "verify") });
    expect(result).toMatchObject({ status: "partial-compensated", code: "CONFIGURED_MISMATCH", verification: { configured: false } });
    expect(result.configChanges[0]).toMatchObject({ applied: true, restored: true });
    expect(await readFile(file, "utf8")).toBe(original);

    const d = await createHarness(scratch, { entries: seed });
    const req2 = d.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const p2 = await plannedOf(d, req2);
    const approval2 = await approveAll(p2);
    let phase = "";
    const blind = { ...d.env, trace: (x: string) => (phase = x), analyze: async (root: string, host: boolean) => (phase === "verify" ? { ...(await d.env.analyze(root, host)), aiTools: [] } : d.env.analyze(root, host)) };
    const undetected = await runInstallTransaction(p2, approval2, req2, blind);
    expect(undetected).toMatchObject({ status: "succeeded", verification: { prepared: "launch-on-demand", configured: true, detected: false } });
    expect(undetected.warnings.map((w) => w.code)).toEqual(["configured-not-detected"]);
    expect(JSON.parse(await readFile(path.join(d.projectRoot, ".mcp.json"), "utf8")).mcpServers.memory.command).toBe("npx");
  });

  it("AC-034-07 nextActions는 env 준비·Claude 승인·Codex trusted·Cursor env·재시작을 안내하고 Installed·설치 완료라는 상태 이름이 없다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const request = h.request("postgres-mcp", [{ client: "claude-code", scope: "project" }, { client: "codex", scope: "project" }, { client: "cursor", scope: "project" }]);
    const p = await plannedOf(h, request);
    const result = await runInstallTransaction(p, await approveAll(p), request, h.env);
    const actions = result.nextActions.join("\n");
    expect(actions).toContain("DATABASE_URI");
    expect(actions).toContain("status: unchecked");
    expect(actions).toContain("OpenHub는 값이나 설정 여부를 확인하거나 저장하지 않습니다");
    expect(actions).toMatch(/Claude Code에서 프로젝트 \.mcp\.json의 postgres 서버 사용을 승인/u);
    expect(actions).toMatch(/trusted/u);
    expect(actions).toMatch(/Cursor를 실행하는 환경에 DATABASE_URI/u);
    expect(actions).toMatch(/다시 시작/u);
    expect(result.requiredEnv).toEqual([{ name: "DATABASE_URI", status: "unchecked" }]);
    const out = serializeInstallResult(result);
    expect(out).not.toMatch(/Installed|설치 완료/u);
  });
});
