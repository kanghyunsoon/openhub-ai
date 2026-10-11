import path from "node:path";
import { cpSync, mkdtempSync } from "node:fs";
import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import { app, BrowserWindow, dialog, ipcMain } from "electron";
import {
  BUNDLED_METADATA_SNAPSHOT,
  CANDIDATES_DIR,
  METADATA_ENV,
  OPENHUB_CORE_VERSION,
  REGISTRY_ENV,
  readOpenAiApiKey,
  resolveMetadataFileSync,
  resolveRegistryDir,
  toolConfigLocation,
} from "@openhub/core";
import { registerAdopt, smokeAdoptDeps } from "./adopt";
import { registerDiscover, smokeDiscoverCandidates } from "./discover";
import { InstallSession, registerInstall, smokeInstallDeps } from "./install";
import { LifecycleSession, registerLifecycle, smokeLifecycleDeps, smokeRepairDeps } from "./lifecycle";
import { AiSummarySession, registerAiSummary } from "./llm";
import { registerRelease, smokeReleaseDeps } from "./release";
import { electronDirectoryPicker, fixedDirectory, registerProjectScan, runProjectSmoke } from "./project-scan";
import { RecommendSession, registerProjectRecommend } from "./recommend";
import { buildRegistryView } from "./registry-view";
import { getDesktopLocale, isLocale, resolveLocale, setDesktopLocale, tr } from "./i18n/index";
import { readStoredLanguage, writeStoredLanguage } from "./i18n/preferences";

const smoke = process.argv.includes("--smoke");
/**
 * Desktop 언어(v0.2.0 P0-3 PR B). 창을 열기 전에 저장된 선택(userData/preferences.json) > OS 언어(ko 계열이면 한국어) > English로 정한다.
 * 스모크에서만 OS 언어(OPENHUB_SMOKE_SYSTEM_LOCALE)와 userData 위치(OPENHUB_SMOKE_USER_DATA)를 바꿀 수 있다(실제 재실행 검증용).
 */
const smokeUserData = smoke ? process.env["OPENHUB_SMOKE_USER_DATA"] || undefined : undefined;
if (smokeUserData !== undefined) app.setPath("userData", smokeUserData);
const smokeSystemLocale = smoke ? process.env["OPENHUB_SMOKE_SYSTEM_LOCALE"] || undefined : undefined;
const smokeI18nSwitch = smoke ? process.env["OPENHUB_SMOKE_I18N_SWITCH"] || undefined : undefined;
async function initDesktopLocale(): Promise<void> {
  const system = smokeSystemLocale !== undefined ? [smokeSystemLocale] : [...app.getPreferredSystemLanguages(), app.getSystemLocale()];
  setDesktopLocale(resolveLocale({ stored: await readStoredLanguage(app.getPath("userData")), system }));
}
// preload가 시작할 때 현재 언어를 동기로 받는다(카탈로그는 preload 번들에 들어 있다).
ipcMain.on("i18n:locale", (event) => {
  event.returnValue = getDesktopLocale();
});
// 언어 선택 저장. en·ko만 받는다. 저장에 성공했을 때만 바꾸고, renderer가 화면을 다시 읽는다.
ipcMain.handle("i18n:set", async (_event, value: unknown) => {
  if (!isLocale(value)) return { status: "invalid" };
  const saved = await writeStoredLanguage(app.getPath("userData"), value);
  if (!saved.ok) return { status: "error", reason: saved.reason };
  setDesktopLocale(value);
  return { status: "ok", locale: value };
});
// 스모크 모드에서 스크린샷을 요청하면 숨긴 창은 캡처할 수 없으므로 창을 잠깐 띄운다.
const screenshot = process.env["OPENHUB_SCREENSHOT"] || undefined;
/** 스모크 설치(TASK-036): --smoke일 때만. 대상 프로젝트는 임시 복사본이고 fake probe·executor·자동 확인 대화상자를 쓴다. */
const smokeInstall = smoke ? process.env["OPENHUB_SMOKE_INSTALL"] || undefined : undefined;
/** 스모크 설치에서 Client 선택 화면에 체크할 Client(쉼표 목록, v0.2.0 P0-3 PR C). 없으면 기본 선택 그대로. */
const smokeInstallClients = smokeInstall === undefined || !process.env["OPENHUB_SMOKE_INSTALL_CLIENTS"] ? undefined : process.env["OPENHUB_SMOKE_INSTALL_CLIENTS"].split(",").map((s) => s.trim()).filter((s) => s !== "");
/** 스모크 경쟁 조건(v0.2.0 P0-3 PR C 보완): 먼저 이 Client로 계획을 요청하고 응답 전에 OPENHUB_SMOKE_INSTALL_CLIENTS로 바꾼다. */
const smokeInstallRaceFirst = smokeInstallClients === undefined || !process.env["OPENHUB_SMOKE_INSTALL_RACE"] ? undefined : process.env["OPENHUB_SMOKE_INSTALL_RACE"].split(",").map((s) => s.trim()).filter((s) => s !== "");
/** 스모크 설치 범위(v0.2.0 범위별 설치): "user"면 Client 선택 화면에서 User를 누른다. 사용자 설정은 임시 복사본 옆 임시 home에 쓴다. */
const smokeInstallScope = smokeInstall === undefined ? undefined : process.env["OPENHUB_SMOKE_INSTALL_SCOPE"] === "user" ? "user" : undefined;
/** 스모크에서 [프로젝트 선택] 대신 분석할 폴더(TASK-015). 스모크 설치면 임시 복사본을 쓴다. */
const smokeProjectSource = process.env["OPENHUB_SMOKE_PROJECT"] || undefined;
const smokeProject =
  smokeProjectSource === undefined || smokeInstall === undefined
    ? smokeProjectSource
    : (() => {
        const copy = path.join(mkdtempSync(path.join(os.tmpdir(), "openhub-smoke-install-")), "project");
        cpSync(smokeProjectSource, copy, { recursive: true });
        return copy;
      })();
/**
 * 배포 경로(TASK-071, D-036). Registry: OPENHUB_REGISTRY > 패키지 리소스(설치본 resourcesPath/registry,
 * 개발 실행은 build.mjs가 만든 <app>/resources/registry). metadata: OPENHUB_METADATA > ~/.openhub/cache/metadata.json
 * (손상 시 경고 후 무시) > 포함 snapshot. repository root를 가정하지 않는다.
 */
const resourceRegistry = app.isPackaged ? path.join(process.resourcesPath, "registry") : path.join(app.getAppPath(), "resources", "registry");
const registryDir = resolveRegistryDir({ env: process.env[REGISTRY_ENV], resource: resourceRegistry, fallback: path.resolve(process.cwd(), "registry") }).dir;
const metadataChoice = resolveMetadataFileSync({ explicit: process.env[METADATA_ENV], homeDir: os.homedir(), registryDir });
for (const warning of metadataChoice.warnings) process.stderr.write(tr("main.warning", { message: warning }) + "\n");
// 고를 metadata가 없으면 없는 경로를 넘겨 화면이 "metadata 없음"을 보이게 한다.
const metadataFile = metadataChoice.file ?? path.join(registryDir, BUNDLED_METADATA_SNAPSHOT);

ipcMain.handle("registry:list", () => buildRegistryView(registryDir, metadataFile));
/** FOR YOU(TASK-026): 대화상자로 분석한 Profile을 기억해 추천에만 쓴다. */
const recommendSession = new RecommendSession();
/** 설치(TASK-036): 고른 폴더를 기억하고 FOR YOU 추천 목록의 toolId만 계획·실행한다. 최종 승인은 네이티브 대화상자다. */
const installSession = new InstallSession();
/** 스모크 설치·update의 가짜 npm 캐시(임시 프로젝트 복사본 옆). npx Prepare가 이 아래에 캐시 항목을 만든다. */
const smokeNpmCache = smokeInstall === undefined || smokeProject === undefined ? undefined : path.join(path.dirname(smokeProject), "npm-cache");
const smokeDeps = smokeInstall === undefined ? undefined : smokeInstallDeps(smokeNpmCache);
/**
 * 스모크 사용자 범위(v0.2.0 P0-3 C2): --smoke + OPENHUB_SMOKE_USER_SCOPE(toolId) + OPENHUB_SMOKE_HOME(빈 임시 home) + OPENHUB_SMOKE_PROJECT일 때만.
 * 설치·Repair·Adopt 스모크와 함께 쓰지 않는다. 실제 창에서 Client·사용자 범위 선택 → 설치 → INSTALLED 사용자 범위 → Health → (main이 사용자
 * tool config를 지워 손상) → Repair → Health를 클릭으로 지난다. 가짜 npm(npx Prepare 캐시 계약)·가짜 Health·자동 확인 대화상자(제목·본문 기록).
 */
const smokeUserScopeTool = smoke && smokeInstall === undefined ? process.env["OPENHUB_SMOKE_USER_SCOPE"] || undefined : undefined;
const smokeUserScopeHome = smokeUserScopeTool === undefined ? undefined : process.env["OPENHUB_SMOKE_HOME"] || undefined;
const smokeUserScopeClients = (process.env["OPENHUB_SMOKE_INSTALL_CLIENTS"] || "codex").split(",").map((s) => s.trim()).filter((s) => s !== "");
const smokeUserScopeDialogs: { title: string; detail: string }[] = [];
let smokeUserScopeFailNext = 0;
const smokeUserScope =
  smokeUserScopeHome === undefined
    ? undefined
    : Object.assign(smokeRepairDeps(path.join(smokeUserScopeHome, "npm-cache")), {
        recordingDialog: {
          showMessageBox: async (options: { title: string; detail: string }) => {
            smokeUserScopeDialogs.push({ title: options.title, detail: options.detail });
            return { response: 1 };
          },
        },
      });
/** 스모크 사용자 범위의 프로젝트 이동: OPENHUB_SMOKE_PROJECT_B가 있으면 두 번째 [프로젝트 선택]부터 그 폴더를 고른다. */
const smokeProjectB = smokeUserScopeTool === undefined ? undefined : process.env["OPENHUB_SMOKE_PROJECT_B"] || undefined;
let smokePicks = 0;
const smokePicker = smokeProject === undefined ? undefined : smokeProjectB === undefined ? fixedDirectory(smokeProject) : async () => (smokePicks++ === 0 ? smokeProject : smokeProjectB);
registerProjectScan(recommendSession.observe(ipcMain), installSession.trackPicker(smokePicker ?? electronDirectoryPicker(dialog)));
registerProjectRecommend(ipcMain, recommendSession, { registryDir, metadataFile, platform: process.platform });
registerInstall(ipcMain, installSession, {
  registryDir,
  metadataFile,
  platform: process.platform,
  homeDir: smokeProject !== undefined && smokeInstall !== undefined ? path.dirname(smokeProject) : os.homedir(),
  recommend: recommendSession,
  dialog: smokeDeps?.dialog ?? { showMessageBox: (options) => dialog.showMessageBox(options) },
  ...(smokeDeps === undefined ? {} : { probe: smokeDeps.probe, spawner: smokeDeps.spawner }),
  ...(smokeUserScope === undefined || smokeUserScopeHome === undefined ? {} : { homeDir: smokeUserScopeHome, dialog: smokeUserScope.recordingDialog, probe: smokeInstallDeps().probe, spawner: smokeUserScope.spawner }),
});
/**
 * Lifecycle(TASK-046): INSTALLED 카드. 고른 프로젝트의 Version State만 다루고 최종 승인은 네이티브 대화상자다.
 * 스모크 업데이트는 --smoke + 스모크 설치가 켜졌을 때만이며 fake resolver·Health·executor·자동 확인 대화상자를 쓴다.
 */
const smokeUpdate = smokeInstall === undefined ? undefined : process.env["OPENHUB_SMOKE_UPDATE"] || undefined;
const smokeLifecycle = smokeUpdate === undefined || smokeNpmCache === undefined ? undefined : smokeLifecycleDeps(smokeNpmCache);
/** 스모크 rollback(v0.2.0): --smoke + 스모크 update + OPENHUB_SMOKE_ROLLBACK=1이면 update 뒤 [롤백] → [Health Check]까지 클릭으로 지난다. */
const smokeRollback = smokeUpdate !== undefined && process.env["OPENHUB_SMOKE_ROLLBACK"] === "1";
/**
 * 스모크 정확한 버전 Update(v0.2.0 RC 선택 A): --smoke + 스모크 update + OPENHUB_SMOKE_UPDATE_VERSIONS="V1,V2"이면 버전 없는 update 대신
 * INSTALLED의 목표 버전 입력 → [업데이트 계획] → 승인 → 실행을 버전마다 클릭으로 지난다(먼저 형식이 틀린 값이 거부되는지 본다).
 */
const smokeUpdateVersions = smokeUpdate === undefined || !process.env["OPENHUB_SMOKE_UPDATE_VERSIONS"] ? undefined : process.env["OPENHUB_SMOKE_UPDATE_VERSIONS"].split(",").map((s) => s.trim()).filter((s) => s !== "");
/**
 * 스모크 Repair(v0.2.0 P0-3): --smoke + OPENHUB_SMOKE_REPAIR(toolId) + OPENHUB_SMOKE_HOME(테스트가 미리 설치·손상시킨 home)일 때만.
 * 설치 스모크와 함께 쓰지 않는다. 가짜 npm(cache 항목만)·가짜 Health·자동 확인 대화상자를 쓴다.
 */
const smokeRepairTool = smoke && smokeInstall === undefined ? process.env["OPENHUB_SMOKE_REPAIR"] || undefined : undefined;
const smokeRepairHome = smokeRepairTool === undefined ? undefined : process.env["OPENHUB_SMOKE_HOME"] || undefined;
const smokeRepair = smokeRepairHome === undefined ? undefined : smokeRepairDeps(path.join(smokeRepairHome, "npm-cache"));
/**
 * 스모크 Adopt·Benchmark(v0.2.0 P0-3 PR B): --smoke + OPENHUB_SMOKE_ADOPT=1 + OPENHUB_SMOKE_HOME(빈 임시 home)일 때만. 설치·Repair 스모크와
 * 함께 쓰지 않는다. 가짜 MCP 서버·자동 확인 대화상자(내용 기록)를 쓴다.
 */
const smokeAdoptHome = smoke && smokeInstall === undefined && smokeRepairTool === undefined && process.env["OPENHUB_SMOKE_ADOPT"] === "1" ? process.env["OPENHUB_SMOKE_HOME"] || undefined : undefined;
const smokeAdopt = smokeAdoptHome === undefined ? undefined : smokeAdoptDeps();
registerLifecycle(ipcMain, new LifecycleSession(() => installSession.projectDir), {
  registryDir,
  platform: process.platform,
  homeDir: smokeProject !== undefined && smokeInstall !== undefined ? path.dirname(smokeProject) : os.homedir(),
  dialog: smokeLifecycle?.dialog ?? { showMessageBox: (options) => dialog.showMessageBox(options) },
  ...(smokeLifecycle === undefined || smokeDeps === undefined ? {} : { fetch: smokeLifecycle.fetch, runHealth: smokeLifecycle.runHealth, spawner: smokeLifecycle.spawner, probe: smokeDeps.probe }),
  // 스모크 Repair(--smoke + OPENHUB_SMOKE_REPAIR + OPENHUB_SMOKE_HOME일 때만): 준비된 home·자동 확인·가짜 npm·가짜 Health.
  ...(smokeRepair === undefined || smokeRepairHome === undefined ? {} : { homeDir: smokeRepairHome, dialog: smokeRepair.dialog, runHealth: smokeRepair.runHealth, spawner: smokeRepair.spawner, probe: smokeInstallDeps().probe }),
  // 스모크 Adopt(--smoke + OPENHUB_SMOKE_ADOPT + OPENHUB_SMOKE_HOME일 때만): INSTALLED 목록이 같은 임시 home의 Version State를 읽는다.
  ...(smokeAdoptHome === undefined ? {} : { homeDir: smokeAdoptHome }),
  // 스모크 사용자 범위(--smoke + OPENHUB_SMOKE_USER_SCOPE + OPENHUB_SMOKE_HOME일 때만): 같은 임시 home·가짜 npm·가짜 Health·기록하는 대화상자.
  ...(smokeUserScope === undefined || smokeUserScopeHome === undefined
    ? {}
    : {
        homeDir: smokeUserScopeHome,
        dialog: smokeUserScope.recordingDialog,
        // 스모크 Health 실패 주입(가짜 Health): smokeUserScopeFailNext만큼 unhealthy를 돌려준다(실제 MCP Health가 아니다).
        runHealth: (async (verified, ...rest) => {
          if (smokeUserScopeFailNext <= 0) return smokeUserScope.runHealth!(verified, ...rest);
          smokeUserScopeFailNext -= 1;
          smokeUserScope.healthRuns += 1;
          return { ok: true, result: { status: "unhealthy", reason: null, toolCount: null, environmentUnverified: false, terminated: true, excerpt: null } };
        }) as typeof smokeUserScope.runHealth,
        spawner: smokeUserScope.spawner,
        probe: smokeInstallDeps().probe,
      }),
});

/**
 * Release·Impact·Pinokio Preview(TASK-057). 버튼을 눌렀을 때만 network(GitHub 비인증), timer·polling 없음, 실행 채널 없음.
 * 스모크 release는 --smoke + 스모크 업데이트가 켜졌을 때만이며 가짜 registry·GitHub 응답을 쓴다.
 */
const smokeReleaseTool = smokeUpdate === undefined ? undefined : process.env["OPENHUB_SMOKE_RELEASE"] || undefined;
const smokeRelease = smokeReleaseTool === undefined ? undefined : smokeReleaseDeps();
const releaseSession = new LifecycleSession(() => installSession.projectDir);
/** AI Summary(TASK-063): [릴리스 확인] 결과만 세션 메모리에 둔다. key는 [AI Summary]를 누른 순간에만 읽는다. */
const aiSession = new AiSummarySession();
registerAiSummary(ipcMain, aiSession, {
  readKey: () => readOpenAiApiKey(process.env),
  confirm: async (lines) =>
    (await dialog.showMessageBox({ type: "question", buttons: [tr("ai.dialog.send"), tr("dialog.cancel")], defaultId: 1, cancelId: 1, title: "AI Summary", message: tr("ai.dialog.message"), detail: lines.join("\n") })).response === 0,
});
registerRelease(ipcMain, releaseSession, {
  registryDir,
  homeDir: smokeProject !== undefined && smokeInstall !== undefined ? path.dirname(smokeProject) : os.homedir(),
  pinokioProbe: { pathEnv: process.env["PATH"] ?? "", platform: process.platform },
  onSnapshot: (id, snapshot, summary) => aiSession.remember(id, snapshot, summary),
  ...(smokeRelease === undefined || smokeDeps === undefined ? {} : { fetch: smokeRelease.fetch, probe: smokeDeps.probe }),
});

/**
 * DISCOVER·Tool 상세·Candidate 기여 패키지·Adopt·Benchmark(TASK-070). network·timer 없음.
 * 기여 패키지 폴더는 네이티브 폴더 선택으로만 정하고, Adopt·Benchmark 승인은 네이티브 대화상자에서만 만들어진다.
 * 스모크(--smoke)는 Candidate만 가짜 데이터로 바꾼다.
 */
const desktopHome = smokeProject !== undefined && smokeInstall !== undefined ? path.dirname(smokeProject) : os.homedir();
registerDiscover(ipcMain, {
  registryDir,
  metadataFile,
  candidatesDir: process.env["OPENHUB_CANDIDATES"] ?? path.resolve(process.cwd(), CANDIDATES_DIR),
  homeDir: desktopHome,
  platform: process.platform,
  recommend: recommendSession,
  projectDir: () => installSession.projectDir,
  chooseFolder: async () => {
    const picked = await dialog.showOpenDialog({ title: tr("candidate.folderDialog"), properties: ["openDirectory", "createDirectory"] });
    return picked.canceled ? null : (picked.filePaths[0] ?? null);
  },
  toolVersion: OPENHUB_CORE_VERSION,
  ...(smoke ? { candidates: async () => smokeDiscoverCandidates() } : {}),
});
registerAdopt(ipcMain, {
  registryDir,
  homeDir: smokeAdoptHome ?? desktopHome,
  platform: process.platform,
  projectDir: () => installSession.projectDir,
  dialog: smokeAdopt?.dialog ?? { showMessageBox: (options) => dialog.showMessageBox(options) },
  ...(smokeAdopt === undefined ? {} : { healthSpawner: smokeAdopt.healthSpawner, killTree: smokeAdopt.killTree }),
});

/** 앱 창. TASK-015에서 프로젝트 분석 스모크·스크린샷 대기를, TASK-026에서 FOR YOU 추천 대기를 더했다(파일의 셸 자체는 REQ-005). */
async function createWindow(): Promise<void> {
  const win = new BrowserWindow({
    width: 1120,
    height: 780,
    title: "OpenHub AI",
    show: !smoke || screenshot !== undefined,
    backgroundColor: "#0f1115",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  await win.loadFile(path.join(__dirname, "../renderer/index.html"));

  if (smoke) {
    // 화면이 Registry를 실제로 그렸는지 확인하고 종료한다(AC-007-01 실행 검증).
    try {
      const count = (await win.webContents.executeJavaScript("window.__openhubReady")) as number;
      // 프로젝트를 고르기 전 onboarding 카드(TASK-070).
      const onboarding = (await win.webContents.executeJavaScript("window.__openhubOnboarding()")) as { visible: boolean; steps: number };
      const project = smokeProject === undefined ? undefined : await runProjectSmoke(win.webContents);
      const recommendations = project === undefined ? undefined : ((await win.webContents.executeJavaScript("window.__openhubRecommend()")) as number);
      // 추천 진단(v0.2.0 C3): FOR YOU 화면에 실제로 그려진 진단·검증 문장을 기록한다.
      const forYou = recommendations === undefined ? undefined : ((await win.webContents.executeJavaScript("window.__openhubForYouDiagnosis()")) as { status: string; emptyReason: string; lines: string[]; verification: string[] });
      const install =
        smokeInstall === undefined || recommendations === undefined
          ? undefined
          : ((await win.webContents.executeJavaScript(
              "window.__openhubInstall(" +
                JSON.stringify(smokeInstall) +
                ", " +
                JSON.stringify(smokeInstallClients ?? null) +
                ", " +
                (smokeInstallRaceFirst === undefined ? "null" : JSON.stringify({ first: smokeInstallRaceFirst })) +
                ", " +
                JSON.stringify(smokeInstallScope ?? null) +
                ")",
            )) as { status: string; stages: string[]; choices?: unknown[]; targets?: string[]; configChanges?: string[] });
      // 스모크 설치 뒤 임시 복사본(프로젝트·임시 home)의 Client 설정 파일 내용(다른 Client 설정 보존 확인용, 테스트 출력 전용).
      const configFiles =
        install === undefined || smokeProject === undefined
          ? undefined
          : Object.fromEntries(
              await Promise.all(
                [
                  ["project/.mcp.json", path.join(smokeProject, ".mcp.json")],
                  ["project/.cursor/mcp.json", path.join(smokeProject, ".cursor", "mcp.json")],
                  ["project/.codex/config.toml", path.join(smokeProject, ".codex", "config.toml")],
                  ["user/.cursor/mcp.json", path.join(path.dirname(smokeProject), ".cursor", "mcp.json")],
                  ["user/.codex/config.toml", path.join(path.dirname(smokeProject), ".codex", "config.toml")],
                ].map(async ([name, file]) => [name, await readFile(file!, "utf8").catch(() => null)] as const),
              ),
            );
      type ExactStep = { status: string; outcome?: string; message?: string; plan?: { from: string | null; to: string | null }; requirements?: string[]; after?: string[] };
      const exact =
        smokeUpdateVersions === undefined || smokeUpdate === undefined || install === undefined
          ? undefined
          : {
              invalid: (await win.webContents.executeJavaScript("window.__openhubLifecycleUpdateTo(" + JSON.stringify(smokeUpdate) + ', "latest", false)')) as ExactStep,
              steps: [] as { version: string; result: ExactStep }[],
            };
      for (const version of exact === undefined ? [] : smokeUpdateVersions!) {
        exact!.steps.push({ version, result: (await win.webContents.executeJavaScript("window.__openhubLifecycleUpdateTo(" + JSON.stringify(smokeUpdate) + ", " + JSON.stringify(version) + ")")) as ExactStep });
      }
      const update =
        smokeUpdate === undefined || install === undefined || exact !== undefined
          ? undefined
          : ((await win.webContents.executeJavaScript("window.__openhubLifecycle(" + JSON.stringify(smokeUpdate) + ")")) as { status: string; health: string[]; rollbackButton: boolean });
      const updated = update?.status === "updated" || (exact !== undefined && exact.steps.length > 0 && exact.steps.every((s) => s.result.status === "updated"));
      // 스모크 rollback(v0.2.0): update 뒤 [이전 버전으로 롤백] → 승인 → 결과, 이어서 [Health Check] → 승인 → 결과(클릭으로).
      type RunOp = { status: string; outcome?: string; requirements?: string[]; lines?: string[]; after?: string[] };
      const rollbackChain =
        !smokeRollback || !updated
          ? undefined
          : {
              rollback: (await win.webContents.executeJavaScript("window.__openhubLifecycleRun(" + JSON.stringify(smokeUpdate) + ', "rollback")')) as RunOp,
              health: (await win.webContents.executeJavaScript("window.__openhubLifecycleRun(" + JSON.stringify(smokeUpdate) + ', "health")')) as RunOp,
            };
      const repair =
        smokeRepairTool === undefined || smokeRepair === undefined || project === undefined
          ? undefined
          : ((await win.webContents.executeJavaScript("window.__openhubRepair(" + JSON.stringify(smokeRepairTool) + ")")) as { status: string; outcome?: string; health?: string[]; preview?: number; boxes?: number; confirmDisabledBeforeChecks?: boolean; after?: string[] });
      // 스모크 Adopt·Benchmark(v0.2.0 P0-3 PR B): 화면의 [Adopt]·[Benchmark] 버튼 click → 네이티브 대화상자 자리(자동 확인, 내용 기록) → 결과.
      const adopt =
        smokeAdopt === undefined || project === undefined
          ? undefined
          : ((await win.webContents.executeJavaScript("window.__openhubAdopt()")) as { status: string; preview: string; adoptResult: string; benchmarkResult: string });
      // 스모크 사용자 범위(v0.2.0 P0-3 C2): 설치(사용자 범위) → Health → 손상(main이 사용자 tool config 삭제) → Repair(가짜 Health 실패 → 보상)
      // → Repair → Health → [프로젝트 선택] 다시 클릭(프로젝트 이동) → 같은 사용자 항목 Health → [사용자 범위 숨기기] 클릭.
      type LifeOp = { status: string; outcome?: string; requirements?: string[]; after?: string[] };
      const userScope =
        smokeUserScopeTool === undefined || smokeUserScopeHome === undefined || project === undefined
          ? undefined
          : await (async () => {
              const js = (code: string) => win.webContents.executeJavaScript(code);
              const install = (await js("window.__openhubInstall(" + JSON.stringify(smokeUserScopeTool) + ", " + JSON.stringify(smokeUserScopeClients) + ", null, \"user\")")) as { status: string; targets?: string[]; configChanges?: string[] };
              const health1 = (await js("window.__openhubLifecycleOp(" + JSON.stringify(smokeUserScopeTool) + ", \"user\", \"health\")")) as LifeOp;
              const loc = toolConfigLocation({ homeDir: smokeUserScopeHome, scope: "user", toolId: smokeUserScopeTool });
              const corrupted = loc === null ? false : await unlink(loc.file).then(() => true, () => false);
              smokeUserScopeFailNext = 1;
              const repairFailed = (await js("window.__openhubLifecycleOp(" + JSON.stringify(smokeUserScopeTool) + ", \"user\", \"repair\")")) as LifeOp;
              const compensated = loc === null ? false : await stat(loc.file).then(() => false, () => true);
              const repair = (await js("window.__openhubLifecycleOp(" + JSON.stringify(smokeUserScopeTool) + ", \"user\", \"repair\")")) as LifeOp;
              const health2 = (await js("window.__openhubLifecycleOp(" + JSON.stringify(smokeUserScopeTool) + ", \"user\", \"health\")")) as LifeOp;
              let moved: { project: number; health: LifeOp } | undefined;
              if (smokeProjectB !== undefined) {
                const project2 = (await js("window.__openhubReselectProject()")) as number;
                moved = { project: project2, health: (await js("window.__openhubLifecycleOp(" + JSON.stringify(smokeUserScopeTool) + ", \"user\", \"health\")")) as LifeOp };
              }
              const hidden = (await js("window.__openhubUserScopeOff(" + JSON.stringify(smokeUserScopeTool) + ")")) as { pressed: string; entries: { state: string; buttons: number; warning: string }[] };
              return { install, health1, corrupted, repairFailed, compensated, repair, health2, moved, hidden, dialogs: smokeUserScopeDialogs, healthRuns: smokeUserScope?.healthRuns ?? 0 };
            })();
      const release =
        smokeReleaseTool === undefined || update === undefined
          ? undefined
          : ((await win.webContents.executeJavaScript("window.__openhubRelease(" + JSON.stringify(smokeReleaseTool) + ")")) as { status: string; impact: string; notesText: boolean; innerHtml: number });
      // DISCOVER 네 탭·Candidate·Tool 상세(TASK-070, 가짜 Candidate).
      const discover = (await win.webContents.executeJavaScript("window.__openhubDiscover()")) as { status: string; tabs: number; candidates: number; forbiddenButtons: number; badges: boolean; untrustedText: boolean; trendClean: boolean; firstTool: string | null; innerHtml: number };
      const detail =
        discover.firstTool === null ? undefined : ((await win.webContents.executeJavaScript("window.__openhubDetail(" + JSON.stringify(discover.firstTool) + ")")) as { status: string; fields: string[]; install: boolean });
      // 다국어(v0.2.0 P0-3 PR B): 화면 언어를 읽고, OPENHUB_SMOKE_I18N_SWITCH가 있으면 화면의 언어 선택을 실제로 바꿔 다시 읽는다.
      type I18nSmoke = { locale: string; htmlLang: string; selectValue: string; texts: Record<string, string>; hangul: number; missingKeys: string[] };
      const i18n: { before: I18nSmoke; after?: I18nSmoke } = { before: (await win.webContents.executeJavaScript("window.__openhubI18n()")) as I18nSmoke };
      if (smokeI18nSwitch !== undefined) {
        const reloaded = new Promise<void>((resolve) => win.webContents.once("did-finish-load", () => resolve()));
        await win.webContents.executeJavaScript("window.__openhubSetLanguage(" + JSON.stringify(smokeI18nSwitch) + ")");
        await reloaded;
        await win.webContents.executeJavaScript("window.__openhubReady");
        i18n.after = (await win.webContents.executeJavaScript("window.__openhubI18n()")) as I18nSmoke;
      }
      if (screenshot !== undefined) {
        // DOM 갱신 뒤 실제로 그려진 프레임을 캡처한다. 문서 스크린샷이 화면 위쪽부터 보이도록 맨 위로 스크롤한다.
        await win.webContents.executeJavaScript("window.scrollTo(0, 0)");
        await win.webContents.executeJavaScript("new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))");
        await writeFile(screenshot, (await win.webContents.capturePage()).toPNG());
      }
      const installOk = install === undefined || install.status === "succeeded";
      const updateOk = update === undefined || update.status === "updated";
      const exactOk =
        exact === undefined ||
        (exact.invalid.status === "not-executable" &&
          exact.steps.length === smokeUpdateVersions!.length &&
          exact.steps.every((s) => s.result.status === "updated" && s.result.outcome === "succeeded" && (s.result.plan?.to ?? "").endsWith("@" + s.version)));
      const rollbackOk = !smokeRollback || (rollbackChain !== undefined && rollbackChain.rollback.status === "rolled-back" && rollbackChain.health.status === "health-checked");
      const repairOk = repair === undefined || (repair.status === "repaired" && repair.outcome === "succeeded" && (repair.after ?? []).length > 0 && (repair.after ?? []).every((s) => s === "state-consistent"));
      const adoptOk = adopt === undefined || (adopt.status === "ok" && (smokeAdopt?.dialogs.length ?? 0) === 2 && (smokeAdopt?.spawns ?? 0) === 6);
      const userScopeOk =
        userScope === undefined ||
        (userScope.install.status === "succeeded" &&
          userScope.health1.status === "health-checked" &&
          userScope.corrupted &&
          userScope.repairFailed.outcome === "failed" &&
          userScope.compensated &&
          userScope.repair.status === "repaired" &&
          userScope.health2.status === "health-checked" &&
          (userScope.moved === undefined || userScope.moved.health.status === "health-checked") &&
          userScope.hidden.pressed === "false" &&
          userScope.hidden.entries.every((e) => e.state === "not-inspected" && e.buttons === 0));
      const i18nOk = i18n.before.missingKeys.length === 0 && (i18n.after === undefined || (i18n.after.locale === smokeI18nSwitch && i18n.after.missingKeys.length === 0));
      const releaseOk = release === undefined || (release.status === "ok" && release.notesText && release.innerHtml === 0 && (smokeRelease?.authorized ?? 0) === 0);
      const onboardingOk = onboarding.visible && onboarding.steps === 7;
      const discoverOk = discover.status === "ok" && discover.tabs === 4 && discover.candidates > 0 && discover.forbiddenButtons === 0 && discover.badges && discover.untrustedText && discover.trendClean && discover.innerHtml === 0 && detail !== undefined && detail.status === "ok";
      // 실행 중 runtime 정체성(TASK-072, D-037): 패키징된 앱에서 실제 Electron·Chromium 버전과 OpenHub 버전을 남긴다.
      const runtime = { electronVersion: process.versions.electron ?? null, chromeVersion: process.versions.chrome ?? null, openhubVersion: OPENHUB_CORE_VERSION };
      process.stdout.write(
        `OPENHUB_SMOKE ${JSON.stringify({
          tools: count,
          runtime,
          onboarding,
          ...(project === undefined ? {} : { project, recommendations, forYou }),
          ...(install === undefined ? {} : { install: { ...install, spawned: smokeDeps?.spawned.length ?? 0, dialogs: smokeDeps?.dialogs ?? 0, configFiles } }),
          ...(update === undefined ? {} : { update: { ...update, fetched: smokeLifecycle?.fetched.length ?? 0, healthRuns: smokeLifecycle?.healthRuns ?? 0, spawned: smokeLifecycle?.spawned.length ?? 0, dialogs: smokeLifecycle?.dialogs ?? 0 } }),
          ...(exact === undefined ? {} : { exact: { ...exact, fetched: smokeLifecycle?.fetched.length ?? 0, healthRuns: smokeLifecycle?.healthRuns ?? 0, dialogs: smokeLifecycle?.dialogs ?? 0 } }),
          ...(rollbackChain === undefined ? {} : { rollbackChain: { ...rollbackChain, healthRuns: smokeLifecycle?.healthRuns ?? 0, npmCalls: (smokeLifecycle?.spawned ?? []).map((c) => c.slice(1).join(" ")), installNpmCalls: (smokeDeps?.spawned ?? []).map((c) => c.slice(1).join(" ")) } }),
          ...(repair === undefined ? {} : { repair: { ...repair, npmCalls: smokeRepair?.npmCalls.length ?? 0, healthRuns: smokeRepair?.healthRuns ?? 0, dialogs: smokeRepair?.dialogs ?? [] } }),
          ...(adopt === undefined ? {} : { adopt: { ...adopt, spawns: smokeAdopt?.spawns ?? 0, dialogs: smokeAdopt?.dialogs ?? [] } }),
          ...(userScope === undefined ? {} : { userScope }),
          ...(release === undefined ? {} : { release: { ...release, fetched: smokeRelease?.fetched.length ?? 0, authorized: smokeRelease?.authorized ?? 0 } }),
          discover,
          ...(detail === undefined ? {} : { detail }),
          i18n,
        })}\n`,
        // pipe로 받는 쪽(release dry-run)이 결과 줄을 놓치지 않도록 stdout에 다 쓴 뒤에 종료한다(TASK-072, Linux AppImage에서 확인).
        () => app.exit(count > 0 && (project === undefined || project > 0) && repairOk && adoptOk && userScopeOk && rollbackOk && exactOk && i18nOk && installOk && updateOk && releaseOk && onboardingOk && discoverOk ? 0 : 1),
      );
    } catch (error) {
      process.stderr.write(`OPENHUB_SMOKE_FAILED ${String(error)}\n`);
      app.exit(1);
    }
  }
}

app.whenReady().then(async () => {
  await initDesktopLocale();
  await createWindow();
}, (error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  app.exit(1);
});
app.on("window-all-closed", () => app.quit());
