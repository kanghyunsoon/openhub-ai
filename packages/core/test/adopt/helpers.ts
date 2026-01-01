import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AdoptPlanOptions, AdoptPlanResult, PlannedAdopt, RegistryEntry } from "../../src/index";

/** adopt 테스트 공용 도우미. 임시 project·home만 쓴다(실제 home·process.env·network 없음). */
export const MEMORY = "@modelcontextprotocol/server-memory";
export interface Case {
  projectRoot: string;
  homeDir: string;
}
export async function newCase(scratch: string, files: Record<string, unknown> = {}, home: Record<string, unknown> = {}): Promise<Case> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const projectRoot = path.join(base, "project");
  const homeDir = path.join(base, "home");
  await mkdir(projectRoot, { recursive: true });
  await mkdir(homeDir, { recursive: true });
  for (const [root, map] of [[projectRoot, files], [homeDir, home]] as const) {
    for (const [rel, c] of Object.entries(map)) {
      await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
      await writeFile(path.join(root, rel), typeof c === "string" ? c : JSON.stringify(c, null, 2) + "\n");
    }
  }
  return { projectRoot, homeDir };
}
export const mcp = (servers: Record<string, unknown>) => ({ mcpServers: servers });
export const adoptOptions = (entries: readonly RegistryEntry[], c: Case, over: Partial<AdoptPlanOptions> = {}): AdoptPlanOptions => ({
  toolId: "memory-mcp",
  projectRoot: c.projectRoot,
  homeDir: c.homeDir,
  entries,
  platform: "linux",
  client: "claude-code",
  scope: "project",
  ...over,
});
export const plannedOf = (r: AdoptPlanResult): PlannedAdopt => {
  if (!r.ok) throw new Error(r.code + " " + r.message);
  return r.planned;
};

