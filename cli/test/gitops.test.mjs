import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runInit } from "../src/commands/init.mjs";
import { runGitops } from "../src/gitops/run.mjs";
import { collectUses, pinWorkflows } from "../src/gitops/pin.mjs";

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-gitops-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "MySvc", scripts: { test: "node --test" } }));
  return dir;
}

const exists = (root, rel) => fs.existsSync(path.join(root, rel));
const fileRead = (root, rel) => fs.readFileSync(path.join(root, rel), "utf8");
const fileWrite = (root, rel, content) => fs.writeFileSync(path.join(root, rel), content);

test("gitops: k8s base + overlays + argocd + release workflow generated", () => {
  const dir = fixture();
  runInit({ root: dir, quiet: true });
  const { app, results } = runGitops({ root: dir, gitopsRepo: "acme/gitops", quiet: true });
  assert.equal(app, "mysvc");
  assert.equal(results.length, 10);

  const deployment = fileRead(dir, "deploy/k8s/base/deployment.yaml");
  assert.match(deployment, /image: ghcr\.io\/mysvc # SET BY GITOPS/);
  assert.match(deployment, /readOnlyRootFilesystem: true/);
  assert.match(deployment, /DATABASE_URL/);

  const staging = fileRead(dir, "deploy/k8s/overlays/staging/patch.yaml");
  assert.match(staging, /replicas: 1/);
  const production = fileRead(dir, "deploy/k8s/overlays/production/patch.yaml");
  assert.match(production, /replicas: 3/);

  const stagingKust = fileRead(dir, "deploy/k8s/overlays/staging/kustomization.yaml");
  assert.match(stagingKust, /newTag: SET-BY-GITOPS/);
  const prodKust = fileRead(dir, "deploy/k8s/overlays/production/kustomization.yaml");
  assert.match(prodKust, /sync is manual/);

  const argoStaging = fileRead(dir, "deploy/argocd/application-staging.yaml");
  assert.match(argoStaging, /repoURL: acme\/gitops/);
  assert.match(argoStaging, /automated:/);
  assert.match(argoStaging, /overlays\/staging/);
  const argoProduction = fileRead(dir, "deploy/argocd/application-production.yaml");
  assert.doesNotMatch(argoProduction, /automated:/);

  // release workflow: SHA-tagged image, SBOM + provenance, scoped packages:write
  const release = fileRead(dir, ".github/workflows/esteira-release.yml");
  assert.match(release, /\$\{\{ github\.sha \}\}/);
  assert.match(release, /provenance: mode=max/);
  assert.match(release, /sbom: true/);
  assert.match(release, /packages: write/);
});

test("gitops: second run skips existing files", () => {
  const dir = fixture();
  const first = runGitops({ root: dir, quiet: true });
  const second = runGitops({ root: dir, quiet: true });
  assert.ok(first.results.every((r) => r.written));
  assert.ok(second.results.every((r) => r.written === false));
});

test("pin: dry-run resolves but never writes", async () => {
  const dir = fixture();
  runInit({ root: dir, quiet: true });
  runGitops({ root: dir, quiet: true });
  const report = await pinWorkflows({
    root: dir, dryRun: true,
    resolveRef: () => "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    existsFile: exists, readFile: fileRead,
    writeFile: () => { throw new Error("must not write"); },
  });
  assert.ok(report.resolved.length >= 3, "dry-run resolves to report");
  assert.equal(report.filesTouched.length, 0);
});

test("collectUses skips local actions and already-pinned lines", () => {
  const sample = [
    "      - uses: actions/checkout@v4",
    "      - uses: ./local-action@v1",
    "      - uses: docker/build-push-action@v6",
    "      - uses: actions/setup-node@v4 # pinned: v4",
  ].join("\n");
  const uses = collectUses(sample);
  assert.deepEqual(uses.map((u) => `${u.action}@${u.ref}`), [
    "actions/checkout@v4",
    "docker/build-push-action@v6",
    "actions/setup-node@v4",
  ]);
});

const SHA = "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0";

test("pin: SHA-pins refs with audit comments; rerun is a no-op", async () => {
  const dir = fixture();
  runInit({ root: dir, quiet: true });
  runGitops({ root: dir, quiet: true });

  const resolutionLog = [];
  const resolveRef = (action, ref) => {
    resolutionLog.push(`${action}@${ref}`);
    return SHA;
  };

  const report = await pinWorkflows({
    root: dir, resolveRef, existsFile: exists, readFile: fileRead, writeFile: fileWrite,
  });
  assert.ok(report.resolved.length >= 3, report.resolved.map((r) => r.action).join(","));
  assert.ok(resolutionLog.includes("actions/checkout@v4"));
  for (const r of report.resolved) assert.match(r.sha, /^[0-9a-f]{40}$/);

  for (const file of report.filesTouched) {
    for (const line of fileRead(dir, file).split("\n")) {
      if (line.includes("uses:") && !line.includes("./") && !line.includes("docker/")) {
        assert.match(line, /uses:\s*[^\s]+@[0-9a-f]{40}\b\s*# pinned: \S+/, line);
      }
    }
  }

  const second = await pinWorkflows({
    root: dir, resolveRef, existsFile: exists, readFile: fileRead, writeFile: fileWrite,
  });
  assert.equal(second.resolved.length, 0);
  assert.ok(second.skipped.every((s) => s.reason === "already SHA-pinned" || s.reason === "not found"));
});

test("release workflow installs the pinned CLI in a step without GITOPS_TOKEN", () => {
  const dir = fixture();
  runInit({ root: dir, quiet: true });
  runGitops({ root: dir, gitopsRepo: "acme/gitops", quiet: true });
  const wf = fileRead(dir, ".github/workflows/esteira-release.yml");
  assert.match(wf, /ESTEIRA_REPO: hugoreiis12-png\/gh-esteira/);
  assert.match(wf, /ESTEIRA_REF: v\d+\.\d+\.\d+/);
  assert.doesNotMatch(wf, /gh extension install|\|\| true|REPLACE-ME\/gh-esteira/);
  // every install step precedes, and is separate from, the step holding the token
  const steps = wf.split(/\n(?=      - )/);
  for (const step of steps.filter((s) => s.includes("Install Esteira"))) assert.doesNotMatch(step, /GITOPS_TOKEN/);
  assert.equal((wf.match(/node "\$ESTEIRA" promote/g) ?? []).length, 2);
});

test("pin rewrites ESTEIRA_REF to a commit SHA of ESTEIRA_REPO", async () => {
  const dir = fixture();
  runInit({ root: dir, quiet: true });
  const calls = [];
  const report = await pinWorkflows({
    root: dir, existsFile: exists, readFile: fileRead, writeFile: fileWrite,
    resolveRef: (action, ref) => { calls.push(`${action}@${ref}`); return "a".repeat(40); },
  });
  const wf = fileRead(dir, ".github/workflows/esteira-ci.yml");
  assert.match(wf, /ESTEIRA_REF: a{40} # pinned: v\d+\.\d+\.\d+/);
  assert.ok(calls.some((c) => c.startsWith("hugoreiis12-png/gh-esteira@v")));
  assert.equal(report.unresolved.length, 0);
});
