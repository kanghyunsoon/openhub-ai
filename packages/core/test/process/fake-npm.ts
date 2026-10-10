import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { npxCacheKey, parseNpmSpec, type NpxSpawner } from "../../src/index";

/**
 * npm을 흉내 내는 테스트용 spawner(npx Prepare 단위·트랜잭션 테스트). 실제 npm·네트워크를 쓰지 않는다.
 * - `npm config get cache`(argv 끝이 config get cache): stdout으로 cacheRoot를 돌려준다.
 * - npx Prepare(`--package=<spec>` 인자): npm처럼 `<cacheRoot>/_npx/<key>`에 package.json·node_modules/<name>/package.json·
 *   node_modules/.package-lock.json(완료 표시)을 만든다. behavior로 실패·불완전·시간 초과를 흉내 낼 수 있다.
 * - 그 밖의 명령: exitCode로 닫는다(docker pull 등).
 * 모든 호출은 calls에 [executable, ...args]로 남는다.
 */
export interface FakeNpmOptions {
  cacheRoot: string;
  exitCode?: number;
  /** hang-unkillable: kill해도 끝나지 않는다(종료 확인 실패 경로). */
  prepare?: "ok" | "fail" | "incomplete" | "hang" | "hang-unkillable" | "wrong-version";
  configStdout?: string;
}

export function fakeNpmSpawner(o: FakeNpmOptions): { spawner: NpxSpawner; calls: string[][]; envs: (Record<string, string> | undefined)[] } {
  const calls: string[][] = [];
  const envs: (Record<string, string> | undefined)[] = [];
  const spawner: NpxSpawner = (exe, args, options) => {
    calls.push([exe, ...args]);
    envs.push(options?.env);
    const stdout = new EventEmitter();
    const unkillable = o.prepare === "hang-unkillable";
    const child = Object.assign(new EventEmitter(), { stdout, stderr: new EventEmitter(), pid: 4242, kill: () => (unkillable ? undefined : queueMicrotask(() => child.emit("close", null, "SIGKILL")), true) });
    const tail = args.slice(-3).join(" ");
    const pkgFlag = args.find((a) => a.startsWith("--package="));
    queueMicrotask(() => {
      if (tail === "config get cache") {
        stdout.emit("data", Buffer.from((o.configStdout ?? o.cacheRoot) + "\n"));
        child.emit("close", 0, null);
        return;
      }
      if (pkgFlag !== undefined) {
        const spec = pkgFlag.slice("--package=".length);
        const parsed = parseNpmSpec(spec)!;
        const dir = path.join(o.cacheRoot, "_npx", npxCacheKey(spec));
        const mode = o.prepare ?? "ok";
        if (mode === "fail") return void child.emit("close", 1, null);
        mkdirSync(path.join(dir, "node_modules", ...parsed.name.split("/")), { recursive: true });
        writeFileSync(path.join(dir, "package.json"), JSON.stringify({ dependencies: { [parsed.name]: parsed.version }, _npx: { packages: [spec] } }));
        writeFileSync(path.join(dir, "node_modules", ...parsed.name.split("/"), "package.json"), JSON.stringify({ name: parsed.name, version: mode === "wrong-version" ? "0.0.0" : parsed.version }));
        if (mode === "hang" || mode === "hang-unkillable") return; // 닫히지 않는다(timeout 경로). hang은 kill()이 닫는다.
        if (mode !== "incomplete") writeFileSync(path.join(dir, "node_modules", ".package-lock.json"), "{}");
        child.emit("close", 0, null);
        return;
      }
      child.emit("close", o.exitCode ?? 0, null);
    });
    return child as never;
  };
  return { spawner, calls, envs };
}

/** npx Prepare 명령 두 개(cache 위치 확인, 내려받기)인지 판별한다. */
export const isNpxPrepareCall = (argv: readonly string[]) => argv.slice(-3).join(" ") === "config get cache" || argv.some((a) => a.startsWith("--package="));
