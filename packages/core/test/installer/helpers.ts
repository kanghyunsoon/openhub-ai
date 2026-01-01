import {
  assembleInstallPlan,
  recommend,
  registryDigestExcluding,
  requestApproval,
  verifyApprovedPlan,
  type ConfigScope,
  type InstallClient,
  type PlanAssemblyInput,
  type PlanTargetInput,
  type PlannedInstall,
  type ProjectProfile,
  type RecommendationReport,
  type RegistryEntry,
  type VerifiedPlan,
} from "../../src/index";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import { FIXTURES_DIR, UPDATE_GOLDEN, item, profile } from "../recommendation/helpers";

export const INSTALLER_FIXTURES = path.join(FIXTURES_DIR, "installer");

/** installer golden과 바이트 단위로 비교한다. OPENHUB_UPDATE_GOLDEN=1이면 갱신한다. */
export async function expectInstallerGolden(relative: string, actual: string): Promise<void> {
  const file = path.join(INSTALLER_FIXTURES, "goldens", relative);
  if (UPDATE_GOLDEN) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, actual);
  }
  if (!existsSync(file)) throw new Error("golden 없음: " + relative + " — OPENHUB_UPDATE_GOLDEN=1로 생성하세요");
  expect(actual).toBe(await readFile(file, "utf8"));
}

/** 네 backend가 모두 사용 가능한 synthetic probe 결과. */
export const ALL_AVAILABLE = {
  node: { name: "node", available: true, version: "22.11.0", status: "ok" },
  npx: { name: "npx", available: true, version: "10.9.2", status: "shim-not-executed" },
  uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
  docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
} as const;

/** installer 테스트 공용 도우미. 실제 PATH·home·process.env를 읽지 않는다. */
export const NO_CONFIG = { exists: false, fileDigest: null, keyAbsent: true } as const;

/** synthetic launch(기본 linux). Windows npx는 D-016 규칙대로 cmd /d /c npx로 감싼다. */
export function launchSpec(executable: "npx" | "uvx" | "docker", args: string[], platform: "windows" | "macos" | "linux" = "linux") {
  const clientSpec = platform === "windows" && executable === "npx" ? { command: "cmd" as const, args: ["/d", "/c", "npx", ...args] } : { command: executable, args: [...args] };
  return { platform, executable, args, envNames: [] as string[], clientSpec };
}

const LOGICAL_FILE: Record<InstallClient, Record<ConfigScope, string>> = {
  "claude-code": { project: ".mcp.json", user: "~/.claude.json" },
  cursor: { project: ".cursor/mcp.json", user: "~/.cursor/mcp.json" },
  codex: { project: ".codex/config.toml", user: "~/.codex/config.toml" },
};

export function target(client: InstallClient, scope: ConfigScope = "project", over: Partial<PlanTargetInput> = {}): PlanTargetInput {
  const envReference = client === "claude-code" ? (scope === "user" ? "manual" : "claude-dollar-brace") : client === "cursor" ? "cursor-env" : "codex-env-vars";
  return { client, scope, file: LOGICAL_FILE[client][scope], envReference, precondition: { ...NO_CONFIG }, ...over };
}

export const claudeClient = item("claude-code", "Claude Code", "config", { file: ".mcp.json" });

/** Claude Code만 있는 synthetic profile. */
export function clientProfile(extra: Parameters<typeof profile>[0] = {}): ProjectProfile {
  return profile({ aiClients: [claudeClient], ...extra });
}

export function reportFor(p: ProjectProfile, entries: readonly RegistryEntry[]): RecommendationReport {
  return recommend(p, entries, undefined, { platform: "linux" });
}

export function entryOf(entries: readonly RegistryEntry[], toolId: string): RegistryEntry {
  const found = entries.find((e) => e.manifest.name === toolId);
  if (found === undefined) throw new Error("entry 없음: " + toolId);
  return found;
}

/** TASK-030 Builder가 만들 입력의 synthetic 판(npx launch-on-demand 기본). */
export function assemblyInput(entries: readonly RegistryEntry[], report: RecommendationReport, toolId: string, over: Partial<PlanAssemblyInput> = {}): PlanAssemblyInput {
  return {
    toolId,
    manifest: entryOf(entries, toolId).manifest,
    report,
    registryDigest: registryDigestExcluding(entries, toolId),
    backend: { adapter: "npx", selection: "preferred", skipped: [], probe: { name: "npx", available: true, version: "10.9.0", status: "ok" } },
    artifact: { kind: "npm-package", spec: toolId + "@latest", pinned: false, preparation: "launch-on-demand" },
    launch: launchSpec("npx", ["-y", toolId + "@latest"]),
    preparation: [],
    targets: [target("claude-code")],
    blockers: [],
    ...over,
  };
}

export function planFor(entries: readonly RegistryEntry[], report: RecommendationReport, toolId: string, over: Partial<PlanAssemblyInput> = {}): PlannedInstall {
  return assembleInstallPlan(assemblyInput(entries, report, toolId, over));
}

/** 테스트용: 모든 요구를 확인한 사람 대역으로 승인하고 실행 직전 검증까지 통과시킨다. */
export async function verifiedPlanOf(planned: PlannedInstall, regenerate: () => PlannedInstall = () => planned): Promise<VerifiedPlan> {
  const outcome = await requestApproval(planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error("승인 실패: " + outcome.status);
  const result = await verifyApprovedPlan(outcome.approval, regenerate);
  if (!result.ok) throw new Error("검증 실패: " + result.code);
  return result.verified;
}
