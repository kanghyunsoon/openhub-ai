import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { CollectErrorKind, CollectResult, RepoMetadata } from "./github";

export const DEFAULT_METADATA_CACHE = ".openhub-cache/metadata.json";

/** OpenScore·Ranking(M3)의 입력이 되는 메타데이터 캐시. 토큰이나 요청 헤더는 담지 않는다. */
export interface MetadataCache {
  version: 1;
  collectedAt: string;
  mode: CollectResult["mode"];
  repositories: Record<string, RepoMetadata>;
  errors: Record<string, { kind: CollectErrorKind; error: string }>;
}

export function toMetadataCache(result: CollectResult): MetadataCache {
  const cache: MetadataCache = { version: 1, collectedAt: result.collectedAt, mode: result.mode, repositories: {}, errors: {} };
  for (const r of result.results) {
    if (r.ok) cache.repositories[r.repository] = r.metadata;
    else cache.errors[r.repository] = { kind: r.kind, error: r.error };
  }
  return cache;
}

export async function writeMetadataCache(file: string, cache: MetadataCache): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(cache, null, 2) + "\n", "utf8");
}

export async function readMetadataCache(file: string): Promise<MetadataCache | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as MetadataCache;
  } catch {
    return undefined;
  }
}
