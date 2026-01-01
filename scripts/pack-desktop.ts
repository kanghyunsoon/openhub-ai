/**
 * pnpm pack:desktop(TASK-071, D-036 §12). Desktop을 빌드하고 Registry 리소스(Manifest·catalog·metadata snapshot)를 staging한 뒤
 * electron-builder 26으로 패키징한다. 현재 OS의 공식 target만 만든다: Windows x64 NSIS, Linux x64 AppImage(macOS target 없음).
 * --dir이면 설치 파일 없이 unpacked 디렉터리만 만든다(smoke 확인용). publish는 하지 않는다(--publish never).
 */
import { execSync } from "node:child_process";
import path from "node:path";
import { parseArgs } from "node:util";
import { checkBundledSnapshot } from "../packages/core/src/index";
import { ROOT, snapshotCandidates, stageRegistry } from "./stage-registry.mjs";

const { values } = parseArgs({ options: { metadata: { type: "string" }, dir: { type: "boolean", default: false } }, strict: true });
const snapshot = values.metadata !== undefined ? path.resolve(values.metadata) : snapshotCandidates()[0];
if (snapshot === undefined) {
  console.error("metadata snapshot이 없습니다. 먼저 pnpm openhub collect를 실행하거나 --metadata <file>을 지정하세요");
  process.exit(1);
}
const checked = await checkBundledSnapshot(snapshot);
if (!checked.ok) {
  console.error("metadata snapshot을 포함할 수 없습니다: " + checked.reason);
  process.exit(1);
}
const platformFlag = process.platform === "win32" ? "--win" : process.platform === "linux" ? "--linux" : null;
if (platformFlag === null) {
  console.error("공식 Desktop artifact는 Windows x64·Linux x64만 만듭니다(macOS는 source build)");
  process.exit(1);
}
const desktop = path.join(ROOT, "apps", "desktop");
execSync("node build.mjs", { cwd: desktop, stdio: "inherit" });
stageRegistry(path.join(desktop, "resources", "registry"), snapshot);
execSync("pnpm exec electron-builder --config electron-builder.yml " + platformFlag + " --x64 --publish never" + (values.dir ? " --dir" : ""), { cwd: desktop, stdio: "inherit" });
console.log("Desktop package: release-out/desktop (metadata collectedAt " + checked.collectedAt + ")");
