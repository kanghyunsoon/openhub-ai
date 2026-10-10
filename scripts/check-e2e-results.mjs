// Desktop Electron E2E 결과 확인(desktop-e2e.yml 전용). vitest JSON reporter 결과 파일마다:
// 파일이 있고, 실행된 테스트가 1개 이상이며, 실패·건너뜀·todo가 0이어야 한다. 건너뛴 E2E(OPENHUB_E2E 누락, Electron 없음)를 통과로 보지 않는다.
// 사용: node scripts/check-e2e-results.mjs <dir> <name>...
import { readFileSync } from "node:fs";
import path from "node:path";

const [dir, ...names] = process.argv.slice(2);
if (dir === undefined || names.length === 0) {
  console.error("usage: node scripts/check-e2e-results.mjs <dir> <name>...");
  process.exit(2);
}
let ok = true;
for (const name of names) {
  const file = path.join(dir, name + ".json");
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    console.error(name + ": no result file (" + file + ")");
    ok = false;
    continue;
  }
  const passed = doc.numPassedTests ?? 0;
  const failed = doc.numFailedTests ?? 0;
  const pending = doc.numPendingTests ?? 0;
  const todo = doc.numTodoTests ?? 0;
  const line = name + ": passed " + passed + ", failed " + failed + ", skipped " + pending + ", todo " + todo;
  if (passed === 0 || failed > 0 || pending > 0 || todo > 0 || doc.success !== true) {
    console.error(line + " — not accepted");
    ok = false;
  } else console.log(line);
}
process.exit(ok ? 0 : 1);

