// v0.2.1 B 다중 프로세스 작업 경쟁용 worker(OPENHUB_E2E 테스트에서만 실행). argv[2] = JSON 명령.
// { op: "install"|"update"|"health", toolId, client, base, projectRoot, homeDir, holdDir? }
// holdDir가 있으면 update·health는 Health 단계에서 <holdDir>/in-health(pid 기록)를 만들고 <holdDir>/release가 생길 때까지 기다린다(= Health 대기 중).
// install은 설정을 쓰고 확인한 뒤 Version State 기록 직전(trace "record")에 <holdDir>/in-record를 만들고, release가 생길 때까지
// event loop 전체를 막고 멈춘다(= 일시 정지된 프로세스). install은 CLI·Desktop과 같은 Core 진입점 runInstallAndRecord를 쓴다.
// 결과는 stdout에 JSON 한 줄: { status, code }.
import { existsSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  planLifecycleRequest,
  requestLifecycleApproval,
  runInstallAndRecord,
  runLifecycleTransaction,
  type LifecycleEnvironment,
  type LifecycleRequest,
} from "../../../src/index";
import { approveAll, createHarness, plannedOf } from "../../installer/harness";
import { seedWithNpxFixture } from "../../recommendation/helpers";
import { fakeNpmSpawner } from "../../process/fake-npm";

const cmd = JSON.parse(process.argv[2]!) as { op: "install" | "update" | "health"; toolId: string; client: "claude-code" | "cursor" | "codex"; base: string; projectRoot: string; homeDir: string; holdDir?: string };
const seed = await seedWithNpxFixture();
const h = await createHarness(cmd.base, { entries: seed, dirs: { base: cmd.base, projectRoot: cmd.projectRoot, homeDir: cmd.homeDir } });
const targets = [{ client: cmd.client, scope: "project" as const }];

if (cmd.op === "install") {
  const request = h.request(cmd.toolId, targets);
  const planned = await plannedOf(h, request);
  const holdDir = cmd.holdDir;
  const trace = (phase: string) => {
    if (phase !== "record" || holdDir === undefined) return;
    writeFileSync(path.join(holdDir, "in-record"), String(process.pid));
    const cell = new Int32Array(new SharedArrayBuffer(4));
    while (!existsSync(path.join(holdDir, "release"))) Atomics.wait(cell, 0, 0, 20);
  };
  const { result: r, recorded } = await runInstallAndRecord(planned, await approveAll(planned), request, { ...h.env, trace }, { now: () => new Date() });
  process.stdout.write(JSON.stringify({ status: r.status, code: r.code ?? null, recorded }) + "\n");
} else {
  const env: LifecycleEnvironment = {
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: cmd.base,
    now: () => new Date(),
    fetch: async (url: string) => {
      const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
      if (url.endsWith("npx-mcp/latest")) return json({ name: "@openhub-fixture/npx-mcp", version: "1.2.3" });
      if (url === "https://pypi.org/pypi/postgres-mcp/json") return json({ info: { name: "postgres-mcp", version: "0.3.0" } });
      return new Response("missing", { status: 404 });
    },
    configFs: h.env.configFs!,
    // v0.2.1(#46): MCP 실행 환경 원본이 없으면 npx·uvx 계획이 PACKAGE_SOURCE_UNVERIFIED로 막힌다. 이 worker의 Health는 가짜이므로
    // 명시적인 빈 환경(출처 설정 없음 = 기본 공개 registry·index)을 넘긴다. #46 이후 이 값이 없어 이 E2E가 계획 단계에서 실패했다.
    mcpSourceEnv: () => ({}),
    spawner: fakeNpmSpawner({ cacheRoot: path.join(cmd.base, "npm-cache-" + process.pid) }).spawner,
    runHealth: async (verified) => {
      if (cmd.holdDir !== undefined) {
        await writeFile(path.join(cmd.holdDir, "in-health"), String(process.pid));
        while (!existsSync(path.join(cmd.holdDir, "release"))) await new Promise((r) => setTimeout(r, 20));
      }
      return { ok: true, result: { status: "healthy", reason: null, toolCount: 3, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null } };
    },
  };
  const request: LifecycleRequest = { operation: cmd.op, toolId: cmd.toolId, projectRoot: cmd.projectRoot, homeDir: cmd.homeDir, platform: "linux", includeUser: false, targets };
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) {
    process.stdout.write(JSON.stringify({ status: "plan-failed", code: built.code }) + "\n");
  } else {
    const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
    if (outcome.status !== "approved") throw new Error(outcome.status);
    const r = await runLifecycleTransaction(built.planned, outcome.approval, request, env);
    process.stdout.write(JSON.stringify({ status: r.status, code: r.code ?? null }) + "\n");
  }
}
