import type { ProjectDetector, ScanContext } from "../detector";
import type { AnalysisWarning, Evidence } from "../profile";
import { FindingSet } from "./findings";
import {
  COMPOSE_FILE,
  SPRING_CONFIG_FILE,
  baseName,
  filesMatching,
  filesNamed,
  isAnalysisCandidate,
  isRecord,
  normalizeImage,
  readCargo,
  readComposeServices,
  readCsproj,
  readGradle,
  readNpm,
  readPom,
  readPyproject,
  readRequirements,
  readSpringUrlSchemes,
} from "./manifests";
import { DEFAULT_TECH_RULES, ruleMatches, type TechRule } from "./rules";

type Ecosystem = "npm" | "pypi" | "jvm" | "jvmPlugins" | "nuget" | "cargo";

interface Signal {
  ecosystem: Ecosystem;
  value: string;
  evidence: Evidence;
}

/** 프로젝트의 의존성·플러그인 신호를 생태계별로 모은다(문자열 검색이 아니라 매니페스트 구조에서). */
async function collectSignals(ctx: ScanContext): Promise<Signal[]> {
  const out: Signal[] = [];
  const dep = (ecosystem: Ecosystem, file: string, value: string, type: Evidence["type"] = "dependency") =>
    out.push({ ecosystem, value, evidence: { file, type, value } });

  for (const file of filesNamed(ctx, "package.json")) for (const d of (await readNpm(ctx, file))?.dependencies ?? []) dep("npm", file, d);
  for (const file of filesNamed(ctx, "pyproject.toml")) for (const d of (await readPyproject(ctx, file))?.dependencies ?? []) dep("pypi", file, d);
  for (const file of filesMatching(ctx, /^requirements.*\.txt$/u)) for (const d of (await readRequirements(ctx, file)) ?? []) dep("pypi", file, d);
  for (const file of filesNamed(ctx, "pom.xml")) {
    const pom = await readPom(ctx, file);
    for (const d of pom?.dependencies ?? []) dep("jvm", file, d);
    for (const p of pom?.plugins ?? []) dep("jvmPlugins", file, p, "build-plugin");
  }
  for (const file of filesNamed(ctx, "build.gradle", "build.gradle.kts")) {
    const gradle = await readGradle(ctx, file);
    for (const d of gradle?.dependencies ?? []) dep("jvm", file, d);
    for (const p of gradle?.plugins ?? []) dep("jvmPlugins", file, p, "build-plugin");
  }
  for (const file of filesMatching(ctx, /\.csproj$/u)) for (const d of (await readCsproj(ctx, file))?.dependencies ?? []) dep("nuget", file, d);
  for (const file of filesNamed(ctx, "Cargo.toml")) for (const d of (await readCargo(ctx, file))?.dependencies ?? []) dep("cargo", file, d);
  return out;
}

/** 규칙 표로 Framework·DB를 탐지하는 Detector를 만든다. 테스트는 규칙만 바꿔 새 기술 탐지를 확인한다. */
export function createTechDetector(id: string, category: TechRule["category"], rules: readonly TechRule[] = DEFAULT_TECH_RULES): ProjectDetector {
  const mine = rules.filter((r) => r.category === category);
  return {
    id,
    supports: (ctx) => ctx.files.length > 0,
    async detect(ctx) {
      const found = new FindingSet();
      const warnings: AnalysisWarning[] = [];
      for (const s of await collectSignals(ctx)) {
        for (const rule of mine) if (ruleMatches(rule[s.ecosystem], s.value)) found.add(category, rule.id, rule.name, s.evidence);
      }
      for (const rule of mine) {
        if (rule.configFiles === undefined) continue;
        for (const file of filesNamed(ctx, ...rule.configFiles)) found.add(category, rule.id, rule.name, { file, type: "config", value: baseName(file) });
      }
      if (category === "frameworks") await detectGameEngines(ctx, found);
      if (category === "databases") {
        for (const file of filesMatching(ctx, COMPOSE_FILE)) {
          for (const svc of (await readComposeServices(ctx, file)) ?? []) {
            if (svc.image === undefined) continue;
            const image = normalizeImage(svc.image);
            for (const rule of mine) {
              if (ruleMatches(rule.dockerImages, image)) found.add(category, rule.id, rule.name, { file, type: "docker-image", value: `${svc.name}: ${image}` });
            }
          }
        }
        for (const file of filesMatching(ctx, SPRING_CONFIG_FILE)) {
          const schemes = await readSpringUrlSchemes(ctx, file);
          if (schemes === undefined) {
            warnings.push({ code: "parse-failed", file, message: `${baseName(file)} 설정 형식이 올바르지 않아 해석하지 못했습니다` });
            continue;
          }
          for (const { key, scheme } of schemes) {
            for (const rule of mine) if (ruleMatches(rule.urlSchemes, scheme)) found.add(category, rule.id, rule.name, { file, type: "config", value: `${key} scheme=${scheme}` });
          }
        }
      }
      return { findings: found.toArray(), warnings, ...(warnings.length > 0 ? { partial: true } : {}) };
    },
  };
}

export const frameworkDetector = createTechDetector("frameworks", "frameworks");
export const databaseDetector = createTechDetector("databases", "databases");

const UNITY_PROJECT_VERSION = /(^|\/)ProjectSettings\/ProjectVersion\.txt$/u;
const UNITY_PACKAGE_MANIFEST = /(^|\/)Packages\/manifest\.json$/u;
const SAFE_TOKEN = /^[0-9A-Za-z._{}+-]{1,64}$/u;
const plainName = (v: unknown): string | undefined =>
  typeof v === "string" && /^[\p{L}\p{N} ._+-]{1,80}$/u.test(v.trim()) ? v.trim() : undefined;

/**
 * 게임 엔진(taxonomyVersion 2). 엔진이 만드는 프로젝트 파일만 근거로 쓴다.
 * - Unity: ProjectSettings/ProjectVersion.txt의 m_EditorVersion 줄, Packages/manifest.json의 com.unity.* 패키지.
 *   .cs·.csproj만 있는 C# 프로젝트는 Unity가 아니다.
 * - Unreal Engine: .uproject(EngineAssociation·Modules·FileVersion), .uplugin(FileVersion·Modules).
 *   C++ 소스만 있는 프로젝트는 Unreal이 아니다. .uproject를 해석하지 못하면 파일 존재 근거만 남긴다(낮은 신뢰도).
 * 줄 단위·구조 파서로 읽고, 근거 값은 안전한 토큰만 남긴다.
 */
async function detectGameEngines(ctx: ScanContext, found: FindingSet): Promise<void> {
  for (const file of ctx.files.filter((f) => isAnalysisCandidate(f) && UNITY_PROJECT_VERSION.test(f))) {
    const text = await ctx.readText(file);
    if (text === undefined) continue;
    for (const line of text.split(/\r?\n/u)) {
      if (!line.startsWith("m_EditorVersion:")) continue;
      const version = line.slice("m_EditorVersion:".length).trim();
      if (SAFE_TOKEN.test(version)) found.add("frameworks", "unity", "Unity", { file, type: "config", value: "m_EditorVersion: " + version });
      break;
    }
  }
  for (const file of ctx.files.filter((f) => isAnalysisCandidate(f) && UNITY_PACKAGE_MANIFEST.test(f))) {
    const json = await ctx.readJson(file);
    const deps = isRecord(json) && isRecord(json["dependencies"]) ? Object.keys(json["dependencies"]).filter((d) => d.startsWith("com.unity.")) : [];
    if (deps.length > 0) found.add("frameworks", "unity", "Unity", { file, type: "manifest", value: "com.unity packages: " + String(deps.length) });
  }
  for (const file of filesMatching(ctx, /\.uproject$/u)) {
    const json = await ctx.readJson(file);
    if (!isRecord(json)) {
      found.add("frameworks", "unreal-engine", "Unreal Engine", { file, type: "file-presence", value: baseName(file) });
      continue;
    }
    const engine = json["EngineAssociation"];
    const modules = Array.isArray(json["Modules"]) ? json["Modules"].map((m) => (isRecord(m) ? plainName(m["Name"]) : undefined)).filter((m): m is string => m !== undefined) : [];
    const value =
      typeof engine === "string" && SAFE_TOKEN.test(engine)
        ? "EngineAssociation: " + engine
        : modules.length > 0
          ? ("Modules: " + modules.join(", ")).slice(0, 200)
          : typeof json["FileVersion"] === "number"
            ? "FileVersion: " + String(json["FileVersion"])
            : undefined;
    if (value !== undefined) found.add("frameworks", "unreal-engine", "Unreal Engine", { file, type: "config", value });
  }
  for (const file of filesMatching(ctx, /\.uplugin$/u)) {
    const json = await ctx.readJson(file);
    if (!isRecord(json) || (typeof json["FileVersion"] !== "number" && !Array.isArray(json["Modules"]))) continue;
    const name = plainName(json["FriendlyName"]) ?? baseName(file).replace(/\.uplugin$/u, "");
    found.add("frameworks", "unreal-engine", "Unreal Engine", { file, type: "config", value: ("plugin: " + name).slice(0, 200) });
  }
}
