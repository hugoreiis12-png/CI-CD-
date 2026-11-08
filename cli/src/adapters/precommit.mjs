import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { exists, join } from "../lib/fs-tools.mjs";

const HOOK_COMMIT = `#!/usr/bin/env sh
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
  exec node "$ROOT/cli/src/index.mjs" gate
fi
echo "[esteira] gate CLI not found; allowing commit without gate (M1)." >&2
exit 0
`;

const HOOK_PUSH = `#!/usr/bin/env sh
# Installed by gh esteira init (M3). Pushes only attested snapshots:
# HEAD content must be byte-identical to an approved playground run.
set -u
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
if [ -f "$ROOT/.esteira/push-disabled" ]; then
  echo "[esteira] push attestation disabled by marker (.esteira/push-disabled)." >&2
  exit 0
fi
if command -v gh-esteira >/dev/null 2>&1; then
  exec gh-esteira attest --verify
fi
if command -v gh >/dev/null 2>&1 && gh extension list 2>/dev/null | grep -q ' esteira'; then
  exec gh esteira attest --verify
fi
if [ -f "$ROOT/cli/src/index.mjs" ]; then
  exec node "$ROOT/cli/src/index.mjs" attest --verify
fi
echo "[esteira] attest runner not found; push allowed unverified (M3)." >&2
exit 0
`;

export function installHook(root) {
  const relCommit = ".esteira/hooks/pre-commit";
  const relPush = ".esteira/hooks/pre-push";
  fs.mkdirSync(join(root, ".esteira/hooks"), { recursive: true });
  fs.writeFileSync(join(root, relCommit), HOOK_COMMIT);
  fs.writeFileSync(join(root, relPush), HOOK_PUSH);
  fs.chmodSync(join(root, relCommit), 0o755);
  fs.chmodSync(join(root, relPush), 0o755);

  if (!exists(root, ".git")) {
    return { path: relCommit, installed: false, reason: "not-a-git-repository" };
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
    return { path: relCommit, installed: true, previousHooksPath: previous, prePush: relPush };
  } catch (error) {
    return { path: relCommit, installed: false, reason: `git config failed: ${error.message}` };
  }
}
