/** @typedef {import("./proposal.mjs").FileFix} FileFix */
/** @typedef {{ key: string, cmd: string, code: number | "timeout" | "error", tail: string }} VerifyResult */
import fs from "node:fs";
import path from "node:path";
import { gitText, linkDependencies, makeTempPlayground } from "../playground/workspace.mjs";
import { runCommand } from "../playground/runner.mjs";
import { errorLine } from "../lib/fs-tools.mjs";

const VERIFY_TIMEOUT_MS = 120_000;

// Git internals and esteira's own records are not part of the project under test.
const SKIP = /^(?:\.git\/|\.esteira\/)/;

/**
 * Copies the working tree (tracked + new, not ignored) into `dir`, so the check
 * sees exactly what the user has, uncommitted changes included.
 * @param {string} root @param {string} dir
 */
function copyWorkingTree(root, dir) {
  const files = gitText(root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
  for (const rel of files) {
    if (SKIP.test(rel)) continue;
    const from = path.join(root, rel);
    if (!fs.existsSync(from)) continue; // removed in the working tree
    const to = path.join(dir, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

/**
 * Runs the verification commands on a snapshot of the working tree with the
 * proposed files applied. The repository itself is never written here.
 * Accepted only if every command exits 0 (no new failure, no unverified change).
 *
 * @param {{ root: string, files: FileFix[], commands: { key: string, cmd: string }[] }} input
 * @returns {{ ok: boolean, results: VerifyResult[], error: string | null }}
 */
export function verifyProposal({ root, files, commands }) {
  const dir = makeTempPlayground("esteira-heal-");
  try {
    copyWorkingTree(root, dir);
    for (const file of files) {
      const to = path.join(dir, file.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.writeFileSync(to, file.content);
    }
    linkDependencies(root, dir);
    const results = commands.map(({ key, cmd }) => {
      const r = runCommand(dir, cmd, { timeoutMs: VERIFY_TIMEOUT_MS });
      return { key, cmd, code: r.code, tail: r.stdout };
    });
    return { ok: results.every((r) => r.code === 0), results, error: null };
  } catch (error) {
    return { ok: false, results: [], error: errorLine(error) };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
