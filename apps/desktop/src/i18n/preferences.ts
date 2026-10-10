import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { isLocale, type Locale } from "./index";

/**
 * Desktop 사용자 설정 파일(언어 선택). Electron userData 아래 preferences.json 하나만 쓴다(~/.openhub의 Version State·설정과 분리).
 * - 읽기: 없거나 깨졌거나 language가 en·ko가 아니면 저장값 없음으로 본다(파일은 건드리지 않는다).
 * - 쓰기: 기존의 다른 key는 그대로 두고 language만 바꾼다. 임시 파일 → rename(원자적). 기존 파일이 JSON object가 아니면 덮어쓰지 않고 실패한다.
 */
export const PREFERENCES_FILE = "preferences.json";

export async function readStoredLanguage(dir: string): Promise<Locale | null> {
  try {
    const doc = JSON.parse(await fs.readFile(path.join(dir, PREFERENCES_FILE), "utf8")) as unknown;
    const value = doc !== null && typeof doc === "object" && !Array.isArray(doc) ? (doc as Record<string, unknown>)["language"] : undefined;
    return isLocale(value) ? value : null;
  } catch {
    return null;
  }
}

export async function writeStoredLanguage(dir: string, language: Locale): Promise<{ ok: true } | { ok: false; reason: string }> {
  const file = path.join(dir, PREFERENCES_FILE);
  let doc: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { ok: false, reason: "preferences-not-object" };
    doc = parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") return { ok: false, reason: "preferences-unreadable" };
  }
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, "." + PREFERENCES_FILE + "." + randomBytes(6).toString("hex") + ".tmp");
  await fs.writeFile(temp, JSON.stringify({ ...doc, language }, null, 2) + "\n", { mode: 0o600 });
  await fs.rename(temp, file);
  return { ok: true };
}

