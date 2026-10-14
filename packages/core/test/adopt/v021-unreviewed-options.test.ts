import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadRegistry, planAdopt, type AdoptPlanOptions, type PlannedAdopt, type RegistryEntry } from "../../src/index";
import { newScratch } from "../lifecycle/helpers";
import { seedWithNpxFixture } from "../recommendation/helpers";

/**
 * v0.2.1 P0-6: Adopt는 package·image가 Registry와 같다는 것만으로 설정 항목을 관리 대상으로 등록하면 안 된다.
 * Registry에서 검토한 실행 인자(읽기 전용·telemetry·access-mode 등)와 다른 옵션이 있으면 blocked여야 한다.
 * 실제 registry/ Manifest를 쓴다. 임시 project·home만 쓰고 network·spawn이 없다.
 */
const REGISTRY = path.resolve(import.meta.dirname, "../../../../registry");
// 실제 Registry + 테스트 전용 npx fixture(v0.2.1 #69: Memory MCP 지원 중단으로 버전 미고정 npx 도구 역할을 대신한다)
const entries = await seedWithNpxFixture();
const scratch = await newScratch("adopt-unreviewed-test");
afterAll(() => rm(scratch, { recursive: true, force: true }));

const MEMORY = "@openhub-fixture/npx-mcp";
const MONGO = ["--readOnly", "--telemetry", "disabled", "--disabledTools", "export,connect,search-knowledge,list-knowledge-sources,atlas-local-connect-deployment,atlas-local-list-deployments,mongodb-logs"];

async function plan(toolId: string, server: string, entry: unknown, platform: AdoptPlanOptions["platform"] = "linux"): Promise<PlannedAdopt> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const projectRoot = path.join(base, "project");
  const homeDir = path.join(base, "home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  await writeFile(path.join(projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { [server]: entry } }, null, 2) + "\n");
  const r = await planAdopt({ toolId, projectRoot, homeDir, entries: entries as RegistryEntry[], platform, client: "claude-code", scope: "project" });
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
}
const codes = (p: PlannedAdopt) => p.plan.blockers.map((b) => b.code);

describe("v0.2.1 P0-6 Adopt: 검토되지 않은 실행 옵션", () => {
  const unreviewed: [string, string, string, unknown][] = [
    ["npm --registry로 다른 package 출처", "fixture-npx-mcp", "fixture-npx", { command: "npx", args: ["-y", "--registry=https://registry.example.test", MEMORY + "@2026.8.31"] }],
    ["memory 뒤에 추가 인자", "fixture-npx-mcp", "fixture-npx", { command: "npx", args: ["-y", MEMORY + "@2026.8.31", "--debug"] }],
    ["mongodb --readOnly 없음", "mongodb-mcp-server", "mongodb", { command: "npx", args: ["-y", "mongodb-mcp-server@3.0.5", ...MONGO.slice(1)] }],
    ["mongodb 옵션 전체 없음", "mongodb-mcp-server", "mongodb", { command: "npx", args: ["-y", "mongodb-mcp-server@3.0.5"] }],
    ["mongodb 검토되지 않은 버전", "mongodb-mcp-server", "mongodb", { command: "npx", args: ["-y", "mongodb-mcp-server@3.0.4", ...MONGO] }],
    ["postgres access-mode=unrestricted", "postgres-mcp", "postgres", { command: "uvx", args: ["postgres-mcp", "--access-mode=unrestricted"] }],
    ["postgres access-mode 없음", "postgres-mcp", "postgres", { command: "uvx", args: ["postgres-mcp"] }],
    ["postgres uvx --index-url", "postgres-mcp", "postgres", { command: "uvx", args: ["--index-url", "https://pypi.example.test/simple", "postgres-mcp", "--access-mode=restricted"] }],
    // v0.2.1 #39: 검토된 postgres 실행 인자는 mcp SDK를 1.x로 고정한다. v0.2.0 형식(고정 없음)과 SDK 버전을 바꾼 항목은 검토된 인자가 아니다.
    ["postgres v0.2.0 형식(mcp 고정 없음)", "postgres-mcp", "postgres", { command: "uvx", args: ["postgres-mcp", "--access-mode=restricted"], env: { DATABASE_URI: "${DATABASE_URI}" } }],
    ["postgres mcp SDK 2.x로 바꿈", "postgres-mcp", "postgres", { command: "uvx", args: ["--from", "postgres-mcp", "--with", "mcp==2.3.0", "postgres-mcp", "--access-mode=restricted"], env: { DATABASE_URI: "${DATABASE_URI}" } }],
    // v0.2.1 #39: Manifest가 postgres-mcp==0.3.0으로 고정됐으므로(Adopt 규칙: 고정된 버전은 같아야 한다) 버전이 없는 --from과 다른 버전은 검토된 인자가 아니다.
    ["postgres --from 버전 없음(이전 #39 형식)", "postgres-mcp", "postgres", { command: "uvx", args: ["--from", "postgres-mcp", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"], env: { DATABASE_URI: "${DATABASE_URI}" } }],
    ["postgres 검토되지 않은 버전", "postgres-mcp", "postgres", { command: "uvx", args: ["--from", "postgres-mcp==0.2.3", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"], env: { DATABASE_URI: "${DATABASE_URI}" } }],
    ["kubernetes --read-only 없음", "kubernetes-mcp-server", "kubernetes", { command: "npx", args: ["-y", "kubernetes-mcp-server@0.0.67", "--toolsets", "core"] }],
  ];
  for (const [name, toolId, server, entry] of unreviewed) {
    it(name + " → blocked(ADOPT_ENTRY_UNSUPPORTED), 승인 불가", async () => {
      for (const platform of ["linux", "windows"] as const) {
        const p = await plan(toolId, server, entry, platform);
        expect(p.plan.status, platform).toBe("blocked");
        expect(codes(p), platform).toContain("ADOPT_ENTRY_UNSUPPORTED");
      }
    });
  }

  const reviewed: [string, string, string, unknown, AdoptPlanOptions["platform"]?][] = [
    ["memory Manifest 그대로(버전 없음)", "fixture-npx-mcp", "fixture-npx", { command: "npx", args: ["-y", MEMORY] }],
    ["memory 정확한 버전 고정(Manifest가 버전을 고정하지 않음)", "fixture-npx-mcp", "fixture-npx", { command: "npx", args: ["-y", MEMORY + "@2026.8.31"] }],
    ["memory Windows cmd wrapper", "fixture-npx-mcp", "fixture-npx", { command: "cmd", args: ["/d", "/c", "npx", "-y", MEMORY + "@2026.8.31"] }, "windows"],
    ["memory Windows에서 wrapper 없는 npx", "fixture-npx-mcp", "fixture-npx", { command: "npx", args: ["-y", MEMORY + "@1.2.3"] }, "windows"],
    // 고정 버전 wheel-only uvx의 검토된 Client 실행 인자는 --no-build로 시작한다(#45). 없는 항목은 아래 #45 리뷰 테스트처럼 편입하지 않는다.
    ["postgres Windows", "postgres-mcp", "postgres", { command: "uvx", args: ["--no-build", "--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"], env: { DATABASE_URI: "${DATABASE_URI}" } }, "windows"],
    ["mongodb Manifest 그대로", "mongodb-mcp-server", "mongodb", { command: "npx", args: ["-y", "mongodb-mcp-server@3.0.5", ...MONGO], env: { MDB_MCP_CONNECTION_STRING: "${MDB_MCP_CONNECTION_STRING}" } }],
    ["postgres Manifest 그대로(0.3.0 + mcp 1.30.0)", "postgres-mcp", "postgres", { command: "uvx", args: ["--no-build", "--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"], env: { DATABASE_URI: "${DATABASE_URI}" } }],
  ];
  for (const [name, toolId, server, entry, platform] of reviewed) {
    it(name + " → 지금처럼 ready", async () => {
      const p = await plan(toolId, server, entry, platform);
      expect(p.plan.blockers).toEqual([]);
      expect(p.plan.status).toBe("ready");
    });
  }

  // v0.2.1 #39: Serena는 지원 중단 도구다. 예전 형식·고정 형식 어느 쪽이든 편입 계획을 만들지 않고 사유를 안내한다(설정은 그대로).
  it("serena(지원 중단) → TOOL_WITHDRAWN, 계획 없음", async () => {
    for (const args of [["--from", "serena-agent", "serena", "start-mcp-server"], ["--from", "serena-agent==1.7.0", "serena", "start-mcp-server"]]) {
      const base = await mkdtemp(path.join(scratch, "serena-"));
      await mkdir(path.join(base, "project"), { recursive: true });
      await mkdir(path.join(base, "home"), { recursive: true });
      await writeFile(path.join(base, "project", ".mcp.json"), JSON.stringify({ mcpServers: { serena: { command: "uvx", args } } }, null, 2) + "\n");
      const r = await planAdopt({ toolId: "serena", projectRoot: path.join(base, "project"), homeDir: path.join(base, "home"), entries: entries as RegistryEntry[], platform: "linux", client: "claude-code", scope: "project" });
      expect(r).toMatchObject({ ok: false, code: "TOOL_WITHDRAWN" });
      if (!r.ok) expect(r.message).toContain("issues/59");
    }
  });
});

describe("v0.2.1 #45 리뷰: 고정 버전 wheel-only uvx의 Client 실행 인자(--no-build)", () => {
  // Registry Manifest는 바꾸지 않고 메모리에서만 postgres-mcp를 정확한 버전(wheel-only Prepare 대상)으로 바꾼다.
  const PIN = "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted";
  const pinned = (entries as RegistryEntry[]).map((e) => (e.manifest.name === "postgres-mcp" ? { ...e, manifest: { ...e.manifest, install: { ...e.manifest.install, options: { command: PIN } } } } : e));
  async function planPinned(entry: unknown): Promise<PlannedAdopt> {
    const base = await mkdtemp(path.join(scratch, "pinned-"));
    const projectRoot = path.join(base, "project");
    const homeDir = path.join(base, "home");
    await mkdir(projectRoot, { recursive: true });
    await mkdir(homeDir, { recursive: true });
    await writeFile(path.join(projectRoot, ".mcp.json"), JSON.stringify({ mcpServers: { postgres: entry } }, null, 2) + "\n");
    const r = await planAdopt({ toolId: "postgres-mcp", projectRoot, homeDir, entries: pinned, platform: "linux", client: "claude-code", scope: "project" });
    if (!r.ok) throw new Error(r.code + " " + r.message);
    return r.planned;
  }
  const env = { DATABASE_URI: "${DATABASE_URI}" };
  const args = ["--from", "postgres-mcp==0.3.0", "--with", "mcp==1.30.0", "postgres-mcp", "--access-mode=restricted"];

  it("OpenHub 표준 형식(--no-build 포함)은 같은 도구로 식별되어 편입할 수 있다", async () => {
    const p = await planPinned({ command: "uvx", args: ["--no-build", ...args], env });
    expect(p.plan.blockers).toEqual([]);
    expect(p.plan.status).toBe("ready");
  });

  it("--no-build가 빠진 항목은 검토된 실행 인자와 달라(소스 빌드 가능) 편입하지 않는다", async () => {
    const p = await planPinned({ command: "uvx", args, env });
    expect(p.plan.status).toBe("blocked");
    expect(codes(p)).toContain("ADOPT_ENTRY_UNSUPPORTED");
  });
});
