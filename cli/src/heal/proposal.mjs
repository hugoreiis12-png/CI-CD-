/** @typedef {{ path: string, content: string }} FileFix */
/** @typedef {{ diagnosis: string, files: FileFix[] }} Proposal */
import fs from "node:fs";
import path from "node:path";
import { safeRelPath } from "../agent/tools.mjs";
import { errorLine } from "../lib/fs-tools.mjs";

export const MAX_FILES = 5;
const MAX_FILE_CHARS = 200_000;
const MAX_CONTEXT_CHARS = 5_000;
const MAX_FINDINGS = 20;

/** @param {string} root @param {string} rel */
function currentContent(root, rel) {
  try {
    return fs.readFileSync(path.join(root, rel), "utf8").slice(0, MAX_CONTEXT_CHARS);
  } catch (error) {
    return `(não lido: ${errorLine(error)})`;
  }
}

/**
 * Prompt that asks Hermes for a complete corrected file per path, as strict JSON.
 * @param {{ root: string, evidence: import("./evidence.mjs").Evidence, kind: string, summary: string }} input
 */
export function buildHealPrompt({ root, evidence, kind, summary }) {
  const findings = (evidence.gate?.findings ?? []).slice(0, MAX_FINDINGS)
    .map((f) => `- [${f.severity}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`);
  const conflictBlocks = evidence.conflicts.map((rel) => `### ${rel} (conteúdo atual)\n${currentContent(root, rel)}`);
  return [
    "Você é o Hermes, o agente de correção da Esteira (gh esteira).",
    `Problema (${kind}): ${summary}.`,
    "",
    findings.length ? `Findings do gate:\n${findings.join("\n")}` : "",
    evidence.ciLog ? `Log do GitHub Actions (passos que falharam):\n${evidence.ciLog.slice(-MAX_CONTEXT_CHARS)}` : "",
    ...conflictBlocks,
    "",
    "Proponha a MENOR correção que resolve o problema sem quebrar o comportamento existente.",
    `Devolva SOMENTE um JSON: {"diagnosis": "<1-2 frases em português>", "files": [{"path": "<caminho relativo>", "content": "<arquivo COMPLETO corrigido>"}]}`,
    `No máximo ${MAX_FILES} arquivos. Não inclua segredos. Sem markdown, sem texto antes ou depois do JSON.`,
  ].join("\n");
}

/**
 * Reads the model's JSON strictly. Anything not shaped as expected is rejected
 * (returns null), and every path must be a safe project-relative file.
 * @param {string} text @param {string} root @returns {Proposal | null}
 */
export function parseProposal(text, root) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  /** @type {any} */
  let value;
  try {
    value = JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!Array.isArray(value?.files) || value.files.length === 0 || value.files.length > MAX_FILES) return null;
  const files = [];
  for (const item of value.files) {
    const fix = toFileFix(item, root);
    if (!fix) return null;
    files.push(fix);
  }
  return { diagnosis: typeof value.diagnosis === "string" ? value.diagnosis : "", files };
}

/** @param {any} item @param {string} root @returns {FileFix | null} */
function toFileFix(item, root) {
  if (typeof item?.content !== "string" || item.content.length > MAX_FILE_CHARS) return null;
  try {
    const rel = safeRelPath(root, item.path);
    if (rel.startsWith(".esteira/")) return null;
    return { path: rel, content: item.content };
  } catch {
    return null;
  }
}
