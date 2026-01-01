import path from "node:path";
import { parseArgs } from "node:util";
import { analyzeProject, serializeProfile, type DetectionItem, type HostEnvironment, type ProjectDetector, type ProjectProfile } from "@openhub/core";

export interface ProjectCommandIO {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  /** 테스트용 Detector 주입. 지정하지 않으면 Core 기본 Detector를 쓴다. */
  detectors?: readonly ProjectDetector[];
  /** 테스트용 Host 환경 주입(--include-host일 때만 쓰인다). */
  hostEnvironment?: Partial<HostEnvironment>;
}

const SECTIONS: { key: Exclude<keyof ProjectProfile, "schemaVersion" | "project" | "detectors" | "warnings">; title: string }[] = [
  { key: "languages", title: "Languages" },
  { key: "frameworks", title: "Frameworks" },
  { key: "databases", title: "Databases" },
  { key: "packageManagers", title: "Package Managers" },
  { key: "infrastructure", title: "Infrastructure" },
  { key: "aiClients", title: "AI Clients" },
  { key: "aiTools", title: "AI Tools" },
];

/** openhub project scan <path> [--json] [--include-host] — 종료 코드: 0 성공(경고 포함), 1 분석 불가 Root, 2 인자 오류 */
export async function runProject(argv: readonly string[], io: ProjectCommandIO, usage: string): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "scan") {
    io.err(`알 수 없는 project 하위 명령: ${sub ?? "(없음)"}\n\n${usage}`);
    return 2;
  }
  let parsed;
  try {
    parsed = parseArgs({
      args: [...rest],
      options: { json: { type: "boolean", default: false }, "include-host": { type: "boolean", default: false } },
      allowPositionals: true,
      strict: true,
    });
  } catch (error) {
    io.err(`${error instanceof Error ? error.message : String(error)}\n\n${usage}`);
    return 2;
  }
  if (parsed.positionals.length !== 1) {
    io.err(`분석할 프로젝트 경로를 하나 지정하세요\n\n${usage}`);
    return 2;
  }
  const result = await analyzeProject(path.resolve(io.cwd, parsed.positionals[0] as string), {
    ...(io.detectors === undefined ? {} : { detectors: io.detectors }),
    // 사용자 범위 탐지는 --include-host를 명시했을 때만 실행한다(D-003).
    ...(parsed.values["include-host"] ? { includeHost: io.hostEnvironment ?? true } : {}),
  });
  if (!result.ok) {
    io.err(`분석할 수 없습니다: ${result.error.message} (${result.error.code})`);
    return 1;
  }
  if (parsed.values.json) {
    io.out(serializeProfile(result.profile).trimEnd());
    return 0;
  }
  for (const line of formatProfile(result.profile)) io.out(line);
  return 0;
}

function describeItem(item: DetectionItem & { kind?: string; clients?: string[] }): string {
  const first = item.evidence[0];
  const more = item.evidence.length > 1 ? ` 외 ${item.evidence.length - 1}건` : "";
  const extra = item.kind === undefined ? "" : ` [${item.kind}; ${(item.clients ?? []).join(", ")}]`;
  const scope = item.scope === "user" ? " (user)" : "";
  return `  ${(item.name + scope + extra).padEnd(34)} ${item.confidence.toFixed(2)}  ${first?.file} (${first?.type}: ${first?.value})${more}`;
}

export function formatProfile(profile: ProjectProfile): string[] {
  const lines = [`OpenHub Project Analysis — ${profile.project.name}`, ""];
  for (const { key, title } of SECTIONS) {
    lines.push(title);
    const items = profile[key] as (DetectionItem & { kind?: string; clients?: string[] })[];
    if (items.length === 0) lines.push("  (탐지 안 됨)");
    for (const item of items) lines.push(describeItem(item));
    lines.push("");
  }
  lines.push(`Detectors  ${profile.detectors.map((d) => `${d.id}:${d.status}`).join("  ") || "(없음)"}`);
  if (profile.warnings.length > 0) {
    lines.push("", `Warnings (${profile.warnings.length})`);
    for (const w of profile.warnings) lines.push(`  - [${w.code}] ${w.file === undefined ? "" : `${w.file}: `}${w.message}`);
  }
  return lines;
}
