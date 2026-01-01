import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { analyzeProject, serializeProfile } from "../src/index";

/**
 * Fixture golden 하네스. 기대 결과는 fixtures/projects/<name>.expected-profile.json에 있다.
 * Detector가 추가·변경되면 OPENHUB_UPDATE_GOLDEN=1 pnpm test 로 갱신하고, 바뀐 golden은 PR diff로 검토한다.
 */
const FIXTURES_DIR = path.resolve(import.meta.dirname, "fixtures/projects");
const UPDATE = process.env["OPENHUB_UPDATE_GOLDEN"] === "1";

/** fixture → 이 golden을 요구하는 수용 기준 */
export const GOLDEN_FIXTURES: Record<string, string> = {
  "react-pnpm": "AC-010-06",
  "python-fastapi": "AC-010-06",
  "polyglot-native": "AC-010-06",
  "spring-postgres": "AC-011-07",
  "react-spring-monorepo": "AC-011-07 AC-012-06",
  "docker-project": "AC-011-07 AC-012-06",
  "claude-mcp": "AC-013-08",
  "malformed-config": "AC-013-08",
};

describe("REQ-010 REQ-011 REQ-012 fixture golden", () => {
  for (const [name, ac] of Object.entries(GOLDEN_FIXTURES)) {
    it(`${ac} ${name} 분석 결과가 golden과 바이트 단위로 같다`, async () => {
      const result = await analyzeProject(path.join(FIXTURES_DIR, name));
      if (!result.ok) throw new Error(result.error.code);
      const actual = serializeProfile(result.profile);
      const file = path.join(FIXTURES_DIR, `${name}.expected-profile.json`);
      if (UPDATE || !existsSync(file)) {
        if (!UPDATE) throw new Error(`golden 없음: ${name} — OPENHUB_UPDATE_GOLDEN=1로 생성하세요`);
        await writeFile(file, actual);
      }
      expect(actual).toBe(await readFile(file, "utf8"));
    });
  }
});

