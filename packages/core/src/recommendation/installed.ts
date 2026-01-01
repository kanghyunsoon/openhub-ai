import { z } from "zod";
import { AI_CLIENT_IDS, AI_TOOL_KINDS, SCOPES, type AiToolKind, type DetectorStatus, type ProjectProfile, type Scope } from "../analyzer/index";
import type { RegistryEntry } from "../registry/index";
import { STRENGTHS, strengthOf } from "./needs";

/**
 * 설치 Tool 식별(§4, D-008).
 * MCP server name(= M2 aiTools의 name, 사용자 config key 원문)과 Registry canonical alias의 exact-match만 쓴다.
 * fuzzy·substring·대소문자 무시·LLM 매칭은 하지 않는다. "GitHub", "my-github"는 unresolved다.
 * command·args·package identity는 M2 계약대로 Profile에 없으므로 쓰지 않는다.
 * M6(D-026): 호출자가 Identity Fingerprint로 만든 identityHints(exact·strong만)를 넘기면 alias가 없는 서버도
 * 그 Tool로 resolved 처리한다. Profile·RecommendationReport schema는 바뀌지 않는다. weak 근거는 hint가 될 수 없다.
 */

export const RESOLUTIONS = ["resolved", "unresolved"] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const installedToolSchema = z.strictObject({
  serverName: z.string().min(1).max(100),
  kind: z.enum(AI_TOOL_KINDS),
  toolId: z.string().min(1).max(64).nullable(),
  resolution: z.enum(RESOLUTIONS),
  strength: z.enum(STRENGTHS),
  scope: z.enum(SCOPES),
  clients: z.array(z.enum(AI_CLIENT_IDS)),
  capabilities: z.array(z.string()),
});
export type InstalledTool = z.output<typeof installedToolSchema>;

/** Identity Fingerprint 결과(D-026). exact·strong만 resolved 근거가 된다. artifact는 검증된 package·image key다. */
export interface IdentityHint {
  serverName: string;
  scope: Scope;
  toolId: string;
  grade: "exact" | "strong";
  artifact: string;
}

const SCOPE_ORDER: Readonly<Record<Scope, number>> = { project: 0, user: 1 };
const KIND_ORDER: Readonly<Record<AiToolKind, number>> = { "mcp-server": 0, skill: 1, plugin: 2 };
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** canonical alias → Registry 항목. alias 유일성은 registry 검증(TASK-018)이 보장한다. */
export function canonicalAliasIndex(entries: readonly RegistryEntry[]): ReadonlyMap<string, RegistryEntry> {
  const index = new Map<string, RegistryEntry>();
  for (const entry of [...entries].sort((a, b) => cmp(a.manifest.name, b.manifest.name))) {
    for (const alias of entry.manifest.recommendation?.identity?.mcpServerNames ?? []) {
      if (!index.has(alias)) index.set(alias, entry);
    }
  }
  return index;
}

function hintFor(hints: readonly IdentityHint[], name: string, scope: Scope, entries: readonly RegistryEntry[]): RegistryEntry | undefined {
  const hint = hints.find((h) => h.serverName === name && h.scope === scope && (h.grade === "exact" || h.grade === "strong"));
  return hint === undefined ? undefined : entries.find((e) => e.manifest.name === hint.toolId);
}

/** Profile aiTools → installedTools. 정렬: scope → serverName → kind. alias가 없으면 identityHints(exact·strong)를 쓴다. */
export function resolveInstalledTools(profile: ProjectProfile, entries: readonly RegistryEntry[], hints: readonly IdentityHint[] = []): InstalledTool[] {
  const index = canonicalAliasIndex(entries);
  return profile.aiTools
    .map((item): InstalledTool => {
      const entry = item.kind === "mcp-server" ? (index.get(item.name) ?? hintFor(hints, item.name, item.scope, entries)) : undefined;
      return {
        serverName: item.name,
        kind: item.kind,
        toolId: entry?.manifest.name ?? null,
        resolution: entry === undefined ? "unresolved" : "resolved",
        strength: strengthOf(item.confidence),
        scope: item.scope,
        clients: [...item.clients].sort(),
        capabilities: entry === undefined ? [] : [...entry.manifest.capabilities].sort(),
      };
    })
    .sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope] || cmp(a.serverName, b.serverName) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
}

/** alias 없이 strong fingerprint로 resolved된 서버의 설명(assessment.warnings에 붙인다). */
export function strongIdentityNotes(profile: ProjectProfile, entries: readonly RegistryEntry[], hints: readonly IdentityHint[]): { code: string; message: string }[] {
  const index = canonicalAliasIndex(entries);
  const out: { code: string; message: string }[] = [];
  for (const item of profile.aiTools) {
    if (item.kind !== "mcp-server" || index.has(item.name)) continue;
    const hint = hints.find((h) => h.serverName === item.name && h.scope === item.scope && h.grade === "strong");
    if (hint === undefined || !entries.some((e) => e.manifest.name === hint.toolId)) continue;
    out.push({
      code: "identity-strong-match",
      message: (item.name + "(" + item.scope + ") 서버를 alias 대신 실행 artifact(" + hint.artifact + ")로 " + hint.toolId + "로 식별했습니다(후보 1개)").slice(0, 300),
    });
  }
  return out;
}

/** satisfied 근거가 되는 설치: resolved이고 strength가 strong 또는 environment. */
export function isSatisfyingInstall(tool: InstalledTool): boolean {
  return tool.resolution === "resolved" && tool.strength !== "weak";
}

/** Gap 판정에 쓰는 unresolved MCP(skill·plugin 제외). */
export function unresolvedMcpServers(installed: readonly InstalledTool[]): InstalledTool[] {
  return installed.filter((t) => t.kind === "mcp-server" && t.resolution === "unresolved");
}

// ---------------------------------------------------------------- Detector 상태와 검사 범위

export function detectorStatus(profile: ProjectProfile, id: string): DetectorStatus | undefined {
  return profile.detectors.find((d) => d.id === id)?.status;
}

/** host-probe가 ok·partial이면 사용자 범위까지 검사한 것이다(D-003: 기본 OFF, --include-host일 때만 실행). */
export function inspectedScopes(profile: ProjectProfile): Scope[] {
  const host = detectorStatus(profile, "host-probe");
  return host === "ok" || host === "partial" ? ["project", "user"] : ["project"];
}

export const INSTALLATION_STATUSES = ["not-installed", "unidentified-present", "unknown"] as const;
export type InstallationStatus = (typeof INSTALLATION_STATUSES)[number];

/**
 * 추천 후보의 설치 상태(§4). resolved로 설치된 tool은 추천에서 빠지므로 여기서 다루지 않는다.
 * 우선순위: unknown → unidentified-present → not-installed. not-installed는 inspectedScopes 범위 안에서만 의미가 있다.
 */
export function installationStatus(toolId: string, profile: ProjectProfile, installed: readonly InstalledTool[]): { status: InstallationStatus; inspectedScopes: Scope[] } {
  const scopes = inspectedScopes(profile);
  const ai = detectorStatus(profile, "ai-environment");
  const host = detectorStatus(profile, "host-probe");
  const weakMatch = installed.some((t) => t.toolId === toolId && t.resolution === "resolved" && t.strength === "weak");
  if (ai !== "ok" || host === "partial" || weakMatch) return { status: "unknown", inspectedScopes: scopes };
  if (unresolvedMcpServers(installed).length > 0) return { status: "unidentified-present", inspectedScopes: scopes };
  return { status: "not-installed", inspectedScopes: scopes };
}
