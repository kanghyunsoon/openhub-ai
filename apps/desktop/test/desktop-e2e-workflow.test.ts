import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

/**
 * desktop-e2e.yml(필수 검사) 보조 스크립트 scripts/desktop-e2e.mjs와 워크플로 자체를 검사한다. CI check에서 매 PR 실행된다.
 * - changes: 영향이 없다고 확인된 경로만 "불필요", 그 밖·모르는 변경은 실행.
 * - list/check: apps/desktop/test에서 OPENHUB_E2E로 켜지는 파일을 모두 찾고, 결과에 없거나 건너뛰었으면 실패.
 */
const ROOT = path.resolve(import.meta.dirname, "../../..");
const SCRIPT = path.join(ROOT, "scripts", "desktop-e2e.mjs");
const lib = (await import(pathToFileURL(SCRIPT).href)) as {
  needsDesktopE2e(files: string[]): { run: boolean; needed: string[]; skipped: string[] };
  discoverElectronE2e(root: string): string[];
};
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-desktop-e2e-script-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const node = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("desktop-e2e 변경 판단", () => {
  it("문서·다른 워크플로·패키지 테스트 파일·CLI·저장소 테스트만 바뀌면 불필요다(PR #23 같은 변경)", () => {
    expect(lib.needsDesktopE2e(["docs/specs/real-npx-lifecycle-e2e.md", ".github/workflows/registry-remote.yml", "packages/core/test/registry/npx-lifecycle-real.e2e.test.ts"]).run).toBe(false);
    expect(lib.needsDesktopE2e(["README.md", "README.ko.md", "LICENSE", ".editorconfig", ".gitleaks.toml", "apps/cli/src/install.ts", "test/docs.test.ts", ".github/workflows/ci.yml"]).run).toBe(false);
    expect(lib.needsDesktopE2e([]).run).toBe(false);
  });

  it("Desktop·Core 소스·Core 테스트 helper·fixture·Registry·examples·빌드 스크립트·의존성·공용 설정·이 워크플로·스크립트는 실행한다", () => {
    for (const f of [
      "apps/desktop/src/main.ts",
      "apps/desktop/test/for-you.test.ts",
      "apps/desktop/build.mjs",
      "packages/core/src/installer/plan.ts",
      "packages/core/package.json",
      "packages/core/test/installer/harness.ts",
      "packages/core/test/process/fake-npm.ts",
      "packages/core/test/recommendation/helpers.ts",
      "packages/core/test/fixtures/projects/react-pnpm/package.json",
      "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json",
      "registry/mcp/playwright-mcp.yaml",
      "examples/demo-project/package.json",
      "scripts/stage-registry.mjs",
      "scripts/desktop-e2e.mjs",
      "package.json",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
      "vitest.config.ts",
      "tsconfig.json",
      ".gitattributes",
      ".github/workflows/desktop-e2e.yml",
      "some-new-top-level-file.json",
      "docs-but-not-docs/x.md",
    ]) expect(lib.needsDesktopE2e(["docs/x.md", f]).run, f).toBe(true);
  });

  it("CLI 모드는 GITHUB_OUTPUT 형식(run=…)만 stdout에 쓴다", async () => {
    const list = path.join(scratch, "changed.txt");
    await writeFile(list, "docs/a.md\npackages/core/test/x.test.ts\n");
    expect(node("changes", list).stdout).toBe("run=false\n");
    await writeFile(list, "docs/a.md\napps/desktop/src/main.ts\n");
    const r = node("changes", list);
    expect(r.stdout).toBe("run=true\n");
    expect(r.stderr).toContain("needs Electron E2E: apps/desktop/src/main.ts");
  });
});

describe("desktop-e2e 실행 대상 누락 방지", () => {
  it("Electron E2E 파일을 모두 찾고, 워크플로는 그 파일마다 한 단계씩 실행한다(목록이 같다)", async () => {
    const found = lib.discoverElectronE2e(ROOT);
    expect(found).toEqual([
      "apps/desktop/test/for-you-electron.e2e.test.ts",
      "apps/desktop/test/i18n-electron.e2e.test.ts",
      "apps/desktop/test/install-clients-electron.e2e.test.ts",
      "apps/desktop/test/npx-lifecycle-smoke.test.ts",
      "apps/desktop/test/repair-electron.e2e.test.ts",
      "apps/desktop/test/user-scope-electron.e2e.test.ts",
    ]);
    const yml = await readFile(path.join(ROOT, ".github/workflows/desktop-e2e.yml"), "utf8");
    const steps = [...yml.matchAll(/xvfb-run -a pnpm exec vitest run (\S+)/gu)].map((m) => m[1]!);
    expect([...steps].sort()).toEqual(found);
    expect(new Set(steps).size).toBe(steps.length);
    expect(yml).not.toMatch(/^s*continue-on-error:/mu);
    expect(yml).not.toMatch(/^\s+paths:/mu);
    expect(yml).toContain("node scripts/desktop-e2e.mjs check e2e-results");
  });

  async function fakeRoot(files: Record<string, string>) {
    const root = await mkdtemp(path.join(scratch, "root-"));
    for (const [rel, text] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), text);
    }
    return root;
  }
  const E2E = 'describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("x", () => {});\n';
  const result = (root: string, file: string, over: Record<string, unknown> = {}) => JSON.stringify({ success: true, numPassedTests: 2, numFailedTests: 0, numPendingTests: 0, numTodoTests: 0, testResults: [{ name: path.join(root, file) }], ...over });

  it("check: 모두 실행·통과면 성공, 등록되지 않은 새 E2E 파일·결과 누락·건너뜀·todo·0개·실패는 실패", async () => {
    const root = await fakeRoot({ "apps/desktop/test/a-electron.e2e.test.ts": E2E, "apps/desktop/test/b.test.ts": E2E, "apps/desktop/test/unit.test.ts": "it('u', () => {});\n" });
    const results = path.join(root, "results");
    await mkdir(results);
    await writeFile(path.join(results, "a.json"), result(root, "apps/desktop/test/a-electron.e2e.test.ts"));
    await writeFile(path.join(results, "b.json"), result(root, "apps/desktop/test/b.test.ts"));
    expect(node("check", results, "--root", root).status).toBe(0);
    // 새 E2E 파일을 추가했지만 워크플로에 등록하지 않음 → 실패.
    await writeFile(path.join(root, "apps/desktop/test/c-electron.e2e.test.ts"), E2E);
    const missing = node("check", results, "--root", root);
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("apps/desktop/test/c-electron.e2e.test.ts: Electron E2E file was not run");
    await writeFile(path.join(results, "c.json"), result(root, "apps/desktop/test/c-electron.e2e.test.ts"));
    expect(node("check", results, "--root", root).status).toBe(0);
    for (const bad of [{ numPendingTests: 1 }, { numTodoTests: 1 }, { numPassedTests: 0 }, { numFailedTests: 1, success: false }]) {
      await writeFile(path.join(results, "c.json"), result(root, "apps/desktop/test/c-electron.e2e.test.ts", bad));
      expect(node("check", results, "--root", root).status, JSON.stringify(bad)).toBe(1);
    }
    await writeFile(path.join(results, "c.json"), "{ broken");
    expect(node("check", results, "--root", root).status).toBe(1);
    expect(node("check", path.join(root, "no-such-dir"), "--root", root).status).toBe(1);
  });
});

