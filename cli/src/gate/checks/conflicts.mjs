/** @typedef {import("../../types.js").Check} Check */
/** @typedef {import("../../types.js").Finding} Finding */
import { isTestPath } from "./test-path.mjs";

// An unresolved merge leaves an opening and a closing marker. Both must be
// present in the added lines, so a lone "=======" (markdown underline) is not
// mistaken for a conflict.
const OPEN = /^<{7}(?: |$)/;
const CLOSE = /^>{7}(?: |$)/;

/** Blocks commits that carry unresolved merge-conflict markers. @type {Check} */
export function checkConflictMarkers(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of ctx.files) {
    if (isTestPath(file.path)) continue;
    const open = file.added.findIndex((line) => OPEN.test(line));
    if (open < 0 || !file.added.some((line) => CLOSE.test(line))) continue;
    findings.push({
      check: "conflicts", severity: "high", rule: "merge-conflict-marker",
      file: file.path, line: file.addedLines?.[open] ?? open + 1,
      message: "Marcador de conflito de merge (<<<<<<< … >>>>>>>) não resolvido; resolva o conflito antes do commit",
    });
  }
  return findings;
}
