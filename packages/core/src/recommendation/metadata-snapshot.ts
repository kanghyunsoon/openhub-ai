import { readFile } from "node:fs/promises";
import type { RepoMetadata } from "../discovery/index";

/**
 * metadata snapshot(OpenScore 입력). `openhub collect`가 쓴 metadata cache와 같은 형식이며 읽기만 한다.
 * 네트워크를 호출하지 않는다. 테스트는 synthetic snapshot만 쓴다(live GitHub metadata는 데모 전용).
 */

export interface MetadataSnapshot {
  /** OpenScore 경과일 계산의 기준 시각(Date.now()를 쓰지 않는다) */
  collectedAt: string;
  repositories: Record<string, RepoMetadata>;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function isRepoMetadata(v: unknown): v is RepoMetadata {
  if (!isRecord(v)) return false;
  const release = v["latestRelease"];
  return (
    typeof v["stars"] === "number" &&
    typeof v["forks"] === "number" &&
    (v["pushedAt"] === null || typeof v["pushedAt"] === "string") &&
    typeof v["archived"] === "boolean" &&
    (v["license"] === null || typeof v["license"] === "string") &&
    (release === null || (isRecord(release) && typeof release["publishedAt"] === "string"))
  );
}

/** 형식이 맞는 저장소 항목만 남긴다. 형식이 틀리면 undefined(모든 tool unavailable). */
export function parseMetadataSnapshot(data: unknown): MetadataSnapshot | undefined {
  if (!isRecord(data) || typeof data["collectedAt"] !== "string" || Number.isNaN(Date.parse(data["collectedAt"]))) return undefined;
  const repos = data["repositories"];
  if (!isRecord(repos)) return undefined;
  const repositories: Record<string, RepoMetadata> = {};
  for (const key of Object.keys(repos).sort()) {
    const value = repos[key];
    if (isRepoMetadata(value)) repositories[key] = value;
  }
  return { collectedAt: data["collectedAt"], repositories };
}

/** snapshot 파일을 읽는다. 없거나 깨졌으면 undefined이며 예외를 던지지 않는다. */
export async function loadMetadataSnapshot(file: string): Promise<MetadataSnapshot | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    return parseMetadataSnapshot(JSON.parse(text));
  } catch {
    return undefined;
  }
}
