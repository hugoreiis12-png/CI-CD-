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
 * Resolve o executável de `tar`. No Windows, o `tar` do PATH pode vir do
 * MSYS/Git Bash sem suporte à extração, ou não existir; o `bsdtar` do próprio
 * Windows vive em System32 e lê tar POSIX sem problemas.
 * @returns {string} caminho (ou nome) do tar
 */
function tarBinary() {
  if (process.platform === "win32") {
    const sys = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
    if (fs.existsSync(sys)) return sys;
  }
  return "tar";
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
    execFileSync(tarBinary(), ["-xf", tarPath], { cwd: destDir, stdio: "ignore" });
  } finally {
    fs.rmSync(tarDir, { recursive: true, force: true });
  }
  return destDir;
}

// Installed dependencies are git-ignored, so `git archive` snapshots never
// contain them and most real test suites cannot start. They are linked
// (read-mostly, not copied) from the working tree into each snapshot.
const DEP_DIRS = ["node_modules", ".venv", "venv"];

/**
 * @param {string} root project working tree
 * @param {string} destDir extracted snapshot
 * @returns {string[]} linked relative paths
 */
export function linkDependencies(root, destDir) {
  const linked = [];
  const folders = ["", ...fs.readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !DEP_DIRS.includes(e.name))
    .map((e) => e.name)];
  for (const folder of folders) {
    for (const dep of DEP_DIRS) {
      const rel = folder ? path.join(folder, dep) : dep;
      const source = path.join(root, rel);
      const target = path.join(destDir, rel);
      if (!fs.existsSync(source) || fs.existsSync(target) || !fs.existsSync(path.dirname(target))) continue;
      fs.symlinkSync(source, target, "dir");
      linked.push(rel);
    }
  }
  return linked;
}

export function makeTempPlayground(prefix = "esteira-playground-") {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
