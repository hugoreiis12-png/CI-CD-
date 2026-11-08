import { exists, isDir } from "../lib/fs-tools.mjs";

export function detectInfra(root, fp) {
  const evidence = [];
  const providers = [];

  let containers = false;
  for (const f of ["Dockerfile", "Containerfile", "compose.yaml", "compose.yml",
    "docker-compose.yml", "docker-compose.yaml"]) {
    if (exists(root, f)) { containers = true; evidence.push(f); }
  }

  const helm = (fp.counts?.["Chart.yaml"] ?? 0) > 0;
  let kubernetes = helm
    || (fp.counts?.["kustomization.yaml"] ?? 0) > 0
    || (fp.counts?.["kustomization.yml"] ?? 0) > 0;
  for (const dir of ["k8s", "deploy", "manifests", "charts", "helm"]) {
    if (isDir(root, dir)) { kubernetes = true; evidence.push(`${dir}/`); }
  }

  const terraform = (fp.counts?.[".tf"] ?? 0) > 0 || (fp.counts?.[".tfvars"] ?? 0) > 0;
  const ansible = exists(root, "ansible.cfg") || (fp.counts?.["playbook.yml"] ?? 0) > 0;
  const argocd = isDir(root, "argocd") || isDir(root, "argo");

  if (exists(root, ".github/workflows")) providers.push("github-actions");
  for (const f of [".gitlab-ci.yml", "azure-pipelines.yml", "bitbucket-pipelines.yml",
    "Jenkinsfile", ".drone.yml", ".circleci"]) {
    if (exists(root, f)) providers.push(f);
  }

  if (!containers && !kubernetes && !terraform && !ansible && providers.length === 0) return null;

  return {
    type: "infra", id: "infra", confidence: 0.9, evidence,
    infra: {
      containers, kubernetes, helm, terraform, ansible, argocd,
      ciProviders: providers, hasPipelines: providers.length > 0,
    },
  };
}
