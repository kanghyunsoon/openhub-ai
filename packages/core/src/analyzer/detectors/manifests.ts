import { parseAllDocuments } from "yaml";
import type { ScanContext } from "../detector";

/**
 * 생태계별 매니페스트를 실행 없이 구조로 읽는다(D-002).
 * JSON·TOML·XML·YAML은 ScanContext의 파서, Gradle·requirements.txt는 줄 단위 규칙을 쓴다.
 */

/** 테스트용 예제 디렉터리 안의 매니페스트는 프로젝트 스택의 근거로 쓰지 않는다(예: test/fixtures/spring-app/pom.xml). */
const NOISE_DIRECTORIES = new Set(["fixtures", "__fixtures__", "testdata", "test-fixtures"]);

export function isAnalysisCandidate(file: string): boolean {
  const dirs = file.split("/").slice(0, -1);
  return !dirs.some((d) => NOISE_DIRECTORIES.has(d));
}

export const baseName = (file: string): string => file.slice(file.lastIndexOf("/") + 1);
export const dirName = (file: string): string => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "");

export function filesNamed(ctx: ScanContext, ...names: string[]): string[] {
  return ctx.files.filter((f) => isAnalysisCandidate(f) && names.includes(baseName(f)));
}

export function filesMatching(ctx: ScanContext, pattern: RegExp): string[] {
  return ctx.files.filter((f) => isAnalysisCandidate(f) && pattern.test(baseName(f)));
}

export const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asArray = (v: unknown): unknown[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const uniqueSorted = (xs: Iterable<string>): string[] => [...new Set(xs)].sort();
const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() !== "" ? v.trim() : undefined);

// ---------------------------------------------------------------- npm

export interface NpmManifest {
  file: string;
  dependencies: string[];
  packageManager?: string;
  hasWorkspaces: boolean;
}

export async function readNpm(ctx: ScanContext, file: string): Promise<NpmManifest | undefined> {
  const json = await ctx.readJson(file);
  if (!isRecord(json)) return undefined;
  const deps: string[] = [];
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    const v = json[field];
    if (isRecord(v)) deps.push(...Object.keys(v));
  }
  const pm = str(json["packageManager"]);
  const ws = json["workspaces"];
  return {
    file,
    dependencies: uniqueSorted(deps.map((d) => d.toLowerCase())),
    ...(pm !== undefined && /^(npm|pnpm|yarn|bun)@/u.test(pm) ? { packageManager: pm } : {}),
    hasWorkspaces: Array.isArray(ws) || (isRecord(ws) && Array.isArray(ws["packages"])),
  };
}

// ---------------------------------------------------------------- Python

export function pep503(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/gu, "-");
}

const PEP508_NAME = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)/u;

function requirementName(spec: unknown): string | undefined {
  if (typeof spec !== "string") return undefined;
  const m = PEP508_NAME.exec(spec);
  return m?.[1] === undefined ? undefined : pep503(m[1]);
}

export interface PythonManifest {
  file: string;
  dependencies: string[];
  usesUv: boolean;
}

export async function readPyproject(ctx: ScanContext, file: string): Promise<PythonManifest | undefined> {
  const toml = await ctx.readToml(file);
  if (!isRecord(toml)) return undefined;
  const names: string[] = [];
  const project = toml["project"];
  if (isRecord(project)) {
    for (const d of asArray(project["dependencies"])) names.push(requirementName(d) ?? "");
    const optional = project["optional-dependencies"];
    if (isRecord(optional)) for (const list of Object.values(optional)) for (const d of asArray(list)) names.push(requirementName(d) ?? "");
  }
  const groups = toml["dependency-groups"];
  if (isRecord(groups)) for (const list of Object.values(groups)) for (const d of asArray(list)) names.push(requirementName(d) ?? "");
  const tool = isRecord(toml["tool"]) ? toml["tool"] : {};
  const poetry = tool["poetry"];
  if (isRecord(poetry)) {
    if (isRecord(poetry["dependencies"])) names.push(...Object.keys(poetry["dependencies"]).map(pep503));
    if (isRecord(poetry["group"])) {
      for (const g of Object.values(poetry["group"])) if (isRecord(g) && isRecord(g["dependencies"])) names.push(...Object.keys(g["dependencies"]).map(pep503));
    }
  }
  return { file, dependencies: uniqueSorted(names.filter((n) => n !== "" && n !== "python")), usesUv: isRecord(tool["uv"]) };
}

export async function readRequirements(ctx: ScanContext, file: string): Promise<string[] | undefined> {
  const text = await ctx.readText(file);
  if (text === undefined) return undefined;
  const names: string[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.replace(/\s+#.*$/u, "").trim();
    if (line === "" || line.startsWith("#") || line.startsWith("-") || /^[a-z+]+:\/\//iu.test(line)) continue;
    const n = requirementName(line);
    if (n !== undefined) names.push(n);
  }
  return uniqueSorted(names);
}

// ---------------------------------------------------------------- JVM

export interface JvmManifest {
  file: string;
  /** "groupId:artifactId" */
  dependencies: string[];
  plugins: string[];
}

function coordinate(v: unknown): string | undefined {
  if (!isRecord(v)) return undefined;
  const g = str(v["groupId"]);
  const a = str(v["artifactId"]);
  return g !== undefined && a !== undefined ? `${g}:${a}` : undefined;
}

export async function readPom(ctx: ScanContext, file: string): Promise<JvmManifest | undefined> {
  const xml = await ctx.readXml(file);
  if (!isRecord(xml) || !isRecord(xml["project"])) return undefined;
  const project = xml["project"];
  const deps: string[] = [];
  const parent = coordinate(project["parent"]);
  if (parent !== undefined) deps.push(parent);
  const depsNode = project["dependencies"];
  if (isRecord(depsNode)) for (const d of asArray(depsNode["dependency"])) deps.push(coordinate(d) ?? "");
  const plugins: string[] = [];
  const build = project["build"];
  if (isRecord(build) && isRecord(build["plugins"])) for (const p of asArray(build["plugins"]["plugin"])) plugins.push(coordinate(p) ?? "");
  return { file, dependencies: uniqueSorted(deps.filter(Boolean)), plugins: uniqueSorted(plugins.filter(Boolean)) };
}

const GRADLE_PLUGIN = /\bid\s*\(?\s*["']([\w.-]+)["']|apply\s+plugin\s*:\s*["']([\w.-]+)["']/gu;
const GRADLE_DEP =
  /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|developmentOnly|annotationProcessor|kapt|ksp)\s*\(?\s*(?:platform\s*\(\s*)?["']([\w.-]+):([\w.-]+)(?::[^"']*)?["']/gu;

/** Gradle 빌드 스크립트는 실행하지 않고 plugins·dependencies 좌표만 규칙으로 추출한다(D-002). */
export async function readGradle(ctx: ScanContext, file: string): Promise<JvmManifest | undefined> {
  const text = await ctx.readText(file);
  if (text === undefined) return undefined;
  const code = text.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
  const plugins = [...code.matchAll(GRADLE_PLUGIN)].map((m) => m[1] ?? m[2] ?? "");
  const deps = [...code.matchAll(GRADLE_DEP)].map((m) => `${m[1]}:${m[2]}`);
  return { file, dependencies: uniqueSorted(deps), plugins: uniqueSorted(plugins.filter(Boolean)) };
}

// ---------------------------------------------------------------- .NET · Rust · Unreal

export async function readCsproj(ctx: ScanContext, file: string): Promise<{ file: string; dependencies: string[] } | undefined> {
  const xml = await ctx.readXml(file);
  if (!isRecord(xml) || !isRecord(xml["Project"])) return undefined;
  const refs: string[] = [];
  for (const group of asArray(xml["Project"]["ItemGroup"])) {
    if (!isRecord(group)) continue;
    for (const ref of asArray(group["PackageReference"])) if (isRecord(ref)) refs.push(str(ref["@_Include"]) ?? "");
  }
  return { file, dependencies: uniqueSorted(refs.filter(Boolean).map((r) => r.toLowerCase())) };
}

export async function readCargo(ctx: ScanContext, file: string): Promise<{ file: string; dependencies: string[]; isPackageOrWorkspace: boolean } | undefined> {
  const toml = await ctx.readToml(file);
  if (!isRecord(toml)) return undefined;
  const deps: string[] = [];
  for (const field of ["dependencies", "dev-dependencies", "build-dependencies"]) if (isRecord(toml[field])) deps.push(...Object.keys(toml[field]));
  const ws = toml["workspace"];
  if (isRecord(ws) && isRecord(ws["dependencies"])) deps.push(...Object.keys(ws["dependencies"]));
  return { file, dependencies: uniqueSorted(deps), isPackageOrWorkspace: isRecord(toml["package"]) || isRecord(ws) };
}

export async function readUprojectModules(ctx: ScanContext, file: string): Promise<string[] | undefined> {
  const json = await ctx.readJson(file);
  if (!isRecord(json)) return undefined;
  return uniqueSorted(asArray(json["Modules"]).map((m) => (isRecord(m) ? (str(m["Name"]) ?? "") : "")).filter(Boolean));
}

// ---------------------------------------------------------------- Docker Compose · Spring 설정

export const COMPOSE_FILE = /^(docker-)?compose\.ya?ml$/u;

/** compose 서비스의 이름과 image만 돌려준다. environment 등 다른 값은 읽어도 꺼내지 않는다. */
export async function readComposeServices(ctx: ScanContext, file: string): Promise<{ name: string; image?: string }[] | undefined> {
  const yaml = await ctx.readYaml(file);
  if (!isRecord(yaml)) return undefined;
  const services = yaml["services"];
  if (!isRecord(services)) return [];
  return Object.keys(services)
    .sort()
    .map((name) => {
      const svc = services[name];
      const image = isRecord(svc) ? str(svc["image"]) : undefined;
      return image === undefined ? { name } : { name, image };
    });
}

/** "docker.io/library/postgres:16@sha256:…" → "postgres" (레지스트리·library/·태그·digest 제거) */
export function normalizeImage(image: string): string {
  let name = image.split("@")[0] as string;
  const lastSlash = name.lastIndexOf("/");
  const colon = name.indexOf(":", lastSlash + 1);
  if (colon >= 0) name = name.slice(0, colon);
  const parts = name.split("/");
  if (parts.length > 1 && /[.:]|^localhost$/u.test(parts[0] as string)) parts.shift();
  if (parts[0] === "library") parts.shift();
  return parts.join("/").toLowerCase();
}

export const SPRING_CONFIG_FILE = /^application(-[\w.-]+)?\.(properties|ya?ml)$/u;
const SPRING_URL_KEYS = ["spring.datasource.url", "spring.r2dbc.url", "spring.data.mongodb.uri"] as const;

/** URL에서 scheme만 뽑는다. host·user·password·query는 버린다. "jdbc:postgresql://…" → "postgresql" */
export function urlScheme(url: string): string | undefined {
  const m = /^\s*(?:jdbc:|r2dbc:)?([a-z][a-z0-9+.-]*):/iu.exec(url);
  return m?.[1]?.toLowerCase();
}

function lookupDotted(doc: unknown, dotted: string): unknown {
  if (isRecord(doc) && dotted in doc) return doc[dotted];
  let cur: unknown = doc;
  for (const part of dotted.split(".")) {
    if (!isRecord(cur)) return undefined;
    cur = cur[part];
  }
  return cur;
}

/**
 * Spring 설정에서 datasource·mongodb URL의 scheme만 추출한다.
 * 값 전체(호스트·계정·비밀번호)는 반환하지 않는다. 해석 실패 시 undefined.
 */
export async function readSpringUrlSchemes(ctx: ScanContext, file: string): Promise<{ key: string; scheme: string }[] | undefined> {
  const text = await ctx.readText(file);
  if (text === undefined) return undefined;
  const found: { key: string; scheme: string }[] = [];
  if (file.endsWith(".properties")) {
    for (const raw of text.split(/\r?\n/u)) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("!")) continue;
      const m = /^([^=:\s]+)\s*[=:]\s*(.*)$/u.exec(line);
      if (m === null || !(SPRING_URL_KEYS as readonly string[]).includes(m[1] as string)) continue;
      const scheme = urlScheme(m[2] as string);
      if (scheme !== undefined) found.push({ key: m[1] as string, scheme });
    }
  } else {
    const docs = parseAllDocuments(text, { prettyErrors: false });
    const list = Array.isArray(docs) ? docs : [docs];
    if (list.some((d) => d.errors.length > 0)) return undefined;
    for (const doc of list) {
      const data: unknown = doc.toJS({ maxAliasCount: 100 });
      for (const key of SPRING_URL_KEYS) {
        const v = lookupDotted(data, key);
        const scheme = typeof v === "string" ? urlScheme(v) : undefined;
        if (scheme !== undefined) found.push({ key, scheme });
      }
    }
  }
  return found;
}
