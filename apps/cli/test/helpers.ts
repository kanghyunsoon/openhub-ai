import { appendFileSync, copyFileSync, cpSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CliIO } from "../src/cli";

const REPO = path.resolve(import.meta.dirname, "../../..");
let fixtureRegistry: string | undefined;

/**
 * 실제 Registry 복사본 + 테스트 전용 npx fixture(fixture-npx-mcp, v0.2.1 #69). Memory MCP가 지원 중단되면서 "버전 미고정 npx 도구"
 * 역할을 맡는 fixture를 CLI 테스트가 쓰도록 한다. 실제 registry/는 바꾸지 않는다(임시 복사본, 프로세스마다 1회).
 */
export function registryWithNpxFixture(): string {
  if (fixtureRegistry !== undefined) return fixtureRegistry;
  const dir = path.join(mkdtempSync(path.join(tmpdir(), "openhub-cli-fixture-registry-")), "registry");
  cpSync(path.join(REPO, "registry"), dir, { recursive: true });
  copyFileSync(path.join(REPO, "packages", "core", "test", "fixtures", "registry-npx-fixture", "mcp", "fixture-npx-mcp.yaml"), path.join(dir, "mcp", "fixture-npx-mcp.yaml"));
  appendFileSync(path.join(dir, "catalog.yaml"), "  fixture-npx-mcp: { addedAt: null }\n");
  fixtureRegistry = dir;
  return dir;
}

/** 출력을 메모리에 모으는 테스트용 CLI 입출력. registryDir를 주면 그 Registry를 쓴다(기본: cwd 기준 registry/). */
export function memoryIO(cwd = process.cwd(), registryDir?: string): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, version: "0.0.0-test", out: (l) => stdout.push(l), err: (l) => stderr.push(l), ...(registryDir === undefined ? {} : { registryDir }) };
}
