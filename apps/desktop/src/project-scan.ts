import path from "node:path";
import { analyzeProject, type ProjectProfile } from "@openhub/core";
import { tr } from "./i18n/index";

/**
 * Desktop 프로젝트 분석 연동(TASK-015).
 * - 분석 경로는 메인 프로세스의 폴더 선택 결과만 쓴다. 화면(renderer)이 보낸 인자는 무시한다.
 * - 분석은 Core analyzeProject가 하고, 여기서는 결과를 그대로 화면에 넘긴다(탐지 로직·Mock 없음).
 * - 사용자 범위 Host Probe는 CLI --include-host 전용이라(D-003) 여기서는 실행하지 않는다.
 */
export const PROJECT_SCAN_CHANNEL = "project:select-and-scan";

export type ProjectScanResponse =
  | { status: "ok"; profile: ProjectProfile }
  | { status: "canceled" }
  | { status: "superseded" }
  | { status: "error"; code: string; message: string };

/**
 * (v0.2.1) 프로젝트 선택 세대. InstallSession.trackPicker가 붙인다.
 * - begin: 선택을 시작할 때 세대 번호를 받는다(대화상자를 여는 것만으로는 현재 프로젝트를 바꾸지 않는다).
 * - picked: 폴더가 정해졌다. 더 늦게 시작한 선택이 이미 폴더를 정했으면 false(이 선택은 버린다). true면 분석이 끝날 때까지 현재 프로젝트가 없다.
 * - completed: 분석이 끝났다. 이 선택이 여전히 최신일 때만 경로와 Profile을 한 번에 확정하고 true를 돌려준다.
 */
export interface ProjectSelectionHooks {
  begin(): number;
  picked(generation: number, dir: string): boolean;
  completed(generation: number, dir: string, profile: ProjectProfile | null): boolean;
}

/** 분석할 폴더를 고르는 방법. 실제 앱은 OS 대화상자, 스모크·테스트는 고정 경로를 쓴다. */
export type DirectoryPicker = (() => Promise<string | undefined>) & { readonly selection?: ProjectSelectionHooks };

interface IpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
}

interface DialogLike {
  showOpenDialog(options: { title: string; properties: ["openDirectory"] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export function electronDirectoryPicker(dialog: DialogLike): DirectoryPicker {
  return async () => {
    const r = await dialog.showOpenDialog({ title: tr("project.dialogTitle"), properties: ["openDirectory"] });
    return r.canceled ? undefined : r.filePaths[0];
  };
}

export function fixedDirectory(dir: string): DirectoryPicker {
  const resolved = path.resolve(dir);
  return async () => resolved;
}

/**
 * 폴더 선택 → 분석. 선택 세대가 있으면(InstallSession.trackPicker) 늦게 끝난 이전 선택·분석은 superseded로 버리고 상태를 바꾸지 않는다.
 * 취소는 아무것도 바꾸지 않는다(기존 프로젝트 유지).
 */
export async function scanSelectedProject(pick: DirectoryPicker): Promise<ProjectScanResponse> {
  const hooks = pick.selection;
  const generation = hooks?.begin() ?? 0;
  const dir = await pick();
  if (dir === undefined) return { status: "canceled" };
  if (hooks !== undefined && !hooks.picked(generation, dir)) return { status: "superseded" };
  const result = await analyzeProject(dir);
  if (hooks !== undefined && !hooks.completed(generation, dir, result.ok ? result.profile : null)) return { status: "superseded" };
  return result.ok ? { status: "ok", profile: result.profile } : { status: "error", code: result.error.code, message: result.error.message };
}

/** IPC 핸들러 등록. 화면이 보낸 인자는 받지 않는다(임의 경로 분석 방지). */
export function registerProjectScan(ipcMain: IpcMainLike, pick: DirectoryPicker): void {
  ipcMain.handle(PROJECT_SCAN_CHANNEL, () => scanSelectedProject(pick));
}

interface WebContentsLike {
  executeJavaScript(code: string): Promise<unknown>;
}

/** 스모크: 화면의 [프로젝트 선택]과 같은 경로로 분석·렌더링하고 표시된 항목 수를 돌려준다. */
export async function runProjectSmoke(webContents: WebContentsLike): Promise<number> {
  return (await webContents.executeJavaScript("window.__openhubScanProject()")) as number;
}
