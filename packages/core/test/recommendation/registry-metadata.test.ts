import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRegistry, parseManifest, type Manifest, type RegistryEntry } from "../../src/index";
import { checkRecommendationMetadata } from "../../src/registry/recommendation-checks";
import { FIXTURES_DIR, REPO_ROOT } from "./helpers";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), "openhub-rec-registry-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function manifestYaml(name: string, extra = "", capabilities = "[browser-automation]"): string {
  return [
    "schemaVersion: 1",
    `name: ${name}`,
    `repository: { github: example/${name} }`,
    "category: [mcp]",
    `capabilities: ${capabilities}`,
    "targets: [claude-code]",
    "platform: { windows: true, macos: true, linux: true }",
    "install: { preferredAdapter: npx }",
    "healthCheck: { type: process }",
    "update: { source: npm }",
    "rollback: { supported: true }",
    extra,
  ].join("\n");
}

async function put(name: string, text: string) {
  await mkdir(path.join(root, "mcp"), { recursive: true });
  await writeFile(path.join(root, "mcp", `${name}.yaml`), text);
}

const parse = (text: string) => parseManifest(text);

describe("REQ-020 Registry Recommendation Metadata", () => {
  it("AC-018-01 recommendation 블록이 없는 기존 v1 Manifest는 수정 없이 parse된다", async () => {
    const plan = await readFile(path.join(FIXTURES_DIR, "plan-section-10.yaml"), "utf8");
    const r = parse(plan);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.manifest.recommendation).toBeUndefined();
    await put("tool-a", manifestYaml("tool-a"));
    const loaded = await loadRegistry(root);
    expect(loaded.issues).toEqual([]);
    expect(loaded.entries.map((e) => e.manifest.name)).toEqual(["tool-a"]);
  });

  it("AC-018-02 appliesTo.stacks·identity.mcpServerNames·source가 parse된다", () => {
    const r = parse(manifestYaml("tool-a", "recommendation:\n  appliesTo: { stacks: [postgresql] }\n  identity: { mcpServerNames: [postgres, pg.server_1] }\n  source: { type: shared-repo, path: src/postgres }"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.manifest.recommendation).toEqual({
        appliesTo: { stacks: ["postgresql"] },
        identity: { mcpServerNames: ["postgres", "pg.server_1"] },
        source: { type: "shared-repo", path: "src/postgres" },
      });
    }
  });

  it("AC-018-02 recommendation 블록 안의 모르는 key는 거부된다(strict)", () => {
    for (const extra of ["recommendation:\n  fingerprint: abc", "recommendation:\n  identity: { mcpServerNames: [x], packages: [y] }", "recommendation:\n  source: { type: dedicated, url: https://example.com }"]) {
      const r = parse(manifestYaml("tool-a", extra));
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.some((i) => i.path.startsWith("recommendation"))).toBe(true);
    }
  });

  it("AC-018-03 taxonomy에 없는 capability는 validate가 실패하고 Manifest 이름과 필드를 알려준다", async () => {
    await put("tool-a", manifestYaml("tool-a", "", "[browser-automation, kubernetes-deploy]"));
    const r = await loadRegistry(root);
    expect(r.entries).toEqual([]);
    expect(r.issues).toEqual([expect.objectContaining({ file: "mcp/tool-a.yaml", path: "capabilities[1]" })]);
    expect(r.issues[0]?.message).toContain("kubernetes-deploy");
  });

  it("AC-018-04 appliesTo.stacks에 M2 tech ID가 아닌 값이 있으면 실패한다", async () => {
    await put("tool-a", manifestYaml("tool-a", "recommendation:\n  appliesTo: { stacks: [postgresql, kubernetes] }"));
    await put("tool-b", manifestYaml("tool-b", "recommendation:\n  appliesTo: { stacks: [codex] }"));
    const r = await loadRegistry(root);
    expect(r.entries).toEqual([]);
    expect(r.issues.map((i) => [i.file, i.path])).toEqual([
      ["mcp/tool-a.yaml", "recommendation.appliesTo.stacks[1]"],
      ["mcp/tool-b.yaml", "recommendation.appliesTo.stacks[0]"],
    ]);
  });

  it("AC-018-05 canonical alias가 Registry 전체에서 중복되면 validate가 실패하고 alias와 두 Manifest 이름을 알려준다", async () => {
    await put("tool-a", manifestYaml("tool-a", "recommendation:\n  identity: { mcpServerNames: [github] }"));
    await put("tool-b", manifestYaml("tool-b", "recommendation:\n  identity: { mcpServerNames: [gh, github] }"));
    const r = await loadRegistry(root);
    expect(r.entries.map((e) => e.manifest.name)).toEqual(["tool-a"]);
    expect(r.issues).toHaveLength(1);
    expect(r.issues[0]).toMatchObject({ file: "mcp/tool-b.yaml", path: "recommendation.identity.mcpServerNames[1]" });
    for (const word of ["github", "tool-a", "tool-b"]) expect(r.issues[0]?.message).toContain(word);
  });

  it("AC-018-05 alias 중복 검사는 대소문자를 무시하고 같은 Manifest 안의 중복도 잡는다", () => {
    const entry = (name: string, aliases: string[]): RegistryEntry => ({
      file: `mcp/${name}.yaml`,
      directory: "mcp",
      manifest: { name, capabilities: [], recommendation: { identity: { mcpServerNames: aliases } } } as unknown as Manifest,
    });
    const cross = checkRecommendationMetadata([entry("tool-b", ["GitHub"]), entry("tool-a", ["github"])]);
    expect(cross.entries.map((e) => e.manifest.name)).toEqual(["tool-a"]);
    expect(cross.issues[0]?.message).toContain("GitHub");
    const self = checkRecommendationMetadata([entry("tool-c", ["memory", "MEMORY"])]);
    expect(self.entries).toEqual([]);
    expect(self.issues).toHaveLength(1);
  });

  it("AC-018-06 shared-repo는 path가 필수이며 절대 경로와 ..를 거부한다", () => {
    const src = (value: string) => parse(manifestYaml("tool-a", `recommendation:\n  source: ${value}`));
    expect(src("{ type: shared-repo, path: src/memory }").ok).toBe(true);
    expect(src("{ type: dedicated }").ok).toBe(true);
    for (const bad of ["{ type: shared-repo }", "{ type: shared-repo, path: /src/memory }", "{ type: shared-repo, path: ../other }", "{ type: shared-repo, path: 'C:/repo' }", "{ type: shared-repo, path: 'src\\\\memory' }"]) {
      const r = src(bad);
      expect(r.ok, bad).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("recommendation.source.path");
    }
  });

  it("AC-018-07 seed 7개는 recommendation 블록과 함께 registry 검증을 통과한다", async () => {
    const r = await loadRegistry(path.join(REPO_ROOT, "registry"));
    expect(r.issues).toEqual([]);
    expect(r.entries).toHaveLength(7);
    const get = (name: string) => r.entries.find((e) => e.manifest.name === name)?.manifest.recommendation;
    expect(get("memory-mcp")?.source).toEqual({ type: "shared-repo", path: "src/memory" });
    expect(get("postgres-mcp")?.appliesTo?.stacks).toEqual(["postgresql"]);
    const aliases = r.entries.flatMap((e) => e.manifest.recommendation?.identity?.mcpServerNames ?? []);
    expect(aliases.length).toBe(7);
    expect(new Set(aliases.map((a) => a.toLowerCase())).size).toBe(aliases.length);
    for (const e of r.entries) expect(e.manifest.recommendation?.source?.type).toBeDefined();
  });

  it("AC-018-08 canonical alias는 normalized lowercase여야 하며 대문자 alias는 실패한다", () => {
    for (const alias of ["GitHub", "GITHUB", "my GitHub", "-github"]) {
      const r = parse(manifestYaml("tool-a", `recommendation:\n  identity: { mcpServerNames: ['${alias}'] }`));
      expect(r.ok, alias).toBe(false);
      if (!r.ok) expect(r.issues.map((i) => i.path)).toContain("recommendation.identity.mcpServerNames[0]");
    }
    expect(parse(manifestYaml("tool-a", "recommendation:\n  identity: { mcpServerNames: [github, chrome-devtools, pg.server_1] }")).ok).toBe(true);
  });
});
