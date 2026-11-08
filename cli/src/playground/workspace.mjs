import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const gitText = (root, args) =>
  execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Same, but returns the raw Buffer (for `git archive`). */
export const gitBuffer = (root, args) =>
  execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Builds an anonymous commit containing exactly the index state, without any
 * ref update (objects only). This is what the playground gates run against.
 */
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
export function headCommit(root) {
  try {
    return gitText(root, ["rev-parse", "--verify", "HEAD"]);
  } catch {
    return null;
  }
}

/** Extracts a commit tree into destDir using `git archive` (read-only). */
export function extractCommit(root, commit, destDir) {
  const buffer = gitBuffer(root, ["archive", commit]);
  const tarPath = path.join(path.dirname(destDir), `${path.basename(destDir)}.tar`);
  fs.writeFileSync(tarPath, buffer);
  try {
    execFileSync("tar", ["-xf", tarPath], { cwd: destDir, stdio: "ignore" });
  } finally {
    fs.rmSync(tarPath, { force: true });
  }
  return destDir;
}

export function makeTempPlayground(prefix = "esteira-playground-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
