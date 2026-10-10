import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  entryPlanDigest,
  formatInstallPlanPreview,
  installPlanSchema,
  installTargetChange,
  readLifecycleState,
  recordInstallInState,
  requestApproval,
  runInstallTransaction,
  serverEntry,
  type InstallRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, newScratch, plannedOf, type Harness } from "./harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.0 범위별 설치 판정. 설치 대상의 식별 기준은 Tool ID + Client + scope + 서버 이름이다.
 * 도구가 다른 Client·범위에 있다는 사실(Recommendation installationStatus)로 설치를 막지 않는다.
 * 같은 대상에 같은 항목이 있으면 변경 없음, 다른 항목이 있으면 충돌(덮어쓰지 않음).
 */
const scratch = await newScratch("scope-aware");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const entries: RegistryEntry[] = await seedEntries();
const TOOL = "memory-mcp";
type Target = InstallRequest["targets"][number];
const T = (client: Target["client"], scope: Target["scope"] = "project"): Target => ({ client, scope });

const FILE: Record<string, string> = {
  "claude-code:project": ".mcp.json",
  "cursor:project": ".cursor/mcp.json",
  "codex:project": ".codex/config.toml",
  "cursor:user": ".cursor/mcp.json",
  "codex:user": ".codex/config.toml",
};
const abs = (h: Harness, t: Target, root = h.projectRoot) => path.join(t.scope === "user" ? h.homeDir : root, FILE[t.client + ":" + t.scope]!);
const readOrNull = (f: string) => readFile(f, "utf8").catch(() => null);

async function installOk(h: Harness, targets: Target[]) {
  const request = h.request(TOOL, targets);
  const planned = await plannedOf(h, request);
  expect(planned.plan.status).toBe("installable");
  const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
  expect(result.status).toBe("succeeded");
  return { request, planned, result };
}
const writtenClients = (plan: { steps: readonly { kind: string }[] }) =>
  plan.steps.filter((s): s is { kind: "config-patch"; client: string; scope: string } => s.kind === "config-patch").map((s) => s.client + ":" + s.scope);

describe("v0.2.0 범위별 설치 판정(Tool + Client + scope + 서버 이름)", () => {
  it("Cursor 프로젝트에 설치됨 → Cursor 사용자 범위 추가 설치: 사용자 대상만 쓰고 user-scope-config 승인이 필요하며 프로젝트 파일은 byte 그대로다", async () => {
    const h = await createHarness(scratch, { entries });
    await installOk(h, [T("cursor")]);
    const projectBytes = await readFile(abs(h, T("cursor")), "utf8");
    const request = h.request(TOOL, [T("cursor", "user")]);
    const planned = await plannedOf(h, request);
    // Recommendation은 도구가 이미 설치됐다고 보지만(프로젝트 Cursor), 고른 대상(사용자 Cursor)에는 없다.
    expect(planned.plan.source.recommendation.installationStatus).toBe("installed");
    expect(planned.plan.status).toBe("installable");
    expect(writtenClients(planned.plan)).toEqual(["cursor:user"]);
    expect(planned.plan.approvalRequirements).toContain("user-scope-config");
    expect(formatInstallPlanPreview(planned).join("\n")).toContain("다른 Client·범위에 이미 설정됨");
    const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(result.status).toBe("succeeded");
    expect(result.configChanges.map((c) => [c.client, c.scope, c.applied])).toEqual([["cursor", "user", true]]);
    expect(JSON.parse((await readOrNull(abs(h, T("cursor", "user"))))!).mcpServers).toHaveProperty("memory");
    expect(await readFile(abs(h, T("cursor")), "utf8")).toBe(projectBytes);
  });

  it("Cursor 프로젝트에 설치됨 → Codex 프로젝트 추가 설치. 프로젝트 범위 요청은 사용자 설정 파일을 읽지 않는다", async () => {
    const h = await createHarness(scratch, { entries });
    await installOk(h, [T("cursor")]);
    h.reset();
    const planned = await plannedOf(h, h.request(TOOL, [T("codex")]));
    expect(planned.plan.status).toBe("installable");
    expect(writtenClients(planned.plan)).toEqual(["codex:project"]);
    expect(planned.plan.approvalRequirements).not.toContain("user-scope-config");
    expect(h.reads.filter((f) => f.startsWith("home/"))).toEqual([]);
  });

  it("Cursor 사용자 범위에 설치됨 → Cursor 프로젝트 추가 설치", async () => {
    const h = await createHarness(scratch, { entries });
    await installOk(h, [T("cursor", "user")]);
    const userBytes = await readFile(abs(h, T("cursor", "user")), "utf8");
    const { result } = await installOk(h, [T("cursor")]);
    expect(result.configChanges.map((c) => c.client + ":" + c.scope)).toEqual(["cursor:project"]);
    expect(await readFile(abs(h, T("cursor", "user")), "utf8")).toBe(userBytes);
  });

  it("같은 Client·scope·서버 이름에 같은 항목 → 변경 없음(no-op): 실행·쓰기·Version State 기록 0", async () => {
    const h = await createHarness(scratch, { entries });
    await installOk(h, [T("cursor", "user")]);
    const request = h.request(TOOL, [T("cursor", "user")]);
    const planned = await plannedOf(h, request);
    expect(planned.plan.status).toBe("already-installed");
    expect(planned.plan.steps).toEqual([]);
    expect(planned.plan.approvalRequirements).toEqual(["base"]);
    expect(planned.plan.targets.map((t) => installTargetChange(planned.plan, t))).toEqual(["unchanged"]);
    expect(formatInstallPlanPreview(planned).join("\n")).toContain("mcpServers.memory 변경 없음");
    h.reset();
    const result = await runInstallTransaction(planned, undefined, request, h.env);
    expect(result).toMatchObject({ status: "no-op", code: "ALREADY_INSTALLED", configChanges: [] });
    expect(h.writes).toEqual([]);
    expect(h.spawns).toEqual([]);
    expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toEqual({ ok: true, recorded: 0 });
  });

  it("같은 대상에 내용이 다른 같은 이름 항목 → CONFIG_KEY_EXISTS로 막고 덮어쓰지 않는다(승인 불가)", async () => {
    const h = await createHarness(scratch, { entries });
    const file = abs(h, T("cursor", "user"));
    await mkdir(path.dirname(file), { recursive: true });
    const custom = '{\n  "mcpServers": {\n    "memory": { "command": "npx", "args": ["-y", "my-own-memory-fork"] }\n  }\n}\n';
    await writeFile(file, custom);
    const planned = await plannedOf(h, h.request(TOOL, [T("cursor", "user"), T("codex")]));
    expect(planned.plan.status).toBe("blocked");
    expect(planned.plan.warnings.filter((w) => w.code === "CONFIG_KEY_EXISTS")).toHaveLength(1);
    expect(planned.plan.targets.map((t) => installTargetChange(planned.plan, t))).toEqual(["add", "conflict"]);
    expect(formatInstallPlanPreview(planned).join("\n")).toContain("충돌, 덮어쓰지 않음");
    expect(await requestApproval(planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) })).toMatchObject({ status: "not-approvable" });
    expect(await readFile(file, "utf8")).toBe(custom);
    expect(await readOrNull(abs(h, T("codex")))).toBeNull();
  });

  it("여러 Client 중 일부만 설치됨: 새 대상만 쓰고 Preview에는 모든 파일, 실패하면 이번에 바꾼 대상만 복구한다", async () => {
    const h = await createHarness(scratch, { entries, failRenameFor: ".codex/config.toml" });
    // Cursor 프로젝트를 먼저 설치한다(rename 실패 주입은 codex 설정에만 걸린다).
    await installOk(h, [T("cursor")]);
    const cursorBytes = await readFile(abs(h, T("cursor")), "utf8");
    const claudeBefore = '{\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
    await writeFile(abs(h, T("claude-code")), claudeBefore);
    const request = h.request(TOOL, [T("claude-code"), T("codex"), T("cursor")]);
    const planned = await plannedOf(h, request);
    expect(planned.plan.status).toBe("installable");
    expect(writtenClients(planned.plan)).toEqual(["claude-code:project", "codex:project"]);
    const preview = formatInstallPlanPreview(planned).join("\n");
    for (const f of [".mcp.json", ".codex/config.toml", ".cursor/mcp.json"]) expect(preview).toContain("  - " + f + " ");
    expect(preview).toContain(".cursor/mcp.json (Cursor, 프로젝트 범위) mcpServers.memory 변경 없음");
    const result = await runInstallTransaction(planned, await approveAll(planned), request, h.env);
    expect(result.status).toBe("partial-compensated");
    expect(result.configChanges.map((c) => [c.client, c.applied, c.restored])).toEqual([
      ["claude-code", true, true],
      ["codex", false, false],
    ]);
    expect(await readFile(abs(h, T("claude-code")), "utf8")).toBe(claudeBefore);
    expect(await readFile(abs(h, T("cursor")), "utf8")).toBe(cursorBytes);
    expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toEqual({ ok: true, recorded: 0 });
  });

  it("성공하면 Version State에는 이번에 쓴 대상만 기록하고, 이미 있던 대상의 기록은 그대로 둔다", async () => {
    const h = await createHarness(scratch, { entries });
    const first = await installOk(h, [T("cursor")]);
    expect(await recordInstallInState(first.planned, first.result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-01T00:00:00.000Z") })).toEqual({ ok: true, recorded: 1 });
    const before = await readLifecycleState({ homeDir: h.homeDir });
    if (!before.ok) throw new Error(before.code);
    const cursorState = Object.values(before.state.entries).find((e) => e.target.client === "cursor")!;
    const second = await installOk(h, [T("claude-code"), T("cursor")]);
    expect(writtenClients(second.planned.plan)).toEqual(["claude-code:project"]);
    expect(await recordInstallInState(second.planned, second.result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date("2026-10-02T00:00:00.000Z") })).toEqual({ ok: true, recorded: 1 });
    const after = await readLifecycleState({ homeDir: h.homeDir });
    if (!after.ok) throw new Error(after.code);
    const states = Object.values(after.state.entries);
    expect(states.map((e) => e.target.client).sort()).toEqual(["claude-code", "cursor"]);
    expect(states.find((e) => e.target.client === "cursor")).toEqual(cursorState);
  });

  it("승인 뒤 '변경 없음' 대상의 항목이 바뀌면 PLAN_STALE이고 아무것도 쓰지 않는다", async () => {
    const h = await createHarness(scratch, { entries });
    await installOk(h, [T("cursor")]);
    const request = h.request(TOOL, [T("claude-code"), T("cursor")]);
    const planned = await plannedOf(h, request);
    const approval = await approveAll(planned);
    const cursorFile = abs(h, T("cursor"));
    const doc = JSON.parse(await readFile(cursorFile, "utf8"));
    doc.mcpServers.memory.args.push("--changed");
    await writeFile(cursorFile, JSON.stringify(doc, null, 2) + "\n");
    h.reset();
    const result = await runInstallTransaction(planned, approval, request, h.env);
    expect(result.status).toBe("stale");
    expect(h.writes).toEqual([]);
    expect(await readOrNull(abs(h, T("claude-code")))).toBeNull();
  });

  it("InstallPlan v1 호환: 항목이 없는 대상에는 entryDigest가 없고(기존 golden 그대로), 기존 저장 Plan은 새 schema로 그대로 해석된다", async () => {
    const h = await createHarness(scratch, { entries });
    const planned = await plannedOf(h, h.request(TOOL, [T("cursor"), T("codex")]));
    expect(planned.plan.schemaVersion).toBe(1);
    for (const t of planned.plan.targets) expect(Object.keys(t.precondition).sort()).toEqual(["exists", "fileDigest", "keyAbsent"]);
    const golden = JSON.parse(await readFile(path.join(import.meta.dirname, "../fixtures/m6/goldens/install-plan-memory.json"), "utf8"));
    const old = golden.plan ?? golden;
    expect(installPlanSchema.safeParse(old).success).toBe(true);
    // 잘못된 형식의 entryDigest는 거부한다.
    const bad = { ...old, targets: old.targets.map((t: { precondition: object }) => ({ ...t, precondition: { ...t.precondition, keyAbsent: false, entryDigest: "md5:x" } })) };
    expect(installPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("Plan 구조만으로 대상별 변경을 계산한다(entryDigest = Plan 형태 표준 항목의 digest)", async () => {
    const h = await createHarness(scratch, { entries });
    await installOk(h, [T("codex")]);
    const planned = await plannedOf(h, h.request(TOOL, [T("codex"), T("cursor")]));
    const codex = planned.plan.targets.find((t) => t.client === "codex")!;
    expect(codex.precondition.entryDigest).toBe(entryPlanDigest(serverEntry("codex", planned.plan.launch!, planned.plan.launch!.envNames)));
    expect(planned.plan.targets.map((t) => installTargetChange(planned.plan, t))).toEqual(["unchanged", "add"]);
  });
});

describe("v0.2.0 범위별 설치 판정: tool config Tool", () => {
  const K8S = "kubernetes-mcp-server";
  it("이 프로젝트 tool config를 가리키는 같은 항목은 변경 없음, 다른 프로젝트의 tool config를 가리키는 복사 항목은 충돌이다", async () => {
    const h = await createHarness(scratch, { entries });
    const request = h.request(K8S, [T("cursor")]);
    const planned = await plannedOf(h, request);
    expect((await runInstallTransaction(planned, await approveAll(planned), request, h.env)).status).toBe("succeeded");
    expect((await plannedOf(h, request)).plan.status).toBe("already-installed");
    // 다른 프로젝트로 설정 파일을 복사한다(--config가 원래 프로젝트의 tool config를 가리킨다).
    const other = path.join(h.base, "project-b");
    await mkdir(other);
    await writeFile(path.join(other, "package.json"), '{ "name": "b", "private": true }\n');
    await cp(path.join(h.projectRoot, ".cursor"), path.join(other, ".cursor"), { recursive: true });
    const copied = await readFile(path.join(other, ".cursor", "mcp.json"), "utf8");
    const b = await plannedOf(h, { ...request, projectRoot: other });
    expect(b.plan.status).toBe("blocked");
    expect(b.plan.warnings.map((w) => w.code)).toContain("CONFIG_KEY_EXISTS");
    expect(b.plan.targets.map((t) => installTargetChange(b.plan, t))).toEqual(["conflict"]);
    expect(await readFile(path.join(other, ".cursor", "mcp.json"), "utf8")).toBe(copied);
  });

  it("tool config Tool을 다른 Client에 추가하면 변경 없는 대상의 tool config 단계는 다시 만들지 않는다", async () => {
    const h = await createHarness(scratch, { entries });
    const first = h.request(K8S, [T("cursor")]);
    const p1 = await plannedOf(h, first);
    expect((await runInstallTransaction(p1, await approveAll(p1), first, h.env)).status).toBe("succeeded");
    const p2 = await plannedOf(h, h.request(K8S, [T("codex"), T("cursor")]));
    expect(p2.plan.status).toBe("installable");
    expect(p2.plan.steps.map((s) => s.kind + ":" + s.id)).toEqual(["run:npx-prepare", "tool-config:tool-config-project", "config-patch:config-codex-project"]);
    // 같은 scope의 tool config가 이미 같은 내용이므로 그 단계는 내용 확인(keep)이다.
    expect(p2.plan.steps.find((s) => s.kind === "tool-config")).toMatchObject({ action: "keep" });
  });
});

