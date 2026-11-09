import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { exists, readFile, join, errorLine } from "../lib/fs-tools.mjs";

const HOOKS_DIR = ".esteira/hooks";
// The CLI that ran `init`. Baked into the hook as an absolute path so the hook
// never executes a gate that lives inside the repo being committed (S6).
const SELF_CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "index.mjs");

const shq = (/** @type {string} */ value) => `'${String(value).replace(/'/g, "'\\''")}'`;

/**
 * Hook body. Fails closed when no gate runner exists (S6): an explicit
 * ESTEIRA_ALLOW_UNGATED=1 is the only way through, and it is printed.
 * Chains the hooks that were active before init (S7); pre-push forwards
 * the ref list git sends on stdin.
 */
/** @param {{ name: "pre-commit" | "pre-push", command: string, cli: string, previous: string | null }} hook */
export function renderHook({ name, command, cli, previous }) {
  const isPush = name === "pre-push";
  const marker = isPush
    ? `if [ -f "$ROOT/.esteira/push-disabled" ]; then
  echo "[esteira] push attestation disabled by marker (.esteira/push-disabled)." >&2
el`
    : "";
  return `#!/usr/bin/env sh
# Installed by gh esteira init. ${name}: runs \`esteira ${command}\`, then the previous hook.
set -u
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
ESTEIRA_CLI=${shq(cli)}
ESTEIRA_PREV_HOOKS=${shq(previous ?? "")}
${isPush ? 'INPUT="$(cat)"\n' : ""}
${marker}if command -v gh-esteira >/dev/null 2>&1; then
  gh-esteira ${command} || exit $?
elif command -v gh >/dev/null 2>&1 && gh extension list 2>/dev/null | grep -q ' esteira'; then
  gh esteira ${command} || exit $?
elif [ -f "$ESTEIRA_CLI" ]; then
  node "$ESTEIRA_CLI" ${command} || exit $?
elif [ "\${ESTEIRA_ALLOW_UNGATED:-}" = "1" ]; then
  echo "[esteira] WARNING: gate CLI not found; ESTEIRA_ALLOW_UNGATED=1 let this ${name} through." >&2
else
  echo "[esteira] gate CLI not found — ${name} blocked. Install gh-esteira, or set ESTEIRA_ALLOW_UNGATED=1 to bypass." >&2
  exit 1
fi

if [ -n "$ESTEIRA_PREV_HOOKS" ] && [ -x "$ESTEIRA_PREV_HOOKS/${name}" ]; then
  ${isPush ? `printf '%s\\n' "$INPUT" | "$ESTEIRA_PREV_HOOKS/${name}" "$@"` : `"$ESTEIRA_PREV_HOOKS/${name}" "$@"`}
  exit $?
fi
exit 0
`;
}

/** @type {{ name: "pre-commit" | "pre-push", command: string }[]} */
const HOOKS = [
  { name: "pre-commit", command: "gate --staged" },
  { name: "pre-push", command: "attest --verify" },
];

/** Hooks dir active before init, to chain: core.hooksPath if set, else .git/hooks. */
/** @param {string} root @returns {{ configured: string | null, chain: string | null }} */
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

/** @param {string} root */
export function installHook(root, { cli = SELF_CLI } = {}) {
  const relCommit = `${HOOKS_DIR}/pre-commit`;
  const relPush = `${HOOKS_DIR}/pre-push`;
  const isRepo = exists(root, ".git");
  const prev = isRepo ? previousHooks(root) : { configured: null, chain: null };

  fs.mkdirSync(join(root, HOOKS_DIR), { recursive: true });
  for (const hook of HOOKS) {
    const rel = `${HOOKS_DIR}/${hook.name}`;
    fs.writeFileSync(join(root, rel), renderHook({ ...hook, cli, previous: prev.chain }));
    fs.chmodSync(join(root, rel), 0o755);
  }

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
    return { path: relCommit, installed: false, reason: `git config failed: ${errorLine(error)}` };
  }
}
