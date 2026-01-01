import path from "node:path";
import { parseArgs } from "node:util";
import { runProject } from "./project";
import { runInstall, type InstallCommandIO } from "./install";
import { runLifecycle, runLifecycleOperation, type LifecycleCommandIO } from "./lifecycle";
import { runRecommend } from "./recommend";
import { runImpact, runReleases, type ReleaseCommandIO } from "./release";
import { runDiscover } from "./discover";
import { runPinokio, runPinokioInstall, type PinokioCommandIO } from "./pinokio";
import { runAdopt, runBenchmarkCommand, runCandidate, runDiscoverView, runDoctor, type M7CommandIO } from "./m7";
import { registryDirOf } from "./paths";
import {
  AGENT_TARGETS,
  CATEGORIES,
  DEFAULT_METADATA_CACHE,
  Registry,
  USER_METADATA_CACHE,
  USER_METADATA_CACHE_LOGICAL,
  collectGitHubMetadata,
  formatRegistryIssue,
  loadRegistry,
  validateRegistry,
  resolveGitHubToken,
  toMetadataCache,
  writeMetadataCache,
  type AgentTarget,
  type Category,
  type FetchLike,
  type ProjectDetector,
} from "@openhub/core";

export interface CliIO {
  out(line: string): void;
  err(line: string): void;
  cwd: string;
  version: string;
  /**
   * 배포 경로(TASK-071). main이 명시·환경변수·패키지 리소스 순서로 정한 Registry 위치와 그 출처 이름,
   * metadata 명시 지정(OPENHUB_METADATA), 사용자 home. 없으면(개발 실행·테스트) cwd 기준 registry/만 쓰고 사용자 cache를 보지 않는다.
   */
  registryDir?: string;
  registrySource?: string;
  metadataFile?: string;
  homeDir?: string;
  /** 테스트에서 네트워크 없이 실행하기 위한 주입 지점. */
  fetch?: FetchLike;
  resolveToken?: () => Promise<{ token: string; source: string } | undefined>;
  detectors?: readonly ProjectDetector[];
  hostEnvironment?: Partial<import("@openhub/core").HostEnvironment>;
  /** 테스트에서 기준 시각을 고정하기 위한 주입 지점(catalog 미래 날짜 판정 등). */
  now?: () => Date;
}

const HELP = `openhub — Project-Aware AI Tool Lifecycle Manager

Usage: openhub <command> [options]

Commands:
  registry validate [--dir <path>]   Registry Manifest 검증 (기본: OPENHUB_REGISTRY > 설치 패키지의 registry)
  registry list [--category <c>] [--capability <c>] [--target <agent>] [--json] [--dir <path>]
                                     Registry Tool 목록
  collect [--out <file>] [--no-token] [--dir <path>]
                                     Registry Tool의 GitHub 메타데이터 수집 (기본: ${USER_METADATA_CACHE_LOGICAL})
  project scan <path> [--json] [--include-host]
                                     프로젝트 분석(Project Profile + Evidence). --include-host는 사용자 범위
                                     (~/.claude.json, ~/.codex/config.toml, ~/.cursor/mcp.json, PATH) 탐지를 켠다
  project recommend <path> [--json] [--include-host]
                                     프로젝트 맞춤 AI Tool 추천(Gap·Project Fit·OpenScore·이유). 설치하지 않는다.
                                     OpenScore는 ${USER_METADATA_CACHE_LOGICAL}(openhub collect) > 포함 snapshot을 읽는다
  install <toolId> [--project <path>] [--client <id>]... [--scope project|user] [--json]
                                     설치 계획(Plan)을 보여 주고 대화형 터미널에서 사람이 승인하면 설치한다.
                                     --json은 Plan과 digest만 출력하고 실행하지 않는다. 자동 승인 옵션은 없다
  lifecycle status [--project <path>] [--include-host] [--check] [--json]
                                     OpenHub가 설치한 도구의 Version State·drift·artifact lock·Health.
                                     --check는 registry에서 새 버전만 확인한다(실행·쓰기 없음)
  update <toolId> [--project <path>] [--client <id>]... [--scope project|user] [--to <version>] [--skip-health] [--json]
                                     새 버전을 확정(resolve)해 계획을 보여 주고 사람이 승인하면 교체한다.
                                     Health Check 통과 후에만 Version State에 기록한다
  rollback <toolId> [--project <path>] [--client <id>]... [--scope project|user] [--skip-health] [--json]
                                     Version State의 직전 버전으로 되돌린다(별도 승인)
  lifecycle health <toolId> [--project <path>] [--client <id>]... [--scope project|user] [--json]
                                     승인 후 MCP 서버를 격리 실행해 handshake를 확인하고 결과만 기록한다
                                     (--skip-health는 필요한 환경변수가 있는 도구에서만 Health 생략을 요청하며 따로 승인받는다)
  releases <toolId> [--project <path>] [--client <id>]... [--scope project|user] [--prerelease] [--no-token]
           [--llm-summary --llm-model <id>] [--json]
                                     현재 → 최신 버전, 결정론 요약(Breaking·Security·…), release notes 원문 일부, 링크.
                                     실행·쓰기 없음. LLM 요약은 OPENAI_API_KEY와 --llm-model을 줄 때만(표시 전용)
  impact <toolId> [--to <version>] [--project <path>] [--client <id>]... [--scope project|user] [--no-token] [--json]
                                     업데이트 영향(none·low·medium·high·unknown, 이유·근거·영향 파일). 실행 없음
  discover [--source github|npm|mcp-registry]... [--out registry-candidates] [--no-token] [--json]
                                     공개 출처에서 Candidate를 찾아 registry-candidates/에 draft로 적는다(registry/ 쓰기 없음)
  install <toolId> --backend pinokio [--client <id>]... [--scope project|user] [--arg key=value]... [--json]
                                     OpenHub가 생성한 제한 Pinokio script만 계획·승인 후 pinokiod로 실행한다
  pinokio inspect <owner/repo>@<commit> [--path install.js] [--no-token] [--json]
                                     제3자 Pinokio script 원문·정적 경고만 보여 준다(실행하지 않는다)
  adopt <toolId> [--project <path>] [--client <id>] [--scope project|user] [--server-name <name>] [--json]
                                     이미 설정된 도구를 승인 후 Version State 관리 대상으로 등록한다(설정 파일은 바꾸지 않는다)
  discover --view new|trending|verified|candidates [--project <path>] [--candidates-dir <dir>] [--include-host] [--json]
                                     DISCOVER 구역을 보여 준다(network 0). Candidate는 UNVERIFIED·DRAFT이며 설치 대상이 아니다
  trending [--json]                  discover --view trending과 같다(현재 popularity와 최근 release/activity 점수)
  candidate prepare <candidateId> [--candidates-dir <dir>] [--out contrib] [--remote]
                                     Registry 기여 패키지(draft Manifest·diff·PR 본문)를 만든다. GitHub에 쓰지 않는다
  benchmark <toolId> [--project <path>] [--client <id>] [--scope project|user] [--include-host] [--json]
                                     승인 후 MCP 서버를 6번 실행해 initialize·tools/list 시간을 잰다(tool 호출 없음)
  doctor [--json]                    실행 환경·backend·Registry·metadata·Version State·지원 범위를 확인한다(쓰기 0)
  --version                          버전 출력
  --help                             도움말 출력`;

/** CLI 진입점. 종료 코드를 돌려주며 process를 직접 종료하지 않는다(테스트 가능). */
export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const [command] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    io.out(HELP);
    return 0;
  }
  if (command === "--version" || command === "-v") {
    io.out(io.version);
    return 0;
  }
  if (command === "registry") return runRegistry(argv.slice(1), io);
  if (command === "collect") return runCollect(argv.slice(1), io);
  if (command === "project" && argv[1] === "recommend") return runRecommend(argv.slice(2), io, HELP);
  if (command === "project") return runProject(argv.slice(1), io, HELP);
  if (command === "install") {
    const rest = argv.slice(1);
    const at = rest.findIndex((a) => a === "--backend" || a.startsWith("--backend="));
    const backend = at === -1 ? undefined : rest[at]!.includes("=") ? rest[at]!.split("=")[1] : rest[at + 1];
    if (backend === "pinokio") return runPinokioInstall(rest.filter((_, i) => i !== at && !(i === at + 1 && !rest[at]!.includes("="))), io as CliIO & PinokioCommandIO, HELP);
    if (at !== -1) {
      io.err("--backend는 pinokio만 지정할 수 있습니다(npx·uvx·docker는 Manifest가 정합니다)");
      return 2;
    }
    return runInstall(rest, io as CliIO & InstallCommandIO, HELP);
  }
  if (command === "releases") return runReleases(argv.slice(1), io as CliIO & ReleaseCommandIO, HELP);
  if (command === "impact") return runImpact(argv.slice(1), io as CliIO & ReleaseCommandIO, HELP);
  if (command === "discover" && argv.slice(1).some((a) => a === "--view" || a.startsWith("--view="))) return runDiscoverView(argv.slice(1), io as CliIO & M7CommandIO, HELP);
  if (command === "discover") return runDiscover(argv.slice(1), io as CliIO & ReleaseCommandIO, HELP);
  if (command === "trending") return runDiscoverView(["--view", "trending", ...argv.slice(1)], io as CliIO & M7CommandIO, HELP);
  if (command === "adopt") return runAdopt(argv.slice(1), io as CliIO & M7CommandIO, HELP);
  if (command === "candidate") return runCandidate(argv.slice(1), io as CliIO & M7CommandIO, HELP);
  if (command === "benchmark") return runBenchmarkCommand(argv.slice(1), io as CliIO & M7CommandIO, HELP);
  if (command === "doctor") return runDoctor(argv.slice(1), io as CliIO & M7CommandIO, HELP);
  if (command === "pinokio") return runPinokio(argv.slice(1), io as CliIO & PinokioCommandIO, HELP);
  if (command === "lifecycle") return runLifecycle(argv.slice(1), io as CliIO & LifecycleCommandIO, HELP);
  if (command === "update" || command === "rollback") return runLifecycleOperation(command, argv.slice(1), io as CliIO & LifecycleCommandIO, HELP);
  io.err(`알 수 없는 명령: ${command}\n\n${HELP}`);
  return 2;
}

async function runCollect(argv: readonly string[], io: CliIO): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { dir: { type: "string" }, out: { type: "string" }, "no-token": { type: "boolean", default: false } },
    allowPositionals: false,
    strict: true,
  });
  const { entries, issues } = await loadRegistry(registryDirOf(io, values.dir));
  for (const issue of issues) io.err(`경고: ${formatRegistryIssue(issue)}`);
  const repos = [...new Set(entries.map((e) => e.manifest.repository.github))];
  const found = values["no-token"] ? undefined : await (io.resolveToken ?? (() => resolveGitHubToken()))();
  io.out(found === undefined ? "토큰 없음 → REST API로 수집합니다(요청 한도 60회/시간)" : `토큰 출처: ${found.source} → GraphQL로 수집합니다`);
  const result = await collectGitHubMetadata(repos, {
    token: found?.token,
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
  });
  // 기본 출력은 ~/.openhub/cache/metadata.json(TASK-071). home을 모르는 실행(테스트)만 예전처럼 cwd 기준이다.
  const out = values.out !== undefined ? path.resolve(io.cwd, values.out) : io.homeDir !== undefined ? path.join(io.homeDir, USER_METADATA_CACHE) : path.resolve(io.cwd, DEFAULT_METADATA_CACHE);
  const outLabel = values.out === undefined && io.homeDir !== undefined ? USER_METADATA_CACHE_LOGICAL : path.relative(io.cwd, out) || out;
  await writeMetadataCache(out, toMetadataCache(result));
  let failed = 0;
  for (const r of result.results) {
    if (r.ok) {
      const m = r.metadata;
      const release = m.latestRelease === null ? "release 없음" : `${m.latestRelease.tag}`;
      io.out(`  ${r.repository.padEnd(36)} ★ ${String(m.stars).padStart(7)}  ${release}${m.archived ? "  [archived]" : ""}`);
    } else {
      failed++;
      io.err(`  ${r.repository.padEnd(36)} ✗ ${r.kind}: ${r.error}`);
    }
  }
  io.out(`저장소 ${result.results.length}개 중 성공 ${result.results.length - failed}개 · 실패 ${failed}개 → ${outLabel}`);
  return failed > 0 && failed === result.results.length ? 1 : 0;
}

async function runRegistry(argv: readonly string[], io: CliIO): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      dir: { type: "string" },
      category: { type: "string" },
      capability: { type: "string" },
      target: { type: "string" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
    strict: true,
  });
  const dir = registryDirOf(io, values.dir);
  if (sub === "validate") {
    // fast validation(D-025): schema·이름·alias + update.source↔adapter·spec 문법·지원 backend·Pinokio template
    // + Catalog Metadata v1(D-035: Manifest↔catalog 1:1, 날짜 형식·미래 날짜). network 0.
    const { entries, issues } = await validateRegistry(dir, { catalog: { asOf: (io.now ?? (() => new Date()))() } });
    if (issues.length > 0) {
      for (const issue of issues) io.err(formatRegistryIssue(issue));
      io.err(`✗ Registry 검증 실패: 오류 ${issues.length}건 (통과 ${entries.length}개)`);
      return 1;
    }
    io.out(`✓ Registry 검증 통과: Manifest ${entries.length}개`);
    return 0;
  }
  if (sub === "list") {
    const { category, capability, target } = values;
    if (category !== undefined && !(CATEGORIES as readonly string[]).includes(category)) {
      io.err(`알 수 없는 카테고리: ${category} (허용: ${CATEGORIES.join(", ")})`);
      return 2;
    }
    if (target !== undefined && !(AGENT_TARGETS as readonly string[]).includes(target)) {
      io.err(`알 수 없는 target: ${target} (허용: ${AGENT_TARGETS.join(", ")})`);
      return 2;
    }
    const { entries, issues } = await loadRegistry(dir);
    for (const issue of issues) io.err(`경고: ${formatRegistryIssue(issue)}`);
    const found = new Registry(entries).list({
      ...(category === undefined ? {} : { category: category as Category }),
      ...(capability === undefined ? {} : { capability }),
      ...(target === undefined ? {} : { target: target as AgentTarget }),
    });
    if (values.json) {
      io.out(JSON.stringify(found.map((e) => e.manifest), null, 2));
      return 0;
    }
    for (const e of found) {
      const m = e.manifest;
      io.out(`${m.name.padEnd(22)} [${m.category.join(", ")}] ${m.summary ?? m.repository.github}`);
    }
    io.out(`— ${found.length}개`);
    return 0;
  }
  io.err(`알 수 없는 registry 하위 명령: ${sub ?? "(없음)"}\n\n${HELP}`);
  return 2;
}
