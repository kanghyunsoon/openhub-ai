import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PROBE_ALLOWLIST,
  PROBE_TIMEOUT_MS,
  containsAbsolutePath,
  evaluateCompatibility,
  probeBackends,
  probeExecutable,
  probeToRecommendContext,
  serializeInstallPlan,
  type HostFs,
  type ProbeEnvironment,
  type ProbeSpawner,
} from "../../src/index";
import { seedEntries } from "../recommendation/helpers";
import { clientProfile, entryOf, planFor, reportFor } from "./helpers";

const seed = await seedEntries();
const INSTALLER_SRC = path.resolve(import.meta.dirname, "../../src/installer");
const PROCESS_SRC = path.resolve(import.meta.dirname, "../../src/process");
afterEach(() => vi.useRealTimers());

/** 메모리 파일 시스템. 실제 PATH·디스크를 읽지 않는다. */
function memoryFs(files: Record<string, string>): HostFs & { reads: string[] } {
  const norm = (f: string) => f.replace(/\\/gu, "/").toLowerCase();
  const table = new Map(Object.entries(files).map(([k, v]) => [norm(k), v]));
  const reads: string[] = [];
  return {
    reads,
    async stat(file) {
      const content = table.get(norm(file));
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isFile: () => true, size: content.length };
    },
    async readFile(file) {
      reads.push(file);
      const content = table.get(norm(file));
      if (content === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return content;
    },
  };
}

interface Call {
  file: string;
  args: readonly string[];
  shell: unknown;
}
function recordingSpawner(stdout: (file: string) => string = () => "v22.11.0\n", exitCode = 0): ProbeSpawner & { calls: Call[] } {
  const calls: Call[] = [];
  const spawner = (async (file, args, options) => {
    calls.push({ file, args: [...args], shell: options.shell });
    return { exitCode, stdout: stdout(file) };
  }) as ProbeSpawner & { calls: Call[] };
  spawner.calls = calls;
  return spawner;
}

const WIN_PATH = "C:\\Users\\X\\AppData\\Roaming\\npm;C:\\Program Files\\nodejs;C:\\Users\\X\\.local\\bin;C:\\Program Files\\Docker\\bin";
const winEnv = (files: Record<string, string>, spawner: ProbeSpawner): Partial<ProbeEnvironment> => ({
  platform: "win32",
  pathEnv: WIN_PATH,
  pathExt: ".COM;.EXE;.BAT;.CMD;.VBS;.JS",
  fs: memoryFs(files),
  spawner,
  timeoutMs: PROBE_TIMEOUT_MS,
});
const WIN_FILES = {
  "C:\\Program Files\\nodejs\\node.exe": "",
  "C:\\Program Files\\nodejs\\npx": "#!/bin/sh",
  "C:\\Program Files\\nodejs\\npx.cmd": "@echo off",
  "C:\\Program Files\\nodejs\\npx.ps1": "",
  "C:\\Program Files\\nodejs\\node_modules\\npm\\package.json": '{"name":"npm","version":"10.9.2"}',
  "C:\\Users\\X\\.local\\bin\\uvx.exe": "",
  "C:\\Program Files\\Docker\\bin\\docker.exe": "",
};

const stripComments = (src: string) => src.replace(/\/\*[\s\S]*?\*\//gu, "").replace(/\/\/.*$/gmu, "");
async function importsOf(file: string, dir = PROCESS_SRC): Promise<string[]> {
  const src = await readFile(path.join(dir, file), "utf8");
  return [...src.matchAll(/^\s*(?:import|export)\b[^;]*?from\s+"([^"]+)"/gmu)].map((m) => m[1]!);
}

describe("REQ-030 Runtime·Backend Probe", () => {
  it("AC-029-01 probe allowlist는 정확히 node·npx·uvx·docker이고 그 밖의 이름은 spawn 없이 거부한다", async () => {
    expect([...PROBE_ALLOWLIST]).toEqual(["node", "npx", "uvx", "docker"]);
    const spawner = recordingSpawner();
    const fs = memoryFs({ "/usr/bin/npm": "", "/usr/bin/uv": "", "/usr/bin/rm": "", "/usr/bin/node": "" });
    for (const name of ["npm", "uv", "rm", "node; rm", "../node", "C:\\x\\node.exe", "/usr/bin/node", "NODE"]) {
      const outcome = await probeExecutable(name, { platform: "linux", pathEnv: "/usr/bin", pathExt: "", fs, spawner });
      expect(outcome, name).toMatchObject({ ok: false, code: "PROBE_NOT_ALLOWED" });
      expect(containsAbsolutePath(JSON.stringify(outcome))).toBe(false);
      expect(JSON.stringify(outcome)).not.toContain(";");
    }
    expect(spawner.calls).toEqual([]);
  });

  it("AC-029-02 실제 실행 파일에만 고정 인자 --version, shell:false로 spawn한다", async () => {
    const spawner = recordingSpawner((file) => (/docker/iu.test(file) ? "Docker version 27.3.1, build ce12230\n" : /uvx/iu.test(file) ? "uvx 0.5.11\n" : "v22.11.0\n"));
    const report = await probeBackends(winEnv(WIN_FILES, spawner));
    expect(spawner.calls.map((c) => path.win32.basename(c.file))).toEqual(["node.exe", "uvx.exe", "docker.exe"]);
    for (const call of spawner.calls) expect(call).toMatchObject({ args: ["--version"], shell: false });
    expect(report).toEqual({
      node: { name: "node", available: true, version: "22.11.0", status: "ok" },
      npx: { name: "npx", available: true, version: "10.9.2", status: "shim-not-executed" },
      uvx: { name: "uvx", available: true, version: "0.5.11", status: "ok" },
      docker: { name: "docker", available: true, version: "27.3.1", status: "ok" },
    });
    const posix = recordingSpawner();
    await probeBackends({ platform: "linux", pathEnv: "/usr/local/bin:/usr/bin", pathExt: "", fs: memoryFs({ "/usr/bin/node": "", "/usr/bin/npx": "" }), spawner: posix });
    expect(posix.calls.map((c) => [c.file.replace(/\\/gu, "/"), c.args, c.shell])).toEqual([
      ["/usr/bin/node", ["--version"], false],
      ["/usr/bin/npx", ["--version"], false],
    ]);
  });

  it("AC-029-03 3,000ms가 지나면 프로세스를 종료(abort)하고 timeout·available unknown으로 기록한다", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const hanging: ProbeSpawner = (_file, _args, options) => {
      signal = options.signal;
      return new Promise(() => undefined);
    };
    const pending = probeExecutable("docker", { platform: "linux", pathEnv: "/usr/bin", pathExt: "", fs: memoryFs({ "/usr/bin/docker": "" }), spawner: hanging, timeoutMs: PROBE_TIMEOUT_MS });
    let settled = false;
    void pending.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ ok: true, snapshot: { name: "docker", available: "unknown", version: null, status: "timeout" } });
    expect(signal?.aborted).toBe(true);
    expect(PROBE_TIMEOUT_MS).toBe(3000);
  });

  it("AC-029-04 stdout은 4KB에서 자르고 버전을 해석할 수 없으면 version null이다", async () => {
    let limit = 0;
    const big: ProbeSpawner = async (_f, _a, options) => ((limit = options.maxStdoutBytes), { exitCode: 0, stdout: "x".repeat(5000) + " 9.9.9" });
    const base = { platform: "linux" as const, pathEnv: "/usr/bin", pathExt: "", fs: memoryFs({ "/usr/bin/node": "" }) };
    expect(await probeExecutable("node", { ...base, spawner: big })).toEqual({ ok: true, snapshot: { name: "node", available: true, version: null, status: "ok" } });
    expect(limit).toBe(4096);
    const garbage: ProbeSpawner = async () => ({ exitCode: 0, stdout: "no version here" });
    expect(await probeExecutable("node", { ...base, spawner: garbage })).toMatchObject({ snapshot: { version: null, status: "ok" } });
    const failing: ProbeSpawner = async () => ({ exitCode: 1, stdout: "v1.2.3" });
    expect(await probeExecutable("node", { ...base, spawner: failing })).toMatchObject({ snapshot: { available: "unknown", version: null, status: "error" } });
  });

  it("AC-029-05 PATH에 사용자 절대 경로를 넣어도 결과·Plan 어디에도 절대 경로나 PATH 원문이 없다", async () => {
    const spawner = recordingSpawner((file) => "v22.11.0 " + file);
    const report = await probeBackends(winEnv(WIN_FILES, spawner));
    const text = JSON.stringify(report);
    expect(containsAbsolutePath(text)).toBe(false);
    for (const leak of ["Users", "Program Files", "AppData", WIN_PATH]) expect(text).not.toContain(leak);
    const planned = planFor(seed, reportFor(clientProfile(), seed), "memory-mcp", {
      backend: { adapter: "npx", selection: "preferred", skipped: [], probe: report.npx },
    });
    const plan = serializeInstallPlan(planned.plan);
    expect(containsAbsolutePath(plan)).toBe(false);
    expect(plan).not.toContain("Program Files");
  });

  it("AC-029-06 Windows shim(.cmd·.bat·.ps1)만 있으면 spawn 0회이고 version은 npm package.json에서만 읽는다", async () => {
    const shimOnly = { "C:\\Program Files\\nodejs\\npx.cmd": "", "C:\\Program Files\\nodejs\\node_modules\\npm\\package.json": '{"version":"10.9.2"}' };
    const spawner = recordingSpawner();
    expect(await probeExecutable("npx", winEnv(shimOnly, spawner))).toEqual({ ok: true, snapshot: { name: "npx", available: true, version: "10.9.2", status: "shim-not-executed" } });
    expect(await probeExecutable("npx", winEnv({ "C:\\Program Files\\nodejs\\npx.cmd": "" }, spawner))).toMatchObject({ snapshot: { available: true, version: null } });
    expect(await probeExecutable("uvx", winEnv({ "C:\\Users\\X\\.local\\bin\\uvx.bat": "" }, spawner))).toMatchObject({ snapshot: { available: true, version: null, status: "shim-not-executed" } });
    expect(await probeExecutable("docker", winEnv({ "C:\\Program Files\\Docker\\bin\\docker.ps1": "" }, spawner))).toMatchObject({ snapshot: { status: "shim-not-executed" } });
    // PATH 순서상 shim이 먼저면 뒤의 실제 실행 파일도 실행하지 않는다(Client가 실행할 것과 다를 수 있다).
    expect(await probeExecutable("node", winEnv({ "C:\\Users\\X\\AppData\\Roaming\\npm\\node.cmd": "", "C:\\Program Files\\nodejs\\node.exe": "" }, spawner))).toMatchObject({ snapshot: { status: "shim-not-executed" } });
    expect(spawner.calls).toEqual([]);

    const all = recordingSpawner();
    await probeBackends(winEnv(WIN_FILES, all));
    for (const call of all.calls) {
      expect(call.shell).toBe(false);
      expect(call.file).not.toMatch(/\.(?:cmd|bat|ps1)$|cmd\.exe$/iu);
      expect(call.args.join(" ")).not.toContain("/c");
    }
    const src = stripComments(await readFile(path.join(PROCESS_SRC, "probe.ts"), "utf8"));
    for (const banned of ["shell: true", "shell:true", "cmd.exe", "/c", "process.env"]) expect(src).not.toContain(banned);
  });

  it("AC-029-07 probe 모듈과 executor 모듈은 서로 import하지 않는다", async () => {
    const files = (await readdir(PROCESS_SRC)).filter((f) => f.endsWith(".ts"));
    const probeImports = await importsOf("probe.ts");
    expect(probeImports.some((s) => /executor|backends/u.test(s))).toBe(false);
    for (const dep of probeImports.filter((s) => s.startsWith("../installer/"))) {
      expect((await importsOf(dep.slice("../installer/".length) + ".ts", INSTALLER_SRC)).some((s) => /executor|probe/u.test(s)), dep).toBe(false);
    }
    for (const file of files.filter((f) => f !== "probe.ts")) {
      expect((await importsOf(file)).some((s) => /probe/u.test(s)), file).toBe(false);
    }
    // 프로세스 실행 코드는 installer 디렉터리에 없다(M1 AC-005-04와 같은 불변식).
    for (const file of await readdir(INSTALLER_SRC)) expect(file).not.toMatch(/probe|executor/u);
  });

  it("AC-029-08 probe 결과가 RecommendContext로 들어가 backend·node runtime이 compatible/incompatible이 되고 python은 unknown이다", async () => {
    const p = clientProfile();
    const memory = entryOf(seed, "memory-mcp").manifest;
    const postgres = entryOf(seed, "postgres-mcp").manifest;
    const ok = probeToRecommendContext(await probeBackends(winEnv(WIN_FILES, recordingSpawner((f) => (/node/iu.test(f) ? "v22.11.0" : "1.0.0")))), "windows");
    expect(ok.runtimes).toEqual({ node: "22.11.0" });
    expect(ok.runtimes?.node).not.toBe(process.versions.node === "22.11.0" ? "never" : process.versions.node);
    expect(evaluateCompatibility(memory, p, ok)).toMatchObject({ runtime: { status: "compatible" }, backend: { status: "compatible" } });
    expect(evaluateCompatibility(postgres, p, ok)).toMatchObject({ runtime: { status: "unknown" }, backend: { status: "compatible" } });

    const old = probeToRecommendContext(
      await probeBackends({ platform: "linux", pathEnv: "/usr/bin", pathExt: "", fs: memoryFs({ "/usr/bin/node": "" }), spawner: recordingSpawner(() => "v16.20.0") }),
      "linux",
    );
    expect(old.availableBackends).toEqual([]);
    expect(evaluateCompatibility(memory, p, old)).toMatchObject({ runtime: { status: "incompatible" }, backend: { status: "incompatible" } });
    expect(evaluateCompatibility(postgres, p, old)).toMatchObject({ runtime: { status: "unknown" }, backend: { status: "incompatible" } });
  });

  it("AC-029-08 timeout·error backend는 근거 없이 제외하지 않고 node가 timeout이면 runtime은 unknown이다", () => {
    const snap = (name: "node" | "npx" | "uvx" | "docker", available: boolean | "unknown", status: "ok" | "timeout" | "not-found" | "error") => ({ name, available, version: null, status });
    const ctx = probeToRecommendContext({ node: snap("node", "unknown", "timeout"), npx: snap("npx", false, "not-found"), uvx: snap("uvx", "unknown", "error"), docker: snap("docker", "unknown", "timeout") });
    expect(ctx).toEqual({ runtimes: {}, availableBackends: ["uvx", "docker"] });
    expect(evaluateCompatibility(entryOf(seed, "memory-mcp").manifest, clientProfile(), ctx)).toMatchObject({ runtime: { status: "unknown" }, backend: { status: "incompatible" } });
  });
});
