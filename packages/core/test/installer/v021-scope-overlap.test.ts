import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRegistry, runInstallTransaction, type InstallClient } from "../../src/index";
import { ConfigWriteError, configTargetFor, nodeConfigFs, resolveInside } from "../../src/installer/config-writer";
import { approveAll, createHarness, plannedOf } from "./harness";

/**
 * v0.2.1 P0-2 재현: project 범위 대상 파일이 (realpath 기준으로) 같은 Client의 사용자 설정 파일과 같으면
 * project 범위 요청이 user-scope-config 승인 없이 사용자 설정을 바꾸면 안 된다.
 * Cursor(~/.cursor/mcp.json)·Codex(~/.codex/config.toml)는 겹칠 수 있고, Claude Code는 project .mcp.json / user ~/.claude.json이라 겹치지 않는다.
 */
const REGISTRY = path.resolve(import.meta.dirname, "../../../../registry");
const { entries } = await loadRegistry(REGISTRY);
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-v021-scope-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const USER_FILE = { cursor: path.join(".cursor", "mcp.json"), codex: path.join(".codex", "config.toml") } as const;
const SEED = { cursor: '{ "theme": "dark", "mcpServers": {} }\n', codex: '# my codex\nmodel = "o4"\n' } as const;

async function overlapping(client: "cursor" | "codex", how: "same-dir" | "symlink") {
  const h = await createHarness(scratch, { entries, packageJson: '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n' });
  await mkdir(path.join(h.homeDir, path.dirname(USER_FILE[client])), { recursive: true });
  await writeFile(path.join(h.homeDir, USER_FILE[client]), SEED[client]);
  let projectRoot = h.homeDir;
  if (how === "symlink") {
    // 프로젝트 폴더가 home을 가리키는 링크(Windows는 junction).
    projectRoot = path.join(path.dirname(h.homeDir), "project-link");
    await symlink(h.homeDir, projectRoot, process.platform === "win32" ? "junction" : "dir");
    await writeFile(path.join(h.homeDir, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  } else {
    await writeFile(path.join(h.homeDir, "package.json"), '{ "name": "api", "dependencies": { "pg": "^8.13.0" } }\n');
  }
  const request = { ...h.request("memory-mcp", [{ client: client as InstallClient, scope: "project" as const }]), projectRoot };
  return { h, request, userFile: path.join(h.homeDir, USER_FILE[client]) };
}

describe("v0.2.1 P0-2 project 범위 대상이 사용자 설정 파일과 같을 때", () => {
  for (const client of ["cursor", "codex"] as const) {
    for (const how of ["same-dir", "symlink"] as const) {
      it(client + " · " + how + ": project 범위 계획은 막히고, 승인해도 사용자 설정은 그대로다", async () => {
        const { h, request, userFile } = await overlapping(client, how);
        const before = await readFile(userFile, "utf8");
        const planned = await plannedOf(h, request);
        // 막힌 계획은 승인할 수 없다(승인 요청 자체가 거부된다). 그래도 실행을 시도해 쓰기가 없는지 본다.
        const approval = await approveAll(planned).catch(() => undefined);
        const result = await runInstallTransaction(planned, approval, request, h.env).catch((e: unknown) => ({ status: "threw", error: String(e) }));
        const after = await readFile(userFile, "utf8");
        expect(planned.plan.status, JSON.stringify({ status: planned.plan.status, req: planned.plan.approvalRequirements, warnings: planned.plan.warnings.map((w) => w.code), run: (result as { status: string }).status })).toBe("blocked");
        expect(approval).toBeUndefined();
        expect((result as { status: string }).status).not.toBe("succeeded");
        expect(planned.plan.warnings.map((w) => w.code)).toContain("PROJECT_TARGET_IS_USER_CONFIG");
        expect(planned.plan.warnings.find((w) => w.code === "PROJECT_TARGET_IS_USER_CONFIG")?.message).toContain(configTargetFor(client, "user").logical);
        expect(planned.plan.steps.filter((s) => s.kind === "config-patch")).toEqual([]);
        expect(after).toBe(before);
        // 실행 단계 이중 방어: 쓰기 경로(resolveInside)도 project 대상을 거부한다.
        const target = configTargetFor(client, "project");
        if (!target.writable) throw new Error("expected writable");
        await expect(resolveInside(target, { projectRoot: request.projectRoot, homeDir: h.homeDir }, nodeConfigFs)).rejects.toMatchObject({ code: "PROJECT_TARGET_IS_USER_CONFIG" });
        expect(new ConfigWriteError("PROJECT_TARGET_IS_USER_CONFIG", "x").code).toBe("PROJECT_TARGET_IS_USER_CONFIG");
      });
    }
  }

  it("같은 Client의 사용자 범위 설치는 그대로 가능하고 user-scope-config 승인을 요구한다", async () => {
    const { h, request } = await overlapping("cursor", "same-dir");
    const planned = await plannedOf(h, { ...request, targets: [{ client: "cursor", scope: "user" }] });
    expect(planned.plan.status).toBe("installable");
    expect(planned.plan.approvalRequirements).toContain("user-scope-config");
  });

  it("겹치지 않는 일반 프로젝트는 영향이 없다", async () => {
    const h = await createHarness(scratch, { entries });
    const planned = await plannedOf(h, h.request("memory-mcp", [{ client: "cursor", scope: "project" }]));
    expect(planned.plan.warnings.map((w) => w.code)).not.toContain("PROJECT_TARGET_IS_USER_CONFIG");
    expect(planned.plan.status).toBe("installable");
  });

  it("Claude Code(.mcp.json)는 home을 프로젝트로 골라도 사용자 설정(~/.claude.json)과 겹치지 않아 그대로 계획된다", async () => {
    const h = await createHarness(scratch, { entries });
    await writeFile(path.join(h.homeDir, ".claude.json"), '{ "keep": true }\n');
    const request = { ...h.request("memory-mcp", [{ client: "claude-code" as const, scope: "project" as const }]), projectRoot: h.homeDir };
    const planned = await plannedOf(h, request);
    expect(planned.plan.warnings.map((w) => w.code)).not.toContain("PROJECT_TARGET_IS_USER_CONFIG");
    expect(planned.plan.status).toBe("installable");
  });
});
