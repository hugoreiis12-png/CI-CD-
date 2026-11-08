import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { exists, join } from "../lib/fs-tools.mjs";

const HOOK = `#!/usr/bin/env sh
# Installed by gh esteira init. Blocks the commit unless the security gate passes.
set -eu
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if command -v gh-esteira >/dev/null 2>&1; then
  exec gh-esteira gate --staged
fi
if command -v gh >/dev/null 2>&1 && gh extension list 2>/dev/null | grep -q ' esteira'; then
  exec gh esteira gate --staged
fi
if [ -f "$ROOT/cli/src/index.mjs" ]; then
  exec node "$ROOT/cli/src/index.mjs" gate --staged
fi
echo "[esteira] gate CLI not found; allowing commit without gate (M1)." >&2
exit 0
`;

export function installHook(root) {
  const rel = ".esteira/hooks/pre-commit";
  fs.mkdirSync(join(root, ".esteira/hooks"), { recursive: true });
  fs.writeFileSync(join(root, rel), HOOK);
  fs.chmodSync(join(root, rel), 0o755);

  if (!exists(root, ".git")) {
    return { path: rel, installed: false, reason: "not-a-git-repository" };
  }

  let previous = null;
  try {
    previous = execFileSync("git", ["config", "--get", "core.hooksPath"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
    }).trim() || null;
  } catch {
    previous = null;
  }

  try {
    execFileSync("git", ["config", "core.hooksPath", ".esteira/hooks"], {
      cwd: root, stdio: ["ignore", "ignore", "ignore"],
    });
    return { path: rel, installed: true, previousHooksPath: previous };
  } catch (error) {
    return { path: rel, installed: false, reason: `git config failed: ${error.message}` };
  }
}
