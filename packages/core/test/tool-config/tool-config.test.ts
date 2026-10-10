import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  TOOL_CONFIG_PLACEHOLDER,
  ToolConfigError,
  fastManifestIssues,
  inspectToolConfig,
  manifestSchema,
  nodeToolConfigFs,
  restoreToolConfig,
  substituteToolConfig,
  toolConfigDigest,
  toolConfigIssues,
  toolConfigLocation,
  writeToolConfig,
  type Manifest,
} from "../../src/index";

/** v0.2.0 OpenHub 관리 tool config(tool-config/index.ts). 실제 임시 디렉터리만 쓴다(network·spawn 0). */
const scratch = await mkdtemp(path.join(tmpdir(), "openhub-tool-config-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
let n = 0;
const home = async () => {
  const d = path.join(scratch, "home-" + String(n++));
  await mkdir(d);
  return d;
};
const K8S_TOML = 'read_only = true\ntoolsets = ["core"]\n\n[[denied_resources]]\ngroup = ""\nversion = "v1"\nkind = "Secret"\n';
const k8s = (over: Partial<Record<string, unknown>> = {}): Manifest =>
  manifestSchema.parse({
    name: "kubernetes-mcp-server",
    repository: { github: "containers/kubernetes-mcp-server" },
    category: ["mcp"],
    capabilities: ["kubernetes-operations"],
    targets: ["claude-code"],
    platform: { windows: true, macos: true, linux: true },
    install: { preferredAdapter: "npx", options: { command: "npx -y kubernetes-mcp-server@0.0.67 --read-only --toolsets core --config " + TOOL_CONFIG_PLACEHOLDER } },
    healthCheck: { type: "mcp-handshake" },
    update: { source: "npm" },
    rollback: { supported: true },
    verification: "community",
    toolConfig: { format: "toml", content: K8S_TOML },
    ...over,
  });
const userLoc = (h: string) => toolConfigLocation({ homeDir: h, scope: "user", toolId: "kubernetes-mcp-server" })!;

describe("tool config: 허용 목록과 고정 내용", () => {
  it("허용 목록 Tool + --config {toolConfig} 한 쌍 + 고정 TOML은 문제가 없다", () => {
    expect(toolConfigIssues(k8s())).toEqual([]);
  });

  it("허용 목록 밖 Tool이 toolConfig를 두면 fast validation 오류다", () => {
    const other = k8s({ name: "some-other-mcp" });
    expect(fastManifestIssues(other).map((i) => i.path)).toContain("toolConfig");
  });

  it("toolConfig 없이 placeholder를 쓰거나, placeholder가 없거나 두 번이거나 --config 뒤가 아니면 오류다", () => {
    expect(toolConfigIssues(k8s({ toolConfig: undefined })).map((i) => i.path)).toEqual(["install.options.command"]);
    for (const command of ["npx -y kubernetes-mcp-server@0.0.67 --read-only", "npx -y kubernetes-mcp-server@0.0.67 --config {toolConfig} --config {toolConfig}", "npx -y kubernetes-mcp-server@0.0.67 {toolConfig}"]) {
      expect(toolConfigIssues(k8s({ install: { preferredAdapter: "npx", options: { command } } })).map((i) => i.path), command).toContain("install.options.command");
    }
  });

  it("TOML 오류, 4096 byte 초과, 환경변수·명령 치환·절대·상위 경로·URL 계정 값은 거부한다", () => {
    const issues = (content: string) => toolConfigIssues(k8s({ toolConfig: { format: "toml", content } })).map((i) => i.path);
    expect(issues("read_only = ")).toEqual(["toolConfig.content"]);
    expect(issues("a = \"" + "x".repeat(5000) + "\"\n")).toContain("toolConfig.content");
    for (const bad of ["${HOME}/x", "$(id)", "%USERPROFILE%", "/etc/passwd", "C:\\\\Windows", "../up", "a/../b", "https://u:p@host", "~/x"]) {
      expect(issues("kubeconfig = " + JSON.stringify(bad) + "\n"), bad).toEqual(["toolConfig.content"]);
    }
  });

  it("실제 Registry Manifest는 toolConfig가 없어도 그대로 통과한다(선택 필드)", () => {
    expect(toolConfigIssues(k8s({ toolConfig: undefined, install: { preferredAdapter: "npx", options: { command: "npx -y kubernetes-mcp-server@0.0.67 --read-only" } } }))).toEqual([]);
  });
});

describe("tool config: 위치", () => {
  it("user·project 위치는 OpenHub 관리 디렉터리 아래이고 결과용 ID에는 경로가 없다", async () => {
    const h = await home();
    const u = userLoc(h);
    expect(path.relative(h, u.file).split(path.sep)).toEqual([".openhub", "tool-config", "user", "kubernetes-mcp-server", "config.toml"]);
    expect(u.fileId).toBe("tool-config:user:kubernetes-mcp-server");
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
  it("없던 파일: 원자적으로 만들고 내용 digest가 같으며 POSIX에서는 0600·0700이다. 보상하면 만든 파일·디렉터리만 지운다", async () => {
    const h = await home();
    const loc = userLoc(h);
    expect(await inspectToolConfig(loc)).toEqual({ state: "absent" });
    const undo = await writeToolConfig(loc, K8S_TOML, { state: "absent" });
    expect(undo.kind).toBe("created");
    expect(await readFile(loc.file, "utf8")).toBe(K8S_TOML);
    expect(await inspectToolConfig(loc)).toEqual({ state: "present", digest: toolConfigDigest(K8S_TOML) });
    if (process.platform !== "win32") {
      expect((await stat(loc.file)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(loc.file))).mode & 0o777).toBe(0o700);
    }
    await restoreToolConfig(loc, undo);
    expect(existsSync(loc.file)).toBe(false);
    expect(existsSync(path.join(h, ".openhub"))).toBe(false);
  });

  it("이미 있던 ~/.openhub는 보상 때 남긴다", async () => {
    const h = await home();
    await mkdir(path.join(h, ".openhub"));
    await writeFile(path.join(h, ".openhub", "keep.txt"), "x");
    const loc = userLoc(h);
    const undo = await writeToolConfig(loc, K8S_TOML, { state: "absent" });
    await restoreToolConfig(loc, undo);
    expect(existsSync(path.join(h, ".openhub", "keep.txt"))).toBe(true);
    expect(existsSync(loc.root)).toBe(false);
  });

  it("있던 파일 교체 후 보상하면 원래 byte로 돌아오고, 같은 내용이면 쓰지 않는다", async () => {
    const h = await home();
    const loc = userLoc(h);
    await writeToolConfig(loc, "read_only = true\n", { state: "absent" });
    const before = await inspectToolConfig(loc);
    const undo = await writeToolConfig(loc, K8S_TOML, before);
    expect(undo.kind).toBe("replaced");
    expect(await readFile(loc.file, "utf8")).toBe(K8S_TOML);
    await restoreToolConfig(loc, undo);
    expect(await readFile(loc.file, "utf8")).toBe("read_only = true\n");
    expect((await writeToolConfig(loc, "read_only = true\n", await inspectToolConfig(loc))).kind).toBe("unchanged");
  });

  it("승인 뒤 파일이 생기거나 바뀌면 TOOL_CONFIG_STALE이고 아무것도 쓰지 않는다", async () => {
    const h = await home();
    const loc = userLoc(h);
    await writeToolConfig(loc, "read_only = true\n", { state: "absent" });
    await expect(writeToolConfig(loc, K8S_TOML, { state: "absent" })).rejects.toMatchObject({ code: "TOOL_CONFIG_STALE" });
    await expect(writeToolConfig(loc, K8S_TOML, { state: "present", digest: toolConfigDigest("other") })).rejects.toMatchObject({ code: "TOOL_CONFIG_STALE" });
    expect(await readFile(loc.file, "utf8")).toBe("read_only = true\n");
  });

  it("경로 중간이 symlink·junction이면 거부하고 링크 대상에 아무것도 쓰지 않는다", async () => {
    const h = await home();
    const outside = path.join(scratch, "outside-" + String(n++));
    await mkdir(outside);
    await mkdir(path.join(h, ".openhub", "tool-config"), { recursive: true });
    await symlink(outside, path.join(h, ".openhub", "tool-config", "user"), process.platform === "win32" ? "junction" : "dir");
    const loc = userLoc(h);
    await expect(writeToolConfig(loc, K8S_TOML, { state: "absent" })).rejects.toBeInstanceOf(ToolConfigError);
    await expect(inspectToolConfig(loc)).rejects.toMatchObject({ code: "TOOL_CONFIG_REJECTED" });
    expect(existsSync(path.join(outside, "kubernetes-mcp-server"))).toBe(false);
  });

  it("rename이 실패하면 TOOL_CONFIG_WRITE_FAILED이고 임시 파일·만든 디렉터리가 남지 않는다", async () => {
    const h = await home();
    const loc = userLoc(h);
    const failing = { ...nodeToolConfigFs, rename: async () => Promise.reject(Object.assign(new Error("EBUSY"), { code: "EBUSY" })) };
    await expect(writeToolConfig(loc, K8S_TOML, { state: "absent" }, failing)).rejects.toMatchObject({ code: "TOOL_CONFIG_WRITE_FAILED" });
    expect(existsSync(path.join(h, ".openhub"))).toBe(false);
  });
});

describe("tool config: Client·Health 인자 치환", () => {
  it("정확히 {toolConfig} token만 바꾸고, 안전한 문자의 절대 경로만 허용한다", () => {
    const args = ["-y", "kubernetes-mcp-server@0.0.67", "--config", TOOL_CONFIG_PLACEHOLDER, "x{toolConfig}"];
    expect(substituteToolConfig(args, "C:\\Users\\dev\\.openhub\\tool-config\\user\\kubernetes-mcp-server\\config.toml", "windows")).toEqual({
      ok: true,
      args: ["-y", "kubernetes-mcp-server@0.0.67", "--config", "C:\\Users\\dev\\.openhub\\tool-config\\user\\kubernetes-mcp-server\\config.toml", "x{toolConfig}"],
    });
    expect(substituteToolConfig(args, "/home/dev/.openhub/tool-config/user/kubernetes-mcp-server/config.toml", "linux").ok).toBe(true);
  });

  it("공백·cmd 특수문자·상대 경로·상위 경로가 있으면 manual-setup-required(자동으로 쓰지 않음)", () => {
    for (const file of ["C:\\Users\\Dev Name\\.openhub\\c.toml", "C:\\Users\\a%b\\c.toml", "C:\\Users\\a&b\\c.toml", "C:\\Users\\a^b\\c.toml", "C:\\Users\\a!b\\c.toml", "C:\\Users\\..\\c.toml", "relative\\c.toml"]) {
      expect(substituteToolConfig(["--config", TOOL_CONFIG_PLACEHOLDER], file, "windows"), file).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    }
    for (const file of ["/home/a b/c.toml", "/home/a;b/c.toml", "/home/../etc/c.toml", "home/c.toml", "/home/$x/c.toml"]) {
      expect(substituteToolConfig(["--config", TOOL_CONFIG_PLACEHOLDER], file, "linux"), file).toMatchObject({ ok: false, code: "MANUAL_SETUP_REQUIRED" });
    }
  });
});

