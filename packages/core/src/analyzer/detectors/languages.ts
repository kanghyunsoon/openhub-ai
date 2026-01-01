import type { ProjectDetector, ScanContext } from "../detector";
import type { AnalysisWarning } from "../profile";
import { FindingSet } from "./findings";
import {
  baseName,
  dirName,
  filesMatching,
  filesNamed,
  isAnalysisCandidate,
  readCargo,
  readCsproj,
  readNpm,
  readPom,
  readPyproject,
  readUprojectModules,
} from "./manifests";

const LANG = {
  typescript: "TypeScript",
  javascript: "JavaScript",
  python: "Python",
  java: "Java",
  csharp: "C#",
  rust: "Rust",
  cpp: "C++",
} as const;
type LangId = keyof typeof LANG;

/** 확장자 개수는 보조 Evidence(가중치 0.4)로만 쓴다. */
const EXTENSIONS: [LangId, RegExp, string][] = [
  ["typescript", /\.(ts|tsx|mts|cts)$/u, ".ts/.tsx"],
  ["javascript", /\.(js|jsx|mjs|cjs)$/u, ".js/.jsx"],
  ["python", /\.py$/u, ".py"],
  ["java", /\.java$/u, ".java"],
  ["csharp", /\.cs$/u, ".cs"],
  ["rust", /\.rs$/u, ".rs"],
  ["cpp", /\.(cpp|cc|cxx|hpp|hh|h)$/u, ".cpp/.h"],
];

export const languageDetector: ProjectDetector = {
  id: "languages",
  supports: (ctx) => ctx.files.length > 0,
  async detect(ctx) {
    const found = new FindingSet();
    const lang = (id: LangId, file: string, type: "manifest" | "dependency" | "config" | "file-presence" | "extension-count", value: string) =>
      found.add("languages", id, LANG[id], { file, type, value });

    for (const file of filesNamed(ctx, "package.json")) {
      const npm = await readNpm(ctx, file);
      if (npm === undefined) {
        lang("javascript", file, "file-presence", "package.json");
        continue;
      }
      lang("javascript", file, "manifest", "package.json");
      if (npm.dependencies.includes("typescript")) lang("typescript", file, "dependency", "typescript");
    }
    for (const file of filesMatching(ctx, /^tsconfig(\..+)?\.json$/u)) lang("typescript", file, "config", baseName(file));

    for (const file of filesNamed(ctx, "pyproject.toml")) {
      lang("python", file, (await readPyproject(ctx, file)) === undefined ? "file-presence" : "manifest", "pyproject.toml");
    }
    for (const file of filesMatching(ctx, /^requirements.*\.txt$/u)) lang("python", file, "manifest", baseName(file));

    for (const file of filesNamed(ctx, "pom.xml")) {
      lang("java", file, (await readPom(ctx, file)) === undefined ? "file-presence" : "manifest", "pom.xml");
    }
    for (const file of filesNamed(ctx, "build.gradle", "build.gradle.kts")) lang("java", file, "manifest", baseName(file));

    for (const file of filesMatching(ctx, /\.csproj$/u)) {
      lang("csharp", file, (await readCsproj(ctx, file)) === undefined ? "file-presence" : "manifest", baseName(file));
    }
    for (const file of filesMatching(ctx, /\.sln$/u)) lang("csharp", file, "manifest", baseName(file));

    for (const file of filesNamed(ctx, "Cargo.toml")) {
      const cargo = await readCargo(ctx, file);
      lang("rust", file, cargo?.isPackageOrWorkspace === true ? "manifest" : "file-presence", "Cargo.toml");
    }

    for (const file of filesMatching(ctx, /\.uproject$/u)) {
      const modules = await readUprojectModules(ctx, file);
      if (modules !== undefined && modules.length > 0) lang("cpp", file, "config", `Modules: ${modules.join(", ")}`.slice(0, 200));
    }

    for (const [id, pattern, label] of EXTENSIONS) {
      const matches = ctx.files.filter((f) => isAnalysisCandidate(f) && pattern.test(f));
      if (matches.length > 0) lang(id, matches[0] as string, "extension-count", `${label} 파일 ${matches.length}개`);
    }
    return { findings: found.toArray() };
  },
};

const LOCKFILES: Record<string, "pnpm" | "npm" | "yarn"> = { "pnpm-lock.yaml": "pnpm", "package-lock.json": "npm", "yarn.lock": "yarn" };
const PM_NAME = { pnpm: "pnpm", npm: "npm", yarn: "Yarn", bun: "Bun", pip: "pip", uv: "uv", maven: "Maven", gradle: "Gradle", cargo: "Cargo" } as const;
type PmId = keyof typeof PM_NAME;

export const packageManagerDetector: ProjectDetector = {
  id: "package-managers",
  supports: (ctx) => ctx.files.length > 0,
  async detect(ctx: ScanContext) {
    const found = new FindingSet();
    const warnings: AnalysisWarning[] = [];
    const pm = (id: PmId, file: string, type: "manifest" | "config" | "lockfile", value: string) => found.add("packageManagers", id, PM_NAME[id], { file, type, value });

    // JavaScript: packageManager 필드 우선, lockfile은 함께 보고하고 충돌을 경고한다.
    const declared = new Map<string, { id: PmId; file: string }>();
    for (const file of filesNamed(ctx, "package.json")) {
      const npm = await readNpm(ctx, file);
      if (npm?.packageManager === undefined) continue;
      const id = npm.packageManager.slice(0, npm.packageManager.indexOf("@")) as PmId;
      pm(id, file, "config", npm.packageManager);
      declared.set(dirName(file), { id, file });
    }
    const lockByDir = new Map<string, { id: PmId; file: string }[]>();
    for (const file of filesNamed(ctx, ...Object.keys(LOCKFILES))) {
      const id = LOCKFILES[baseName(file)] as PmId;
      pm(id, file, "lockfile", baseName(file));
      const list = lockByDir.get(dirName(file)) ?? [];
      list.push({ id, file });
      lockByDir.set(dirName(file), list);
    }
    for (const file of filesNamed(ctx, "pnpm-workspace.yaml")) pm("pnpm", file, "config", "pnpm-workspace.yaml");
    for (const [dir, locks] of [...lockByDir].sort(([a], [b]) => (a < b ? -1 : 1))) {
      const ids = [...new Set(locks.map((l) => l.id))].sort();
      const decl = declared.get(dir);
      const mismatch = decl !== undefined && ids.some((id) => id !== decl.id);
      if (ids.length > 1 || mismatch) {
        const all = [...new Set([...(decl ? [decl.id] : []), ...ids])].sort();
        warnings.push({
          code: "package-manager-conflict",
          file: (locks[0] as { file: string }).file,
          message: `같은 위치에서 여러 패키지 매니저가 확인됐습니다: ${all.join(", ")}`,
        });
      }
    }

    // Python
    for (const file of filesMatching(ctx, /^requirements.*\.txt$/u)) pm("pip", file, "manifest", baseName(file));
    for (const file of filesNamed(ctx, "uv.lock")) pm("uv", file, "lockfile", "uv.lock");
    for (const file of filesNamed(ctx, "pyproject.toml")) {
      if ((await readPyproject(ctx, file))?.usesUv === true) pm("uv", file, "config", "[tool.uv]");
    }

    // JVM
    for (const file of filesNamed(ctx, "pom.xml")) pm("maven", file, "manifest", "pom.xml");
    for (const file of filesNamed(ctx, "mvnw", "mvnw.cmd")) pm("maven", file, "config", baseName(file));
    for (const file of filesNamed(ctx, "build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts")) pm("gradle", file, "manifest", baseName(file));
    for (const file of [...filesNamed(ctx, "gradlew", "gradlew.bat"), ...filesNamed(ctx, "gradle-wrapper.properties")]) pm("gradle", file, "config", baseName(file));

    // Rust
    for (const file of filesNamed(ctx, "Cargo.toml")) pm("cargo", file, "manifest", "Cargo.toml");
    for (const file of filesNamed(ctx, "Cargo.lock")) pm("cargo", file, "lockfile", "Cargo.lock");

    return { findings: found.toArray(), warnings };
  },
};
