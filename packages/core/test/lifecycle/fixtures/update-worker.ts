// v0.2.1 P0-3 강제 종료 E2E용 worker(OPENHUB_E2E 테스트에서만 실행). argv[2] = JSON { toolId, client, scope, base, projectRoot, homeDir, holdDir }.
// update를 승인·실행하고 Health 단계에서 <holdDir>/in-health를 만든 뒤 끝없이 기다린다. 테스트가 이 프로세스(트리)를 강제 종료한다.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { planLifecycleRequest, requestLifecycleApproval, runLifecycleTransaction, type LifecycleEnvironment, type LifecycleRequest } from "../../../src/index";
import { createHarness } from "../../installer/harness";
import { seedEntries } from "../../recommendation/helpers";
import { fakeNpmSpawner } from "../../process/fake-npm";

const cmd = JSON.parse(process.argv[2]!) as { toolId: string; client: "cursor" | "claude-code" | "codex"; scope: "project" | "user"; base: string; projectRoot: string; homeDir: string; holdDir: string };
const seed = await seedEntries();
const h = await createHarness(cmd.base, { entries: seed, dirs: { base: cmd.base, projectRoot: cmd.projectRoot, homeDir: cmd.homeDir } });
const env: LifecycleEnvironment = {
  loadEntries: async () => seed,
  probe: () => h.env.probe(),
  tempBase: cmd.base,
  now: () => new Date(),
  fetch: async (url: string) => {
    const json = (doc: unknown) => new Response(JSON.stringify(doc), { status: 200 });
    if (url.startsWith("https://ghcr.io/token")) return json({ token: "anon" });
    if (url.includes("/manifests/")) return new Response(null, { status: 200, headers: { "docker-content-digest": "sha256:" + "f".repeat(64) } });
    return new Response("missing", { status: 404 });
  },
  configFs: h.env.configFs!,
  spawner: fakeNpmSpawner({ cacheRoot: path.join(cmd.base, "npm-cache-" + process.pid) }).spawner,
  runHealth: async () => {
    await writeFile(path.join(cmd.holdDir, "in-health"), String(process.pid));
    // 타이머로 event loop를 붙잡아 둔다(Promise만으로는 Node가 스스로 끝난다). 테스트가 강제 종료할 때까지 Health에 머문다.
    setInterval(() => undefined, 1_000);
    return new Promise(() => undefined);
  },
};
const request: LifecycleRequest = { operation: "update", toolId: cmd.toolId, projectRoot: cmd.projectRoot, homeDir: cmd.homeDir, platform: "linux", includeUser: cmd.scope === "user", targets: [{ client: cmd.client, scope: cmd.scope }] };
const built = await planLifecycleRequest(request, env);
if (!built.ok) throw new Error(built.code + " " + built.message);
const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
if (outcome.status !== "approved") throw new Error(outcome.status);
await runLifecycleTransaction(built.planned, outcome.approval, request, env);
