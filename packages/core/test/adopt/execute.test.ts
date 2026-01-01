import { readFileSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  commitLifecycleState,
  executeAdopt,
  formatAdoptResult,
  formatLifecycleStatusItem,
  lifecycleStatus,
  nodeConfigFs,
  planAdopt,
  planLifecycle,
  readLifecycleState,
  requestAdoptApproval,
  type AdoptApprovalRequirement,
  type AdoptPlanOptions,
  type ConfigFs,
  type PlannedAdopt,
  type RegistryEntry,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { newScratch, stateOf, toolState } from "../lifecycle/helpers";
import { MEMORY, adoptOptions, mcp, newCase, plannedOf, type Case } from "./helpers";

/** TASK-060 Adopt 실행: 승인 검증 → Version State write 1회. 임시 project·home만 쓴다. */
const seed = await seedEntries();
const scratch = await newScratch("adopt-execute-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const NOW = () => new Date("2026-10-07T01:02:03.000Z");
const stateFile = (c: Case) => path.join(c.homeDir, ".openhub", "state", "lifecycle.json");
const exists = async (f: string) => readFile(f).then(() => true, () => false);

async function approve(p: PlannedAdopt, skip: readonly AdoptApprovalRequirement[] = []) {
  const outcome = await requestAdoptApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id).filter((id) => !skip.includes(id)) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  return outcome.approval;
}
async function prepared(files: Record<string, unknown>, over: Partial<AdoptPlanOptions> = {}, skip: readonly AdoptApprovalRequirement[] = []) {
  const c = await newCase(scratch, files);
  const options = adoptOptions(seed, c, over);
  const p = plannedOf(await planAdopt(options));
  return { c, options, p, approval: await approve(p, skip) };
}
const exec = (approval: Awaited<ReturnType<typeof approve>>, options: AdoptPlanOptions, regen: Partial<AdoptPlanOptions> = {}, fs?: ConfigFs) =>
  executeAdopt(approval, { toolId: options.toolId, homeDir: options.homeDir, now: NOW, regenerate: () => planAdopt({ ...options, ...regen }), ...(fs === undefined ? {} : { fs }) });
const strongFiles = { ".mcp.json": mcp({ "my-memory": { command: "npx", args: ["-y", MEMORY] } }) };
const exactFiles = { ".mcp.json": mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] } }) };
const withManifest = (toolId: string, edit: (m: RegistryEntry["manifest"]) => void): RegistryEntry[] =>
  seed.map((e) => {
    if (e.manifest.name !== toolId) return e;
    const copy = structuredClone(e);
    edit(copy.manifest);
    return copy;
  });

describe("REQ-063 Adopt 실행", () => {
  it("AC-060-01 승인된 Plan 실행은 Version State write 1회이고 config 변화·spawn·fetch가 0이다", async () => {
    const { c, options, approval } = await prepared(exactFiles);
    const config = await readFile(path.join(c.projectRoot, ".mcp.json"));
    const written: string[] = [];
    const fs: ConfigFs = { ...nodeConfigFs, writeFile: async (f, d) => (written.push(f), nodeConfigFs.writeFile(f, d)), rename: async (a, b) => (written.push(b), nodeConfigFs.rename(a, b)) };
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const r = await exec(approval, options, {}, fs);
    expect(r.status).toBe("adopted");
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
    expect(await readFile(path.join(c.projectRoot, ".mcp.json"))).toEqual(config);
    expect(written.filter((f) => !f.endsWith(".tmp") && !f.includes(".tmp-")).map((f) => path.relative(c.homeDir, f))).toEqual([path.join(".openhub", "state", "lifecycle.json")]);
    for (const f of ["plan.ts", "execute.ts", "preview.ts"]) {
      const src = readFileSync(path.join(import.meta.dirname, "../../src/adopt", f), "utf8");
      // 자식 프로세스 모듈 import·환경변수 읽기·fetch 호출이 없다(문자열은 AC-031-09 검사와 겹치지 않게 조립한다).
      expect(src, f).not.toMatch(new RegExp('from "node:' + "child_" + 'process"|process\\.env[.[]|\\bfetch\\(', "u"));
    }
  });

  it("AC-060-02 새 entry는 revision 1·previous null·lastHealth null·Plan digest·현재 항목 digest·기존 서버 이름이다", async () => {
    const { options, p, approval } = await prepared(strongFiles, {}, []);
    const r = await exec(approval, options);
    expect(r).toMatchObject({ status: "adopted", revision: 1, planDigest: p.planDigest, entryKey: p.plan.target.entryKey });
    const read = await readLifecycleState({ homeDir: options.homeDir });
    if (!read.ok) throw new Error(read.code);
    const s = read.state.entries[p.plan.target.entryKey]!;
    expect(s).toMatchObject({ toolId: "memory-mcp", revision: 1, previous: null, lastHealth: null, appliedPlanDigest: p.planDigest, backend: "npx" });
    expect(s.target.serverName).toBe("my-memory");
    expect(s.config.entryDigest).toBe(p.plan.precondition.entryDigest);
    expect(s.artifact).toEqual({ requested: MEMORY, resolved: null });
    expect(formatAdoptResult(r).join("\n")).toContain("Not verified");
  });

  it("AC-060-03 승인 후 config 항목이 바뀌면 PLAN_STALE(config-entry)이고 state write 0이다", async () => {
    const { c, options, approval } = await prepared(exactFiles);
    await writeFile(path.join(c.projectRoot, ".mcp.json"), JSON.stringify(mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.4"] } }), null, 2) + "\n");
    const r = await exec(approval, options);
    expect(r.status).toBe("stale");
    expect(r.changed).toContain("config-entry");
    expect(await exists(stateFile(c))).toBe(false);
  });

  it("AC-060-04 같은 파일의 다른 내용만 바뀌어도 PLAN_STALE(config-file)이고 state write 0이다", async () => {
    const { c, options, approval } = await prepared(exactFiles);
    await writeFile(path.join(c.projectRoot, ".mcp.json"), JSON.stringify(mcp({ memory: { command: "npx", args: ["-y", MEMORY + "@1.2.3"] }, other: { command: "npx", args: ["-y", "x"] } }), null, 2) + "\n");
    const r = await exec(approval, options);
    expect(r).toMatchObject({ status: "stale", changed: ["config-file"] });
    expect(await exists(stateFile(c))).toBe(false);
  });

  it("AC-060-05 identity·registry·manifest·target이 바뀌면 PLAN_STALE(해당 항목)이고 state write 0이다", async () => {
    const cases: [Partial<AdoptPlanOptions>, string][] = [
      [{ entries: withManifest("memory-mcp", (m) => void (m.recommendation!.identity = { mcpServerNames: ["my-memory"] })) }, "identity"],
      [{ entries: withManifest("context7", (m) => void (m.summary = "changed")) }, "registry"],
      [{ entries: withManifest("memory-mcp", (m) => void (m.summary = "changed")) }, "manifest"],
      [{ platform: "macos" }, "target"],
    ];
    for (const [regen, kind] of cases) {
      const { c, options, approval } = await prepared(strongFiles);
      const r = await exec(approval, options, regen);
      expect(r.status, kind).toBe("stale");
      expect(r.changed, kind).toContain(kind);
      expect(await exists(stateFile(c)), kind).toBe(false);
    }
  });

  it("AC-060-06 승인과 실행 사이에 같은 EntryKey가 생기면 PLAN_STALE(state-present)이고 기존 entry는 그대로다", async () => {
    const { c, options, p, approval } = await prepared(exactFiles);
    const other = toolState({ target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "memory", projectName: "project", projectKey: p.plan.target.projectKey } });
    expect(await commitLifecycleState(stateOf(other), null, { homeDir: c.homeDir })).toMatchObject({ ok: true });
    const before = await readFile(stateFile(c));
    const r = await exec(approval, options);
    expect(r).toMatchObject({ status: "stale" });
    expect(r.changed).toContain("state-present");
    expect(await readFile(stateFile(c))).toEqual(before);
  });

  it("AC-060-07 Approval 재사용은 APPROVAL_CONSUMED, strong 확인 누락은 APPROVAL_INCOMPLETE이며 state write 0이다", async () => {
    const a = await prepared(exactFiles);
    expect((await exec(a.approval, a.options)).status).toBe("adopted");
    const again = await exec(a.approval, a.options);
    expect(again).toMatchObject({ status: "blocked", error: { code: "APPROVAL_CONSUMED" } });
    const s = await prepared(strongFiles, {}, ["identity-strong-match"]);
    const r = await exec(s.approval, s.options);
    expect(r).toMatchObject({ status: "blocked", error: { code: "APPROVAL_INCOMPLETE" } });
    expect(await exists(stateFile(s.c))).toBe(false);
  });

  it("AC-060-08 adopt 후 status는 state-consistent·artifact lock·Health 미확인이고 이후 변경은 config-drift·missing-config다", async () => {
    const { c, options, approval } = await prepared(strongFiles);
    expect((await exec(approval, options)).status).toBe("adopted");
    const status = async () => {
      const s = await lifecycleStatus({ projectRoot: c.projectRoot, homeDir: c.homeDir, entries: seed, platform: "linux", includeUser: false });
      if (!s.ok) throw new Error(s.code);
      return s.items.find((i) => i.serverName === "my-memory")!;
    };
    const item = await status();
    expect(item).toMatchObject({ toolId: "memory-mcp", state: "state-consistent", revision: 1, artifact: { lock: "artifact-unlocked" } });
    expect(item.health).not.toBe("healthy");
    expect(formatLifecycleStatusItem(item).join("\n")).toContain("아직 확인하지 않음");
    await writeFile(path.join(c.projectRoot, ".mcp.json"), JSON.stringify(mcp({ "my-memory": { command: "npx", args: ["-y", MEMORY, "--x"] } }), null, 2) + "\n");
    expect((await status()).state).toBe("config-drift");
    await writeFile(path.join(c.projectRoot, ".mcp.json"), JSON.stringify(mcp({}), null, 2) + "\n");
    expect((await status()).state).toBe("missing-config");
  });

  it("AC-060-09 adopt한 entry는 M5 update 대상이 되고 previous가 없어 rollback은 막힌다", async () => {
    const { c, options, approval } = await prepared(strongFiles);
    expect((await exec(approval, options)).status).toBe("adopted");
    const fetch = vi.fn(async (url: string) =>
      url === "https://registry.npmjs.org/@modelcontextprotocol%2fserver-memory/latest" ? new Response(JSON.stringify({ name: MEMORY, version: "1.2.3" }), { status: 200 }) : new Response("missing", { status: 404 }),
    );
    const base = { toolId: "memory-mcp", projectRoot: c.projectRoot, homeDir: c.homeDir, entries: seed, platform: "linux" as const, includeUser: false, fetch };
    const update = await planLifecycle({ ...base, operation: "update" });
    if (!update.ok) throw new Error(update.code);
    expect(update.planned.plan.status).toBe("ready");
    expect(update.planned.plan.steps[0]).toMatchObject({ kind: "config-replace", path: ["mcpServers", "my-memory"] });
    expect(await planLifecycle({ ...base, operation: "rollback" })).toMatchObject({ ok: false, code: "NO_ROLLBACK_TARGET" });
  });

  it("AC-060-10 state가 손상됐거나 쓸 수 없으면 failed이고 부분 쓰기 없이 config는 그대로다", async () => {
    const a = await prepared(exactFiles);
    const config = await readFile(path.join(a.c.projectRoot, ".mcp.json"));
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path.dirname(stateFile(a.c)), { recursive: true });
    await writeFile(stateFile(a.c), "{ not json");
    const corrupt = await exec(a.approval, a.options);
    expect(corrupt).toMatchObject({ status: "failed", error: { code: "STATE_CORRUPT" } });
    expect(await readFile(stateFile(a.c), "utf8")).toBe("{ not json");
    expect(await readFile(path.join(a.c.projectRoot, ".mcp.json"))).toEqual(config);

    const b = await prepared(exactFiles);
    const failing: ConfigFs = { ...nodeConfigFs, rename: async () => Promise.reject(new Error("EPERM")) };
    const r = await exec(b.approval, b.options, {}, failing);
    expect(r).toMatchObject({ status: "failed", error: { code: "STATE_WRITE_FAILED" } });
    expect(await exists(stateFile(b.c))).toBe(false);
  });
});

