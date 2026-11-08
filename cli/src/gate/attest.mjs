import { createHash } from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { exists, readFile, writeFile, join } from "../lib/fs-tools.mjs";

const gitOut = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

/**
 * Content-addressed snapshot of the validated staged tree (the "security SHA"
 * from the README). Only blob SHAs participate, so the same content produces
 * the same attestation id regardless of where the repo lives.
 *
 * Two snapshots exist per gate run:
 *   - `snapshot({path, blob}[])` — the changed set being judged
 *   - `snapshot(indexBlobs(root))` — the FULL index (the `tree` attested id)
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

/** Full index content: path → blob SHA (all staged/tracked entries). */
export function indexBlobs(root) {
  return parseLsFiles(gitOut(root, ["ls-files", "-s"]));
}

/** Full committed content of a ref (default HEAD): path → blob SHA. */
export function treeBlobs(root, ref = "HEAD") {
  return parseLsTree(gitOut(root, ["ls-tree", "-r", ref]));
}

function parseLsFiles(text) {
  // "100644 <blob> 0\tpath"
  return text.split("\n").filter(Boolean).map((line) => {
    const [meta, p] = line.split("\t");
    const blob = meta.trim().split(/\s+/)[1];
    return { path: p, blob };
  });
}

function parseLsTree(text) {
  // "100644 blob <blob>\tpath"
  return text.split("\n").filter(Boolean).map((line) => {
    const [meta, p] = line.split("\t");
    const blob = meta.trim().split(/\s+/)[2];
    return { path: p, blob };
  });
}

/**
 * Push attestation (M3): a push is only allowed when HEAD's full content is
 * byte-identical to an already-approved playground run — i.e. the verified
 * snapshot id must exist among .esteira/runs records with verdict=approved.
 * Commits that bypassed the gate (--no-verify) therefore cannot be pushed.
 */
export function verifyAttestation({ root, json = false }) {
  let head;
  try {
    head = treeBlobs(root, "HEAD");
  } catch (error) {
    return result({
      root, json, ok: false, exitCode: 1,
      message: `No HEAD tree to attest (${error.message.split("\n")[0]}).`,
    });
  }

  const headId = snapshot(head).id;
  const dir = join(root, ".esteira", "runs");
  let match = null;
  let seen = 0;
  if (exists(root, ".esteira/runs")) {
    for (const file of fs.readdirSync(dir)) {
      if (!file.endsWith(".json")) continue;
      const run = readFileSafe(join(dir, file));
      if (!run) continue;
      seen += 1;
      if (!match && run.verdict === "approved" && run.tree === headId) match = run;
    }
  }

  if (match) {
    return result({
      root, json, ok: true, exitCode: 0, run: match,
      message: `Push attested: HEAD matches validated snapshot ${runShort(match)} (${match.id}).`,
    });
  }
  return result({
    root, json, ok: false, exitCode: 1,
    message: seen
      ? `Push BLOCKED: HEAD is not an attested snapshot. Commit went through --no-verify, or content changed after the gate. Run \`gh esteira gate\` on the commit content.`
      : `Push BLOCKED: no attested gate runs found. Commit must pass \`gh esteira gate\` before pushing.`,
  });
}

function result(r) {
  if (!r.json) process.stdout.write(`Esteira attest — ${r.ok ? "approved" : "blocked"}\n${r.message}\n`);
  return { ...r };
}

function readFileSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const runShort = (run) => run.snapshot?.slice(0, 12) ?? "…";

/** Writes the audit-trail run record under .esteira/runs/<short>.json (idempotent). */
export function writeRun(root, run) {
  const rel = `.esteira/runs/${run.id}.json`;
  writeFile(root, rel, `${JSON.stringify(run, null, 2)}\n`);
  return { path: rel, written: true };
}
