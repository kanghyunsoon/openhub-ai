import { execFile } from "node:child_process";

export type CommandRunner = (command: string, args: readonly string[]) => Promise<string>;

const runCommand: CommandRunner = (command, args) =>
  new Promise((resolve, reject) => {
    execFile(command, [...args], { timeout: 10_000, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(String(stdout));
    });
  });

/**
 * GitHub 토큰을 찾는다: GITHUB_TOKEN → GH_TOKEN → `gh auth token`. 없으면 undefined(REST 모드).
 * 토큰 값은 돌려주기만 하고 출력하거나 저장하지 않는다.
 */
export async function resolveGitHubToken(
  env: Readonly<Record<string, string | undefined>> = process.env,
  run: CommandRunner = runCommand,
): Promise<{ token: string; source: "GITHUB_TOKEN" | "GH_TOKEN" | "gh" } | undefined> {
  const fromEnv = env["GITHUB_TOKEN"]?.trim();
  if (fromEnv) return { token: fromEnv, source: "GITHUB_TOKEN" };
  const gh = env["GH_TOKEN"]?.trim();
  if (gh) return { token: gh, source: "GH_TOKEN" };
  try {
    const out = (await run("gh", ["auth", "token"])).trim();
    return out === "" ? undefined : { token: out, source: "gh" };
  } catch {
    return undefined;
  }
}
