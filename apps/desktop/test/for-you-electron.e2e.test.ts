import { execFile, spawn } from "node:child_process";
import { cp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { analyzeProject, buildInstallPlan, loadRegistry, recommend, toRecommendPlatform, type BackendProbeReport } from "@openhub/core";
import { en } from "../src/i18n/en";
import { ko } from "../src/i18n/ko";

/**
 * v0.2.0 P0-3 C3 추천 진단 실제 Electron E2E(OPENHUB_E2E=1, Electron 바이너리가 있을 때만). 실제 fixture 프로젝트를 분석해
 * FOR YOU 화면에 그려진 진단 문장을 읽는다. 설치·쓰기·network·실제 MCP 실행 0.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const PROJECTS = path.join(ROOT, "packages", "core", "test", "fixtures", "projects");
const electronBin = (() => {
  try {
    return createRequire(path.join(DESKTOP, "package.json"))("electron") as string;
  } catch {
    return null;
  }
})();
const scratch = path.join(tmpdir(), "openhub-desktop-foryou-e2e-" + process.pid);

type ForYou = { status: string; emptyReason: string; lines: string[]; addButtons: string[]; verification: string[] };
type InstallSmoke = { status: string; stages: string[]; targets?: string[]; requirements?: string[]; entryNote?: boolean; message?: string; configChanges?: string[]; dialogs: number; configFiles: Record<string, string | null> };

async function launch(locale: string, project: string, install?: { tool: string; clients: string; scope?: "user" }): Promise<{ code: number | null; recommendations: number; forYou: ForYou; install?: InstallSmoke }> {
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const dir = path.isAbsolute(project) ? project : path.join(PROJECTS, project);
    const env: Record<string, string> = { ...(process.env as Record<string, string>), OPENHUB_SMOKE_USER_DATA: path.join(scratch, "ud-" + locale + "-" + path.basename(dir) + "-" + (install?.clients ?? "none") + (install?.scope ?? "")), OPENHUB_SMOKE_SYSTEM_LOCALE: locale, OPENHUB_SMOKE_PROJECT: dir };
    for (const k of ["ELECTRON_RUN_AS_NODE", "OPENHUB_SMOKE_INSTALL", "OPENHUB_SMOKE_UPDATE", "OPENHUB_SMOKE_REPAIR", "OPENHUB_SMOKE_RELEASE", "OPENHUB_SMOKE_ADOPT", "OPENHUB_SMOKE_HOME", "OPENHUB_SMOKE_I18N_SWITCH", "OPENHUB_SCREENSHOT", "OPENHUB_SMOKE_INSTALL_CLIENTS", "OPENHUB_SMOKE_INSTALL_RACE", "OPENHUB_SMOKE_INSTALL_SCOPE", "OPENHUB_SMOKE_USER_SCOPE", "OPENHUB_SMOKE_ROLLBACK"]) delete env[k];
    if (install !== undefined) {
      env["OPENHUB_SMOKE_INSTALL"] = install.tool;
      env["OPENHUB_SMOKE_INSTALL_CLIENTS"] = install.clients;
      if (install.scope !== undefined) env["OPENHUB_SMOKE_INSTALL_SCOPE"] = install.scope;
    }
    const child = spawn(electronBin!, [".", "--smoke"], { cwd: DESKTOP, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("OPENHUB_SMOKE "));
  if (line === undefined) throw new Error("smoke 결과 없음: " + out.stderr.slice(-1500));
  const parsed = JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as { recommendations: number; forYou: ForYou; install?: InstallSmoke };
  return { code: out.code, recommendations: parsed.recommendations, forYou: parsed.forYou, ...(parsed.install === undefined ? {} : { install: parsed.install }) };
}

/** 스모크 설치와 같은 가짜 probe(Desktop smokeInstallDeps). 표준 항목은 backend 선택·launch에만 달려 있다. */
const SMOKE_PROBES: BackendProbeReport = {
  node: { name: "node", available: true, version: "22.0.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.0.0", status: "ok" },
  uvx: { name: "uvx", available: true, version: "0.5.0", status: "ok" },
  docker: { name: "docker", available: true, version: "27.0.0", status: "ok" },
};
const TOOL = "playwright-mcp";

/** react-pnpm 복사본에 Cursor 프로젝트 설정(이 OS에서 OpenHub가 쓰는 표준 Playwright 항목)을 넣는다. 실행할 때마다 앱이 임시 복사본을 만든다. */
async function cursorProjectSource(): Promise<{ dir: string; cursor: string }> {
  const dir = path.join(scratch, "src-cursor-installed");
  await rm(dir, { recursive: true, force: true });
  await cp(path.join(PROJECTS, "react-pnpm"), dir, { recursive: true });
  const { entries } = await loadRegistry(path.join(ROOT, "registry"));
  const analysis = await analyzeProject(dir);
  if (!analysis.ok) throw new Error("analysis");
  const platform = toRecommendPlatform(process.platform)!;
  const report = recommend(analysis.profile, entries, undefined, { platform });
  const built = buildInstallPlan({ toolId: TOOL, entries, report, probes: SMOKE_PROBES, platform, targets: [{ client: "cursor", scope: "project", file: ".cursor/mcp.json", envReference: "cursor-env", precondition: { exists: false, fileDigest: null, keyAbsent: true } }] });
  if (!built.ok) throw new Error(built.code);
  const step = built.planned.plan.steps.find((s) => s.kind === "config-patch");
  if (step?.kind !== "config-patch") throw new Error("config-patch 없음");
  const cursor = JSON.stringify({ mcpServers: { playwright: step.value } }, null, 2) + "\n";
  await mkdir(path.join(dir, ".cursor"), { recursive: true });
  await writeFile(path.join(dir, ".cursor", "mcp.json"), cursor);
  return { dir, cursor };
}

describe.skipIf(process.env["OPENHUB_E2E"] !== "1" || electronBin === null)("v0.2.0 C3 추천 진단 실제 Electron E2E", () => {
  beforeAll(async () => {
    await stat(electronBin!);
    await mkdir(scratch, { recursive: true });
    await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: DESKTOP });
  }, 120_000);
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  it("추천 0개(Verified 도구 없음)는 '추천 없음'만이 아니라 Core 진단 이유를 화면에 보인다(English·한국어)", async () => {
    const enRun = await launch("en-US", "unity-editor-only");
    expect(enRun.code).toBe(0);
    expect(enRun.recommendations).toBe(0);
    expect(enRun.forYou).toMatchObject({ status: en["forYou.none"], emptyReason: "no-verified-tool" });
    expect(enRun.forYou.lines).toEqual([en["forYou.diag.title"], en["forYou.empty.noVerifiedTool"]]);
    const koRun = await launch("ko-KR", "unity-editor-only");
    expect(koRun.forYou.lines).toEqual([ko["forYou.diag.title"], ko["forYou.empty.noVerifiedTool"]]);
    console.log("desktop for-you empty: " + JSON.stringify({ en: enRun.forYou, ko: koRun.forYou }));
  }, 180_000);

  it("추천이 있으면 이미 설치된 도구의 중복 제외 이유와 Registry 등록 ≠ 실행 검증 안내를 보인다", async () => {
    const run = await launch("en-US", "claude-mcp");
    expect(run.code).toBe(0);
    expect(run.recommendations).toBeGreaterThan(0);
    expect(run.forYou.emptyReason).toBe("");
    expect(run.forYou.lines).toContain(en["forYou.diag.excludedTitle"]);
    expect(run.forYou.lines.filter((l) => l.endsWith(en["forYou.exclusion.installed"])).length).toBe(2);
    expect(run.forYou.lines.at(-1)).toBe(en["forYou.verify.notice"]);
    expect(run.forYou.verification.length).toBe(run.recommendations);
    for (const v of run.forYou.verification) expect(v.startsWith("Registry listed · ")).toBe(true);
    console.log("desktop for-you excluded: " + JSON.stringify(run.forYou));
  }, 120_000);

  it("추가 설치: Cursor 프로젝트에 이미 있는 도구를 [다른 Client·범위에 추가]로 Codex 프로젝트·Cursor 사용자 범위에 넣고, 같은 대상은 변경 없음이다", async () => {
    const src = await cursorProjectSource();
    // 진단: 이미 사용 중이라 추천에서 빠지고 추가 버튼이 붙는다.
    const view = await launch("en-US", src.dir);
    expect(view.forYou.addButtons).toContain(TOOL);
    expect(view.forYou.lines.some((l) => l.startsWith("Playwright MCP") && l.endsWith(en["forYou.exclusion.installed"]))).toBe(true);
    // D·N: Codex 프로젝트 추가. 기존 Cursor 프로젝트 설정은 byte 그대로.
    const codex = await launch("en-US", src.dir, { tool: TOOL, clients: "codex" });
    expect(codex.code).toBe(0);
    expect(codex.install).toMatchObject({ status: "succeeded", entryNote: true, dialogs: 1, configChanges: [".codex/config.toml (project scope): written"] });
    expect(codex.install?.requirements).not.toContain("user-scope-config");
    expect(codex.install?.configFiles["project/.cursor/mcp.json"]).toBe(src.cursor);
    expect(codex.install?.configFiles["project/.codex/config.toml"]).toContain("[mcp_servers.playwright]");
    // C·G·N: Cursor 사용자 범위 추가는 user-scope-config 승인이 필요하고 프로젝트 설정은 그대로다.
    const user = await launch("en-US", src.dir, { tool: TOOL, clients: "cursor", scope: "user" });
    expect(user.code).toBe(0);
    expect(user.install).toMatchObject({ status: "succeeded", entryNote: true, dialogs: 1, configChanges: ["~/.cursor/mcp.json (user scope): written"] });
    expect(user.install?.requirements).toContain("user-scope-config");
    expect(user.install?.configFiles["project/.cursor/mcp.json"]).toBe(src.cursor);
    expect(JSON.parse(user.install!.configFiles["user/.cursor/mcp.json"]!).mcpServers).toHaveProperty("playwright");
    // E: 같은 대상(Cursor 프로젝트)은 변경 없음(no-op), 대화상자·쓰기 0. 스모크는 설치 성공이 아니므로 종료 코드 1이다.
    const same = await launch("en-US", src.dir, { tool: TOOL, clients: "cursor" });
    expect(same.install).toMatchObject({ status: "no-op", dialogs: 0, message: en["install.noChanges"] });
    expect(same.install?.targets?.[0]).toContain(en["install.target.unchanged"]);
    expect(same.install?.configFiles["project/.cursor/mcp.json"]).toBe(src.cursor);
    // L: 한국어
    const koRun = await launch("ko-KR", src.dir, { tool: TOOL, clients: "codex" });
    expect(koRun.install).toMatchObject({ status: "succeeded", configChanges: [".codex/config.toml (프로젝트 범위): 기록함"] });
    expect(koRun.forYou.lines.some((l) => l.endsWith(ko["forYou.exclusion.installed"]))).toBe(true);
    console.log("desktop add-elsewhere: " + JSON.stringify({ codex: codex.install?.configChanges, user: user.install?.configChanges, same: same.install?.status, ko: koRun.install?.configChanges }));
  }, 300_000);
});

