/**
 * pnpm pack:cli(TASK-071, D-036 §12). core를 포함한 CLI 단일 bundle(dist/openhub.cjs, node 24)을 만들고
 * 생성 package openhub-ai를 npm pack해 release-out/openhub-ai-<version>.tgz를 쓴다.
 * - tgz: dist/openhub.cjs, dist/registry/(Manifest·catalog.yaml·metadata snapshot), LICENSE, THIRD_PARTY_NOTICES.md, README.md, package.json.
 * - package.json에 dependencies가 없다(workspace:·tsx 0). private: true(npm publish는 사용자 승인 후 별도).
 * - metadata snapshot은 필수이며 schema·credential 검사를 통과해야 한다(--metadata 또는 OPENHUB_PACK_METADATA로 지정 가능).
 * - esbuild metafile을 release-out/cli.metafile.json에 남긴다(bundle inventory 검사용).
 */
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { build } from "esbuild";
import { OPENHUB_CORE_VERSION, checkBundledSnapshot } from "../packages/core/src/index";
import { ROOT, snapshotCandidates, stageRegistry } from "./stage-registry.mjs";

const { values } = parseArgs({ options: { metadata: { type: "string" }, out: { type: "string" } }, strict: true });
const OUT = path.resolve(values.out ?? path.join(ROOT, "release-out"));
const snapshot = values.metadata !== undefined ? path.resolve(values.metadata) : snapshotCandidates()[0];
if (snapshot === undefined) {
  console.error("metadata snapshot이 없습니다. 먼저 pnpm openhub collect를 실행하거나 --metadata <file>을 지정하세요");
  process.exit(1);
}
const checked = await checkBundledSnapshot(snapshot);
if (!checked.ok) {
  console.error("metadata snapshot을 포함할 수 없습니다: " + checked.reason);
  process.exit(1);
}

const stage = mkdtempSync(path.join(os.tmpdir(), "openhub-pack-cli-"));
try {
  const pkg = path.join(stage, "package");
  mkdirSync(path.join(pkg, "dist"), { recursive: true });
  const result = await build({
    entryPoints: [path.join(ROOT, "apps/cli/src/main.ts")],
    outfile: path.join(pkg, "dist", "openhub.cjs"),
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node24",
    banner: { js: "#!/usr/bin/env node" },
    // CJS bundle에서는 __dirname을 쓴다(main.ts). import.meta.url은 개발 실행(ESM) 전용이다.
    define: { "import.meta.url": "undefined" },
    metafile: true,
    legalComments: "eof",
    logLevel: "warning",
  });
  mkdirSync(OUT, { recursive: true });
  writeFileSync(path.join(OUT, "cli.metafile.json"), JSON.stringify(result.metafile, null, 2) + "\n");
  stageRegistry(path.join(pkg, "dist", "registry"), snapshot);
  for (const f of ["LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"]) if (existsSync(path.join(ROOT, f))) copyFileSync(path.join(ROOT, f), path.join(pkg, f));
  const manifest = {
    name: "openhub-ai",
    version: OPENHUB_CORE_VERSION,
    description: "Project-aware AI tool lifecycle manager (CLI)",
    license: "MIT",
    private: true,
    bin: { openhub: "dist/openhub.cjs" },
    engines: { node: ">=24.15" },
    files: ["dist", "LICENSE", "THIRD_PARTY_NOTICES.md", "README.md"],
    repository: { type: "git", url: "https://github.com/kanghyunsoon/openhub-ai" },
  };
  writeFileSync(path.join(pkg, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
  const tgz = path.join(OUT, "openhub-ai-" + OPENHUB_CORE_VERSION + ".tgz");
  rmSync(tgz, { force: true });
  execSync("npm pack --silent --pack-destination " + JSON.stringify(OUT), { cwd: pkg, stdio: ["ignore", "pipe", "inherit"] });
  if (!existsSync(tgz)) throw new Error("npm pack 결과가 없습니다: " + path.basename(tgz));
  const text = readFileSync(path.join(pkg, "package.json"), "utf8");
  if (/workspace:|"tsx"/u.test(text)) throw new Error("생성 package.json에 workspace:·tsx 의존이 있습니다");
  console.log("CLI package: release-out/" + path.basename(tgz) + " (metadata collectedAt " + checked.collectedAt + ")");
} finally {
  rmSync(stage, { recursive: true, force: true });
}
