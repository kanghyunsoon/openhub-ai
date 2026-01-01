import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { RegistryEntry, RegistryIssue } from "../registry/load";

/**
 * Catalog Metadata v1(TASK-061, D-035). registry/catalog.yaml이 Registry Tool 등록일(addedAt)의 유일한 출처다.
 * - Manifest v1은 바꾸지 않는다. 각 Manifest마다 entry가 하나 있고 addedAt은 ISO 날짜(YYYY-MM-DD) 또는 null이다.
 * - addedAt: null은 "legacy / 등록일 미상"이며 어떤 entry에도 허용된다. 특정 Tool ID 목록을 코드에 두지 않는다.
 * - 검사: Manifest ↔ catalog 1:1, 중복 toolId(YAML 중복 키 포함), 누락 entry, orphan entry, 날짜 형식 오류, asOf보다 미래인 날짜.
 * - Git history·child process·network를 쓰지 않는다.
 */

export const CATALOG_FILE = "catalog.yaml";
export const CATALOG_SCHEMA_VERSION = 1;
export const CATALOG_KIND = "openhub-registry-catalog";

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/u;
/** 달력에 있는 YYYY-MM-DD인지. */
export function isIsoDate(value: string): boolean {
  const m = ISO_DATE.exec(value);
  if (m === null) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === value;
}
/** Date → UTC YYYY-MM-DD */
export const isoDateOf = (d: Date) => d.toISOString().slice(0, 10);

const kebab = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u).max(64);
export const catalogSchema = z.strictObject({
  schemaVersion: z.literal(CATALOG_SCHEMA_VERSION),
  kind: z.literal(CATALOG_KIND),
  tools: z.record(kebab, z.strictObject({ addedAt: z.string().nullable() })),
});
export type RegistryCatalog = z.output<typeof catalogSchema>;

export type CatalogParseResult = { ok: true; catalog: RegistryCatalog } | { ok: false; issues: RegistryIssue[] };

const issue = (p: string, message: string): RegistryIssue => ({ file: CATALOG_FILE, path: p, message });

/** catalog.yaml 텍스트를 읽는다. YAML 중복 키는 오류다. */
export function parseCatalogText(text: string): CatalogParseResult {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length > 0) {
    const dup = doc.errors.some((e) => /unique/iu.test(e.message));
    return { ok: false, issues: [issue("tools", dup ? "같은 toolId가 catalog에 두 번 있습니다" : "catalog.yaml을 해석하지 못했습니다")] };
  }
  const parsed = catalogSchema.safeParse(doc.toJS());
  if (!parsed.success) return { ok: false, issues: parsed.error.issues.map((i) => issue(i.path.join("."), "catalog 형식이 올바르지 않습니다: " + i.message)) };
  return { ok: true, catalog: parsed.data };
}

/** <registryRoot>/catalog.yaml을 읽는다. 없으면 오류다. */
export async function loadCatalog(registryRoot: string): Promise<CatalogParseResult> {
  let text: string;
  try {
    text = await readFile(path.join(registryRoot, CATALOG_FILE), "utf8");
  } catch {
    return { ok: false, issues: [issue("", "registry/catalog.yaml이 없습니다. 모든 Registry Tool의 addedAt(날짜 또는 null)을 적어야 합니다")] };
  }
  return parseCatalogText(text);
}

/** Manifest와 catalog의 1:1·날짜 규칙을 검사한다. asOf는 주입한 기준일이다. */
export function checkCatalog(catalog: RegistryCatalog, entries: readonly RegistryEntry[], asOf: Date): RegistryIssue[] {
  const out: RegistryIssue[] = [];
  const today = isoDateOf(asOf);
  const names = new Set(entries.map((e) => e.manifest.name));
  for (const name of [...names].sort()) if (catalog.tools[name] === undefined) out.push(issue("tools." + name, name + " Manifest에 대응하는 catalog entry가 없습니다"));
  for (const [toolId, entry] of Object.entries(catalog.tools).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (!names.has(toolId)) out.push(issue("tools." + toolId, toolId + "에 대응하는 Manifest가 없습니다(orphan entry)"));
    if (entry.addedAt === null) continue;
    if (!isIsoDate(entry.addedAt)) out.push(issue("tools." + toolId + ".addedAt", "addedAt은 YYYY-MM-DD 날짜 또는 null이어야 합니다"));
    else if (entry.addedAt > today) out.push(issue("tools." + toolId + ".addedAt", "addedAt(" + entry.addedAt + ")이 기준일(" + today + ")보다 미래입니다"));
  }
  return out;
}

/** toolId → addedAt(null이면 등록일 미상). catalog에 없는 Tool도 null이다. */
export function addedAtOf(catalog: RegistryCatalog | undefined, toolId: string): string | null {
  const v = catalog?.tools[toolId]?.addedAt ?? null;
  return v !== null && isIsoDate(v) ? v : null;
}

