import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { analyzeProject, defaultDetectors, projectProfileSchema, serializeProfile, type Finding, type ProjectDetector, type ScanContext } from "../src/index";

let base: string;
let root: string;
beforeEach(async () => {
  base = await mkdtemp(path.join(tmpdir(), "openhub-analyze-"));
  root = path.join(base, "demo");
  await mkdir(root);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies: { react: "19" } }));
  await writeFile(path.join(root, "broken.json"), '{"apiKey": "SECRET_IN_BROKEN_FILE", }');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const finding = (id: string, file = "package.json", extra: Partial<Finding> = {}): Finding => ({
  category: "frameworks", id, name: id.toUpperCase(), scope: "project", evidence: [{ file, type: "dependency", value: id }], ...extra,
});

function fake(id: string, findings: Finding[] | (() => never), opts: { supports?: boolean; read?: string } = {}): ProjectDetector & { calls: number } {
  return {
    id,
    calls: 0,
    supports: () => opts.supports ?? true,
    async detect(ctx: ScanContext) {
      this.calls++;
      if (opts.read !== undefined) await ctx.readJson(opts.read);
      if (typeof findings === "function") findings();
      return { findings: findings as Finding[] };
    },
  };
}

async function profileOf(detectors: ProjectDetector[]) {
  const r = await analyzeProject(root, { detectors });
  if (!r.ok) throw new Error(r.error.code);
  return r.profile;
}

describe("REQ-010 REQ-011 REQ-012 Analyzer Orchestrator", () => {
  it("AC-014-01 supports가 참인 Detector만 실행하고 결과를 병합해 검증된 Profile을 돌려준다", async () => {
    const skipped = fake("skipped", [finding("vue")], { supports: false });
    const used = fake("frameworks", [finding("react")]);
    const profile = await profileOf([skipped, used]);
    expect(skipped.calls).toBe(0);
    expect(used.calls).toBe(1);
    expect(profile.frameworks.map((f) => f.id)).toEqual(["react"]);
    expect(profile.project.name).toBe("demo");
    expect(projectProfileSchema.safeParse(profile).success).toBe(true);
  });

  it("AC-014-02 analyze.ts는 개별 Detector 구현을 import하지 않고 주입한 Detector가 그대로 반영된다", async () => {
    const source = await readFile(path.resolve(import.meta.dirname, "../src/analyzer/analyze.ts"), "utf8");
    const imports = [...source.matchAll(/from "([^"]+)"/gu)].map((m) => m[1]).sort();
    // 개별 Detector 구현(detectors/*.ts)은 import하지 않고 목록(detectors/index)만 쓴다.
    // host-probe는 프로젝트 Detector가 아니라 D-003의 opt-in 사용자 범위 경로다(TASK-016).
    expect(imports.filter((i) => i?.startsWith("./detectors/"))).toEqual(["./detectors/index"]);
    expect(imports).toEqual(["./detector", "./detectors/index", "./host-probe", "./merge", "./profile", "./scanner"]);
    expect(Array.isArray(defaultDetectors())).toBe(true);
    const profile = await profileOf([fake("plugin-x", [finding("svelte")])]);
    expect(profile.frameworks.map((f) => f.id)).toEqual(["svelte"]);
  });

  it("AC-014-03 예외를 던진 Detector만 failed가 되고 다른 결과는 유지되며 예외 메시지는 남지 않는다", async () => {
    const boom = fake("boom", () => {
      throw new Error("C:\\Users\\me\\token=SECRET_FROM_EXCEPTION");
    });
    const profile = await profileOf([boom, fake("frameworks", [finding("react")])]);
    expect(profile.detectors).toEqual([{ id: "boom", status: "failed" }, { id: "frameworks", status: "ok" }]);
    expect(profile.frameworks.map((f) => f.id)).toEqual(["react"]);
    expect(profile.warnings).toContainEqual(expect.objectContaining({ code: "detector-failed", detector: "boom" }));
    expect(serializeProfile(profile)).not.toContain("SECRET_FROM_EXCEPTION");
  });

  it("AC-014-04 Detector 등록 순서와 결과 순서를 바꿔도 Profile JSON이 같다(경고·partial 판정 포함)", async () => {
    const a = () => fake("alpha", [finding("react"), finding("vue", "web/package.json")], { read: "broken.json" });
    const b = () => fake("beta", [finding("react", "web/package.json"), finding("next")], { read: "broken.json" });
    const one = serializeProfile(await profileOf([a(), b()]));
    const reversed = [b(), a()].map((d) => ({ ...d, detect: async (ctx: ScanContext) => { const r = await d.detect.call(d, ctx); return { findings: [...r.findings].reverse() }; } }));
    const two = serializeProfile(await profileOf(reversed));
    expect(two).toBe(one);
    const parsed = JSON.parse(one) as { detectors: unknown; warnings: { detector?: string; code: string }[] };
    // 같은 깨진 파일을 읽은 Detector는 실행 순서와 무관하게 모두 partial이고, 파일 경고는 한 번만 남는다.
    expect(parsed.detectors).toEqual([{ id: "alpha", status: "partial" }, { id: "beta", status: "partial" }]);
    expect(parsed.warnings).toEqual([{ code: "parse-failed", file: "broken.json", message: expect.any(String) }]);
    expect(one).not.toContain("SECRET_IN_BROKEN_FILE");
  });

  it("AC-014-05 계약을 위반한 출력(빈 evidence, 절대 경로, user scope)은 그 Detector를 failed로 만든다", async () => {
    const cases: [string, Finding][] = [
      ["empty-evidence", { ...finding("react"), evidence: [] }],
      ["absolute-path", finding("react", "C:/Users/me/app/package.json")],
      ["user-scope", { ...finding("react"), scope: "user", evidence: [{ file: "PATH", type: "executable", value: "react" }] }],
      ["bad-id", { ...finding("react"), id: "React!" }],
    ];
    for (const [id, bad] of cases) {
      const profile = await profileOf([fake(id, [bad, finding("vue")]), fake("good", [finding("next")])]);
      expect(profile.detectors, id).toEqual([{ id: "good", status: "ok" }, { id, status: "failed" }].sort((x, y) => (x.id < y.id ? -1 : 1)));
      expect(profile.frameworks.map((f) => f.id), id).toEqual(["next"]);
      expect(profile.warnings, id).toContainEqual(expect.objectContaining({ code: "detector-invalid-output", detector: id }));
      expect(serializeProfile(profile)).not.toMatch(/C:\/Users/u);
    }
  });
});

