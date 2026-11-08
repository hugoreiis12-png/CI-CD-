function title(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function render(run) {
  const lines = [];
  lines.push(`Esteira gate — ${run.verdict}`);
  lines.push(`Snapshot    : ${run.snapshot.slice(0, 16)}… (sha256)`);
  lines.push(`Changes     : ${run.stats.files} files, +${run.stats.insertions}/-${run.stats.deletions}`);
  lines.push(`Record      : ${run.path ?? "(not written)"}`);

  if (run.playground?.ran) {
    for (const lineItem of run.playground.lines) lines.push(`Playground  : ${lineItem}`);
  } else if (run.playground?.ran === false) {
    lines.push(`Playground  : NOT RUN (${run.playground.reason})`);
  }

  if (run.findings.length) {
    for (const f of run.findings) {
      const where = f.line ? `${f.file}:${f.line}` : f.file;
      lines.push(`  ${f.severity.toUpperCase().padEnd(6)} ${f.rule.padEnd(28)} ${where}  ${f.message}`);
    }
  } else {
    lines.push("  (no findings)");
  }

  if (run.note) lines.push(`Note        : ${run.note}`);

  lines.push(
    run.verdict === "reproved"
      ? "Verdict     : commit BLOCKED — fix the findings above, re-stage and commit again."
      : run.attested
        ? `Verdict     : commit may proceed. Attestation ${run.tree.slice(0, 12)}… recorded (push-gated).`
        : "Verdict     : commit may proceed.",
  );
  return lines.join("\n");
}
