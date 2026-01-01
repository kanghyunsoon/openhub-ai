import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { containsAbsolutePath } from "../analyzer/index";
import { BACKEND_ADAPTERS } from "../installer/backends";
import { npxArtifact, parseNpmSpec, uvxArtifact } from "../installer/command";
import { CONFIG_WRITE_ALLOWLIST, decode, nodeConfigFs, readOptional, resolveInside, type ConfigFs } from "../installer/config-writer";
import { INSTALL_BACKENDS, type InstallBackend } from "../installer/plan";
import { installCandidates } from "../installer/router";
import type { Manifest } from "../manifest/index";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN, canonicalAliasIndex, type IdentityHint } from "../recommendation/index";
import type { RegistryEntry } from "../registry/index";

/**
 * Identity Fingerprint(TASK-051, D-026). 설정된 MCP 항목을 canonical alias 외에 실행 artifact로 Registry Tool과 식별한다.
 * - 근거는 artifact token 하나뿐이다: npx 첫 package token(scoped 포함), uvx `--from` 값 또는 첫 token, docker image repo,
 *   Windows `cmd /d /c npx` 뒤 token. 그 밖의 args·env 값·token·credential·경로는 추출 직후 버리고 결과에 담지 않는다.
 * - `~/.claude.json`은 D-003대로 최상위 mcpServers의 서버 이름만 읽는다(artifact 없음).
 * - Registry 근거는 M4 Adapter가 만드는 표준 launch에 같은 추출기를 적용한 값 + fallback npm/uv/pip package다.
 * - 등급: exact(alias·artifact 모두 일치), strong(alias 불일치·artifact 일치·후보 1개) = resolved,
 *   weak(artifact 일치 없음, 이름만 같음) · unresolved(근거 없음·후보 2개 이상·alias와 artifact가 다른 Tool) = unresolved.
 *   fuzzy·substring·대소문자 무시·LLM 매칭은 하지 않는다(이름 비교는 소문자 정규화 후 완전 일치).
 * - weak는 어떤 경우에도 resolved·Version State 편입·untracked-adoptable이 되지 않는다.
 * - 프로세스 환경변수를 읽지 않고 network·spawn·write가 없다.
 */

export const FINGERPRINT_GRADES = ["exact", "strong", "weak", "unresolved"] as const;
export type FingerprintGrade = (typeof FINGERPRINT_GRADES)[number];
export const FINGERPRINT_REASONS = ["alias-and-artifact", "artifact-only", "name-only", "ambiguous", "alias-artifact-conflict", "alias-only", "no-evidence"] as const;
export type FingerprintReason = (typeof FINGERPRINT_REASONS)[number];

/** artifact key: "npm:<name>" · "pypi:<normalized>" · "docker:<host>/<repo>" */
export type ArtifactKey = string;

export interface ConfiguredServer {
  client: "claude-code" | "cursor" | "codex";
  scope: "project" | "user";
  /** 논리 경로(.mcp.json, ~/.cursor/mcp.json, ~/.claude.json) */
  file: string;
  serverName: string;
  artifact: ArtifactKey | null;
}

export interface FingerprintMatch extends ConfiguredServer {
  grade: FingerprintGrade;
  reason: FingerprintReason;
  /** exact·strong이면 식별된 Tool, 그 밖은 null */
  toolId: string | null;
  /** weak·ambiguous일 때 "가능한 일치"로만 보여 줄 후보(정렬) */
  candidates: string[];
}

const NPM_NAME = /^(?:@[a-z0-9~][a-z0-9._~-]*\/)?[a-z0-9~][a-z0-9._~-]*$/u;
const PY_NAME = /^[a-z0-9](?:[a-z0-9._-]{0,98}[a-z0-9])?$/u;
const IMAGE_PART = /^[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*$/u;
const HOST = /^[a-z0-9.-]+(?::\d{1,5})?$/u;
const SERVER_NAME_MAX = 100;

const safeText = (s: string) => s.length > 0 && !containsAbsolutePath(s) && !URL_CREDENTIAL_PATTERN.test(s) && !TOKEN_PATTERN.test(s) && !/[\u0000-\u001f\u007f]/u.test(s);
const commandBase = (command: string) => path.posix.basename(command.replace(/\\/gu, "/")).toLowerCase().replace(/\.(?:cmd|exe|bat)$/u, "");
const pep503 = (name: string) => name.toLowerCase().replace(/[-_.]+/gu, "-");

export function npmKey(spec: string): ArtifactKey | null {
  const name = parseNpmSpec(spec)?.name;
  return name !== undefined && name.length <= 214 && NPM_NAME.test(name) && safeText(name) ? "npm:" + name : null;
}
export function pypiKey(spec: string): ArtifactKey | null {
  // 이름[extra] + 선택적 버전 지정자만 받는다. URL·경로·git+ 같은 spec은 package 근거가 아니다.
  const name = /^([A-Za-z0-9][A-Za-z0-9._-]*)(?:\[[A-Za-z0-9,._ -]*\])?\s*(?:(?:===|==|>=|<=|~=|!=|<|>)\s*[A-Za-z0-9.*+!_-]+)?$/u.exec(spec.trim())?.[1];
  if (name === undefined) return null;
  const norm = pep503(name);
  return PY_NAME.test(norm) && safeText(norm) ? "pypi:" + norm : null;
}
/** image에서 digest·tag를 떼고 host/repo로 정규화한다. Docker Hub 단일 이름은 library/ 규칙을 따른다. */
export function dockerKey(image: string): ArtifactKey | null {
  const named = image.split("@")[0]!;
  const parts = named.split("/");
  const first = parts[0]!;
  const hasHost = parts.length > 1 && (first.includes(".") || first.includes(":") || first === "localhost");
  let host = hasHost ? first.toLowerCase() : "docker.io";
  let rest = hasHost ? parts.slice(1).join("/") : named;
  const lastSlash = rest.lastIndexOf("/");
  const colon = rest.lastIndexOf(":");
  if (colon > lastSlash) rest = rest.slice(0, colon);
  if (host === "index.docker.io" || host === "registry-1.docker.io") host = "docker.io";
  if (host === "docker.io" && !rest.includes("/")) rest = "library/" + rest;
  if (!HOST.test(host) || rest === "" || !rest.split("/").every((p) => IMAGE_PART.test(p))) return null;
  const key = "docker:" + host + "/" + rest;
  return safeText(key) ? key : null;
}

const DOCKER_BOOLEAN_FLAGS = new Set(["-i", "-t", "-it", "-ti", "-d", "--rm", "--init", "--interactive", "--tty", "--detach", "--privileged", "--read-only", "-q", "--quiet"]);
/** docker run 인자에서 image token(첫 비옵션 인자). Adopt(TASK-059)도 같은 규칙으로 image를 찾는다. */
export function dockerImageArg(args: readonly string[]): string | null {
  const run = args.indexOf("run");
  if (run === -1) return null;
  for (let i = run + 1; i < args.length; i += 1) {
    const a = args[i]!;
    if (!a.startsWith("-")) return a;
    if (a.includes("=") || DOCKER_BOOLEAN_FLAGS.has(a)) continue;
    i += 1; // 값을 받는 옵션(-e NAME, -v a:b, --name x 등)
  }
  return null;
}

/** config 항목의 command·args에서 artifact key만 꺼낸다. 다른 값은 반환하지 않는다. */
export function artifactKeyFromLaunch(command: unknown, args: unknown): ArtifactKey | null {
  if (typeof command !== "string" || command.length === 0 || command.length > 4096) return null;
  const list = Array.isArray(args) && args.every((a) => typeof a === "string") ? (args as string[]) : [];
  let base = commandBase(command);
  let rest = list;
  if (base === "cmd") {
    let i = 0;
    let sawC = false;
    while (i < rest.length && /^\/[dsc]$/iu.test(rest[i]!)) {
      if (rest[i]!.toLowerCase() === "/c") sawC = true;
      i += 1;
    }
    if (!sawC || i >= rest.length) return null;
    base = commandBase(rest[i]!);
    rest = rest.slice(i + 1);
  }
  if (base === "npx") {
    const ref = npxArtifact(rest);
    return ref === null ? null : npmKey(ref.spec);
  }
  if (base === "uvx") {
    const ref = uvxArtifact(rest);
    return ref === null ? null : pypiKey(ref.spec);
  }
  if (base === "docker") {
    const image = dockerImageArg(rest);
    return image === null ? null : dockerKey(image);
  }
  return null;
}

export function artifactKeyFromEntry(entry: unknown): ArtifactKey | null {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return null;
  const e = entry as Record<string, unknown>;
  return artifactKeyFromLaunch(e["command"], e["args"]);
}

/** Registry Tool 하나의 artifact key 목록(표준 launch + fallback package). */
export function registryArtifactKeys(manifest: Manifest): ArtifactKey[] {
  const keys = new Set<ArtifactKey>();
  for (const { step } of installCandidates(manifest)) {
    if ((INSTALL_BACKENDS as readonly string[]).includes(step.adapter)) {
      const planned = BACKEND_ADAPTERS[step.adapter as InstallBackend].planLaunch(manifest, step, "linux");
      if (planned.ok) {
        const key = artifactKeyFromLaunch(planned.value.launch.clientSpec.command, planned.value.launch.clientSpec.args);
        if (key !== null) keys.add(key);
      }
    }
    const pkg = typeof step.package === "string" ? step.package : typeof step.options?.["package"] === "string" ? (step.options["package"] as string) : undefined;
    if (pkg !== undefined) {
      const key = step.adapter === "npm" || step.adapter === "npx" ? npmKey(pkg) : step.adapter === "uv" || step.adapter === "uvx" || step.adapter === "pip" ? pypiKey(pkg) : null;
      if (key !== null) keys.add(key);
    }
    const image = typeof step.image === "string" ? step.image : typeof step.options?.["image"] === "string" ? (step.options["image"] as string) : undefined;
    if (image !== undefined && step.adapter === "docker") {
      const key = dockerKey(image);
      if (key !== null) keys.add(key);
    }
  }
  return [...keys].sort();
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export interface FingerprintIndex {
  byArtifact: ReadonlyMap<ArtifactKey, readonly string[]>;
  byName: ReadonlyMap<string, readonly string[]>;
  aliases: ReturnType<typeof canonicalAliasIndex>;
}

/** Registry 전체 색인. 이름 색인은 Tool 이름과 repository.github 저장소 이름(소문자, 완전 일치용)이다. */
export function buildFingerprintIndex(entries: readonly RegistryEntry[]): FingerprintIndex {
  const byArtifact = new Map<ArtifactKey, string[]>();
  const byName = new Map<string, string[]>();
  const add = (map: Map<string, string[]>, key: string, id: string) => {
    const list = map.get(key) ?? [];
    if (!list.includes(id)) list.push(id);
    map.set(key, list.sort(cmp));
  };
  for (const { manifest } of entries) {
    for (const key of registryArtifactKeys(manifest)) add(byArtifact, key, manifest.name);
    add(byName, manifest.name.toLowerCase(), manifest.name);
    add(byName, manifest.repository.github.split("/")[1]!.toLowerCase(), manifest.name);
  }
  return { byArtifact, byName, aliases: canonicalAliasIndex(entries) };
}

const artifactBase = (key: ArtifactKey) => {
  const body = key.slice(key.indexOf(":") + 1);
  return body.slice(body.lastIndexOf("/") + 1).toLowerCase();
};

/** 설정 항목 하나의 등급. alias 매칭은 exact-match(D-008)이고 이름 비교는 소문자 완전 일치다. */
export function gradeServer(server: ConfiguredServer, index: FingerprintIndex): FingerprintMatch {
  const aliasTool = index.aliases.get(server.serverName)?.manifest.name ?? null;
  const candidates = server.artifact === null ? [] : [...(index.byArtifact.get(server.artifact) ?? [])];
  const out = (grade: FingerprintGrade, reason: FingerprintReason, toolId: string | null, shown: string[] = []): FingerprintMatch => ({ ...server, grade, reason, toolId, candidates: [...shown].sort(cmp) });
  if (aliasTool !== null && candidates.includes(aliasTool)) return out("exact", "alias-and-artifact", aliasTool);
  if (aliasTool !== null && candidates.length > 0) return out("unresolved", "alias-artifact-conflict", null, [aliasTool, ...candidates]);
  if (candidates.length > 1) return out("unresolved", "ambiguous", null, candidates);
  if (candidates.length === 1) return out(aliasTool === null ? "strong" : "exact", aliasTool === null ? "artifact-only" : "alias-and-artifact", candidates[0]!);
  if (aliasTool !== null) return out("unresolved", "alias-only", null, [aliasTool]);
  const names = new Set<string>([server.serverName.toLowerCase(), ...(server.artifact === null ? [] : [artifactBase(server.artifact)])]);
  const similar = [...new Set([...names].flatMap((n) => [...(index.byName.get(n) ?? [])]))];
  return similar.length > 0 ? out("weak", "name-only", null, similar) : out("unresolved", "no-evidence", null);
}

export interface ReadServersOptions {
  projectRoot: string;
  homeDir: string;
  /** user scope(~/.cursor·~/.codex·~/.claude.json)를 읽을지(D-003, 기본 false) */
  includeUser: boolean;
  fs?: ConfigFs;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validServerName = (name: string) => name.length <= SERVER_NAME_MAX && safeText(name);

/**
 * D-013 allowlist config(project 기본, user는 includeUser)의 MCP 항목에서 서버 이름과 artifact key만 꺼낸다.
 * 읽을 수 없거나 경로가 root 밖을 가리키는 파일은 건너뛴다(결과에 경로·내용을 남기지 않는다).
 */
export async function readConfiguredServers(options: ReadServersOptions): Promise<ConfiguredServer[]> {
  const fs = options.fs ?? nodeConfigFs;
  const roots = { projectRoot: options.projectRoot, homeDir: options.homeDir, fs };
  const out: ConfiguredServer[] = [];
  const readDoc = async (target: Parameters<typeof resolveInside>[0]): Promise<unknown> => {
    try {
      const { file } = await resolveInside(target, roots, fs);
      const bytes = await readOptional(fs, file);
      if (bytes === null) return undefined;
      const { text } = decode(bytes);
      return target.format === "json" ? JSON.parse(text) : parseToml(text);
    } catch {
      return undefined;
    }
  };
  for (const target of CONFIG_WRITE_ALLOWLIST) {
    if (target.scope === "user" && !options.includeUser) continue;
    const doc = await readDoc(target);
    const servers = isRecord(doc) ? doc[target.format === "json" ? "mcpServers" : "mcp_servers"] : undefined;
    if (!isRecord(servers)) continue;
    for (const name of Object.keys(servers).sort(cmp)) {
      if (!validServerName(name)) continue;
      out.push({ client: target.client, scope: target.scope, file: target.logical, serverName: name, artifact: artifactKeyFromEntry(servers[name]) });
    }
  }
  if (options.includeUser) {
    // ~/.claude.json: 최상위 mcpServers의 key만 읽는다(D-003). 값(command·args·env 등)은 보지 않는다.
    const doc = await readDoc({ writable: true, client: "claude-code", scope: "user", logical: "~/.claude.json", relative: ".claude.json", format: "json", envReference: "claude-dollar-brace" });
    const servers = isRecord(doc) ? doc["mcpServers"] : undefined;
    if (isRecord(servers)) {
      for (const name of Object.keys(servers).sort(cmp)) if (validServerName(name)) out.push({ client: "claude-code", scope: "user", file: "~/.claude.json", serverName: name, artifact: null });
    }
  }
  return out;
}

/** 설정 항목 전체를 등급으로 판정한다. 정렬: scope → file → serverName. */
export function fingerprintServers(servers: readonly ConfiguredServer[], entries: readonly RegistryEntry[]): FingerprintMatch[] {
  const index = buildFingerprintIndex(entries);
  return servers
    .map((s) => gradeServer(s, index))
    .sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) || cmp(a.file, b.file) || cmp(a.serverName, b.serverName));
}

/** recommend()에 넘길 identityHints. exact·strong만 만든다(weak·unresolved는 0건). */
export function identityHintsFrom(matches: readonly FingerprintMatch[]): IdentityHint[] {
  const out: IdentityHint[] = [];
  for (const m of matches) {
    if ((m.grade !== "exact" && m.grade !== "strong") || m.toolId === null || m.artifact === null) continue;
    if (out.some((h) => h.serverName === m.serverName && h.scope === m.scope)) continue;
    out.push({ serverName: m.serverName, scope: m.scope, toolId: m.toolId, grade: m.grade, artifact: m.artifact });
  }
  return out.sort((a, b) => (a.scope === b.scope ? 0 : a.scope === "project" ? -1 : 1) || cmp(a.serverName, b.serverName));
}

/** Discovery 중복 판정용: 이미 Registry에 있는 artifact인지(TASK-055). */
export function isKnownArtifact(key: ArtifactKey | null, index: FingerprintIndex): boolean {
  return key !== null && (index.byArtifact.get(key)?.length ?? 0) > 0;
}

