import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { METADATA_ENV, OPENHUB_CORE_VERSION, REGISTRY_ENV, resolveRegistryDir } from "@openhub/core";
import { runCli } from "./cli";

/**
 * CLI 진입점. 배포 bundle(dist/openhub.cjs)에서는 bundle 옆 registry/가 패키지 리소스다(TASK-071, D-036).
 * Registry는 --dir > OPENHUB_REGISTRY > 패키지 리소스 > (개발 실행) cwd 기준 registry/ 순서다. repository root를 가정하지 않는다.
 */
const here = typeof __dirname === "string" ? __dirname : path.dirname(fileURLToPath(import.meta.url));
const registry = resolveRegistryDir({ env: process.env[REGISTRY_ENV], resource: path.join(here, "registry"), fallback: path.resolve(process.cwd(), "registry") });
const SOURCE_LABEL = { option: "--dir", env: REGISTRY_ENV, resource: "설치 패키지의 registry", fallback: "./registry" } as const;

void runCli(process.argv.slice(2), {
  out: (line) => process.stdout.write(line + "\n"),
  err: (line) => process.stderr.write(line + "\n"),
  cwd: process.cwd(),
  version: OPENHUB_CORE_VERSION,
  registryDir: registry.dir,
  registrySource: SOURCE_LABEL[registry.source],
  homeDir: os.homedir(),
  ...(process.env[METADATA_ENV] ? { metadataFile: process.env[METADATA_ENV] } : {}),
}).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(String(error instanceof Error ? error.message : error) + "\n");
    process.exitCode = 1;
  },
);
