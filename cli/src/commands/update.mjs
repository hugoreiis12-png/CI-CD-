/** @typedef {import("../types.js").Profile} Profile */
import { writeManifest } from "../adapters/manifest.mjs";
import { writeWorkflow } from "../adapters/workflows.mjs";
import { installHook } from "../adapters/precommit.mjs";
import { appendUniqueLines } from "../lib/fs-tools.mjs";
import { buildProfile } from "../lib/profile.mjs";
import { renderText } from "./analyze.mjs";
import { pinWorkflows } from "../gitops/pin.mjs";

/** @type {Record<string, string>} */
const REASONS = {
  exists: "já existe",
  unchanged: "sem mudanças",
  "not-a-git-repository": "não é um repositório git",
  "dry-run": "dry-run",
  updated: "atualizado",
  regenerated: "regenerado",
};

const GITIGNORE_LINES = [".esteira/runs/", ".esteira/tmp/", ".esteira/hooks/"];

/**
 * @param {{ resolved: { file: string, action?: string, ref?: string, sha?: string }[], unresolved: { file: string, action?: string, ref?: string, reason?: string }[], skipped: { file: string, action?: string, reason?: string }[], filesTouched: string[] }} report
 * @param {boolean} dryRun
 */
function renderPin(report, dryRun) {
  const lines = [`Pin ${dryRun ? "(simulação)" : ""}: ${report.filesTouched.length ? `atualizado: ${report.filesTouched.join(", ")}` : "nada a mudar"}`];
  const already = report.skipped.filter((s) => s.action).length;
  if (already) lines.push(`  ${already} referência(s) já estavam fixadas`);
  for (const s of report.skipped.filter((x) => !x.action)) lines.push(`  ignorado    ${s.file} (${s.reason === "not found" ? "arquivo não existe" : s.reason})`);
  for (const u of report.unresolved) lines.push(`  NÃO RESOLVIDO ${u.file}  ${u.action}@${u.ref}: ${u.reason}`);
  return lines.join("\n");
}

/**
 * Reajuste idempotente da esteira num projeto: re-análise do perfil,
 * re-aplicação dos adaptadores (manifest, workflow, hooks, .gitignore) e
 * re-pinning das actions por SHA. A política do usuário em
 * `.esteira/project.json` (gate/audit/llm) é sempre preservada.
 *
 * @param {{ root: string, dryRun?: boolean, force?: boolean, quiet?: boolean, json?: boolean,
 *   existsFile: (root: string, rel: string) => boolean,
 *   readFile: (root: string, rel: string) => string | null,
 *   writeFile: (root: string, rel: string, content: string) => void,
 *   resolveRef: (action: string, ref: string) => string | Promise<string>,
 * }} input
 * @returns {Promise<{ profile: Profile, dryRun: boolean, results: { path: string, written?: boolean, changed?: boolean, installed?: boolean, reason?: string }[], pinReport: { resolved: unknown[], unresolved: unknown[], skipped: unknown[], filesTouched: string[] } }>}
 */
export async function runUpdate({
  root,
  dryRun = false,
  force = false,
  quiet = false,
  json = false,
  existsFile,
  readFile,
  writeFile,
  resolveRef,
}) {
  const profile = buildProfile(root);

  if (dryRun) {
    if (!quiet && !json) {
      process.stdout.write(
        `${renderText(profile)}\n\nDry-run — nada foi gravado. Adaptadores previstos:\n` +
        "  - .esteira/project.json (perfil; política preservada)\n" +
        "  - .github/workflows/esteira-ci.yml (só com --force)\n" +
        "  - .esteira/hooks + git config core.hooksPath\n" +
        "  - .gitignore (linhas de .esteira/)\n" +
        "  - pin das actions por SHA\n"
      );
    }
    return { profile, dryRun: true, results: [], pinReport: { resolved: [], unresolved: [], skipped: [], filesTouched: [] } };
  }

  const results = [
    writeManifest(root, profile),
    writeWorkflow(root, profile, { force }),
    installHook(root),
    { path: ".gitignore", ...appendUniqueLines(root, ".gitignore", GITIGNORE_LINES) },
  ];

  const pinReport = await pinWorkflows({ root, existsFile, readFile, writeFile, resolveRef });

  if (!quiet && !json) {
    process.stdout.write(`${renderText(profile)}\n\nReaplicação:\n`);
    for (const raw of results) {
      /** @type {Record<string, unknown>} */
      const r = /** @type {Record<string, unknown>} */ (raw);
      const applied = r.written === true || r.changed === true || r.installed === true;
      const reason = /** @type {string | undefined} */ (r.reason) ?? "unchanged";
      const status = applied ? "aplicado" : `ignorado (${REASONS[reason] ?? reason})`;
      process.stdout.write(`  - ${r.path}: ${status}\n`);
    }
    process.stdout.write(`\n${renderPin(pinReport, false)}\n`);
    if (pinReport.unresolved.length > 0) {
      process.stdout.write("\nVeredito    : há referências não resolvidas — corrija-as e rode de novo.\n");
    } else {
      process.stdout.write("\nVeredito    : esteira atualizada.\n");
    }
  } else if (json) {
    process.stdout.write(`${JSON.stringify({ profile, results, pinReport }, null, 2)}\n`);
  }

  return { profile, dryRun: false, results, pinReport };
}
