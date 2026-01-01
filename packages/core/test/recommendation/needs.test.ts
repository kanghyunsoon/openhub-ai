import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  AI_CLIENT_IDS,
  CAPABILITIES,
  DEFAULT_TECH_RULES,
  KNOWN_TECH_IDS,
  NEED_RULES,
  TAXONOMY_VERSION,
  deriveNeeds,
  isCapabilityId,
  loadRegistry,
  strengthOf,
  type NeedRule,
} from "../../src/index";
import { REPO_ROOT, expectGolden, fixtureProfile, item, profile, shuffleProfile } from "./helpers";

const summary = (p: Parameters<typeof deriveNeeds>[0]) => deriveNeeds(p).map((n) => `${n.capability}:${n.priority}:${n.strength}`);

describe("REQ-020 Capability Taxonomy와 Need Rules", () => {
  it("AC-017-01 taxonomy는 seed capability 14개를 포함하고 kebab-case·중복 없음·label·domain을 가진다", async () => {
    expect(TAXONOMY_VERSION).toBe(1);
    expect(CAPABILITIES).toHaveLength(14);
    const ids = CAPABILITIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of CAPABILITIES) {
      expect(c.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
      expect(c.label.length).toBeGreaterThan(0);
      expect(c.domain.length).toBeGreaterThan(0);
    }
    const { entries } = await loadRegistry(path.join(REPO_ROOT, "registry"));
    const seedCapabilities = new Set(entries.flatMap((e) => e.manifest.capabilities));
    expect(seedCapabilities.size).toBe(14);
    for (const id of seedCapabilities) expect(isCapabilityId(id)).toBe(true);
  });

  it("AC-017-02 Need Rule trigger는 M2 tech ID이고 capability는 taxonomy에 있다", () => {
    for (const rule of NEED_RULES) {
      for (const t of rule.triggers) expect(KNOWN_TECH_IDS[rule.category]).toContain(t);
      for (const n of rule.needs) expect(isCapabilityId(n.capability)).toBe(true);
    }
  });

  it("AC-017-02 KNOWN_TECH_IDS는 M2 Detector가 실제로 만드는 ID 집합과 같다", async () => {
    const ids = (category: string) => DEFAULT_TECH_RULES.filter((r) => r.category === category).map((r) => r.id).sort();
    expect([...KNOWN_TECH_IDS.frameworks].sort()).toEqual(ids("frameworks"));
    expect([...KNOWN_TECH_IDS.databases].sort()).toEqual(ids("databases"));
    expect([...KNOWN_TECH_IDS.aiClients].sort()).toEqual([...AI_CLIENT_IDS].sort());
    const src = (file: string) => readFile(path.join(REPO_ROOT, "packages/core/src/analyzer/detectors", file), "utf8");
    const keysOf = (text: string, constName: string) => {
      const body = new RegExp(`const ${constName} = \\{([^}]*)\\}`, "u").exec(text)?.[1] ?? "";
      return [...body.matchAll(/(?:^|[\s,{])"?([a-z][a-z0-9-]*)"?\s*:/gu)].map((m) => m[1]).sort();
    };
    const languages = await src("languages.ts");
    expect([...KNOWN_TECH_IDS.languages].sort()).toEqual(keysOf(languages, "LANG"));
    expect([...KNOWN_TECH_IDS.packageManagers].sort()).toEqual(keysOf(languages, "PM_NAME"));
    expect([...KNOWN_TECH_IDS.infrastructure].sort()).toEqual(keysOf(await src("infrastructure.ts"), "NAMES"));
  });

  it("AC-017-03 react-pnpm fixture의 need 목록이 golden과 일치한다(시나리오 1)", async () => {
    const needs = deriveNeeds(await fixtureProfile("react-pnpm"));
    expect(summary(await fixtureProfile("react-pnpm"))).toEqual(
      expect.arrayContaining(["browser-automation:high:strong", "e2e-testing:high:strong", "performance-tracing:medium:strong", "network-inspection:medium:strong"]),
    );
    await expectGolden("react-pnpm.needs.json", JSON.stringify(needs, null, 2) + "\n");
  });

  it("AC-017-04 python-fastapi fixture는 DB need를 PostgreSQL 항목과 연결한다(시나리오 4)", async () => {
    const needs = deriveNeeds(await fixtureProfile("python-fastapi"));
    const pick = (cap: string) => needs.find((n) => n.capability === cap);
    expect(pick("db-schema-access")?.priority).toBe("high");
    expect(pick("sql-query")?.priority).toBe("high");
    expect(pick("query-tuning")?.priority).toBe("medium");
    for (const cap of ["db-schema-access", "sql-query", "query-tuning"]) {
      expect(pick(cap)?.sources).toEqual([{ category: "databases", itemId: "postgresql", scope: "project", confidence: 1, strength: "strong" }]);
    }
  });

  it("AC-017-05 git만으로는 github-api need가 없고 github-actions가 있으면 high다", () => {
    const gitOnly = deriveNeeds(profile({ infrastructure: [item("git", "Git", "config", { file: ".git/HEAD" })] }));
    expect(gitOnly.find((n) => n.capability === "github-api")).toBeUndefined();
    const actions = deriveNeeds(profile({ infrastructure: [item("git", "Git", "config"), item("github-actions", "GitHub Actions", "config", { file: ".github/workflows/ci.yml" })] }));
    expect(actions.find((n) => n.capability === "github-api")?.priority).toBe("high");
  });

  it("AC-017-06 confidence 경계값 5개를 strong·environment·weak로 해석한다", () => {
    expect([1.0, 0.9, 0.8, 0.6, 0.4].map(strengthOf)).toEqual(["strong", "strong", "environment", "weak", "weak"]);
  });

  it("AC-017-06 source가 여러 개면 최강 강도를 쓰고 source 목록 정렬은 고정이다", () => {
    const p = profile({
      frameworks: [item("vue", "Vue", "file-presence", { file: "vite.config.ts" }), item("react", "React", "dependency")],
    });
    const need = deriveNeeds(p).find((n) => n.capability === "browser-automation");
    expect(need?.strength).toBe("strong");
    expect(need?.sources.map((s) => `${s.itemId}:${s.strength}`)).toEqual(["react:strong", "vue:weak"]);
    const weakOnly = deriveNeeds(profile({ frameworks: [item("vue", "Vue", "file-presence")] })).find((n) => n.capability === "browser-automation");
    expect(weakOnly?.strength).toBe("weak");
  });

  it("AC-017-07 같은 capability의 trigger 여러 개는 need 하나로 합치고 priority는 최댓값이다", () => {
    const rules: NeedRule[] = [
      { id: "T-1", category: "frameworks", triggers: ["react"], needs: [{ capability: "library-docs", priority: "low" }] },
      { id: "T-2", category: "databases", triggers: ["postgresql"], needs: [{ capability: "library-docs", priority: "high" }] },
    ];
    const needs = deriveNeeds(profile({ frameworks: [item("react", "React")], databases: [item("postgresql", "PostgreSQL")] }), rules);
    expect(needs).toHaveLength(1);
    expect(needs[0]?.priority).toBe("high");
    expect(needs[0]?.sources.map((s) => s.itemId)).toEqual(["react", "postgresql"]);
    const real = deriveNeeds(profile({ frameworks: [item("react", "React"), item("fastapi", "FastAPI")] })).filter((n) => n.capability === "library-docs");
    expect(real).toHaveLength(1);
    expect(real[0]?.sources.map((s) => s.itemId)).toEqual(["fastapi", "react"]);
  });

  it("AC-017-08 Profile 배열 순서를 섞어도 needs 결과가 같다", async () => {
    for (const name of ["react-spring-monorepo", "claude-mcp", "docker-project"]) {
      const p = await fixtureProfile(name);
      expect(JSON.stringify(deriveNeeds(shuffleProfile(p)))).toBe(JSON.stringify(deriveNeeds(p)));
    }
  });
});
