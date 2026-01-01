import { createOpenAiSummaryProvider, openAiProviderFromCli, runLlmSummary, type FetchLike, type ReleaseSnapshotV1, type ReleaseSummaryV1 } from "@openhub/core";

/**
 * Desktop AI Summary(TASK-063, D-030). M6 SummaryProvider(OpenAI Responses API, api.openai.com 고정)를 재사용한다.
 * - 사용자가 릴리스 화면의 [AI Summary]를 누른 경우에만 main process가 그 시점에 OPENAI_API_KEY를 읽는다.
 *   환경변수가 있다는 이유만으로 호출하지 않는다. 앱 시작·프로젝트 선택·릴리스 확인에서는 호출 0이다.
 * - 순서: model 형식 확인 → key 읽기(없으면 안내, 호출 0) → 세션 첫 호출이면 보낼 내용·목적지 확인 대화상자(취소하면 호출 0) → 호출.
 * - key는 renderer로 보내지 않고 저장·로그·analytics가 없다. key 입력 UI·keychain이 없다. model은 세션 메모리에만 있다.
 * - 실패하면 결정론 요약은 그대로이고 오류만 알린다. LLM 결과는 표시 전용이며 Impact·Plan·승인에 쓰지 않는다.
 * - 입력은 직전에 [릴리스 확인]으로 만든 ReleaseSnapshot·결정론 요약(세션 메모리)이다. 이 모듈은 다시 조회하지 않는다.
 */

export const AI_SUMMARY_CHANNEL = "release:ai-summary";
export const AI_SUMMARY_DESTINATION = "api.openai.com";

type Listener = (...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
}

interface Remembered {
  toolId: string;
  snapshot: ReleaseSnapshotV1;
  summary: ReleaseSummaryV1;
}

/** 세션 메모리. 디스크에 쓰지 않는다. */
export class AiSummarySession {
  private readonly releases = new Map<string, Remembered>();
  private consented = false;
  /** [릴리스 확인] 결과를 기억한다(ReleaseDeps.onSnapshot). */
  remember(id: string, snapshot: ReleaseSnapshotV1, summary: ReleaseSummaryV1): void {
    this.releases.set(id, { toolId: snapshot.toolId, snapshot, summary });
  }
  get(id: string): Remembered | undefined {
    return this.releases.get(id);
  }
  get hasConsent(): boolean {
    return this.consented;
  }
  consent(): void {
    this.consented = true;
  }
}

export interface AiSummaryDeps {
  /** 클릭 시점에 main process가 OPENAI_API_KEY를 읽는다. 값은 provider에만 넘긴다. */
  readKey: () => string | null;
  /** 보낼 내용·목적지 확인(네이티브 대화상자). true면 보낸다. */
  confirm: (lines: readonly string[]) => Promise<boolean>;
  fetch?: FetchLike;
  timeoutMs?: number;
}

export type AiSummaryResponse =
  | { status: "ok"; model: string; text: string }
  | { status: "invalid-model" | "no-key" | "no-release" | "cancelled"; message: string }
  | { status: "failed"; reason: string; message: string };

const FAILED = "AI 요약을 받지 못했습니다. 결정론 요약은 그대로입니다.";

/** 보낼 내용 안내 줄(key·경로 없음). */
export function aiSummaryConsentLines(r: { toolId: string; snapshot: ReleaseSnapshotV1 }): string[] {
  const versions = [r.snapshot.current.version ?? "현재 버전 미확인", r.snapshot.target?.version ?? "최신 버전 없음"].join(" → ");
  return [
    "AI Summary는 아래 내용을 " + AI_SUMMARY_DESTINATION + "(OpenAI Responses API)로 보냅니다.",
    "도구: " + r.toolId + " (" + versions + ")",
    "보내는 것: 결정론 요약과 잘린 release notes 원문",
    "보내지 않는 것: 설정 파일, 경로, 환경변수 값, Version State",
    "API key는 OPENAI_API_KEY 환경변수에서 지금 한 번 읽고 저장하지 않습니다.",
    "결과는 표시용이며 Impact·업데이트 판단에 쓰지 않습니다.",
  ];
}

/** release:ai-summary — INSTALLED 항목 id와 model. 명시적 클릭에서만 호출된다. */
export async function aiSummaryForRenderer(session: AiSummarySession, deps: AiSummaryDeps, id: unknown, model: unknown): Promise<AiSummaryResponse> {
  const modelId = typeof model === "string" ? model.trim() : "";
  if (openAiProviderFromCli({ llmSummary: true, llmModel: modelId === "" ? null : modelId }, {}).unavailable === "invalid-model") {
    return { status: "invalid-model", message: "model ID를 입력하세요(영문·숫자·.·_·:·-, 100자 이하)" };
  }
  const remembered = typeof id === "string" ? session.get(id) : undefined;
  if (remembered === undefined) return { status: "no-release", message: "먼저 [릴리스 확인]을 누르세요" };
  const apiKey = deps.readKey();
  if (apiKey === null) return { status: "no-key", message: "OPENAI_API_KEY가 설정되지 않았습니다. 결정론 요약은 그대로 볼 수 있습니다." };
  if (!session.hasConsent) {
    if (!(await deps.confirm(aiSummaryConsentLines(remembered)))) return { status: "cancelled", message: "AI Summary를 보내지 않았습니다" };
    session.consent();
  }
  const provider = createOpenAiSummaryProvider({ apiKey, model: modelId, ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }), ...(deps.timeoutMs === undefined ? {} : { timeoutMs: deps.timeoutMs }) });
  const result = await runLlmSummary(remembered.summary, remembered.snapshot, provider);
  if (result.status === "ok") return { status: "ok", model: result.model, text: result.text };
  return { status: "failed", reason: result.status === "failed" ? result.reason : result.reason, message: FAILED };
}

export function registerAiSummary(ipc: IpcMainLike, session: AiSummarySession, deps: AiSummaryDeps): void {
  ipc.handle(AI_SUMMARY_CHANNEL, (_event: unknown, id: unknown, model: unknown) => aiSummaryForRenderer(session, deps, id, model));
}

