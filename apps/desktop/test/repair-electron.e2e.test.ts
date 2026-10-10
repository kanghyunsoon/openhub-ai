import { execFile, spawn } from "node:child_process";
import { readFile, realpath, rm, stat, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { loadRegistry, locateWindowsNpxLauncher, projectKeyFromRealpath, recordInstallInState, runInstallTransaction, toolConfigLocation } from "@openhub/core";
import { approveAll, createHarness, plannedOf } from "../../../packages/core/test/installer/harness";

/**
 * v0.2.0 P0-3 Desktop Repair 실제 Electron E2E(OPENHUB_E2E=1, Electron 바이너리가 있을 때만). Core로 kubernetes-mcp-server를 임시
 * 프로젝트에 설치하고 tool config를 지운 뒤, 실제 Electron 앱을 --smoke + OPENHUB_SMOKE_REPAIR로 띄운다. renderer가 화면의
 * [복구 계획 확인] click → 승인 항목 checkbox click → 확인 버튼 click → (preload → main IPC → 네이티브 대화상자 자리의 자동 확인 → Core 실행)
 * → 결과 렌더링 → 최신 상태를 그대로 지난다(renderer 내부 함수 직접 호출 없음).
 * 이 테스트는 Electron UI·IPC 통합 검증이다: 가짜 npm(cache 항목만)·가짜 Health를 쓴다(network·실제 MCP 실행 0). 실제 MCP 서버 Health는
 * packages/core/test/registry/kubernetes-tool-config.e2e.test.ts가 따로 검증한다. 실제 Kubernetes·자격증명은 쓰지 않는다.
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
const scratch = path.join(tmpdir(), "openhub-desktop-repair-e2e-" + process.pid);
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe.skipIf(process.env["OPENHUB_E2E"] !== "1" || electronBin === null)("v0.2.0 P0-3 Desktop Repair 실제 Electron E2E", () => {
  it("실제 Electron 창에서 [복구 계획 확인] → 승인 → Repair → Health → 최신 상태가 모두 state-consistent다", async () => {
    await stat(electronBin!);
    const { mkdir } = await import("node:fs/promises");
    await mkdir(scratch, { recursive: true });
    const { entries } = await loadRegistry(path.join(ROOT, "registry"));
    const h = await createHarness(scratch, { entries });
    const platform = process.platform === "win32" ? ("windows" as const) : ("linux" as const);
    const launcher = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
    const request = { ...h.request("kubernetes-mcp-server", (["claude-code", "codex", "cursor"] as const).map((client) => ({ client, scope: "project" as const }))), platform };
    const env = { ...h.env, ...(launcher === null ? {} : { windowsNpx: async () => launcher }) };
    const planned = await plannedOf({ ...h, env }, request);
    const installed = await runInstallTransaction(planned, await approveAll(planned), request, env);
    expect(installed.status, JSON.stringify(installed.steps)).toBe("succeeded");
    await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
    const toolConfig = toolConfigLocation({ homeDir: h.homeDir, scope: "project", toolId: "kubernetes-mcp-server", projectKey: projectKeyFromRealpath(await realpath(h.projectRoot)) })!.file;
    await unlink(toolConfig);

    await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: DESKTOP });
    const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
      // v0.2.0 PR B: 화면 언어를 한국어로 고정하고(대화상자 제목 비교) userData를 임시 폴더로 둔다(사용자 언어 선택에 영향받지 않게).
      const childEnv: Record<string, string> = { ...(process.env as Record<string, string>), OPENHUB_SMOKE_PROJECT: h.projectRoot, OPENHUB_SMOKE_REPAIR: "kubernetes-mcp-server", OPENHUB_SMOKE_HOME: h.homeDir, OPENHUB_SMOKE_SYSTEM_LOCALE: "ko-KR", OPENHUB_SMOKE_USER_DATA: path.join(scratch, "user-data") };
      delete childEnv["ELECTRON_RUN_AS_NODE"];
      const child = spawn(electronBin!, [".", "--smoke"], { cwd: DESKTOP, env: childEnv, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.on("close", (code) => resolve({ code, stdout, stderr }));
    });
    const line = out.stdout.split("\n").find((l) => l.startsWith("OPENHUB_SMOKE "));
    if (line === undefined) throw new Error("smoke 결과 없음: " + out.stderr.slice(-1500));
    const smoke = JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as { repair?: { status: string; outcome: string; health: string[]; preview: number; boxes: number; confirmDisabledBeforeChecks: boolean; after: string[]; npmCalls: number; healthRuns: number; dialogs: string[] }; runtime: { electronVersion: string } };
    console.log("desktop repair electron: " + JSON.stringify({ exit: out.code, electron: smoke.runtime.electronVersion, repair: smoke.repair }));
    expect(smoke.repair).toMatchObject({ status: "repaired", outcome: "succeeded", healthRuns: 1, npmCalls: 2, dialogs: ["OpenHub 복구 승인"], boxes: 3, confirmDisabledBeforeChecks: true });
    expect(smoke.repair!.health[0]).toMatch(/^Health: Healthy/u);
    expect(smoke.repair!.after).toEqual(["state-consistent", "state-consistent", "state-consistent"]);
    expect(smoke.repair!.preview).toBeGreaterThan(5);
    expect(out.code).toBe(0);
    expect(await readFile(toolConfig, "utf8")).toContain('kind = "Secret"');
  }, 300_000);
});

