import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";
import { commitLifecycleState, readLifecycleState } from "../../src/index";
import { homeIn, newScratch, stateOf } from "./helpers";

/**
 * v0.2.1 P0-4 프로세스 간 잠금(OPENHUB_E2E=1일 때만). 별도 node 프로세스 4개(CLI·Desktop 동시 실행과 같은 조건)가
 * 같은 digest로 거의 같은 순간 커밋한다. 기본 테스트·CI는 실제 프로세스를 띄우지 않는다(AC-031-09).
 */
const skip = process.env["OPENHUB_E2E"] !== "1";
const scratch = await newScratch("v021-state-lock-e2e");
afterAll(() => rm(scratch, { recursive: true, force: true }));

describe.skipIf(skip)("v0.2.1 P0-4 Version State 프로세스 간 커밋", () => {
  it("별도 프로세스 4개가 같은 digest로 동시에 커밋해도 정확히 하나만 성공하고 나머지는 STATE_CONFLICT다", async () => {
    for (let round = 0; round < 3; round += 1) {
      const home = await homeIn(scratch);
      const first = await commitLifecycleState(stateOf(), null, { homeDir: home });
      if (!first.ok) throw new Error(first.code);
      const tsx = createRequire(import.meta.url).resolve("tsx/cli");
      const worker = path.join(import.meta.dirname, "fixtures", "commit-worker.ts");
      const go = path.join(home, "go");
      const runs = [0, 1, 2, 3].map((i) => promisify(execFile)(process.execPath, [tsx, worker, home, first.digest, "p" + i, go], { timeout: 60_000 }));
      await new Promise((r) => setTimeout(r, 2000)); // worker가 모두 시작해 go를 기다리게 한다
      await writeFile(go, "");
      const codes = (await Promise.all(runs)).map((r) => r.stdout.trim());
      expect(codes.filter((c) => c === "ok").length, JSON.stringify(codes)).toBe(1);
      expect(codes.filter((c) => c !== "ok")).toEqual(["STATE_CONFLICT", "STATE_CONFLICT", "STATE_CONFLICT"]);
      const read = await readLifecycleState({ homeDir: home });
      expect(read.ok && Object.keys(read.state.entries).length).toBe(1);
    }
  }, 180_000);
});
