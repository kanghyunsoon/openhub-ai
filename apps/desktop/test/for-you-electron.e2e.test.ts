import { execFile, spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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

type ForYou = { status: string; emptyReason: string; lines: string[]; verification: string[] };

async function launch(locale: string, project: string): Promise<{ code: number | null; recommendations: number; forYou: ForYou }> {
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), OPENHUB_SMOKE_USER_DATA: path.join(scratch, "ud-" + locale + "-" + project), OPENHUB_SMOKE_SYSTEM_LOCALE: locale, OPENHUB_SMOKE_PROJECT: path.join(PROJECTS, project) };
    for (const k of ["ELECTRON_RUN_AS_NODE", "OPENHUB_SMOKE_INSTALL", "OPENHUB_SMOKE_UPDATE", "OPENHUB_SMOKE_REPAIR", "OPENHUB_SMOKE_RELEASE", "OPENHUB_SMOKE_ADOPT", "OPENHUB_SMOKE_HOME", "OPENHUB_SMOKE_I18N_SWITCH", "OPENHUB_SCREENSHOT", "OPENHUB_SMOKE_INSTALL_CLIENTS", "OPENHUB_SMOKE_INSTALL_RACE", "OPENHUB_SMOKE_USER_SCOPE", "OPENHUB_SMOKE_ROLLBACK"]) delete env[k];
    const child = spawn(electronBin!, [".", "--smoke"], { cwd: DESKTOP, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("OPENHUB_SMOKE "));
  if (line === undefined) throw new Error("smoke 결과 없음: " + out.stderr.slice(-1500));
  const parsed = JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as { recommendations: number; forYou: ForYou };
  return { code: out.code, recommendations: parsed.recommendations, forYou: parsed.forYou };
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
});

