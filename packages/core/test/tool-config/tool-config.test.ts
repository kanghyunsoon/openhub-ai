import { existsSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  KUBERNETES_TOOL_CONFIG,
  NPX_CLI_PLACEHOLDER,
  REVIEWED_TOOL_CONFIGS,
  TOOL_CONFIG_PLACEHOLDER,
  ToolConfigError,
  assertReviewedToolConfig,
  fastManifestIssues,
  inspectToolConfig,
  isDirectExecPath,
  manifestSchema,
  materializeClientArgs,
  nodeToolConfigFs,
  planFormOfEntry,
  restoreToolConfig,
  substituteToolConfig,
  toolConfigDigest,
  toolConfigIssues,
  toolConfigLocation,
  verifyClientLauncher,
  writeToolConfig,
  type Manifest,
} from "../../src/index";

/** v0.2.0 OpenHub 관리 tool config(tool-config/index.ts). 실제 임시 디렉터리만 쓴다(network·spawn 0). */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-tool-config-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
let n = 0;
const home = async (name = "home") => {
  const d = path.join(scratch, name + "-" + String(n++));
  await mkdir(d, { recursive: true });
  return d;
};
const COMMAND = REVIEWED_TOOL_CONFIGS["kubernetes-mcp-server"]!.commands[0]!;
const k8s = (over: Partial<Record<string, unknown>> = {}): Manifest =>
  manifestSchema.parse({
    name: "kubernetes-mcp-server",
    repository: { github: "containers/kubernetes-mcp-server" },
    category: ["mcp"],
    capabilities: ["kubernetes-operations"],
    targets: ["claude-code"],
    platform: { windows: true, macos: true, linux: true },
    install: { preferredAdapter: "npx", options: { command: COMMAND } },
    healthCheck: { type: "mcp-handshake" },
    update: { source: "npm" },
    rollback: { supported: true },
    verification: "community",
    toolConfig: { format: "toml", content: KUBERNETES_TOOL_CONFIG },
    ...over,
  });
const withContent = (content: string) => k8s({ toolConfig: { format: "toml", content } });
const withCommand = (command: string) => k8s({ install: { preferredAdapter: "npx", options: { command } } });
const userLoc = (h: string) => toolConfigLocation({ homeDir: h, scope: "user", toolId: "kubernetes-mcp-server" })!;
/** 정책 밖 내용을 이미 있던 파일로 만든다(OpenHub writer는 검토된 내용만 쓴다). */
const plant = async (h: string, content: string) => {
  const loc = userLoc(h);
  await mkdir(path.dirname(loc.file), { recursive: true });
  await writeFile(loc.file, content);
  return loc;
};

describe("tool config: 검토된 정책과 정확히 일치", () => {
  it("검토된 명령(0.0.67, --read-only, --toolsets core, --config {toolConfig} 1개)과 검토된 TOML은 문제가 없다", () => {
    expect(COMMAND).toBe("npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config " + TOOL_CONFIG_PLACEHOLDER);
    expect(toolConfigIssues(k8s())).toEqual([]);
    // 주석·공백·키 순서 차이는 같은 정책이다.
    expect(toolConfigIssues(withContent('# reviewed\ntoolsets = [ "core" ]\nread_only = true\n[[denied_resources]]\nkind = "Secret"\nversion = "v1"\ngroup = ""\n'))).toEqual([]);
  });

  it("유효한 TOML이어도 정책과 다르면 거부한다", () => {
    const bad: Record<string, string> = {
      "read_only = false": KUBERNETES_TOOL_CONFIG.replace("read_only = true", "read_only = false"),
      "read_only 누락": KUBERNETES_TOOL_CONFIG.replace("read_only = true\n", ""),
      "Secret 규칙 누락": 'read_only = true\ntoolsets = ["core"]\n',
      "kind 다름": KUBERNETES_TOOL_CONFIG.replace('kind = "Secret"', 'kind = "ConfigMap"'),
      "group 다름": KUBERNETES_TOOL_CONFIG.replace('group = ""', 'group = "apps"'),
      "version 다름": KUBERNETES_TOOL_CONFIG.replace('version = "v1"', 'version = "v2"'),
      "config toolset 추가(configuration_view 재활성화)": KUBERNETES_TOOL_CONFIG.replace('toolsets = ["core"]', 'toolsets = ["core", "config"]'),
      "알 수 없는 추가 설정": KUBERNETES_TOOL_CONFIG + 'port = "8080"\n',
      "추가 denied_resources": KUBERNETES_TOOL_CONFIG + '[[denied_resources]]\ngroup = ""\nversion = "v1"\nkind = "Pod"\n',
      "kubeconfig 경로": 'kubeconfig = "/etc/kube/config"\n' + KUBERNETES_TOOL_CONFIG,
      "환경변수 치환": 'kubeconfig = "${HOME}/x"\n' + KUBERNETES_TOOL_CONFIG,
      "명령 치환": 'log_level = "$(id)"\n' + KUBERNETES_TOOL_CONFIG,
      "상위 경로": 'kubeconfig = "../up"\n' + KUBERNETES_TOOL_CONFIG,
      "잘못된 TOML": "read_only = ",
    };
    for (const [label, content] of Object.entries(bad)) {
      expect(toolConfigIssues(withContent(content)).map((i) => i.path), label).toContain("toolConfig.content");
      expect(() => assertReviewedToolConfig("kubernetes-mcp-server", content), label).toThrow(ToolConfigError);
    }
    expect(toolConfigIssues(withContent("a = \"" + "x".repeat(5000) + "\"\n")).map((i) => i.path)).toContain("toolConfig.content");
  });

  it("명령이 검토된 형태와 다르면(버전·플래그·placeholder) 거부한다", () => {
    for (const command of [
      "npx -y kubernetes-mcp-server@0.0.66 --read-only --toolsets core --config {toolConfig}",
      "npx -y kubernetes-mcp-server --read-only --toolsets core --config {toolConfig}",
      "npx -y kubernetes-mcp-server@0.0.67 --toolsets core --config {toolConfig}",
      "npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core,config --config {toolConfig}",
      "npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config {toolConfig} --disable-destructive=false",
      "npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config {toolConfig} --config {toolConfig}",
      "npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core {toolConfig}",
      "npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core",
    ]) {
      expect(toolConfigIssues(withCommand(command)).map((i) => i.path), command).toContain("install.options.command");
    }
  });

  it("허용 목록 밖 Tool이 toolConfig를 두거나, toolConfig 없이 placeholder를 쓰면 fast validation 오류다", () => {
    expect(fastManifestIssues(k8s({ name: "some-other-mcp" })).map((i) => i.path)).toContain("toolConfig");
    expect(toolConfigIssues(k8s({ toolConfig: undefined })).map((i) => i.path)).toEqual(["install.options.command"]);
    expect(toolConfigIssues(k8s({ toolConfig: undefined, install: { preferredAdapter: "npx", options: { command: "npx -y kubernetes-mcp-server@0.0.67 --read-only" } } }))).toEqual([]);
  });
});

describe("tool config: 위치", () => {
  it("user·project 위치는 OpenHub 관리 디렉터리 아래이고 결과용 ID에는 경로가 없다", async () => {
    const h = await home();
    expect(path.relative(h, userLoc(h).file).split(path.sep)).toEqual([".openhub", "tool-config", "user", "kubernetes-mcp-server", "config.toml"]);
    expect(userLoc(h).fileId).toBe("tool-config:user:kubernetes-mcp-server");
    const p = toolConfigLocation({ homeDir: h, scope: "project", toolId: "kubernetes-mcp-server", projectKey: "0123456789abcdef" })!;
    expect(path.relative(h, p.file).split(path.sep)).toEqual([".openhub", "tool-config", "project", "0123456789abcdef", "kubernetes-mcp-server", "config.toml"]);
    expect(p.fileId).toBe("tool-config:project:kubernetes-mcp-server");
  });

  it("toolId·projectKey가 식별자 형식이 아니거나 home이 상대 경로면 위치를 만들지 않는다", async () => {
    const h = await home();
    for (const toolId of ["../x", "a/b", "A", "a..b", ""]) expect(toolConfigLocation({ homeDir: h, scope: "user", toolId }), toolId).toBeNull();
    for (const projectKey of [undefined, "../../x", "0123", "0123456789ABCDEF"]) expect(toolConfigLocation({ homeDir: h, scope: "project", toolId: "kubernetes-mcp-server", ...(projectKey === undefined ? {} : { projectKey }) })).toBeNull();
    expect(toolConfigLocation({ homeDir: "relative/home", scope: "user", toolId: "kubernetes-mcp-server" })).toBeNull();
  });
});

describe("tool config: 쓰기·보상", () => {
  it("없던 파일: 원자적으로 만들고 digest가 같으며 POSIX에서는 0600·0700이다. 보상하면 만든 파일·디렉터리만 지운다", async () => {
    const h = await home();
    const loc = userLoc(h);
    expect(await inspectToolConfig(loc)).toEqual({ state: "absent" });
    const undo = await writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, { state: "absent" });
    expect(undo.kind).toBe("created");
    expect(await readFile(loc.file, "utf8")).toBe(KUBERNETES_TOOL_CONFIG);
    expect(await inspectToolConfig(loc)).toEqual({ state: "present", digest: toolConfigDigest(KUBERNETES_TOOL_CONFIG) });
    if (process.platform !== "win32") {
      expect((await stat(loc.file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(loc.file))).mode & 0o777).toBe(0o700);
    }
    await restoreToolConfig(loc, undo);
    expect(existsSync(path.join(h, ".openhub"))).toBe(false);
  });

  it("이미 있던 ~/.openhub는 보상 때 남긴다", async () => {
    const h = await home();
    await mkdir(path.join(h, ".openhub"));
    await writeFile(path.join(h, ".openhub", "keep.txt"), "x");
    const loc = userLoc(h);
    await restoreToolConfig(loc, await writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, { state: "absent" }));
    expect(existsSync(path.join(h, ".openhub", "keep.txt"))).toBe(true);
    expect(existsSync(loc.root)).toBe(false);
  });

  it("검토되지 않은 내용은 쓰지 않는다(파일 0개)", async () => {
    const h = await home();
    await expect(writeToolConfig(userLoc(h), "read_only = false\n", { state: "absent" })).rejects.toMatchObject({ code: "TOOL_CONFIG_REJECTED" });
    expect(existsSync(path.join(h, ".openhub"))).toBe(false);
  });

  it("있던(변경된) 파일을 교체한 뒤 보상하면 원래 byte로 돌아오고, 같은 내용이면 쓰지 않는다", async () => {
    const h = await home();
    const loc = await plant(h, "read_only = false\n");
    const undo = await writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, await inspectToolConfig(loc));
    expect(undo.kind).toBe("replaced");
    await restoreToolConfig(loc, undo);
    expect(await readFile(loc.file, "utf8")).toBe("read_only = false\n");
    expect((await writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, await inspectToolConfig(loc))).kind).toBe("replaced");
    expect((await writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, await inspectToolConfig(loc))).kind).toBe("unchanged");
  });

  it("승인 뒤 파일이 생기거나 바뀌면 TOOL_CONFIG_STALE이고 아무것도 쓰지 않는다", async () => {
    const h = await home();
    const loc = await plant(h, "read_only = false\n");
    await expect(writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, { state: "absent" })).rejects.toMatchObject({ code: "TOOL_CONFIG_STALE" });
    await expect(writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, { state: "present", digest: toolConfigDigest("other") })).rejects.toMatchObject({ code: "TOOL_CONFIG_STALE" });
    expect(await readFile(loc.file, "utf8")).toBe("read_only = false\n");
  });

  it("보상 직전 파일이 이번에 쓴 내용과 다르면(다른 프로세스가 바꿈) 덮어쓰지 않고 TOOL_CONFIG_RESTORE_CONFLICT", async () => {
    const h = await home();
    const loc = userLoc(h);
    const undo = await writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, { state: "absent" });
    await writeFile(loc.file, "# someone else\n");
    await expect(restoreToolConfig(loc, undo)).rejects.toMatchObject({ code: "TOOL_CONFIG_RESTORE_CONFLICT" });
    expect(await readFile(loc.file, "utf8")).toBe("# someone else\n");
  });

  it("경로 중간이 symlink·junction이면 거부하고 링크 대상에 아무것도 쓰지 않는다", async () => {
    const h = await home();
    const outside = await home("outside");
    await mkdir(path.join(h, ".openhub", "tool-config"), { recursive: true });
    await symlink(outside, path.join(h, ".openhub", "tool-config", "user"), process.platform === "win32" ? "junction" : "dir");
    const loc = userLoc(h);
    await expect(writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, { state: "absent" })).rejects.toBeInstanceOf(ToolConfigError);
    await expect(inspectToolConfig(loc)).rejects.toMatchObject({ code: "TOOL_CONFIG_REJECTED" });
    expect(existsSync(path.join(outside, "kubernetes-mcp-server"))).toBe(false);
  });

  it("rename이 실패하면 TOOL_CONFIG_WRITE_FAILED이고 임시 파일·만든 디렉터리가 남지 않는다", async () => {
    const h = await home();
    const failing = { ...nodeToolConfigFs, rename: async () => Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" })) };
    await expect(writeToolConfig(userLoc(h), KUBERNETES_TOOL_CONFIG, { state: "absent" }, failing)).rejects.toMatchObject({ code: "TOOL_CONFIG_WRITE_FAILED" });
    expect(existsSync(path.join(h, ".openhub"))).toBe(false);
  });

  it("권한 부족(쓰기 거부)이면 실패하고 기존 파일 byte를 바꾸지 않는다", async () => {
    const h = await home();
    const loc = await plant(h, "read_only = false\n");
    const denied = { ...nodeToolConfigFs, writeFile: async () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" })) };
    await expect(writeToolConfig(loc, KUBERNETES_TOOL_CONFIG, await inspectToolConfig(loc), denied)).rejects.toMatchObject({ code: "TOOL_CONFIG_WRITE_FAILED" });
    expect(await readFile(loc.file, "utf8")).toBe("read_only = false\n");
  });
});

describe("tool config: 직접 실행 경로·Client 항목", () => {
  const WIN_PATHS = [
    "C:\\Users\\Dev Name\\.openhub\\tool-config\\user\\kubernetes-mcp-server\\config.toml",
    "C:\\Users\\홍길동\\.openhub\\tool-config\\user\\kubernetes-mcp-server\\config.toml",
    "C:\\Users\\dev (work)\\.openhub\\tool-config\\user\\kubernetes-mcp-server\\config.toml",
    "C:\\Users\\R&D%1!^\\.openhub\\tool-config\\user\\kubernetes-mcp-server\\config.toml",
    "C:\\Program Files (x86)\\node js\\node_modules\\npm\\bin\\npx-cli.js",
  ];

  it("직접 실행(shell 없음)이므로 공백·한글·괄호·&·%·!·^가 있는 Windows 절대 경로를 그대로 넘긴다", () => {
    for (const file of WIN_PATHS) {
      expect(isDirectExecPath(file, "windows"), file).toBe(true);
      expect(substituteToolConfig(["--config", TOOL_CONFIG_PLACEHOLDER], file, "windows")).toEqual({ ok: true, args: ["--config", file] });
    }
    expect(substituteToolConfig(["--config", TOOL_CONFIG_PLACEHOLDER], "/home/dev name/.openhub/c.toml", "linux").ok).toBe(true);
  });

  it("따옴표·제어 문자·상대·상위·UNC·와일드카드 경로는 manual-setup-required", () => {
    for (const file of ['C:\\Users\\a"b\\c.toml', "C:\\Users\\a\nb\\c.toml", "C:\\Users\\..\\c.toml", "relative\\c.toml", "\\\\server\\share\\c.toml", "C:\\Users\\a*b\\c.toml", "C:\\Users\\a<b\\c.toml"]) {
      expect(substituteToolConfig(["--config", TOOL_CONFIG_PLACEHOLDER], file, "windows"), JSON.stringify(file)).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    }
    for (const file of ["home/c.toml", "/home/../etc/c.toml", '/home/a"b/c.toml', "//net/c.toml"]) {
      expect(substituteToolConfig(["--config", TOOL_CONFIG_PLACEHOLDER], file, "linux"), file).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    }
  });

  it("Client 항목: Windows node 형태는 검증된 node.exe·npx-cli.js·tool config로 바뀌고 Plan 형태로 정확히 되돌아온다", () => {
    const spec = { command: "node", args: [NPX_CLI_PLACEHOLDER, "-y", "kubernetes-mcp-server@0.0.67", "--read-only", "--toolsets", "core", "--config", TOOL_CONFIG_PLACEHOLDER] };
    const launcher = { node: "C:\\Program Files (x86)\\node js\\node.exe", npxCli: "C:\\Program Files (x86)\\node js\\node_modules\\npm\\bin\\npx-cli.js" };
    const m = materializeClientArgs(spec, { platform: "windows", toolConfigFile: WIN_PATHS[3]!, launcher });
    expect(m).toEqual({ ok: true, command: launcher.node, args: [launcher.npxCli, "-y", "kubernetes-mcp-server@0.0.67", "--read-only", "--toolsets", "core", "--config", WIN_PATHS[3]] });
    if (m.ok) expect(planFormOfEntry({ command: m.command, args: m.args })).toEqual(spec);
    expect(materializeClientArgs(spec, { platform: "windows", toolConfigFile: WIN_PATHS[0]!, launcher: null })).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    expect(materializeClientArgs(spec, { platform: "linux", toolConfigFile: "/h/c.toml", launcher })).toMatchObject({ ok: false });
    // 일반 npx Tool은 바뀌지 않는다(D-016 cmd 래퍼 계약 유지).
    expect(materializeClientArgs({ command: "cmd", args: ["/d", "/c", "npx", "-y", "x"] }, { platform: "windows" })).toEqual({ ok: true, command: "cmd", args: ["/d", "/c", "npx", "-y", "x"] });
  });

  it("OpenHub 관리 위치가 아닌 --config 경로는 Plan 형태로 되돌리지 않는다(다른 내용으로 남는다)", () => {
    const changed = planFormOfEntry({ command: "C:\\n\\node.exe", args: ["C:\\n\\node_modules\\npm\\bin\\npx-cli.js", "-y", "kubernetes-mcp-server@0.0.67", "--config", "C:\\Users\\x\\evil.toml"] });
    expect(changed.args).toContain("C:\\Users\\x\\evil.toml");
  });
});

describe("tool config: Windows Client 실행 경로 검증(실행하지 않음)", () => {
  const install = async (dirName: string) => {
    const root = await home("node");
    const dir = path.join(root, dirName);
    await mkdir(path.join(dir, "node_modules", "npm", "bin"), { recursive: true });
    await writeFile(path.join(dir, "node.exe"), "fake");
    await writeFile(path.join(dir, "node_modules", "npm", "bin", "npx-cli.js"), "// fake");
    await writeFile(path.join(dir, "node_modules", "npm", "package.json"), JSON.stringify({ name: "npm", version: "11.0.0" }));
    return { node: path.win32.join(dir, "node.exe"), npxCli: path.win32.join(dir, "node_modules", "npm", "bin", "npx-cli.js"), dir };
  };

  it.runIf(process.platform === "win32")("같은 설치의 node.exe + npm npx-cli.js이고 링크가 없으면 통과한다(공백·괄호·한글·& 경로 포함)", async () => {
    for (const name of ["node js", "nodejs (x86)", "노드", "R&D node"]) {
      const l = await install(name);
      expect(await verifyClientLauncher(l), name).toEqual({ ok: true });
    }
  });

  it.runIf(process.platform === "win32")("다른 설치의 npx-cli.js, npm이 아닌 패키지, 경로의 junction, node.exe가 아닌 파일은 거부한다", async () => {
    const a = await install("a");
    const b = await install("b");
    expect((await verifyClientLauncher({ node: a.node, npxCli: b.npxCli })).ok).toBe(false);
    await writeFile(path.join(a.dir, "node_modules", "npm", "package.json"), JSON.stringify({ name: "evil-npm" }));
    expect((await verifyClientLauncher(a)).ok).toBe(false);
    const c = await install("c");
    const link = path.join(path.dirname(c.dir), "linked");
    await symlink(c.dir, link, "junction");
    expect((await verifyClientLauncher({ node: path.win32.join(link, "node.exe"), npxCli: path.win32.join(link, "node_modules", "npm", "bin", "npx-cli.js") })).ok).toBe(false);
    const d = await install("d");
    await copyFile(d.node, path.join(d.dir, "other.exe"));
    expect((await verifyClientLauncher({ node: path.win32.join(d.dir, "other.exe"), npxCli: d.npxCli })).ok).toBe(false);
  });
});

