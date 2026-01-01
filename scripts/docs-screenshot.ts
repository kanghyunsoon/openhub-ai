/**
 * pnpm docs:screenshot(TASK-073). 문서 스크린샷을 fixture 데이터로만 만든다: examples/demo-project + 합성 metadata snapshot,
 * Desktop --smoke 경로(가짜 Candidate). 개인 경로·실제 cache를 쓰지 않는다. 결과: docs/images/desktop.png
 */
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const out = path.join(ROOT, "docs", "images", "desktop.png");
mkdirSync(path.dirname(out), { recursive: true });
const env = {
  ...process.env,
  OPENHUB_SMOKE_PROJECT: path.join(ROOT, "examples", "demo-project"),
  OPENHUB_METADATA: path.join(ROOT, "packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json"),
  OPENHUB_REGISTRY: path.join(ROOT, "registry"),
  OPENHUB_CANDIDATES: path.join(ROOT, "examples", "demo-project", "no-candidates"),
  OPENHUB_SCREENSHOT: out,
};
for (const k of ["OPENHUB_SMOKE_INSTALL", "OPENHUB_SMOKE_UPDATE", "OPENHUB_SMOKE_RELEASE"]) delete env[k];
const r = spawnSync("pnpm", ["--filter", "@openhub/desktop", "smoke"], { cwd: ROOT, env, stdio: "inherit", shell: process.platform === "win32" });
process.exitCode = r.status ?? 1;
