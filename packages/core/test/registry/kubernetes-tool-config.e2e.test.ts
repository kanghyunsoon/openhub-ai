import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  TOOL_CONFIG_PLACEHOLDER,
  createTreeKiller,
  inspectToolConfig,
  locateWindowsNpxLauncher,
  npmToolArgv,
  substituteToolConfig,
  toolConfigDigest,
  toolConfigLocation,
  writeToolConfig,
} from "../../src/index";

/**
 * v0.2.0 Kubernetes tool config 실제 E2E(OPENHUB_E2E=1에서만). 실제 kubernetes-mcp-server(고정 버전)를 npx로 실행한다.
 * 합성 Kubernetes API(127.0.0.1, 가짜 Secret 1개·ConfigMap 1개)와 가짜 bearer token kubeconfig만 쓴다. 실제 클러스터·자격증명 없음.
 * npm cache·home은 임시 디렉터리다. OpenHub tool-config 모듈로 설정 파일을 쓰고, Health와 같은 argv(shell 없음)로,
 * Windows에서는 Client 설정과 같은 cmd /d /c npx 경로로도 실행한다(D-016: OpenHub 자신은 cmd를 실행하지 않는다. 여기서는 Client를 흉내 낸다).
 */
const VERSION = process.env["OPENHUB_E2E_K8S_VERSION"] ?? "0.0.67";
const platform = process.platform === "win32" ? "windows" : "linux";
const TOKEN = ["openhub", "e2e", "fake", "bearer", "9931"].join("-");
const SECRET_PLAIN = ["openhub", "e2e", "fake", "secret", "value"].join("-");
const SECRET_B64 = Buffer.from(SECRET_PLAIN).toString("base64");
const TOML = 'read_only = true\ntoolsets = ["core"]\n\n[[denied_resources]]\ngroup = ""\nversion = "v1"\nkind = "Secret"\n';
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

async function session(argv: string[], cwd: string, env: NodeJS.ProcessEnv, calls: { name: string; arguments: Record<string, unknown> }[]): Promise<{ tools: Tool[]; replies: Reply[]; transcript: string }> {
  const windows = process.platform === "win32";
  const child = spawn(argv[0]!, argv.slice(1), { cwd, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"], detached: !windows });
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
      const timer = setTimeout(() => reject(new Error("timeout " + method)), 300_000);
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
];

describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("v0.2.0 Kubernetes tool config 실제 E2E", () => {
  it("OpenHub가 쓴 denied_resources 설정으로 Secret get·list가 거부되고 ConfigMap은 읽히며 token·Secret 값이 나오지 않는다(설정 없는 대조군은 Secret이 읽힌다)", async () => {
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
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-k8s-"));
    const npmCache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
    try {
      const kubeconfig = path.join(scratch, "kubeconfig.yaml");
      await writeFile(kubeconfig, "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster: { server: 'http://127.0.0.1:" + String(port) + "' }\ncontexts:\n- name: fake\n  context: { cluster: fake, user: fake, namespace: default }\ncurrent-context: fake\nusers:\n- name: fake\n  user: { token: " + TOKEN + " }\n");
      const env = { ...process.env, KUBECONFIG: kubeconfig, npm_config_cache: npmCache };
      const loc = toolConfigLocation({ homeDir: scratch, scope: "user", toolId: "kubernetes-mcp-server" })!;
      expect(await writeToolConfig(loc, TOML, { state: "absent" })).toMatchObject({ kind: "created" });
      const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
      const base = ["-y", "kubernetes-mcp-server@" + VERSION, "--read-only", "--toolsets", "core"];
      const sub = substituteToolConfig([...base, "--config", TOOL_CONFIG_PLACEHOLDER], loc.file, platform);
      if (!sub.ok) throw new Error(sub.message);
      const healthArgv = npmToolArgv("npx", sub.args, platform, windowsNpx);
      const controlArgv = npmToolArgv("npx", base, platform, windowsNpx);
      if (healthArgv === null || controlArgv === null) throw new Error("launcher-not-found");

      // 대조군: 설정 없이는 같은 합성 API에서 Secret 데이터가 읽힌다(합성 API가 실제로 Secret을 돌려준다는 증거).
      const control = await session([controlArgv.executable, ...controlArgv.args], scratch, env, CALLS.slice(0, 1));
      expect(JSON.stringify(control.replies[0])).toContain(SECRET_B64);
      const secretRequestsBefore = requests.filter((r) => r.includes("/secrets")).length;

      const runs = [{ label: "health-argv", argv: [healthArgv.executable, ...healthArgv.args] }];
      if (platform === "windows") runs.push({ label: "client-cmd-wrapper", argv: ["cmd", "/d", "/c", "npx", ...sub.args] });
      for (const run of runs) {
        const s = await session(run.argv, scratch, env, CALLS);
        const names = s.tools.map((t) => t.name).sort();
        console.log("k8s " + run.label + " tools: " + names.join(","));
        for (const t of s.tools) {
          expect(t.annotations?.readOnlyHint, t.name).toBe(true);
          expect(t.annotations?.destructiveHint ?? false, t.name).toBe(false);
        }
        for (const banned of ["configuration_view", "pods_delete", "pods_exec", "pods_run", "resources_create_or_update", "resources_delete", "resources_scale"]) expect(names, run.label).not.toContain(banned);
        const [getSecret, listSecret, getConfigMap, configView] = s.replies;
        for (const r of [getSecret, listSecret]) {
          expect(r?.result?.isError, run.label).toBe(true);
          expect(JSON.stringify(r), run.label).toMatch(/resource not allowed/u);
        }
        expect(getConfigMap?.result?.isError ?? false, run.label).toBe(false);
        expect(JSON.stringify(getConfigMap), run.label).toContain("LOG_LEVEL");
        expect(configView?.error?.message ?? "", run.label).toMatch(/unknown tool/u);
        expect(s.transcript, run.label).not.toContain(TOKEN);
        expect(s.transcript, run.label).not.toContain(SECRET_B64);
        expect(s.transcript, run.label).not.toContain(SECRET_PLAIN);
      }
      // 설정이 적용된 실행에서는 Secret 요청이 API에 도달하지 않는다.
      expect(requests.filter((r) => r.includes("/secrets")).length).toBe(secretRequestsBefore);
      // 파일은 승인한 내용 그대로이고, 바꾸면 digest가 달라진다(drift 판정 근거).
      expect(await inspectToolConfig(loc)).toEqual({ state: "present", digest: toolConfigDigest(TOML) });
      await writeFile(loc.file, TOML.replace('kind = "Secret"', 'kind = "ConfigMap"'));
      expect(await inspectToolConfig(loc)).not.toEqual({ state: "present", digest: toolConfigDigest(TOML) });
    } finally {
      api.close();
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
      await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 900_000);
});

