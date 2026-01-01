/**
 * pnpm metrics(TASK-067, D-032). 라벨된 fixture로 REQ-061 지표를 계산해 metrics-report.json·.md를 쓴다.
 * - network 0, 사용자 state(~/.openhub) 읽기 0, host probe 없음. telemetry를 쓰지 않는다.
 * - --sandbox <file>(sandbox workflow의 정제 report)·--discovery <file>을 주면 성공률·탐지 지표도 계산하고, 없으면 "not measured"다.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { buildMetricsReport, discoveryReportSchema, formatMetricsMarkdown, loadMetadataSnapshot, loadRegistry, metricsInputFromLabels, sandboxReportSchema } from "../packages/core/src/index";

const { values } = parseArgs({ options: { out: { type: "string" }, sandbox: { type: "string" }, discovery: { type: "string" }, labels: { type: "string" } }, strict: true });
const labelsFile = path.resolve(values.labels ?? "packages/core/test/fixtures/metrics/labels.yaml");
const { entries } = await loadRegistry(path.resolve("registry"));
const snapshot = await loadMetadataSnapshot(path.resolve("packages/core/test/fixtures/recommendation/metadata.seed-synthetic.json"));
const input = await metricsInputFromLabels(await readFile(labelsFile, "utf8"), path.dirname(labelsFile), entries, snapshot);
const sandbox = values.sandbox === undefined ? undefined : sandboxReportSchema.parse(JSON.parse(await readFile(values.sandbox, "utf8")));
const discovery = values.discovery === undefined ? undefined : discoveryReportSchema.parse(JSON.parse(await readFile(values.discovery, "utf8")));
const report = buildMetricsReport({ ...input, ...(sandbox === undefined ? {} : { sandbox }), ...(discovery === undefined ? {} : { discovery }) });
const out = path.resolve(values.out ?? "metrics-report");
await mkdir(out, { recursive: true });
await writeFile(path.join(out, "metrics-report.json"), JSON.stringify(report, null, 2) + "\n");
await writeFile(path.join(out, "metrics-report.md"), formatMetricsMarkdown(report));
process.stdout.write(formatMetricsMarkdown(report));

