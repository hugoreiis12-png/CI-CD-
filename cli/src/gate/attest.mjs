import { createHash } from "node:crypto";
import { writeFile } from "../lib/fs-tools.mjs";

/**
 * Content-addressed snapshot of the validated staged tree (the "security SHA"
 * from the README). Only blob SHAs participate, so the same content produces
 * the same attestation id regardless of where the repo lives.
 */
export function snapshot(files) {
  const hash = createHash("sha256");
  hash.update("esteira-gate-v1\n");
  const sorted = files.slice().sort((a, b) => a.path.localeCompare(b.path));
  for (const f of sorted) {
    hash.update(`${f.path}\u0000${f.blob ?? "-"}\u0000`);
  }
  const hex = hash.digest("hex");
  return { id: hex, short: hex.slice(0, 12) };
}

/** Writes the audit-trail run record under .esteira/runs/<short>.json (idempotent). */
export function writeRun(root, run) {
  const rel = `.esteira/runs/${run.id}.json`;
  writeFile(root, rel, `${JSON.stringify(run, null, 2)}\n`);
  return { path: rel, written: true };
}
