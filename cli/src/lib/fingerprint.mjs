/** @typedef {import("../types.js").FileFingerprint} FileFingerprint */
import path from "node:path";
import { listDir } from "./fs-tools.mjs";

export const IGNORED_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "target", ".venv", "venv",
  "__pycache__", ".gradle", "vendor", "coverage", ".next", ".cache",
  ".pytest_cache", ".mypy_cache", "out", "bin", "obj", "Pods", ".terraform",
  ".esteira", ".idea", ".vscode",
]);

export const SPECIAL_FILES = new Set([
  "Dockerfile", "Containerfile", "compose.yaml", "compose.yml",
  "docker-compose.yaml", "docker-compose.yml", "Chart.yaml", "values.yaml",
  "kustomization.yaml", "kustomization.yml", "go.mod", "go.sum", "go.work",
  "Cargo.toml", "Cargo.lock", "pom.xml", "build.gradle", "build.gradle.kts",
  "Gemfile", "composer.json", "pyproject.toml", "requirements.txt", "setup.py",
  "Pipfile", "poetry.lock", "uv.lock", "package.json", "package-lock.json",
  "pnpm-lock.yaml", "pnpm-workspace.yaml", "yarn.lock", "bun.lockb",
  "tsconfig.json", "turbo.json", "nx.json", "lerna.json", "Jenkinsfile",
  "helmfile.yaml", "ansible.cfg", "terraform.tfvars", ".gitlab-ci.yml",
  "azure-pipelines.yml", "bitbucket-pipelines.yml", "playbook.yml",
]);

/** @param {string} name */
export function extOf(name) {
  if (name.startsWith(".") && !name.slice(1).includes(".")) return name;
  const i = name.lastIndexOf(".");
  return i <= 0 ? "__no_ext__" : name.slice(i).toLowerCase();
}

/** Counts files by extension/signature. Never throws; bounded by maxFiles. */
/** @param {string} root @returns {FileFingerprint} */
export function fingerprint(root, { maxFiles = 20000 } = {}) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  let total = 0;

  const walk = (/** @type {string} */ rel) => {
    for (const entry of listDir(root, rel)) {
      if (total >= maxFiles) return;
      if (entry.isDirectory() && IGNORED_DIRS.has(entry.name)) continue;
      const child = rel === "." ? entry.name : path.join(rel, entry.name);
      if (entry.isDirectory()) { walk(child); continue; }
      total += 1;
      const ext = extOf(entry.name);
      counts.set(ext, (counts.get(ext) ?? 0) + 1);
      if (SPECIAL_FILES.has(entry.name)) {
        counts.set(entry.name, (counts.get(entry.name) ?? 0) + 1);
      }
    }
  };

  walk(".");
  return {
    total,
    counts: Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1])),
  };
}
