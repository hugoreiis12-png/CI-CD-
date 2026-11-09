/** @typedef {import("../types.js").BlobEntry} BlobEntry */
/** @typedef {import("../types.js").RunRecord} RunRecord */
import { createHash } from "node:crypto";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { exists, writeFile, join, errorLine } from "../lib/fs-tools.mjs";

const gitOut = (/** @type {string} */ root, /** @type {string[]} */ args) =>
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
/** @param {{ path: string, blob: string | null }[]} files */
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
/** @param {string} root @returns {BlobEntry[]} */
export function indexBlobs(root) {
  return parseLsFiles(gitOut(root, ["ls-files", "-s"]));
}

/** Full committed content of a ref (default HEAD): path → blob SHA. */
/** @param {string} root @returns {BlobEntry[]} */
export function treeBlobs(root, ref = "HEAD") {
  return parseLsTree(gitOut(root, ["ls-tree", "-r", ref]));
}

/** @param {string} text @returns {BlobEntry[]} */
function parseLsFiles(text) {
  // "100644 <blob> 0\tpath"
  return text.split("\n").filter(Boolean).map((line) => {
    const [meta, p] = line.split("\t");
    const blob = meta.trim().split(/\s+/)[1];
    return { path: p, blob };
  });
}

/** @param {string} text @returns {BlobEntry[]} */
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
/** @param {{ root: string, json?: boolean }} options */
export function verifyAttestation({ root, json = false }) {
  let head;
  try {
    head = treeBlobs(root, "HEAD");
  } catch (error) {
    return result({
      root, json, ok: false, exitCode: 1,
      message: `Não há commit (HEAD) para atestar (${errorLine(error)}).`,
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
      message: `Push atestado: o HEAD é idêntico ao snapshot validado ${runShort(match)} (${match.id}).`,
    });
  }
  return result({
    root, json, ok: false, exitCode: 1,
    message: seen
      ? "Push BLOQUEADO: o HEAD não é um snapshot atestado (o commit foi feito com --no-verify, sem pre-commit — merge, cherry-pick, rebase — ou o conteúdo mudou depois do gate). Rode `gh esteira gate --head` para validar e atestar o último commit."
      : "Push BLOQUEADO: nenhuma execução aprovada do gate foi encontrada. Rode `gh esteira gate --head` para validar e atestar o último commit.",
  });
}

/**
 * @template {{ json: boolean, ok: boolean, message: string }} R
 * @param {R} r
 */
function result(r) {
  if (!r.json) process.stdout.write(`Esteira attest — ${r.ok ? "aprovado" : "bloqueado"}\n${r.message}\n`);
  return { ...r };
}

/** @param {string} file @returns {Partial<RunRecord> | null} */
function readFileSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

const runShort = (/** @type {Partial<RunRecord>} */ run) => run.snapshot?.slice(0, 12) ?? "…";

/** Writes the audit-trail run record under .esteira/runs/<short>.json (idempotent). */
/** @param {string} root @param {RunRecord} run */
export function writeRun(root, run) {
  const rel = `.esteira/runs/${run.id}.json`;
  writeFile(root, rel, `${JSON.stringify(run, null, 2)}\n`);
  return { path: rel, written: true };
}
