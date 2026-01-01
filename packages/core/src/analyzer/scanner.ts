import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { parse as parseToml } from "smol-toml";
import { parseDocument } from "yaml";
import type { ScanContext } from "./detector";
import type { AnalysisWarning } from "./profile";

/**
 * Safe Project Scanner(TASK-009).
 * - Root 밖은 읽지 않는다(모든 읽기에서 realpath 재확인).
 * - Root 밖을 가리키는 symlink·junction은 따라가지 않는다.
 * - 비밀 파일은 목록에서 빼고 내용을 읽지 않는다.
 * - 오류는 예외가 아니라 경고로 남기며, 경고에는 절대 경로나 파일 원문을 넣지 않는다.
 * - 프로세스 실행·네트워크 호출을 하지 않는다.
 */

export const DEFAULT_EXCLUDED_DIRECTORIES: readonly string[] = Object.freeze([
  ".git", "node_modules", "dist", "build", "target", "Library", "Temp", ".venv", "venv",
  "vendor", "out", "coverage", ".next", ".turbo", "__pycache__", "obj", ".gradle",
]);

export const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = Object.freeze([
  /^\.env$/u, /^\.env\..+/u, /\.pem$/iu, /\.key$/iu, /\.p12$/iu, /\.pfx$/iu,
  /^id_rsa/u, /^id_ed25519/u, /^\.npmrc$/u, /^\.pypirc$/u, /^\.netrc$/u,
]);

export interface ScanLimits {
  /** Root 아래로 들어갈 수 있는 최대 디렉터리 깊이 */
  maxDepth: number;
  /** 탐색할 최대 항목(파일·디렉터리) 수 */
  maxEntries: number;
  /** 읽을 수 있는 파일 최대 크기(바이트) */
  maxFileBytes: number;
}

export const DEFAULT_SCAN_LIMITS: Readonly<ScanLimits> = Object.freeze({ maxDepth: 8, maxEntries: 20_000, maxFileBytes: 1024 * 1024 });

export type ScanErrorCode = "root-not-found" | "root-not-directory" | "root-unreadable";
export type ScanResult = { ok: true; context: ProjectScanContext } | { ok: false; error: { code: ScanErrorCode; message: string } };

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((p) => p.test(name));
}

function isInside(realRoot: string, candidate: string): boolean {
  const rel = path.relative(realRoot, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

const errnoCode = (error: unknown): string =>
  typeof error === "object" && error !== null && "code" in error && typeof (error as { code: unknown }).code === "string"
    ? (error as { code: string }).code
    : "UNKNOWN";

export async function scanProject(root: string, options: { limits?: Partial<ScanLimits> } = {}): Promise<ScanResult> {
  const limits: ScanLimits = { ...DEFAULT_SCAN_LIMITS, ...options.limits };
  let realRoot: string;
  try {
    realRoot = await realpath(path.resolve(root));
    if (!(await stat(realRoot)).isDirectory()) {
      return { ok: false, error: { code: "root-not-directory", message: "지정한 경로는 디렉터리가 아닙니다" } };
    }
  } catch (error) {
    const code = errnoCode(error);
    return code === "ENOENT"
      ? { ok: false, error: { code: "root-not-found", message: "지정한 프로젝트 경로가 없습니다" } }
      : { ok: false, error: { code: "root-unreadable", message: `프로젝트 경로를 읽을 수 없습니다(${code})` } };
  }

  const warnings: AnalysisWarning[] = [];
  const files: string[] = [];
  const rootExcluded: string[] = [];
  const excluded = new Set(DEFAULT_EXCLUDED_DIRECTORIES);
  let entries = 0;
  let stopped = false;
  let depthWarned = false;

  const walk = async (dirRel: string, depth: number): Promise<void> => {
    if (stopped) return;
    let dirents;
    try {
      dirents = await readdir(dirRel === "" ? realRoot : path.join(realRoot, ...dirRel.split("/")), { withFileTypes: true });
    } catch (error) {
      warnings.push({ code: "read-failed", file: dirRel === "" ? "." : dirRel, message: `디렉터리를 읽을 수 없습니다(${errnoCode(error)})` });
      return;
    }
    dirents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const d of dirents) {
      if (++entries > limits.maxEntries) {
        stopped = true;
        warnings.push({ code: "scan-limit", message: `탐색 항목 상한(${limits.maxEntries}개)에 도달해 일부만 분석했습니다` });
        return;
      }
      const rel = dirRel === "" ? d.name : `${dirRel}/${d.name}`;
      if (excluded.has(d.name)) {
        if (depth === 0) rootExcluded.push(d.name);
        continue;
      }
      if (d.isSymbolicLink()) {
        const full = path.join(realRoot, ...rel.split("/"));
        try {
          const target = await realpath(full);
          if (!isInside(realRoot, target)) {
            warnings.push({ code: "symlink-outside-root", file: rel, message: "프로젝트 밖을 가리키는 링크라 따라가지 않았습니다" });
            continue;
          }
          const st = await stat(target);
          if (st.isFile() && !isSensitiveFileName(d.name)) files.push(rel);
          // 프로젝트 안을 가리키는 디렉터리 링크는 중복·순환을 피하려고 따라가지 않는다.
        } catch {
          warnings.push({ code: "symlink-broken", file: rel, message: "대상을 찾을 수 없는 링크입니다" });
        }
        continue;
      }
      if (d.isDirectory()) {
        if (depth + 1 > limits.maxDepth) {
          if (!depthWarned) {
            depthWarned = true;
            warnings.push({ code: "scan-limit", file: rel, message: `탐색 깊이 상한(${limits.maxDepth})을 넘는 디렉터리는 분석하지 않았습니다` });
          }
          continue;
        }
        await walk(rel, depth + 1);
        if (stopped) return;
        continue;
      }
      if (d.isFile() && !isSensitiveFileName(d.name)) files.push(rel);
    }
  };

  await walk("", 0);
  files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return { ok: true, context: new ProjectScanContext(realRoot, files, rootExcluded.sort(), warnings, limits) };
}

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  processEntities: false,
  htmlEntities: false,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
});

type Parser = "json" | "yaml" | "toml" | "xml";
const PARSE_LABEL: Record<Parser, string> = { json: "JSON", yaml: "YAML", toml: "TOML", xml: "XML" };

/** Detector에 넘기는 안전한 읽기 API. 결과는 캐시되어 같은 파일 경고가 중복되지 않는다. */
export class ProjectScanContext implements ScanContext {
  readonly files: readonly string[];
  readonly rootExcluded: readonly string[];
  readonly projectName: string;
  readonly #root: string;
  readonly #fileSet: ReadonlySet<string>;
  readonly #warnings: AnalysisWarning[];
  readonly #limits: ScanLimits;
  readonly #text = new Map<string, Promise<string | undefined>>();
  readonly #parsed = new Map<string, Promise<unknown>>();
  /** 읽기·해석에 실패한 파일. Detector별 partial 판정에 쓴다(경고 자체는 파일당 한 번만 남는다). */
  readonly #failed = new Set<string>();

  constructor(realRoot: string, files: string[], rootExcluded: string[], warnings: AnalysisWarning[], limits: ScanLimits) {
    this.#root = realRoot;
    this.files = Object.freeze([...files]);
    this.rootExcluded = Object.freeze([...rootExcluded]);
    this.projectName = path.basename(realRoot);
    this.#fileSet = new Set(files);
    this.#warnings = warnings;
    this.#limits = limits;
  }

  /** 지금까지 쌓인 경고(Scan + 읽기·파싱). */
  get warnings(): readonly AnalysisWarning[] {
    return [...this.#warnings];
  }

  /** 이 파일을 읽거나 해석하다 실패한 적이 있는가 */
  hasFailure(file: string): boolean {
    return this.#failed.has(file);
  }

  #fail(warning: AnalysisWarning & { file: string }): void {
    this.#failed.add(warning.file);
    this.#warnings.push(warning);
  }

  hasFile(file: string): boolean {
    return this.#fileSet.has(file);
  }

  readText(file: string): Promise<string | undefined> {
    let p = this.#text.get(file);
    if (p === undefined) {
      p = this.#readText(file);
      this.#text.set(file, p);
    }
    return p;
  }

  async #readText(file: string): Promise<string | undefined> {
    if (path.isAbsolute(file) || /^[A-Za-z]:/u.test(file) || file.split(/[\\/]/u).includes("..")) {
      this.#warnings.push({ code: "path-outside-root", message: "프로젝트 밖 경로 읽기 요청을 거부했습니다" });
      return undefined;
    }
    if (!this.#fileSet.has(file)) return undefined;
    try {
      const real = await realpath(path.join(this.#root, ...file.split("/")));
      if (!isInside(this.#root, real)) {
        this.#fail({ code: "symlink-outside-root", file, message: "프로젝트 밖을 가리키게 되어 읽지 않았습니다" });
        return undefined;
      }
      const st = await stat(real);
      if (st.size > this.#limits.maxFileBytes) {
        this.#fail({ code: "scan-limit", file, message: `파일 크기 상한(${this.#limits.maxFileBytes} bytes)을 넘어 읽지 않았습니다` });
        return undefined;
      }
      const text = await readFile(real, "utf8");
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
    } catch (error) {
      this.#fail({ code: "read-failed", file, message: `파일을 읽을 수 없습니다(${errnoCode(error)})` });
      return undefined;
    }
  }

  readJson(file: string): Promise<unknown> {
    return this.#parse(file, "json");
  }
  readYaml(file: string): Promise<unknown> {
    return this.#parse(file, "yaml");
  }
  readToml(file: string): Promise<unknown> {
    return this.#parse(file, "toml");
  }
  readXml(file: string): Promise<unknown> {
    return this.#parse(file, "xml");
  }

  #parse(file: string, kind: Parser): Promise<unknown> {
    const key = `${kind}:${file}`;
    let p = this.#parsed.get(key);
    if (p === undefined) {
      p = this.#doParse(file, kind);
      this.#parsed.set(key, p);
    }
    return p;
  }

  async #doParse(file: string, kind: Parser): Promise<unknown> {
    const text = await this.readText(file);
    if (text === undefined) return undefined;
    try {
      return parseText(text, kind);
    } catch {
      // 파서 오류 메시지에는 원문 일부가 들어갈 수 있어(비밀값 유출 위험) 고정 문구만 남긴다.
      this.#fail({ code: "parse-failed", file, message: `${PARSE_LABEL[kind]} 형식이 올바르지 않아 해석하지 못했습니다` });
      return undefined;
    }
  }
}

/**
 * Detector 한 개가 쓰는 ScanContext 보기. 이 Detector가 실패한 파일을 읽으려 했는지 기록한다.
 * 읽기는 캐시를 공유하므로 경고는 파일당 한 번이지만, 같은 파일을 읽은 모든 Detector가 partial이 된다.
 */
export class DetectorScanView implements ScanContext {
  #touchedFailure = false;
  constructor(readonly base: ProjectScanContext) {}

  get files(): readonly string[] {
    return this.base.files;
  }
  get rootExcluded(): readonly string[] {
    return this.base.rootExcluded;
  }
  get touchedFailure(): boolean {
    return this.#touchedFailure;
  }
  hasFile(file: string): boolean {
    return this.base.hasFile(file);
  }
  async #track<T>(file: string, value: Promise<T>): Promise<T> {
    const v = await value;
    if (v === undefined && this.base.hasFailure(file)) this.#touchedFailure = true;
    return v;
  }
  readText(file: string): Promise<string | undefined> {
    return this.#track(file, this.base.readText(file));
  }
  readJson(file: string): Promise<unknown> {
    return this.#track(file, this.base.readJson(file));
  }
  readYaml(file: string): Promise<unknown> {
    return this.#track(file, this.base.readYaml(file));
  }
  readToml(file: string): Promise<unknown> {
    return this.#track(file, this.base.readToml(file));
  }
  readXml(file: string): Promise<unknown> {
    return this.#track(file, this.base.readXml(file));
  }
}

function parseText(text: string, kind: Parser): unknown {
  switch (kind) {
    case "json":
      return JSON.parse(text);
    case "yaml": {
      const doc = parseDocument(text, { prettyErrors: false });
      if (doc.errors.length > 0) throw new Error("yaml");
      return doc.toJS({ maxAliasCount: 100 });
    }
    case "toml":
      return parseToml(text);
    case "xml":
      if (XMLValidator.validate(text) !== true) throw new Error("xml");
      return xmlParser.parse(text);
  }
}
