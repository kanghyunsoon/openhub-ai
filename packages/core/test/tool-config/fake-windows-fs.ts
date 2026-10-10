import path from "node:path";
import type { ClientLauncher, LauncherCheckFs } from "../../src/index";

type Kind = "dir" | "file" | "link";
/**
 * Windows 경로(대소문자 무시)를 키로 쓰는 읽기 전용 가짜 fs(v0.2.0 client launcher 테스트 공용). lstat·readFile만 있다.
 * 어느 OS에서도 같게 돈다. 실행 경로 검사는 아무것도 실행하지 않는다.
 */
export class FakeWindowsFs {
  readonly nodes = new Map<string, { kind: Kind; data: string }>();
  readonly denied = new Set<string>();
  readonly calls: string[] = [];
  private key = (p: string) => path.win32.normalize(p).toLowerCase();
  private parents(p: string) {
    const parts = path.win32.normalize(p).split("\\");
    for (let i = 2; i < parts.length; i++) {
      const k = this.key(parts.slice(0, i).join("\\"));
      if (!this.nodes.has(k)) this.nodes.set(k, { kind: "dir", data: "" });
    }
  }
  file(p: string, data = "") {
    this.parents(p);
    this.nodes.set(this.key(p), { kind: "file", data });
  }
  link(p: string) {
    this.parents(p);
    this.nodes.set(this.key(p), { kind: "link", data: "" });
  }
  remove(p: string) {
    const k = this.key(p);
    for (const key of [...this.nodes.keys()]) if (key === k || key.startsWith(k + "\\")) this.nodes.delete(key);
  }
  /** node.exe와 같은 디렉터리의 npm(공식 Windows 설치 구조). */
  install(dir: string, npmName = "npm"): ClientLauncher {
    const node = path.win32.join(dir, "node.exe");
    const npxCli = path.win32.join(dir, "node_modules", "npm", "bin", "npx-cli.js");
    this.file(node, "MZ");
    this.file(npxCli, "#!/usr/bin/env node");
    this.file(path.win32.join(dir, "node_modules", "npm", "package.json"), JSON.stringify({ name: npmName }));
    return { node, npxCli };
  }
  readonly fs: LauncherCheckFs = {
    lstat: async (p) => {
      this.calls.push("lstat");
      if (this.denied.has(this.key(p))) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      const n = this.nodes.get(this.key(p));
      if (n === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return { isSymbolicLink: () => n.kind === "link", isDirectory: () => n.kind === "dir", isFile: () => n.kind === "file" };
    },
    readFile: async (p) => {
      this.calls.push("readFile");
      const n = this.nodes.get(this.key(p));
      if (n === undefined || n.kind !== "file") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return Buffer.from(n.data, "utf8");
    },
  };
}

