import { parseAllDocuments } from "yaml";
import type { ProjectDetector } from "../detector";
import { FindingSet } from "./findings";
import { COMPOSE_FILE, baseName, isAnalysisCandidate, isRecord } from "./manifests";

/**
 * Kubernetes Detector(taxonomyVersion 2). infrastructure Detector를 바꾸지 않고 별도로 등록한다.
 * 근거로 인정하는 것:
 * - YAML 문서의 apiVersion이 Kubernetes API 그룹이고 kind가 핵심 리소스(Deployment·Service 등)인 경우
 * - kustomization.yaml(resources·bases 또는 kind: Kustomization)
 * - Helm Chart.yaml(apiVersion v1·v2 + name)
 * README 등 YAML이 아닌 파일의 언급, CRD 등 핵심이 아닌 kind, 해석할 수 없는 YAML은 근거가 아니다.
 */
const CORE_KINDS = new Set([
  "Deployment", "Service", "StatefulSet", "DaemonSet", "ReplicaSet", "Job", "CronJob", "Pod", "Ingress", "ConfigMap", "Secret", "Namespace",
  "PersistentVolumeClaim", "HorizontalPodAutoscaler", "NetworkPolicy", "ServiceAccount", "Role", "RoleBinding", "ClusterRole", "ClusterRoleBinding",
]);
const K8S_API_VERSION = /^(?:v1|(?:apps|batch|autoscaling|policy)\/v[0-9a-z]{1,10}|[a-z0-9-]{1,30}(?:\.[a-z0-9-]{1,30}){0,4}\.k8s\.io\/v[0-9a-z]{1,10})$/u;
const YAML_FILE = /\.ya?ml$/u;
const KUSTOMIZATION = /^kustomization\.ya?ml$/u;
const WORKFLOW_DIR = /^\.github\/workflows\//u;
const CHART_NAME = /^[a-z0-9][a-z0-9.-]{0,62}$/u;
const MAX_DOCUMENTS = 50;

export const kubernetesDetector: ProjectDetector = {
  id: "kubernetes",
  supports: (ctx) => ctx.files.length > 0,
  async detect(ctx) {
    const found = new FindingSet();
    const add = (file: string, value: string) => found.add("infrastructure", "kubernetes", "Kubernetes", { file, type: "config", value: value.slice(0, 200) });
    const yamlFiles = ctx.files.filter((f) => isAnalysisCandidate(f) && YAML_FILE.test(baseName(f)) && !WORKFLOW_DIR.test(f) && !COMPOSE_FILE.test(baseName(f)));
    for (const file of yamlFiles) {
      const name = baseName(file);
      if (KUSTOMIZATION.test(name)) {
        const y = await ctx.readYaml(file);
        if (isRecord(y) && (Array.isArray(y["resources"]) || Array.isArray(y["bases"]) || y["kind"] === "Kustomization")) add(file, "kustomization");
        continue;
      }
      if (name === "Chart.yaml") {
        const y = await ctx.readYaml(file);
        if (isRecord(y) && (y["apiVersion"] === "v1" || y["apiVersion"] === "v2") && typeof y["name"] === "string" && CHART_NAME.test(y["name"])) add(file, "Helm chart: " + y["name"]);
        continue;
      }
      const text = await ctx.readText(file);
      // 줄 시작의 apiVersion:·kind:가 둘 다 없으면 파싱하지 않는다.
      if (text === undefined || !/^apiVersion:/mu.test(text) || !/^kind:/mu.test(text)) continue;
      const kinds: string[] = [];
      const versions: string[] = [];
      let docs: ReturnType<typeof parseAllDocuments>;
      try {
        docs = parseAllDocuments(text);
      } catch {
        continue;
      }
      for (const doc of (Array.isArray(docs) ? docs : [docs]).slice(0, MAX_DOCUMENTS)) {
        if (doc.errors.length > 0) continue;
        let value: unknown;
        try {
          value = doc.toJS({ maxAliasCount: 50 });
        } catch {
          continue;
        }
        if (!isRecord(value)) continue;
        const kind = value["kind"];
        const apiVersion = value["apiVersion"];
        if (typeof kind !== "string" || typeof apiVersion !== "string" || !CORE_KINDS.has(kind) || !K8S_API_VERSION.test(apiVersion)) continue;
        if (!kinds.includes(kind)) kinds.push(kind);
        if (!versions.includes(apiVersion)) versions.push(apiVersion);
      }
      if (kinds.length > 0) add(file, kinds.join(", ") + " (" + versions.join(", ") + ")");
    }
    return { findings: found.toArray() };
  },
};
