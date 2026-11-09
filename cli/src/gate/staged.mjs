import { execFileSync } from "node:child_process";

const BUFFER = 1024 * 1024 * 16;

const run = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: BUFFER });

/**
 * Parses `git diff -U0` output into { path, added[], addedLines[] } per file.
 * Headers ("--- a/x", "+++ b/x") only exist before the first hunk, so an added
 * line whose content starts with "++" is still content (S8). addedLines holds
 * the real line number in the new file, from the "@@ … +start" hunk header.
 */
export function parsePatch(text) {
  const files = [];
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

/** Collects staged changes: files, added lines, blob SHAs and blob sizes. */
export function getStaged(root) {
  const numstat = run(root, ["diff", "--cached", "--no-renames", "--numstat"]);
  const patch = run(root, ["diff", "--cached", "--no-renames", "-U0"]);
  const byPath = new Map(parsePatch(patch).map((f) => [f.path, f]));

  const files = [];
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [ins, del, ...rest] = line.split("\t");
    const path = rest.join("\t");
    const safePath = path.replace(/^"(.*)"$/, "$1");

    let blob = null;
    let size = null;
    try {
      const entry = run(root, ["ls-files", "-s", "--", safePath]).trim().split("\t")[0];
      blob = entry.split(/\s+/)[1] ?? null;
      if (blob) {
        size = Number.parseInt(
          run(root, ["cat-file", "-s", blob]).trim(),
          10,
        );
      }
    } catch {
      // Unresolvable blob (e.g. rename edge cases) — keep going without it.
    }

    files.push({
      path: safePath,
      insertions: ins === "-" ? null : Number.parseInt(ins, 10) || 0,
      deletions: del === "-" ? null : Number.parseInt(del, 10) || 0,
      added: byPath.get(path)?.added ?? [],
      addedLines: byPath.get(path)?.addedLines ?? [],
      blob,
      size,
      binary: ins === "-" || del === "-",
    });
  }

  return files;
}
