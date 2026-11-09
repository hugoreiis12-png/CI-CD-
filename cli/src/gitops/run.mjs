import path from "node:path";
import { writeIfMissing, writeFile, readJson } from "../lib/fs-tools.mjs";
import {
  renderDeployment, renderService, renderKustomization, renderOverlay,
} from "./k8s.mjs";
import { renderApplication } from "./argocd.mjs";
import { renderReleaseWorkflow } from "./release.mjs";

const DEFAULT_IMAGE = (/** @type {string} */ app) => `ghcr.io/${app}`; // override: --image ghcr.io/org/repo

const WORKFLOW_FILE = ".github/workflows/esteira-release.yml";

const sanitize = (/** @type {unknown} */ value) => String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");

/** @param {string} root */
function appName(root) {
  // package.json name is the most semantic identity; manifest root is next.
  const pkg = readJson(root, "package.json");
  if (pkg?.name) {
    // Scoped names (@scope/pkg) keep the last segment, matching tags safely.
    return sanitize(String(pkg.name).split("/").pop());
  }
  const fromManifest = readJson(root, ".esteira/project.json");
  if (fromManifest?.profile?.root) {
    return sanitize(path.basename(fromManifest.profile.root));
  }
  return sanitize(path.basename(path.resolve(root))) || "esteira-app";
}

/**
 * `gh esteira gitops` (M5): Kubernetes base + overlays, Argo CD Applications
 * and the release workflow (image by commit-SHA + SBOM + provenance).
 * Idempotent like init: writes are either new or --force regenerated.
 */
/** @param {{ root: string, image?: string, force?: boolean, gitopsRepo?: string, quiet?: boolean }} input */
export function runGitops({ root, image: imageFlag, force = false, gitopsRepo, quiet = false }) {
  const app = appName(root);
  const image = imageFlag ?? DEFAULT_IMAGE(app);
  const repo = gitopsRepo ?? "REPLACE-ME/esteira-gitops";

  const files = new Map();
  files.set("deploy/k8s/base/deployment.yaml", renderDeployment({ app, image }));
  files.set("deploy/k8s/base/service.yaml", renderService({ app }));
  files.set("deploy/k8s/base/kustomization.yaml", renderKustomization({ app }));
  for (const env of /** @type {const} */ (["staging", "production"])) {
    const overlay = renderOverlay({ app, env });
    for (const [name, content] of Object.entries(overlay)) {
      files.set(`deploy/k8s/overlays/${env}/${name}`, content);
    }
    files.set(`deploy/argocd/application-${env}.yaml`, renderApplication({ app, gitopsRepo: repo, env }));
  }
  files.set(WORKFLOW_FILE, renderReleaseWorkflow({ app, gitopsRepo: repo }));

  const results = [];
  for (const [rel, content] of files) {
    if (force) {
      writeFile(root, rel, content);
      results.push({ path: rel, written: true, reason: "regenerated" });
    } else {
      const out = writeIfMissing(root, rel, content);
      results.push({ path: rel, written: out.written, reason: out.reason });
    }
  }

  if (!quiet) {
    process.stdout.write(`Esteira gitops — app: ${app} · image: ${image}\n\nManifests & workflow:\n`);
    for (const r of results) {
      const status = r.written ? "applied" : `skipped (${r.reason ?? "unchanged"})`;
      process.stdout.write(`  - ${r.path}: ${status}\n`);
    }
    process.stdout.write(
      "\nNext:\n" +
      "  - gh esteira pin            (REQUIRED before committing: the gate blocks floating actions in privileged workflows)\n" +
      "  - Replace REPLACE-ME/esteira-gitops (deploy/argocd/*.yaml) with your GitOps repo\n" +
      "  - Wire the promotion job: CI proposes the GitOps PR; Argo CD reconciles the cluster\n",
    );
  }

  return { app, image, results };
}
