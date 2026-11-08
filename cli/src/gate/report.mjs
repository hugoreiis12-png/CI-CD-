function title(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function render(run) {
  const lines = [];
  lines.push(`Esteira gate — ${run.verdict}`);
  lines.push(`Snapshot    : ${run.snapshot.slice(0, 16)}… (sha256)`);
  lines.push(`Changes     : ${run.stats.files} files, +${run.stats.insertions}/-${run.stats.deletions}`);
  lines.push(`Record      : ${run.path ?? "(not written)"}`);

  if (run.findings.length) {
    for (const f of run.findings) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`  ${f.severity.toUpperCase().padEnd(6)} ${f.rule.padEnd(28)} ${where}  ${f.message}`);
    }
  } else {
    lines.push("  (no findings)");
  }

  if (run.note) lines.push(`Note        : ${run.note}`);

  if (run.verdict === "reproved") {
    lines.push("Verdict     : commit BLOCKED — fix the findings above, re-stage and commit again.");
  } else {
    lines.push("Verdict     : commit may proceed.");
  }
  return lines.join("\n");
}
