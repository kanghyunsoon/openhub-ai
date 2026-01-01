/**
 * sandbox workflow 보고서 변환(TASK-067). vitest --reporter=json 출력을 개수·상태·소요 시간만 담은 정제 report로 바꾼다.
 * 테스트 이름·실패 메시지·경로·출력은 버린다. registry-remote.yml sandbox job에서만 쓴다.
 */
import { readFile, writeFile } from "node:fs/promises";
import { sandboxReportFromVitest } from "../packages/core/src/index";

const [input, output] = process.argv.slice(2);
if (input === undefined || output === undefined) throw new Error("usage: tsx scripts/sandbox-report.ts <vitest.json> <sandbox-report.json>");
const report = sandboxReportFromVitest(JSON.parse(await readFile(input, "utf8")), new Date());
await writeFile(output, JSON.stringify(report, null, 2) + "\n");

