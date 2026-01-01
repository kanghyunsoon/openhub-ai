import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { CATEGORIES, parseManifest, type Category, type Manifest } from "../manifest/index";
import { checkRecommendationMetadata } from "./recommendation-checks";

/** Registry에 적재된 Manifest 하나. `file`은 Registry 루트 기준 POSIX 경로다. */
export interface RegistryEntry {
  file: string;
  directory: Category;
  manifest: Manifest;
}

/** Registry 검증 오류. `path`는 Manifest 안의 필드 경로이며 파일 단위 오류는 빈 문자열이다. */
export interface RegistryIssue {
  file: string;
  path: string;
  message: string;
}

export interface RegistryLoadResult {
  entries: RegistryEntry[];
  issues: RegistryIssue[];
}

const MANIFEST_EXT = /\.ya?ml$/u;
/** 최상위의 README 같은 문서와 Catalog Metadata(catalog.yaml, D-035), 배포 패키지의 포함 metadata snapshot(D-036)은 Manifest가 아니다. */
const IGNORED = /\.md$|^catalog\.yaml$|^metadata\.snapshot\.json$/u;
const isCategory = (name: string): name is Category => (CATEGORIES as readonly string[]).includes(name);

/**
 * `<root>/<category>/<name>.yaml` 구조의 Registry를 읽고 검증한다.
 * 잘못된 Manifest는 entries에 넣지 않고 issues로만 보고한다(예외를 던지지 않는다).
 */
export async function loadRegistry(root: string): Promise<RegistryLoadResult> {
  const issues: RegistryIssue[] = [];
  const candidates: RegistryEntry[] = [];

  let top;
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch (error) {
    return { entries: [], issues: [{ file: ".", path: "", message: `Registry 디렉터리를 읽을 수 없습니다: ${String(error)}` }] };
  }

  for (const dirent of top.sort((a, b) => a.name.localeCompare(b.name))) {
    if (dirent.isFile()) {
      if (!IGNORED.test(dirent.name)) {
        issues.push({ file: dirent.name, path: "", message: "Manifest는 registry/<category>/<name>.yaml 위치에 있어야 합니다" });
      }
      continue;
    }
    if (!dirent.isDirectory()) continue;
    if (!isCategory(dirent.name)) {
      issues.push({ file: dirent.name, path: "", message: `알 수 없는 카테고리 디렉터리입니다. 허용: ${CATEGORIES.join(", ")}` });
      continue;
    }
    const category = dirent.name;
    const children = await readdir(path.join(root, category), { withFileTypes: true });
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      const file = `${category}/${child.name}`;
      if (child.isDirectory()) {
        issues.push({ file, path: "", message: "카테고리 아래에 하위 디렉터리를 둘 수 없습니다" });
        continue;
      }
      if (IGNORED.test(child.name)) continue;
      if (!MANIFEST_EXT.test(child.name)) {
        issues.push({ file, path: "", message: "Manifest 파일은 .yaml 또는 .yml이어야 합니다" });
        continue;
      }
      const text = await readFile(path.join(root, category, child.name), "utf8");
      const parsed = parseManifest(text);
      if (!parsed.ok) {
        for (const issue of parsed.issues) issues.push({ file, ...issue });
        continue;
      }
      const { manifest } = parsed;
      const stem = child.name.replace(MANIFEST_EXT, "");
      let valid = true;
      if (stem !== manifest.name) {
        issues.push({ file, path: "name", message: `파일 이름(${stem})과 name(${manifest.name})이 일치해야 합니다` });
        valid = false;
      }
      if (!manifest.category.includes(category)) {
        issues.push({ file, path: "category", message: `디렉터리 카테고리 '${category}'가 category 목록에 있어야 합니다` });
        valid = false;
      }
      if (valid) candidates.push({ file, directory: category, manifest });
    }
  }

  const seen = new Map<string, string>();
  const entries: RegistryEntry[] = [];
  for (const entry of candidates) {
    const first = seen.get(entry.manifest.name);
    if (first !== undefined) {
      issues.push({ file: entry.file, path: "name", message: `Tool 이름 '${entry.manifest.name}'이 ${first}와 중복됩니다` });
      continue;
    }
    seen.set(entry.manifest.name, entry.file);
    entries.push(entry);
  }
  entries.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  const checked = checkRecommendationMetadata(entries);
  return { entries: checked.entries.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name)), issues: [...issues, ...checked.issues] };
}

/** 사람이 읽는 한 줄 형식: `mcp/foo.yaml: install.preferredAdapter: 메시지` */
export function formatRegistryIssue(issue: RegistryIssue): string {
  return issue.path === "" ? `${issue.file}: ${issue.message}` : `${issue.file}: ${issue.path}: ${issue.message}`;
}
