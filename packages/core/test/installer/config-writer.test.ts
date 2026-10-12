import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  CONFIG_WRITE_ALLOWLIST,
  applyConfigPatch,
  buildInstallPlan,
  configTargetFor,
  executeVerifiedPlan,
  entryPlanDigest,
  fileSha256,
  inspectConfigTarget,
  installPlanDigest,
  nodeConfigFs,
  restoreConfig,
  type ConfigFs,
  type ConfigPatchStep,
  type ConfigRoots,
  type ConfigScope,
  type ExecChild,
  type ExecSpawner,
  type InstallClient,
  type InstallPlanV1,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { ALL_AVAILABLE, clientProfile, entryOf, reportFor, verifiedPlanOf } from "./helpers";

const seed = await seedEntries();
const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-config-test-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

async function roots(): Promise<ConfigRoots & { base: string }> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const projectRoot = path.join(base, "project");
  const homeDir = path.join(base, "home");
  await mkdir(projectRoot);
  await mkdir(homeDir);
  return { base, projectRoot, homeDir };
}
const aliasOf = (toolId: string) => entryOf(seed, toolId).manifest.recommendation!.identity!.mcpServerNames![0]!;

async function planWith(toolId: string, targets: [InstallClient, ConfigScope][], r: ConfigRoots, platform: "linux" | "windows" = "linux"): Promise<InstallPlanV1> {
  const inspected = await Promise.all(targets.map(([c, s]) => inspectConfigTarget(c, s, aliasOf(toolId), r)));
  const built = buildInstallPlan({ toolId, entries: seed, report: reportFor(clientProfile(), seed), probes: ALL_AVAILABLE, targets: inspected, platform });
  if (!built.ok) throw new Error(built.code);
  return built.planned.plan;
}
async function stepsFor(toolId: string, targets: [InstallClient, ConfigScope][], r: ConfigRoots, platform: "linux" | "windows" = "linux"): Promise<ConfigPatchStep[]> {
  return (await planWith(toolId, targets, r, platform)).steps.filter((s): s is ConfigPatchStep => s.kind === "config-patch");
}
const ALL_ACKS = ["base", "user-scope-config", "floating-artifact", "client-env-parse-risk"] as const;
const apply = (step: ConfigPatchStep, r: ConfigRoots, acks: readonly string[] = ALL_ACKS) => applyConfigPatch(step, { ...r, acknowledgements: acks as never });
const listing = async (dir: string) => (await readdir(dir, { recursive: true })).map((f) => f.replace(/\\/gu, "/")).sort();

describe("REQ-036 Agent Client Config Writer", () => {
  it("AC-032-01 쓸 수 있는 파일은 allowlist 5개뿐이고 ~/.claude.json 등은 manual-setup-required이며 쓰지 않는다", async () => {
    expect(CONFIG_WRITE_ALLOWLIST.map((t) => t.client + ":" + t.logical)).toEqual([
      "claude-code:.mcp.json",
      "cursor:.cursor/mcp.json",
      "codex:.codex/config.toml",
      "cursor:~/.cursor/mcp.json",
      "codex:~/.codex/config.toml",
    ]);
    expect(configTargetFor("claude-code", "user")).toMatchObject({ writable: false, logical: "~/.claude.json" });
    const r = await roots();
    await writeFile(path.join(r.homeDir, ".claude.json"), '{"mcpServers":{}}');
    expect(await inspectConfigTarget("claude-code", "user", "memory", r)).toMatchObject({ file: "~/.claude.json", envReference: "manual" });
    const plan = await planWith("memory-mcp", [["claude-code", "user"]], r);
    expect(plan.steps.filter((s) => s.kind === "config-patch")).toEqual([]);
    expect(plan.warnings.map((w) => w.code)).toContain("manual-setup-required");
    const [valid] = await stepsFor("memory-mcp", [["claude-code", "project"]], r);
    const forged = [
      { ...valid!, scope: "user" as const, file: "~/.claude.json" },
      { ...valid!, file: ".vscode/mcp.json" },
      { ...valid!, file: "../outside/.mcp.json" },
      { ...valid!, path: ["mcpServers", "memory", "command"] },
    ];
    for (const step of forged) await expect(apply(step, r), step.file).rejects.toMatchObject({ code: "MANUAL_SETUP_REQUIRED" });
    expect(await readFile(path.join(r.homeDir, ".claude.json"), "utf8")).toBe('{"mcpServers":{}}');
    expect(await listing(r.projectRoot)).toEqual([]);
  });

  it("AC-032-02 JSON 패치는 mcpServers.<alias>만 추가하고 다른 key·서버·unknown field와 들여쓰기를 유지한다", async () => {
    const r = await roots();
    const original = {
      $schema: "https://example.invalid/schema.json",
      mcpServers: { existing: { command: "node", args: ["server.js"], disabled: true, custom: { nested: [1, 2] } } },
      unknownTop: { keep: "me" },
    };
    const file = path.join(r.projectRoot, ".mcp.json");
    await writeFile(file, JSON.stringify(original, null, 4) + "\n");
    const [step] = await stepsFor("memory-mcp", [["claude-code", "project"]], r);
    await apply(step!, r);
    const text = await readFile(file, "utf8");
    const doc = JSON.parse(text);
    expect(doc.$schema).toEqual(original.$schema);
    expect(doc.unknownTop).toEqual(original.unknownTop);
    expect(doc.mcpServers.existing).toEqual(original.mcpServers.existing);
    expect(Object.keys(doc.mcpServers)).toEqual(["existing", "memory"]);
    expect(doc.mcpServers.memory).toEqual({ args: ["-y", "@modelcontextprotocol/server-memory"], command: "npx" });
    expect(text.split("\n")[1]).toMatch(/^ {4}"\$schema"/u);
    expect(text.endsWith("}\n")).toBe(true);
  });

  it("AC-032-02 탭 들여쓰기·CRLF·BOM을 유지하고 파일·디렉터리가 없으면 새로 만든다", async () => {
    const r = await roots();
    await mkdir(path.join(r.projectRoot, ".cursor"));
    const cursor = path.join(r.projectRoot, ".cursor", "mcp.json");
    await writeFile(cursor, "\uFEFF{\r\n\t\"mcpServers\": {\r\n\t\t\"a\": {\"command\": \"x\", \"args\": []}\r\n\t}\r\n}\r\n");
    const [cursorStep] = await stepsFor("memory-mcp", [["cursor", "project"]], r);
    await apply(cursorStep!, r);
    const text = await readFile(cursor, "utf8");
    expect(text.startsWith("\uFEFF{\r\n\t\"mcpServers\"")).toBe(true);
    expect(text.replace(/\r\n/gu, "")).not.toContain("\n");
    expect(JSON.parse(text.slice(1)).mcpServers).toMatchObject({ a: { command: "x" }, memory: { command: "npx" } });

    const fresh = await roots();
    const [step] = await stepsFor("memory-mcp", [["claude-code", "project"], ["codex", "project"]], fresh);
    await apply(step!, fresh);
    expect(JSON.parse(await readFile(path.join(fresh.projectRoot, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { memory: { args: ["-y", "@modelcontextprotocol/server-memory"], command: "npx" } } });
  });

  it("AC-032-03 TOML은 블록을 원본 뒤에 덧붙이기만 하고 원본 byte가 prefix이며 smol-toml로 다시 parse된다", async () => {
    const r = await roots();
    await mkdir(path.join(r.projectRoot, ".codex"));
    const file = path.join(r.projectRoot, ".codex", "config.toml");
    const original = '# 주석은 그대로\nmodel = "gpt-x"\n\n[mcp_servers.other]\ncommand = "node"\nargs = ["a.js"] # trailing\n\n[profiles.fast]\nmodel_reasoning_effort = "low"';
    await writeFile(file, original);
    const [step] = await stepsFor("postgres-mcp", [["codex", "project"]], r);
    await apply(step!, r);
    const after = await readFile(file);
    const before = Buffer.from(original, "utf8");
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    const doc = parseToml(after.toString("utf8")) as Record<string, any>;
    expect(doc["mcp_servers"]["postgres"]).toEqual({ command: "uvx", args: ["postgres-mcp", "--access-mode=restricted"], env_vars: ["DATABASE_URI"] });
    expect(doc["mcp_servers"]["other"]).toEqual({ command: "node", args: ["a.js"] });
    expect(doc["profiles"]).toEqual({ fast: { model_reasoning_effort: "low" } });
    expect(after.subarray(before.length).toString("utf8")).toBe('\n\n[mcp_servers.postgres]\ncommand = "uvx"\nargs = ["postgres-mcp", "--access-mode=restricted"]\nenv_vars = ["DATABASE_URI"]\n');
  });

  it("AC-032-03 덧붙인 TOML이 기존 형식과 충돌하면 쓰지 않는다", async () => {
    const r = await roots();
    await mkdir(path.join(r.projectRoot, ".codex"));
    const file = path.join(r.projectRoot, ".codex", "config.toml");
    const inline = 'mcp_servers = { other = { command = "node", args = [] } }\n';
    await writeFile(file, inline);
    const [step] = await stepsFor("memory-mcp", [["codex", "project"]], r);
    await expect(apply(step!, r)).rejects.toMatchObject({ code: "CONFIG_UNPARSEABLE" });
    expect(await readFile(file, "utf8")).toBe(inline);
    await writeFile(file, "this is = = not toml");
    await expect(apply(step!, r)).rejects.toMatchObject({ code: "CONFIG_UNPARSEABLE" });
  });

  it("AC-032-04 같은 key가 있으면 CONFIG_KEY_EXISTS이고 파일에 쓰지 않는다", async () => {
    const r = await roots();
    const json = path.join(r.projectRoot, ".mcp.json");
    await writeFile(json, '{ "mcpServers": { "memory": { "command": "mine" } } }');
    await mkdir(path.join(r.projectRoot, ".codex"));
    const toml = path.join(r.projectRoot, ".codex", "config.toml");
    await writeFile(toml, '[mcp_servers.memory]\ncommand = "mine"\n');
    // Plan 단계에서 이미 막힌다(precondition.keyAbsent=false). v0.2.0: 있는 항목의 Plan 형태 digest(entryDigest)가 표준 항목과 달라 충돌이다.
    const plan = await planWith("memory-mcp", [["claude-code", "project"], ["codex", "project"]], r);
    expect(plan.status).toBe("blocked");
    expect(plan.warnings.filter((w) => w.code === "CONFIG_KEY_EXISTS")).toHaveLength(2);
    const mine = entryPlanDigest({ command: "mine" });
    expect(plan.targets.map((t) => t.precondition)).toEqual([
      { exists: true, fileDigest: fileSha256(await readFile(json)), keyAbsent: false, entryDigest: mine },
      { exists: true, fileDigest: fileSha256(await readFile(toml)), keyAbsent: false, entryDigest: mine },
    ]);
    // 쓰기 직전 다시 확인해도 같은 key면 거부한다.
    const empty = await roots();
    const steps = await stepsFor("memory-mcp", [["claude-code", "project"], ["codex", "project"]], empty);
    for (const step of steps) await expect(apply(step, r)).rejects.toMatchObject({ code: "CONFIG_KEY_EXISTS" });
    expect(await readFile(json, "utf8")).toBe('{ "mcpServers": { "memory": { "command": "mine" } } }');
    expect(await readFile(toml, "utf8")).toBe('[mcp_servers.memory]\ncommand = "mine"\n');
  });

  it("AC-032-05 같은 디렉터리 임시 파일에 쓴 뒤 rename하고 rename 실패를 주입해도 원본 byte가 그대로다", async () => {
    const r = await roots();
    const file = path.join(r.projectRoot, ".mcp.json");
    const original = '{\n  "mcpServers": {}\n}\n';
    await writeFile(file, original);
    const calls: string[] = [];
    const failing: ConfigFs = {
      ...nodeConfigFs,
      writeFile: async (f, d) => (calls.push("write:" + path.relative(r.projectRoot, f).replace(/\\/gu, "/")), nodeConfigFs.writeFile(f, d)),
      rename: async (a, b) => {
        calls.push("rename:" + path.basename(a) + "->" + path.basename(b));
        throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      },
    };
    const [step] = await stepsFor("memory-mcp", [["claude-code", "project"]], r);
    await expect(applyConfigPatch(step!, { ...r, fs: failing, acknowledgements: ["base", "floating-artifact"] })).rejects.toMatchObject({ code: "CONFIG_WRITE_FAILED" });
    expect(await readFile(file, "utf8")).toBe(original);
    expect(calls[0]).toMatch(/^write:\.\.mcp\.json\.openhub-[0-9a-f]{12}\.tmp$/u);
    expect(calls[1]).toMatch(/^rename:\.\.mcp\.json\.openhub-[0-9a-f]{12}\.tmp->\.mcp\.json$/u);
    expect(await listing(r.projectRoot)).toEqual([".mcp.json"]);

    const receipt = await apply(step!, r);
    expect(receipt.original?.toString("utf8")).toBe(original);
    expect(await restoreConfig(receipt)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(original);
    const fresh = await roots();
    const [cursorStep] = await stepsFor("memory-mcp", [["cursor", "project"]], fresh);
    const created = await apply(cursorStep!, fresh);
    expect(created.original).toBeNull();
    expect(await restoreConfig(created)).toBe(true);
    expect(await listing(fresh.projectRoot)).toEqual([]);
  });

  it("AC-032-06 대상 파일이나 상위 디렉터리가 project root·home 밖으로 해석되는 symlink·junction이면 거부한다", async () => {
    const r = await roots();
    const outside = path.join(r.base, "outside");
    await mkdir(outside);
    await symlink(outside, path.join(r.projectRoot, ".cursor"), "junction");
    await symlink(outside, path.join(r.homeDir, ".codex"), "junction");
    await expect(inspectConfigTarget("cursor", "project", "memory", r)).rejects.toMatchObject({ code: "CONFIG_PATH_ESCAPE" });
    const ok = await roots();
    const steps = await stepsFor("memory-mcp", [["cursor", "project"], ["codex", "user"]], ok);
    for (const step of steps) await expect(apply(step, r), step.file).rejects.toMatchObject({ code: "CONFIG_PATH_ESCAPE" });
    expect(await listing(outside)).toEqual([]);
    // root 안을 가리키는 junction은 허용한다.
    const inside = await roots();
    await mkdir(path.join(inside.projectRoot, "real-cursor"));
    await symlink(path.join(inside.projectRoot, "real-cursor"), path.join(inside.projectRoot, ".cursor"), "junction");
    const [cursorStep] = await stepsFor("memory-mcp", [["cursor", "project"]], inside);
    await apply(cursorStep!, inside);
    expect(await listing(path.join(inside.projectRoot, "real-cursor"))).toEqual(["mcp.json"]);
  });

  it("AC-032-07 비밀값은 공식 참조로만 쓰고 테스트 프로세스 env에 실제 값을 넣어도 파일에 0건이다", async () => {
    const secret = "postgresql://admin:Sup3r-Secret-Pw@db.internal:5432/app";
    vi.stubEnv("DATABASE_URI", secret);
    const r = await roots();
    const steps = await stepsFor("postgres-mcp", [["claude-code", "project"], ["cursor", "project"], ["codex", "project"]], r);
    for (const step of steps) await apply(step, r);
    const claude = await readFile(path.join(r.projectRoot, ".mcp.json"), "utf8");
    const cursor = await readFile(path.join(r.projectRoot, ".cursor", "mcp.json"), "utf8");
    const codex = await readFile(path.join(r.projectRoot, ".codex", "config.toml"), "utf8");
    expect(JSON.parse(claude).mcpServers.postgres.env).toEqual({ DATABASE_URI: "$" + "{DATABASE_URI}" });
    expect(JSON.parse(cursor).mcpServers.postgres.env).toEqual({ DATABASE_URI: "$" + "{env:DATABASE_URI}" });
    expect((parseToml(codex) as any).mcp_servers.postgres.env_vars).toEqual(["DATABASE_URI"]);
    expect((parseToml(codex) as any).mcp_servers.postgres.env).toBeUndefined();
    for (const text of [claude, cursor, codex]) {
      expect(text).not.toContain("Sup3r-Secret-Pw");
      expect(text).not.toContain("postgresql://");
    }
  });

  it("AC-032-08 required:false env(CONTEXT7_API_KEY)는 참조를 쓰지 않는다", async () => {
    const r = await roots();
    const steps = await stepsFor("context7", [["claude-code", "project"], ["cursor", "project"], ["codex", "project"]], r);
    for (const step of steps) await apply(step, r);
    const all = [await readFile(path.join(r.projectRoot, ".mcp.json"), "utf8"), await readFile(path.join(r.projectRoot, ".cursor", "mcp.json"), "utf8"), await readFile(path.join(r.projectRoot, ".codex", "config.toml"), "utf8")];
    for (const text of all) {
      expect(text).not.toContain("CONTEXT7_API_KEY");
      expect(text).not.toMatch(/"env"|env_vars/u);
    }
  });

  it("AC-032-09 user scope 대상은 user-scope-config 승인이 없으면 쓰지 않는다", async () => {
    const r = await roots();
    const plan = await planWith("memory-mcp", [["cursor", "user"]], r);
    expect(plan.approvalRequirements).toContain("user-scope-config");
    const [step] = plan.steps.filter((s): s is ConfigPatchStep => s.kind === "config-patch");
    await expect(apply(step!, r, ["base", "floating-artifact"])).rejects.toMatchObject({ code: "USER_SCOPE_NOT_APPROVED" });
    expect(await listing(r.homeDir)).toEqual([]);
    await apply(step!, r);
    expect(await listing(r.homeDir)).toEqual([".cursor", ".cursor/mcp.json"]);
    expect(await listing(r.projectRoot)).toEqual([]);
  });

  it("AC-032-10 config write는 모든 준비 단계가 성공한 뒤에만 일어난다", async () => {
    const r = await roots();
    const order: string[] = [];
    const spawner = (exitCode: number): ExecSpawner =>
      ((executable, args) => {
        order.push("spawn:" + [executable, ...args].join(" "));
        const events = new EventEmitter();
        queueMicrotask(() => events.emit("close", exitCode, null));
        return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
      }) as ExecSpawner;
    const isolatedDir = async () => {
      const dir = await mkdtemp(path.join(scratch, "iso-"));
      return { path: dir, base: scratch, cleanup: () => rm(dir, { recursive: true, force: true }) };
    };
    const run = async (exitCode: number) => {
      const inspected = await inspectConfigTarget("cursor", "project", "github", r);
      const built = buildInstallPlan({ toolId: "github-mcp-server", entries: seed, report: reportFor(clientProfile(), seed), probes: ALL_AVAILABLE, targets: [inspected], platform: "linux" });
      if (!built.ok) throw new Error(built.code);
      const verified = await verifiedPlanOf(built.planned);
      return executeVerifiedPlan(verified, {
        projectRoot: r.projectRoot,
        spawner: spawner(exitCode),
        isolatedDir,
        onConfigStep: async (step) => {
          order.push("write:" + step.file);
          await applyConfigPatch(step, { ...r, acknowledgements: verified.acknowledgements });
          return { id: step.id, status: "done" };
        },
      });
    };
    await run(1);
    expect(order).toEqual(["spawn:docker pull ghcr.io/github/github-mcp-server"]);
    expect(await listing(r.projectRoot)).toEqual([]);
    await run(0);
    expect(order.slice(1)).toEqual(["spawn:docker pull ghcr.io/github/github-mcp-server", "write:.cursor/mcp.json"]);
    expect(JSON.parse(await readFile(path.join(r.projectRoot, ".cursor", "mcp.json"), "utf8")).mcpServers.github.command).toBe("docker");
  });

  it("AC-032-11 공식 형식이 확인되지 않은 client·필드·reference는 쓰지 않고 manual-setup-required를 반환한다", async () => {
    const r = await roots();
    const [cursor] = await stepsFor("postgres-mcp", [["cursor", "project"]], r);
    const [codex] = await stepsFor("postgres-mcp", [["codex", "project"]], r);
    const cases: ConfigPatchStep[] = [
      { ...cursor!, value: { ...cursor!.value, env: { DATABASE_URI: "$" + "{DATABASE_URI}" } } },
      { ...cursor!, value: { ...cursor!.value, env: { DATABASE_URI: "postgresql://u:p@h/db" } } },
      { ...codex!, value: { ...codex!.value, env: { DATABASE_URI: "$" + "{DATABASE_URI}" } } },
      { ...cursor!, value: { ...cursor!.value, url: "https://example.invalid/mcp" } as never },
      { ...cursor!, value: { ...cursor!.value, env_vars: ["DATABASE_URI"] } },
    ];
    for (const step of cases) await expect(apply(step, r)).rejects.toMatchObject({ code: "MANUAL_SETUP_REQUIRED", message: expect.stringContaining("직접") });
    expect(await listing(r.projectRoot)).toEqual([]);
  });

  it("AC-032-12 Windows npx는 세 Client config에 cmd /d /c npx로 기록되고 절대 cmd.exe 경로가 없으며 Probe·Executor는 cmd를 실행하지 않는다", async () => {
    const r = await roots();
    const plan = await planWith("context7", [["claude-code", "project"], ["cursor", "project"], ["codex", "project"]], r, "windows");
    const verified = await verifiedPlanOf({ plan, planDigest: installPlanDigest(plan) });
    const spawned: string[][] = [];
    const spawner = ((executable: string, args: readonly string[]) => {
      spawned.push([executable, ...args]);
      const events = new EventEmitter();
      queueMicrotask(() => events.emit("close", 0, null));
      return { stdout: null, stderr: null, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
    }) as ExecSpawner;
    const report = await executeVerifiedPlan(verified, {
      projectRoot: r.projectRoot,
      spawner,
      onConfigStep: async (step) => (await applyConfigPatch(step, { ...r, acknowledgements: verified.acknowledgements }), { id: step.id, status: "done" }),
    });
    expect(report).toMatchObject({ ok: true, prepared: true });
    expect(spawned).toEqual([]);
    const wrapper = { command: "cmd", args: ["/d", "/c", "npx", "-y", "@upstash/context7-mcp"] };
    const claude = await readFile(path.join(r.projectRoot, ".mcp.json"), "utf8");
    const cursor = await readFile(path.join(r.projectRoot, ".cursor", "mcp.json"), "utf8");
    const codex = await readFile(path.join(r.projectRoot, ".codex", "config.toml"), "utf8");
    expect(JSON.parse(claude).mcpServers.context7).toEqual(wrapper);
    expect(JSON.parse(cursor).mcpServers.context7).toEqual(wrapper);
    expect((parseToml(codex) as any).mcp_servers.context7).toEqual(wrapper);
    for (const text of [claude, cursor, codex]) {
      for (const banned of ["cmd.exe", "System32", "npx.cmd", "C:\\", "C:/"]) expect(text).not.toContain(banned);
    }
    // docker Plan도 Windows에서 docker만 실행한다. Probe·Executor 소스에는 cmd 실행 경로가 없다.
    const docker = await planWith("github-mcp-server", [["cursor", "project"]], await roots(), "windows");
    await executeVerifiedPlan(await verifiedPlanOf({ plan: docker, planDigest: installPlanDigest(docker) }), {
      projectRoot: r.projectRoot,
      spawner,
      isolatedDir: async () => {
        const dir = await mkdtemp(path.join(scratch, "iso-"));
        return { path: dir, base: scratch, cleanup: () => rm(dir, { recursive: true, force: true }) };
      },
    });
    expect(spawned).toEqual([["docker", "pull", "ghcr.io/github/github-mcp-server"]]);
    for (const file of ["probe.ts", "executor.ts"]) {
      const src = (await readFile(path.resolve(import.meta.dirname, "../../src/process", file), "utf8")).replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
      expect(src, file).not.toMatch(/["'`]cmd(?:\.exe)?["'`]|cmd\.exe|["']\/c["']|shell:\s*true/u);
    }
  });

  it("AC-032-13 안전하게 표현할 수 없는 Windows wrapper는 자동 완화하지 않고 manual-setup-required 또는 Plan 차단이다", async () => {
    const r = await roots();
    const [step] = await stepsFor("memory-mcp", [["claude-code", "project"]], r, "windows");
    expect(step!.value).toEqual({ command: "cmd", args: ["/d", "/c", "npx", "-y", "@modelcontextprotocol/server-memory"] });
    const tail = step!.value.args.slice(3);
    const tampered = [
      { command: "C:\\Windows\\System32\\cmd.exe", args: step!.value.args },
      { command: "cmd.exe", args: step!.value.args },
      { command: "npx.cmd", args: tail },
      { command: "cmd", args: ["/s", "/c", "npx", ...tail] },
      { command: "cmd", args: ["/c", "npx", ...tail] },
      { command: "cmd", args: ["/d", "/c", "node", "server.js"] },
      { command: "cmd", args: ["/d", "/c", "npx", "%COMSPEC%"] },
      { command: "cmd", args: ["/d", "/c", "npx", "!VAR!"] },
      { command: "cmd", args: ["/d", "/c", "npx", "pkg^&calc"] },
      { command: "cmd", args: ["/d", "/c", "npx", "pkg & calc"] },
      { command: "cmd", args: ["/d", "/c", "npx"] },
    ];
    for (const value of tampered) {
      await expect(apply({ ...step!, value }, r), JSON.stringify(value)).rejects.toMatchObject({ code: "MANUAL_SETUP_REQUIRED" });
    }
    expect(await listing(r.projectRoot)).toEqual([]);
    // Manifest 쪽에서 들어온 위험 인자는 Plan 단계에서 막힌다(완화해서 쓰지 않는다).
    const memory = entryOf(seed, "memory-mcp");
    const risky = [{ ...memory, manifest: { ...memory.manifest, install: { preferredAdapter: "npx" as const, options: { command: "npx -y pkg %COMSPEC%" }, fallback: [] } } }, ...seed.filter((e) => e !== memory)];
    const blocked = buildInstallPlan({ toolId: "memory-mcp", entries: risky, report: reportFor(clientProfile(), risky), probes: ALL_AVAILABLE, targets: [await inspectConfigTarget("claude-code", "project", "memory", r)], platform: "windows" });
    expect(blocked).toMatchObject({ ok: false, code: "MANIFEST_COMMAND_REJECTED" });
  });
});
