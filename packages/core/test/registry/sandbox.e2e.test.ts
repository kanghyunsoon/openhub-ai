import os from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createTreeKiller, healthArgv, locateWindowsNpxLauncher, planLifecycle, recordInstallInState, requestLifecycleApproval, runHealthCheck, runInstallTransaction, verifyApprovedLifecyclePlan, type HealthStep } from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * 검증 전용 최소 MCP stdio client. initialize → tools/list → (선택) tools/call 하나를 보내고 전체 stdout을 돌려준다.
 * Health와 같은 argv(shell 없음)·process tree 종료를 쓴다. 제품 코드가 아니며 OPENHUB_E2E 테스트에서만 쓴다.
 */
async function mcpSession(argv: string[], cwd: string, call?: { name: string; arguments: Record<string, unknown> }): Promise<{ tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[]; callResult: { error?: { message: string }; result?: unknown } | null; transcript: string }> {
  const windows = process.platform === "win32";
  const child = spawn(argv[0]!, argv.slice(1), { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: !windows });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  let buffer = "";
  let transcript = "";
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.on("data", (d: Buffer) => {
    transcript += d.toString();
    buffer += d.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line === "") continue;
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (typeof m["id"] === "number") waiters.get(m["id"])?.(m);
      } catch {
        // 로그 줄은 무시한다.
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => (transcript += d.toString()));
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const n = ++id;
      const timer = setTimeout(() => reject(new Error("timeout " + method)), 60_000);
      waiters.set(n, (m) => (clearTimeout(timer), resolve(m)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n");
    });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openhub-e2e", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const list = (await request("tools/list", {}))["result"] as { tools: { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } }[] };
    const callResult = call === undefined ? null : ((await request("tools/call", call)) as { error?: { message: string }; result?: unknown });
    return { tools: list.tools, callResult, transcript };
  } finally {
    // npx → 실제 서버(손자 process)까지 끝낸다. 남으면 임시 디렉터리를 잡고 있게 된다.
    if (child.pid !== undefined) await createTreeKiller({ cwd: os.tmpdir() })(child.pid, windows ? "windows" : "linux");
    await closed;
  }
}

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
   * 실제 클러스터·자격증명은 쓰지 않는다. 접속할 수 없는 주소와 가짜 token을 가진 합성 kubeconfig만 쓴다
   * (서버는 시작할 때 클러스터에 접속하지 않는다). Health는 OS 환경을 상속하므로 이 테스트만 KUBECONFIG를 합성 파일로 바꿨다가 되돌린다.
   * 이어서 같은 argv로 tools/list를 받아 노출 도구가 모두 readOnlyHint이고 destructive·configuration_view가 없는지,
   * configuration_view 호출이 거부되고 가짜 token이 어디에도 나오지 않는지 확인한다.
   */
  const platform = process.platform === "win32" ? "windows" : "linux";
  const FAKE_TOKEN = ["openhub", "e2e", "fake", "token", "0123456789abcdef"].join("-");
  const cases = [
    { toolId: "kubernetes-mcp-server", clients: ["claude-code", "cursor", "codex"] as const, flags: ["--read-only", "--toolsets core"] },
  ];
  for (const c of cases) {
    it("P0-2 batch 1 sandbox: " + c.toolId + "를 설치 계획대로 적고 실제 npx로 Health handshake를 통과한다", async () => {
      const seed = await seedEntries();
      const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-sandbox-"));
      const kubeconfig = path.join(scratch, "synthetic-kubeconfig.yaml");
      await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster: { server: 'https://127.0.0.1:1' }\ncontexts:\n- name: fake\n  context: { cluster: fake, user: fake }\ncurrent-context: fake\nusers:\n- name: fake\n  user: { token: " + FAKE_TOKEN + " }\n");
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
          for (const flag of c.flags.flatMap((f) => f.split(" "))) expect(written, file).toContain(flag);
          expect(written, file).not.toMatch(/127\.0\.0\.1|synthetic-kubeconfig/u);
          expect(written, file).not.toContain(FAKE_TOKEN);
        }
        expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true });
        const regen = () => planLifecycle({ operation: "health", toolId: c.toolId, projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform, includeUser: false });
        const first = await regen();
        if (!first.ok) throw new Error(first.code);
        const outcome = await requestLifecycleApproval(first.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
        if (outcome.status !== "approved") throw new Error(outcome.status);
        const gate = await verifyApprovedLifecyclePlan(outcome.approval, regen);
        if (!gate.ok) throw new Error(gate.code);
        const step = gate.verified.plan.steps.find((s): s is HealthStep => s.kind === "health")!;
        // Windows npx는 cmd를 거치지 않고 node.exe + npx-cli.js로 실행한다(D-016). 경로는 probe 단계처럼 PATH에서 찾는다.
        const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
        const health = await runHealthCheck(gate.verified, { healthCheckType: "mcp-handshake", tempBase: os.tmpdir(), windowsNpx });
        expect(health).toMatchObject({ ok: true, result: { status: "healthy" } });
        if (health.ok) console.log(c.toolId + " health: " + JSON.stringify({ status: health.result.status, toolCount: health.result.toolCount, environmentUnverified: health.result.environmentUnverified }));

        const argv = healthArgv(step, platform, windowsNpx);
        if (argv === null) throw new Error("launcher-not-found");
        const session = await mcpSession(argv, scratch, { name: "configuration_view", arguments: { minified: false } });
        const names = session.tools.map((t) => t.name).sort();
        console.log(c.toolId + " tools: " + names.join(","));
        expect(names.length).toBeGreaterThan(0);
        for (const t of session.tools) {
          expect(t.annotations?.readOnlyHint, t.name).toBe(true);
          expect(t.annotations?.destructiveHint ?? false, t.name).toBe(false);
        }
        for (const banned of ["configuration_view", "pods_delete", "pods_exec", "pods_run", "resources_create_or_update", "resources_delete", "resources_scale"]) expect(names).not.toContain(banned);
        expect(session.callResult?.error?.message ?? "").toMatch(/unknown tool/u);
        expect(session.transcript).not.toContain(FAKE_TOKEN);
      } finally {
        if (previous === undefined) delete process.env["KUBECONFIG"];
        else process.env["KUBECONFIG"] = previous;
        await rm(scratch, { recursive: true, force: true });
      }
    }, 600_000);
  }
});

