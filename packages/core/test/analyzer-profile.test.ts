import { describe, expect, it } from "vitest";
import {
  DetectorRegistry,
  EVIDENCE_WEIGHTS,
  buildProfile,
  containsAbsolutePath,
  detectionConfidence,
  projectProfileSchema,
  serializeProfile,
  toKebabId,
  validateFinding,
  type DetectorRun,
  type Finding,
  type ProjectDetector,
} from "../src/index";

const react = (file: string, type: Finding["evidence"][number]["type"] = "dependency"): Finding => ({
  category: "frameworks",
  id: "react",
  name: "React",
  scope: "project",
  evidence: [{ file, type, value: "react" }],
});

const run = (id: string, findings: Finding[], status: DetectorRun["status"] = "ok"): DetectorRun => ({ id, status, findings, warnings: [] });

describe("REQ-010 REQ-011 REQ-012 ProjectProfile 계약", () => {
  it("AC-008-01 Profile은 schemaVersion과 9개 섹션을 가지며 zod로 검증된다", () => {
    const p = buildProfile("my-app", []);
    expect(Object.keys(p)).toEqual([
      "schemaVersion", "project", "languages", "frameworks", "databases", "packageManagers",
      "infrastructure", "aiClients", "aiTools", "detectors", "warnings",
    ]);
    expect(p.schemaVersion).toBe(1);
    expect(p.project).toEqual({ name: "my-app" });
    expect(projectProfileSchema.safeParse({ ...p, extra: 1 }).success).toBe(false);
    expect(projectProfileSchema.safeParse({ ...p, schemaVersion: 2 }).success).toBe(false);
  });

  it("AC-008-02 항목은 id·name·scope·confidence·evidence를 가지며 project Evidence는 POSIX 상대 경로다", () => {
    const p = buildProfile("x", [run("d", [react("apps/web/package.json")])]);
    expect(p.frameworks).toEqual([
      { id: "react", name: "React", scope: "project", confidence: 1, evidence: [{ file: "apps/web/package.json", type: "dependency", value: "react" }] },
    ]);
    for (const bad of ["apps\\web\\package.json", "../package.json", "/package.json", "./package.json"]) {
      expect(validateFinding(react(bad)), bad).toMatch(/상대 경로/);
    }
    expect(validateFinding({ ...react("package.json"), evidence: [] })).toBeDefined();
    expect(validateFinding({ ...react("package.json"), id: "React JS" })).toMatch(/kebab/);
  });

  it("AC-008-03 confidence는 확률이 아닌 Evidence 가중치 최댓값이다", () => {
    expect(EVIDENCE_WEIGHTS).toMatchObject({ dependency: 1, lockfile: 0.9, executable: 0.8, "file-presence": 0.6, "extension-count": 0.4 });
    expect(detectionConfidence([{ type: "extension-count" }, { type: "file-presence" }])).toBe(0.6);
    expect(detectionConfidence([{ type: "extension-count" }, { type: "lockfile" }, { type: "file-presence" }])).toBe(0.9);
    const weak = buildProfile("x", [run("d", [react("src/App.tsx", "extension-count")])]);
    expect(weak.frameworks[0]?.confidence).toBe(0.4);
    const merged = buildProfile("x", [run("a", [react("src/App.tsx", "extension-count")]), run("b", [react("package.json")])]);
    expect(merged.frameworks[0]?.confidence).toBe(1);
    const tampered = structuredClone(merged);
    (tampered.frameworks[0] as { confidence: number }).confidence = 0.5;
    expect(projectProfileSchema.safeParse(tampered).success).toBe(false);
  });

  it("AC-008-04 같은 입력은 순서와 무관하게 바이트 단위로 같은 JSON을 만든다", () => {
    const a = run("languages", [
      { category: "languages", id: "typescript", name: "TypeScript", scope: "project", evidence: [{ file: "tsconfig.json", type: "config", value: "tsconfig.json" }] },
      { category: "languages", id: "java", name: "Java", scope: "project", evidence: [{ file: "pom.xml", type: "manifest", value: "pom.xml" }] },
    ]);
    const b = run("frameworks", [react("b/package.json"), react("a/package.json")]);
    const one = serializeProfile(buildProfile("x", [a, b]));
    const two = serializeProfile(buildProfile("x", [{ ...b, findings: [...b.findings].reverse() }, { ...a, findings: [...a.findings].reverse() }]));
    expect(one).toBe(two);
    expect(one).not.toMatch(/\d{4}-\d{2}-\d{2}T/u);
  });

  it("AC-008-05 절대 경로가 들어간 결과는 유효하지 않다", () => {
    for (const s of ["C:\\Users\\me\\app", "D:/work/app", "\\\\server\\share\\x", "/home/me/app", "/Users/me", "열기 실패: /var/lib/x"]) {
      expect(containsAbsolutePath(s), s).toBe(true);
    }
    for (const s of ["apps/web/package.json", "@playwright/mcp", "ghcr.io/github/github-mcp-server", "jdbc:postgresql", "~/.codex/config.toml"]) {
      expect(containsAbsolutePath(s), s).toBe(false);
    }
    const ok = buildProfile("x", []);
    expect(projectProfileSchema.safeParse({ ...ok, warnings: [{ code: "read-failed", message: "C:\\secret\\a.txt 읽기 실패" }] }).success).toBe(false);
    expect(projectProfileSchema.safeParse({ ...ok, project: { name: "C:\\x\\app" } }).success).toBe(false);
  });

  it("AC-008-06 Detector 상태로 '탐지 실패'와 '탐지 안 됨'을 구분한다", () => {
    const p = buildProfile("x", [run("frameworks", [], "ok"), run("languages", [], "failed"), run("ai", [], "partial")]);
    expect(p.detectors).toEqual([
      { id: "ai", status: "partial" },
      { id: "frameworks", status: "ok" },
      { id: "languages", status: "failed" },
    ]);
    expect(p.frameworks).toEqual([]);
  });

  it("AC-008-07 중복 Evidence는 합치고 같은 (카테고리, id, scope)는 병합하며 scope가 다르면 분리한다", () => {
    const p = buildProfile("x", [
      run("a", [react("package.json"), react("package.json")]),
      run("b", [react("package.json"), react("web/package.json")]),
    ]);
    expect(p.frameworks).toHaveLength(1);
    expect(p.frameworks[0]?.evidence.map((e) => e.file)).toEqual(["package.json", "web/package.json"]);
    const scoped = buildProfile("x", [
      run("project", [{ category: "aiClients", id: "codex", name: "Codex", scope: "project", evidence: [{ file: ".codex/config.toml", type: "config", value: "config.toml" }] }]),
      run("host", [{ category: "aiClients", id: "codex", name: "Codex", scope: "user", evidence: [{ file: "PATH", type: "executable", value: "codex" }] }]),
    ]);
    expect(scoped.aiClients.map((c) => [c.id, c.scope, c.confidence])).toEqual([["codex", "project", 1], ["codex", "user", 0.8]]);
    expect(validateFinding({ category: "aiClients", id: "codex", name: "Codex", scope: "user", evidence: [{ file: ".codex/config.toml", type: "config", value: "x" }] })).toMatch(/user scope/);
  });

  it("AC-008-08 ProjectDetector 계약과 DetectorRegistry는 중복 id를 거부한다", () => {
    const d = (id: string): ProjectDetector => ({ id, supports: () => true, detect: async () => ({ findings: [] }) });
    expect(new DetectorRegistry([d("a"), d("b")]).list().map((x) => x.id)).toEqual(["a", "b"]);
    expect(() => new DetectorRegistry([d("a"), d("a")])).toThrow(/두 번/);
  });

  it("AC-008-09 aiTools는 kind와 clients를 가지며 다른 설정 값은 담을 수 없다", () => {
    const mcp = (client: "claude-code" | "codex", file: string): Finding => ({
      category: "aiTools", id: "github", name: "github", scope: "project", kind: "mcp-server", clients: [client],
      evidence: [{ file, type: "config", value: "github" }],
    });
    const skill: Finding = { category: "aiTools", id: "github", name: "github", scope: "project", kind: "skill", clients: ["claude-code"], evidence: [{ file: ".claude/skills/github/SKILL.md", type: "config", value: "github" }] };
    const p = buildProfile("x", [run("ai", [mcp("codex", ".codex/config.toml"), mcp("claude-code", ".mcp.json"), skill])]);
    expect(p.aiTools.map((t) => [t.id, t.kind, t.clients])).toEqual([["github", "mcp-server", ["claude-code", "codex"]], ["github", "skill", ["claude-code"]]]);
    expect(projectProfileSchema.safeParse({ ...p, aiTools: [{ ...p.aiTools[0], command: "npx" }] }).success).toBe(false);
    expect(validateFinding({ ...react("package.json"), kind: "skill" })).toMatch(/aiTools/);
  });

  it("toKebabId는 서버 이름을 kebab-case id로 정규화한다", () => {
    expect(toKebabId("My_Server.v2")).toBe("my-server-v2");
    expect(toKebabId("context7")).toBe("context7");
  });
});

