/** @typedef {import("../../types.js").Check} Check */
/** @typedef {import("../../types.js").Finding} Finding */
/** Flags oversized staged blobs (default 5 MB) so binaries/artifacts stay out of Git. */
/** @type {Check} */
export function checkLargeFiles(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  const limit = ctx.config.maxFileBytes ?? 5_242_880;
  for (const file of ctx.files) {
    if (file.size == null || file.size <= limit) continue;
    findings.push({
      check: "files", severity: "low", rule: "large-file",
      file: file.path, line: null, message: `Staged blob is ${(file.size / 1_048_576).toFixed(1)} MB (limit ${(limit / 1_048_576).toFixed(0)} MB); consider LFS or external storage`,
    });
  }
  return findings;
}
