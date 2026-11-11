import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runGate, runGateCommits } from "../gate/run.mjs";
import { runAudit } from "../audit/run.mjs";
import { runHeal, renderHeal } from "../heal/run.mjs";
import { severityLabel } from "../lib/labels.mjs";
import { exists, errorLine } from "../lib/fs-tools.mjs";

/** @typedef {import("../types.js").RunRecord} RunRecord */

/**
 * `gh esteira hook <nome>`: o que cada hook de git faz. Os scripts em
 * .esteira/hooks (ou no hooksPath global) só localizam a CLI e chamam isto,
 * então atualizar a extensão atualiza o comportamento sem refazer o init.
 *
 *   pre-commit, pre-merge-commit  gate completo sobre o índice (bloqueia)
 *   pre-push                      cada commit novo + testes no último (bloqueia)
 *   post-merge, post-rewrite      análise do que chegou no pull/merge/rebase (avisa)
 */
export const HOOK_NAMES = ["pre-commit", "pre-merge-commit", "pre-push", "post-merge", "post-rewrite"];

const ZERO = /^0+$/;
// ponytail: o primeiro push de um histórico longo validaria commit a commit;
// acima disto a faixa vira um diff único (o CI continua validando o PR).
const MAX_COMMITS = 100;
const DEPENDENCY_FILES = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb",
  "requirements.txt", "pyproject.toml", "poetry.lock", "uv.lock", "Pipfile.lock", "go.mod", "go.sum", "Cargo.toml", "Cargo.lock",
]);
// Registros da esteira nunca devem ir para o git, nem em repositórios sem init.
const LOCAL_EXCLUDES = [".esteira/runs/", ".esteira/tmp/", ".esteira/audits/", ".esteira/reports/", ".esteira/heals/", ".esteira/backups/"];

/** @param {string} root @param {string[]} args */
const git = (root, args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A blocked commit gets Hermes' fix, verified by the project's own checks, in
 * the working tree. The commit stays blocked: the user reviews, stages, commits.
 * Off with ESTEIRA_HEAL=0. Never blocks on its own failure.
 * @param {string} root
 */
async function healAfterBlock(root) {
  if (process.env.ESTEIRA_HEAL === "0") return;
  try {
    process.stdout.write(renderHeal(await runHeal({ root })));
  } catch (error) {
    process.stderr.write(`[esteira] heal falhou (não bloqueia): ${errorLine(error)}\n`);
  }
}

/** @param {string} root */
function enabled(root) {
  try {
    return git(root, ["config", "--bool", "esteira.enabled"]) !== "false";
  } catch {
    return true; // não configurado
  }
}

/** Garante os registros da esteira em .git/info/exclude (local, nunca commitado). @param {string} root */
function excludeRecords(root) {
  try {
    const file = path.join(git(root, ["rev-parse", "--git-common-dir"]), "info", "exclude");
    const abs = path.isAbsolute(file) ? file : path.join(root, file);
    const current = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    const missing = LOCAL_EXCLUDES.filter((line) => !current.split(/\r?\n/).includes(line));
    if (missing.length === 0) return;
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.appendFileSync(abs, `${current && !current.endsWith("\n") ? "\n" : ""}# gh esteira\n${missing.join("\n")}\n`);
  } catch {
    // sem .git acessível: nada a excluir
  }
}

/**
 * Commits que este push vai enviar e que o remoto ainda não tem.
 * @param {string} root @param {string} remote @param {string} stdin linhas "<ref local> <sha local> <ref remota> <sha remoto>"
 */
export function commitsToPush(root, remote, stdin) {
  const commits = new Set();
  for (const line of stdin.split("\n")) {
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO.test(localSha)) continue; // apagando a ref remota
    const args = ["rev-list", "--reverse", localSha, "--not", `--remotes=${remote}`];
    if (remoteSha && !ZERO.test(remoteSha)) {
      try { git(root, ["cat-file", "-e", `${remoteSha}^{commit}`]); args.push(remoteSha); } catch { /* remoto à frente: o push vai falhar sozinho */ }
    }
    for (const c of git(root, args).split("\n").filter(Boolean)) commits.add(c);
  }
  return [...commits];
}

/** @param {RunRecord} run @param {string} title */
function renderWarnings(run, title) {
  const lines = [title];
  for (const f of run.findings.filter((x) => !/^(?:playground-|submodule-)/.test(x.rule))) {
    lines.push(`  ${severityLabel(f.severity).padEnd(6)} ${f.rule.padEnd(28)} ${f.line ? `${f.file}:${f.line}` : f.file}  ${f.message}`);
  }
  return lines.join("\n");
}

/**
 * @param {string} name
 * @param {{ root: string, args: string[], stdin: string }} input
 * @returns {Promise<number>} código de saída do hook
 */
export async function runHook(name, { root, args, stdin }) {
  if (!HOOK_NAMES.includes(name)) {
    process.stderr.write(`[esteira] hook desconhecido: ${name} (esperado: ${HOOK_NAMES.join(", ")})\n`);
    return 1;
  }
  if (!enabled(root)) {
    process.stderr.write(`[esteira] desligada neste repositório (git config esteira.enabled false) — ${name} liberado.\n`);
    return 0;
  }
  excludeRecords(root);

  if (name === "pre-commit" || name === "pre-merge-commit") {
    const gate = await runGate({ root });
    if (gate.exitCode !== 0) await healAfterBlock(root);
    return gate.exitCode;
  }

  if (name === "pre-push") {
    if (exists(root, ".esteira/push-disabled")) {
      process.stderr.write("[esteira] validação do push desligada pelo arquivo .esteira/push-disabled.\n");
      return 0;
    }
    let commits = commitsToPush(root, args[0] ?? "origin", stdin);
    if (commits.length > MAX_COMMITS) {
      process.stderr.write(`[esteira] ${commits.length} commits novos: validando a faixa como um diff único (o security-gate do CI valida o PR).\n`);
      commits = [commits[commits.length - 1]];
    }
    if (commits.length === 0) return 0;
    process.stdout.write(`Esteira pre-push — validando ${commits.length} commit(s) que ainda não estão no remoto\n`);
    return (await runGateCommits({ root, commits })).exitCode;
  }

  // post-merge (git pull / git merge) e post-rewrite (git pull --rebase, rebase): não bloqueiam.
  if (name === "post-rewrite" && args[0] !== "rebase") return 0; // amend: o pre-commit já validou
  let incoming = [];
  try {
    incoming = git(root, ["rev-list", "--reverse", "ORIG_HEAD..HEAD"]).split("\n").filter(Boolean);
  } catch {
    return 0; // sem ORIG_HEAD: nada a comparar
  }
  if (incoming.length === 0) return 0;
  try {
    const run = await runGateCommits({ root, commits: incoming.slice(-MAX_COMMITS), json: true, staticOnly: true });
    const problems = run.findings.filter((f) => !/^(?:playground-|submodule-)/.test(f.rule));
    process.stdout.write(problems.length
      ? `${renderWarnings(run, `Esteira (${name === "post-merge" ? "pull/merge" : "rebase"}) — ATENÇÃO: o que chegou tem ${problems.length} problema(s) de segurança:`)}\n`
      : `Esteira (${name === "post-merge" ? "pull/merge" : "rebase"}) — ${incoming.length} commit(s) recebido(s) analisado(s): nada encontrado.\n`);
    const changed = git(root, ["diff", "--name-only", "ORIG_HEAD", "HEAD"]).split("\n");
    if (changed.some((f) => DEPENDENCY_FILES.has(f.split("/").pop() ?? ""))) {
      process.stdout.write("Esteira — as dependências mudaram; rodando a auditoria de CVEs:\n");
      await runAudit({ root });
    }
  } catch (error) {
    process.stderr.write(`[esteira] análise do ${name} falhou (não bloqueia): ${errorLine(error)}\n`);
  }
  return 0;
}

