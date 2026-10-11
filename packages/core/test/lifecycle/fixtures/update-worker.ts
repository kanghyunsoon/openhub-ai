// v0.2.1 P0-3 강제 종료 E2E용 worker(OPENHUB_E2E 테스트에서만 실행). argv[2] = JSON 명령.
// { op: "update"|"recover", holdAt?, toolId, client, scope, base, projectRoot, homeDir, holdDir }
// - update: 승인·실행한다. holdAt이 없거나 "health"면 Health 실행 중(runHealth)에 <holdDir>/in-health를 만들고 멈춘다.
//   holdAt이 그 밖의 단계(config-replace·config-replaced·state-commit·journal-cleanup)면 그 단계 trace에서 <holdDir>/in-<단계>를 만들고
//   event loop 전체를 막고 멈춘다(= 일시 정지). <holdDir>/release가 생기면 계속한다. 테스트는 보통 이 상태에서 강제 종료한다.
// - recover: 남은 Journal의 undo 복구를 승인·실행한다. holdAt이 recover-write·recover-cleanup이면 그 지점에서 같은 방식으로 멈춘다.
// 결과는 stdout에 JSON 한 줄: { status, code }.
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  executeRecovery,
  planLifecycleRequest,
  planRecovery,
  requestLifecycleApproval,
  requestRecoveryApproval,
  runLifecycleTransaction,
  type LifecycleEnvironment,
  type LifecycleRequest,
} from "../../../src/index";
import { createHarness } from "../../installer/harness";
import { seedEntries } from "../../recommendation/helpers";
import { fakeNpmSpawner } from "../../process/fake-npm";

type Cmd = { op?: "update" | "recover"; holdAt?: string; toolId: string; client: "cursor" | "claude-code" | "codex"; scope: "project" | "user"; base: string; projectRoot: string; homeDir: string; holdDir: string };
const cmd = JSON.parse(process.argv[2]!) as Cmd;
const seed = await seedEntries();
const h = await createHarness(cmd.base, { entries: seed, dirs: { base: cmd.base, projectRoot: cmd.projectRoot, homeDir: cmd.homeDir } });

/** 멈춤: 표시 파일을 만들고 release가 생길 때까지 event loop 전체를 막는다(일시 정지된 프로세스와 같다). */
function hold(phase: string) {
  writeFileSync(path.join(cmd.holdDir, "in-" + phase), String(process.pid));
  const cell = new Int32Array(new SharedArrayBuffer(4));
  while (!existsSync(path.join(cmd.holdDir, "release"))) Atomics.wait(cell, 0, 0, 20);
}

if (cmd.op === "recover") {
  const opts = { toolId: cmd.toolId, projectRoot: cmd.projectRoot, homeDir: cmd.homeDir, mode: "undo" as const };
  const built = await planRecovery(opts);
  if (!built.ok) throw new Error(built.code);
  const o = await requestRecoveryApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (o.status !== "approved") throw new Error(o.status);
  const r = await executeRecovery(o.approval, { ...opts, regenerate: () => planRecovery(opts), trace: (phase) => (phase === cmd.holdAt ? hold(phase) : undefined) });
  process.stdout.write(JSON.stringify({ status: r.status, code: r.error?.code ?? null }) + "\n");
} else {
  const holdInHealth = cmd.holdAt === undefined || cmd.holdAt === "health";
  const env: LifecycleEnvironment = {
    loadEntries: async () => seed,
    probe: () => h.env.probe(),
    tempBase: cmd.base,
    now: () => new Date(),
    fetch: async (url: string) => {
      const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
      if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
      if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "f".repeat(64) } });
      if (url.endsWith("server-memory/latest")) return json({ name: "@modelcontextprotocol/server-memory", version: "1.2.3" });
      return new Response("missing", { status: 404 });
    },
    configFs: h.env.configFs!,
    spawner: fakeNpmSpawner({ cacheRoot: path.join(cmd.base, "npm-cache-" + process.pid) }).spawner,
    trace: (phase) => (!holdInHealth && phase === cmd.holdAt ? hold(phase) : undefined),
    runHealth: async (verified) => {
      if (holdInHealth) {
        writeFileSync(path.join(cmd.holdDir, "in-health"), String(process.pid));
        // 타이머로 event loop를 붙잡아 둔다(Promise만으로는 Node가 스스로 끝난다). release가 생기면 healthy로 계속한다.
        await new Promise<void>((resolve) => {
          const t = setInterval(() => {
            if (existsSync(path.join(cmd.holdDir, "release"))) {
              clearInterval(t);
              resolve();
            }
          }, 20);
        });
      }
      return { ok: true, result: { status: "healthy", reason: null, toolCount: 3, environmentUnverified: verified.plan.requiredEnv.some((e) => e.required), terminated: true, excerpt: null } };
    },
  };
  const request: LifecycleRequest = { operation: "update", toolId: cmd.toolId, projectRoot: cmd.projectRoot, homeDir: cmd.homeDir, platform: "linux", includeUser: cmd.scope === "user", targets: [{ client: cmd.client, scope: cmd.scope }] };
  const built = await planLifecycleRequest(request, env);
  if (!built.ok) throw new Error(built.code + " " + built.message);
  const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
  if (outcome.status !== "approved") throw new Error(outcome.status);
  const r = await runLifecycleTransaction(built.planned, outcome.approval, request, env);
  process.stdout.write(JSON.stringify({ status: r.status, code: r.code ?? null }) + "\n");
}
