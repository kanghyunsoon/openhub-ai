import { describe, expect, it } from "vitest";
import {
  assessProfile,
  classifyGaps,
  deriveNeeds,
  installationStatus,
  installedToolSchema,
  resolveInstalledTools,
  type ProjectProfile,
  type RegistryEntry,
} from "../../src/index";
import { fixtureProfile, item, profile, seedEntries, tool } from "./helpers";

const entries: RegistryEntry[] = await seedEntries();
const run = (p: ProjectProfile) => {
  const installed = resolveInstalledTools(p, entries);
  const gaps = classifyGaps(p, deriveNeeds(p), installed);
  const gap = (cap: string) => gaps.find((g) => g.capability === cap);
  return { installed, gaps, gap };
};
const react = item("react", "React");
const reactProject = (extra: Parameters<typeof profile>[0] = {}) => profile({ frameworks: [react], aiClients: [item("claude-code", "Claude Code", "config", { file: ".mcp.json" })], ...extra });
const withHost = { "host-probe": "ok" as const };

describe("REQ-021 Installed Tool Resolver와 Gap Classifier", () => {
  it("AC-019-01 server name과 canonical alias가 정확히 같을 때만 resolved다(대소문자·substring·fuzzy 없음)", () => {
    const p = reactProject({ aiTools: [tool("playwright"), tool("Playwright", { clients: ["codex"] }), tool("playwright-mcp"), tool("my-playwright"), tool("playwrigh")] });
    const { installed } = run(p);
    expect(installed.map((t) => [t.serverName, t.resolution, t.toolId])).toEqual([
      ["Playwright", "unresolved", null],
      ["my-playwright", "unresolved", null],
      ["playwrigh", "unresolved", null],
      ["playwright", "resolved", "playwright-mcp"],
      ["playwright-mcp", "unresolved", null],
    ]);
  });

  it("AC-019-01 mcp-server가 아닌 kind와 weak 강도 항목은 satisfied 근거가 아니다", () => {
    const skill = run(reactProject({ aiTools: [tool("playwright", { kind: "skill" })], detectors: withHost }));
    expect(skill.installed[0]).toMatchObject({ resolution: "unresolved", toolId: null });
    expect(skill.gap("browser-automation")?.state).toBe("confirmed-gap");
    const weak = run(reactProject({ aiTools: [tool("playwright", { type: "file-presence" })], detectors: withHost }));
    expect(weak.installed[0]).toMatchObject({ resolution: "resolved", strength: "weak" });
    expect(weak.gap("browser-automation")?.state).not.toBe("satisfied");
  });

  it("AC-019-02 unresolved tool은 toolId null·capabilities []이며 어떤 capability도 satisfied로 만들지 않는다", () => {
    const { installed, gaps } = run(reactProject({ aiTools: [tool("my-browser"), tool("my-github")], detectors: withHost }));
    for (const t of installed) expect(t).toMatchObject({ toolId: null, resolution: "unresolved", capabilities: [] });
    expect(gaps.filter((g) => g.state === "satisfied")).toEqual([]);
  });

  it("AC-019-03 claude-mcp fixture의 playwright는 resolved이고 browser-automation·e2e-testing은 project scope로 satisfied다(시나리오 5)", async () => {
    const { installed, gap } = run(await fixtureProfile("claude-mcp"));
    expect(installed.find((t) => t.serverName === "playwright")).toMatchObject({ resolution: "resolved", toolId: "playwright-mcp", scope: "project" });
    for (const cap of ["browser-automation", "e2e-testing"]) {
      expect(gap(cap)?.state).toBe("satisfied");
      expect(gap(cap)?.satisfiedBy).toEqual([{ toolId: "playwright-mcp", serverName: "playwright", scope: "project" }]);
    }
  });

  it("AC-019-04 user scope에만 있는 playwright도 host-probe 실행 시 satisfied이고 scope는 user다(시나리오 6)", () => {
    const { gap } = run(reactProject({ aiTools: [tool("playwright", { scope: "user" })], detectors: withHost }));
    expect(gap("browser-automation")?.state).toBe("satisfied");
    expect(gap("browser-automation")?.satisfiedBy).toEqual([{ toolId: "playwright-mcp", serverName: "playwright", scope: "user" }]);
  });

  it("AC-019-05 host-probe가 없으면 inspectedScopes는 project뿐이고 미충족 need는 최대 likely-gap이다", () => {
    const p = reactProject();
    const { gaps, installed } = run(p);
    expect(assessProfile(p, installed).inspectedScopes).toEqual(["project"]);
    expect(gaps.every((g) => g.state === "likely-gap" || g.state === "unknown")).toBe(true);
    expect(gaps.find((g) => g.capability === "browser-automation")?.stateReasons).toContain("host-unchecked");
  });

  it("AC-019-06 confirmed-gap은 strong·detector ok·host ok·unresolved 0·충족 도구 없음을 모두 만족할 때만 나온다", () => {
    const state = (p: ProjectProfile) => run(p).gap("browser-automation")?.state;
    expect(state(reactProject({ detectors: withHost }))).toBe("confirmed-gap");
    expect(state(profile({ frameworks: [item("react", "React", "executable", { scope: "user" })], detectors: withHost }))).toBe("likely-gap"); // environment 근거
    expect(state(reactProject({ detectors: { ...withHost, frameworks: "partial" } }))).toBe("likely-gap");
    expect(state(reactProject({ detectors: { "host-probe": "partial" } }))).toBe("likely-gap");
    expect(state(reactProject())).toBe("likely-gap"); // host 미검사
    expect(state(reactProject({ detectors: withHost, aiTools: [tool("my-browser")] }))).toBe("likely-gap");
    expect(state(reactProject({ detectors: withHost, aiTools: [tool("playwright")] }))).toBe("satisfied");
  });

  it("AC-019-07 source가 weak뿐인 need는 unknown이다(시나리오 7)", () => {
    const p = profile({ frameworks: [item("react", "React", "file-presence", { file: "vite.config.ts" })], detectors: { ...withHost, frameworks: "partial" } });
    const g = run(p).gap("browser-automation");
    expect(g?.state).toBe("unknown");
    expect(g?.stateReasons).toContain("weak-evidence");
  });

  it("AC-019-07 confidence 0.6 이하 aiTools는 satisfied 근거가 아니며 해당 capability는 unknown이다", () => {
    const g = run(reactProject({ aiTools: [tool("playwright", { type: "file-presence" })], detectors: withHost })).gap("browser-automation");
    expect(g?.state).toBe("unknown");
    expect(g?.stateReasons).toEqual(["weak-installed-match"]);
    expect(g?.satisfiedBy).toEqual([]);
  });

  it("AC-019-08 source detector나 ai-environment가 partial이면 최대 likely-gap이고 detector-partial이 있다(시나리오 8)", () => {
    for (const detectors of [{ ...withHost, frameworks: "partial" as const }, { ...withHost, "ai-environment": "partial" as const }]) {
      const g = run(reactProject({ detectors })).gap("browser-automation");
      expect(g?.state).toBe("likely-gap");
      expect(g?.stateReasons).toContain("detector-partial");
    }
  });

  it("AC-019-09 ai-environment가 failed이면 미충족 need는 모두 unknown이고 후보 설치 상태도 unknown이다(시나리오 9)", () => {
    const p = reactProject({ detectors: { ...withHost, "ai-environment": "failed" } });
    const { gaps, installed } = run(p);
    expect(gaps.every((g) => g.state === "unknown")).toBe(true);
    for (const toolId of entries.map((e) => e.manifest.name)) expect(installationStatus(toolId, p, installed).status).toBe("unknown");
  });

  it("AC-019-10 frameworks가 failed이면 coverage에 기록되고 needs-incomplete 경고가 붙는다(시나리오 9)", () => {
    const p = profile({ languages: [item("typescript", "TypeScript", "config", { file: "tsconfig.json" })], detectors: { frameworks: "failed" } });
    const a = assessProfile(p, []);
    expect(a.coverage).toContainEqual({ detector: "frameworks", status: "failed" });
    expect(a.warnings).toContainEqual({ code: "needs-incomplete", message: "frameworks Detector가 실패해 일부 Capability 필요를 판단하지 못했습니다" });
  });

  it("AC-019-11 MCP key를 my-github·GitHub로 바꾸면 unresolved이고 github-api는 최대 likely-gap, 후보는 unidentified-present다", () => {
    for (const key of ["my-github", "GitHub"]) {
      const p = profile({
        infrastructure: [item("github-actions", "GitHub Actions", "config", { file: ".github/workflows/ci.yml" })],
        aiTools: [tool(key)],
        detectors: withHost,
      });
      const { installed, gap } = run(p);
      expect(installed).toEqual([expect.objectContaining({ serverName: key, resolution: "unresolved", toolId: null })]);
      expect(gap("github-api")?.state).toBe("likely-gap");
      expect(gap("github-api")?.stateReasons).toEqual(["unresolved-installed-tools"]);
      expect(installationStatus("github-mcp-server", p, installed).status).toBe("unidentified-present");
      expect(JSON.stringify({ installed, gaps: run(p).gaps })).not.toContain("설치되지 않음");
    }
  });

  it("AC-019-12 installedTools는 resolved MCP·unresolved MCP·skill/plugin 모두 schema를 따르고 command·args·package가 없다", async () => {
    const { installed } = run(await fixtureProfile("claude-mcp"));
    const byKind = (kind: string, resolution: string) => installed.filter((t) => t.kind === kind && t.resolution === resolution);
    expect(byKind("mcp-server", "resolved").map((t) => t.toolId)).toEqual(["context7", "github-mcp-server", "playwright-mcp", "postgres-mcp"]);
    expect(byKind("skill", "unresolved")).toHaveLength(1);
    expect(byKind("plugin", "unresolved")).toHaveLength(1);
    const unresolvedMcp = run(reactProject({ aiTools: [tool("custom-mcp")] })).installed;
    for (const t of [...installed, ...unresolvedMcp]) {
      expect(installedToolSchema.parse(t)).toEqual(t);
      for (const key of ["command", "args", "package", "env", "url"]) expect(Object.keys(t)).not.toContain(key);
    }
  });
});
