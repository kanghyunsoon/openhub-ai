import type { ProjectDetector, ScanContext } from "../detector";
import type { AnalysisWarning, Evidence } from "../profile";
import { FindingSet } from "./findings";
import {
  COMPOSE_FILE,
  SPRING_CONFIG_FILE,
  baseName,
  filesMatching,
  filesNamed,
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
