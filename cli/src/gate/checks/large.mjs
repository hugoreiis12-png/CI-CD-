/** @typedef {import("../../types.js").Check} Check */
/** @typedef {import("../../types.js").Finding} Finding */
/** Flags oversized staged blobs (default 5 MB) so binaries/artifacts stay out of Git. */
/** @type {Check} */
export function checkLargeFiles(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  const limit = ctx.config.maxFileBytes ?? 5_242_880;
  for (const file of ctx.files) {
    if (file.submodule) {
      findings.push({
        check: "files", severity: "low", rule: "submodule-not-scanned", file: file.path, line: null,
        message: "Repositório embutido (gitlink): o conteúdo dele não é validado aqui. Rode `gh esteira init` dentro dele, ou remova-o com `git rm --cached`.",
      });
      continue;
    }
    if (file.size == null || file.size <= limit) continue;
    findings.push({
      check: "files", severity: "low", rule: "large-file",
      file: file.path, line: null, message: `Blob staged de ${(file.size / 1_048_576).toFixed(1)} MB (limite ${(limit / 1_048_576).toFixed(0)} MB); considere Git LFS ou armazenamento externo`,
    });
  }
  return findings;
}
