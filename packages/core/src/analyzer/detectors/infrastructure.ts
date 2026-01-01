import type { ProjectDetector } from "../detector";
import { FindingSet } from "./findings";
import { COMPOSE_FILE, baseName, filesMatching, isAnalysisCandidate, isRecord, readComposeServices } from "./manifests";

const NAMES = { docker: "Docker", "docker-compose": "Docker Compose", "github-actions": "GitHub Actions", git: "Git" } as const;
type InfraId = keyof typeof NAMES;

const DOCKERFILE = /^Dockerfile(\..+)?$/u;
const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/u;

/** Dockerfile의 FROM 이미지(--platform 등 옵션과 AS 별칭 제외). */
function fromImages(text: string): string[] {
  const images: string[] = [];
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const m = /^FROM\s+(.+)$/iu.exec(line);
    if (m === null) continue;
    const image = (m[1] as string).split(/\s+/u).find((t) => !t.startsWith("--"));
    if (image !== undefined) images.push(image);
  }
  return [...new Set(images)];
}

/**
 * Infrastructure Detector(TASK-012). Docker, Docker Compose, GitHub Actions, Git만 다룬다.
 * 클라우드·오케스트레이션 도구는 이 파일을 바꾸지 않고 별도 Detector를 등록해 추가한다.
 */
export const infrastructureDetector: ProjectDetector = {
  id: "infrastructure",
  supports: (ctx) => ctx.files.length > 0 || ctx.rootExcluded.length > 0,
  async detect(ctx) {
    const found = new FindingSet();
    const infra = (id: InfraId, file: string, type: "config" | "file-presence", value: string) =>
      found.add("infrastructure", id, NAMES[id], { file, type, value: value.slice(0, 200) });

    for (const file of filesMatching(ctx, DOCKERFILE)) {
      const text = await ctx.readText(file);
      const images = text === undefined ? [] : fromImages(text);
      if (images.length === 0) infra("docker", file, "file-presence", baseName(file));
      for (const image of images) infra("docker", file, "config", `FROM ${image}`);
    }

    for (const file of filesMatching(ctx, COMPOSE_FILE)) {
      const services = await readComposeServices(ctx, file);
      if (services === undefined) infra("docker-compose", file, "file-presence", baseName(file));
      else if (services.length > 0) infra("docker-compose", file, "config", `services: ${services.map((s) => s.name).join(", ")}`);
    }

    for (const file of ctx.files.filter((f) => WORKFLOW.test(f) && isAnalysisCandidate(f))) {
      const yaml = await ctx.readYaml(file);
      if (yaml === undefined) {
        infra("github-actions", file, "file-presence", baseName(file));
        continue;
      }
      const jobs = isRecord(yaml) ? yaml["jobs"] : undefined;
      if (isRecord(jobs) && Object.keys(jobs).length > 0) infra("github-actions", file, "config", `jobs: ${Object.keys(jobs).sort().join(", ")}`);
    }

    // .git은 Scanner가 탐색하지 않고 이름만 기록한다(디렉터리 또는 worktree 파일). 내부는 읽지 않는다.
    if (ctx.rootExcluded.includes(".git")) infra("git", ".git", "config", ".git");

    return { findings: found.toArray() };
  },
};
