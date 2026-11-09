#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalyze } from "./commands/analyze.mjs";
import { runInit } from "./commands/init.mjs";
import { runGate } from "./gate/run.mjs";
import { verifyAttestation } from "./gate/attest.mjs";
import { runAudit } from "./audit/run.mjs";
import { runGitops } from "./gitops/run.mjs";
import { runPromote } from "./promote/run.mjs";
import { runReport } from "./report/cloudflare.mjs";
import { runHelp, overview } from "./commands/help.mjs";
import { runHook } from "./hooks/run.mjs";
import { installGlobalHooks, uninstallGlobalHooks } from "./adapters/precommit.mjs";
import { pinWorkflows, makeGhResolver } from "./gitops/pin.mjs";
import { exists, readFile, writeFile, errorLine } from "./lib/fs-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
).version;


/**
 * @typedef {object} Flags
 * @property {boolean} json
 * @property {boolean} dryRun
 * @property {boolean} force
 * @property {boolean} [global]
 * @property {boolean} [uninstall]
 * @property {boolean} staged
 * @property {boolean} verify
 * @property {boolean} help
 * @property {boolean} version
 * @property {string} dir
 * @property {string} [image]
 * @property {string} [gitopsRepo]
 * @property {string} [policyRef]
 * @property {boolean} [head]
 * @property {string} [tag]
 * @property {string} [env]
 * @property {string} [repo]
 * @property {string} [app]
 * @property {string} [out]
 */

/** @param {string[]} argv @returns {{ flags: Flags, positional: string[] }} */
function parse(argv) {
  /** @type {Flags} */
  const flags = {
    json: false, dryRun: false, force: false, staged: false, verify: false,
    help: false, version: false, dir: process.cwd(),
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--global") flags.global = true;
    else if (a === "--uninstall") flags.uninstall = true;
    else if (a === "--staged") flags.staged = true;
    else if (a === "--verify") flags.verify = true;
    else if (a === "--dir") flags.dir = path.resolve(argv[++i] ?? process.cwd());
    else if (a === "--image") flags.image = argv[++i];
    else if (a === "--gitops-repo") flags.gitopsRepo = argv[++i];
    else if (a === "--policy-ref") flags.policyRef = argv[++i];
    else if (a === "--head") flags.head = true;
    else if (a === "--out") flags.out = argv[++i];
    else if (a === "--tag") flags.tag = argv[++i];
    else if (a === "--env") flags.env = argv[++i];
    else if (a === "--repo") flags.repo = argv[++i];
    else if (a === "--app") flags.app = argv[++i];
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (!a.startsWith("-")) positional.push(a);
    else process.stderr.write(`[esteira] flag desconhecida: ${a}\n`);
  }
  return { flags, positional };
}

/**
 * @param {{ resolved: { file: string, action?: string, ref?: string, sha?: string }[], unresolved: { file: string, action?: string, ref?: string, reason?: string }[], skipped: { file: string, action?: string, reason?: string }[], filesTouched: string[] }} report
 * @param {boolean} dryRun
 */
function renderPin(report, dryRun) {
  const lines = [`Esteira pin — ${dryRun ? "simulação (nada foi gravado)" : "actions fixadas por SHA"}`];
  for (const r of report.resolved) lines.push(`  fixado      ${r.file}  ${r.action}@${r.ref} → ${r.sha?.slice(0, 12)}`);
  const already = report.skipped.filter((s) => s.action).length;
  if (already) lines.push(`  ${already} referência(s) já estavam fixadas`);
  for (const s of report.skipped.filter((x) => !x.action)) lines.push(`  ignorado    ${s.file} (${s.reason === "not found" ? "arquivo não existe" : s.reason})`);
  for (const u of report.unresolved) lines.push(`  NÃO RESOLVIDO ${u.file}  ${u.action}@${u.ref}: ${u.reason}`);
  lines.push(report.unresolved.length
    ? "Veredito    : há referências não resolvidas — corrija-as e rode de novo."
    : `Veredito    : ${report.filesTouched.length ? `atualizado: ${report.filesTouched.join(", ")}` : "nada a mudar"}.`);
  return `${lines.join("\n")}\n`;
}

async function main() {
  const { flags, positional } = parse(process.argv.slice(2));
  const command = positional[0];

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (!command || command === "help" || flags.help) {
    process.exitCode = runHelp(command === "help" ? positional[1] : command);
    return;
  }

  switch (command) {
    case "analyze":
      runAnalyze({ root: flags.dir, json: flags.json });
      break;
    case "init":
      if (flags.global) {
        if (flags.uninstall) {
          const { restored } = uninstallGlobalHooks();
          process.stdout.write(`Esteira — hooks globais removidos${restored ? `; core.hooksPath global restaurado para ${restored}` : ""}.\n`);
        } else {
          const { dir, previous } = installGlobalHooks();
          process.stdout.write(
            `Esteira — hooks globais instalados em ${dir} (git config --global core.hooksPath).\n` +
            "Agora todo repositório desta máquina passa pela esteira no commit, push, pull, merge e rebase.\n" +
            (previous ? `Os hooks globais anteriores (${previous}) continuam rodando depois da esteira.\n` : "") +
            "Repositórios com core.hooksPath local (husky, gh esteira init) usam os próprios hooks.\n" +
            "Desligar num repositório: git config esteira.enabled false   ·   Remover: gh esteira init --global --uninstall\n",
          );
        }
        break;
      }
      runInit({ root: flags.dir, dryRun: flags.dryRun, force: flags.force });
      break;
    case "hook": {
      const stdin = process.stdin.isTTY ? "" : fs.readFileSync(0, "utf8");
      process.exitCode = await runHook(positional[1] ?? "", { root: flags.dir, args: positional.slice(2), stdin });
      break;
    }
    case "gate": {
      const run = runGate({ root: flags.dir, json: flags.json, policyRef: flags.policyRef, head: flags.head });
      if (flags.json) process.stdout.write(`${JSON.stringify(run, null, 2)}\n`);
      process.exitCode = run.exitCode;
      break;
    }
    case "attest": {
      const check = verifyAttestation({ root: flags.dir, json: flags.json });
      if (flags.json) process.stdout.write(`${JSON.stringify(check, null, 2)}\n`);
      process.exitCode = check.exitCode;
      break;
    }
    case "audit": {
      const result = await runAudit({ root: flags.dir, json: flags.json });
      process.exitCode = result.exitCode;
      break;
    }
    case "gitops": {
      runGitops({ root: flags.dir, image: flags.image, force: flags.force, gitopsRepo: flags.gitopsRepo });
      break;
    }
    case "promote": {
      const result = await runPromote({
        root: flags.dir, repo: flags.repo, app: flags.app, tag: flags.tag,
        env: flags.env, dryRun: flags.dryRun,
      });
      process.exitCode = result.exitCode;
      break;
    }
    case "report": {
      process.exitCode = runReport({ root: flags.dir, out: flags.out, json: flags.json }).exitCode;
      break;
    }
    case "pin": {
      const resolveRef = await makeGhResolver();
      const report = await pinWorkflows({
        root: flags.dir, dryRun: flags.dryRun, resolveRef,
        existsFile: exists, readFile, writeFile,
      });
      if (flags.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      else process.stdout.write(renderPin(report, flags.dryRun));
      if (report.unresolved.length > 0) process.exitCode = 1;
      break;
    }
    default:
      process.stderr.write(`[esteira] comando desconhecido: ${command}\n\n${overview()}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[esteira] ${errorLine(error)}\n`);
  process.exitCode = 1;
});
