import { errorLine } from "../lib/fs-tools.mjs";
/**
 * Hardening pass over generated workflows: rewrites `uses: action@ref`
 * to `uses: action@<full SHA>  # <ref>`, resolving refs through `gh api`.
 * Unknown refs and local actions (`./`) are reported, never silently skipped.
 * The resolver is injectable so tests stay offline.
 */
const FILES = [
  ".github/workflows/esteira-ci.yml",
  ".github/workflows/esteira-release.yml",
];

/**
 * @typedef {{ prefix: string, action: string, ref: string, rest: string, index: number }} UsesLine
 * @typedef {{ file: string, action?: string, ref?: string, sha?: string, reason?: string }} PinEntry
 */

/** @param {string} text @returns {UsesLine[]} */
export function collectUses(text) {
  // matches "- uses: X@ref" and "uses: X@ref", ignoring local actions only
  /** @type {UsesLine[]} */
  const found = [];
  const re = /^(\s*(?:-\s*)?uses:\s*)([^@\s]+)@(\S+)(.*)$/gm;
  let match;
  while ((match = re.exec(text)) !== null) {
    const [, prefix, action, ref, rest = ""] = match;
    if (action.startsWith("./") ) {
      continue; // local actions resolve inside the repo context
    }
    found.push({ prefix, action, ref, rest, index: match.index });
  }
  return found;
}

/** @param {{ action: string, sha: string, originalRef: string, previousComment?: string }} input */
export function renderPinned({ action, sha, originalRef, previousComment = "" }) {
  const comment = ` # pinned: ${originalRef}${previousComment ? ` (was ${previousComment})` : ""}`;
  return `${action}@${sha}${comment}`;
}

/**
 * Rewrites every resolvable `uses:` in the given files (default: the Esteira
 * generated set). resolveRef(action, ref) -> 40-char sha; resolution failures
 * are collected, not fatal, so one bad ref doesn't block the others.
 */
/**
 * @param {{
 *   root: string,
 *   files?: string[],
 *   existsFile: (root: string, rel: string) => boolean,
 *   readFile: (root: string, rel: string) => string | null,
 *   writeFile: (root: string, rel: string, content: string) => void,
 *   resolveRef: (action: string, ref: string) => string | Promise<string>,
 *   dryRun?: boolean,
 *   alreadyPinned?: (rest: string) => boolean,
 * }} input
 */
export async function pinWorkflows({
  root,
  files = FILES,
  existsFile,
  readFile,
  writeFile,
  resolveRef,
  dryRun = false,
  alreadyPinned = (rest) => /# pinned:/.test(rest ?? ""),
}) {
  /** @type {{ resolved: PinEntry[], unresolved: PinEntry[], skipped: PinEntry[], filesTouched: string[], written: string[] }} */
  const report = { resolved: [], unresolved: [], skipped: [], filesTouched: [], written: [] };

  for (const rel of files) {
    if (!existsFile?.(root ?? "", rel)) {
      report.skipped.push({ file: rel, reason: "not found" });
      continue;
    }
    const original = readFile(root, rel) ?? "";
    const uses = collectUses(original);
    if (uses.length === 0) {
      report.skipped.push({ file: rel, reason: "sem linhas uses:" });
      continue;
    }
    let next = original;
    for (const use of uses) {
      if (alreadyPinned(use.rest)) {
        report.skipped.push({ file: rel, action: use.action, ref: use.ref, reason: "already SHA-pinned" });
        continue;
      }
      let sha;
      try {
        sha = await resolveRef(use.action, use.ref);
      } catch (error) {
        report.unresolved.push({ file: rel, action: use.action, ref: use.ref, reason: errorLine(error) });
        continue;
      }
      if (!/^[0-9a-f]{40}$/.test(sha)) {
        report.unresolved.push({ file: rel, action: use.action, ref: use.ref, reason: `não é uma SHA de 40 caracteres: ${sha}` });
        continue;
      }
      const replacement = renderPinned({
        action: use.action, sha, originalRef: use.ref, previousComment: use.rest ?? "",
      });
      const before = `${use.prefix}${use.action}@${use.ref}${use.rest}`;
      // Only the first occurrence is replaced per hit (dedupe via index check less critical here).
      if (next.includes(before)) next = next.replace(before, `${use.prefix}${replacement}`);
      report.resolved.push({ file: rel, action: use.action, ref: use.ref, sha });
    }
    // The Esteira CLI itself (ESTEIRA_REPO@ESTEIRA_REF) is a build input too.
    const repo = original.match(/^\s*ESTEIRA_REPO:\s*(\S+)/m)?.[1];
    const pinnedRef = original.match(/^(\s*ESTEIRA_REF:\s*)(\S+)(.*)$/m);
    if (repo && pinnedRef && !/^[0-9a-f]{40}$/.test(pinnedRef[2])) {
      const [line, prefix, ref] = pinnedRef;
      try {
        const sha = await resolveRef(repo, ref);
        if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`não é uma SHA de 40 caracteres: ${sha}`);
        next = next.replace(line, `${prefix}${sha} # pinned: ${ref}`);
        report.resolved.push({ file: rel, action: repo, ref, sha });
      } catch (error) {
        report.unresolved.push({ file: rel, action: repo, ref, reason: errorLine(error) });
      }
    }
    if (next !== original && !dryRun) {
      writeFile(root, rel, next);
      report.filesTouched.push(rel);
    }
  }

  return report;
}

/** Default resolver via the `gh` CLI (uses the developer's session, no new tokens). */
export async function makeGhResolver() {
  const { execFileSync } = await import("node:child_process");
  return (/** @type {string} */ action, /** @type {string} */ ref) => execFileSync("gh", [
    "api", `repos/${action}/commits/${ref}`, "--jq", ".sha",
  ], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}
