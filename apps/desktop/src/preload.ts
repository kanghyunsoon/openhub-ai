import { contextBridge, ipcRenderer } from "electron";
import { formatDateTime, formatNumber, isLocale, translate, type Params } from "./i18n/index";

/**
 * 다국어 브리지(v0.2.0 P0-3 PR B). 카탈로그는 이 번들에 들어 있고 현재 언어만 main에서 동기로 받는다.
 * t()는 텍스트만 돌려준다(renderer는 textContent로만 넣는다). params는 문자열·숫자만 받는다. setLanguage는 en·ko만 저장한다.
 */
const locale = (() => {
  const value: unknown = ipcRenderer.sendSync("i18n:locale");
  return isLocale(value) ? value : "en";
})();
const textParams = (value: unknown): Params | undefined => {
  if (value === null || typeof value !== "object") return undefined;
  const out: Record<string, string | number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === "string" || typeof v === "number") out[k] = v;
  return out;
};
contextBridge.exposeInMainWorld("openhubI18n", {
  locale,
  t: (key: unknown, params?: unknown) => translate(locale, String(key), textParams(params)),
  formatDateTime: (iso: unknown) => formatDateTime(String(iso), locale),
  formatNumber: (n: unknown) => formatNumber(Number(n), locale),
  setLanguage: (value: unknown) => ipcRenderer.invoke("i18n:set", String(value)),
});

/** 프로젝트 분석 브리지. 인자를 받지 않는다. 분석 경로는 메인 프로세스의 폴더 선택 결과만 쓴다(TASK-015). */
const projectBridge = {
  scanProject: () => ipcRenderer.invoke("project:select-and-scan"),
};

/** FOR YOU 추천 브리지. 인자를 받지 않는다. 추천 대상은 메인 프로세스가 대화상자로 분석한 프로젝트뿐이다(TASK-026). */
const recommendBridge = {
  recommendProject: () => ipcRenderer.invoke("project:recommend"),
};

/**
 * 설치 브리지(TASK-036). toolId 하나만 보낸다. Plan·digest·승인을 보내는 API는 없다.
 * 최종 승인은 main 프로세스의 네이티브 확인 대화상자에서만 만들어진다.
 */
const installBridge = {
  // Client 선택(v0.2.0 P0-3 PR C): Client 이름 문자열 목록만 넘긴다. 검증은 main이 한다.
  installOptions: (toolId: unknown) => ipcRenderer.invoke("install:options", String(toolId)),
  planInstall: (toolId: unknown, selection?: unknown) => {
    const clients = selection !== null && typeof selection === "object" && Array.isArray((selection as { clients?: unknown }).clients) ? ((selection as { clients: unknown[] }).clients.slice(0, 6).map(String)) : undefined;
    // 범위는 "project"·"user" 이름만(경로 없음). 그 밖의 값은 문자열로 넘기고 main이 거부한다.
    const scope = clients !== undefined && typeof (selection as { scope?: unknown }).scope === "string" ? String((selection as { scope: string }).scope) : undefined;
    return ipcRenderer.invoke("install:plan", String(toolId), clients === undefined ? undefined : scope === undefined ? { clients } : { clients, scope });
  },
  runInstall: (toolId: unknown) => ipcRenderer.invoke("install:run", String(toolId)),
  discardInstallPlan: (toolId: unknown) => ipcRenderer.invoke("install:discard", String(toolId)),
};

/**
 * Lifecycle 브리지(TASK-046). state entry id 하나만 보낸다. 경로·Plan·digest·승인을 보내는 API는 없다.
 * 최종 승인은 main 프로세스의 네이티브 확인 대화상자에서만 만들어진다.
 */
const lifecycleBridge = {
  // 사용자 범위 보기(v0.2.0 P0-3 C2): { includeUser: boolean }만 넘긴다. 없으면 main의 현재 설정 그대로.
  lifecycleStatus: (options?: unknown) =>
    ipcRenderer.invoke("lifecycle:status", options !== null && typeof options === "object" && typeof (options as { includeUser?: unknown }).includeUser === "boolean" ? { includeUser: (options as { includeUser: boolean }).includeUser } : undefined),
  checkLifecycle: (id: unknown) => ipcRenderer.invoke("lifecycle:check", String(id)),
  // 정확한 버전(선택)은 문자열일 때만 { version }으로 보낸다. 검증은 main이 한다.
  planLifecycleUpdate: (id: unknown, version?: unknown) => ipcRenderer.invoke("lifecycle:plan-update", String(id), typeof version === "string" ? { version } : undefined),
  planLifecycleRollback: (id: unknown) => ipcRenderer.invoke("lifecycle:plan-rollback", String(id)),
  planLifecycleHealth: (id: unknown) => ipcRenderer.invoke("lifecycle:plan-health", String(id)),
  planLifecycleRepair: (id: unknown) => ipcRenderer.invoke("lifecycle:plan-repair", String(id)),
  runLifecycle: (id: unknown, version?: unknown) => ipcRenderer.invoke("lifecycle:run", String(id), typeof version === "string" ? { version } : undefined),
  discardLifecyclePlan: () => ipcRenderer.invoke("lifecycle:discard"),
};

/**
 * Release·Impact·Pinokio Preview 브리지(TASK-057). INSTALLED 항목 id, Registry toolId, "owner/repo@commit"·script 경로만 보낸다.
 * 실행·승인 API는 없다(Pinokio 설치는 CLI 승인 흐름).
 */
const releaseBridge = {
  checkRelease: (id: unknown) => ipcRenderer.invoke("release:check", String(id)),
  previewPinokio: (toolId: unknown) => ipcRenderer.invoke("pinokio:preview", String(toolId)),
  inspectPinokio: (ref: unknown, scriptPath: unknown) => ipcRenderer.invoke("pinokio:inspect", String(ref), String(scriptPath)),
};

/** 화면에 노출하는 기본 API. Node·파일 시스템은 노출하지 않는다. */
contextBridge.exposeInMainWorld("openhub", {
  listRegistry: () => ipcRenderer.invoke("registry:list"),
  ...projectBridge,
  ...recommendBridge,
  ...installBridge,
  ...lifecycleBridge,
});

/** M6 조회·미리보기 전용 API(실행·승인 없음). 기본 openhub 객체는 바꾸지 않는다. */
contextBridge.exposeInMainWorld("openhubRelease", releaseBridge);

/** AI Summary 브리지(TASK-063). 항목 id와 model만 보낸다. API key를 주고받는 API는 없다(key는 main process가 클릭 시점에 읽는다). */
const aiBridge = {
  aiSummary: (id: unknown, model: unknown) => ipcRenderer.invoke("release:ai-summary", String(id), String(model)),
};
contextBridge.exposeInMainWorld("openhubAi", aiBridge);

/**
 * DISCOVER·상세·Candidate 기여·Adopt·Benchmark 브리지(TASK-070). toolId·Candidate id·INSTALLED 항목 id 하나만 보낸다.
 * 경로·명령·Plan·digest·승인을 보내는 API와 일반 실행 API는 없다. 승인은 main process 네이티브 대화상자에서만 만들어진다.
 * 기본 openhub·openhubRelease·openhubAi 객체는 바꾸지 않는다.
 */
const discoverBridge = {
  discoverView: () => ipcRenderer.invoke("discover:view"),
  toolDetail: (toolId: unknown) => ipcRenderer.invoke("tool:detail", String(toolId)),
  prepareCandidate: (id: unknown) => ipcRenderer.invoke("candidate:prepare", String(id)),
  adoptCandidates: () => ipcRenderer.invoke("adopt:candidates"),
  runAdopt: (id: unknown) => ipcRenderer.invoke("adopt:run", String(id)),
  runBenchmark: (id: unknown) => ipcRenderer.invoke("benchmark:run", String(id)),
};
contextBridge.exposeInMainWorld("openhubDiscover", discoverBridge);
