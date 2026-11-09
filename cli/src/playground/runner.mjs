/** @typedef {import("../types.js").CommandResult} CommandResult */
import { spawnSync } from "node:child_process";

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
 * Runs a command inside the playground dir with a hard timeout.
 * code: 0 = ok, "timeout" = killed by the gate, 127 = command not found.
 * stdout/stderr tails are kept for diagnosis and gate verdicts.
 */
/** @param {string} dir @param {string} cmd @returns {CommandResult} */
export function runCommand(dir, cmd, { timeoutMs = 120_000 } = {}) {
  const started = Date.now();
  const argv = splitCommand(cmd);
  const result = spawnSync(argv[0], argv.slice(1), {
    cwd: dir,
    env: gateEnv(),
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 16,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const timedOut = /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code === "ETIMEDOUT";
  const code = timedOut ? "timeout" : result.status ?? "error";
  const stdout = tail(`${result.stdout ?? ""}\n${result.stderr ?? ""}`);
  return { cmd, code, ms: Date.now() - started, stdout };
}

const tail = (/** @type {string} */ s, max = 4000) => (s.length > max ? `…${s.slice(-max)}` : s);

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
