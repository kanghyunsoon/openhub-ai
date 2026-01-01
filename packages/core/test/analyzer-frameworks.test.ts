import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TECH_RULES, analyzeProject, createTechDetector, serializeProfile, type ProjectProfile } from "../src/index";

const FIXTURES = path.resolve(import.meta.dirname, "fixtures/projects");

async function profile(dir: string, detectors?: Parameters<typeof analyzeProject>[1]): Promise<ProjectProfile> {
  const r = await analyzeProject(dir, detectors);
  if (!r.ok) throw new Error(r.error.code);
  return r.profile;
}
const fixture = (name: string) => profile(path.join(FIXTURES, name));
const ids = (items: { id: string }[]) => items.map((i) => i.id);
const evidenceOf = (items: { id: string; evidence: { file: string; type: string; value: string }[] }[], id: string) =>
  items.find((i) => i.id === id)?.evidence.map((e) => `${e.file}|${e.type}|${e.value}`) ?? [];

describe("REQ-010 Framework · Database Detection", () => {
  it("AC-011-01 React·Next.js·Vue·Spring Boot·FastAPI를 의존성 또는 Build 플러그인으로 탐지한다", async () => {
    const spring = await fixture("spring-postgres");
    expect(ids(spring.frameworks)).toEqual(["spring-boot"]);
    expect(evidenceOf(spring.frameworks, "spring-boot")).toEqual([
      "pom.xml|build-plugin|org.springframework.boot:spring-boot-maven-plugin",
      "pom.xml|dependency|org.springframework.boot:spring-boot-starter-data-jpa",
      "pom.xml|dependency|org.springframework.boot:spring-boot-starter-parent",
      "pom.xml|dependency|org.springframework.boot:spring-boot-starter-web",
    ]);
    const mono = await fixture("react-spring-monorepo");
    expect(ids(mono.frameworks)).toEqual(["nextjs", "react", "spring-boot"]);
    expect(evidenceOf(mono.frameworks, "spring-boot")).toContain("backend/build.gradle.kts|build-plugin|org.springframework.boot");
    expect(ids((await fixture("docker-project")).frameworks)).toEqual(["vue"]);
    expect(ids((await fixture("python-fastapi")).frameworks)).toEqual(["fastapi"]);
  });

  it("AC-011-02 PostgreSQL·MySQL·SQLite·MongoDB를 드라이버 의존성·compose image·datasource scheme으로 탐지한다", async () => {
    const docker = await fixture("docker-project");
    expect(ids(docker.databases)).toEqual(["mongodb", "postgresql", "sqlite"]);
    expect(evidenceOf(docker.databases, "postgresql")).toEqual(["compose.yaml|docker-image|db: postgres"]);
    expect(evidenceOf(docker.databases, "mongodb")).toEqual(["compose.yaml|docker-image|documents: mongo", "package.json|dependency|mongoose"]);
    expect(evidenceOf(docker.databases, "sqlite")).toEqual(["package.json|dependency|better-sqlite3"]);
    const spring = await fixture("spring-postgres");
    expect(evidenceOf(spring.databases, "postgresql")).toEqual([
      "pom.xml|dependency|org.postgresql:postgresql",
      "src/main/resources/application.yml|config|spring.datasource.url scheme=postgresql",
    ]);
    expect(evidenceOf((await fixture("python-fastapi")).databases, "postgresql")).toEqual(["pyproject.toml|dependency|psycopg"]);
  });

  it("AC-011-03 같은 기술을 가리키는 여러 Evidence는 하나의 항목으로 합쳐진다", async () => {
    const mono = await fixture("react-spring-monorepo");
    expect(mono.databases).toHaveLength(1);
    expect(evidenceOf(mono.databases, "mysql")).toEqual([
      "backend/build.gradle.kts|dependency|com.mysql:mysql-connector-j",
      "backend/src/main/resources/application.properties|config|spring.datasource.url scheme=mysql",
      "docker-compose.yml|docker-image|mysql: mysql",
    ]);
  });

  it("AC-011-04 datasource·compose 설정의 host·user·password·environment 값은 결과에 없다", async () => {
    for (const name of ["spring-postgres", "react-spring-monorepo", "docker-project"]) {
      const json = serializeProfile(await fixture(name));
      for (const secret of ["FAKE_", "db.internal.example", "shop-db.internal", "app_user", "sslmode", "localhost:5432", "3306", "MYSQL_ROOT_PASSWORD", "POSTGRES_PASSWORD"]) {
        expect(json, `${name}: ${secret}`).not.toContain(secret);
      }
    }
  });

  it("AC-011-05 README·주석·설명 문자열의 기술 이름만으로는 탐지하지 않는다", async () => {
    const spring = await fixture("spring-postgres");
    expect(ids(spring.databases)).toEqual(["postgresql"]); // README의 MongoDB 언급은 무시
    expect(ids(spring.frameworks)).not.toContain("react");
    const mono = await fixture("react-spring-monorepo");
    expect(ids(mono.databases)).not.toContain("postgresql"); // build.gradle.kts의 주석 처리된 의존성은 무시
    const dir = await mkdtemp(path.join(tmpdir(), "openhub-negative-"));
    try {
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ description: "react, vue, next, postgres, mongodb로 만든 앱", keywords: ["mysql"] }));
      await writeFile(path.join(dir, "NOTES.md"), "import React from 'react'; jdbc:postgresql://x");
      const p = await profile(dir);
      expect(p.frameworks).toEqual([]);
      expect(p.databases).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("AC-011-06 규칙 표에 항목을 추가하는 것만으로 새 Framework·DB를 탐지한다", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "openhub-rules-"));
    try {
      await writeFile(path.join(dir, "package.json"), JSON.stringify({ dependencies: { svelte: "5", "@libsql/client": "0.14" } }));
      expect((await profile(dir)).frameworks).toEqual([]);
      const rules = [
        ...DEFAULT_TECH_RULES,
        { category: "frameworks" as const, id: "svelte", name: "Svelte", npm: ["svelte"] },
        { category: "databases" as const, id: "libsql", name: "libSQL", npm: ["@libsql/*"] },
      ];
      const p = await profile(dir, { detectors: [createTechDetector("frameworks", "frameworks", rules), createTechDetector("databases", "databases", rules)] });
      expect(ids(p.frameworks)).toEqual(["svelte"]);
      expect(ids(p.databases)).toEqual(["libsql"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

