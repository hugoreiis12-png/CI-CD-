/** @typedef {import("../types.js").CommandResult} CommandResult */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";

/** @param {string} cmd */
export function splitCommand(cmd) {
  return cmd.trim().split(/\s+/).filter(Boolean);
}

/**
 * Environment for playground commands. The host runner's variables must not
 * leak: NODE_TEST_CONTEXT (injected by Node's test harness) makes an inner
 * `node --test` act as a child harness and swallow exit codes.
 */
/** @param {NodeJS.ProcessEnv} [extra] @returns {NodeJS.ProcessEnv} */
export function gateEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  return env;
}

/**
 * On Windows, resolve a bare command name to its full executable path using
 * backslash separators (forward slashes cause cmd.exe to fail with
 * "syntax error"). `npm`, `yarn`, `pnpm` are .cmd shims — spawning them
 * directly raises EINVAL. Returns the name unchanged on POSIX.
 * @param {string} name @returns {string}
 */
function resolveOnWindows(name) {
  if (process.platform !== "win32") return name;
  if (name.includes("\\") || name.includes("/")) return name;
  const paths = (process.env.PATH ?? "").split(";").filter(Boolean);
  const exts = (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean);
  for (const dir of paths) {
    const normalized = dir.replace(/\/g/g, "");
    for (const ext of exts) {
      const candidate = `${normalized}\\${name}${ext.toLowerCase()}`;
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return name;
}

/**
 * Runs a command inside the playground dir with a hard timeout.
 * code: 0 = ok, "timeout" = killed by the gate, 127 = command not found.
 * stdout/stderr tails are kept for diagnosis and gate verdicts.
 */
/** @param {string} dir @param {string} cmd @returns {CommandResult} */
export function runCommand(dir, cmd, { timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  const argv = splitCommand(cmd);
  const isWin = process.platform === "win32";

  /** @type {{ status: number | null, stdout: string, stderr: string, error?: NodeJS.ErrnoException }} */
  let result;

  if (isWin) {
    // Windows: go through cmd.exe so .cmd/.bat shims (npm, yarn, …) work.
    // Use backslash paths — forward slashes cause cmd.exe syntax errors.
    const cmdExe = resolveOnWindows("cmd");
    result = spawnSync(cmdExe, ["/c", cmd], {
      cwd: dir,
      env: gateEnv(),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } else {
    result = spawnSync(argv[0], argv.slice(1), {
      cwd: dir,
      env: gateEnv(),
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 16,
      stdio: ["ignore", "pipe", "pipe"],
    });
  }

  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT";
  const code = timedOut ? "timeout" : result.status ?? "error";
  const full = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  // Counted on the full output: the kept tail would undercount long reports.
  return { cmd, code, ms: Date.now() - started, stdout: tail(full), errors: countErrors(full) };
}

const tail = (/** @type {string} */ s, max = 4000) => (s.length > max ? `…${s.slice(-max)}` : s);

/**
 * Error count of a typecheck/lint report: tsc ("error TS1234"), mypy
 * ("Found N errors"), pyright ("N errors"), else lines containing "error".
 * @param {string} output
 */
export function countErrors(output) {
  const tsc = output.match(/\berror TS\d+/g);
  if (tsc) return tsc.length;
  const summary = output.match(/(?:Found\s+)?(\d+)\s+errors?\b/i);
  if (summary) return Number.parseInt(summary[1], 10);
  return output.split("\n").filter((line) => /\berror\b/i.test(line)).length;
}

/**
 * Best-effort failure count from test-runner output. Reads failure summaries
 * line-by-line and accepts the number either before ("2 failed", jest) or
 * after ("fail 1", node TAP / "failures: 1", pytest) the keyword; falls back
 * to counting "FAIL" markers (jest/vitest/go style).
 */
/** @param {string | null | undefined} output */
export function countFailures(output) {
  const text = output ?? "";
  const counts = [];
  for (const line of text.split("\n")) {
    if (!/\bfail(?:ed|ure|ures)?\b/i.test(line)) continue;
    counts.push(Number.parseInt(line.match(/(\d+)\s*fail(?:ed|ure|ures)?\b/i)?.[1] ?? "", 10));
    counts.push(Number.parseInt(line.match(/\bfail(?:ed|ure|ures)?\b\s*:?\s*(\d+)/i)?.[1] ?? "", 10));
  }
  const valid = counts.filter((n) => Number.isInteger(n));
  if (valid.length) return Math.max(0, ...valid);
  return [...text.matchAll(/\bFAIL\b/g)].length;
}
