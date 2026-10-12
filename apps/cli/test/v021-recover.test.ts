import { readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { planLifecycleRequest, readJournals, recordInstallInState, requestLifecycleApproval, runInstallTransaction, runLifecycleTransaction, type LifecycleEnvironment, type LifecycleRequest } from "@openhub/core";
import { runCli } from "../src/cli";
import { memoryIO } from "./helpers";
import { approveAll, createHarness, plannedOf } from "../../../packages/core/test/installer/harness";
import { seedEntries } from "../../../packages/core/test/recommendation/helpers";
import { fakeNpmSpawner } from "../../../packages/core/test/process/fake-npm";
import { abandonOperationLock, newScratch } from "../../../packages/core/test/lifecycle/helpers";

/** v0.2.1 P0-3 CLI openhub lifecycle recover. Core harness로 "Health 중 끝난 Update" 상태를 만든 뒤 CLI로 복구한다(spawn·network 0). */
const REPO = path.resolve(import.meta.dirname, "../../..");
const seed = await seedEntries();
const scratch = await newScratch("cli-v021-recover");
afterAll(() => rm(scratch, { recursive: true, force: true }));

async function interrupted() {
  const h = await createHarness(scratch, { entries: seed });
  const targets = [{ client: "cursor" as const, scope: "project" as const }];
  const install = h.request("github-mcp-server", targets);
  const p = await plannedOf(h, install);
  const r = await runInstallTransaction(p, await approveAll(p), install, h.env);
  await recordInstallInState(p, r, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() });
  const file = path.join(h.projectRoot, ".cursor", "mcp.json");
  const original = await readFile(file, "utf8");
  let reached!: () => void;
  const inHealth = new Promise<void>((res) => (reached = res));
  const env: LifecycleEnvironment = {
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: scratch,
    now: () => new Date(),
    fetch: async (url: string) =>
      url.startsWith("https://ghcr.io/token") ? new Response(JSON.stringify({ token: "anon" })) : url.includes("/manifests/") ? new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "f".repeat(64) } }) : new Response("x", { status: 404 }),
    configFs: h.env.configFs!,
    spawner: fakeNpmSpawner({ cacheRoot: path.join(h.base, "npm") }).spawner,
    runHealth: () => (reached(), new Promise(() => undefined)),
  };
  const request: LifecycleRequest = { operation: "update", toolId: "github-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "linux", includeUser: false, targets };
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) throw new Error(built.code);
  const o = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (x) => x.requirements.map((y) => y.id) });
  if (o.status !== "approved") throw new Error(o.status);
  void runLifecycleTransaction(built.planned, o.approval, request, env);
  await inHealth;
  await abandonOperationLock(h.homeDir); // 강제 종료가 남기는 잠금 상태(죽은 pid)
  return { h, file, original, changed: await readFile(file, "utf8") };
}

async function cli(args: string[], c: { homeDir: string }, opts: { tty?: boolean; answers?: string[] } = {}) {
  const io = memoryIO(REPO);
  const answers = [...(opts.answers ?? [])];
  const full = Object.assign(io, { homeDir: c.homeDir, prompter: { isTTY: opts.tty ?? true, ask: async () => answers.shift() ?? "" } });
  const code = await runCli(["lifecycle", "recover", ...args], full);
  return { code, out: io.stdout.join("\n"), err: io.stderr.join("\n") };
}

describe("v0.2.1 CLI openhub lifecycle recover", () => {
  it("자동 승인 옵션은 exit 2, 복구할 기록이 없으면 exit 0", async () => {
    const h = await createHarness(scratch, { entries: seed });
    expect((await cli(["github-mcp-server", "--yes", "--project", h.projectRoot], h)).code).toBe(2);
    const none = await cli(["github-mcp-server", "--project", h.projectRoot], h);
    expect(none.code).toBe(0);
    expect(none.err).toContain("복구할 것이 없습니다");
  });

  it("비대화형은 exit 3, --json은 Plan만, 거절은 exit 1이고 모두 쓰기 0. 승인하면 변경 전으로 되돌리고 exit 0", async () => {
    const c = await interrupted();
    const args = ["github-mcp-server", "--project", c.h.projectRoot];
    expect((await cli(args, c.h, { tty: false })).code).toBe(3);
    const json = await cli([...args, "--json"], c.h, { tty: false });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out).plan).toMatchObject({ status: "ready", mode: "undo" });
    expect((await cli(args, c.h, { answers: ["wrong-id"] })).code).toBe(1);
    expect(await readFile(c.file, "utf8")).toBe(c.changed);
    const ok = await cli(args, c.h, { answers: ["github-mcp-server"] });
    expect(ok.code, ok.err).toBe(0);
    expect(ok.out).toContain("결과  recovered");
    expect(JSON.parse(await readFile(c.file, "utf8"))).toEqual(JSON.parse(c.original));
    const left = await readJournals(c.h.homeDir);
    expect(left.ok && left.journals).toEqual([]);
  });

  it("lifecycle status는 남은 작업 기록마다 지금 복구할 수 있는지와 정확한 명령을 알린다(되돌리기 가능 / 자동 복구 불가)", async () => {
    const status = async (c: { homeDir: string; projectRoot: string }, json = false) => {
      const io = memoryIO(REPO);
      const full = Object.assign(io, { homeDir: c.homeDir });
      const code = await runCli(["lifecycle", "status", "--project", c.projectRoot, ...(json ? ["--json"] : [])], full);
      return { code, out: io.stdout.join("\n") };
    };
    const c = await interrupted();
    const s = await status(c.h);
    expect(s.code).toBe(0);
    expect(s.out).toContain("interrupted-update");
    expect(s.out).toContain("복구 가능  github-mcp-server: openhub lifecycle recover github-mcp-server — 승인하면");
    expect(JSON.parse((await status(c.h, true)).out).recovery).toEqual([{ toolId: "github-mcp-server", available: "undo", blockers: [] }]);
    // 사용자가 같은 항목을 바꿨으면 자동 복구 대상이 아니다.
    await writeFile(c.file, '{ "mcpServers": { "github": { "command": "docker", "args": ["run", "-i", "--rm", "my-own-image"] } } }\n');
    const manual = await status(c.h);
    expect(manual.out).toContain("자동 복구 불가  github-mcp-server (EXTERNAL_CHANGE)");
    expect(manual.out).not.toContain("복구 가능  github-mcp-server");
  });
});
