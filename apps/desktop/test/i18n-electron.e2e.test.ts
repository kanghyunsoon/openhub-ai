import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PREFERENCES_FILE } from "../src/i18n/preferences";

/**
 * v0.2.0 P0-3 PR B Desktop 다국어 실제 Electron E2E(OPENHUB_E2E=1, Electron 바이너리가 있을 때만).
 * 실제 Electron 앱을 --smoke로 띄워 첫 실행 언어(OS 언어), 저장된 선택 우선, 화면의 언어 선택 변경(change 이벤트 → main 저장 →
 * 다시 읽기), 재실행 후 유지, 번역 누락 0을 확인한다. userData는 테스트마다 임시 폴더다(사용자 설정을 건드리지 않는다).
 * network·MCP 실행·모델 호출 0.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const DESKTOP = path.join(ROOT, "apps", "desktop");
const electronBin = (() => {
  try {
    return createRequire(path.join(DESKTOP, "package.json"))("electron") as string;
  } catch {
    return null;
  }
})();
const scratch = path.join(tmpdir(), "openhub-desktop-i18n-e2e-" + process.pid);
const HANGUL = /[\uac00-\ud7a3]/u;

type I18nSmoke = { locale: string; htmlLang: string; selectValue: string; texts: Record<string, string>; hangul: number; missingKeys: string[] };
type AdoptSmoke = { status: string; preview: string; adoptResult: string; benchmarkResult: string; spawns: number; dialogs: { title: string; message: string; detail: string }[] };
type Smoke = { i18n: { before: I18nSmoke; after?: I18nSmoke }; tools: number; adopt?: AdoptSmoke };

async function launch(userData: string, systemLocale: string, switchTo?: "en" | "ko", extraEnv: Record<string, string> = {}): Promise<{ code: number | null; smoke: Smoke }> {
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), OPENHUB_SMOKE_USER_DATA: userData, OPENHUB_SMOKE_SYSTEM_LOCALE: systemLocale };
    if (switchTo !== undefined) childEnv["OPENHUB_SMOKE_I18N_SWITCH"] = switchTo;
    for (const k of ["ELECTRON_RUN_AS_NODE", "OPENHUB_SMOKE_PROJECT", "OPENHUB_SMOKE_INSTALL", "OPENHUB_SMOKE_UPDATE", "OPENHUB_SMOKE_REPAIR", "OPENHUB_SMOKE_RELEASE", "OPENHUB_SMOKE_ADOPT", "OPENHUB_SMOKE_HOME", "OPENHUB_SCREENSHOT"]) delete childEnv[k];
    Object.assign(childEnv, extraEnv);
    const child = spawn(electronBin!, [".", "--smoke"], { cwd: DESKTOP, env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("OPENHUB_SMOKE "));
  if (line === undefined) throw new Error("smoke 결과 없음: " + out.stderr.slice(-1500));
  return { code: out.code, smoke: JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as Smoke };
}

const storedLanguage = async (userData: string) => (JSON.parse(await readFile(path.join(userData, PREFERENCES_FILE), "utf8")) as { language?: string }).language;

function expectEnglish(s: I18nSmoke) {
  expect(s).toMatchObject({ locale: "en", htmlLang: "en", selectValue: "en", hangul: 0, missingKeys: [] });
  for (const [id, text] of Object.entries(s.texts)) expect(text, id).not.toMatch(HANGUL);
  expect(s.texts["project-select"]).toBe("Choose project");
}
function expectKorean(s: I18nSmoke) {
  expect(s).toMatchObject({ locale: "ko", htmlLang: "ko", selectValue: "ko", missingKeys: [] });
  expect(s.hangul).toBeGreaterThan(100);
  expect(s.texts["project-select"]).toMatch(HANGUL);
}

describe.skipIf(process.env["OPENHUB_E2E"] !== "1" || electronBin === null)("v0.2.0 P0-3 PR B Desktop 다국어 실제 Electron E2E", () => {
  beforeAll(async () => {
    await stat(electronBin!);
    await mkdir(scratch, { recursive: true });
    await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: DESKTOP });
  }, 120_000);
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  it("첫 실행: OS 언어 en-US면 English, ko-KR이면 한국어이고 번역 누락이 없다(선택을 저장하지 않는다)", async () => {
    const enDir = path.join(scratch, "first-en");
    const en = await launch(enDir, "en-US");
    expect(en.code).toBe(0);
    expectEnglish(en.smoke.i18n.before);
    const koDir = path.join(scratch, "first-ko");
    const ko = await launch(koDir, "ko-KR");
    expect(ko.code).toBe(0);
    expectKorean(ko.smoke.i18n.before);
    await expect(stat(path.join(koDir, PREFERENCES_FILE))).rejects.toThrow();
    console.log("desktop i18n first run: " + JSON.stringify({ en: en.smoke.i18n.before.texts, ko: ko.smoke.i18n.before.texts }));
  }, 180_000);

  it("화면 언어 선택 en → ko, ko → en이 저장되고 재실행 후에도 OS 언어보다 저장된 선택이 우선한다", async () => {
    const dir = path.join(scratch, "switch");
    const toKo = await launch(dir, "en-US", "ko");
    expect(toKo.code).toBe(0);
    expectEnglish(toKo.smoke.i18n.before);
    expectKorean(toKo.smoke.i18n.after!);
    expect(await storedLanguage(dir)).toBe("ko");

    const relaunchKo = await launch(dir, "en-US");
    expect(relaunchKo.code).toBe(0);
    expectKorean(relaunchKo.smoke.i18n.before);

    const toEn = await launch(dir, "ko-KR", "en");
    expect(toEn.code).toBe(0);
    expectKorean(toEn.smoke.i18n.before);
    expectEnglish(toEn.smoke.i18n.after!);
    expect(await storedLanguage(dir)).toBe("en");

    const relaunchEn = await launch(dir, "ko-KR");
    expect(relaunchEn.code).toBe(0);
    expectEnglish(relaunchEn.smoke.i18n.before);
    console.log("desktop i18n switch: " + JSON.stringify({ stored: await storedLanguage(dir), after: [toKo.smoke.i18n.after!.locale, relaunchKo.smoke.i18n.before.locale, toEn.smoke.i18n.after!.locale, relaunchEn.smoke.i18n.before.locale] }));
  }, 300_000);

  it("Adopt·Benchmark: 실제 창에서 버튼 click → 승인 대화상자 → 결과가 English는 영어(승인 ID 유지), ko-KR은 Core 한국어 문장이다", async () => {
    const { mkdir: mk, writeFile } = await import("node:fs/promises");
    const run = async (locale: string) => {
      const base = path.join(scratch, "adopt-" + locale);
      const project = path.join(base, "project");
      const home = path.join(base, "home");
      await mk(project, { recursive: true });
      await mk(home, { recursive: true });
      await writeFile(path.join(project, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
      await writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@1.2.3"] } } }, null, 2) + "\n");
      const r = await launch(path.join(base, "user-data"), locale, undefined, { OPENHUB_SMOKE_PROJECT: project, OPENHUB_SMOKE_ADOPT: "1", OPENHUB_SMOKE_HOME: home });
      expect(r.code, JSON.stringify(r.smoke.adopt)).toBe(0);
      return r.smoke.adopt!;
    };
    const en = await run("en-US");
    expect(en).toMatchObject({ status: "ok", spawns: 6 });
    expect(en.dialogs.map((d) => d.title)).toEqual(["OpenHub Adopt approval", "OpenHub Benchmark approval"]);
    for (const s of [en.preview, en.adoptResult, en.benchmarkResult, ...en.dialogs.flatMap((d) => [d.title, d.message, d.detail])]) expect(s).not.toMatch(HANGUL);
    expect(en.dialogs[0]!.detail).toContain("• [base] I reviewed the adopt plan above");
    expect(en.dialogs[1]!.detail).toContain("the MCP server is started 6 times");
    expect(en.dialogs[1]!.detail).toContain("(third-party code)");
    expect(en.dialogs[1]!.detail).toContain("This is not a Health Check");
    expect(en.dialogs[1]!.detail).toMatch(/• \[base\] .*• \[artifact-fetch\] /su);
    expect(en.adoptResult).toContain("Adopt completed: memory-mcp");
    expect(en.benchmarkResult).toMatch(/^Benchmark memory-mcp — \d of 5 measured runs succeeded/u);
    const ko = await run("ko-KR");
    expect(ko.dialogs.map((d) => d.title)).toEqual(["OpenHub Adopt 승인", "OpenHub Benchmark 승인"]);
    expect(ko.dialogs[0]!.detail).toContain("Adopt 계획: memory-mcp (ready)");
    expect(ko.dialogs[1]!.detail).toContain("Benchmark 계획: memory-mcp (ready)");
    console.log("desktop adopt i18n: " + JSON.stringify({ en: en.dialogs.map((d) => d.title), ko: ko.dialogs.map((d) => d.title), spawns: [en.spawns, ko.spawns], enFirstLine: en.benchmarkResult.split("\n")[0] }));
  }, 300_000);
});

