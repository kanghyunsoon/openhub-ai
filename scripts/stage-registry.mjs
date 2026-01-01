// 배포 리소스 staging(TASK-071, D-036 §12). 저장소 registry/의 Manifest·catalog.yaml·README와 metadata snapshot(있으면)을
// 배포 패키지의 registry 리소스 디렉터리로 복사한다. 쓰는 곳은 호출자가 넘긴 dest 하나뿐이다.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SNAPSHOT_NAME = "metadata.snapshot.json";

/** 포함할 snapshot 후보(앞이 우선): OPENHUB_PACK_METADATA > 저장소 .openhub-cache(개발 collect) > ~/.openhub/cache. */
export function snapshotCandidates() {
  const env = process.env["OPENHUB_PACK_METADATA"];
  return [env, path.join(ROOT, ".openhub-cache", "metadata.json"), path.join(os.homedir(), ".openhub", "cache", "metadata.json")].filter((f) => typeof f === "string" && f !== "" && existsSync(f));
}

/** dest를 비우고 Registry 리소스를 만든다. snapshot이 null이면 snapshot 없이 만든다(개발 실행). */
export function stageRegistry(dest, snapshot) {
  const src = path.join(ROOT, "registry");
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const name of readdirSync(src)) {
    const from = path.join(src, name);
    if (statSync(from).isDirectory()) cpSync(from, path.join(dest, name), { recursive: true, filter: (f) => statSync(f).isDirectory() || /\.ya?ml$/u.test(f) });
    else if (/^(catalog\.yaml|README\.md)$/u.test(name)) cpSync(from, path.join(dest, name));
  }
  if (snapshot !== null) cpSync(snapshot, path.join(dest, SNAPSHOT_NAME));
  return dest;
}
