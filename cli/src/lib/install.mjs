import { exists, join } from "./fs-tools.mjs";

// Install commands for CI. Lifecycle scripts are off on purpose: a dependency's
// postinstall must not run unreviewed on a runner (same policy as the CI job).
/** @type {Record<string, { lockfile: string, locked: string, loose: string, flag: (dir: string) => string }>} */
const NODE_TOOLS = {
  npm: {
    lockfile: "package-lock.json",
    locked: "npm ci --ignore-scripts",
    loose: "npm install --ignore-scripts",
    flag: (dir) => ` --prefix ${dir}`,
  },
  pnpm: {
    lockfile: "pnpm-lock.yaml",
    locked: "pnpm install --frozen-lockfile --ignore-scripts",
    loose: "pnpm install --ignore-scripts",
    flag: (dir) => `--dir ${dir} `,
  },
  yarn: {
    lockfile: "yarn.lock",
    locked: "yarn install --frozen-lockfile --ignore-scripts",
    loose: "yarn install --ignore-scripts",
    flag: (dir) => `--cwd ${dir} `,
  },
};

/**
 * Command that installs the dependencies of a Node project at `dir` (relative
 * to root; "" for the root). Null for stacks without a known installer.
 * @param {string} root @param {string} dir @param {string | null} packageManager
 * @returns {string | null}
 */
export function installCommandFor(root, dir, packageManager) {
  const tool = packageManager ? NODE_TOOLS[packageManager] : undefined;
  if (!tool) return null;
  const locked = exists(root, join(dir, tool.lockfile));
  const base = locked ? tool.locked : tool.loose;
  if (!dir) return base;
  // npm takes --prefix after the subcommand; pnpm/yarn take their flag before it.
  return packageManager === "npm" ? `${base}${tool.flag(dir)}` : base.replace(" install", ` ${tool.flag(dir).trim()} install`);
}
