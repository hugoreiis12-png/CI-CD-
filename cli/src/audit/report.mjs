/** @typedef {import("../types.js").AuditRecord} AuditRecord */
const SEV_LABEL = (/** @type {string} */ s) => s.toUpperCase().padEnd(8);

/** @param {AuditRecord} record */
export function render(record) {
  const lines = [];
  lines.push("Esteira audit — CVE & dependency advisories (OSV.dev)");
  const eco = Object.entries(record.sbom.byEcosystem)
    .map(([k, v]) => `${k} ${v}`).join(", ");
  lines.push(`Dependencies: ${record.sbom.total} scanned${eco ? ` (${eco})` : ""}`);
  lines.push(`Advisories  : ${record.advisoryCount} found, ${record.blockers} at/above failOn=${record.failOn}`);

  const counts = Object.entries(record.counts).filter(([, v]) => v > 0);
  if (counts.length) lines.push(`Severity    : ${counts.map(([k, v]) => `${k}=${v}`).join(", ")}`);

  for (const f of record.findings) {
    lines.push(`  ${SEV_LABEL(f.severity)} ${f.id.padEnd(20)} ${f.ecosystem}/${f.package}@${f.version}`);
    lines.push(`         ${f.summary}`);
    if (f.fixed?.length) lines.push(`         fix: upgrade ${f.package} to >= ${f.fixed[f.fixed.length - 1]} (${f.source})`);
    else lines.push(`         fix: review ${f.id} for a supported resolution (${f.source})`);
  }

  if (record.sbom.total === 0) lines.push("  (no dependency manifests found)");
  if (record.note) lines.push(`Note        : ${record.note}`);

  lines.push(`Record      : ${record.path ?? "(not written)"}`);
  lines.push(
    record.verdict === "reproved"
      ? `Verdict     : dependencies failed the audit (failOn=${record.failOn}).`
      : `Verdict     : dependencies pass the audit (failOn=${record.failOn}).`,
  );
  return lines.join("\n");
}
