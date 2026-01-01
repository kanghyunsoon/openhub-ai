import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import * as core from "../../src/index";
import {
  TOKEN_PATTERN,
  URL_CREDENTIAL_PATTERN,
  analyzeUpdateImpact,
  buildPinokioPlan,
  collectReleaseSnapshot,
  containsAbsolutePath,
  executePinokioPlan,
  executeVerifiedPlan,
  planLifecycle,
  readLifecycleState,
  recommend,
  recordInstallInState,
  runHealthCheck,
  runInstallTransaction,
  serializeInstallPlan,
  serializeLifecyclePlan,
  serializePinokioPlan,
  serializeRecommendationReport,
  serializeReleaseSnapshot,
  serializeReleaseSummary,
  serializeUpdateImpact,
  summarizeReleases,
  verifyApprovedLifecyclePlan,
  verifyApprovedPlan,
  verifyPinokioApproval,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "./harness";
import { REPO_ROOT, item, profile, seedEntries, tool } from "../recommendation/helpers";
import { newScratch } from "../lifecycle/helpers";
import { pinokioManifest } from "../pinokio/helpers";

/** TASK-058 M1 approvePlan 삭제와 전체 회귀(D-028). */
const seed = await seedEntries();
const scratch = await newScratch("legacy-removal-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const GOLDENS = path.join(REPO_ROOT, "packages/core/test/fixtures/m6/goldens");
const UPDATE = process.env["OPENHUB_UPDATE_GOLDEN"] === "1";
const NOW = () => new Date("2026-10-07T01:02:03.000Z");
const TOKEN = "ghp_" + "LegacyRemoval0000000000000000000000000";
const REMOVED = ["approvePlan", "assertApproved", "ApprovalMismatchError", "planDigest"];
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/^\s*\/\/.*$/gmu, "").replace(/\s\/\/.*$/gmu, "");
async function walk(dir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const name of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, name.name);
    if (name.isDirectory()) {
      if (!["node_modules", "dist", "fixtures"].includes(name.name)) out.push(...(await walk(p)));
    } else if (/\.(?:ts|js|mjs)$/u.test(name.name)) out.push(p);
  }
  return out;
}
async function golden(name: string, actual: string) {
  const file = path.join(GOLDENS, name);
  if (UPDATE) {
    await mkdir(GOLDENS, { recursive: true });
    await writeFile(file, actual);
  }
  if (!existsSync(file)) throw new Error("golden 없음: " + name + " — OPENHUB_UPDATE_GOLDEN=1로 생성하세요");
  expect(actual).toBe(await readFile(file, "utf8"));
}
const registryFetch = async (url: string) =>
  url === "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest" ? new Response(JSON.stringify({ name: "@modelcontextprotocol/server-memory", version: "1.2.3" }), { status: 200 }) : new Response("missing", { status: 404 });

/** memory-mcp를 설치하고 update LifecyclePlan을 만든 표본(골든·출력 검사 공용). */
async function sample() {
  const h = await createHarness(scratch, { entries: seed });
  const request = h.request("memory-mcp", [{ client: "claude-code", scope: "project" }]);
  const install = await plannedOf(h, request);
  const installBytes = serializeInstallPlan(install.plan);
  const result = await runInstallTransaction(install, await approveAll(install), request, h.env);
  expect(result.status).toBe("succeeded");
  expect(await recordInstallInState(install, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: NOW })).toMatchObject({ ok: true });
  const life = await planLifecycle({ operation: "update", toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false, fetch: registryFetch, ...(h.env.configFs === undefined ? {} : { fs: h.env.configFs }) });
  if (!life.ok) throw new Error(life.code);
  const read = await readLifecycleState({ homeDir: h.homeDir });
  if (!read.ok) throw new Error(read.code);
  const stateBytes = await readFile(path.join(h.homeDir, ".openhub", "state", "lifecycle.json"), "utf8");
  const projectKey = Object.values(read.state.entries)[0]!.target.projectKey!;
  return { h, install, installBytes, life: life.planned, stateBytes, state: Object.values(read.state.entries)[0]!, projectKey };
}

describe("REQ-004 M1 approvePlan 삭제와 전체 회귀", () => {
  it("AC-058-01 approvePlan·assertApproved·ApprovalMismatchError의 정의·export·소비처가 0개이고 Approval 타입·InstallerAdapter는 유지된다", async () => {
    for (const name of REMOVED) expect(Object.keys(core), name).not.toContain(name);
    const files = (await Promise.all(["packages/core/src", "packages/core/test", "apps/cli/src", "apps/cli/test", "apps/desktop/src", "apps/desktop/test", "apps/desktop/renderer"].map((d) => walk(path.join(REPO_ROOT, d))))).flat();
    expect(files.length).toBeGreaterThan(100);
    // 소비처 = import·호출·new·instanceof. "삭제됐다"를 검사하는 문자열·정규식 안의 이름은 소비가 아니다.
    const NAMES = "approvePlan|assertApproved|ApprovalMismatchError";
    const usage = new RegExp("import\\s*(?:type\\s*)?\\{[^}]*\\b(?:" + NAMES + ")\\b[^}]*\\}\\s*from|(?<![\\w|(])(?:approvePlan|assertApproved)\\s*\\(|new\\s+ApprovalMismatchError\\b|(?:instanceof|toBeInstanceOf\\()\\s*ApprovalMismatchError\\b|export\\s+(?:function|class|const)\\s+(?:" + NAMES + ")\\b", "u");
    const withoutStrings = (s: string) => s.replace(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/gu, '""');
    const offenders = files.filter((f) => !f.endsWith("legacy-removal.test.ts") && usage.test(withoutStrings(stripComments(readFileSync(f, "utf8")))));
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
    const adapter = readFileSync(path.join(REPO_ROOT, "packages/core/src/installer/adapter.ts"), "utf8");
    expect(adapter).toContain("export interface Approval {");
    expect(adapter).toContain("export interface InstallerAdapter {");
    expect(readFileSync(path.join(REPO_ROOT, "packages/core/src/installer/index.ts"), "utf8")).toContain('export * from "./adapter";');
    expect(typeof core.formatPlanPreview).toBe("function");
  });

  it("AC-058-02 Core가 발급하지 않은 승인 객체로 InstallPlan·LifecyclePlan·PinokioPlan gate를 통과할 수 없다", async () => {
    const s = await sample();
    const legacyShape = { planDigest: s.install.planDigest, approvedBy: "someone", approvedAt: NOW().toISOString() };
    const kernelShape = { planDigest: s.install.planDigest, acknowledgements: ["base", "floating-artifact"], channel: "cli-tty" };
    let regen = 0;
    const never = () => (regen++, Promise.reject(new Error("unused")));
    for (const forged of [legacyShape, kernelShape]) {
      expect(await verifyApprovedPlan(forged as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
      expect(await verifyApprovedLifecyclePlan({ ...forged, planDigest: s.life.planDigest } as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
      expect(await verifyPinokioApproval(forged as never, never)).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    }
    expect(regen).toBe(0);
    // 직접 만든 VerifiedPlan 모양 객체도 실행 함수가 거부한다(spawn·write 0).
    const fakeVerified = (plan: unknown, planDigest: string) => ({ plan, planDigest, acknowledgements: ["base"], channel: "cli-tty" });
    expect(await executeVerifiedPlan(fakeVerified(s.install.plan, s.install.planDigest) as never, { projectRoot: s.h.projectRoot })).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    expect(await runHealthCheck(fakeVerified(s.life.plan, s.life.planDigest) as never, { healthCheckType: "mcp-handshake", tempBase: scratch })).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
    const pinokio = buildPinokioPlan({ operation: "install", manifest: pinokioManifest() }, { versions: { pterm: "0.0.25", pinokiod: "4.0.3", script: "4.0" }, appState: { exists: false, digest: "sha256:" + "0".repeat(64) }, installed: null });
    if (!pinokio.ok) throw new Error(pinokio.code);
    expect(await executePinokioPlan(fakeVerified(pinokio.planned.plan, pinokio.planned.planDigest) as never, { entry: { node: "node", indexJs: "index.js", version: "0.0.25" } as never, homeDir: s.h.homeDir })).toMatchObject({ ok: false, code: "APPROVAL_REQUIRED" });
  });

  it("AC-058-03 갱신한 3개 테스트(M1 AC-005-03·M4 AC-028-09·M5 AC-040-09)가 직접 만든 승인 객체 검증으로 바뀌어 있다", async () => {
    const read = (rel: string) => readFileSync(path.join(REPO_ROOT, "packages/core/test", rel), "utf8");
    expect(read("installer.test.ts")).toContain("AC-005-03 승인한 계획과 다른 계획으로는 실행되지 않는다 (CON-006) — 직접 만든 Approval은 gate를 통과하지 못한다");
    expect(read("installer/approval-v1.test.ts")).toContain("Core가 발급하지 않은(직접 만든) 승인 객체로는 M4 실행 게이트를 통과할 수 없다");
    expect(read("lifecycle/plan.test.ts")).toContain("AC-040-09 Core가 발급하지 않은 승인 객체로는 lifecycle gate를 통과할 수 없고 M1 approvePlan은 삭제됐다");
  });

  it("AC-058-04 InstallPlan v1·LifecyclePlan v1·LifecycleStateFile v1 골든 byte가 바뀌지 않는다", async () => {
    const s = await sample();
    const norm = (text: string) => text.split(s.projectKey).join("<projectKey>");
    await golden("install-plan-memory.json", s.installBytes);
    const lifeDoc = JSON.parse(serializeLifecyclePlan(s.life.plan)) as { source: { stateDigest: string } };
    lifeDoc.source.stateDigest = "<stateDigest: Version State 파일 byte의 sha256, projectKey에 따라 다름>";
    await golden("lifecycle-plan-memory.json", norm(JSON.stringify(lifeDoc, null, 2) + "\n"));
    await golden("lifecycle-state-memory.json", norm(s.stateBytes));
    // 같은 입력이면 다시 만들어도 byte가 같다.
    const again = await sample();
    expect(again.installBytes).toBe(s.installBytes);
  });

  it("AC-058-05 전체 결과·출력 표본에서 secret·token·API key·절대 경로가 0건이다", async () => {
    const s = await sample();
    const releaseFetch = async (url: string) =>
      url.endsWith("server-memory/latest")
        ? new Response(JSON.stringify({ name: "@modelcontextprotocol/server-memory", version: "1.2.3" }), { status: 200 })
        : url.startsWith("https://api.github.com/repos/modelcontextprotocol/servers/releases")
          ? new Response(JSON.stringify([{ tag_name: "1.2.3", name: "1.2.3", body: "- fixed " + TOKEN.slice(0, 6), draft: false, prerelease: false, published_at: "2026-09-01T00:00:00Z", html_url: "https://github.com/modelcontextprotocol/servers/releases/tag/1.2.3" }]), { status: 200 })
          : new Response("missing", { status: 404 });
    const snap = await collectReleaseSnapshot({ toolId: "memory-mcp", versionSource: "npm", backend: "npx", requested: "@modelcontextprotocol/server-memory", resolved: null, github: "modelcontextprotocol/servers" }, { fetch: releaseFetch, now: NOW, githubToken: TOKEN });
    if (!snap.ok) throw new Error(snap.code);
    const impact = analyzeUpdateImpact({ state: s.state, configEnvNames: [], manifest: seed.find((e) => e.manifest.name === "memory-mcp")!.manifest, snapshot: snap.snapshot, runtimes: { node: "22.11.0" } });
    const report = recommend(profile({ languages: [item("typescript", "TypeScript")], aiTools: [tool("memory")] }), seed, undefined, { platform: "linux" });
    const pinokio = buildPinokioPlan({ operation: "install", manifest: pinokioManifest() }, { versions: { pterm: "0.0.25", pinokiod: "4.0.3", script: "4.0" }, appState: { exists: false, digest: "sha256:" + "0".repeat(64) }, installed: null });
    if (!pinokio.ok) throw new Error(pinokio.code);
    const outputs = [s.installBytes, serializeLifecyclePlan(s.life.plan), s.stateBytes, serializeReleaseSnapshot(snap.snapshot), serializeReleaseSummary(summarizeReleases(snap.snapshot)), serializeUpdateImpact(impact), serializeRecommendationReport(report)];
    for (const out of outputs) {
      expect(out).not.toContain(TOKEN);
      expect(TOKEN_PATTERN.test(out)).toBe(false);
      expect(URL_CREDENTIAL_PATTERN.test(out)).toBe(false);
      expect(containsAbsolutePath(out)).toBe(false);
      for (const p of [s.h.base, s.h.homeDir, s.h.projectRoot, scratch]) expect(out).not.toContain(p);
    }
    // PinokioPlan 생성 script에는 Pinokio on.event 정규식 문자열("/…/")이 있어 실제 경로 문자열 포함 여부로 본다(TASK-052 전용 검사).
    const pin = serializePinokioPlan(pinokio.planned.plan);
    expect(pin).not.toContain(scratch);
    expect(TOKEN_PATTERN.test(pin) || URL_CREDENTIAL_PATTERN.test(pin)).toBe(false);
  });

  it("AC-058-06 product·spec·README의 approvePlan 언급을 갱신한다", () => {
    const read = (rel: string) => readFileSync(path.join(REPO_ROOT, rel), "utf8");
    expect(read("README.md")).not.toMatch(/approvePlan/u);
    // 명세 문서 검사는 test/internal-truth.internal.test.ts로 옮겼다(TASK-074, public export 제외).
  });
});

