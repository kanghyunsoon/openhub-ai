/**
 * pnpm smoke:desktop-package(TASK-071 AC-071-07). pnpm pack:desktop --dir로 만든 unpacked 앱을 저장소 밖 임시 cwd에서
 * --smoke로 실행해 process.resourcesPath의 Registry를 읽는지 확인한다. OPENHUB_REGISTRY·OPENHUB_METADATA는 지운다.
 * Linux에서는 화면이 필요하므로 CI에서 xvfb-run으로 감싼다.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const unpacked = path.join(ROOT, "release-out", "desktop", process.platform === "win32" ? "win-unpacked" : "linux-unpacked");
const exe = path.join(unpacked, process.platform === "win32" ? "OpenHub AI.exe" : "openhub-ai");
const registry = path.join(unpacked, "resources", "registry");
if (!existsSync(exe) || !existsSync(registry)) {
  console.error("unpacked 앱이 없습니다. 먼저 pnpm pack:desktop --dir를 실행하세요");
  process.exit(1);
}
const cwd = mkdtempSync(path.join(os.tmpdir(), "openhub-desktop-smoke-"));
try {
  const env = { ...process.env };
  delete env["OPENHUB_REGISTRY"];
  delete env["OPENHUB_METADATA"];
  const args = process.platform === "linux" ? ["--smoke", "--no-sandbox"] : ["--smoke"];
  const r = spawnSync(exe, args, { cwd, env, encoding: "utf8", timeout: 120_000 });
  const line = (r.stdout ?? "").split(/\r?\n/u).find((l) => l.startsWith("OPENHUB_SMOKE "));
  if (r.status !== 0 || line === undefined) {
    console.error("packaged smoke 실패 (exit " + String(r.status) + ")\n" + (r.stderr ?? "").slice(-2000));
    process.exit(1);
  }
  const result = JSON.parse(line.slice("OPENHUB_SMOKE ".length)) as { tools: number };
  if (result.tools < 1) {
    console.error("resourcesPath Registry를 읽지 못했습니다");
    process.exit(1);
  }
  console.log("packaged Desktop smoke 통과: " + line);
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
