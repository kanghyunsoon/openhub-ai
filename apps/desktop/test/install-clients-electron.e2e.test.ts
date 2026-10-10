import { execFile, spawn } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * v0.2.0 P0-3 PR C Desktop Client 선택 실제 Electron E2E(OPENHUB_E2E=1, Electron 바이너리가 있을 때만). 스모크 설치(가짜 probe·executor·
 * 자동 확인 대화상자, 프로젝트는 임시 복사본)로 실제 창에서 [설치 계획 보기] → Client 선택 화면 → 체크 변경 → [선택한 Client로 계획 보기]
 * → 승인 체크 → 확인 → 결과를 클릭으로 지난다. network·실제 MCP 실행 0.
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
const scratch = path.join(tmpdir(), "openhub-desktop-clients-e2e-" + process.pid);

type InstallSmoke = { status: string; stages: string[]; choices: { client: string; enabled: boolean; checked: boolean; verification: string }[]; targets: string[]; configChanges: string[]; dialogs: number; spawned: number };

async function launch(locale: string, clients?: string, raceFirst?: string): Promise<{ code: number | null; install: InstallSmoke }> {
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>), OPENHUB_SMOKE_USER_DATA: path.join(scratch, "ud-" + locale + "-" + (clients ?? "default")), OPENHUB_SMOKE_SYSTEM_LOCALE: locale, OPENHUB_SMOKE_PROJECT: path.join(ROOT, "examples", "demo-project"), OPENHUB_SMOKE_INSTALL: "serena" };
    for (const k of ["ELECTRON_RUN_AS_NODE", "OPENHUB_SMOKE_UPDATE", "OPENHUB_SMOKE_REPAIR", "OPENHUB_SMOKE_RELEASE", "OPENHUB_SMOKE_ADOPT", "OPENHUB_SMOKE_HOME", "OPENHUB_SMOKE_I18N_SWITCH", "OPENHUB_SCREENSHOT", "OPENHUB_SMOKE_INSTALL_CLIENTS", "OPENHUB_SMOKE_INSTALL_RACE"]) delete env[k];
    if (clients !== undefined) env["OPENHUB_SMOKE_INSTALL_CLIENTS"] = clients;
    if (raceFirst !== undefined) env["OPENHUB_SMOKE_INSTALL_RACE"] = raceFirst;
    const child = spawn(electronBin!, [".", "--smoke"], { cwd: DESKTOP, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("OPENHUB_SMOKE "));
  if (line === undefined) throw new Error("smoke 결과 없음: " + out.stderr.slice(-1500));
  return { code: out.code, install: (JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as { install: InstallSmoke }).install };
}

describe.skipIf(process.env["OPENHUB_E2E"] !== "1" || electronBin === null)("v0.2.0 P0-3 PR C Desktop Client 선택 실제 Electron E2E", () => {
  beforeAll(async () => {
    await stat(electronBin!);
    await mkdir(scratch, { recursive: true });
    await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: DESKTOP });
  }, 120_000);
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  it("기본 선택(탐지된 Client)과 화면에서 고른 Client만 설치하고 다른 Client 설정은 바꾸지 않는다(English·한국어)", async () => {
    const def = await launch("en-US");
    expect(def.code).toBe(0);
    expect(def.install.choices.map((c) => [c.client, c.enabled, c.checked])).toEqual([["claude-code", true, true], ["codex", true, false], ["cursor", true, false]]);
    expect(def.install.configChanges).toEqual([".mcp.json (project scope): written"]);
    const codex = await launch("en-US", "codex");
    expect(codex.code).toBe(0);
    expect(codex.install).toMatchObject({ status: "succeeded", dialogs: 1, targets: [".codex/config.toml · codex · project scope"], configChanges: [".codex/config.toml (project scope): written"] });
    const two = await launch("ko-KR", "codex,cursor");
    expect(two.code).toBe(0);
    expect(two.install.configChanges).toEqual([".codex/config.toml (프로젝트 범위): 기록함", ".cursor/mcp.json (프로젝트 범위): 기록함"]);
    // 모두 해제하면 [계획 보기]가 비활성이고 계획·대화상자·실행이 없다(스모크는 설치 실패로 끝난다).
    const none = await launch("en-US", ",");
    expect(none.install).toMatchObject({ status: "no-client", dialogs: 0, spawned: 0 });
    console.log("desktop clients: " + JSON.stringify({ default: def.install.configChanges, codex: codex.install.configChanges, two: two.install.configChanges, verification: def.install.choices.map((c) => c.verification) }));
  }, 300_000);

  it("경쟁 조건: Claude Code로 계획을 요청한 직후 Cursor로 바꿔 다시 요청하면 화면 대상·승인·설치가 모두 Cursor뿐이다", async () => {
    const race = await launch("en-US", "cursor", "claude-code");
    expect(race.code).toBe(0);
    expect(race.install).toMatchObject({ status: "succeeded", dialogs: 1, targets: [".cursor/mcp.json · cursor · project scope"], configChanges: [".cursor/mcp.json (project scope): written"] });
  }, 120_000);
});

