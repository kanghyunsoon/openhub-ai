import { mkdtemp, readdir, readFile, realpath, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  APPROVAL_REQUIREMENTS,
  CAPABILITIES,
  LIFECYCLE_APPROVAL_REQUIREMENTS,
  REASON_CODES,
  REVIEWED_TOOL_CONFIGS,
  loadRegistry,
  projectKeyFromRealpath,
  recordInstallInState,
  runInstallTransaction,
  toolConfigLocation,
  type HealthRunReport,
} from "@openhub/core";
import { CAPABILITY_EN, EN_WARNING_CODES, INSTALL_APPROVAL_EN, LIFECYCLE_APPROVAL_EN, REASON_EN, installPreviewEn } from "../src/i18n/core-en";
import { en } from "../src/i18n/en";
import { getDesktopLocale, resolveLocale, setDesktopLocale, translate } from "../src/i18n/index";
import { ko } from "../src/i18n/ko";
import { PREFERENCES_FILE, readStoredLanguage, writeStoredLanguage } from "../src/i18n/preferences";
import type { NativeDialogLike } from "../src/install";
import { LIFECYCLE_PLAN_CHANNELS, LIFECYCLE_RUN_CHANNEL, LIFECYCLE_STATUS_CHANNEL, LifecycleSession, projectChangedMessage, registerLifecycle, type LifecyclePlanResponse, type LifecycleRunResponse, type LifecycleStatusResponse } from "../src/lifecycle";
import { buildForYouView } from "../src/for-you-view";
import { approveAll, createHarness, plannedOf } from "../../../packages/core/test/installer/harness";
import { fakeNpmSpawner } from "../../../packages/core/test/process/fake-npm";

/**
 * v0.2.0 P0-3 PR B Desktop 다국어. 언어 결정·저장, 카탈로그 무결성, Core code 커버리지, 실제 Plan·IPC 결과의 English 표시를 검증한다.
 * English 결과에 한글이 0자인지 본다(Registry 작성 데이터·사용자 데이터는 대상이 아니다).
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const REGISTRY = path.join(ROOT, "registry");
const { entries } = await loadRegistry(REGISTRY);
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-i18n-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const HANGUL = /[\uac00-\ud7a3]/u;
const placeholders = (s: string) => [...s.matchAll(/\{([A-Za-z0-9_]+)\}/gu)].map((m) => m[1]).sort();
beforeEach(() => setDesktopLocale("en"));

describe("v0.2.0 PR B 언어 결정·저장", () => {
  it("저장값이 OS 언어보다 우선하고, 저장값이 없으면 OS 언어가 ko 계열일 때만 한국어, 그 밖에는 English다", () => {
    expect(resolveLocale({ stored: null, system: [] })).toBe("en");
    expect(resolveLocale({ stored: null, system: ["en-US"] })).toBe("en");
    for (const tag of ["ko", "ko-KR", "ko_KR", "KO-kr"]) expect(resolveLocale({ stored: null, system: [tag] }), tag).toBe("ko");
    expect(resolveLocale({ stored: null, system: ["en-US", "ko-KR"] })).toBe("en");
    expect(resolveLocale({ stored: null, system: ["kok-IN"] })).toBe("en");
    expect(resolveLocale({ stored: "en", system: ["ko-KR"] })).toBe("en");
    expect(resolveLocale({ stored: "ko", system: ["en-US"] })).toBe("ko");
    expect(resolveLocale({ stored: "fr", system: ["ko-KR"] })).toBe("ko");
    expect(resolveLocale({ stored: { language: "ko" }, system: ["en-US"] })).toBe("en");
  });

  it("언어 저장은 다른 설정 key를 보존하고 원자적으로 쓰며, 깨진 파일은 덮어쓰지 않는다", async () => {
    const dir = await mkdtemp(path.join(scratch, "prefs-"));
    expect(await readStoredLanguage(dir)).toBeNull();
    expect(await writeStoredLanguage(dir, "ko")).toEqual({ ok: true });
    expect(await readStoredLanguage(dir)).toBe("ko");
    await writeFile(path.join(dir, PREFERENCES_FILE), JSON.stringify({ language: "ko", windowBounds: { w: 1120 } }));
    expect(await writeStoredLanguage(dir, "en")).toEqual({ ok: true });
    expect(JSON.parse(await readFile(path.join(dir, PREFERENCES_FILE), "utf8"))).toEqual({ language: "en", windowBounds: { w: 1120 } });
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    await writeFile(path.join(dir, PREFERENCES_FILE), "{ broken");
    expect(await readStoredLanguage(dir)).toBeNull();
    expect(await writeStoredLanguage(dir, "ko")).toEqual({ ok: false, reason: "preferences-unreadable" });
    expect(await readFile(path.join(dir, PREFERENCES_FILE), "utf8")).toBe("{ broken");
    await writeFile(path.join(dir, PREFERENCES_FILE), JSON.stringify({ language: "de" }));
    expect(await readStoredLanguage(dir)).toBeNull();
  });
});

describe("v0.2.0 PR B 카탈로그", () => {
  it("en·ko key 집합이 같고 key마다 placeholder가 같으며 값이 비어 있지 않고 HTML이 없다", () => {
    expect(Object.keys(ko).sort()).toEqual(Object.keys(en).sort());
    for (const key of Object.keys(en) as (keyof typeof en)[]) {
      expect(placeholders(ko[key]), key).toEqual(placeholders(en[key]));
      expect(en[key].trim(), key).not.toBe("");
      expect(ko[key].trim(), key).not.toBe("");
      for (const v of [en[key], ko[key]]) expect(v, key).not.toMatch(/<\s*[a-z!/]/iu);
      expect(en[key], key).not.toMatch(HANGUL);
    }
  });

  it("보간 값은 텍스트로만 들어가고(HTML 해석 없음) 없는 placeholder는 그대로 남는다", () => {
    expect(translate("en", "project.error", { message: "<img src=x onerror=alert(1)>" })).toBe("Cannot analyze: <img src=x onerror=alert(1)>");
    expect(translate("en", "project.error")).toBe("Cannot analyze: {message}");
    expect(translate("ko", "forYou.count", { scope: "프로젝트 범위", count: 3 })).toBe("프로젝트 범위 · 추천 3개");
    expect(translate("en", "no.such.key")).toBe("no.such.key");
  });

  it("renderer·main 코드가 쓰는 key는 모두 카탈로그에 있다(정적 key, data-i18n, 조합 key)", async () => {
    const files = [
      ...(await readdir(path.join(ROOT, "apps/desktop/renderer"))).filter((f) => f.endsWith(".js") || f.endsWith(".html")).map((f) => path.join(ROOT, "apps/desktop/renderer", f)),
      ...(await readdir(path.join(ROOT, "apps/desktop/src"), { recursive: true })).filter((f) => f.endsWith(".ts")).map((f) => path.join(ROOT, "apps/desktop/src", f)),
    ];
    const used = new Set<string>();
    for (const f of files) {
      const text = await readFile(f, "utf8");
      for (const m of text.matchAll(/\b(?:t|tr)\("([a-zA-Z0-9_.]+)"/gu)) used.add(m[1]!);
      for (const m of text.matchAll(/data-i18n(?:-aria)?="([^"]+)"/gu)) used.add(m[1]!);
      for (const m of text.matchAll(/"((?:life|dialog|lifecycle|install|scope|guide|outcome)\.[A-Za-z0-9_.]+)"/gu)) if (!/\.(?:js|ts|html|css)$/u.test(m[1]!)) used.add(m[1]!);
    }
    // "onboarding.step" + n + ".title" 같은 조합 key의 접두어는 key가 아니다(아래에서 완성 key를 넣는다).
    used.delete("onboarding.step");
    for (let n = 1; n <= 7; n++) used.add("onboarding.step" + n + ".title").add("onboarding.step" + n + ".body");
    const missing = [...used].filter((k) => !(k in en));
    expect(missing).toEqual([]);
    expect(used.size).toBeGreaterThan(250);
  });
});

describe("v0.2.0 PR B Core code 커버리지(English)", () => {
  it("모든 설치·lifecycle 승인 요구 ID, 추천 이유 code, capability ID에 영어 문장이 있다", () => {
    for (const id of APPROVAL_REQUIREMENTS) expect(INSTALL_APPROVAL_EN[id], id).toBeTruthy();
    for (const id of LIFECYCLE_APPROVAL_REQUIREMENTS) expect(LIFECYCLE_APPROVAL_EN[id], id).toBeTruthy();
    for (const code of REASON_CODES) expect(REASON_EN[code], code).toBeTruthy();
    for (const c of CAPABILITIES) expect(CAPABILITY_EN[c.id], c.id).toBeTruthy();
  });

  it("검토된 tool config의 영어 고지(noticeEn)는 표시 전용이다: 모든 정책에 있고, Plan warning은 기존 한국어 고지 그대로다", async () => {
    for (const [id, reviewed] of Object.entries(REVIEWED_TOOL_CONFIGS)) {
      expect(reviewed.noticeEn.trim(), id).not.toBe("");
      expect(reviewed.noticeEn, id).not.toMatch(HANGUL);
    }
    const c = await k8sDesktop();
    const reviewed = REVIEWED_TOOL_CONFIGS[c.planned.plan.toolId]!;
    // Core Plan(따라서 Plan digest·CLI·golden)은 noticeEn을 쓰지 않는다.
    expect(c.planned.plan.warnings.find((w) => w.code === "tool-config")?.message).toBe(reviewed.notice);
    expect(JSON.stringify(c.planned.plan)).not.toContain(reviewed.noticeEn);
    expect(installPreviewEn(c.planned).join("\n")).toContain(reviewed.noticeEn);
  });

  it("Core 설치·lifecycle Plan이 만드는 warning·blocker code는 모두 영어 문장이 있다", async () => {
    const dirs = ["packages/core/src/installer", "packages/core/src/lifecycle", "packages/core/src/tool-config"];
    const codes = new Set<string>();
    for (const d of dirs) {
      for (const f of (await readdir(path.join(ROOT, d))).filter((x) => x.endsWith(".ts"))) {
        const text = await readFile(path.join(ROOT, d, f), "utf8");
        for (const m of text.matchAll(/code: "([A-Za-z_-]+)"/gu)) codes.add(m[1]!);
      }
    }
    // 화면 warning이 아닌 code(zod issue·승인 gate·Plan 재생성 결과 code): 결과 화면은 code 그대로와 code별 안내를 쓴다.
    const notWarnings = new Set(["custom", "APPROVAL_CONSUMED", "APPROVAL_INCOMPLETE", "APPROVAL_REQUIRED", "PLAN_INVALID", "PLAN_REGENERATION_FAILED", "COMPENSATION_INCOMPLETE"]);
    const missing = [...codes].filter((c) => !notWarnings.has(c) && !EN_WARNING_CODES.includes(c));
    expect(missing).toEqual([]);
  });
});

const ID = "project:claude-code:kubernetes";
const CLIENTS = (["claude-code", "codex", "cursor"] as const).map((client) => ({ client, scope: "project" as const }));
const unhealthy: HealthRunReport = { ok: true, result: { status: "unhealthy", reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } };
const healthy: HealthRunReport = { ok: true, result: { status: "healthy", reason: null, toolCount: 13, environmentUnverified: false, terminated: true, excerpt: null } };

async function k8sDesktop(o: { health?: () => Promise<HealthRunReport> | HealthRunReport; dialog?: () => Promise<number> | number } = {}) {
  const h = await createHarness(scratch, { entries });
  const request = { ...h.request("kubernetes-mcp-server", CLIENTS), platform: "linux" as const };
  const planned = await plannedOf(h, request);
  const installed = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
  await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
  const dialogs: Parameters<NativeDialogLike["showMessageBox"]>[0][] = [];
  let dir: string | undefined = h.projectRoot;
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerLifecycle({ handle: (c: string, fn: (...args: unknown[]) => unknown) => void handlers.set(c, fn) }, new LifecycleSession(() => dir), {
    registryDir: REGISTRY,
    platform: "linux",
    homeDir: h.homeDir,
    dialog: { showMessageBox: async (opt) => (dialogs.push(opt), { response: await (o.dialog?.() ?? 1) }) },
    probe: h.env.probe,
    spawner: fakeNpmSpawner({ cacheRoot: path.join(h.base, "npm-cache") }).spawner,
    runHealth: async () => (await o.health?.()) ?? healthy,
    tempBase: h.base,
    now: () => new Date("2026-10-10T00:00:00.000Z"),
  });
  const call = (c: string, ...a: unknown[]) => handlers.get(c)!({}, ...a);
  const toolConfig = toolConfigLocation({ homeDir: h.homeDir, scope: "project", toolId: "kubernetes-mcp-server", projectKey: projectKeyFromRealpath(await realpath(h.projectRoot)) })!.file;
  return {
    h,
    dialogs,
    toolConfig,
    planned,
    setProject: (d: string | undefined) => void (dir = d),
    status: () => call(LIFECYCLE_STATUS_CHANNEL) as Promise<LifecycleStatusResponse>,
    plan: () => call(LIFECYCLE_PLAN_CHANNELS.repair, ID) as Promise<LifecyclePlanResponse>,
    run: () => call(LIFECYCLE_RUN_CHANNEL, ID) as Promise<LifecycleRunResponse>,
  };
}

describe("v0.2.0 PR B English 표시(실제 Plan·IPC 결과)", () => {
  it("설치 Plan Preview: 같은 정보·같은 승인 요구 ID를 영어로 보여 주고 한글이 없다. 보안 고지 의미가 남는다", async () => {
    const c = await k8sDesktop();
    const lines = installPreviewEn(c.planned).join("\n");
    expect(lines).not.toMatch(HANGUL);
    for (const id of c.planned.plan.approvalRequirements) expect(lines).toContain("[" + id + "] " + INSTALL_APPROVAL_EN[id]);
    for (const w of c.planned.plan.warnings) expect(lines).toContain("[" + w.code + "]");
    expect(lines).toContain("Plan digest  " + c.planned.planDigest);
    expect(lines).toMatch(/Secret reads denied[\s\S]*pod or node logs are not blocked[\s\S]*read-only RBAC user/u);
    expect(lines).toContain("Cursor: running in this client was not verified by OpenHub.");
  });

  it("Repair: 상태·Preview·승인 대화상자·성공 결과가 영어이고 승인 요구 ID는 그대로다", async () => {
    const c = await k8sDesktop();
    await unlink(c.toolConfig);
    const s = await c.status();
    if (s.status !== "ok") throw new Error(s.status);
    const item = s.items.find((i) => i.id === ID)!;
    expect(item.canRepair).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(HANGUL);
    expect(item.warning).toContain("[Review repair plan]");
    const plan = await c.plan();
    if (plan.status !== "ok") throw new Error(plan.status);
    expect(JSON.stringify(plan.view)).not.toMatch(HANGUL);
    expect(plan.view.requirements.map((r) => r.id)).toEqual(["base", "health-execution", "tool-config"]);
    const run = await c.run();
    if (run.status !== "done") throw new Error(run.status);
    expect(c.dialogs[0]!.title).toBe("OpenHub Repair approval");
    expect(c.dialogs[0]!.buttons).toEqual(["Cancel", "Approve"]);
    expect(c.dialogs[0]!.detail).not.toMatch(HANGUL);
    for (const id of ["base", "health-execution", "tool-config"]) expect(c.dialogs[0]!.detail).toContain("• [" + id + "] " + LIFECYCLE_APPROVAL_EN[id as keyof typeof LIFECYCLE_APPROVAL_EN]);
    expect(run.result).toMatchObject({ status: "repaired", outcome: "succeeded", summary: "Repair completed (repaired)" });
    expect(JSON.stringify(run.result)).not.toMatch(HANGUL);
  });

  it("Health 실패(HEALTH_FAILED)·부분 실패(CONFIG_RESTORE_FAILED)·PLAN_STALE·project-changed 안내가 영어다", async () => {
    const failed = await k8sDesktop({ health: () => unhealthy });
    await unlink(failed.toolConfig);
    await failed.plan();
    const hf = await failed.run();
    if (hf.status !== "done") throw new Error(hf.status);
    // Core 결과 code(unhealthy)를 실패 code 뒤에 그대로 붙인다(한국어 화면과 같은 정보).
    expect(hf.result.summary).toBe("Repair failed (HEALTH_FAILED: unhealthy): the MCP server did not respond correctly. This run's config changes were reverted and Version State was not changed.");
    expect(JSON.stringify(hf.result)).not.toMatch(HANGUL);

    let mcp = "";
    const partial = await k8sDesktop({ health: async () => (await writeFile(mcp, '{ "mcpServers": { "kubernetes": { "command": "x", "args": [] } } }\n'), unhealthy) });
    mcp = path.join(partial.h.projectRoot, ".mcp.json");
    await writeFile(partial.toolConfig, "read_only = false\n");
    await partial.plan();
    const pf = await partial.run();
    if (pf.status !== "done") throw new Error(pf.status);
    expect(pf.result).toMatchObject({ status: "rollback-failed", outcome: "partial" });
    expect(pf.result.summary).toContain("Changes made meanwhile by other programs were not overwritten");
    expect(pf.result.lines.join("\n")).toContain("Check these files yourself: .mcp.json");
    expect(JSON.stringify(pf.result)).not.toMatch(HANGUL);

    let file = "";
    const stale = await k8sDesktop({ dialog: async () => (await writeFile(file, "read_only = false\n"), 1) });
    file = stale.toolConfig;
    await unlink(file);
    await stale.plan();
    const st = await stale.run();
    if (st.status !== "done") throw new Error(st.status);
    expect(st.result).toMatchObject({ status: "stale", outcome: "not-run", reapprove: true });
    expect(st.result.summary).toContain("Review the new plan and approve again.");
    expect(JSON.stringify(st.result)).not.toMatch(HANGUL);

    const moved = await k8sDesktop();
    await unlink(moved.toolConfig);
    await moved.plan();
    moved.setProject(path.join(moved.h.base, "elsewhere"));
    expect(await moved.run()).toEqual({ status: "project-changed", message: projectChangedMessage() });
    expect(projectChangedMessage()).not.toMatch(HANGUL);
  });

  it("FOR YOU 화면 데이터(배지·범위·능력·이유·OpenScore 의미)가 영어이고, 한국어로 바꾸면 이전 문장 그대로다", async () => {
    const c = await k8sDesktop();
    const { recommend: rec, analyzeProject, loadMetadataSnapshot } = await import("@openhub/core");
    await writeFile(path.join(c.h.projectRoot, "Chart.yaml"), "apiVersion: v2\nname: web\nversion: 0.1.0\n");
    const scan = await analyzeProject(c.h.projectRoot, { includeHost: false });
    if (!scan.ok) throw new Error(scan.error.code);
    const snapshot = await loadMetadataSnapshot(path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json"));
    const report = rec(scan.profile, entries, snapshot, { platform: "linux" });
    expect(report.recommendations.length).toBeGreaterThan(0);
    const view = buildForYouView(report);
    expect(JSON.stringify(view)).not.toMatch(HANGUL);
    expect(view.notice).toBe("OpenScore is a repository maintenance, activity and community signal. It is not a security or code quality rating.");
    setDesktopLocale("ko");
    expect(getDesktopLocale()).toBe("ko");
    const koView = buildForYouView(report);
    expect(koView.notice).toBe("OpenScore는 저장소 유지관리·활동성·커뮤니티 신호이며 보안·코드 품질 평가가 아닙니다");
    expect(koView.items.map((i) => i.reasons)).toEqual(report.recommendations.map((r) => r.reasons.slice(0, 3).map((x) => x.message)));
  });
});

