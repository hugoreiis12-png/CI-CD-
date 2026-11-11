/** @typedef {import("../types.js").RunRecord} RunRecord */
import { severityLabel } from "../lib/labels.mjs";
/** @param {RunRecord} run */
export function render(run) {
  const lines = [];
  lines.push(`Esteira gate — ${run.verdict === "approved" ? "aprovado" : "reprovado"}`);
  lines.push(`Snapshot    : ${run.snapshot.slice(0, 16)}… (sha256)`);
  lines.push(`Mudanças    : ${run.stats.files} arquivo(s), +${run.stats.insertions}/-${run.stats.deletions}`);
  lines.push(`Registro    : ${run.path ?? "(não gravado)"}`);

  if (run.playground?.ran) {
    for (const lineItem of run.playground.lines ?? []) lines.push(`Playground  : ${lineItem}`);
  } else if (run.playground?.ran === false) {
    lines.push(`Playground  : NÃO RODOU (${run.playground.reason})`);
  }

  if (run.findings.length) {
    for (const f of run.findings) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`  ${severityLabel(f.severity).padEnd(6)} ${f.rule.padEnd(28)} ${where}  ${f.message}`);
    }
  } else {
    lines.push("  (nenhum finding)");
  }

  if (run.advisory?.text) {
    lines.push("");
    lines.push(`Parecer do Hermes (${run.advisory.model}, ${run.advisory.ms}ms):`);
    for (const line of run.advisory.text.split("\n")) lines.push(`  ${line}`);
  }

  if (run.note) lines.push(`Nota        : ${run.note}`);

  lines.push(
    run.verdict === "reproved"
      ? "Veredito    : commit BLOQUEADO — corrija os findings acima, faça git add de novo e commite."
      : run.attested
        ? `Veredito    : commit liberado. Attestation ${run.tree?.slice(0, 12)}… registrada (libera o push).`
        : "Veredito    : commit liberado.",
  );
  return lines.join("\n");
}
