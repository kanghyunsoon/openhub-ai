import { loadMetadataSnapshot, loadRegistry, recommend, toRecommendPlatform, type ProjectProfile } from "@openhub/core";
import { buildForYouView, type ForYouView } from "./for-you-view";
import { tr } from "./i18n/index";

/**
 * Desktop FOR YOU 추천 연동(TASK-026, D-005: 메인 프로세스에서 Core를 직접 호출).
 * - 추천 대상은 [프로젝트 선택] 대화상자로 분석한 Profile뿐이다. 화면(renderer)이 보낸 인자는 무시한다.
 * - Host Probe는 D-003·TASK-015대로 Desktop에서 실행하지 않는다(inspectedScopes = ["project"]).
 * - 설치하지 않는다(M4). 네트워크를 쓰지 않으며 OpenScore는 로컬 metadata cache만 읽는다.
 */

export const PROJECT_RECOMMEND_CHANNEL = "project:recommend";

export type RecommendResponse = { status: "ok"; view: ForYouView } | { status: "no-project" } | { status: "error"; code: string; message: string };

type Listener = (...args: unknown[]) => unknown;
interface IpcMainLike {
  handle(channel: string, listener: Listener): void;
}

export interface RecommendDeps {
  registryDir: string;
  metadataFile: string;
  /** process.platform 형식 */
  platform: string;
}

const isOkScan = (v: unknown): v is { status: "ok"; profile: ProjectProfile } =>
  typeof v === "object" && v !== null && (v as { status?: unknown }).status === "ok" && "profile" in v;

/** 마지막으로 대화상자에서 분석한 Profile을 기억한다. */
export class RecommendSession {
  #profile: ProjectProfile | undefined;

  get profile(): ProjectProfile | undefined {
    return this.#profile;
  }

  /** 프로젝트 분석 IPC 결과를 관찰하는 ipcMain 래퍼. 결과는 바꾸지 않는다. */
  observe(ipc: IpcMainLike): IpcMainLike {
    return {
      handle: (channel, listener) =>
        ipc.handle(channel, async (...args: unknown[]) => {
          const result = await listener(...args);
          if (isOkScan(result)) this.#profile = result.profile;
          else if (typeof result === "object" && result !== null && (result as { status?: unknown }).status === "error") this.#profile = undefined;
          return result;
        }),
    };
  }
}

export async function recommendCurrentProject(session: RecommendSession, deps: RecommendDeps): Promise<RecommendResponse> {
  const profile = session.profile;
  if (profile === undefined) return { status: "no-project" };
  try {
    const [{ entries }, snapshot] = await Promise.all([loadRegistry(deps.registryDir), loadMetadataSnapshot(deps.metadataFile)]);
    const platform = toRecommendPlatform(deps.platform);
    const report = recommend(profile, entries, snapshot, platform === undefined ? {} : { platform });
    // 진단(v0.2.0 C3)은 같은 Profile·Registry·OS로 만든다. 새 점수·후보를 만들지 않는다.
    return { status: "ok", view: buildForYouView(report, { profile, entries, ...(platform === undefined ? {} : { platform }) }) };
  } catch {
    return { status: "error", code: "recommend-failed", message: tr("recommend.failed") };
  }
}

/** IPC 핸들러 등록. 화면이 보낸 인자는 받지 않는다(임의 경로·Profile 주입 방지). */
export function registerProjectRecommend(ipc: IpcMainLike, session: RecommendSession, deps: RecommendDeps): void {
  ipc.handle(PROJECT_RECOMMEND_CHANNEL, () => recommendCurrentProject(session, deps));
}
