/** @typedef {import("../types.js").RunRecord} RunRecord */
/** @typedef {import("../types.js").Finding} Finding */
import fs from "node:fs";
import path from "node:path";
import { readJson } from "../lib/fs-tools.mjs";
import { gitText } from "../playground/workspace.mjs";
import { ciFailureLog } from "../agent/tools.mjs";

/**
 * What went wrong, as facts: the latest gate verdict and its blocking findings,
 * unmerged files, and (with `ci`) the failed steps of the latest GitHub Actions run.
 * Read-only; nothing here changes the repository.
 *
 * @typedef {{
 *   gate: { verdict: string, findings: Finding[] } | null,
 *   conflicts: string[],
 *   ciLog: string | null,
 * }} Evidence
 */

/** @param {string} root @returns {string[]} */
function unmergedFiles(root) {
  try {
    return gitText(root, ["diff", "--name-only", "--diff-filter=U"]).split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/** Latest gate record, reduced to what a fix needs. @param {string} root */
function latestGate(root) {
  const folder = path.join(root, ".esteira", "runs");
  if (!fs.existsSync(folder)) return null;
  const last = fs.readdirSync(folder).filter((f) => f.endsWith(".json")).sort().pop();
  const run = last ? /** @type {RunRecord | null} */ (readJson(folder, last)) : null;
  if (!run) return null;
  return { verdict: run.verdict, findings: run.findings ?? [] };
}

/**
 * @param {string} root
 * @param {{ ci?: boolean }} [options]
 * @returns {Evidence}
 */
export function collectEvidence(root, { ci = false } = {}) {
  const gate = latestGate(root);
  const conflicts = [...new Set([
    ...unmergedFiles(root),
    ...(gate?.findings ?? []).filter((f) => f.rule === "merge-conflict-marker").map((f) => f.file),
  ])];
  const ciLog = ci ? ciFailureLog(root) : null;
  return { gate, conflicts, ciLog };
}

/**
 * Deterministic classification: which failure this is, before any LLM is asked.
 * @param {Evidence} evidence
 * @returns {{ kind: "merge-conflict" | "gate-block" | "ci-failure" | "none", summary: string }}
 */
export function classify(evidence) {
  if (evidence.conflicts.length > 0) {
    return { kind: "merge-conflict", summary: `conflito de merge não resolvido em ${evidence.conflicts.join(", ")}` };
  }
  if (evidence.gate?.verdict === "reproved") {
    const blocking = evidence.gate.findings.filter((f) => !/^(?:playground-|submodule-)/.test(f.rule));
    return { kind: "gate-block", summary: `gate reprovou o commit (${blocking.length} finding(s))` };
  }
  if (evidence.ciLog && !/^(?:sem run|gh indisponível)/.test(evidence.ciLog)) {
    return { kind: "ci-failure", summary: "o GitHub Actions falhou no último run" };
  }
  return { kind: "none", summary: "nenhum problema detectado" };
}
