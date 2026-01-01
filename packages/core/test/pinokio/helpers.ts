import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, vi } from "vitest";
import { manifestSchema, type Manifest, type ManifestInput } from "../../src/index";

/** Pinokio 테스트 공용: synthetic Manifest, OS 규칙대로 만든 pterm 배치(실행하지 않음), 가짜 pinokiod(loopback HTTP). */
export const scratch = await mkdtemp(path.join(tmpdir(), "openhub-pinokio-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
export const WIN = process.platform === "win32";
export const COMMIT = "a".repeat(40);
export const COMMIT2 = "b".repeat(40);
let n = 0;

export function pinokioManifest(over: Partial<ManifestInput> = {}, options: Record<string, unknown> = {}): Manifest {
  return manifestSchema.parse({
    schemaVersion: 1,
    name: "local-llm-ui",
    displayName: "Local LLM UI",
    summary: "로컬 LLM UI(synthetic Pinokio 도구)",
    repository: { github: "acme/local-llm-ui" },
    category: ["mcp"],
    capabilities: [],
    targets: ["claude-code", "cursor", "codex"],
    platform: { windows: true, macos: true, linux: true },
    requirements: { python: ">=3.10" },
    env: [],
    install: { preferredAdapter: "pinokio", options: { template: "uv-pip", commit: COMMIT, package: "local-llm-ui", version: "1.2.0", start: { module: "local_llm_ui.server" }, mcp: { path: "/mcp" }, ...options }, fallback: [] },
    healthCheck: { type: "http", url: "http://127.0.0.1:7860/health", expectStatus: 200 },
    update: { source: "github-release" },
    rollback: { supported: true },
    verification: "community",
    ...over,
  });
}

/** 실행 중인 OS 규칙대로 npm global pterm 배치를 만든다(파일은 실행하지 않는다). */
export async function ptermLayout(version = "0.0.25", over: { pkg?: Record<string, unknown>; noNode?: boolean } = {}) {
  n += 1;
  const prefix = path.join(scratch, "prefix-" + String(n));
  const binDir = WIN ? prefix : path.join(prefix, "bin");
  const pkgDir = WIN ? path.join(prefix, "node_modules", "pterm") : path.join(prefix, "lib", "node_modules", "pterm");
  await mkdir(pkgDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  await writeFile(path.join(binDir, WIN ? "pterm.cmd" : "pterm"), "launcher (not executed)");
  if (over.noNode !== true) await writeFile(path.join(binDir, WIN ? "node.exe" : "node"), "node (not executed)");
  await writeFile(path.join(pkgDir, "package.json"), JSON.stringify({ name: "pterm", version, bin: { pterm: "./index.js" }, ...over.pkg }));
  await writeFile(path.join(pkgDir, "index.js"), "// pterm (not executed)\n");
  return { prefix, binDir, pkgDir, pathEnv: [path.join(scratch, "empty-dir"), binDir].join(WIN ? ";" : ":") };
}

export const realFs = (log: string[] = []) => ({
  stat: async (f: string) => (log.push(f), stat(f)),
  readFile: async (f: string) => (log.push(f), readFile(f, "utf8")),
  realpath: async (f: string) => (log.push(f), realpath(f)),
});

export async function newHome() {
  n += 1;
  const home = path.join(scratch, "pinokio-home-" + String(n));
  await mkdir(path.join(home, "api"), { recursive: true });
  return home;
}

/** 가짜 pinokiod control plane(loopback HTTP). health는 선택 처리기다. */
export function pinokiod(home: string, versions: Record<string, unknown> = { pinokiod: "4.0.3", script: "4.0" }, health?: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (url: string) => {
    calls.push(url);
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "http://127.0.0.1:42000/pinokio/version") return json(versions);
    if (url === "http://127.0.0.1:42000/pinokio/home") return json({ path: home });
    if (health !== undefined && !url.startsWith("http://127.0.0.1:42000/")) return health(url);
    return new Response("missing", { status: 404 });
  });
  return { fetch, calls };
}

