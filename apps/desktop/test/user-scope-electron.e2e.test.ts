import { execFile, spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { toolConfigLocation } from "@openhub/core";

/**
 * v0.2.0 P0-3 C2 Desktop 사용자 범위 실제 Electron E2E(OPENHUB_E2E=1, Electron 바이너리가 있을 때만). 실제 창에서
 * Client 선택 → 사용자 범위 선택 → Install Plan → 승인 → 설치 → INSTALLED 사용자 범위(설치 뒤 자동으로 보임) → Health →
 * (테스트 home의 사용자 tool config 삭제) → Repair Plan → 승인 → Repair → Health를 클릭으로 지난다.
 * 임시 project·home만 쓴다. 가짜 npm(npx Prepare 캐시 계약)·가짜 Health·자동 확인 대화상자(제목·본문 기록). 실제 MCP 실행·network 0.
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
const scratch = path.join(tmpdir(), "openhub-desktop-user-scope-e2e-" + process.pid);
const K8S = "kubernetes-mcp-server";
const CODEX_USER = '# my codex settings\nmodel = "o4"\n\n[mcp_servers.notes]\ncommand = "uvx"\nargs = ["notes-mcp==1.0.0"]\n';
const PROJECT_FILES: Record<string, string> = {
  "package.json": '{ "name": "ops" }\n',
  ".mcp.json": '{ "mcpServers": {} }\n',
  "Chart.yaml": "apiVersion: v2\nname: web\nversion: 0.1.0\n",
  "k8s/deploy.yaml": "apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n",
};

type LifeOp = { status: string; outcome?: string; requirements?: string[]; after?: string[] };
type UserScopeSmoke = { install: { status: string; targets?: string[]; configChanges?: string[] }; health1: LifeOp; corrupted: boolean; repair: LifeOp; health2: LifeOp; dialogs: { title: string; detail: string }[]; healthRuns: number };

async function run(locale: string) {
  const base = path.join(scratch, locale);
  const project = path.join(base, "project");
  const home = path.join(base, "home");
  for (const [rel, text] of Object.entries(PROJECT_FILES)) {
    await mkdir(path.dirname(path.join(project, rel)), { recursive: true });
    await writeFile(path.join(project, rel), text);
  }
  await mkdir(path.join(home, ".codex"), { recursive: true });
  await writeFile(path.join(home, ".codex", "config.toml"), CODEX_USER);
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const env: Record<string, string> = { ...(process.env as Record<string, string>) };
    for (const k of Object.keys(env)) if (k.startsWith("OPENHUB_SMOKE_") || k === "ELECTRON_RUN_AS_NODE" || k === "OPENHUB_SCREENSHOT") delete env[k];
    Object.assign(env, { OPENHUB_SMOKE_USER_DATA: path.join(base, "user-data"), OPENHUB_SMOKE_SYSTEM_LOCALE: locale, OPENHUB_SMOKE_PROJECT: project, OPENHUB_SMOKE_USER_SCOPE: K8S, OPENHUB_SMOKE_HOME: home, OPENHUB_SMOKE_INSTALL_CLIENTS: "codex" });
    const child = spawn(electronBin!, [".", "--smoke"], { cwd: DESKTOP, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  const line = out.stdout.split("\n").find((l) => l.startsWith("OPENHUB_SMOKE "));
  if (line === undefined) throw new Error("smoke 결과 없음: " + out.stderr.slice(-1500));
  const smoke = (JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as { userScope?: UserScopeSmoke }).userScope!;
  return { code: out.code, smoke, project, home };
}

describe.skipIf(process.env["OPENHUB_E2E"] !== "1" || electronBin === null)("v0.2.0 P0-3 C2 Desktop 사용자 범위 실제 Electron E2E", () => {
  beforeAll(async () => {
    await stat(electronBin!);
    await mkdir(scratch, { recursive: true });
    await promisify(execFile)(process.execPath, ["build.mjs"], { cwd: DESKTOP });
  }, 120_000);
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  for (const locale of ["en-US", "ko-KR"]) {
    it("사용자 범위 설치 → INSTALLED 사용자 범위 → Health → 손상 → Repair → Health (" + locale + ")", async () => {
      const r = await run(locale);
      expect(r.code, JSON.stringify(r.smoke)).toBe(0);
      expect(r.smoke.install.status).toBe("succeeded");
      expect(r.smoke.install.targets).toHaveLength(1);
      expect(r.smoke.install.targets![0]).toContain("~/.codex/config.toml");
      expect(r.smoke.health1).toMatchObject({ status: "health-checked", outcome: "succeeded" });
      expect(r.smoke.corrupted).toBe(true);
      expect(r.smoke.repair).toMatchObject({ status: "repaired", outcome: "succeeded" });
      expect(r.smoke.repair.requirements).toContain("user-scope-config");
      expect(r.smoke.health2).toMatchObject({ status: "health-checked", outcome: "succeeded" });
      expect(r.smoke.health2.after).toEqual(["user:state-consistent"]);
      expect(r.smoke.healthRuns).toBe(3);
      // 대화상자: 설치(사용자 범위 경고 포함) → Health → Repair(사용자 범위) → Health.
      expect(r.smoke.dialogs).toHaveLength(4);
      const installDialog = r.smoke.dialogs[0]!.detail;
      expect(installDialog).toContain("~/.codex/config.toml");
      expect(installDialog).toContain(locale === "en-US" ? "This affects every project that uses these clients" : "이 Client를 쓰는 모든 프로젝트에 영향을 줍니다");
      expect(installDialog).toContain("[user-scope-config]");
      // 사용자 Codex 설정의 기존 내용은 그대로이고 OpenHub 항목만 추가됐다. 프로젝트 설정·다른 Client 설정은 그대로다.
      const toml = await readFile(path.join(r.home, ".codex", "config.toml"), "utf8");
      expect(toml.startsWith(CODEX_USER)).toBe(true);
      expect(toml).toContain("[mcp_servers.kubernetes]");
      expect(await readFile(path.join(r.project, ".mcp.json"), "utf8")).toBe(PROJECT_FILES[".mcp.json"]);
      await expect(stat(path.join(r.project, ".codex"))).rejects.toThrow();
      await expect(stat(path.join(r.home, ".cursor"))).rejects.toThrow();
      expect(await readFile(toolConfigLocation({ homeDir: r.home, scope: "user", toolId: K8S })!.file, "utf8")).toContain('kind = "Secret"');
      console.log("desktop user scope " + locale + ": " + JSON.stringify({ install: r.smoke.install.status, health1: r.smoke.health1.status, repair: r.smoke.repair.status, health2: r.smoke.health2.after, dialogs: r.smoke.dialogs.map((d) => d.title) }));
    }, 300_000);
  }
});

