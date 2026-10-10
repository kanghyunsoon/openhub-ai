import http from "node:http";
import os from "node:os";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { describe, expect, it } from "vitest";
import {
  KUBERNETES_TOOL_CONFIG,
  REVIEWED_TOOL_CONFIGS,
  clientLauncherDigest,
  containsAbsolutePath,
  createTreeKiller,
  installTargetChange,
  lifecycleStatus,
  locateWindowsNpxLauncher,
  nodeExecSpawner,
  npmChildEnv,
  planLifecycle,
  planLifecycleRequest,
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

/** codex.cmd를 shell로 띄우지 않도록 npm 전역 설치의 @openai/codex/bin/codex.js를 찾는다(node로 shell 없이 실행). */
function findCodexJs(): string | null {
  const override = process.env["OPENHUB_E2E_CODEX_JS"];
  if (override !== undefined && override !== "") return override;
  for (const dir of (process.env["PATH"] ?? "").split(path.delimiter)) {
    if (dir === "") continue;
    const js = path.join(dir, "node_modules", "@openai", "codex", "bin", "codex.js");
    if (existsSync(js)) return js;
  }
  return null;
}

type CodexItem = { type?: string; server?: string; tool?: string; arguments?: unknown; result?: unknown; error?: unknown; status?: string };

/**
 * Codex 실제 MCP 연결·호출(OPENHUB_E2E_CODEX_EXEC=1). OpenHub가 프로젝트 .codex/config.toml에 쓴 kubernetes 항목(command·args)을
 * 그대로 읽어 명령줄 -c override로 codex exec에 넘기고, 모델이 ConfigMap·Secret 조회를 tools/call로 시도하게 한다.
 * 프로젝트 파일 자체를 읽게 하지 않는 이유: Codex CLI 0.147.0에서 --ignore-user-config + -c projects.<root>.trust_level 조합으로는
 * 프로젝트 .codex/config.toml의 서버가 로드되지 않았다(2026-10-10 실측: tool 없음, MCP 오류 없음. 원인은 확인하지 못했다).
 * 사용자 설정을 쓰지 않고 trust를 주는 다른 방법이 없어서, 이 검사는 "OpenHub가 쓴 실행 명세로 Codex가 서버를 띄우고 호출한다"까지이고,
 * "프로젝트 파일 인식"은 codex mcp list가 따로 확인한다. 두 근거를 합쳐도 Codex의 프로젝트 파일 → 실행 경로 자체는 직접 확인한 것이 아니다.
 * 격리:
 * - --ignore-user-config: 사용자 ~/.codex/config.toml을 읽지 않는다(로그인 정보만 CODEX_HOME에서 읽는다). --ephemeral: 세션 파일 없음.
 * - -s read-only, approval_policy never. 사용자 설정 파일·로그인 파일을 쓰거나 복사하지 않는다.
 * - HOME·USERPROFILE은 가짜 ~/.kube/config만 있는 임시 디렉터리다(KUBECONFIG가 전달되지 않아도 실제 kubeconfig에 닿지 않는다).
 */
async function codexExecCheck(o: { scratch: string; projectRoot: string; kubeconfig: string; requests: string[] }) {
  const codexJs = findCodexJs();
  expect(codexJs, "codex.js(npm 전역 @openai/codex)").not.toBeNull();
  const codexHome = process.env["CODEX_HOME"] ?? path.join(os.homedir(), ".codex");
  const isoHome = path.join(o.scratch, "codex exec home");
  await mkdir(path.join(isoHome, ".kube"), { recursive: true });
  await writeFile(path.join(isoHome, ".kube", "config"), await readFile(o.kubeconfig, "utf8"));
  const before = o.requests.filter((r) => r.includes("/secrets")).length;
  const written = (parseToml(await readFile(path.join(o.projectRoot, ".codex", "config.toml"), "utf8")) as { mcp_servers: Record<string, { command: string; args: string[] }> }).mcp_servers["kubernetes"]!;
  // JSON 문자열 표기는 TOML basic string과 같다(\\, \", \uXXXX). 값은 OpenHub가 쓴 항목 그대로다.
  const overrides = ["mcp_servers.kubernetes.command=" + JSON.stringify(written.command), "mcp_servers.kubernetes.args=[" + written.args.map((a) => JSON.stringify(a)).join(",") + "]"];
  const prompt = [
    "Use only the MCP server named kubernetes. Do not run shell commands and do not read files.",
    "Step 1: call the tool resources_get with apiVersion v1, kind ConfigMap, namespace default, name app-config, and report the value of LOG_LEVEL.",
    "Step 2: call the tool resources_get with apiVersion v1, kind Secret, namespace default, name demo, and report only whether the call succeeded or was refused. Do not print secret data.",
  ].join(" ");
  const args = [codexJs!, "exec", "--json", "--ephemeral", "--skip-git-repo-check", "--ignore-user-config", "-s", "read-only", "-C", o.projectRoot,
    ...overrides.flatMap((v) => ["-c", v]), "-c", 'approval_policy="never"', prompt];
  const env = { ...process.env, HOME: isoHome, USERPROFILE: isoHome, CODEX_HOME: codexHome, KUBECONFIG: o.kubeconfig };
  const out = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, args, { cwd: o.projectRoot, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 300_000);
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => (clearTimeout(timer), resolve({ code, stdout, stderr })));
    child.on("error", () => (clearTimeout(timer), resolve({ code: -1, stdout, stderr })));
  });
  const events = out.stdout.split("\n").flatMap((l) => {
    try {
      return [JSON.parse(l) as { type?: string; item?: CodexItem }];
    } catch {
      return [];
    }
  });
  const calls = events.filter((e) => e.type === "item.completed" && e.item?.type === "mcp_tool_call").map((e) => e.item!);
  const summary = calls.map((c) => ({ server: c.server, tool: c.tool, kind: (c.arguments as { kind?: string } | undefined)?.kind, status: c.status, refused: /resource not allowed/u.test(JSON.stringify(c.result ?? c.error ?? "")), logLevel: JSON.stringify(c.result ?? "").includes("LOG_LEVEL") }));
  const scrub = (s: string) => s.replace(/[A-Za-z]:\\[^\s"]*/gu, "<abs>").replace(/\s+/gu, " ");
  console.log("k8s codex exec: " + JSON.stringify({ exit: out.code, types: [...new Set(events.map((e) => e.type))], calls: summary }));
  if (calls.length === 0) console.log("k8s codex exec tail: " + scrub(out.stdout.slice(-800) + " | " + out.stderr.slice(-800)));
  const mcpLines = out.stderr.split("\n").filter((l) => /mcp|kubernetes|trust|project/iu.test(l)).slice(0, 20);
  if (calls.length === 0) console.log("k8s codex exec mcp stderr: " + JSON.stringify(mcpLines.map(scrub)));
  expect(calls.length, "Codex가 kubernetes MCP tool을 실제로 호출해야 한다").toBeGreaterThan(0);
  expect(calls.every((c) => c.server === "kubernetes")).toBe(true);
  expect(summary.some((c) => c.kind === "ConfigMap" && c.logLevel)).toBe(true);
  expect(summary.some((c) => c.kind === "Secret" && c.refused)).toBe(true);
  for (const s of [out.stdout, out.stderr]) {
    expect(s).not.toContain(TOKEN);
    expect(s).not.toContain(SECRET_B64);
    expect(s).not.toContain(SECRET_PLAIN);
  }
  expect(o.requests.filter((r) => r.includes("/secrets")).length).toBe(before);
}

/**
 * Codex 프로젝트 설정 → 실제 MCP 실행·호출(OPENHUB_E2E_CODEX_APP_SERVER=1, 모델 호출 0). Codex CLI의 app-server(JSON-RPC, stdio)를
 * 띄워 thread/start(cwd = 테스트 프로젝트) → mcpServerStatus/list → mcpServer/tool/call 순서로 부른다. 격리:
 * - CODEX_HOME = 임시 디렉터리. 그 config.toml에는 테스트 프로젝트 trust 한 줄만 있다. 사용자 ~/.codex는 읽지도 쓰지도 않는다.
 * - 로그인 파일·API key를 쓰지 않는다(자식 환경에서 OPENAI_API_KEY·CODEX_API_KEY를 지운다). turn/start(모델 호출)를 부르지 않는다.
 * - HOME·USERPROFILE은 가짜 ~/.kube/config만 있는 임시 디렉터리다.
 */
async function codexAppServerCheck(o: { scratch: string; projectRoot: string; kubeconfig: string; requests: string[] }) {
  // 대조군: trust가 없는 격리 CODEX_HOME에서는 프로젝트 .codex/config.toml의 서버가 로드되지 않는다(= 아래 결과는 프로젝트 파일에서 온 것).
  const untrusted = await codexAppServerSession({ ...o, trust: false });
  expect(untrusted.servers, "trust 없음").not.toContain("kubernetes");
  const trusted = await codexAppServerSession({ ...o, trust: true });
  expect(trusted.servers).toContain("kubernetes");
  console.log("codex project servers: " + JSON.stringify({ untrusted: untrusted.servers, trusted: trusted.servers, tools: trusted.tools.length }));
  expect(trusted.tools).toHaveLength(13);
  for (const banned of BANNED) expect(trusted.tools).not.toContain(banned);
}

async function codexAppServerSession(o: { scratch: string; projectRoot: string; kubeconfig: string; requests: string[]; trust: boolean }): Promise<{ servers: string[]; tools: string[] }> {
  const codexJs = findCodexJs();
  expect(codexJs, "codex.js(npm 전역 @openai/codex)").not.toBeNull();
  const codexHome = path.join(o.scratch, "codex isolated home " + (o.trust ? "trusted" : "untrusted"));
  const isoHome = path.join(o.scratch, "codex user home " + (o.trust ? "trusted" : "untrusted"));
  await mkdir(codexHome, { recursive: true });
  await mkdir(path.join(isoHome, ".kube"), { recursive: true });
  await writeFile(path.join(isoHome, ".kube", "config"), await readFile(o.kubeconfig, "utf8"));
  await writeFile(path.join(codexHome, "config.toml"), o.trust ? "[projects." + JSON.stringify(o.projectRoot) + "]\ntrust_level = \"trusted\"\n" : "");
  const env: Record<string, string> = { ...(process.env as Record<string, string>), CODEX_HOME: codexHome, HOME: isoHome, USERPROFILE: isoHome, KUBECONFIG: o.kubeconfig };
  for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "CODEX_ACCESS_TOKEN"]) delete env[k];
  const before = o.requests.filter((r) => r.includes("/secrets")).length;
  const child = spawn(process.execPath, [codexJs!, "app-server"], { cwd: o.projectRoot, env, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = "";
  let transcript = "";
  const pending = new Map<number, (m: Record<string, unknown>) => void>();
  const methods: string[] = [];
  child.stdout.on("data", (d: Buffer) => {
    transcript += d.toString();
    buffer += d.toString();
    let i: number;
    while ((i = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, i).trim();
      buffer = buffer.slice(i + 1);
      if (line === "") continue;
      try {
        const m = JSON.parse(line) as Record<string, unknown>;
        if (typeof m["method"] === "string") {
          methods.push(m["method"] as string);
          // 서버가 보낸 요청(승인 등)은 거절한다.
          if (m["id"] !== undefined) child.stdin.write(JSON.stringify({ id: m["id"], error: { code: -32601, message: "not supported in test" } }) + "\n");
        } else if (typeof m["id"] === "number") pending.get(m["id"] as number)?.(m);
      } catch {
        // 로그 줄
      }
    }
  });
  let stderr = "";
  child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
  let id = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const k = ++id;
      const timer = setTimeout(() => reject(new Error("timeout " + method + " " + stderr.slice(-400))), 120_000);
      pending.set(k, (m) => (clearTimeout(timer), resolve(m)));
      child.stdin.write(JSON.stringify({ id: k, method, params }) + "\n");
    });
  const scrub = (s: string) => s.replace(/[A-Za-z]:\\[^\s"]*/gu, "<abs>").replace(/\s+/gu, " ");
  try {
    const init = await request("initialize", { clientInfo: { name: "openhub-e2e", version: "0" }, capabilities: { experimentalApi: true } });
    child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
    const thread = await request("thread/start", { cwd: o.projectRoot, ephemeral: true, sandbox: "read-only", approvalPolicy: "never" });
    console.log("codex app-server: " + scrub(JSON.stringify({ init: Object.keys(init), threadError: thread["error"] ?? null })));
    const threadId = (thread["result"] as { thread?: { id?: string } } | undefined)?.thread?.id;
    expect(threadId, "thread/start " + scrub(JSON.stringify(thread).slice(0, 600))).toBeTruthy();
    const status = await request("mcpServerStatus/list", { threadId, detail: "full" });
    const data = ((status["result"] as { data?: { name: string; tools?: Record<string, unknown> }[] } | undefined)?.data ?? []);
    const servers = data.map((s) => s.name).sort();
    const tools = Object.keys(data.find((s) => s.name === "kubernetes")?.tools ?? {}).sort();
    if (!o.trust) return { servers, tools };
    const calls = [
      { name: "configmap", arguments: { apiVersion: "v1", kind: "ConfigMap", namespace: "default", name: "app-config" } },
      { name: "secret-get", arguments: { apiVersion: "v1", kind: "Secret", namespace: "default", name: "demo" } },
    ];
    const results: Record<string, string> = {};
    for (const c of calls) {
      const r = await request("mcpServer/tool/call", { threadId, server: "kubernetes", tool: "resources_get", arguments: c.arguments });
      results[c.name] = JSON.stringify(r);
    }
    console.log("codex tool calls: " + scrub(JSON.stringify(Object.fromEntries(Object.entries(results).map(([k, v]) => [k, v.slice(0, 300)])))));
    expect(results["configmap"]).toContain("LOG_LEVEL");
    expect(results["secret-get"]).toMatch(/resource not allowed/u);
    for (const s of [transcript, stderr]) {
      expect(s).not.toContain(TOKEN);
      expect(s).not.toContain(SECRET_B64);
      expect(s).not.toContain(SECRET_PLAIN);
    }
    expect(o.requests.filter((r) => r.includes("/secrets")).length).toBe(before);
    expect(methods).not.toContain("turn/started");
    return { servers, tools };
  } finally {
    if (child.pid !== undefined) await createTreeKiller({ cwd: os.tmpdir() })(child.pid, process.platform === "win32" ? "windows" : "linux");
  }
}

/** 127.0.0.1 합성 Kubernetes API(ROUTES만 응답, 요청 경로 기록). */
async function startFakeApi(): Promise<{ port: number; requests: string[]; close: () => void }> {
  const requests: string[] = [];
  const api = http.createServer((req, res) => {
    const p = (req.url ?? "").split("?")[0]!;
    requests.push(p);
    const body = ROUTES[p];
    res.writeHead(body === undefined ? 404 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify(body ?? { kind: "Status", apiVersion: "v1", status: "Failure", code: 404, reason: "NotFound" }));
  });
  await new Promise<void>((r) => api.listen(0, "127.0.0.1", () => r()));
  return { port: (api.address() as { port: number }).port, requests, close: () => api.close() };
}
const kubeconfigText = (port: number) =>
  "apiVersion: v1\nkind: Config\nclusters:\n- name: fake\n  cluster: { server: 'http://127.0.0.1:" + String(port) + "' }\ncontexts:\n- name: fake\n  context: { cluster: fake, user: fake, namespace: default }\ncurrent-context: fake\nusers:\n- name: fake\n  user: { token: " + TOKEN + " }\n";


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
        // CLI·Desktop과 같은 경로(planLifecycleRequest: Windows 실행 경로 검증 포함). 실행 직전 재생성도 같은 함수다.
        const built = await planLifecycleRequest(req, lifecycleEnv);
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
      // (선택) Codex 실제 MCP 연결·호출: OPENHUB_E2E_CODEX_EXEC=1일 때만. codex exec가 OpenHub가 쓴 프로젝트 .codex/config.toml로
      // 서버를 띄우고 모델이 tools/call을 하게 한다(로그인된 Codex 계정·모델 호출을 쓴다).
      if (process.env["OPENHUB_E2E_CODEX_EXEC"] === "1") await codexExecCheck({ scratch, projectRoot: h.projectRoot, kubeconfig, requests });
      // (선택) Codex 프로젝트 설정 → 실제 MCP 실행·호출(모델 호출 0): OPENHUB_E2E_CODEX_APP_SERVER=1일 때만.
      if (process.env["OPENHUB_E2E_CODEX_APP_SERVER"] === "1") await codexAppServerCheck({ scratch, projectRoot: h.projectRoot, kubeconfig, requests });


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


/**
 * v0.2.0 P0-3 C2 사용자 범위 실제 E2E(OPENHUB_E2E=1). 실제 npm·실제 kubernetes-mcp-server@0.0.67을 사용자 범위(Cursor·Codex 사용자 설정)로
 * 설치하고, 실제 Health(MCP handshake)와 실제 MCP 호출(Secret 거부·ConfigMap 성공)을 확인한다. 사용자 tool config drift → includeUser
 * 상태 → 승인한 repair(user-scope-config) → 실제 Health·MCP 호출. 127.0.0.1 합성 Kubernetes API와 가짜 token kubeconfig만 쓴다.
 */
describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("v0.2.0 Kubernetes 사용자 범위 실제 E2E(설치·Health·drift·repair)", () => {
  it("사용자 범위 설치 → 실제 Health·MCP 호출 → drift → 승인 repair → 실제 Health. 기존 사용자 설정 항목은 그대로다", async () => {
    const api = await startFakeApi();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub e2e (user) & 한글-"));
    const npmCache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
    const saved = { cache: process.env["npm_config_cache"], kube: process.env["KUBECONFIG"] };
    try {
      const kubeconfig = path.join(scratch, "kubeconfig.yaml");
      await writeFile(kubeconfig, kubeconfigText(api.port));
      process.env["npm_config_cache"] = npmCache;
      process.env["KUBECONFIG"] = kubeconfig;
      const entries: RegistryEntry[] = await seedEntries();
      const h = await createHarness(scratch, { entries });
      // 사용자가 이미 가진 사용자 설정(다른 서버·다른 키). OpenHub 항목만 추가되어야 한다.
      const cursorUser = '{\n  "theme": "dark",\n  "mcpServers": {\n    "notes": { "command": "uvx", "args": ["notes-mcp==1.0.0"] }\n  }\n}\n';
      const codexUser = '# mine\nmodel = "o4"\n\n[mcp_servers.notes]\ncommand = "uvx"\nargs = ["notes-mcp==1.0.0"]\n';
      await mkdir(path.join(h.homeDir, ".cursor"), { recursive: true });
      await mkdir(path.join(h.homeDir, ".codex"), { recursive: true });
      await writeFile(path.join(h.homeDir, ".cursor", "mcp.json"), cursorUser);
      await writeFile(path.join(h.homeDir, ".codex", "config.toml"), codexUser);
      const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
      const { spawner: _fake, ...rest } = h.env;
      const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const request = { ...h.request("kubernetes-mcp-server", (["codex", "cursor"] as const).map((client) => ({ client, scope: "user" as const }))), platform } as const;
      const planned = await plannedOf({ ...h, env }, request);
      expect(planned.plan.approvalRequirements).toContain("user-scope-config");
      expect(planned.plan.targets.map((t) => [t.client, t.scope, t.file])).toEqual([
        ["codex", "user", "~/.codex/config.toml"],
        ["cursor", "user", "~/.cursor/mcp.json"],
      ]);
      const result = await runInstallTransaction(planned, await approveAll(planned), request, env);
      console.log("k8s user install " + JSON.stringify({ status: result.status, steps: result.steps.map((s) => s.id + ":" + s.status) }));
      expect(result.status).toBe("succeeded");
      expect(await recordInstallInState(planned, result, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 2 });
      // 프로젝트 설정은 만들지 않았다. 사용자 설정의 기존 항목·키는 그대로다.
      for (const f of [".mcp.json", ".cursor", ".codex"]) expect(existsSync(path.join(h.projectRoot, f)), f).toBe(false);
      const cursorAfter = JSON.parse(await readFile(path.join(h.homeDir, ".cursor", "mcp.json"), "utf8")) as { theme: string; mcpServers: Record<string, { command: string; args: string[] }> };
      expect(cursorAfter.theme).toBe("dark");
      expect(cursorAfter.mcpServers["notes"]).toEqual({ command: "uvx", args: ["notes-mcp==1.0.0"] });
      expect((await readFile(path.join(h.homeDir, ".codex", "config.toml"), "utf8")).startsWith(codexUser)).toBe(true);
      const entry = cursorAfter.mcpServers["kubernetes"]!;
      const configPath = entry.args[entry.args.indexOf("--config") + 1]!;
      expect(configPath.startsWith(path.join(h.homeDir, ".openhub", "tool-config", "user"))).toBe(true);

      // 실제 MCP 서버: 사용자 설정에 쓴 command·args 그대로(shell 없이).
      const mcpCheck = async (label: string) => {
        const before = api.requests.filter((r) => r.includes("/secrets")).length;
        const s = await session(entry.command, entry.args, os.tmpdir(), CALLS);
        const [getSecret, listSecret, getConfigMap] = s.replies;
        for (const r of [getSecret, listSecret]) expect(JSON.stringify(r), label).toMatch(/resource not allowed/u);
        expect(JSON.stringify(getConfigMap), label).toContain("LOG_LEVEL");
        for (const banned of BANNED) expect(s.tools.map((t) => t.name), label).not.toContain(banned);
        expect(s.transcript).not.toContain(TOKEN);
        expect(s.transcript).not.toContain(SECRET_PLAIN);
        expect(api.requests.filter((r) => r.includes("/secrets")).length, label).toBe(before);
        return s.tools.length;
      };
      expect(await mcpCheck("user installed")).toBe(13);

      const lifecycleEnv: LifecycleEnvironment = { loadEntries: async () => entries, probe: h.env.probe, tempBase: os.tmpdir(), now: () => new Date(), spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const runOp = async (operation: LifecycleRequest["operation"]) => {
        const req: LifecycleRequest = { operation, toolId: "kubernetes-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform, includeUser: true, targets: [{ client: "cursor", scope: "user" }] };
        const built = await planLifecycleRequest(req, lifecycleEnv);
        if (!built.ok) throw new Error(built.code);
        const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
        if (outcome.status !== "approved") throw new Error(outcome.status);
        return { requirements: built.planned.plan.approvalRequirements, result: await runLifecycleTransaction(built.planned, outcome.approval, req, lifecycleEnv) };
      };
      const health = await runOp("health");
      console.log("k8s user health " + JSON.stringify(health.result.health));
      expect(health.result).toMatchObject({ status: "health-checked", health: { status: "healthy", toolCount: 13 } });

      // drift: 사용자 tool config에서 Secret 거부를 지운다. 사용자 범위를 볼 때만 잡히고, 보지 않으면 읽지 않는다(not-inspected).
      await writeFile(configPath, 'read_only = true\ntoolsets = ["core"]\n');
      const hidden = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: false });
      expect(hidden.ok && hidden.items.map((i) => i.state)).toEqual(["not-inspected", "not-inspected"]);
      const shown = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: true });
      expect(shown.ok && shown.items.map((i) => i.state)).toEqual(["tool-config-drift", "tool-config-drift"]);
      const repaired = await runOp("repair");
      console.log("k8s user repair " + JSON.stringify({ status: repaired.result.status, health: repaired.result.health?.status, requirements: repaired.requirements }));
      expect(repaired.requirements).toContain("user-scope-config");
      expect(repaired.result).toMatchObject({ status: "repaired", health: { status: "healthy" } });
      expect(await readFile(configPath, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
      expect(await mcpCheck("user repaired")).toBe(13);
      const after = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: true });
      expect(after.ok && after.items.map((i) => i.state)).toEqual(["state-consistent", "state-consistent"]);
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


describe.skipIf(process.env["OPENHUB_E2E"] !== "1")("v0.2.0 범위별 추가 설치 실제 E2E(Cursor 프로젝트 → Codex 프로젝트·Cursor 사용자 추가 → 실제 Health)", () => {
  it("이미 Cursor 프로젝트에 있는 Kubernetes MCP를 Codex 프로젝트·Cursor 사용자 범위에 추가하고, 추가한 대상 그대로 실제 Health·MCP 호출이 통과한다", async () => {
    const api = await startFakeApi();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub e2e (add) & 한글-"));
    const npmCache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
    const saved = { cache: process.env["npm_config_cache"], kube: process.env["KUBECONFIG"] };
    try {
      const kubeconfig = path.join(scratch, "kubeconfig.yaml");
      await writeFile(kubeconfig, kubeconfigText(api.port));
      process.env["npm_config_cache"] = npmCache;
      process.env["KUBECONFIG"] = kubeconfig;
      const entries: RegistryEntry[] = await seedEntries();
      const h = await createHarness(scratch, { entries });
      const windowsNpx = platform === "windows" ? await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } }) : null;
      const { spawner: _fake, ...rest } = h.env;
      const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const install = async (targets: { client: "codex" | "cursor"; scope: "project" | "user" }[]) => {
        const request = { ...h.request("kubernetes-mcp-server", targets), platform } as const;
        const planned = await plannedOf({ ...h, env }, request);
        return { planned, request, run: async () => runInstallTransaction(planned, await approveAll(planned), request, env) };
      };
      const first = await install([{ client: "cursor", scope: "project" }]);
      const r1 = await first.run();
      expect(r1.status, JSON.stringify(r1.steps)).toBe("succeeded");
      expect(await recordInstallInState(first.planned, r1, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 1 });
      const cursorBytes = await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8");

      // 추가: Cursor 프로젝트(변경 없음) + Codex 프로젝트(추가) + Cursor 사용자(추가). 새 대상만 쓴다.
      const second = await install([{ client: "codex", scope: "project" }, { client: "cursor", scope: "project" }, { client: "cursor", scope: "user" }]);
      expect(second.planned.plan.status).toBe("installable");
      expect(second.planned.plan.targets.map((t) => [t.client, t.scope, installTargetChange(second.planned.plan, t)])).toEqual([
        ["codex", "project", "add"],
        ["cursor", "project", "unchanged"],
        ["cursor", "user", "add"],
      ]);
      expect(second.planned.plan.approvalRequirements).toContain("user-scope-config");
      const r2 = await second.run();
      console.log("k8s add-elsewhere install " + JSON.stringify({ status: r2.status, changes: r2.configChanges.map((c) => c.client + ":" + c.scope + ":" + c.applied) }));
      expect(r2.status).toBe("succeeded");
      expect(r2.configChanges.map((c) => c.client + ":" + c.scope)).toEqual(["codex:project", "cursor:user"]);
      expect(await readFile(path.join(h.projectRoot, ".cursor", "mcp.json"), "utf8")).toBe(cursorBytes);
      expect(await recordInstallInState(second.planned, r2, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 2 });

      // 추가한 Codex 프로젝트 항목·Cursor 사용자 항목 그대로 실제 MCP 서버를 띄운다(shell 없이).
      const codexToml = await readFile(path.join(h.projectRoot, ".codex", "config.toml"), "utf8");
      const codexEntry = (parseToml(codexToml) as { mcp_servers: Record<string, { command: string; args: string[] }> }).mcp_servers["kubernetes"]!;
      const userEntry = (JSON.parse(await readFile(path.join(h.homeDir, ".cursor", "mcp.json"), "utf8")) as { mcpServers: Record<string, { command: string; args: string[] }> }).mcpServers["kubernetes"]!;
      for (const [label, entry] of [["codex project", codexEntry], ["cursor user", userEntry]] as const) {
        const before = api.requests.filter((r) => r.includes("/secrets")).length;
        const s = await session(entry.command, entry.args, os.tmpdir(), CALLS);
        expect(s.tools.length, label).toBe(13);
        for (const r of s.replies.slice(0, 2)) expect(JSON.stringify(r), label).toMatch(/resource not allowed/u);
        expect(JSON.stringify(s.replies[2]), label).toContain("LOG_LEVEL");
        for (const banned of BANNED) expect(s.tools.map((t) => t.name), label).not.toContain(banned);
        expect(s.transcript).not.toContain(TOKEN);
        expect(s.transcript).not.toContain(SECRET_PLAIN);
        expect(api.requests.filter((r) => r.includes("/secrets")).length, label).toBe(before);
      }

      // lifecycle Health(실제 MCP Health): 추가한 Codex 프로젝트 대상만.
      const lifecycleEnv: LifecycleEnvironment = { loadEntries: async () => entries, probe: h.env.probe, tempBase: os.tmpdir(), now: () => new Date(), spawner: nodeExecSpawner, windowsNpx: async () => windowsNpx, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const req: LifecycleRequest = { operation: "health", toolId: "kubernetes-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform, includeUser: false, targets: [{ client: "codex", scope: "project" }] };
      const built = await planLifecycleRequest(req, lifecycleEnv);
      if (!built.ok) throw new Error(built.code);
      const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (x) => x.requirements.map((y) => y.id) });
      if (outcome.status !== "approved") throw new Error(outcome.status);
      const health = await runLifecycleTransaction(built.planned, outcome.approval, req, lifecycleEnv);
      console.log("k8s add-elsewhere health " + JSON.stringify(health.health));
      expect(health).toMatchObject({ status: "health-checked", health: { status: "healthy", toolCount: 13 } });
      const status = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform, includeUser: true });
      expect(status.ok && status.items.map((i) => i.scope + ":" + i.client + ":" + i.state)).toEqual(["project:codex:state-consistent", "project:cursor:state-consistent", "user:cursor:state-consistent"]);
    } finally {
      if (saved.cache === undefined) delete process.env["npm_config_cache"];
      else process.env["npm_config_cache"] = saved.cache;
      if (saved.kube === undefined) delete process.env["KUBECONFIG"];
      else process.env["KUBECONFIG"] = saved.kube;
      api.close();
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 900_000);
});

/**
 * v0.2.0 client-launcher-invalid 실제 E2E(Windows, OPENHUB_E2E=1). 실제 node.exe·npm을 임시 위치(공백·괄호·&·한글)에 복사해
 * 그 경로로 설치한 뒤 복사본을 지워 "Node.js 이동·재설치"를 만든다. status가 잡고 Health는 막히며, 승인한 repair가 지금 Node.js로
 * 실행 경로만 바꾸고 실제 Health·실제 MCP 호출(Secret 거부·ConfigMap 성공)을 확인한다. 실제 Kubernetes·자격증명은 쓰지 않는다.
 */
describe.skipIf(process.env["OPENHUB_E2E"] !== "1" || process.platform !== "win32")("v0.2.0 Windows client launcher 실제 E2E(Node.js 이동 → client-launcher-invalid → 승인 repair)", () => {
  it("옮겨진 Node.js 경로를 status가 잡고, 승인한 repair가 실행 경로만 바꾼 뒤 실제 Health·MCP 호출이 통과한다", async () => {
    const api = await startFakeApi();
    const scratch = await mkdtemp(path.join(os.tmpdir(), "openhub e2e (launcher) & 한글-"));
    const npmCache = await mkdtemp(path.join(os.tmpdir(), "openhub-e2e-npmcache-"));
    const saved = { cache: process.env["npm_config_cache"], kube: process.env["KUBECONFIG"] };
    try {
      const kubeconfig = path.join(scratch, "kubeconfig.yaml");
      await writeFile(kubeconfig, kubeconfigText(api.port));
      process.env["npm_config_cache"] = npmCache;
      process.env["KUBECONFIG"] = kubeconfig;
      const system = await locateWindowsNpxLauncher({ pathEnv: process.env["PATH"] ?? "", fs: { stat } });
      expect(system).not.toBeNull();
      const oldDir = path.join(scratch, "Old Node (x86) & 한글", "nodejs");
      await mkdir(path.join(oldDir, "node_modules"), { recursive: true });
      await cp(system!.node, path.join(oldDir, "node.exe"));
      await cp(path.join(path.win32.dirname(system!.node), "node_modules", "npm"), path.join(oldDir, "node_modules", "npm"), { recursive: true });
      const old = { node: path.join(oldDir, "node.exe"), npxCli: path.join(oldDir, "node_modules", "npm", "bin", "npx-cli.js") };
      let current: { node: string; npxCli: string } = old;

      const entries: RegistryEntry[] = await seedEntries();
      const h = await createHarness(scratch, { entries });
      const { spawner: _fake, ...rest } = h.env;
      const env: InstallEnvironment = { ...rest, spawner: nodeExecSpawner, windowsNpx: async () => current, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const request = { ...h.request("kubernetes-mcp-server", (["claude-code", "codex", "cursor"] as const).map((client) => ({ client, scope: "project" as const }))), platform: "windows" as const };
      const planned = await plannedOf({ ...h, env }, request);
      const installed = await runInstallTransaction(planned, await approveAll(planned), request, env);
      expect(installed.status, JSON.stringify(installed.steps)).toBe("succeeded");
      expect(await recordInstallInState(planned, installed, { projectRoot: h.projectRoot, homeDir: h.homeDir, now: () => new Date() })).toMatchObject({ ok: true, recorded: 3 });
      const entryOf = async () => JSON.parse(await readFile(path.join(h.projectRoot, ".mcp.json"), "utf8")).mcpServers.kubernetes as { command: string; args: string[] };
      const before = await entryOf();
      expect(before.command).toBe(old.node);

      const lifecycleEnv: LifecycleEnvironment = { loadEntries: async () => entries, probe: h.env.probe, tempBase: os.tmpdir(), now: () => new Date(), spawner: nodeExecSpawner, windowsNpx: async () => current, killTree: createTreeKiller({ cwd: os.tmpdir() }), npmChildEnv: () => npmChildEnv(process.env) };
      const statusOf = async () => {
        const s = await lifecycleStatus({ projectRoot: h.projectRoot, homeDir: h.homeDir, entries, platform: "windows", includeUser: false });
        if (!s.ok) throw new Error(s.code);
        return s.items.filter((i) => i.serverName === "kubernetes");
      };
      const req = (operation: LifecycleRequest["operation"]): LifecycleRequest => ({ operation, toolId: "kubernetes-mcp-server", projectRoot: h.projectRoot, homeDir: h.homeDir, platform: "windows", includeUser: false });
      expect((await statusOf()).map((i) => i.state)).toEqual(["state-consistent", "state-consistent", "state-consistent"]);

      // Node.js 이동·재설치: 옛 설치가 사라진다. Client 설정 byte는 그대로다.
      await rm(oldDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      const invalid = await statusOf();
      console.log("launcher status after move: " + JSON.stringify(invalid.map((i) => ({ client: i.client, state: i.state, launcher: i.launcher }))));
      expect(invalid.map((i) => i.state)).toEqual(["client-launcher-invalid", "client-launcher-invalid", "client-launcher-invalid"]);
      expect(containsAbsolutePath(JSON.stringify(invalid))).toBe(false);
      expect(await entryOf()).toEqual(before);
      const health = await planLifecycleRequest(req("health"), lifecycleEnv);
      expect(health.ok && health.planned.plan.warnings.map((w) => w.code)).toContain("CLIENT_LAUNCHER_INVALID");

      // 지금 PATH의 Node.js로 repair(승인 필수).
      current = system!;
      const built = await planLifecycleRequest(req("repair"), lifecycleEnv);
      if (!built.ok) throw new Error(built.code);
      expect(built.planned.plan.status).toBe("ready");
      expect(built.planned.plan.targets.map((t) => t.launcher)).toEqual(Array(3).fill({ recorded: "invalid", replacementDigest: clientLauncherDigest(system!) }));
      const outcome = await requestLifecycleApproval(built.planned, { channel: "cli-tty", confirm: async (r) => r.requirements.map((x) => x.id) });
      if (outcome.status !== "approved") throw new Error(outcome.status);
      const t0 = Date.now();
      const repaired = await runLifecycleTransaction(built.planned, outcome.approval, req("repair"), lifecycleEnv);
      console.log("launcher repair ms " + String(Date.now() - t0) + " " + JSON.stringify({ status: repaired.status, health: repaired.health?.status, toolCount: repaired.health?.toolCount, steps: repaired.steps.map((s) => s.id + ":" + s.status) }));
      expect(repaired).toMatchObject({ status: "repaired", stateCommitted: true, health: { status: "healthy" } });
      expect((await statusOf()).map((i) => i.state)).toEqual(["state-consistent", "state-consistent", "state-consistent"]);
      const after = await entryOf();
      expect(after.command).toBe(system!.node);
      expect(after.args[0]).toBe(system!.npxCli);
      expect(after.args.slice(1)).toEqual(before.args.slice(1));

      // 고친 Client 설정 그대로 실제 MCP 호출.
      const secrets = api.requests.filter((r) => r.includes("/secrets")).length;
      const s = await session(after.command, after.args, h.projectRoot, CALLS);
      const names = s.tools.map((t) => t.name).sort();
      console.log("launcher repaired tools: " + names.join(","));
      expect(names).toHaveLength(13);
      for (const banned of BANNED) expect(names).not.toContain(banned);
      for (const r of s.replies.slice(0, 2)) expect(JSON.stringify(r)).toMatch(/resource not allowed/u);
      expect(JSON.stringify(s.replies[2])).toContain("LOG_LEVEL");
      expect(s.transcript).not.toContain(TOKEN);
      expect(s.transcript).not.toContain(SECRET_B64);
      expect(api.requests.filter((r) => r.includes("/secrets")).length).toBe(secrets);
    } finally {
      if (saved.cache === undefined) delete process.env["npm_config_cache"];
      else process.env["npm_config_cache"] = saved.cache;
      if (saved.kube === undefined) delete process.env["KUBECONFIG"];
      else process.env["KUBECONFIG"] = saved.kube;
      api.close();
      await rm(scratch, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      await rm(npmCache, { recursive: true, force: true }).catch(() => undefined);
    }
  }, 900_000);
});

