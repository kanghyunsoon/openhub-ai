import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** build·release 스크립트도 root typecheck(CI의 pnpm typecheck)에서 검사한다. 예전에는 13개 중 3개만 import로 딸려 검사됐다. */
const ROOT = path.resolve(import.meta.dirname, "..");
const tsc = path.join(path.dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin", "tsc");

describe("scripts typecheck 범위", () => {
  it("root tsconfig로 typecheck하면 scripts/의 TypeScript 파일이 모두 포함된다", { timeout: 60_000 }, () => {
    const listed = execFileSync(process.execPath, [tsc, "-p", "tsconfig.json", "--listFilesOnly"], { cwd: ROOT, encoding: "utf8" })
      .split(/\r?\n/u)
      .filter(Boolean)
      .map((f) => path.relative(ROOT, path.resolve(ROOT, f)).split(path.sep).join("/"));
    const included = new Set(listed);
    const scripts = readdirSync(path.join(ROOT, "scripts"))
      .filter((f) => /\.(?:ts|mts)$/u.test(f))
      .map((f) => "scripts/" + f);
    expect(scripts.length).toBeGreaterThanOrEqual(13);
    expect(scripts.filter((f) => !included.has(f))).toEqual([]);
  });

  it("CI가 root tsconfig(noEmit)로 typecheck를 실행한다", () => {
    const pkg = JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts["typecheck"]).toBe("tsc -p tsconfig.json");
    const tsconfig = JSON.parse(readFileSync(path.join(ROOT, "tsconfig.json"), "utf8")) as { compilerOptions: { noEmit?: boolean }; include: string[] };
    expect(tsconfig.compilerOptions.noEmit).toBe(true);
    expect(tsconfig.include).toContain("scripts");
    expect(readFileSync(path.join(ROOT, ".github/workflows/ci.yml"), "utf8")).toContain("- run: pnpm typecheck");
  });
});

