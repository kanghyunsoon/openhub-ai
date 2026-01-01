import type { CliIO } from "../src/cli";

/** 출력을 메모리에 모으는 테스트용 CLI 입출력. */
export function memoryIO(cwd = process.cwd()): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, cwd, version: "0.0.0-test", out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}
