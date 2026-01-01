import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import {
  LIFECYCLE_STATE_LOGICAL_PATH,
  commitLifecycleState,
  entryKeyOf,
  lifecycleStateFileSchema,
  nodeConfigFs,
  projectKeyFor,
  readLifecycleState,
  serializeLifecycleState,
  stateBytesDigest,
  type ConfigFs,
  type LifecycleStateFile,
} from "../../src/index";
import { homeIn, newScratch, stateOf, toolState } from "./helpers";

const scratch = await newScratch("state-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));
afterEach(() => vi.unstubAllEnvs());

const stateFile = (home: string) => path.join(home, ".openhub", "state", "lifecycle.json");
const userEntry = toolState({ target: { client: "cursor", scope: "user", file: "~/.cursor/mcp.json", serverName: "context7", projectName: null, projectKey: null }, toolId: "context7" });

function recordingFs(writes: string[], failRename = false): ConfigFs {
  return {
    ...nodeConfigFs,
    writeFile: async (f, d) => (writes.push("write:" + path.basename(f)), nodeConfigFs.writeFile(f, d)),
    rename: async (a, b) => {
      writes.push("rename:" + path.basename(b));
      if (failRename) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return nodeConfigFs.rename(a, b);
    },
    mkdir: async (d) => (writes.push("mkdir:" + path.basename(d)), nodeConfigFs.mkdir(d)),
  };
}

describe("REQ-043 Version State v1 저장소", () => {
  it("AC-037-01 lifecycleStateSchema는 strict이고 schemaVersion 1만 받으며 모르는 key를 거부한다", () => {
    const valid = stateOf(toolState(), userEntry);
    expect(lifecycleStateFileSchema.parse(valid)).toEqual(valid);
    const entry = valid.entries[entryKeyOf(toolState().target)]!;
    const bad: unknown[] = [
      { ...valid, extra: true },
      { ...valid, schemaVersion: 2 },
      { ...valid, entries: { [entryKeyOf(entry.target)]: { ...entry, healthy: true } } },
      { ...valid, entries: { [entryKeyOf(entry.target)]: { ...entry, target: { ...entry.target, absolutePath: "x" } } } },
      { ...valid, entries: { "wrong-key": entry } },
      { ...valid, entries: { [entryKeyOf(entry.target)]: { ...entry, target: { ...entry.target, projectKey: null } } } },
    ];
    for (const b of bad) expect(lifecycleStateFileSchema.safeParse(b).success).toBe(false);
  });

  it("AC-037-02 같은 state를 5번 직렬화하면 byte가 같고 entry 삽입 순서와 무관하다", () => {
    const a = stateOf(toolState(), userEntry);
    const b = stateOf(userEntry, toolState());
    const outs = [...Array.from({ length: 5 }, () => serializeLifecycleState(a)), serializeLifecycleState(b)];
    expect(new Set(outs).size).toBe(1);
    const keys = Object.keys(JSON.parse(outs[0]!).entries);
    expect(keys).toEqual([...keys].sort());
    expect(outs[0]!.endsWith("}\n")).toBe(true);
  });

  it("AC-037-03 저장 경로는 home/.openhub/state/lifecycle.json이고 임시 파일 → rename으로 쓴다", async () => {
    const home = await homeIn(scratch);
    const writes: string[] = [];
    const first = await commitLifecycleState(stateOf(toolState()), null, { homeDir: home, fs: recordingFs(writes) });
    expect(first.ok).toBe(true);
    expect(LIFECYCLE_STATE_LOGICAL_PATH).toBe("~/.openhub/state/lifecycle.json");
    expect(writes.map((w) => w.replace(/openhub-[0-9a-f]{12}\.tmp$/u, "TMP"))).toEqual(["mkdir:.openhub", "mkdir:state", "write:.lifecycle.json.TMP", "rename:lifecycle.json"]);
    expect(serializeLifecycleState(stateOf(toolState()))).toBe(await readFile(stateFile(home), "utf8"));
  });

  it("AC-037-03 rename 실패를 주입해도 원본 byte가 그대로이고 임시 파일이 남지 않는다", async () => {
    const home = await homeIn(scratch);
    const ok = await commitLifecycleState(stateOf(toolState()), null, { homeDir: home });
    if (!ok.ok) throw new Error(ok.code);
    const before = await readFile(stateFile(home));
    const failed = await commitLifecycleState(stateOf(toolState(), userEntry), ok.digest, { homeDir: home, fs: recordingFs([], true) });
    expect(failed).toMatchObject({ ok: false, code: "STATE_WRITE_FAILED" });
    expect((await readFile(stateFile(home))).equals(before)).toBe(true);
    expect((await readdir(path.dirname(stateFile(home)))).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("AC-037-04 JSON 해석 실패는 STATE_CORRUPT이고 파일은 그대로이며 write 0회다", async () => {
    const home = await homeIn(scratch);
    await mkdir(path.dirname(stateFile(home)), { recursive: true });
    await writeFile(stateFile(home), '{ "schemaVersion": 1, "kind": ');
    const writes: string[] = [];
    expect(await readLifecycleState({ homeDir: home, fs: recordingFs(writes) })).toMatchObject({ ok: false, code: "STATE_CORRUPT" });
    expect(writes).toEqual([]);
    expect(await readFile(stateFile(home), "utf8")).toBe('{ "schemaVersion": 1, "kind": ');
  });

  it("AC-037-04 schemaVersion 1이어도 unknown field나 schema 위반이면 STATE_CORRUPT다", async () => {
    const home = await homeIn(scratch);
    await mkdir(path.dirname(stateFile(home)), { recursive: true });
    const doc = JSON.parse(serializeLifecycleState(stateOf(toolState())));
    await writeFile(stateFile(home), JSON.stringify({ ...doc, futureField: 1 }));
    expect(await readLifecycleState({ homeDir: home })).toMatchObject({ ok: false, code: "STATE_CORRUPT" });
  });

  it("AC-037-05 schemaVersion 2 파일은 STATE_VERSION_UNSUPPORTED이고 write 0회다", async () => {
    const home = await homeIn(scratch);
    await mkdir(path.dirname(stateFile(home)), { recursive: true });
    const original = JSON.stringify({ schemaVersion: 2, kind: "openhub-lifecycle-state", entries: {}, newShape: true });
    await writeFile(stateFile(home), original);
    const writes: string[] = [];
    expect(await readLifecycleState({ homeDir: home, fs: recordingFs(writes) })).toMatchObject({ ok: false, code: "STATE_VERSION_UNSUPPORTED" });
    expect(writes).toEqual([]);
    expect(await readFile(stateFile(home), "utf8")).toBe(original);
  });

  it("AC-037-06 token·URL credential·절대 경로가 든 entry는 거부되고 env 값이 직렬화 결과에 0건이다", async () => {
    const secret = "postgresql://admin:S3cret-Pw@db.internal:5432/app";
    vi.stubEnv("DATABASE_URI", secret);
    const leaks: Partial<Parameters<typeof toolState>[0]>[] = [
      { launch: { platform: "linux", clientSpec: { command: "npx", args: ["-y", "pkg", "ghp_" + "x".repeat(36)] } } },
      { artifact: { requested: "https://user:pw@registry.example/pkg", resolved: null } },
      { target: { client: "claude-code", scope: "project", file: "C:\\Users\\someone\\.mcp.json", serverName: "memory", projectName: "demo", projectKey: "0123456789abcdef" } },
      { target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "memory", projectName: "/home/someone/demo", projectKey: "0123456789abcdef" } },
    ];
    for (const over of leaks) expect(lifecycleStateFileSchema.safeParse(stateOf(toolState(over))).success).toBe(false);
    const home = await homeIn(scratch);
    const writes: string[] = [];
    const bad = await commitLifecycleState(stateOf(toolState(leaks[0])), null, { homeDir: home, fs: recordingFs(writes) });
    expect(bad).toMatchObject({ ok: false, code: "STATE_INVALID" });
    expect(writes).toEqual([]);
    const good = serializeLifecycleState(stateOf(toolState({ artifact: { requested: "postgres-mcp", resolved: null } })));
    expect(good).not.toContain("S3cret-Pw");
    expect(good).not.toContain("postgresql://");
  });

  it("AC-037-07 읽은 뒤 다른 writer가 파일을 바꾸면 STATE_CONFLICT이고 write 0회다", async () => {
    const home = await homeIn(scratch);
    const first = await commitLifecycleState(stateOf(toolState()), null, { homeDir: home });
    if (!first.ok) throw new Error(first.code);
    const read = await readLifecycleState({ homeDir: home });
    if (!read.ok) throw new Error(read.code);
    const other = await commitLifecycleState(stateOf(toolState(), userEntry), read.digest, { homeDir: home });
    expect(other.ok).toBe(true);
    const afterOther = await readFile(stateFile(home));
    const writes: string[] = [];
    const mine = await commitLifecycleState(stateOf(toolState({ revision: 2 })), read.digest, { homeDir: home, fs: recordingFs(writes) });
    expect(mine).toMatchObject({ ok: false, code: "STATE_CONFLICT" });
    expect(writes).toEqual([]);
    expect((await readFile(stateFile(home))).equals(afterOther)).toBe(true);
    expect(await commitLifecycleState(stateOf(toolState()), null, { homeDir: home })).toMatchObject({ ok: false, code: "STATE_CONFLICT" });
  });

  it("AC-037-08 commit마다 직전 정상 파일을 .bak 1세대로 남기고 projectKey만 있으며 경로 문자열이 0건이다", async () => {
    const home = await homeIn(scratch);
    const projectRoot = path.join(scratch, "projects", "demo-app");
    await mkdir(projectRoot, { recursive: true });
    const key = await projectKeyFor(projectRoot);
    expect(key).toMatch(/^[0-9a-f]{16}$/u);
    expect(await projectKeyFor(path.join(projectRoot, "."))).toBe(key);
    const entry = (rev: number) => toolState({ revision: rev, target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "memory", projectName: "demo-app", projectKey: key } });
    let digest: string | null = null;
    const bytes: string[] = [];
    for (const rev of [1, 2, 3]) {
      const r = await commitLifecycleState(stateOf(entry(rev)), digest, { homeDir: home });
      if (!r.ok) throw new Error(r.code);
      digest = r.digest;
      bytes.push(await readFile(stateFile(home), "utf8"));
    }
    expect(await readFile(stateFile(home) + ".bak", "utf8")).toBe(bytes[1]);
    expect(stateBytesDigest(Buffer.from(bytes[2]!))).toBe(digest);
    const files = (await readdir(path.dirname(stateFile(home)))).sort();
    expect(files).toEqual(["lifecycle.json", "lifecycle.json.bak"]);
    for (const leak of [projectRoot, home, scratch, projectRoot.replace(/\\/gu, "/")]) expect(bytes[2]).not.toContain(leak);
  });

  it("AC-037-09 저장소 디렉터리가 home 밖을 가리키는 junction이면 STATE_PATH_ESCAPE이고 write 0회다", async () => {
    const home = await homeIn(scratch);
    const outside = path.join(scratch, "outside-" + Math.random().toString(16).slice(2));
    await mkdir(outside, { recursive: true });
    await symlink(outside, path.join(home, ".openhub"), "junction");
    const writes: string[] = [];
    expect(await readLifecycleState({ homeDir: home, fs: recordingFs(writes) })).toMatchObject({ ok: false, code: "STATE_PATH_ESCAPE" });
    expect(await commitLifecycleState(stateOf(toolState()), null, { homeDir: home, fs: recordingFs(writes) })).toMatchObject({ ok: false, code: "STATE_PATH_ESCAPE" });
    expect(writes).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
    // home 안을 가리키는 junction은 허용한다.
    const home2 = await homeIn(scratch);
    await mkdir(path.join(home2, "real-openhub"));
    await symlink(path.join(home2, "real-openhub"), path.join(home2, ".openhub"), "junction");
    expect((await commitLifecycleState(stateOf(toolState()), null, { homeDir: home2 })).ok).toBe(true);
    const ok: LifecycleStateFile = (await readLifecycleState({ homeDir: home2 }) as { ok: true; state: LifecycleStateFile }).state;
    expect(Object.keys(ok.entries)).toHaveLength(1);
  });
});
