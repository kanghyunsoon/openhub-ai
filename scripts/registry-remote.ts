/**
 * Registry remote validation 실행 스크립트(TASK-054, D-025). GitHub Actions registry-remote.yml에서만 쓴다.
 * - 인증 정보 없이 비인증 REST로 저장소·release source를 확인하고 보고서(JSON)와 job summary(Markdown)만 남긴다.
 * - 결과와 무관하게 exit 0이다(remote 실패가 merge를 막지 않는다). Registry 파일을 바꾸지 않는다.
 */
import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { formatRemoteReportMarkdown, remoteValidateRegistry, validateRegistry } from "../packages/core/src/index";

const out = process.argv[2] ?? "registry-remote-report.json";
const { entries, issues } = await validateRegistry(path.resolve("registry"));
const report = await remoteValidateRegistry(entries, { now: () => new Date() });
await writeFile(out, JSON.stringify({ ...report, fastIssues: issues.length }, null, 2) + "\n");
const markdown = formatRemoteReportMarkdown(report);
const summary = process.env["GITHUB_STEP_SUMMARY"];
if (summary !== undefined && summary !== "") await appendFile(summary, markdown);
process.stdout.write(markdown);

