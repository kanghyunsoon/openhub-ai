/**
 * 의존성·Build 플러그인·이미지·설정 scheme → 기술 규칙 표(TASK-011).
 * 새 Framework·DB는 이 표에 항목을 추가하는 것만으로 탐지된다. 끝이 "*"인 값은 접두사 일치다.
 */
export interface TechRule {
  category: "frameworks" | "databases";
  id: string;
  name: string;
  npm?: readonly string[];
  /** PEP 503 정규화 이름 */
  pypi?: readonly string[];
  /** "groupId:artifactId" (pom.xml 의존성·parent, Gradle 의존성 공통) */
  jvm?: readonly string[];
  /** Maven 플러그인 좌표 또는 Gradle 플러그인 id */
  jvmPlugins?: readonly string[];
  nuget?: readonly string[];
  cargo?: readonly string[];
  /** compose 서비스 image(레지스트리·태그 제외) */
  dockerImages?: readonly string[];
  /** Spring datasource·mongodb URL scheme(jdbc: 다음 또는 URL scheme) */
  urlSchemes?: readonly string[];
}

export const DEFAULT_TECH_RULES: readonly TechRule[] = Object.freeze([
  { category: "frameworks", id: "react", name: "React", npm: ["react"] },
  { category: "frameworks", id: "nextjs", name: "Next.js", npm: ["next"] },
  { category: "frameworks", id: "vue", name: "Vue", npm: ["vue"] },
  {
    category: "frameworks",
    id: "spring-boot",
    name: "Spring Boot",
    jvm: ["org.springframework.boot:*"],
    jvmPlugins: ["org.springframework.boot:spring-boot-maven-plugin", "org.springframework.boot"],
  },
  { category: "frameworks", id: "fastapi", name: "FastAPI", pypi: ["fastapi"] },

  {
    category: "databases",
    id: "postgresql",
    name: "PostgreSQL",
    npm: ["pg", "postgres", "pg-promise"],
    pypi: ["psycopg", "psycopg2", "psycopg2-binary", "asyncpg"],
    jvm: ["org.postgresql:postgresql", "org.postgresql:r2dbc-postgresql"],
    nuget: ["npgsql", "npgsql.entityframeworkcore.postgresql"],
    cargo: ["tokio-postgres", "postgres"],
    dockerImages: ["postgres", "postgis/postgis", "bitnami/postgresql"],
    urlSchemes: ["postgresql", "postgres"],
  },
  {
    category: "databases",
    id: "mysql",
    name: "MySQL",
    npm: ["mysql", "mysql2"],
    pypi: ["pymysql", "mysqlclient", "mysql-connector-python", "aiomysql"],
    jvm: ["com.mysql:mysql-connector-j", "mysql:mysql-connector-java"],
    nuget: ["mysql.data", "mysqlconnector", "pomelo.entityframeworkcore.mysql"],
    cargo: ["mysql", "mysql_async"],
    dockerImages: ["mysql", "bitnami/mysql"],
    urlSchemes: ["mysql"],
  },
  {
    category: "databases",
    id: "sqlite",
    name: "SQLite",
    npm: ["sqlite3", "better-sqlite3"],
    pypi: ["aiosqlite"],
    jvm: ["org.xerial:sqlite-jdbc"],
    nuget: ["microsoft.data.sqlite", "system.data.sqlite"],
    cargo: ["rusqlite"],
    urlSchemes: ["sqlite"],
  },
  {
    category: "databases",
    id: "mongodb",
    name: "MongoDB",
    npm: ["mongodb", "mongoose"],
    pypi: ["pymongo", "motor", "mongoengine"],
    jvm: ["org.mongodb:*", "org.springframework.boot:spring-boot-starter-data-mongodb"],
    nuget: ["mongodb.driver"],
    cargo: ["mongodb"],
    dockerImages: ["mongo", "bitnami/mongodb"],
    urlSchemes: ["mongodb", "mongodb+srv"],
  },
]);

export function ruleMatches(patterns: readonly string[] | undefined, value: string): boolean {
  return (patterns ?? []).some((p) => (p.endsWith("*") ? value.startsWith(p.slice(0, -1)) : value === p));
}
