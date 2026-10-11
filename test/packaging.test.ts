import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { build } from "esbuild";
import { bundledPackages, sbomComponentNames } from "../scripts/bundle-inventory-lib.mjs";

/**
 * REQ-065 TASK-071 배포 산출물. 실제 pnpm pack:cli → npm pack tgz → 깨끗한 임시 prefix 설치 → 저장소 밖 cwd 실행.
 * 쓰기는 OS 임시 디렉터리뿐이다. metadata snapshot은 synthetic fixture를 쓴다(live GitHub 0).
 */
const ROOT = path.resolve(import.meta.dirname, "..");
/** registry/<category>/<name>.yaml Manifest 수(v0.2.0 P0-2부터 묶음마다 늘어나므로 숫자를 박지 않는다). */
const REGISTRY_MANIFEST_COUNT = readdirSync(path.join(ROOT, "registry"), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .flatMap((d) => readdirSync(path.join(ROOT, "registry", d.name)).filter((f) => f.endsWith(".yaml"))).length;
const SEED = path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json");
const scratch = mkdtempSync(path.join(tmpdir(), "openhub-packaging-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const tsxCli = path.join(path.dirname(createRequire(import.meta.url).resolve("tsx/package.json")), "dist", "cli.mjs");
const win = process.platform === "win32";

describe("REQ-065 TASK-071 배포 산출물", () => {
  it("AC-071-02·03 CLI tgz는 단일 bundle·registry·snapshot·LICENSE·NOTICES를 담고 의존이 없으며 임시 prefix 설치 후 저장소 밖에서 실행된다", { timeout: 180_000 }, () => {
    const out = path.join(scratch, "out");
    execFileSync(process.execPath, [tsxCli, "scripts/pack-cli.ts", "--metadata", SEED, "--out", out], { cwd: ROOT, stdio: "pipe" });
    const tgz = path.join(out, "openhub-ai-0.2.0.tgz");
    expect(existsSync(tgz)).toBe(true);
    const list = execFileSync("tar", ["-tzf", tgz], { encoding: "utf8" }).split(/\r?\n/u).filter(Boolean).sort();
    for (const f of ["package/dist/openhub.cjs", "package/dist/registry/catalog.yaml", "package/dist/registry/metadata.snapshot.json", "package/dist/registry/database/postgres-mcp.yaml", "package/LICENSE", "package/THIRD_PARTY_NOTICES.md", "package/package.json"]) expect(list).toContain(f);
    expect(list.filter((f) => f.endsWith(".js") || f.endsWith(".cjs") || f.endsWith(".mjs"))).toEqual(["package/dist/openhub.cjs"]);
    expect(list.filter((f) => f.endsWith(".yaml") && f.split("/").length === 5)).toHaveLength(REGISTRY_MANIFEST_COUNT);
    const extract = path.join(scratch, "extract");
    mkdirSync(extract);
    execFileSync("tar", ["-xzf", tgz, "-C", extract]);
    const pkgText = readFileSync(path.join(extract, "package", "package.json"), "utf8");
    const pkg = JSON.parse(pkgText) as Record<string, unknown>;
    expect(pkg).toMatchObject({ name: "openhub-ai", version: "0.2.0", bin: { openhub: "dist/openhub.cjs" }, license: "MIT", private: true });
    expect(pkg["dependencies"]).toBeUndefined();
    expect(pkgText).not.toMatch(/workspace:|tsx/u);
    const bundle = readFileSync(path.join(extract, "package", "dist", "openhub.cjs"), "utf8");
    expect(bundle).not.toMatch(/require\("(@openhub\/core|zod|yaml|smol-toml|fast-xml-parser)"\)/u);
    expect(bundle).not.toContain(ROOT);

    const prefix = path.join(scratch, "prefix");
    const cwd = path.join(scratch, "cwd");
    mkdirSync(cwd);
    execSync("npm install -g --no-audit --no-fund --prefix " + JSON.stringify(prefix) + " " + JSON.stringify(tgz), { stdio: "pipe" });
    const bin = win ? path.join(prefix, "openhub.cmd") : path.join(prefix, "bin", "openhub");
    const env = { ...process.env, OPENHUB_REGISTRY: "", OPENHUB_METADATA: "" };
    const run = (args: string) => execSync(JSON.stringify(bin) + " " + args, { cwd, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run("--version").trim()).toBe("0.2.0");
    expect((JSON.parse(run("registry list --json")) as unknown[]).length).toBe(REGISTRY_MANIFEST_COUNT);
    expect(JSON.parse(run("project scan " + JSON.stringify(path.join(ROOT, "packages/core/test/fixtures/projects/react-spring-monorepo")) + " --json"))).toMatchObject({ schemaVersion: expect.any(Number) });
    expect((JSON.parse(run("doctor --json")) as { registry: { source: string } }).registry.source).toBe("설치 패키지의 registry");
  });

  it("AC-071-06 electron-builder 26.x 설정은 Windows x64 NSIS·Linux AppImage만이고 macOS target이 없으며 asar·extraResources·appId가 고정이다", () => {
    const yml = readFileSync(path.join(ROOT, "apps/desktop/electron-builder.yml"), "utf8");
    const desktop = JSON.parse(readFileSync(path.join(ROOT, "apps/desktop/package.json"), "utf8")) as { devDependencies: Record<string, string>; dependencies?: Record<string, string> };
    expect(desktop.devDependencies["electron-builder"]).toMatch(/^26\.\d+\.\d+$/u);
    // TASK-072 조정: core는 런타임 의존성이라 dependencies에 두고(dependency SBOM --prod가 비지 않게) app.asar에서는 node_modules를 뺀다.
    expect(desktop.dependencies).toEqual({ "@openhub/core": "workspace:*" });
    expect(yml).toContain('  - "!**/node_modules/**/*"');
    for (const s of ["appId: io.github.kanghyunsoon.openhub-ai", "productName: OpenHub AI", "asar: true", "publish: null", "  - from: resources/registry\n    to: registry", "    - target: nsis\n      arch: [x64]", "    - target: AppImage\n      arch: [x64]"]) expect(yml).toContain(s);
    expect(yml).not.toMatch(/^mac:|dmg|pkg:|certificateFile|cscLink|signtoolOptions|azureSignOptions/mu);
    expect(readFileSync(path.join(ROOT, "scripts/pack-desktop.ts"), "utf8")).toContain("--publish never");
  });

+  it("AC-071-07 패키징된 Desktop은 process.resourcesPath의 Registry를 읽고 저장소 밖 cwd에서 --smoke를 확인하는 스크립트가 있다", () => {
    const main = readFileSync(path.join(ROOT, "apps/desktop/src/main.ts"), "utf8");
    expect(main).toContain('app.isPackaged ? path.join(process.resourcesPath, "registry") : path.join(app.getAppPath(), "resources", "registry")');
    const smoke = readFileSync(path.join(ROOT, "scripts/smoke-desktop-package.ts"), "utf8");
    for (const s of ['delete env["OPENHUB_REGISTRY"]', 'delete env["OPENHUB_METADATA"]', 'mkdtempSync(path.join(os.tmpdir(), "openhub-desktop-smoke-"))', '"resources", "registry"', "result.tools < 1"]) expect(smoke).toContain(s);
    const build = readFileSync(path.join(ROOT, "apps/desktop/build.mjs"), "utf8");
    expect(build).toContain('stageRegistry("resources/registry"');
    expect(readFileSync(path.join(ROOT, "scripts/pack-desktop.ts"), "utf8")).toContain('stageRegistry(path.join(desktop, "resources", "registry"), snapshot)');
  });

  it("AC-071-08 CLI·Desktop bundle의 package 집합 ⊆ Layer A production SBOM component 집합이다", { timeout: 120_000 }, async () => {
    const common = { bundle: true, platform: "node" as const, format: "cjs" as const, write: false, metafile: true, logLevel: "silent" as const };
    const cli = await build({ ...common, entryPoints: [path.join(ROOT, "apps/cli/src/main.ts")], outfile: path.join(scratch, "cli.cjs"), define: { "import.meta.url": "undefined" } });
    const desktop = await build({ ...common, entryPoints: [path.join(ROOT, "apps/desktop/src/main.ts")], outfile: path.join(scratch, "main.cjs"), external: ["electron"] });
    const sbom = sbomComponentNames(JSON.parse(execSync("pnpm -r sbom --prod --sbom-format cyclonedx", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })));
    for (const meta of [cli.metafile, desktop.metafile]) {
      const pkgs = bundledPackages(meta ?? {});
      expect(pkgs).toEqual(expect.arrayContaining(["zod", "yaml", "smol-toml", "fast-xml-parser"]));
      expect(pkgs.filter((p) => !sbom.has(p))).toEqual([]);
    }
    expect(bundledPackages({ inputs: { "node_modules/.pnpm/@scope+x@1.0.0/node_modules/@scope/x/index.js": {}, "src/a.ts": {} } })).toEqual(["@scope/x"]);
    const root = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { devDependencies: Record<string, string>; scripts: Record<string, string> };
    expect(root.devDependencies["esbuild"]).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it("AC-071-09 개발 흐름 스크립트가 그대로이고 배포 스크립트가 추가됐다", () => {
    const root = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(root.scripts).toMatchObject({ openhub: "tsx apps/cli/src/main.ts", desktop: "pnpm --filter @openhub/desktop start", "pack:cli": "tsx scripts/pack-cli.ts", "pack:desktop": "tsx scripts/pack-desktop.ts", "bundle:inventory": "tsx scripts/bundle-inventory.ts" });
    const gitignore = readFileSync(path.join(ROOT, ".gitignore"), "utf8");
    expect(gitignore).toContain("release-out/");
    expect(gitignore).toContain("apps/desktop/resources/");
  });
});
