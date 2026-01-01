/**
 * pnpm pinokio:compat(TASK-068, D-033). npm의 pterm·pinokiod 최신 버전을 읽어 호환성 보고서만 쓴다.
 * 지원 범위 상수(pterm 0.0.25)를 바꾸지 않는다. 범위를 넓히려면 실제 호환성 확인과 새 Decision이 필요하다.
 */
import { writeFile } from "node:fs/promises";
import { pinokioCompatReport } from "../packages/core/src/index";

const out = process.argv[2] ?? "pinokio-compat-report.json";
const report = await pinokioCompatReport({ now: () => new Date() });
await writeFile(out, JSON.stringify(report, null, 2) + "\n");
process.stdout.write("pterm latest " + String(report.latest.pterm) + " (supported " + report.supported.pterm + ") · pinokiod latest " + String(report.latest.pinokiod) + "\n" + report.notice + "\n");

