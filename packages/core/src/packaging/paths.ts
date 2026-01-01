import { existsSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadMetadataSnapshot, parseMetadataSnapshot } from "../recommendation/metadata-snapshot";
import { TOKEN_PATTERN, URL_CREDENTIAL_PATTERN } from "../recommendation/report";

/**
 * 배포 경로 규칙(TASK-071, D-036 §12). repository root를 가정하지 않는다.
 * - Registry: 명시 옵션(--dir) > 환경변수(OPENHUB_REGISTRY) > 패키지 리소스(CLI bundle 옆 registry/, Desktop resourcesPath/registry)
 *   > 개발 실행 fallback(호출자가 정한 cwd 기준 registry/. 배포 패키지에는 리소스가 있으므로 쓰이지 않는다).
 * - metadata: 명시 지정 > ~/.openhub/cache/metadata.json(openhub collect 기본 출력, 손상 시 경고 후 무시) > 포함 snapshot.
 * credential은 어디에도 없다(snapshot은 GitHub 공개 메타데이터뿐이고 포함 전에 token 패턴을 검사한다).
 */
export const REGISTRY_ENV = "OPENHUB_REGISTRY";
export const METADATA_ENV = "OPENHUB_METADATA";
/** home 기준 상대 경로(사람에게는 USER_METADATA_CACHE_LOGICAL로 보인다). */
export const USER_METADATA_CACHE = path.join(".openhub", "cache", "metadata.json");
export const USER_METADATA_CACHE_LOGICAL = "~/.openhub/cache/metadata.json";
/** Registry 리소스 디렉터리 안의 포함 snapshot 파일 이름. Registry loader는 이 파일을 Manifest로 보지 않는다. */
export const BUNDLED_METADATA_SNAPSHOT = "metadata.snapshot.json";

export type RegistrySource = "option" | "env" | "resource" | "fallback";
export function resolveRegistryDir(o: { explicit?: string | undefined; env?: string | undefined; resource?: string | undefined; fallback: string }): { dir: string; source: RegistrySource } {
  if (o.explicit !== undefined && o.explicit !== "") return { dir: o.explicit, source: "option" };
  if (o.env !== undefined && o.env !== "") return { dir: o.env, source: "env" };
  if (o.resource !== undefined && existsSync(o.resource)) return { dir: o.resource, source: "resource" };
  return { dir: o.fallback, source: "fallback" };
}

export type MetadataSource = "option" | "user-cache" | "bundled" | "none";
export interface MetadataChoice {
  file: string | null;
  source: MetadataSource;
  /** 사람이 읽는 출처(절대 경로 없음) */
  label: string;
  warnings: string[];
}

const readable = (file: string): boolean => {
  try {
    return parseMetadataSnapshot(JSON.parse(readFileSync(file, "utf8"))) !== undefined;
  } catch {
    return false;
  }
};

/** metadata 파일을 고른다. 파일 내용은 읽어 확인만 하고 쓰지 않는다(동기, Desktop 시작 시점용). */
export function resolveMetadataFileSync(o: { explicit?: string | undefined; homeDir?: string | undefined; registryDir?: string | undefined }): MetadataChoice {
  if (o.explicit !== undefined && o.explicit !== "") return { file: o.explicit, source: "option", label: "명시 지정(" + METADATA_ENV + " 또는 옵션)", warnings: [] };
  const warnings: string[] = [];
  if (o.homeDir !== undefined) {
    const cache = path.join(o.homeDir, USER_METADATA_CACHE);
    if (existsSync(cache)) {
      if (readable(cache)) return { file: cache, source: "user-cache", label: USER_METADATA_CACHE_LOGICAL, warnings };
      warnings.push(USER_METADATA_CACHE_LOGICAL + "을(를) 읽을 수 없어(손상) 무시합니다. openhub collect로 다시 만드세요");
    }
  }
  if (o.registryDir !== undefined) {
    const bundled = path.join(o.registryDir, BUNDLED_METADATA_SNAPSHOT);
    if (existsSync(bundled) && readable(bundled)) return { file: bundled, source: "bundled", label: "포함 snapshot(registry/" + BUNDLED_METADATA_SNAPSHOT + ")", warnings };
  }
  return { file: null, source: "none", label: "없음(openhub collect)", warnings };
}

/** resolveMetadataFileSync와 같다(CLI용 비동기 표면). */
export async function resolveMetadataFile(o: { explicit?: string | undefined; homeDir?: string | undefined; registryDir?: string | undefined }): Promise<MetadataChoice> {
  return resolveMetadataFileSync(o);
}

/** 포함 snapshot 후보 검사: metadata schema로 읽히고 token·credential URL이 없어야 한다. */
export async function checkBundledSnapshot(file: string): Promise<{ ok: true; collectedAt: string } | { ok: false; reason: string }> {
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return { ok: false, reason: "파일을 읽을 수 없습니다" };
  if (TOKEN_PATTERN.test(text) || URL_CREDENTIAL_PATTERN.test(text)) return { ok: false, reason: "credential로 보이는 문자열이 있습니다" };
  const snapshot = await loadMetadataSnapshot(file);
  if (snapshot === undefined) return { ok: false, reason: "metadata 형식이 아닙니다" };
  return { ok: true, collectedAt: snapshot.collectedAt };
}
