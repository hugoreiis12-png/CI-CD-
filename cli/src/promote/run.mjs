/** @typedef {import("../types.js").ExecImpl} ExecImpl */
/** @typedef {import("../types.js").GhImpl} GhImpl */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readJson, readFile } from "../lib/fs-tools.mjs";
import { replaceTag, currentTag } from "./mutate.mjs";

/** @param {string} root */
function appFor(root) {
  const pkg = readJson(root, "package.json");
  const name = pkg?.name ?? path.basename(path.resolve(root));
  return sanitize(String(name).split("/").pop() ?? "");
}

/** @param {string} value */
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
/**
 * @typedef {object} PromoteInput
 * @property {string} root
 * @property {string} [repo] GitOps repository (owner/name)
 * @property {string} [app]
 * @property {string} [tag] image tag (commit SHA)
 * @property {string} [env] "staging" | "production"
 * @property {boolean} [dryRun]
 * @property {string} [cloneTarget]
 * @property {boolean} [quiet]
 * @property {ExecImpl} [execImpl]
 * @property {GhImpl} [ghImpl]
 */

/** @param {PromoteInput} input */
export async function runPromote({
  root,
  repo,
  app,
  tag,
  env = "staging",
  dryRun = false,
  cloneTarget,
  quiet = false,
  execImpl = (/** @type {string} */ cmd, /** @type {string[]} */ args) => execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim(),
  ghImpl = (/** @type {string[]} */ args) => execFileSync("gh", args, {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
  }).trim(),
}) {
  const opts = loadPromoteOptions({ root, repo, app, tag, env });

  if (dryRun) {
    return dryRunPlan({ root, ...opts, quiet });
  }

  const cloneDir = cloneTarget ?? fs.mkdtempSync(path.join(os.tmpdir(), "esteira-promote-"));
  const ownsClone = !cloneTarget;
  try {
    // owner/name is not a git URL; gh resolves it (and its auth) to the real remote.
    await ghImpl(["repo", "clone", opts.repo, cloneDir, "--", "--depth", "1"]);

    const kustomizationRel = path.join("apps", opts.app, "overlays", opts.env, "kustomization.yaml");
    const kustomizationPath = path.join(cloneDir, kustomizationRel);
    if (!fs.existsSync(kustomizationPath)) {
      throw new Error(
        `O repositório GitOps não contém ${kustomizationRel}. Gere os manifestos com \`gh esteira gitops\` e copie deploy/k8s/overlays para o repositório GitOps.`,
      );
    }

    const original = fs.readFileSync(kustomizationPath, "utf8");
    const mutation = replaceTag(original, opts.app, opts.tag);
    if (mutation.changed === false && mutation.reason === "already-current") {
      if (!quiet) {
        process.stdout.write(`Esteira promote — ${opts.app}@${opts.env} já está em ${opts.tag}; nada a fazer.\n`);
      }
      return { changed: false, already: true, exitCode: 0 };
    }
    if (mutation.changed === false) {
      throw new Error(
        `Nenhuma imagem chamada "${opts.app}" em ${kustomizationRel}. Confira se o repositório GitOps segue apps/${opts.app}/overlays/${opts.env}.`,
      );
    }

    fs.writeFileSync(kustomizationPath, `${mutation.next}\n`.replace(/\n{2,}$/, "\n"));

    const branch = `esteira/promote-${opts.app}-${opts.env}-${opts.tag.slice(0, 10)}`;
    const commitMessage = `chore(promote): ${opts.app} (${opts.env}) -> ${opts.tag}`;

    await execImpl("git", ["-C", cloneDir, "checkout", "-b", branch]);
    await execImpl("git", ["-C", cloneDir, "add", "-A"]);
    await execImpl("git", ["-C", cloneDir, "-c", "user.name=esteira", "-c", "user.email=esteira@ci", "commit", "-m", commitMessage]);
    await execImpl("git", ["-C", cloneDir, "push", "-u", "origin", branch]);

    const title = `Promover ${opts.app} (${opts.env}) para ${opts.tag.slice(0, 10)}`;
    const body = [
      `Promoção automática de **${opts.app}** (${opts.env}) para a tag de imagem \`${opts.tag}\`.`,
      "",
      "- A imagem é identificada pela SHA imutável do commit, publicada pelo workflow de release da Esteira.",
      "- Aberto depois que o scan Trivy da imagem passou no workflow de release.",
      "- Confira o registro de attestation se o repositório da aplicação usa os gates da Esteira.",
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
        `Tag anterior : ${mutation.previous}\n` +
        `Branch       : ${branch}\n` +
        `PR           : ${prUrl || "(gh pr create não retornou URL)"}\n`,
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

/**
 * @param {{ root: string, repo?: string, app?: string, tag?: string, env?: string }} input
 * @returns {{ app: string, tag: string, env: "staging" | "production", repo: string }}
 */
function loadPromoteOptions({ root, repo, app, tag, env }) {
  const manifest = readJson(root, ".esteira/project.json") ?? null;
  const stored = manifest?.gitops?.repo ?? null;
  if (!repo && !stored) {
    throw new Error(
      'Repositório GitOps desconhecido. Passe --repo dono/nome.',
    );
  }
  if (!tag) {
    throw new Error(`A promoção exige --tag (SHA do commit).`);
  }
  const resolvedEnv = env === "staging" || env === "production" ? env : null;
  if (!resolvedEnv) {
    throw new Error(`--env precisa ser staging ou production (recebido: "${env}").`);
  }
  return { app: app ?? appFor(root), tag, env: resolvedEnv, repo: repo ?? stored };
}

/** @param {{ root: string, app: string, repo: string, tag: string, env: string, quiet: boolean }} input */
function dryRunPlan({ root, app, repo, tag, env, quiet }) {
  const local = readFile(root, path.join("deploy", "k8s", "overlays", env, "kustomization.yaml"));
  const previous = local ? currentTag(local, app) : null;
  if (local == null) {
    if (!quiet) {
      process.stdout.write(
        `Esteira promote (dry-run) — ${app} (${env}) -> ${tag}\n` +
        "Plano: clonar o repositório GitOps e abrir um PR atualizando apps/"
        + `${app}/overlays/${env} para newTag: ${tag}. (overlay local não encontrado para uma prévia detalhada)\n`,
      );
    }
    return { dryRun: true, exitCode: 0, changed: true, previous: null };
  }
  const already = previous === tag;
  if (!quiet) {
    process.stdout.write(
      `Esteira promote (dry-run) — ${app} (${env})\n` +
      `Tag atual    : ${previous ?? "SET-BY-GITOPS"}\n` +
      `Tag alvo     : ${tag}\n` +
      (already ? "Veredito     : já está nessa tag — nenhum PR.\n" : `Próximo      : clonar, criar branch e abrir PR com newTag -> ${tag}\n`),
    );
  }
  return { dryRun: true, exitCode: 0, changed: !already, previous };
}

/** @param {string} env */
function environmentNote(env) {
  return env === "production"
    ? "Este PR altera o overlay de **production**: precisa de revisão (environment protegido, revisores obrigatórios)."
    : "O staging sincroniza sozinho depois do merge (prune + self-heal).";
}
