import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  analyzeProject,
  nodeConfigFs,
  planInstall,
  requestApproval,
  verifyInstallation,
  type ApprovalRequirement,
  type ConfigFs,
  type ExecChild,
  type ExecSpawner,
  type InstallApproval,
  type InstallEnvironment,
  type InstallRequest,
  type PlannedInstall,
  type RegistryEntry,
} from "../../src/index";
import { ALL_AVAILABLE } from "./helpers";

/**
 * 설치 흐름 테스트 harness: 임시 project·home, 실제 analyzeProject(home은 임시 디렉터리로 주입),
 * fake probe·spawner, 기록용 ConfigFs. 실제 PATH·home·process.env·네트워크를 쓰지 않는다.
 */
export interface HarnessOptions {
  entries: readonly RegistryEntry[];
  exitCode?: number;
  stderr?: string;
  failRenameFor?: string;
  verify?: boolean;
  packageJson?: string;
}

export interface Harness {
  env: InstallEnvironment;
  log: string[];
  spawns: string[][];
  writes: string[];
  reads: string[];
  analyzeCalls: boolean[];
  base: string;
  projectRoot: string;
  homeDir: string;
  isoBase: string;
  request(toolId: string, targets: InstallRequest["targets"], includeHost?: boolean): InstallRequest;
  reset(): void;
}

export async function createHarness(scratch: string, options: HarnessOptions): Promise<Harness> {
  const base = await mkdtemp(path.join(scratch, "case-"));
  const projectRoot = path.join(base, "project");
  const homeDir = path.join(base, "home");
  const isoBase = path.join(base, "tmp");
  for (const d of [projectRoot, homeDir, isoBase]) await mkdir(d);
  await writeFile(path.join(projectRoot, "package.json"), options.packageJson ?? '{ "name": "demo", "private": true }\n');
  const log: string[] = [];
  const spawns: string[][] = [];
  const writes: string[] = [];
  const reads: string[] = [];
  const analyzeCalls: boolean[] = [];
  const rel = (f: string) => path.relative(base, f).replace(/\\/gu, "/");
  const configFs: ConfigFs = {
    ...nodeConfigFs,
    readFile: async (f) => (reads.push(rel(f)), log.push("read"), nodeConfigFs.readFile(f)),
    writeFile: async (f, d) => (writes.push("write:" + rel(f)), log.push("write"), nodeConfigFs.writeFile(f, d)),
    rename: async (a, b) => {
      writes.push("rename:" + rel(b));
      if (options.failRenameFor !== undefined && rel(b).endsWith(options.failRenameFor)) throw Object.assign(new Error("EBUSY"), { code: "EBUSY" });
      return nodeConfigFs.rename(a, b);
    },
    mkdir: async (d) => (writes.push("mkdir:" + rel(d)), nodeConfigFs.mkdir(d)),
    rm: async (f) => (writes.push("rm:" + rel(f)), nodeConfigFs.rm(f)),
  };
  const spawner: ExecSpawner = (executable, args) => {
    spawns.push([executable, ...args]);
    log.push("spawn");
    const events = new EventEmitter();
    const stderr = new EventEmitter();
    queueMicrotask(() => {
      if (options.stderr !== undefined) stderr.emit("data", Buffer.from(options.stderr));
      events.emit("close", options.exitCode ?? 0, null);
    });
    return { stdout: null, stderr, on: (e: string, l: (...a: unknown[]) => void) => events.on(e, l), kill: () => true } as ExecChild;
  };
  const env: InstallEnvironment = {
    loadEntries: async () => options.entries,
    analyze: async (projectDir, includeHost) => {
      analyzeCalls.push(includeHost);
      log.push("analyze");
      const result = await analyzeProject(projectDir, { includeHost: includeHost ? { homeDir, pathEnv: "", pathExt: "" } : false });
      if (!result.ok) throw new Error(result.error.code);
      return result.profile;
    },
    probe: async () => (log.push("probe-call"), ALL_AVAILABLE),
    configFs,
    spawner,
    isolatedDir: async () => {
      const dir = await mkdtemp(path.join(isoBase, "iso-"));
      return { path: dir, base: isoBase, cleanup: () => rm(dir, { recursive: true, force: true }) };
    },
    trace: (phase) => log.push(phase),
    ...(options.verify === false ? {} : { verify: verifyInstallation }),
  };
  return {
    env,
    log,
    spawns,
    writes,
    reads,
    analyzeCalls,
    base,
    projectRoot,
    homeDir,
    isoBase,
    request: (toolId, targets, includeHost = false) => ({ toolId, projectRoot, homeDir, targets, includeHost, platform: "linux" }),
    reset: () => {
      log.length = 0;
      spawns.length = 0;
      writes.length = 0;
      reads.length = 0;
      analyzeCalls.length = 0;
    },
  };
}

export async function plannedOf(h: Harness, request: InstallRequest): Promise<PlannedInstall> {
  const { result } = await planInstall(request, h.env);
  if (!result.ok) throw new Error(result.code);
  return result.planned;
}

export async function approveAll(p: PlannedInstall, skip: readonly ApprovalRequirement[] = []): Promise<InstallApproval> {
  const outcome = await requestApproval(p, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id).filter((id) => !skip.includes(id)) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  return outcome.approval;
}

export const listing = async (dir: string) => (await readdir(dir, { recursive: true })).map((f) => f.replace(/\\/gu, "/")).sort();
export const newScratch = (name: string) => mkdtemp(path.join(os.tmpdir(), "openhub-" + name + "-"));
