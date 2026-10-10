import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  KUBERNETES_TOOL_CONFIG,
  REVIEWED_TOOL_CONFIGS,
  createTreeKiller,
  lifecycleStatus,
  locateWindowsNpxLauncher,
  nodeExecSpawner,
  npmChildEnv,
  planLifecycle,
  recordInstallInState,
  requestLifecycleApproval,
  runInstallTransaction,
  runLifecycleTransaction,
  type InstallEnvironment,
  type LifecycleEnvironment,
  type LifecycleRequest,
  type RegistryEntry,
} from "../../src/index";
import { approveAll, createHarness, plannedOf } from "../installer/harness";
import { seedEntries } from "../recommendation/helpers";

/**
 * v0.2.0 Kubernetes tool config 실제 E2E(OPENHUB_E2E=1에서만). 승인된 InstallPlan·LifecyclePlan을 끝까지 실행한다.
 * 실제 npm(npx Prepare, 임시 npm cache)과 실제 kubernetes-mcp-server@0.0.67을 쓴다. 클러스터·자격증명은 쓰지 않는다:
 * 127.0.0.1 합성 Kubernetes API(가짜 Secret·ConfigMap, Secret 요청 카운터)와 가짜 bearer token kubeconfig만 쓴다.
 * home 경로에 공백·괄호·&·한글을 넣는다. 실제 Registry Manifest(registry/mcp/kubernetes-mcp-server.yaml)를 쓴다.
 * MCP 서버는 각 Client 설정 파일에 OpenHub가 실제로 쓴 command·args를 그대로(shell 없이) 실행한다.
 */
const platform = process.platform === "win32" ? "windows" : "linux";
const TOKEN = ["openhub", "e2e", "fake", "bearer", "9931"].join("-");
const SECRET_PLAIN = ["openhub", "e2e", "fake", "secret", "value"].join("-");
const SECRET_B64 = Buffer.from(SECRET_PLAIN).toString("base64");
const meta = (name: string) => ({ name, namespace: "default", uid: name + "-uid", resourceVersion: "1", creationTimestamp: "2026-10-01T00:00:00Z" });
const secret = { apiVersion: "v1", kind: "Secret", metadata: meta("demo"), type: "Opaque", data: { password: SECRET_B64 } };
const configMap = { apiVersion: "v1", kind: "ConfigMap", metadata: meta("app-config"), data: { LOG_LEVEL: "info" } };
const ROUTES: Record<string, unknown> = {
  "/version": { major: "1", minor: "31", gitVersion: "v1.31.0" },
  "/api": { kind: "APIVersions", versions: ["v1"], serverAddressByClientCIDRs: [] },
  "/apis": { kind: "APIGroupList", apiVersion: "v1", groups: [] },
  "/api/v1": {
    kind: "APIResourceList",
    groupVersion: "v1",
    resources: [
      { name: "secrets", singularName: "secret", namespaced: true, kind: "Secret", verbs: ["get", "list"] },
      { name: "configmaps", singularName: "configmap", namespaced: true, kind: "ConfigMap", verbs: ["get", "list"] },
      { name: "pods", singularName: "pod", namespaced: true, kind: "Pod", verbs: ["get", "list"] },
      { name: "namespaces", singularName: "namespace", namespaced: false, kind: "Namespace", verbs: ["get", "list"] },
    ],
  },
  "/api/v1/namespaces/default/secrets/demo": secret,
  "/api/v1/namespaces/default/secrets": { kind: "SecretList", apiVersion: "v1", metadata: { resourceVersion: "1" }, items: [secret] },
  "/api/v1/namespaces/default/configmaps/app-config": configMap,
};

type Tool = { name: string; annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean } };
type Reply = { error?: { message: string }; result?: { isError?: boolean } };

async function session(command: string, args: string[], cwd: string, calls: { name: string; arguments: Record<string, unknown> }[]): Promise<{ tools: Tool[]; replies: Reply[]; transcript: string }> {
  const windows = process.platform === "win32";
  const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: !windows });
  const closed = new Promise<void>((resolve) => child.on("close", () => resolve()));
  let buffer = "";
  let transcript = "";
  const waiters = new Map<number, (m: Record<string, unknown>) => void>();
  child.stdout.on("data", (d: Buffer) => {
    transcript += d.toString();
    buffer += d.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (typeof m["id"] === "number") waiters.get(m["id"])?.(m);
      } catch {
        // 로그 줄
      }
    }
  });
  child.stderr.on("data", (d: Buffer) => (transcript += d.toString()));
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const k = ++id;
      const timer = setTimeout(() => reject(new Error("timeout " + method + " " + transcript.slice(-300))), 120_000);
      waiters.set(k, (m) => (clearTimeout(timer), resolve(m)));
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: k, method, params }) + "\n");
    });
  try {
    await request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "openhub-e2e", version: "0" } });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const tools = ((await request("tools/list", {}))["result"] as { tools: Tool[] }).tools;
    const replies: Reply[] = [];
    for (const c of calls) replies.push((await request("tools/call", c)) as Reply);
    return { tools, replies, transcript };
  } finally {
    if (child.pid !== undefined) await createTreeKiller({ cwd: os.tmpdir() })(child.pid, windows ? "windows" : "linux");
    await closed;
  }
}

const CALLS = [
  { name: "resources_get", arguments: { apiVersion: "v1", kind: "Secret", namespace: "default", name: "demo" } },
  { name: "resources_list", arguments: { apiVersion: "v1", kind: "Secret", namespace: "default" } },
  { name: "resources_get", arguments: { apiVersion: "v1", kind: "ConfigMap", namespace: "default", name: "app-config" } },
  { name: "configuration_view", arguments: { minified: false } },
  { name: "resources_delete", arguments: { apiVersion: "v1", kind: "ConfigMap", namespace: "default", name: "app-config" } },
  { name: "resources_create_or_update", arguments: { resource: "{}" } },
  { name: "pods_exec", arguments: { namespace: "default", name: "x", command: ["id"] } },
];
const BANNED = ["configuration_view", "pods_delete", "pods_exec", "pods_run", "resources_create_or_update", "resources_delete", "resources_scale"];

describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("v0.2.0 Kubernetes tool config 실제 E2E(승인된 설치·Health·drift·repair)", () => {
  it("승인된 Plan으로 설치한 Client 설정 그대로 실행하면 Secret get·list가 거부되고 ConfigMap은 읽히며, drift를 repair 뒤에도 같다", async () => {
    const requests: string[] = [];
    const api = http.createServer((req, res) => {
      const p = (req.url ?? "").split("?")[0]!;
      requests.push(p);
      const body = ROUTES[p];
      res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
      res.end(JSON.stringify(body ?? { kind: "Status", apiVersion: "v1", status: "Failure", code: 404, reason: "NotFound" }));
    });
    await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
    const port = (api.address() as { port: number }).port;
    // 공백·괄호·&·한글이 있는 경로(home·project 모두 이 아래에 생긴다).
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub e2e (k8s) & 한글-"));
    const npmCache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
    const saved = { cache: process.env["npm_config_cache"], kube: process.env["KUBECONFIG"] };
    try {
      const kubeconfig = path.join(scratch, "kubeconfig.yaml");
      await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster: { server: 'http://127.0.0.1:" + String(port) + "' }\ncontexts:\n- name: fake\n  context: { cluster: fake, user: fake, namespace: default }\ncurrent-context: fake\nusers:\n- name: fake\n  user: { token: " + TOKEN + " }\n");
      process.env["npm_config_cache"] = npmCache;
      process.env["KUBECONFIG"] = kubeconfig;

      // 실제 Registry Manifest(registry/mcp/kubernetes-mcp-server.yaml). 검토된 명령과 같아야 한다.
      const entries: RegistryEntry[] = await seedEntries();
      const k8s = entries.find((x) => x.manifest.name === "kubernetes-mcp-server")!.manifest;
      expect(k8s.install.options?.["command"]).toBe(REVIEWED_TOOL_CONFIGS["kubernetes-mcp-server"]!.commands[0]);
      expect(k8s.toolConfig?.content).toBe(KUBERNETES_TOOL_CONFIG);
      const h = await createHarness(scratch, { entries });
      const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
      const { spawner: _fake, ...rest } = h.env;
      const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const request = { ...h.request("kubernetes-mcp-server", (["claude-code", "codex", "cursor"] as const).map((client) => ({ client, scope: "project" as const }))), platform } as const;
      const planned = await plannedOf({ ...h, env }, request);
      expect(planned.plan.steps.map((s) => s.kind)).toEqual(["run", "tool-config", "config-patch", "config-patch", "config-patch"]);
      const t0 = Date.now();
      const result = await runInstallTransaction(planned, await approveAll(planned), request, env);
      console.log("k8s install ms " + String(Date.now() - t0) + " " + JSON.stringify({ status: result.status, code: result.code, steps: result.steps.map((s) => s.id + ":" + s.status) }));
      expect(result.status).toBe("succeeded");
      expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 3 });

      // 3개 Client 설정에 OpenHub가 실제로 쓴 command·args.
      const claude = JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).mcpServers.kubernetes as { command: string; args: string[] };
      const cursor = JSON.parse(await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8")).mcpServers.kubernetes as { command: string; args: string[] };
      const codex = (parseToml(await readFile(path.join(h.projectRoot, ".codex", "config.toml"), "utf8")) as { mcp_servers: Record<string, { command: string; args: string[] }> }).mcp_servers["kubernetes"]!;
      for (const [label, e] of [["claude-code", claude], ["cursor", cursor], ["codex", codex]] as const) {
        console.log("k8s client " + label + ": " + JSON.stringify({ command: path.basename(e.command), args: e.args.map((a) => (path.isAbsolute(a) ? "<abs:" + path.basename(a) + ">" : a)) }));
        expect(e.command).not.toBe("cmd");
        if (platform === "windows") expect(e.command).toBe(windowsNpx!.node);
        const config = e.args[e.args.indexOf("--config") + 1]!;
        expect(config.startsWith(h.homeDir)).toBe(true);
        expect(await readFile(config, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
      }
      expect(cursor).toEqual(claude);
      expect(codex).toEqual(claude);

      const lifecycleEnv: LifecycleEnvironment = { loadEntries: async () => entries, probe: h.env.probe, tempBase: os.tmpdir(), now: () => new Date(), spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const runOp = async (operation: LifecycleRequest["operation"]) => {
        const req: LifecycleRequest = { operation, toolId: "kubernetes-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform, includeUser: false };
        const built = await planLifecycle({ ...req, entries });
        if (!built.ok) throw new Error(built.code);
        const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
        if (outcome.status !== "approved") throw new Error(outcome.status);
        return runLifecycleTransaction(built.planned, outcome.approval, req, lifecycleEnv);
      };
      const health = await runOp("health");
      console.log("k8s health " + JSON.stringify(health.health));
      expect(health).toMatchObject({ status: "health-checked", health: { status: "healthy" } });
      // (선택) 실제 Client 프로그램 확인: OPENHUB_E2E_REAL_CLIENTS=1이고 claude·codex CLI가 있을 때만. 사용자 설정은 쓰지 않는다
      // (CLAUDE_CONFIG_DIR·CODEX_HOME·HOME을 임시 디렉터리로 바꾸고, 테스트 프로젝트 안에서만 승인·trust를 준다. OpenHub가 하는 일이 아니다).
      if (process.env["OPENHUB_E2E_REAL_CLIENTS"] === "1") {
        const clientHome = path.join(scratch, "client home");
        await mkdir(path.join(clientHome, ".claude-config"), { recursive: true });
        await mkdir(path.join(clientHome, ".codex"), { recursive: true });
        await mkdir(path.join(h.projectRoot, ".claude"), { recursive: true });
        await writeFile(path.join(h.projectRoot, ".claude", "settings.local.json"), JSON.stringify({ enabledMcpjsonServers: ["kubernetes"] }));
        // 격리된 Claude 설정의 프로젝트 승인 상태(사용자가 claude에서 승인한 것과 같은 상태). 경로 표기 두 가지를 모두 넣는다.
        const approved = { hasTrustDialogAccepted: true, enabledMcpjsonServers: ["kubernetes"], disabledMcpjsonServers: [] };
        const claudeProjects = { [h.projectRoot]: approved, [h.projectRoot.replace(/\\/gu, "/")]: approved };
        await writeFile(path.join(clientHome, ".claude-config", ".claude.json"), JSON.stringify({ projects: claudeProjects }));
        await writeFile(path.join(clientHome, ".codex", "config.toml"), "[projects." + JSON.stringify(h.projectRoot) + "]\ntrust_level = \"trusted\"\n");
        const clientEnv = { ...process.env, HOME: clientHome, USERPROFILE: clientHome, CLAUDE_CONFIG_DIR: path.join(clientHome, ".claude-config"), CODEX_HOME: path.join(clientHome, ".codex") };
        const run = (exe: string, args: string[]) =>
          new Promise<{ code: number | null; out: string }>((resolve) => {
            const child = spawn(exe, args, { cwd: h.projectRoot, env: clientEnv, shell: process.platform === "win32" && exe === "codex", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            let out = "";
            child.stdout.on("data", (d: Buffer) => (out += d.toString()));
            child.stderr.on("data", (d: Buffer) => (out += d.toString()));
            child.on("close", (code) => resolve({ code, out }));
            child.on("error", () => resolve({ code: -1, out }));
          });
        const claudeList = await run("claude", ["mcp", "list"]);
        console.log("k8s real claude: " + claudeList.out.replace(/[A-Za-z]:\\[^\s"]*/gu, "<abs>").replace(/\s+/gu, " ").slice(0, 400));
        expect(claudeList.out).toMatch(/kubernetes:.*(✓|Connected)/u);
        const codexList = await run("codex", ["mcp", "list"]);
        console.log("k8s real codex: " + codexList.out.replace(/[A-Za-z]:\\[^\s"]*/gu, "<abs>").replace(/\s+/gu, " ").slice(0, 400));
        expect(codexList.out).toContain("kubernetes");
      }


      const check = async (label: string) => {
        const before = requests.filter((r) => r.includes("/secrets")).length;
        const s = await session(claude.command, claude.args, h.projectRoot, CALLS);
        const names = s.tools.map((t) => t.name).sort();
        console.log("k8s " + label + " tools: " + names.join(","));
        for (const t of s.tools) {
          expect(t.annotations?.readOnlyHint, t.name).toBe(true);
          expect(t.annotations?.destructiveHint ?? false, t.name).toBe(false);
        }
        for (const banned of BANNED) expect(names).not.toContain(banned);
        const [getSecret, listSecret, getConfigMap, configView, del, create, exec] = s.replies;
        for (const r of [getSecret, listSecret]) {
          expect(r?.result?.isError, label).toBe(true);
          expect(JSON.stringify(r), label).toMatch(/resource not allowed/u);
        }
        expect(getConfigMap?.result?.isError ?? false, label).toBe(false);
        expect(JSON.stringify(getConfigMap)).toContain("LOG_LEVEL");
        for (const r of [configView, del, create, exec]) expect(r?.error?.message ?? "", label).toMatch(/unknown tool/u);
        expect(s.transcript).not.toContain(TOKEN);
        expect(s.transcript).not.toContain(SECRET_B64);
        expect(s.transcript).not.toContain(SECRET_PLAIN);
        expect(requests.filter((r) => r.includes("/secrets")).length, label).toBe(before);
      };
      await check("installed");

      // drift: 다른 프로세스가 Secret 거부 규칙을 지우면 status가 잡고 Health는 막힌다. repair(승인) 뒤 다시 거부된다.
      const configPath = claude.args[claude.args.indexOf("--config") + 1]!;
      await writeFile(configPath, 'read_only = true\ntoolsets = ["core"]\n');
      const status = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: false });
      expect(status.ok && status.items.filter((i) => i.serverName === "kubernetes").map((i) => i.state)).toEqual(["tool-config-drift", "tool-config-drift", "tool-config-drift"]);
      const blocked = await planLifecycle({ operation: "health", toolId: "kubernetes-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: false });
      expect(blocked.ok && blocked.planned.plan.status).toBe("blocked");
      const repaired = await runOp("repair");
      console.log("k8s repair " + JSON.stringify({ status: repaired.status, health: repaired.health?.status }));
      expect(repaired).toMatchObject({ status: "repaired", health: { status: "healthy" } });
      expect(await readFile(configPath, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
      await check("repaired");
    } finally {
      if (saved.cache === undefined) delete process.env["npm_config_cache"];
      else process.env["npm_config_cache"] = saved.cache;
      if (saved.kube === undefined) delete process.env["KUBECONFIG"];
      else process.env["KUBECONFIG"] = saved.kube;
      api.close();
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 900_000);
});

