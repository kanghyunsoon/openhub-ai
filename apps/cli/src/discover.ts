import path from "node:path";
import { parseArgs } from "node:util";
import { CANDIDATES_DIR, discoverCandidates, formatRegistryIssue, loadRegistry, resolveGitHubToken, writeCandidates, type DiscoverySource } from "@openhub/core";
import { rejectAutoApprove, type ReleaseCommandIO } from "./release";
import { registryDirOf } from "./paths";

/**
 * openhub discover(TASK-056, D-025). GitHub Search·Topics·npm search·MCP Registry v0.1에서 Candidate를 만든다.
 * - Candidate는 registry-candidates/<id>.yaml에만 쓴다. registry/ 쓰기·PR 생성·자동 merge가 없다. --json이면 쓰기도 0회다.
 * - README·metadata 설치 문구는 데이터로만 보존하고 실행하지 않는다.
 */

export const DEFAULT_GITHUB_QUERIES = ["topic:mcp-server", "topic:model-context-protocol"] as const;
export const DEFAULT_NPM_QUERIES = ["mcp server", "modelcontextprotocol"] as const;
const SOURCES = ["github", "npm", "mcp-registry"] as const;

export async function runDiscover(argv: readonly string[], io: ReleaseCommandIO, usage: string): Promise<number> {
  if (rejectAutoApprove(argv, io)) return 2;
  let values;
  try {
    values = parseArgs({ args: [...argv], options: { source: { type: "string", multiple: true }, out: { type: "string" }, json: { type: "boolean", default: false }, "no-token": { type: "boolean", default: false } }, allowPositionals: false, strict: true }).values;
  } catch (error) {
    io.err((error instanceof Error ? error.message : String(error)) + "\n\n" + usage);
    return 2;
  }
  const sources = values.source ?? [...SOURCES];
  if (sources.some((s) => !(SOURCES as readonly string[]).includes(s))) {
    io.err("--source는 " + SOURCES.join(", ") + " 중 하나입니다");
    return 2;
  }
  const out = path.resolve(io.cwd, values.out ?? CANDIDATES_DIR);
  if (path.basename(out) !== CANDIDATES_DIR) {
    io.err("--out은 " + CANDIDATES_DIR + " 디렉터리만 쓸 수 있습니다(registry/에는 쓰지 않습니다)");
    return 2;
  }
  const { entries, issues } = await loadRegistry(registryDirOf(io));
  for (const issue of issues) io.err("경고: " + formatRegistryIssue(issue));
  const token = values["no-token"] || !sources.includes("github") ? undefined : (await (io.resolveToken ?? (() => resolveGitHubToken()))().catch(() => undefined))?.token;
  const result = await discoverCandidates(entries, {
    githubQueries: sources.includes("github") ? DEFAULT_GITHUB_QUERIES : [],
    npmQueries: sources.includes("npm") ? DEFAULT_NPM_QUERIES : [],
    mcpRegistry: sources.includes("mcp-registry"),
    now: io.now ?? (() => new Date()),
    ...(io.fetch === undefined ? {} : { fetch: io.fetch }),
    ...(token === undefined ? {} : { githubToken: token }),
  });
  if (values.json) {
    io.out(JSON.stringify({ candidates: result.candidates, errors: result.errors }, null, 2));
    return 0;
  }
  const written = await writeCandidates(path.dirname(out), result.candidates);
  io.out("Discovery Candidate " + String(result.candidates.length) + "개 (Registry entry가 아닙니다. 사람이 검토·수정해 registry/로 옮겨야 추천·설치 대상이 됩니다)");
  for (const c of result.candidates) io.out("  - " + c.id + " [" + c.confidence + "] " + c.sources.join("+") + (c.package === null ? "" : " · " + c.package.key) + (c.repository === null ? "" : " · " + c.repository));
  if (written.length > 0) io.out("기록: " + written.join(", "));
  for (const e of result.errors) io.err("출처 " + (e.source as DiscoverySource) + " 조회 실패 (" + e.code + ")");
  return 0;
}

