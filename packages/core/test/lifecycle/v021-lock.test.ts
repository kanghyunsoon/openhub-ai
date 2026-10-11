import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, symlink, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LOCK_INCOMPLETE_MS, acquireLock, isAbandoned, readLock, reclaimLock, withOperationLock } from "../../src/index";
import { homeIn, newScratch } from "./helpers";

/** v0.2.1 B 소유권 잠금 규칙(프로세스 생성 없음). 다중 프로세스 경쟁은 v021-operation-lock.e2e.test.ts(OPENHUB_E2E). */
const scratch = await newScratch("v021-lock");
afterAll(() => rm(scratch, { recursive: true, force: true }));
const DEAD_PID = 2_147_483_000;
const record = (pid: number, host = os.hostname()) => ({ token: randomBytes(16).toString("hex"), pid, host, purpose: "test", startedAt: new Date().toISOString() });
const lockIn = async () => {
  const home = await homeIn(scratch);
  const dir = path.join(home, ".openhub", "state");
  await mkdir(dir, { recursive: true });
  return { home, file: path.join(dir, "operation.lock") };
};

describe("v0.2.1 B 소유권 잠금", () => {
  it("해제는 내 token일 때만 지운다(다른 소유자의 잠금으로 바뀌었으면 그대로)", async () => {
    const { file } = await lockIn();
    const mine = await acquireLock(file, "a", { waitMs: 0 });
    if (!mine.ok) throw new Error("busy");
    const other = JSON.stringify(record(process.pid)) + "\n";
    await writeFile(file, other);
    await mine.release();
    expect(await readFile(file, "utf8")).toBe(other);
  });

  it("회수 중 다른 소유자가 만든 새 잠금은 지우지 않는다(관찰한 버려진 잠금과 token이 다르다)", async () => {
    const { file } = await lockIn();
    await writeFile(file, JSON.stringify(record(DEAD_PID)) + "\n");
    const observed = (await readLock(file))!;
    expect(isAbandoned(observed)).toBe(true);
    const fresh = JSON.stringify(record(process.pid)) + "\n";
    await writeFile(file, fresh); // 다른 회수자가 먼저 회수하고 새 소유자가 잠금을 만들었다
    expect(await reclaimLock(file, observed)).toBe(false);
    expect(await readFile(file, "utf8")).toBe(fresh);
  });

  it("죽은 pid의 잠금 하나를 10개 작업이 동시에 회수해도 정확히 하나만 실행하고, 실행 중 그 소유자의 잠금이 지워지지 않는다", async () => {
    const { home, file } = await lockIn();
    await writeFile(file, JSON.stringify(record(DEAD_PID)) + "\n");
    const seen: string[] = [];
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        withOperationLock({ homeDir: home, purpose: "op" + i }, async () => {
          const before = (await readLock(file))?.record?.token ?? "none";
          await new Promise((r) => setTimeout(r, 200));
          const after = (await readLock(file))?.record?.token ?? "none";
          seen.push(before === after ? "kept" : "lost");
          return i;
        }),
      ),
    );
    expect(results.filter((r) => r.ok).length).toBe(1);
    expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code))).toEqual(Array(9).fill("OPERATION_IN_PROGRESS"));
    expect(seen).toEqual(["kept"]);
    expect(await readLock(file)).toBeNull();
  });

  it("같은 프로세스의 겹친 작업도 OPERATION_IN_PROGRESS이고, 메시지에 경로가 없다", async () => {
    const { home } = await lockIn();
    let inner: Awaited<ReturnType<typeof withOperationLock>> | undefined;
    const outer = await withOperationLock({ homeDir: home, purpose: "lifecycle-update" }, async () => {
      inner = await withOperationLock({ homeDir: home, purpose: "install" }, async () => 1);
      return 0;
    });
    expect(outer.ok).toBe(true);
    expect(inner).toMatchObject({ ok: false, code: "OPERATION_IN_PROGRESS" });
    expect(inner && !inner.ok && inner.message).toContain("lifecycle-update");
    expect(inner && !inner.ok && inner.message).not.toContain(home);
  });

  it("살아 있는 소유자·다른 host·쓰는 중(빈 파일, 방금)인 잠금은 버려진 것이 아니고, 오래된 빈 파일만 버려진 것이다", async () => {
    const { file } = await lockIn();
    expect(isAbandoned({ record: record(process.pid), mtimeMs: 0 })).toBe(false);
    expect(isAbandoned({ record: record(DEAD_PID, "other-host.invalid"), mtimeMs: 0 })).toBe(false);
    expect(isAbandoned({ record: record(4242) , mtimeMs: 0 }, { isAlive: () => true })).toBe(false);
    await writeFile(file, "");
    expect(isAbandoned((await readLock(file))!)).toBe(false);
    const old = new Date(Date.now() - LOCK_INCOMPLETE_MS - 5_000);
    await utimes(file, old, old);
    expect(isAbandoned((await readLock(file))!)).toBe(true);
  });

  it("잠금 경로가 symlink이면 따라가지 않고 실행하지 않는다(OPERATION_LOCK_FAILED)", async () => {
    const { home, file } = await lockIn();
    const target = path.join(scratch, "elsewhere-" + randomBytes(4).toString("hex"));
    await writeFile(target, "x");
    try {
      await symlink(target, file);
    } catch {
      return; // 이 환경에서 symlink를 만들 권한이 없다(Windows 일반 사용자). Linux CI에서 검사한다.
    }
    let ran = false;
    const r = await withOperationLock({ homeDir: home, purpose: "x" }, async () => (ran = true));
    expect(r).toMatchObject({ ok: false, code: "OPERATION_LOCK_FAILED" });
    expect(ran).toBe(false);
    expect(await readFile(target, "utf8")).toBe("x");
  });
});
