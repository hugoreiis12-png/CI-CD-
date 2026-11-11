import { errorLine } from "../lib/fs-tools.mjs";
import { gitText } from "../playground/workspace.mjs";

/**
 * Shared shapes and helpers of the agent tools (local and GitHub).
 *
 * @typedef {{ root: string }} ToolContext
 * @typedef {{ description: string, args: string, run: (ctx: ToolContext, args: Record<string, unknown>) => string | Promise<string> }} AgentTool
 */

export const MAX_READ_CHARS = 12_000;
export const MAX_LIST = 300;
export const MAX_LOG_CHARS = 4_000;
export const MAX_REMOTE_ITEMS = 50;

/** @param {string} value @param {number} max */
export const clip = (value, max) => (value.length > max ? `${value.slice(0, max)}\n…[cortado em ${max} caracteres]` : value);

/** @param {unknown} value */
export const text = (value) => (typeof value === "string" ? value : "");

/** Integer argument within [1, max]; anything else falls back. @param {unknown} value @param {number} fallback @param {number} max */
export const intArg = (value, fallback, max) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback;
};

/** Git read in `root`; a failure becomes a readable line instead of a throw. @param {string} root @param {string[]} args */
export const gitOrError = (root, args) => {
  try {
    return gitText(root, args);
  } catch (error) {
    return `git falhou: ${errorLine(error)}`;
  }
};
