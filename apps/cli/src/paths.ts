import path from "node:path";
import { loadMetadataSnapshot, resolveMetadataFile, type MetadataChoice, type MetadataSnapshot } from "@openhub/core";
import type { CliIO } from "./cli";

/**
 * CLI의 Registry·metadata 위치(TASK-071, D-036 §12).
 * - main이 명시·환경변수·패키지 리소스 순서로 정한 io.registryDir를 쓴다. 정하지 않았으면(개발 실행·테스트) cwd 기준 registry/다.
 * - metadata: io.metadataFile(OPENHUB_METADATA) > ~/.openhub/cache/metadata.json(io.homeDir) > registry 리소스의 포함 snapshot.
 *   손상된 사용자 cache는 경고 후 무시한다. 출력에는 절대 경로 대신 논리 이름만 쓴다.
 */
/** 명령별 IO 타입이 달라도 쓸 수 있도록 위치 관련 필드만 받는다. */
export type PathsIO = Pick<CliIO, "cwd" | "err" | "registryDir" | "registrySource" | "metadataFile" | "homeDir">;

export function registryDirOf(io: PathsIO, explicit?: string): string {
  if (explicit !== undefined) return path.resolve(io.cwd, explicit);
  return io.registryDir ?? path.resolve(io.cwd, "registry");
}

export async function metadataOf(io: PathsIO): Promise<{ snapshot: MetadataSnapshot | undefined; choice: MetadataChoice }> {
  const choice = await resolveMetadataFile({
    explicit: io.metadataFile === undefined ? undefined : path.resolve(io.cwd, io.metadataFile),
    homeDir: io.homeDir,
    registryDir: registryDirOf(io),
  });
  for (const w of choice.warnings) io.err("경고: " + w);
  return { snapshot: choice.file === null ? undefined : await loadMetadataSnapshot(choice.file), choice };
}
