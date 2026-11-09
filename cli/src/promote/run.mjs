import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readJson, readFile } from "../lib/fs-tools.mjs";
import { replaceTag, currentTag } from "./mutate.mjs";

function appFor(root) {
  const pkg = readJson(root, "package.json");
  const name = pkg?.name ?? path.basename(path.resolve(root));
  return sanitize(String(name).split("/").pop());
}

function sanitize(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "esteira-app";
}

/**
 * `gh esteira promote` (M6): copies the published commit-SHA tag into the
 * GitOps repo and opens a review PR. CI holds no cluster credentials; the
 * promotion is human-approved (or staging auto-merged by policy).
 *
 * Injection points (exec/gh runners) keep tests offline.
 */
export async function runPromote({
  root,
  repo,
  app,
  tag,
  env = "staging",
  dryRun = false,
  cloneTarget,
  quiet = false,
  execImpl = (cmd, args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
  ghImpl = (args) => execFileSync("gh", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim(),
} = {}) {
  const opts = loadPromoteOptions({ root, repo, app, tag, env });

  if (dryRun) {
    return dryRunPlan({ root, ...opts, quiet });
  }

  const cloneDir = cloneTarget ?? fs.mkdtempSync(path.join(os.tmpdir(), "esteira-promote-"));
  const ownsClone = !cloneTarget;
  try {
    await execImpl("git", ["clone", "--depth", "1", opts.repo, cloneDir]);

    const kustomizationRel = path.join("apps", opts.app, "overlays", opts.env, "kustomization.yaml");
    const kustomizationPath = path.join(cloneDir, kustomizationRel);
    if (!fs.existsSync(kustomizationPath)) {
      throw new Error(
        `GitOps repo does not contain ${kustomizationRel}. Generate the manifests with \`gh esteira gitops\` and copy deploy/k8s/overlays to the GitOps repo.`,
      );
    }

    const original = fs.readFileSync(kustomizationPath, "utf8");
    const mutation = replaceTag(original, opts.app, opts.tag);
    if (mutation.changed === false && mutation.reason === "already-current") {
      if (!quiet) {
        process.stdout.write(`Esteira promote — ${opts.app}@${opts.env} already at ${opts.tag}; nothing to do.\n`);
      }
      return { changed: false, already: true, exitCode: 0 };
    }
    if (mutation.changed === false) {
      throw new Error(
        `No image entry named "${opts.app}" found in ${kustomizationRel}. Check the GitOps layout matches apps/${opts.app}/overlays/${opts.env}.`,
      );
    }

    fs.writeFileSync(kustomizationPath, `${mutation.next}\n`.replace(/\n{2,}$/, "\n"));

    const branch = `esteira/promote-${opts.app}-${opts.env}-${opts.tag.slice(0, 10)}`;
    const commitMessage = `chore(promote): ${opts.app} (${opts.env}) -> ${opts.tag}`;

    await execImpl("git", ["-C", cloneDir, "checkout", "-b", branch]);
    await execImpl("git", ["-C", cloneDir, "add", "-A"]);
    await execImpl("git", ["-C", cloneDir, "-c", "user.name=esteira", "-c", "user.email=esteira@ci", "commit", "-m", commitMessage]);
    await execImpl("git", ["-C", cloneDir, "push", "-u", "origin", branch]);

    const title = `Promote ${opts.app} (${opts.env}) to ${opts.tag.slice(0, 10)}`;
    const body = [
      `Automated promotion of **${opts.app}** (${opts.env}) to image tag \`${opts.tag}\`.`,
      "",
      "- Image is the immutable commit SHA published by the Esteira release workflow.",
      "- Opened after the release workflow's Trivy image scan passed.",
      "- Verify the attestation audit log if the app repo deploys Esteira gates.",
      "",
      environmentNote(opts.env),
    ].join("\n");

    const prUrl = await ghImpl([
      "pr", "create", "--repo", opts.repo,
      "--head", branch, "--title", title, "--body", body,
    ]);

    if (!quiet) {
      process.stdout.write(
        `Esteira promote — ${opts.app} (${opts.env}) -> ${opts.tag}\n` +
        `Previous tag : ${mutation.previous}\n` +
        `Branch       : ${branch}\n` +
        `PR           : ${prUrl || "(gh pr create returned no url)"}\n`,
      );
    }

    return {
      changed: true, app: opts.app, env: opts.env, tag: opts.tag,
      previous: mutation.previous, branch, url: prUrl ?? null, exitCode: 0,
    };
  } finally {
    if (ownsClone) fs.rmSync(cloneDir, { recursive: true, force: true });
  }
}

function loadPromoteOptions({ root, repo, app, tag, env }) {
  const manifest = readJson(root, ".esteira/project.json") ?? null;
  const stored = manifest?.gitops?.repo ?? null;
  if (!repo && !stored) {
    throw new Error(
      'No GitOps repository known. Pass --repo owner/name or run gh esteira gitops --gitops-repo owner/name first.',
    );
  }
  if (!tag) {
    throw new Error(`A --tag (commit SHA) is required for a promotion.`);
  }
  const resolvedEnv = ["staging", "production"].includes(env) ? env : null;
  if (!resolvedEnv) {
    throw new Error(`env must be staging or production (got "${env}").`);
  }
  return { app: app ?? appFor(root), tag, env: resolvedEnv, repo: repo ?? stored };
}

function dryRunPlan({ root, app, repo, tag, env, quiet }) {
  const local = readFile(root, path.join("deploy", "k8s", "overlays", env, "kustomization.yaml"));
  const previous = local ? currentTag(local, app) : null;
  if (local == null) {
    if (!quiet) {
      process.stdout.write(
        `Esteira promote (dry-run) — ${app} (${env}) -> ${tag}\n` +
        "Plan: clone the GitOps repo, open a PR updating apps/"
        + `${app}/overlays/${env} to newTag: ${tag}. (local overlay not found for a richer preview)\n`,
      );
    }
    return { dryRun: true, exitCode: 0, changed: true, previous: null };
  }
  const already = previous === tag;
  if (!quiet) {
    process.stdout.write(
      `Esteira promote (dry-run) — ${app} (${env})\n` +
      `Current tag  : ${previous ?? "SET-BY-GITOPS"}\n` +
      `Target tag   : ${tag}\n` +
      (already ? "Verdict      : already current — no PR.\n" : `Next         : clone, branch, PR updating newTag -> ${tag}\n`),
    );
  }
  return { dryRun: true, exitCode: 0, changed: !already, previous };
}

function environmentNote(env) {
  return env === "production"
    ? "This PR targets the **production** overlay: it must be reviewed (protected environment, required reviewers)."
    : "Staging auto-syncs after merge (prune + self-heal).";
}
