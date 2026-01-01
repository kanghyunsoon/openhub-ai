import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  REASON_CODES,
  classifyGaps,
  computeOpenScore,
  computeProjectFit,
  deriveNeeds,
  explainNeed,
  explainRecommendation,
  matchCandidates,
  resolveInstalledTools,
  resolveReasonRef,
  type MetadataSnapshot,
  type ProjectProfile,
  type Reason,
  type RegistryEntry,
} from "../../src/index";
import { REPO_ROOT, item, profile, seedEntries, syntheticEntries, syntheticSnapshot, tool } from "./helpers";

const synthetic = await syntheticEntries();
const seed = await seedEntries();
const snapshot = await syntheticSnapshot();

function explainAll(p: ProjectProfile, entries: readonly RegistryEntry[], snap: MetadataSnapshot | undefined = snapshot) {
  const installed = resolveInstalledTools(p, entries);
  const needs = deriveNeeds(p);
  const gaps = classifyGaps(p, needs, installed);
  const m = matchCandidates(p, gaps, installed, entries, { platform: "linux" });
  const recs = m.tools.map((e) => {
    const fit = computeProjectFit(e);
    if (fit === undefined) throw new Error("fit");
    const open = computeOpenScore(e.entry.manifest, snap);
    return { toolId: e.entry.manifest.name, reasons: explainRecommendation({ profile: p, evaluation: e, primary: fit.primary, installed, openScore: open.openScore, signals: open.signals }) };
  });
  const needReasons = gaps.flatMap((g) => explainNeed(g, m.candidates.get(g.capability) ?? []));
  return { recs, needReasons, ctx: { profile: p, entries, snapshot: snap, installed, needs } };
}

const clients = [item("claude-code", "Claude Code", "config", { file: ".mcp.json" }), item("codex", "Codex", "config", { file: ".codex/config.toml" })];
const full = (extra: Parameters<typeof profile>[0] = {}) =>
  profile({
    frameworks: [item("react", "React"), item("fastapi", "FastAPI", "dependency", { file: "pyproject.toml" })],
    databases: [item("postgresql", "PostgreSQL", "dependency", { file: "pyproject.toml" })],
    aiClients: clients,
    detectors: { "host-probe": "ok" },
    ...extra,
  });
const allReasons = (r: ReturnType<typeof explainAll>): Reason[] => [...r.recs.flatMap((x) => x.reasons), ...r.needReasons];
const OPEN_CODES = new Set(["repo-activity", "repo-release", "repo-community", "repo-shared", "repo-archived", "license-unknown"]);

describe("REQ-022 Recommendation Explanation", () => {
  it("AC-023-01 모든 추천은 need source 이유와 gap 상태 이유를 각각 1개 이상 가진다", () => {
    for (const p of [full(), full({ detectors: {} }), profile({ frameworks: [item("react", "React", "file-presence", { file: "vite.config.ts" })] })]) {
      const r = explainAll(p, synthetic);
      expect(r.recs.length).toBeGreaterThan(0);
      for (const rec of r.recs) {
        expect(rec.reasons.some((x) => x.code === "need-from-evidence"), rec.toolId).toBe(true);
        expect(rec.reasons.some((x) => x.code.startsWith("gap-")), rec.toolId).toBe(true);
      }
    }
  });

  it("AC-023-02 모든 reason code는 고정 표에 있고 refs는 실재하는 입력을 가리킨다", () => {
    for (const p of [full(), full({ aiTools: [tool("my-github"), tool("tool-a", { type: "file-presence" })] }), full({ detectors: { frameworks: "partial", "ai-environment": "failed" } })]) {
      const r = explainAll(p, synthetic);
      for (const reason of allReasons(r)) {
        expect(REASON_CODES).toContain(reason.code);
        expect(reason.refs.length, reason.code).toBeGreaterThan(0);
        for (const ref of reason.refs) expect(resolveReasonRef(ref, r.ctx), `${reason.code} ${ref}`).toBe(true);
      }
    }
    expect(resolveReasonRef("profile:frameworks/vue/project", explainAll(full(), synthetic).ctx)).toBe(false);
    expect(resolveReasonRef("metadata:example/tool-d#stars", explainAll(full(), synthetic).ctx)).toBe(false);
  });

  it("AC-023-03 같은 입력은 같은 문장을 만든다", () => {
    expect(JSON.stringify(explainAll(full(), synthetic))).toBe(JSON.stringify(explainAll(full(), synthetic)));
  });

  it("AC-023-03 입력에 없는 tech·tool 이름은 이유 문장에 나오지 않는다", () => {
    const universe = ["React", "Next.js", "Vue", "Spring Boot", "FastAPI", "PostgreSQL", "MySQL", "SQLite", "MongoDB", "TypeScript", "JavaScript", "Python", "Java", "Rust", "Claude Code", "Codex", "Cursor", "Docker", "GitHub Actions", ...seed.map((e) => e.manifest.displayName ?? e.manifest.name), ...synthetic.map((e) => e.manifest.displayName ?? e.manifest.name)];
    const p = full({ aiTools: [tool("my-github")] });
    const r = explainAll(p, synthetic);
    const allowed = new Set([...["languages", "frameworks", "databases", "packageManagers", "infrastructure", "aiClients"].flatMap((c) => (p[c as "languages"]).map((i) => i.name)), ...p.aiTools.map((t) => t.name)]);
    for (const reason of allReasons(r)) {
      const runtimeNames = reason.code.startsWith("runtime-") ? ["Python", "Node.js"] : [];
      for (const name of universe) {
        const found = new RegExp(`(^|[^A-Za-z.])${name.replace(/[.+]/gu, "\\$&")}($|[^A-Za-z])`, "u").test(reason.message);
        if (found) expect(allowed.has(name) || runtimeNames.includes(name), `${name} in "${reason.message}"`).toBe(true);
      }
    }
  });

  it("AC-023-04 unknown 상태 이유는 '판단 보류'를 포함하고 '설치되지 않음' 단정이 없다", () => {
    const weak = explainAll(profile({ frameworks: [item("react", "React", "file-presence", { file: "vite.config.ts" })], aiClients: clients, detectors: { "host-probe": "ok" } }), synthetic);
    const failed = explainAll(full({ detectors: { "host-probe": "ok", "ai-environment": "failed" } }), synthetic);
    for (const r of [weak, failed]) {
      const gapReasons = r.recs.flatMap((x) => x.reasons).filter((x) => x.code.startsWith("gap-unknown") || x.code === "installation-unknown");
      expect(gapReasons.length).toBeGreaterThan(0);
      for (const g of gapReasons) expect(g.message).toContain("판단 보류");
      expect(JSON.stringify(r)).not.toMatch(/설치되지 않음|미설치/u);
    }
  });

  it("AC-023-05 host 미검사로 likely-gap이면 '사용자 범위 미검사'가 있다", () => {
    const r = explainAll(full({ detectors: {} }), synthetic);
    for (const rec of r.recs) {
      const g = rec.reasons.find((x) => x.code === "gap-likely-host-unchecked");
      expect(g?.message, rec.toolId).toContain("사용자 범위 미검사");
    }
  });

  it("AC-023-06 shared·stale·no-release·license-unknown·required env에 대응하는 이유가 있고 env는 이름만 나온다", () => {
    const r = explainAll(full(), synthetic);
    const of = (id: string) => r.recs.find((x) => x.toolId === id)?.reasons ?? [];
    expect(of("tool-a").find((x) => x.code === "repo-shared")?.message).toContain("example/shared-monorepo");
    expect(of("tool-b").find((x) => x.code === "repo-release")?.message).toContain("1년 이상");
    expect(of("tool-e").find((x) => x.code === "repo-release")?.message).toContain("release 없음");
    expect(of("tool-e").some((x) => x.code === "license-unknown")).toBe(true);
    const env = of("tool-b").find((x) => x.code === "setup-required-env");
    expect(env?.message).toBe("환경변수 DATABASE_URI 설정 필요");
    expect(JSON.stringify(allReasons(r))).not.toContain("secret-password");
  });

  it("AC-023-07 explain 모듈은 LLM 클라이언트나 fetch를 쓰지 않는다", async () => {
    const text = await readFile(path.join(REPO_ROOT, "packages/core/src/recommendation/explain.ts"), "utf8");
    const imports = [...text.matchAll(/from\s+"([^"]+)"/gu)].map((m) => m[1]);
    expect(imports.every((i) => i?.startsWith("./") || i?.startsWith("../analyzer") || i?.startsWith("../registry"))).toBe(true);
    expect(text).not.toMatch(/\bfetch\s*\(|openai|anthropic|llm\./iu);
  });

  it("AC-023-08 OpenScore 관련 이유 문장에 금지어가 없다", () => {
    const r = explainAll(full(), synthetic);
    const openReasons = allReasons(r).filter((x) => OPEN_CODES.has(x.code));
    expect(openReasons.length).toBeGreaterThan(5);
    for (const x of openReasons) expect(x.message).not.toMatch(/보안|안전|신뢰|품질|검증|secure|safe|trust|quality|verified/iu);
  });

  it("AC-023-09 unresolved MCP가 있으면 installed-unidentified 이유에 서버 이름만 나온다", () => {
    const p = full({ aiTools: [tool("my-github", { value: "my-github (stdio, npx)" })] });
    const r = explainAll(p, synthetic);
    for (const rec of r.recs) {
      const x = rec.reasons.find((y) => y.code === "installed-unidentified");
      expect(x?.message, rec.toolId).toBe("식별되지 않은 MCP(my-github)가 있어 설치 여부를 단정할 수 없음");
      expect(x?.refs).toEqual(["installed:project/my-github"]);
    }
    expect(JSON.stringify(r.recs)).not.toContain("stdio");
  });
});
