import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "vitest";
import {
  EVIDENCE_WEIGHTS,
  analyzeProject,
  loadMetadataSnapshot,
  loadRegistry,
  projectProfileSchema,
  toKebabId,
  type AiClientId,
  type AiToolItem,
  type AiToolKind,
  type DetectionItem,
  type DetectorStatus,
  type EvidenceType,
  type MetadataSnapshot,
  type ProjectProfile,
  type RegistryEntry,
  type Scope,
} from "../../src/index";

/** recommendation 테스트 공용 도우미. 실제 .openhub-cache나 live GitHub metadata를 읽지 않는다(AC-022-11). */
export const FIXTURES_DIR = path.resolve(import.meta.dirname, "../fixtures");
export const PROJECTS_DIR = path.join(FIXTURES_DIR, "projects");
export const RECOMMENDATION_FIXTURES = path.join(FIXTURES_DIR, "recommendation");
export const REPO_ROOT = path.resolve(import.meta.dirname, "../../../..");
export const UPDATE_GOLDEN = process.env["OPENHUB_UPDATE_GOLDEN"] === "1";

interface ItemOptions {
  scope?: Scope;
  file?: string;
  value?: string;
}

/** 탐지 항목 하나. confidence는 Evidence 가중치로 정해진다(M2 계약). */
export function item(id: string, name: string, type: EvidenceType = "dependency", options: ItemOptions = {}): DetectionItem {
  const scope = options.scope ?? "project";
  const file = options.file ?? (scope === "user" ? (type === "executable" ? "PATH" : "~/.claude.json") : "package.json");
  return { id, name, scope, confidence: EVIDENCE_WEIGHTS[type], evidence: [{ file, type, value: options.value ?? id }] };
}

/** aiTools 항목. id는 M2와 같은 규칙(toKebabId)으로 만들고 name에 원래 server name을 둔다. */
export function tool(name: string, options: ItemOptions & { kind?: AiToolKind; clients?: AiClientId[]; type?: EvidenceType } = {}): AiToolItem {
  const base = item(toKebabId(name), name, options.type ?? "config", { ...options, value: options.value ?? name, file: options.file ?? (options.scope === "user" ? "~/.claude.json" : ".mcp.json") });
  return { ...base, kind: options.kind ?? "mcp-server", clients: options.clients ?? ["claude-code"] };
}

const DEFAULT_DETECTORS = ["languages", "package-managers", "frameworks", "databases", "infrastructure", "ai-environment"] as const;

export interface ProfileParts {
  name?: string;
  languages?: DetectionItem[];
  frameworks?: DetectionItem[];
  databases?: DetectionItem[];
  packageManagers?: DetectionItem[];
  infrastructure?: DetectionItem[];
  aiClients?: DetectionItem[];
  aiTools?: AiToolItem[];
  /** 기본 Detector 6개의 상태를 덮어쓰거나(host-probe 포함) 추가한다. */
  detectors?: Record<string, DetectorStatus>;
}

/** 검증된 synthetic ProjectProfile. */
export function profile(parts: ProfileParts = {}): ProjectProfile {
  const statuses: Record<string, DetectorStatus> = Object.fromEntries(DEFAULT_DETECTORS.map((d) => [d, "ok" as DetectorStatus]));
  Object.assign(statuses, parts.detectors ?? {});
  return projectProfileSchema.parse({
    schemaVersion: 1,
    project: { name: parts.name ?? "synthetic" },
    languages: parts.languages ?? [],
    frameworks: parts.frameworks ?? [],
    databases: parts.databases ?? [],
    packageManagers: parts.packageManagers ?? [],
    infrastructure: parts.infrastructure ?? [],
    aiClients: parts.aiClients ?? [],
    aiTools: parts.aiTools ?? [],
    detectors: Object.entries(statuses)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, status]) => ({ id, status })),
    warnings: [],
  });
}

export async function fixtureProfile(name: string): Promise<ProjectProfile> {
  const result = await analyzeProject(path.join(PROJECTS_DIR, name));
  if (!result.ok) throw new Error(result.error.code);
  return result.profile;
}

/** 실제 seed Registry(저장소가 관리하는 curated 데이터). live metadata와 무관하다. */
export async function seedEntries(): Promise<RegistryEntry[]> {
  const { entries, issues } = await loadRegistry(path.join(REPO_ROOT, "registry"));
  if (issues.length > 0) throw new Error("seed registry 검증 실패");
  return entries;
}

/** §9 synthetic Registry(tool-a ~ tool-g). */
export async function syntheticEntries(): Promise<RegistryEntry[]> {
  const { entries, issues } = await loadRegistry(path.join(RECOMMENDATION_FIXTURES, "registry"));
  if (issues.length > 0) throw new Error(`synthetic registry 검증 실패: ${JSON.stringify(issues)}`);
  return entries;
}

/** fixture metadata snapshot 경로. recommendation 테스트는 .openhub-cache를 읽지 않는다(AC-022-11). */
export function snapshotPath(name: string): string {
  const file = path.join(RECOMMENDATION_FIXTURES, name);
  const rel = path.relative(RECOMMENDATION_FIXTURES, file);
  if (rel.startsWith("..") || path.isAbsolute(rel) || file.includes(".openhub-cache")) throw new Error(`fixture 밖 metadata를 읽으려 했습니다: ${name}`);
  return file;
}

export async function syntheticSnapshot(name = "metadata.synthetic.json"): Promise<MetadataSnapshot> {
  const snapshot = await loadMetadataSnapshot(snapshotPath(name));
  if (snapshot === undefined) throw new Error(`snapshot 없음: ${name}`);
  return snapshot;
}

/** 배열 순서를 결정적으로 뒤집고 섞는다(입력 순서 무관성 검증용). */
export function shuffled<T>(values: readonly T[]): T[] {
  const out = [...values].reverse();
  if (out.length > 2) out.push(out.shift() as T);
  return out;
}

export function shuffleProfile(p: ProjectProfile): ProjectProfile {
  return {
    ...p,
    languages: shuffled(p.languages),
    frameworks: shuffled(p.frameworks),
    databases: shuffled(p.databases),
    packageManagers: shuffled(p.packageManagers),
    infrastructure: shuffled(p.infrastructure),
    aiClients: shuffled(p.aiClients),
    aiTools: shuffled(p.aiTools),
    detectors: shuffled(p.detectors),
  };
}

/** golden 파일과 바이트 단위로 비교한다. OPENHUB_UPDATE_GOLDEN=1이면 갱신한다. */
export async function expectGolden(relative: string, actual: string): Promise<void> {
  const file = path.join(RECOMMENDATION_FIXTURES, "goldens", relative);
  if (UPDATE_GOLDEN) await writeFile(file, actual);
  if (!existsSync(file)) throw new Error(`golden 없음: ${relative} — OPENHUB_UPDATE_GOLDEN=1로 생성하세요`);
  expect(actual).toBe(await readFile(file, "utf8"));
}
