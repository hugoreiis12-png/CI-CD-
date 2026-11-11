/** @typedef {import("./proposal.mjs").FileFix} FileFix */
/** @typedef {import("./verify.mjs").VerifyResult} VerifyResult */
import { generate } from "../hermes/adapter.mjs";
import { resolveLlmSettings } from "../hermes/config.mjs";
import { readJson, writeFile } from "../lib/fs-tools.mjs";
import { buildProfile } from "../lib/profile.mjs";
import { collectEvidence, classify } from "./evidence.mjs";
import { buildHealPrompt, parseProposal } from "./proposal.mjs";
import { verifyProposal } from "./verify.mjs";

export const HEALS_DIR = ".esteira/heals";

/**
 * @typedef {{
 *   status: "nothing" | "no-llm" | "unverifiable" | "llm-error" | "invalid-proposal" | "rejected" | "verified" | "applied",
 *   kind: string,
 *   summary: string,
 *   diagnosis: string,
 *   files: string[],
 *   results: VerifyResult[],
 *   error: string | null,
 * }} HealResult
 */

/** @param {Partial<HealResult>} fields @returns {HealResult} */
const result = (fields) => ({
  status: "nothing", kind: "none", summary: "", diagnosis: "", files: [], results: [], error: null, ...fields,
});

/** Verification commands the project declares: a fix is only applied when these pass. @param {string} root */
function verificationCommands(root) {
  const { commands } = buildProfile(root);
  return [["typecheck", commands.typecheck], ["test", commands.test]]
    .filter(([, cmd]) => Boolean(cmd))
    .map(([key, cmd]) => ({ key: String(key), cmd: String(cmd) }));
}

/**
 * Records what was applied, for the user and for `gh esteira agent` to read later.
 * @param {string} root @param {HealResult} outcome
 */
function recordHeal(root, outcome) {
  const id = new Date().toISOString().replace(/[:.]/g, "-");
  writeFile(root, `${HEALS_DIR}/${id}.json`, `${JSON.stringify({ id, ...outcome }, null, 2)}\n`);
  return id;
}

/**
 * `gh esteira heal`: diagnoses the current failure (gate, merge conflict or
 * the latest CI run), asks Hermes for a fix, and writes it to the working tree
 * ONLY if the project's own typecheck and tests pass with the fix applied.
 * Nothing is staged or committed: the user reviews the diff and commits again.
 *
 * @param {{ root: string, ci?: boolean, dryRun?: boolean, fetchImpl?: unknown }} input
 * @returns {Promise<HealResult>}
 */
export async function runHeal({ root, ci = false, dryRun = false, fetchImpl }) {
  const evidence = collectEvidence(root, { ci });
  const problem = classify(evidence);
  if (problem.kind === "none") return result({ summary: problem.summary });

  const base = { kind: problem.kind, summary: problem.summary };
  const settings = resolveLlmSettings(readJson(root, ".esteira/project.json"));
  if (!settings.endpoint) return result({ ...base, status: "no-llm" });

  const commands = verificationCommands(root);
  if (commands.length === 0) return result({ ...base, status: "unverifiable" });

  const llm = await generate({ settings, prompt: buildHealPrompt({ root, evidence, ...base }), fetchImpl });
  if (llm.status !== "ok") return result({ ...base, status: "llm-error", error: llm.error });

  const proposal = parseProposal(llm.text, root);
  if (!proposal) return result({ ...base, status: "invalid-proposal" });

  const check = verifyProposal({ root, files: proposal.files, commands });
  const files = proposal.files.map((f) => f.path);
  if (!check.ok) {
    return result({ ...base, status: "rejected", diagnosis: proposal.diagnosis, files, results: check.results, error: check.error });
  }
  if (dryRun) return result({ ...base, status: "verified", diagnosis: proposal.diagnosis, files, results: check.results });

  return applyFixes(root, { ...base, diagnosis: proposal.diagnosis, files, results: check.results }, proposal.files);
}

/**
 * @param {string} root @param {Omit<HealResult, "status" | "error">} outcome @param {FileFix[]} fixes
 * @returns {HealResult}
 */
function applyFixes(root, outcome, fixes) {
  for (const fix of fixes) writeFile(root, fix.path, fix.content);
  const applied = result({ ...outcome, status: "applied" });
  recordHeal(root, applied);
  return applied;
}

/** @param {HealResult} outcome */
const verdictLine = (outcome) => {
  const map = {
    nothing: `Nada a corrigir: ${outcome.summary}.`,
    "no-llm": "Hermes desligado (llm.enabled=false): não há como propor a correção.",
    unverifiable: "Sem comandos de typecheck/test configurados: não aplico correção sem verificação. Rode `gh esteira update` ou defina profile.commands.",
    "llm-error": `Hermes indisponível (${outcome.error}): nenhuma correção proposta.`,
    "invalid-proposal": "A resposta do Hermes não é uma proposta válida (JSON com até 5 arquivos seguros): nada foi alterado.",
    rejected: `Correção REJEITADA: a verificação do projeto falhou com a correção aplicada. Nada foi alterado.${outcome.error ? ` (${outcome.error})` : ""}`,
    verified: "Correção verificada (dry-run): nada foi gravado.",
    applied: "Correção aplicada no working tree e verificada. Nada foi commitado.",
  };
  return map[outcome.status];
};

/** @param {HealResult} outcome @returns {string} */
export function renderHeal(outcome) {
  const lines = [`Esteira heal — ${outcome.kind} (${outcome.summary})`, verdictLine(outcome)];
  if (outcome.diagnosis) lines.push(`Diagnóstico: ${outcome.diagnosis}`);
  if (outcome.files.length) lines.push(`Arquivos: ${outcome.files.join(", ")}`);
  for (const r of outcome.results) lines.push(`  [${r.key}] ${r.cmd} → código ${r.code}`);
  if (outcome.status === "applied") {
    lines.push("Próximo passo: revise com `git diff`, rode `git add` nos arquivos e faça o commit de novo (o gate roda outra vez).");
  }
  return `${lines.join("\n")}\n`;
}
