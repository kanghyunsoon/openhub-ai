import path from "node:path";
import { analyzeProject, type ProjectProfile } from "@openhub/core";

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
  | { status: "error"; code: string; message: string };

/** 분석할 폴더를 고르는 방법. 실제 앱은 OS 대화상자, 스모크·테스트는 고정 경로를 쓴다. */
export type DirectoryPicker = () => Promise<string | undefined>;

interface IpcMainLike {
  handle(channel: string, listener: (...args: unknown[]) => unknown): void;
}

interface DialogLike {
  showOpenDialog(options: { title: string; properties: ["openDirectory"] }): Promise<{ canceled: boolean; filePaths: string[] }>;
}

export function electronDirectoryPicker(dialog: DialogLike): DirectoryPicker {
  return async () => {
    const r = await dialog.showOpenDialog({ title: "분석할 프로젝트 폴더 선택", properties: ["openDirectory"] });
    return r.canceled ? undefined : r.filePaths[0];
  };
}

export function fixedDirectory(dir: string): DirectoryPicker {
  const resolved = path.resolve(dir);
  return async () => resolved;
}

export async function scanSelectedProject(pick: DirectoryPicker): Promise<ProjectScanResponse> {
  const dir = await pick();
  if (dir === undefined) return { status: "canceled" };
  const result = await analyzeProject(dir);
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
