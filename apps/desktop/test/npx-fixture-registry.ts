import { appendFileSync, copyFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "../../..");
let dir: string | undefined;

/**
 * 실제 Registry 복사본 + 테스트 전용 npx fixture(fixture-npx-mcp, v0.2.1 #69). Memory MCP가 지원 중단되면서 "버전 미고정 npx 도구"
 * 역할을 fixture가 맡는다. 실제 registry/는 바꾸지 않는다(임시 복사본, 프로세스마다 1회).
 */
export function registryWithNpxFixture(): string {
  if (dir !== undefined) return dir;
  const target = path.join(mkdtempSync(path.join(tmpdir(), "openhub-desktop-fixture-registry-")), "registry");
  cpSync(path.join(ROOT, "registry"), target, { recursive: true });
  copyFileSync(path.join(ROOT, "packages", "core", "test", "fixtures", "registry-npx-fixture", "mcp", "fixture-npx-mcp.yaml"), path.join(target, "mcp", "fixture-npx-mcp.yaml"));
  appendFileSync(path.join(target, "catalog.yaml"), "  fixture-npx-mcp: { addedAt: null }\n");
  dir = target;
  return target;
}

