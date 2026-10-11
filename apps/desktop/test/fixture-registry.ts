import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const PINNED = 'command: "uvx --from postgres-mcp==0.3.0 --with mcp==1.30.0 postgres-mcp --access-mode=restricted"';
const FLOATING = 'command: "uvx --from postgres-mcp --with mcp==1.30.0 postgres-mcp --access-mode=restricted"';

/**
 * Desktop update·rollback 흐름 테스트용 Registry 사본(v0.2.1 #39). 실제 Registry는 postgres-mcp를 0.3.0으로 고정했고,
 * Desktop update는 Manifest 버전으로만 바꾸므로(--to 없음) 고정된 도구는 늘 up-to-date다. 이 테스트들은 Registry 내용이 아니라
 * Desktop 흐름(필수 env 승인, Health 생략, rollback, 프로젝트 변경)을 확인하므로, postgres-mcp만 버전이 없는 형식으로 바꾼 사본을 쓴다.
 * 실제 Registry의 고정·Prepare 동작은 core·CLI 테스트와 registry/uvx-prepare.e2e.test.ts가 확인한다.
 */
export async function floatingPostgresRegistry(root: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "openhub-desktop-registry-"));
  await cp(path.join(root, "registry"), dir, { recursive: true });
  const file = path.join(dir, "database", "postgres-mcp.yaml");
  const text = await readFile(file, "utf8");
  if (!text.includes(PINNED)) throw new Error("postgres-mcp 고정 명령을 찾지 못했습니다. fixture-registry.ts를 Registry와 맞추세요");
  await writeFile(file, text.replace(PINNED, FLOATING));
  return dir;
}
