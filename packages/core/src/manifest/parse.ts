import { z } from "zod";
import { parseDocument } from "yaml";
import { manifestSchema, type Manifest } from "./schema";

/** 검증 오류 하나. `path`는 `install.fallback[0].adapter` 형식이고 문서 전체 오류는 빈 문자열이다. */
export interface ManifestIssue {
  path: string;
  message: string;
}

export type ManifestResult = { ok: true; manifest: Manifest } | { ok: false; issues: ManifestIssue[] };

const koreanErrors = z.locales.ko().localeError;

export function formatPath(path: readonly PropertyKey[]): string {
  let out = "";
  for (const key of path) {
    if (typeof key === "number") out += `[${key}]`;
    else out += out === "" ? String(key) : `.${String(key)}`;
  }
  return out;
}

/** 이미 객체로 읽은 데이터를 검증한다. 예외를 던지지 않는다. */
export function validateManifest(data: unknown): ManifestResult {
  const result = manifestSchema.safeParse(data, { error: koreanErrors });
  if (result.success) return { ok: true, manifest: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({ path: formatPath(issue.path), message: issue.message })),
  };
}

/** YAML 텍스트를 읽어 검증한다. YAML 문법 오류도 issue로 돌려준다. */
export function parseManifest(yamlText: string): ManifestResult {
  const doc = parseDocument(yamlText, { prettyErrors: false, uniqueKeys: true });
  if (doc.errors.length > 0) {
    return { ok: false, issues: doc.errors.map((e) => ({ path: "", message: `YAML 문법 오류: ${e.message}` })) };
  }
  return validateManifest(doc.toJS());
}
