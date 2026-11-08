import { execFileSync } from "node:child_process";

const BUFFER = 1024 * 1024 * 16;

const run = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", maxBuffer: BUFFER });

/** Parses `git diff -U0` output into { path, addedLines[] } per file. */
export function parsePatch(text) {
  const files = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      current = { path: match?.[2] ?? match?.[1] ?? "unknown", added: [] };
      files.push(current);
    } else if (current && line.startsWith("+") && !line.startsWith("+++")) {
      current.added.push(line.slice(1));
    }
    // "-", "@@", "index", "new file mode", "Binary files…" lines are ignored.
  }
  return files;
}

/** Collects staged changes: files, added lines, blob SHAs and blob sizes. */
export function getStaged(root) {
  const numstat = run(root, ["diff", "--cached", "--numstat"]);
  const patch = run(root, ["diff", "--cached", "-U0"]);
  const addedByPath = new Map(parsePatch(patch).map((f) => [f.path, f.added]));

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
      added: addedByPath.get(path) ?? [],
      blob,
      size,
      binary: ins === "-" || del === "-",
    });
  }

  return files;
}
