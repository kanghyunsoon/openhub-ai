import { mkdir, mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { LIFECYCLE_STATE_KIND, entryKeyOf, type LifecycleStateFile, type ToolState } from "../../src/index";

/** lifecycle 테스트 공용 도우미. 실제 home·PATH·process.env·네트워크를 쓰지 않는다. */
export const newScratch = (name: string) => mkdtemp(path.join(os.tmpdir(), "openhub-" + name + "-"));

export async function homeIn(scratch: string): Promise<string> {
  const home = await mkdtemp(path.join(scratch, "home-"));
  await mkdir(home, { recursive: true });
  return home;
}

export const DIGEST_A = "sha256:" + "a".repeat(64);
export const DIGEST_B = "sha256:" + "b".repeat(64);

export function toolState(over: Partial<ToolState> = {}): ToolState {
  return {
    toolId: "memory-mcp",
    backend: "npx",
    revision: 1,
    target: { client: "claude-code", scope: "project", file: ".mcp.json", serverName: "memory", projectName: "demo", projectKey: "0123456789abcdef" },
    artifact: { requested: "@modelcontextprotocol/server-memory", resolved: null },
    launch: { platform: "linux", clientSpec: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory"] } },
    config: { entryDigest: DIGEST_A, tomlBlockDigest: null },
    appliedPlanDigest: DIGEST_B,
    committedAt: "2026-10-07T00:00:00.000Z",
    lastHealth: null,
    previous: null,
    ...over,
  };
}

export function stateOf(...entries: ToolState[]): LifecycleStateFile {
  return { schemaVersion: 1, kind: LIFECYCLE_STATE_KIND, entries: Object.fromEntries(entries.map((e) => [entryKeyOf(e.target), e])) };
}
