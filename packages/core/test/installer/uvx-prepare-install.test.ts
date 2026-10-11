import { EventEmitter } from "node:events";
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  HEALTH_TIMEOUTS,
  fastManifestIssues,
  formatInstallPlanPreview,
  installPlanSchema,
  planInstall,
  requestApproval,
  runInstallTransaction,
  uvxPrepareArgs,
  uvxVerifyArgs,
  type ExecChild,
  type ExecSpawner,
  type RegistryEntry,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";
import { approveAll, createHarness, plannedOf } from "./harness";

/**
 * v0.2.1 uvx Prepare — 설치 경로(docs/specs/uvx-prepare.md D1–D9). 실제 Registry Manifest는 바꾸지 않고 합성 Manifest로 확인한다
 * (Registry 고정은 #39). 가짜 spawner만 쓴다(network·실제 uv 0).
 */
const seed = await seedEntries();
const scratch = await newScratch("uvx-prepare-install-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const PIN = "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted";
const TARGET = { from: "postgres-mcp==0.3.0", withPins: ["mcp==1.30.0"] };
const withPostgres = (options: Record<string, unknown>): RegistryEntry[] =>
  seed.map((e) => (e.manifest.name === "postgres-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options } } } : e));
const manifestOf = (entries: RegistryEntry[]) => entries.find((e) => e.manifest.name === "postgres-mcp")!.manifest;
const pinned = withPostgres({ command: PIN });
const SOURCE_BUILD = { build: "source-build-reviewed", sourceBuild: [{ package: "proxy-tools", version: "0.1.0", source: "pypi-sdist" }] };
const sourceBuild = withPostgres({ command: PIN, prepare: SOURCE_BUILD });
const CURSOR = [{ client: "cursor" as const, scope: "project" as const }];

/** uvx 호출을 code로 닫는 spawner(그 밖은 성공). */
function uvxSpawner(spawns: string[][], codes: number[], stderr = ""): ExecSpawner {
  let n = 0;
  return (executable, args) => {
    spawns.push([executable, ...args]);
    const code = executable === "uvx" ? (codes[n++] ?? 0) : 0;
    const events = new EventEmitter();
    const err = new EventEmitter();
    queueMicrotask(() => {
      if (code !== 0 && stderr !== "") err.emit("data", Buffer.from(stderr));
      events.emit("close", code, null);
    });
    return { pid: 7000 + n, stdout: null, stderr: err, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as unknown as ExecChild;
  };
}

describe("uvx Prepare: 설치 계획", () => {
  it("정확한 버전 uvx는 준비 단계가 설정 쓰기 앞에 오고(wheel만) floating·source-build 승인이 없으며 Preview가 설명한다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const planned = await plannedOf(h, h.request("postgres-mcp", CURSOR));
    const { plan } = planned;
    expect(plan.artifact).toEqual({ kind: "python-package", spec: "postgres-mcp==0.3.0", pinned: true, preparation: "uv-cache" });
    expect(plan.steps.map((s) => s.id)).toEqual(["uvx-prepare", "config-cursor-project"]);
    expect(plan.steps[0]).toEqual({ id: "uvx-prepare", kind: "run", executable: "uvx", args: uvxPrepareArgs(TARGET, "wheels-only"), cwd: "isolated", network: true, timeoutMs: 600_000 });
    expect(plan.approvalRequirements).not.toContain("floating-artifact");
    expect(plan.approvalRequirements).not.toContain("source-build");
    expect(plan.warnings.map((w) => w.code)).toContain("uvx-prepare");
    expect(formatInstallPlanPreview(planned).join("\n")).toContain("uv cache에 설치하고 네트워크 없이 다시 확인합니다");
    // Health 시작 한도는 그대로 20 s다(Prepare가 시간을 옮길 뿐 늘리지 않는다).
    expect(HEALTH_TIMEOUTS.startupMs).toBe(20_000);
  });

  it("고정되지 않은 uvx(현재 Registry), --with가 떠 있는 경우, 다른 uv 플래그가 앞에 있는 경우는 준비하지 않는다", async () => {
    for (const [entries, pinnedExpected] of [
      [seed, false],
      [withPostgres({ command: "uvx --from postgres-mcp==0.3.0 --with mcp postgres-mcp" }), false],
      [withPostgres({ command: "uvx --python 3.12 --from postgres-mcp==0.3.0 postgres-mcp" }), false],
    ] as const) {
      const h = await createHarness(scratch, { entries });
      const { plan } = await plannedOf(h, h.request("postgres-mcp", CURSOR));
      expect(plan.artifact).toMatchObject({ pinned: pinnedExpected, preparation: "launch-on-demand" });
      expect(plan.steps.some((s) => s.kind === "run")).toBe(false);
      expect(plan.approvalRequirements).toContain("floating-artifact");
    }
  });

  it("검토된 소스 빌드 Manifest는 --no-build 없이 준비하고 source-build 승인과 제3자 코드 고지가 붙는다", async () => {
    const h = await createHarness(scratch, { entries: sourceBuild });
    const { plan } = await plannedOf(h, h.request("postgres-mcp", CURSOR));
    expect(plan.steps[0]).toMatchObject({ id: "uvx-prepare", args: uvxPrepareArgs(TARGET, "source-build-reviewed") });
    expect(plan.approvalRequirements).toContain("source-build");
    expect(plan.warnings.map((w) => w.code)).toEqual(expect.arrayContaining(["uvx-prepare", "uvx-source-build"]));
  });

  it("검토되지 않은 빌드 정책은 Manifest 단계에서 거부한다(계획 0, Registry 검사 실패)", async () => {
    const bad: Record<string, unknown>[] = [
      { command: PIN, prepare: { build: "source-build-reviewed" } },
      { command: PIN, prepare: { build: "source-build-reviewed", sourceBuild: [] } },
      { command: PIN, prepare: { build: "wheels-only", sourceBuild: SOURCE_BUILD.sourceBuild } },
      { command: PIN, prepare: { build: "anything" } },
      { command: PIN, prepare: { build: "source-build-reviewed", sourceBuild: [{ package: "proxy-tools", version: "0.1", source: "pypi-sdist" }] } },
      { command: PIN, prepare: { build: "source-build-reviewed", sourceBuild: [{ package: "proxy-tools", version: "0.1.0", source: "https://example.invalid/x.tar.gz" }] } },
      { command: PIN, prepare: { build: "wheels-only", extra: true } },
      { command: "uvx postgres-mcp --access-mode=restricted", prepare: SOURCE_BUILD },
    ];
    for (const options of bad) {
      const entries = withPostgres(options);
      const h = await createHarness(scratch, { entries });
      const built = await planInstall(h.request("postgres-mcp", CURSOR), h.env);
      expect(built.result, JSON.stringify(options)).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
      expect(fastManifestIssues(manifestOf(entries)).length, JSON.stringify(options)).toBeGreaterThan(0);
    }
    expect(fastManifestIssues(manifestOf(pinned))).toEqual([]);
    expect(fastManifestIssues(manifestOf(sourceBuild))).toEqual([]);
  });

  it("InstallPlan schema는 launch 대상과 다른 준비 단계·index 인자·승인 없는 소스 빌드를 거부한다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const { plan } = await plannedOf(h, h.request("postgres-mcp", CURSOR));
    expect(installPlanSchema.safeParse(plan).success).toBe(true);
    const withArgs = (args: string[]) => ({ ...plan, steps: plan.steps.map((s) => (s.kind === "run" ? { ...s, args } : s)) });
    expect(installPlanSchema.safeParse(withArgs(uvxPrepareArgs({ from: "postgres-mcp==0.3.1", withPins: ["mcp==1.30.0"] }, "wheels-only"))).success).toBe(false);
    expect(installPlanSchema.safeParse(withArgs(uvxPrepareArgs({ from: "postgres-mcp==0.3.0", withPins: ["mcp==1.31.0"] }, "wheels-only"))).success).toBe(false);
    expect(installPlanSchema.safeParse(withArgs(uvxPrepareArgs({ from: "postgres-mcp==0.3.0", withPins: [] }, "wheels-only"))).success).toBe(false);
    expect(installPlanSchema.safeParse(withArgs(["--no-build", "--index-url", "https://example.invalid/simple", ...uvxPrepareArgs(TARGET, "wheels-only").slice(1)])).success).toBe(false);
    expect(installPlanSchema.safeParse(withArgs(uvxPrepareArgs(TARGET, "source-build-reviewed"))).success).toBe(false); // source-build 승인 없음
    expect(installPlanSchema.safeParse({ ...plan, steps: plan.steps.map((s) => (s.kind === "run" ? { ...s, timeoutMs: 3_600_000 } : s)) }).success).toBe(false);
  });
});

describe("uvx Prepare: 설치 실행", () => {
  it("성공하면 준비 → 네트워크 없는 확인 → 설정 쓰기 순서이고 Prepared는 cached다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const request = h.request("postgres-mcp", CURSOR);
    const planned = await plannedOf(h, request);
    h.reset();
    const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(result.status).toBe("succeeded");
    expect(result.verification?.prepared).toBe("cached");
    expect(h.spawns).toEqual([["uvx", ...uvxPrepareArgs(TARGET, "wheels-only")], ["uvx", ...uvxVerifyArgs(TARGET, "wheels-only")]]);
    expect(h.log.indexOf("spawn")).toBeLessThan(h.log.indexOf("write"));
    const config = JSON.parse(await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8"));
    expect(config.mcpServers.postgres).toMatchObject({ command: "uvx", args: ["--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"] });
  });

  it("준비가 실패하면(wheel 없음) 설정 파일을 바꾸지 않고 소스 빌드로 재시도하지 않는다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const existing = '{\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
    await mkdir(path.join(h.projectRoot, ".cursor"), { recursive: true });
    await writeFile(path.join(h.projectRoot, ".cursor", "mcp.json"), existing);
    const request = h.request("postgres-mcp", CURSOR);
    const planned = await plannedOf(h, request);
    const spawns: string[][] = [];
    const result = await runInstallTransaction(planned, await approveAll(planned), request, { ...h.env, spawner: uvxSpawner(spawns, [2], "error: Wheels are required for `proxy-tools` because building from source is disabled") });
    expect(result).toMatchObject({ status: "failed", code: "UVX_WHEEL_UNAVAILABLE", verification: { prepared: "failed", configured: false } });
    expect(spawns).toEqual([["uvx", ...uvxPrepareArgs(TARGET, "wheels-only")]]);
    expect(await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8")).toBe(existing);
    expect(existsSync(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"))).toBe(false);
  });

  it("확인(offline)이 실패해도 설정 파일을 바꾸지 않는다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const request = h.request("postgres-mcp", CURSOR);
    const planned = await plannedOf(h, request);
    const spawns: string[][] = [];
    const result = await runInstallTransaction(planned, await approveAll(planned), request, { ...h.env, spawner: uvxSpawner(spawns, [0, 2]) });
    expect(result).toMatchObject({ status: "failed", code: "UVX_PREPARE_VERIFY_FAILED" });
    expect(existsSync(path.join(h.projectRoot, ".cursor", "mcp.json"))).toBe(false);
  });

  it("source-build를 확인하지 않은 승인은 실행 게이트에서 막힌다(APPROVAL_INCOMPLETE, 빌드 0회, 쓰기 0)", async () => {
    const h = await createHarness(scratch, { entries: sourceBuild });
    const request = h.request("postgres-mcp", CURSOR);
    const planned = await plannedOf(h, request);
    const outcome = await requestApproval(planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id).filter((id) => id !== "source-build") });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    expect(outcome.approval.acknowledgements).not.toContain("source-build");
    h.reset();
    const result = await runInstallTransaction(planned, outcome.approval, request, h.env);
    expect(result).toMatchObject({ status: "approval-required", code: "APPROVAL_INCOMPLETE" });
    expect(h.spawns).toEqual([]);
    expect(existsSync(path.join(h.projectRoot, ".cursor", "mcp.json"))).toBe(false);
    // 사람이 거절하면(rejected) 승인이 없다.
    expect(await requestApproval(planned, { channel: "cli-tty", confirm: async () => "rejected" })).toEqual({ status: "rejected" });
  });

  it("승인 뒤 Manifest 버전이 바뀌면 PLAN_STALE이고 준비·쓰기 0이다", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const request = h.request("postgres-mcp", CURSOR);
    const planned = await plannedOf(h, request);
    const approval = await approveAll(planned);
    const changed = withPostgres({ command: PIN.replace("postgres-mcp==0.3.0", "postgres-mcp==0.3.1") });
    h.reset();
    const result = await runInstallTransaction(planned, approval, request, { ...h.env, loadEntries: async () => changed });
    expect(result).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(h.spawns).toEqual([]);
    expect(existsSync(path.join(h.projectRoot, ".cursor", "mcp.json"))).toBe(false);
  });

  it("사용자 지정 index는 계정 없이 fingerprint로 계획에 들어가고, 승인 뒤 index가 바뀌면 PLAN_STALE이다(비밀번호만 바뀌면 그대로)", async () => {
    const h = await createHarness(scratch, { entries: pinned });
    const request = h.request("postgres-mcp", CURSOR);
    let indexEnv: Record<string, string> = { UV_INDEX_URL: "https://ci-user:Index-Pass-1@idx.example/simple" };
    const env = { ...h.env, uvChildEnv: () => indexEnv };
    const built = await planInstall(request, env);
    if (!built.result.ok) throw new Error(built.result.code);
    const planned = built.result.planned;
    const step = planned.plan.steps[0]!;
    expect(step).toMatchObject({ kind: "run", executable: "uvx", index: { custom: true } });
    expect(planned.plan.warnings.map((w) => w.code)).toContain("uvx-custom-index");
    const json = JSON.stringify(planned.plan);
    expect(json).not.toContain("Index-Pass-1");
    expect(json).not.toContain("idx.example");
    expect(json).not.toContain("ci-user");
    const approval = await approveAll(planned);
    indexEnv = { UV_INDEX_URL: "https://other.example/simple" };
    h.reset();
    expect(await runInstallTransaction(planned, approval, request, env)).toMatchObject({ status: "stale", code: "PLAN_STALE" });
    expect(h.spawns).toEqual([]);
    // 같은 index에서 비밀번호만 바뀌면 같은 계획이다.
    indexEnv = { UV_INDEX_URL: "https://ci-user:Index-Pass-1@idx.example/simple" };
    const again = await planInstall(request, env);
    if (!again.result.ok) throw new Error(again.result.code);
    const approval2 = await approveAll(again.result.planned);
    indexEnv = { UV_INDEX_URL: "https://ci-user:Index-Pass-2@idx.example/simple" };
    expect((await runInstallTransaction(again.result.planned, approval2, request, env)).status).toBe("succeeded");
  });
});
