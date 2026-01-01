import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import {
  CANDIDATES_DIR,
  TREND_SCORE_MEANING,
  buildDiscoverView,
  formatTrendItem,
  installCandidates,
  loadCatalog,
  loadMetadataSnapshot,
  loadRegistry,
  prepareContribution,
  projectKeyFor,
  readCandidateFile,
  readLifecycleState,
  recommend,
  toRecommendPlatform,
  writeContributionPackage,
  type ConfigFs,
  type DiscoveryCandidate,
  discoveryCandidateSchema,
} from "@openhub/core";
import type { RecommendSession } from "./recommend";

/**
 * Desktop DISCOVER·Tool 상세·Candidate 기여 패키지(TASK-070, D-035·D-031).
 * - discover:view는 인자를 받지 않는다. 고른 프로젝트의 추천(M3)·Version State·catalog·metadata·Candidate 파일로 네 구역을 만든다(network·write 0).
 * - Candidate에는 Install·Adopt·Update 동작이 없고 UNVERIFIED·DRAFT 배지가 붙는다. 비신뢰 문자열은 untrusted 필드로만 보낸다.
 * - tool:detail은 Registry toolId 하나만 받는다. Install은 이 프로젝트 FOR YOU 추천에 있는 도구에만 열어 둔다(기존 설치 승인 흐름).
 * - candidate:prepare는 candidateId 하나만 받고 저장 폴더는 main의 폴더 선택 대화상자로만 정한다. GitHub write 0.
 */

export const DISCOVER_VIEW_CHANNEL = "discover:view";
export const TOOL_DETAIL_CHANNEL = "tool:detail";
export const CANDIDATE_PREPARE_CHANNEL = "candidate:prepare";

type Listener = (...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
}

export interface DiscoverDeps {
  registryDir: string;
  metadataFile: string;
  /** registry-candidates 디렉터리 */
  candidatesDir: string;
  homeDir: string;
  platform: string;
  recommend: RecommendSession;
  projectDir: () => string | undefined;
  /** 기여 패키지를 쓸 폴더 선택(취소면 null). */
  chooseFolder: () => Promise<string | null>;
  toolVersion: string;
  now?: () => Date;
  configFs?: ConfigFs;
  /** 스모크용 Candidate 주입. */
  candidates?: () => Promise<DiscoveryCandidate[]>;
}

export interface DiscoverItemView {
  kind: "registry-tool";
  toolId: string;
  title: string;
  line: string;
}
export interface CandidateItemView {
  kind: "candidate";
  id: string;
  badges: string[];
  line: string;
  /** 비신뢰 데이터(textContent로만 표시) */
  untrusted: { description: string | null; installText: string | null };
  evidence: string[];
  actions: string[];
}
export type DiscoverViewResponse =
  | { status: "ok"; asOf: string; trendMeaning: string; metadataCollectedAt: string | null; sections: { newForProject: DiscoverItemView[]; trending: DiscoverItemView[]; verified: DiscoverItemView[]; candidates: CandidateItemView[] } }
  | { status: "error"; code: string; message: string };

const clean = (s: string, max = 300) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, " ").slice(0, max);

async function readCandidates(dir: string): Promise<DiscoveryCandidate[]> {
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => /^[a-z0-9]+(?:-[a-z0-9]+)*\.yaml$/u.test(f)).sort();
  } catch {
    return [];
  }
  const out: DiscoveryCandidate[] = [];
  for (const f of files) {
    const r = await readCandidateFile(dir, f.slice(0, -5));
    if (r.ok) out.push(r.candidate);
  }
  return out;
}

async function context(deps: DiscoverDeps) {
  const [{ entries }, snapshot, catalog] = await Promise.all([loadRegistry(deps.registryDir), loadMetadataSnapshot(deps.metadataFile), loadCatalog(deps.registryDir)]);
  const profile = deps.recommend.profile;
  const platform = toRecommendPlatform(deps.platform);
  const report = profile === undefined ? undefined : recommend(profile, entries, snapshot, platform === undefined ? {} : { platform });
  return { entries, snapshot, catalog: catalog.ok ? catalog.catalog : undefined, report };
}

export async function discoverViewForRenderer(deps: DiscoverDeps): Promise<DiscoverViewResponse> {
  try {
    const { entries, snapshot, catalog, report } = await context(deps);
    const managed: string[] = [];
    const dir = deps.projectDir();
    if (dir !== undefined) {
      const state = await readLifecycleState({ homeDir: deps.homeDir, ...(deps.configFs === undefined ? {} : { fs: deps.configFs }) });
      const key = await projectKeyFor(dir).catch(() => null);
      if (state.ok) for (const e of Object.values(state.state.entries)) if (e.target.scope === "project" && e.target.projectKey === key) managed.push(e.toolId);
    }
    const candidates = await (deps.candidates ?? (() => readCandidates(deps.candidatesDir)))();
    const v = buildDiscoverView({ entries, catalog, snapshot, report, managedToolIds: managed, candidates, asOf: (deps.now ?? (() => new Date()))() });
    const titleOf = (id: string) => entries.find((e) => e.manifest.name === id)?.manifest.displayName ?? id;
    return {
      status: "ok",
      asOf: v.asOf,
      trendMeaning: TREND_SCORE_MEANING,
      metadataCollectedAt: v.metadataCollectedAt,
      sections: {
        newForProject: v.sections.newForProject.map((t) => ({ kind: "registry-tool", toolId: t.toolId, title: titleOf(t.toolId), line: "추천 " + String(t.rank) + "위 · " + t.primaryCapability + " · Registry 등록 " + t.addedAt })),
        trending: v.sections.trending.map((t, i) => ({ kind: "registry-tool", toolId: t.toolId, title: titleOf(t.toolId), line: clean(formatTrendItem(t, i + 1)) })),
        verified: v.sections.verified.map((t) => ({ kind: "registry-tool", toolId: t.toolId, title: t.displayName, line: t.verification + " · " + (t.addedAt ?? "등록일 미상") + " · " + clean(t.summary ?? "") })),
        candidates: v.sections.candidates.map((c) => ({
          kind: "candidate",
          id: c.id,
          badges: [...c.badges],
          line: c.confidence + " · " + c.sources.join("+") + (c.repository === null ? "" : " · " + c.repository) + (c.package === null ? "" : " · " + c.package.kind + " " + c.package.name),
          untrusted: { description: c.untrustedText.description === null ? null : clean(c.untrustedText.description), installText: c.untrustedText.installText === null ? null : clean(c.untrustedText.installText) },
          evidence: c.evidence.map((e) => e.source + ": " + clean(e.ref, 200)),
          actions: [...c.actions],
        })),
      },
    };
  } catch {
    return { status: "error", code: "discover-failed", message: "DISCOVER 화면을 만들지 못했습니다" };
  }
}

export type ToolDetailResponse =
  | {
      status: "ok";
      detail: { toolId: string; title: string; summary: string | null; categories: string[]; openScore: string; openScoreMeaning: string; projectFit: string; reasons: string[]; backends: string[]; requirements: string[]; platforms: string[]; canInstall: boolean; installNote: string };
    }
  | { status: "not-found" }
  | { status: "error"; code: string; message: string };

export const OPEN_SCORE_MEANING = "OpenScore는 저장소 유지관리·활동성·커뮤니티 신호이며 보안·코드 품질 평가가 아닙니다";

export async function toolDetailForRenderer(deps: DiscoverDeps, toolId: unknown): Promise<ToolDetailResponse> {
  try {
    if (typeof toolId !== "string") return { status: "not-found" };
    const { entries, report } = await context(deps);
    const m = entries.find((e) => e.manifest.name === toolId)?.manifest;
    if (m === undefined) return { status: "not-found" };
    const rec = report?.recommendations.find((r) => r.toolId === toolId);
    const fmt = (x: number | null | undefined) => (x === null || x === undefined ? "—" : String(Math.round(x * 100)));
    const req = m.requirements;
    return {
      status: "ok",
      detail: {
        toolId,
        title: m.displayName ?? m.name,
        summary: m.summary ?? null,
        categories: [...m.category],
        openScore: rec === undefined ? "—" : fmt(rec.openScore.score),
        openScoreMeaning: OPEN_SCORE_MEANING,
        projectFit: rec === undefined ? (report === undefined ? "프로젝트를 고르면 계산합니다" : "이 프로젝트의 추천 대상이 아닙니다") : fmt(rec.projectFit.score),
        reasons: rec === undefined ? [] : rec.reasons.map((r) => clean(r.message, 600)),
        backends: installCandidates(m).map((c) => c.step.adapter),
        requirements: [req.node === undefined ? null : "Node " + req.node, req.python === undefined ? null : "Python " + req.python, req.docker === true ? "Docker" : null, ...m.env.filter((e) => e.required).map((e) => "환경변수 " + e.name)].filter((x): x is string => x !== null),
        platforms: (["windows", "macos", "linux"] as const).filter((p) => m.platform[p]),
        canInstall: rec !== undefined,
        installNote: rec !== undefined ? "FOR YOU 설치 흐름(계획 → 네이티브 승인)으로 설치합니다" : "설치 버튼은 이 프로젝트의 FOR YOU 추천에 있는 Registry 도구에만 있습니다",
      },
    };
  } catch {
    return { status: "error", code: "detail-failed", message: "도구 정보를 만들지 못했습니다" };
  }
}

export type CandidatePrepareResponse = { status: "ok"; folder: string; files: string[]; note: string } | { status: "cancelled" } | { status: "error"; code: string; message: string };

export async function candidatePrepareForRenderer(deps: DiscoverDeps, candidateId: unknown): Promise<CandidatePrepareResponse> {
  if (typeof candidateId !== "string") return { status: "error", code: "CONTRIBUTION_INVALID_ID", message: "Candidate를 고르세요" };
  const pool = await (deps.candidates ?? (() => readCandidates(deps.candidatesDir)))();
  const found = pool.find((c) => c.id === candidateId) ?? (deps.candidates === undefined ? ((r) => (r.ok ? r.candidate : undefined))(await readCandidateFile(deps.candidatesDir, candidateId)) : undefined);
  if (found === undefined) return { status: "error", code: "CANDIDATE_NOT_FOUND", message: CANDIDATES_DIR + "에 그 Candidate가 없습니다" };
  const folder = await deps.chooseFolder();
  if (folder === null) return { status: "cancelled" };
  const catalogText = await readFile(path.join(deps.registryDir, "catalog.yaml"), "utf8").catch(() => null);
  const prepared = await prepareContribution(found, { asOf: (deps.now ?? (() => new Date()))(), catalogText, toolVersion: deps.toolVersion });
  if (!prepared.ok) return { status: "error", code: prepared.code, message: prepared.message };
  const written = await writeContributionPackage(folder, prepared);
  if (!written.ok) return { status: "error", code: written.code, message: written.message };
  return { status: "ok", folder: written.dir, files: written.files, note: "OpenHub는 GitHub에 쓰지 않았습니다. 검토한 뒤 COMMANDS.md의 명령을 직접 실행하세요." };
}

export function registerDiscover(ipc: IpcMainLike, deps: DiscoverDeps): void {
  ipc.handle(DISCOVER_VIEW_CHANNEL, () => discoverViewForRenderer(deps));
  ipc.handle(TOOL_DETAIL_CHANNEL, (_event: unknown, toolId: unknown) => toolDetailForRenderer(deps, toolId));
  ipc.handle(CANDIDATE_PREPARE_CHANNEL, (_event: unknown, id: unknown) => candidatePrepareForRenderer(deps, id));
}

/** 스모크(--smoke) 전용 가짜 Candidate. 비신뢰 문자열에 HTML·명령을 넣어 textContent 렌더링을 확인한다(network 0). */
export function smokeDiscoverCandidates(): DiscoveryCandidate[] {
  return [
    discoveryCandidateSchema.parse({
      id: "smoke-weather-mcp",
      sources: ["github-search"],
      repository: "acme/smoke-weather-mcp",
      package: { kind: "npm", name: "smoke-weather-mcp", key: "npm:smoke-weather-mcp" },
      signals: { stars: 12, updatedAt: "2026-10-01T00:00:00.000Z", archived: false, description: "<img src=x onerror=alert(1)> Weather MCP <script>alert(2)</script>" },
      confidence: "medium",
      evidence: [{ source: "github-search", ref: "acme/smoke-weather-mcp" }],
      untrustedInstallText: "npx -y smoke-weather-mcp && <b>run</b>",
      discoveredAt: "2026-10-06T00:00:00.000Z",
    }),
  ];
}

