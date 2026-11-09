import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { exists, readFile, join, errorLine } from "../lib/fs-tools.mjs";
import { HOOK_NAMES } from "../hooks/run.mjs";

const HOOKS_DIR = ".esteira/hooks";
// The CLI that ran `init`. Baked into the hook as an absolute path so the hook
// never executes a gate that lives inside the repo being committed (S6).
const SELF_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");
/** Machine-wide hooks (`init --global`). */
export const GLOBAL_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "esteira", "hooks");
const GLOBAL_PREVIOUS = path.join(path.dirname(GLOBAL_DIR), "previous-hooks-path");

const shq = (/** @type {string} */ value) => `'${String(value).replace(/'/g, "'\\''")}'`;
const BLOCKING = new Set(["pre-commit", "pre-merge-commit", "pre-push"]);
const READS_STDIN = new Set(["pre-push", "post-rewrite"]);

/**
 * Hook script. All behaviour lives in `gh esteira hook <name>`; the script
 * only finds the CLI — the one that ran init (absolute path outside the repo;
 * normally the gh-managed extension itself), then the gh extension, then a
 * `gh-esteira` on PATH (a dev link never wins) — and chains the hook that
 * was active before. Blocking hooks fail closed when no CLI exists (S6):
 * ESTEIRA_ALLOW_UNGATED=1 is the only, printed, way through.
 * @param {{ name: string, cli: string, previous: string | null, global?: boolean }} hook
 *   previous: hooks dir to chain; global hooks chain the repository's own .git/hooks.
 */
export function renderHook({ name, cli, previous, global = false }) {
  const blocking = BLOCKING.has(name);
  const prev = global && !previous
    ? `ESTEIRA_PREV_HOOKS="$(git rev-parse --git-common-dir 2>/dev/null)/hooks"`
    : `ESTEIRA_PREV_HOOKS=${shq(previous ?? "")}`;
  return `#!/usr/bin/env sh
# Instalado por gh esteira init${global ? " --global" : ""}. A lógica fica na CLI: gh esteira hook ${name}.
set -u
ESTEIRA_CLI=${shq(cli)}
${prev}
INPUT=""
${READS_STDIN.has(name) ? 'INPUT="$(cat)"\n' : ""}
esteira() {
  if [ -f "$ESTEIRA_CLI" ]; then
    printf '%s' "$INPUT" | node "$ESTEIRA_CLI" hook ${name} "$@"
  elif command -v gh >/dev/null 2>&1 && gh extension list 2>/dev/null | grep -q '^gh esteira'; then
    printf '%s' "$INPUT" | gh esteira hook ${name} "$@"
  elif command -v gh-esteira >/dev/null 2>&1; then
    printf '%s' "$INPUT" | gh-esteira hook ${name} "$@"
  else
    return 127
  fi
}

esteira "$@"
STATUS=$?
if [ "$STATUS" -eq 127 ]; then
${blocking ? `  if [ "\${ESTEIRA_ALLOW_UNGATED:-}" = "1" ]; then
    echo "[esteira] AVISO: CLI da esteira não encontrada; ESTEIRA_ALLOW_UNGATED=1 liberou este ${name}." >&2
    STATUS=0
  else
    echo "[esteira] CLI da esteira não encontrada — ${name} bloqueado. Instale com: gh extension install hugoreiis12-png/gh-esteira (ou use ESTEIRA_ALLOW_UNGATED=1 para liberar)." >&2
    exit 1
  fi` : `  echo "[esteira] CLI da esteira não encontrada — análise do ${name} pulada." >&2
  STATUS=0`}
fi
${blocking ? '[ "$STATUS" -eq 0 ] || exit "$STATUS"\n' : ""}
if [ -n "$ESTEIRA_PREV_HOOKS" ] && [ -x "$ESTEIRA_PREV_HOOKS/${name}" ]; then
  printf '%s' "$INPUT" | "$ESTEIRA_PREV_HOOKS/${name}" "$@"
  exit $?
fi
exit ${blocking ? 0 : '"$STATUS"'}
`;
}

/** @param {string} dir @param {string} cli @param {string | null} previous @param {boolean} global */
function writeHooks(dir, cli, previous, global) {
  fs.mkdirSync(dir, { recursive: true });
  for (const name of HOOK_NAMES) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, renderHook({ name, cli, previous, global }));
    fs.chmodSync(file, 0o755);
  }
}

/** Hooks dir active before init, to chain: core.hooksPath if set, else .git/hooks. @param {string} root @returns {{ configured: string | null, chain: string | null }} */
function previousHooks(root) {
  /** @type {string | null} */
  let configured = null;
  try {
    configured = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    configured = null;
  }
  if (configured === HOOKS_DIR) {
    // Re-run of init: keep what the first install chained to (never ourselves).
    const current = readFile(root, `${HOOKS_DIR}/pre-commit`) ?? "";
    const baked = current.match(/^ESTEIRA_PREV_HOOKS='((?:[^']|'\\'')*)'$/m)?.[1];
    return { configured, chain: baked ? baked.replace(/'\\''/g, "'") : null };
  }
  const chain = configured ? path.resolve(root, configured) : path.join(root, ".git", "hooks");
  return { configured, chain };
}

/** Per-project hooks (`gh esteira init`). @param {string} root */
export function installHook(root, { cli = SELF_CLI } = {}) {
  const relCommit = `${HOOKS_DIR}/pre-commit`;
  const relPush = `${HOOKS_DIR}/pre-push`;
  const isRepo = exists(root, ".git");
  const prev = isRepo ? previousHooks(root) : { configured: null, chain: null };

  writeHooks(join(root, HOOKS_DIR), cli, prev.chain, false);

  if (!isRepo) {
    return { path: relCommit, installed: false, reason: "not-a-git-repository" };
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", HOOKS_DIR], {
      cwd: root, stdio: ["ignore", "ignore", "ignore"],
    });
    return {
      path: relCommit, installed: true, prePush: relPush,
      previousHooksPath: prev.configured, chainedHooks: prev.chain,
    };
  } catch (error) {
    return { path: relCommit, installed: false, reason: `git config falhou: ${errorLine(error)}` };
  }
}

/** @param {string[]} args */
const gitGlobal = (args) => execFileSync("git", ["config", "--global", ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();

/**
 * Machine-wide hooks (`gh esteira init --global`): every repository without a
 * local core.hooksPath runs the esteira on commit, push, pull, merge, rebase.
 * A previous global hooksPath is chained and restored by `--uninstall`.
 * @param {{ cli?: string, dir?: string }} [options]
 */
export function installGlobalHooks({ cli = SELF_CLI, dir = GLOBAL_DIR } = {}) {
  let current = null;
  try { current = gitGlobal(["--get", "core.hooksPath"]) || null; } catch { current = null; }
  const previous = current && path.resolve(current) !== path.resolve(dir) ? current : readPrevious();
  writeHooks(dir, cli, previous, true);
  fs.writeFileSync(GLOBAL_PREVIOUS, previous ?? "");
  gitGlobal(["core.hooksPath", dir]);
  return { dir, previous };
}

/** Restores the global hooksPath that existed before `init --global`. */
export function uninstallGlobalHooks({ dir = GLOBAL_DIR } = {}) {
  const previous = readPrevious();
  if (previous) gitGlobal(["core.hooksPath", previous]);
  else {
    try { gitGlobal(["--unset", "core.hooksPath"]); } catch { /* já não estava definido */ }
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(GLOBAL_PREVIOUS, { force: true });
  return { restored: previous };
}

function readPrevious() {
  try { return fs.readFileSync(GLOBAL_PREVIOUS, "utf8").trim() || null; } catch { return null; }
}
