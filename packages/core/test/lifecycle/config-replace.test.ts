import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  configEntryDigest,
  planLifecycle,
  readLifecycleState,
  recordInstallInState,
  replaceConfigEntry,
  restoreConfig,
  runInstallTransaction,
  type ConfigReplaceStep,
  type InstallRequest,
  type LifecyclePlanOptions,
  type ToolState,
} from "../../src/index";
import { approveAll, createHarness, plannedOf, type Harness } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";
import { newScratch } from "./helpers";

/** TASK-042 Config 교체 writer. M4 설치로 만든 실제 config 파일을 LifecyclePlan의 config-replace 단계로 바꾼다. */
const seed = await seedEntries();
const scratch = await newScratch("config-replace-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());
const NOW = () => new Date("2026-10-07T01:02:03.000Z");

function registry() {
  return vi.fn(async (url: string) => {
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: "1.2.3" });
    if (url === "https://pypi.org/pypi/postgres-mcp/json") return json({ info: { name: "postgres-mcp", version: "0.3.0" } });
    return new Response("missing", { status: 404 });
  });
}
async function installed(h: Harness, toolId: string, targets: InstallRequest["targets"], platform: "linux" | "windows" = "linux") {
  const request = { ...h.request(toolId, targets), platform };
  const planned = await plannedOf(h, request);
  const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
  expect(result.status).toBe("succeeded");
  expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: NOW })).toMatchObject({ ok: true });
}
async function stepsFor(h: Harness, over: Partial<LifecyclePlanOptions> = {}) {
  const r = await planLifecycle({ operation: "update", toolId: "memory-mcp", projectRoot: h.projectRoot, homeDir: h.homeDir, entries: seed, platform: "linux", includeUser: false, fetch: registry(), ...over });
  if (!r.ok) throw new Error(r.code);
  expect(r.planned.plan.status).toBe("ready");
  return r.planned.plan.steps.filter((s): s is ConfigReplaceStep => s.kind === "config-replace");
}
async function stateEntry(h: Harness, client: string): Promise<ToolState> {
  const r = await readLifecycleState({ homeDir: h.homeDir });
  if (!r.ok) throw new Error(r.code);
  return Object.values(r.state.entries).find((e) => e.target.client === client)!;
}
const roots = (h: Harness, acknowledgements: string[] = ["base"]) => ({ projectRoot: h.projectRoot, homeDir: h.homeDir, fs: h.env.configFs!, acknowledgements });
const MEMORY_123 = { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@1.2.3"] };

describe("REQ-040 Config 교체 writer", () => {
  it("AC-042-01 JSON은 entryDigest가 같을 때만 mcpServers.<alias>를 바꾸고 나머지 key·순서·들여쓰기·줄바꿈을 유지한다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const before = { $schema: "x", mcpServers: { zeta: { command: "node", args: ["z.js"], extra: { keep: true } } }, trailingKey: [1, 2] };
    await writeFile(path.join(h.projectRoot, ".mcp.json"), JSON.stringify(before, null, 4).replace(/\n/gu, "\r\n") + "\r\n");
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const installedText = await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8");
    const [step] = await stepsFor(h);
    const r = await replaceConfigEntry(step!, roots(h));
    expect(r.ok).toBe(true);
    const text = await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8");
    const doc = JSON.parse(text);
    expect(doc.mcpServers.memory).toEqual(MEMORY_123);
    expect(Object.keys(doc)).toEqual(Object.keys(JSON.parse(installedText)));
    expect(Object.keys(doc.mcpServers)).toEqual(["zeta", "memory"]);
    expect({ ...doc, mcpServers: { zeta: doc.mcpServers.zeta } }).toEqual(before);
    expect(text).toContain('\r\n    "mcpServers": {\r\n        "zeta"');
    expect(text.endsWith("}\r\n")).toBe(true);
    expect(text.replace(/\r\n/gu, "\n").split("\n").length).toBe(installedText.replace(/\r\n/gu, "\n").split("\n").length);
  });

  it("AC-042-02 TOML은 OpenHub block이 정확히 1회 있을 때만 그 block만 바꾸고 나머지 byte는 같다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await mkdir(path.join(h.projectRoot, ".codex"));
    const head = '# 내 설정\nmodel = "o3"\n\n[mcp_servers.other]\ncommand = "node"\nargs = ["o.js"]\n';
    await writeFile(path.join(h.projectRoot, ".codex", "config.toml"), head);
    await installed(h, "postgres-mcp", [{ client: "codex", scope: "project" }]);
    const file = path.join(h.projectRoot, ".codex", "config.toml");
    const before = await readFile(file, "utf8");
    const [step] = await stepsFor(h, { toolId: "postgres-mcp" });
    const state = await stateEntry(h, "codex");
    const r = await replaceConfigEntry(step!, { ...roots(h), expectedBlockDigest: state.config.tomlBlockDigest });
    expect(r.ok).toBe(true);
    const after = await readFile(file, "utf8");
    const oldBlock = '[mcp_servers.postgres]\ncommand = "uvx"\nargs = ["postgres-mcp", "--access-mode=restricted"]\nenv_vars = ["DATABASE_URI"]\n';
    const newBlock = '[mcp_servers.postgres]\ncommand = "uvx"\nargs = ["postgres-mcp==0.3.0", "--access-mode=restricted"]\nenv_vars = ["DATABASE_URI"]\n';
    expect(before.endsWith(oldBlock)).toBe(true);
    expect(after).toBe(before.replace(oldBlock, newBlock));
    expect(after.startsWith(head)).toBe(true);
  });

  it("AC-042-03 precondition이 다르거나 block이 0회·2회 이상이면 CONFIG_DRIFT이고 write 0회다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const [step] = await stepsFor(h);
    const mcp = path.join(h.projectRoot, ".mcp.json");
    const original = await readFile(mcp, "utf8");
    await writeFile(mcp, original.replace('"-y"', '"--yes"'));
    h.reset();
    expect(await replaceConfigEntry(step!, roots(h))).toMatchObject({ ok: false, code: "CONFIG_DRIFT" });
    expect(h.writes).toEqual([]);

    const c = await createHarness(scratch, { entries: seed });
    await installed(c, "postgres-mcp", [{ client: "codex", scope: "project" }]);
    const [codexStep] = await stepsFor(c, { toolId: "postgres-mcp" });
    const digest = (await stateEntry(c, "codex")).config.tomlBlockDigest;
    const file = path.join(c.projectRoot, ".codex", "config.toml");
    const block = await readFile(file, "utf8");
    // 0회: 같은 의미지만 OpenHub가 쓴 byte가 아니다(줄 나눔).
    await writeFile(file, block.replace('args = ["postgres-mcp", "--access-mode=restricted"]', 'args = [\n  "postgres-mcp",\n  "--access-mode=restricted",\n]'));
    c.reset();
    const zero = await replaceConfigEntry(codexStep!, { ...roots(c), expectedBlockDigest: digest });
    expect(zero).toMatchObject({ ok: false, code: "CONFIG_DRIFT" });
    expect(!zero.ok && zero.message).toContain("0회");
    // 2회: 같은 block byte가 여러 줄 문자열 안에 한 번 더 있다.
    await writeFile(file, "notes = '''\n" + block + "'''\n" + block);
    const two = await replaceConfigEntry(codexStep!, { ...roots(c), expectedBlockDigest: digest });
    expect(!two.ok && two.message).toContain("2회");
    // Version State의 block digest와 다르다.
    await writeFile(file, block);
    expect(await replaceConfigEntry(codexStep!, { ...roots(c), expectedBlockDigest: "sha256:" + "0".repeat(64) })).toMatchObject({ ok: false, code: "CONFIG_DRIFT" });
    expect(c.writes.filter((w) => !w.startsWith("mkdir"))).toEqual([]);
  });

  it("AC-042-04 같은 디렉터리 임시 파일 → rename으로 쓰고 영수증으로 원본 byte를 되돌린다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const [step] = await stepsFor(h);
    const file = path.join(h.projectRoot, ".mcp.json");
    const original = await readFile(file);
    h.reset();
    const r = await replaceConfigEntry(step!, roots(h));
    if (!r.ok) throw new Error(r.code);
    expect(h.writes).toHaveLength(2);
    expect(h.writes[0]).toMatch(/^write:project\/\.\.mcp\.json\.openhub-[0-9a-f]{12}\.tmp$/u);
    expect(h.writes[1]).toBe("rename:project/.mcp.json");
    expect(r.receipt.original?.equals(original)).toBe(true);
    expect(await restoreConfig(r.receipt, h.env.configFs)).toBe(true);
    expect((await readFile(file)).equals(original)).toBe(true);
  });

  it("AC-042-05 D-013 allowlist 밖(~/.claude.json 포함)은 manual-setup-required이고 write 0회다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "claude-code", scope: "project" }]);
    const [step] = await stepsFor(h);
    h.reset();
    for (const forged of [
      { ...step!, scope: "user" as const, file: "~/.claude.json" },
      { ...step!, file: "../.mcp.json" },
      { ...step!, path: ["servers", "memory"] },
    ]) {
      expect(await replaceConfigEntry(forged, roots(h, ["base", "user-scope-config"]))).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    }
    const user = { ...step!, client: "cursor" as const, scope: "user" as const, file: "~/.cursor/mcp.json" };
    expect(await replaceConfigEntry(user, roots(h))).toMatchObject({ ok: false, code: "USER_SCOPE_NOT_APPROVED" });
    expect(h.writes).toEqual([]);
  });

  it("AC-042-06 Windows npx 항목은 교체 후에도 cmd /d /c npx이고 D-016 검증을 통과하지 못하면 write 0회다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "memory-mcp", [{ client: "cursor", scope: "project" }], "windows");
    const [step] = await stepsFor(h, { platform: "windows" });
    expect(step!.value).toEqual({ command: "cmd", args: ["/d", "/c", "npx", "-y", "@modelcontextprotocol/server-memory@1.2.3"] });
    h.reset();
    for (const bad of ["%COMSPEC%", "!VAR!", "^&calc", "a&b"]) {
      const forged = { ...step!, value: { command: "cmd", args: ["/d", "/c", "npx", "-y", bad] } };
      expect(await replaceConfigEntry(forged, roots(h)), bad).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    }
    expect(await replaceConfigEntry({ ...step!, value: { command: "cmd", args: ["/c", "npx", "-y", "x@1.0.0"] } }, roots(h))).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    expect(h.writes).toEqual([]);
    expect((await replaceConfigEntry(step!, roots(h))).ok).toBe(true);
    const doc = JSON.parse(await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8"));
    expect(doc.mcpServers.memory).toEqual({ command: "cmd", args: ["/d", "/c", "npx", "-y", "@modelcontextprotocol/server-memory@1.2.3"] });
  });

  it("AC-042-07 대상 파일·상위 디렉터리가 project root·home 밖으로 해석되는 symlink·junction이면 거부한다", async () => {
    const h = await createHarness(scratch, { entries: seed });
    const outside = await mkdtemp(path.join(scratch, "outside-"));
    const entry = { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] };
    await writeFile(path.join(outside, "mcp.json"), JSON.stringify({ mcpServers: { memory: entry } }));
    await writeFile(path.join(outside, "config.toml"), '[mcp_servers.memory]\ncommand = "npx"\nargs = ["-y", "@modelcontextprotocol/server-memory"]\n');
    await symlink(outside, path.join(h.projectRoot, ".cursor"), "junction");
    await symlink(outside, path.join(h.homeDir, ".codex"), "junction");
    const base = { id: "config", kind: "config-replace" as const, expectedEntryDigest: configEntryDigest(entry), value: MEMORY_123 };
    h.reset();
    const cursor = await replaceConfigEntry({ ...base, client: "cursor", scope: "project", file: ".cursor/mcp.json", path: ["mcpServers", "memory"] }, roots(h));
    const codex = await replaceConfigEntry({ ...base, client: "codex", scope: "user", file: "~/.codex/config.toml", path: ["mcp_servers", "memory"] }, roots(h, ["base", "user-scope-config"]));
    expect([cursor, codex]).toMatchObject([{ ok: false, code: "CONFIG_PATH_ESCAPE" }, { ok: false, code: "CONFIG_PATH_ESCAPE" }]);
    expect(h.writes).toEqual([]);
    expect(JSON.parse(await readFile(path.join(outside, "mcp.json"), "utf8")).mcpServers.memory).toEqual(entry);
  });

  it("AC-042-08 env는 Client별 참조 문법으로만 쓰고 실제 env 값은 파일에 0건이다", async () => {
    const secret = "postgresql://admin:Rotated-Secret-9@db.internal:5432/app";
    vi.stubEnv("DATABASE_URI", secret);
    const h = await createHarness(scratch, { entries: seed });
    await installed(h, "postgres-mcp", [
      { client: "claude-code", scope: "project" },
      { client: "codex", scope: "project" },
      { client: "cursor", scope: "project" },
    ]);
    const steps = await stepsFor(h, { toolId: "postgres-mcp" });
    for (const step of steps) {
      const state = await stateEntry(h, step.client);
      expect((await replaceConfigEntry(step, { ...roots(h), expectedBlockDigest: state.config.tomlBlockDigest })).ok, step.client).toBe(true);
    }
    const claude = await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8");
    const cursor = await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8");
    const codex = await readFile(path.join(h.projectRoot, ".codex", "config.toml"), "utf8");
    expect(JSON.parse(claude).mcpServers.postgres.env).toEqual({ DATABASE_URI: "$" + "{DATABASE_URI}" });
    expect(JSON.parse(cursor).mcpServers.postgres.env).toEqual({ DATABASE_URI: "$" + "{env:DATABASE_URI}" });
    expect(codex).toContain('env_vars = ["DATABASE_URI"]');
    for (const text of [claude, cursor, codex]) {
      expect(text).toContain("postgres-mcp==0.3.0");
      expect(text).not.toContain("Rotated-Secret-9");
    }
  });
});

