/**
 * pnpm bundle:inventory(TASK-071, D-036 §12). esbuild metafile의 node_modules 입력 package 집합이
 * Layer A production SBOM(pnpm sbom --prod, CycloneDX) component 집합에 포함되는지 검사한다(CLI·Desktop).
 * app.asar·CLI bundle 안에 번들된 의존성을 SBOM이 빠짐없이 덮는지 보장한다. network 0, 쓰기 0.
 *   tsx scripts/bundle-inventory.ts --metafile release-out/cli.metafile.json --metafile apps/desktop/dist/metafile.json [--sbom file]
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { bundledPackages, sbomComponentNames } from "./bundle-inventory-lib.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const { values } = parseArgs({ options: { metafile: { type: "string", multiple: true }, sbom: { type: "string" } }, strict: true });
const metafiles = values.metafile ?? [path.join(ROOT, "release-out", "cli.metafile.json"), path.join(ROOT, "apps", "desktop", "dist", "metafile.json")];
const sbomText = values.sbom !== undefined ? readFileSync(values.sbom, "utf8") : execSync("pnpm -r sbom --prod --sbom-format cyclonedx", { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const components = sbomComponentNames(JSON.parse(sbomText));
let failed = false;
for (const file of metafiles) {
  const pkgs = bundledPackages(JSON.parse(readFileSync(file, "utf8")));
  const missing = pkgs.filter((p) => !components.has(p));
  console.log(path.relative(ROOT, file) + ": bundle package " + pkgs.length + "개 [" + pkgs.join(", ") + "]" + (missing.length === 0 ? " ⊆ SBOM" : " — SBOM에 없음: " + missing.join(", ")));
  if (missing.length > 0) failed = true;
}
process.exit(failed ? 1 : 0);
