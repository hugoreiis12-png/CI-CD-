import { countFailures } from "./runner.mjs";

const finding = (rule, severity, message) => ({
  check: "playground", rule, severity, file: "*", line: null, message,
});

/**
 * Contract/regression gate: the project's own suite runs against the staged
 * snapshot; compared against a baseline run of HEAD when available.
 *   - staged suite fails, baseline clean            → high (suite-failure)
 *   - failure count worse than a failing baseline   → high (regression)
 *   - failure count equal/better than baseline      → low (pre-existing, not blocking)
 */
export function evaluateSuite({ staged, baseline, settings }) {
  if (staged.code === "timeout") {
    return {
      finding: finding(
        "playground-timeout", "high",
        `Test suite exceeded the ${settings.timeoutMs} ms playground budget; commit blocked.`,
      ),
      lines: [`suite  ${staged.cmd}: TIMEOUT (>${settings.timeoutMs} ms)`],
      ok: false,
    };
  }
  if (staged.code === 127) {
    return {
      finding: finding(
        "playground-skipped", "low",
        `Test command not runnable in playground (${staged.cmd}) — ensure dependencies are installed.`,
      ),
      lines: [`suite  ${staged.cmd}: command not found (127)`],
      ok: true,
    };
  }
  if (staged.code === 0) {
    return {
      finding: null,
      lines: [`suite  ${staged.cmd}: OK (${staged.ms} ms)`],
      ok: true,
    };
  }

  const baselineClean = baseline ? baseline.code === 0 : true;
  const before = baselineClean ? 0 : countFailures(baseline.stdout);
  const after = countFailures(staged.stdout);

  if (baselineClean) {
    return {
      finding: finding(
        "suite-failure", "high",
        `Playground suite failed on the staged snapshot (${after} failure(s)); HEAD baseline was clean — refactor/break detected.`,
      ),
      lines: [`suite  ${staged.cmd}: FAILED after=${after} before=0 (${staged.ms} ms)`],
      ok: false,
    };
  }
  if (after > before) {
    return {
      finding: finding(
        "regression", "high",
        `Failure count increased against the baseline: ${before} → ${after}.`,
      ),
      lines: [`suite  ${staged.cmd}: FAILED after=${after} before=${before} (${staged.ms} ms)`],
      ok: false,
    };
  }
  return {
    finding: finding(
      "pre-existing-failures", "low",
      `Failure count not worse than baseline (${before} → ${after}); record kept.`,
    ),
    lines: [`suite  ${staged.cmd}: FAILED (pre-existing) after=${after} before=${before}`],
    ok: true,
  };
}

/** Type-semantics gate against the staged snapshot (no baseline needed). */
export function evaluateTypecheck({ staged, settings }) {
  if (staged.code === "timeout") {
    return {
      finding: finding(
        "playground-timeout", "high",
        `Typecheck exceeded the ${settings.timeoutMs} ms playground budget.`,
      ),
      lines: [`check  ${staged.cmd}: TIMEOUT`],
      ok: false,
    };
  }
  if (staged.code === 127) {
    return {
      finding: finding("playground-skipped", "low", `Typecheck command not runnable (${staged.cmd}).`),
      lines: [`check  ${staged.cmd}: command not found (127)`],
      ok: true,
    };
  }
  if (staged.code !== 0) {
    return {
      finding: finding(
        "playground-typecheck", "medium",
        `Typecheck failed on the staged snapshot (${staged.cmd}).`,
      ),
      lines: [`check  ${staged.cmd}: FAIL (${staged.ms} ms)`],
      ok: false,
    };
  }
  return { finding: null, lines: [`check  ${staged.cmd}: OK (${staged.ms} ms)`], ok: true };
}
