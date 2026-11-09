import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const gitText = (/** @type {string} */ root, /** @type {string[]} */ args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * Builds an anonymous commit containing exactly the index state, without any
 * ref update (objects only). This is what the playground gates run against.
 */
/** @param {string} root @returns {string} anonymous commit SHA */
export function stageCommit(root) {
  const tree = gitText(root, ["write-tree"]);
  let head = null;
  try {
    head = gitText(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    head = null;
  }
  const args = ["-c", "user.name=esteira", "-c", "user.email=esteira@local", "commit-tree"];
  if (head) args.push("-p", head);
  args.push("-m", "Esteira playground snapshot (objects only, no ref update)");
  args.push(tree);
  return gitText(root, args);
}

/** HEAD as commit SHA, or null on an empty (unborn) repository. */
/** @param {string} root @returns {string | null} */
export function headCommit(root) {
  try {
    return gitText(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return null;
  }
}

/**
 * Extracts a commit tree into destDir. `git archive --output` writes the tar
 * straight to disk (no stdout buffer cap) inside a private mkdtemp directory,
 * so the tar path is neither size-limited nor predictable.
 */
/** @param {string} root @param {string} commit @param {string} destDir */
export function extractCommit(root, commit, destDir) {
  const tarDir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-archive-"));
  const tarPath = path.join(tarDir, "snapshot.tar");
  try {
    gitText(root, ["archive", "--format=tar", `--output=${tarPath}`, commit]);
    execFileSync("tar", ["-xf", tarPath], { cwd: destDir, stdio: "ignore" });
  } finally {
    fs.rmSync(tarDir, { recursive: true, force: true });
  }
  return destDir;
}

export function makeTempPlayground(prefix = "esteira-playground-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
