/** @typedef {import("../types.js").PatchFile} PatchFile */
/** @typedef {import("../types.js").StagedFile} StagedFile */
import { execFileSync } from "node:child_process";

// Per-command output cap. Exceeding it throws, and runGate fails closed (item 1).
const BUFFER = 1024 * 1024 * 64;

// stderr is captured (not printed): git's own "fatal: …" lines would otherwise
// leak into the terminal; the error message still carries them.
const run = (/** @type {string} */ root, /** @type {string[]} */ args, /** @type {string} */ input = "") =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: BUFFER, input, stdio: ["pipe", "pipe", "pipe"] });

// A gitlink (mode 160000) records a commit of an embedded repository, not a
// blob of this one: there is nothing here to read or scan.
const GITLINK = "160000";

/**
 * Base the change set is measured against. Default: HEAD (the index diff).
 * For `gate --head`: HEAD's parent, or the empty tree for a root commit.
 * @param {string} root
 * @returns {string}
 */
export function headBase(root) {
  try {
    return run(root, ["rev-parse", "--verify", "HEAD^"]).trim();
  } catch {
    return run(root, ["hash-object", "-t", "tree", "--stdin"], "").trim();
  }
}

// Content diffs ignore repo-controlled .gitattributes (`-diff`, textconv,
// external drivers) so a PR cannot hide added lines from the checks (item 3).
const DIFF = ["diff", "--cached", "--no-renames", "--no-ext-diff"];
const TEXT_DIFF = [...DIFF, "--text", "--no-textconv", "-U0"];

// `:(literal)` stops git from reading the path as a glob or pathspec magic.
const literal = (/** @type {string} */ path) => `:(literal)${path}`;

/**
 * Parses `git diff -U0` output into { path, added[], addedLines[] } per file.
 * Headers ("--- a/x", "+++ b/x") only exist before the first hunk, so an added
 * line whose content starts with "++" is still content (S8). addedLines holds
 * the real line number in the new file, from the "@@ … +start" hunk header.
 */
/** @param {string} text @returns {PatchFile[]} */
export function parsePatch(text) {
  /** @type {PatchFile[]} */
  const files = [];
  /** @type {PatchFile | null} */
  let current = null;
  let inHunk = false;
  let next = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match?.[2] ?? match?.[1] ?? "unknown", added: [], addedLines: [] };
      files.push(current);
      inHunk = false;
    } else if (current && line.startsWith("@@")) {
      inHunk = true;
      next = Number.parseInt(line.match(/\+(\d+)/)?.[1] ?? "1", 10);
    } else if (current && inHunk && line.startsWith("+")) {
      current.added.push(line.slice(1));
      current.addedLines.push(next++);
    }
    // "-" lines, file headers and "Binary files…" are ignored.
  }
  return files;
}

/**
 * Parses `git diff --numstat -z`: "ins\tdel\tpath\0" records. Paths are
 * verbatim (no C-quoting), so non-ASCII names and names containing " b/" or
 * tabs keep their real value (item 4).
 */
/** @param {string} text @returns {{ ins: string, del: string, path: string }[]} */
export function parseNumstatZ(text) {
  const entries = [];
  for (const record of text.split("\0")) {
    if (!record) continue;
    const first = record.indexOf("\t");
    const second = record.indexOf("\t", first + 1);
    if (first < 0 || second < 0) throw new Error(`unexpected numstat record: ${JSON.stringify(record)}`);
    entries.push({ ins: record.slice(0, first), del: record.slice(first + 1, second), path: record.slice(second + 1) });
  }
  return entries;
}

/**
 * Collects staged changes: files, added lines, blob SHAs and blob sizes.
 * Every git failure propagates; runGate turns it into a blocking verdict.
 */
/**
 * @param {string} root
 * @param {{ base?: string }} [options] compare the index with this commit/tree instead of HEAD
 * @returns {StagedFile[]}
 */
export function getStaged(root, { base } = {}) {
  const against = base ? [base] : [];
  /** @type {StagedFile[]} */
  const files = [];
  for (const { ins, del, path } of parseNumstatZ(run(root, [...DIFF, "--numstat", "-z", ...against]))) {
    const entry = run(root, ["ls-files", "-s", "-z", "--", literal(path)]).split("\0")[0];
    const [mode, sha] = entry ? entry.split(/\s+/) : [];
    const submodule = mode === GITLINK;
    const blob = sha && !submodule ? sha : null; // null for deletions and gitlinks
    const size = blob ? Number.parseInt(run(root, ["cat-file", "-s", blob]).trim(), 10) : null;

    // Diff each file by its exact path instead of re-parsing paths out of one
    // big patch header (items 3 and 4).
    const [parsed] = submodule ? [] : parsePatch(run(root, [...TEXT_DIFF, ...against, "--", literal(path)]));

    files.push({
      path,
      insertions: ins === "-" ? null : Number.parseInt(ins, 10) || 0,
      deletions: del === "-" ? null : Number.parseInt(del, 10) || 0,
      added: parsed?.added ?? [],
      addedLines: parsed?.addedLines ?? [],
      blob,
      size,
      binary: ins === "-" || del === "-",
      submodule,
    });
  }
  return files;
}
