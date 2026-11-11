import { severityLabel } from "../lib/labels.mjs";
/** @typedef {import("../types.js").AuditRecord} AuditRecord */
const SEV_LABEL = (/** @type {string} */ s) => severityLabel(s).padEnd(12);

/** @param {AuditRecord} record */
export function render(record) {
  const lines = [];
  lines.push("Esteira audit — CVEs e advisories das dependências (OSV.dev)");
  const eco = Object.entries(record.sbom.byEcosystem)
    .map(([k, v]) => `${k} ${v}`).join(", ");
  lines.push(`Dependências: ${record.sbom.total} analisada(s)${eco ? ` (${eco})` : ""}`);
  lines.push(`Advisories  : ${record.advisoryCount} encontrado(s), ${record.blockers} com severidade ≥ failOn=${record.failOn}`);

  const counts = Object.entries(record.counts).filter(([, v]) => v > 0);
  if (counts.length) lines.push(`Severidade  : ${counts.map(([k, v]) => `${k}=${v}`).join(", ")}`);

  for (const f of record.findings) {
    lines.push(`  ${SEV_LABEL(f.severity)} ${f.id.padEnd(20)} ${f.ecosystem}/${f.package}@${f.version}`);
    lines.push(`             ${f.summary}`);
    if (f.fixed?.length) lines.push(`             correção: atualize ${f.package} para >= ${f.fixed[f.fixed.length - 1]} (${f.source})`);
    else lines.push(`             correção: veja em ${f.id} a resolução suportada (${f.source})`);
  }

  if (record.advisory?.text) {
    lines.push("");
    lines.push(`Parecer do Hermes (${record.advisory.model}, ${record.advisory.ms}ms):`);
    for (const line of record.advisory.text.split("\n")) lines.push(`  ${line}`);
  }
  if (record.sbom.total === 0) lines.push("  (nenhum manifesto de dependências encontrado)");
  if (record.note) lines.push(`Nota        : ${record.note}`);

  lines.push(`Registro    : ${record.path ?? "(não gravado)"}`);
  lines.push(
    record.verdict === "reproved"
      ? `Veredito    : as dependências foram reprovadas na auditoria (failOn=${record.failOn}).`
      : `Veredito    : as dependências passaram na auditoria (failOn=${record.failOn}).`,
  );
  return lines.join("\n");
}
