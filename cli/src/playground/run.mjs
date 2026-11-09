/** @typedef {import("../types.js").Commands} Commands */
/** @typedef {import("../types.js").Finding} Finding */
/** @typedef {import("../types.js").PlaygroundSettings} PlaygroundSettings */
import fs from "node:fs";
import { stageCommit, headCommit, extractCommit, makeTempPlayground } from "./workspace.mjs";
import { runCommand } from "./runner.mjs";
import { evaluateSuite, evaluateTypecheck } from "./gates.mjs";

/**
 * Runs the gate matrix inside an isolated playground:
 *   1. snapshot commit  — index content as an anonymous commit (no ref updates)
 *   2. baseline commit  — HEAD (optional)
 *   3. both extracted to temp dirs via `git archive`
 *   4. commands run twice (staged + baseline) and compared
 * Nothing in the developer's working tree or the real repository is touched.
 */
/**
 * @param {{ root: string, settings?: Partial<PlaygroundSettings>, commands: Commands }} input
 * @returns {{ ran: true, findings: Finding[], lines: string[], results: object[], stagedSha: string, headSha: string | null }}
 */
export function runPlayground({ root, settings, commands }) {
  const configured = {
    timeoutMs: settings?.timeoutMs ?? 120_000,
    baseline: settings?.baseline !== false,
  };

  const stagedSha = stageCommit(root);
  const headSha = configured.baseline ? headCommit(root) : null;

  const stagedDir = makeTempPlayground();
  const baselineDir = headSha ? makeTempPlayground() : null;
  const tempDirs = baselineDir ? [stagedDir, baselineDir] : [stagedDir];

  try {
    extractCommit(root, stagedSha, stagedDir);
    if (baselineDir && headSha) extractCommit(root, headSha, baselineDir);

    /** @type {Finding[]} */
    const findings = [];
    const lines = [`staged ${stagedSha.slice(0, 10)}`, `HEAD   ${headSha ? headSha.slice(0, 10) : "(none)"}`];
    const results = [];

    if (commands.test) {
      const staged = runCommand(stagedDir, commands.test, { timeoutMs: configured.timeoutMs });
      const baseline = baselineDir
        ? runCommand(baselineDir, commands.test, { timeoutMs: configured.timeoutMs })
        : null;
      const evalResult = evaluateSuite({ staged, baseline, settings: configured });
      if (evalResult.finding) findings.push(evalResult.finding);
      lines.push(...evalResult.lines);
      results.push({ stage: "suite", cmd: commands.test, code: staged.code, ms: staged.ms, out: staged.stdout });
      if (baseline) {
        results.push({ stage: "suite-baseline", cmd: commands.test, code: baseline.code, ms: baseline.ms, out: baseline.stdout });
      }
    } else {
      findings.push({
        check: "playground", rule: "playground-skipped", severity: "low",
        file: "*", line: null,
        message: "No test command detected — suite gate skipped. Run `gh esteira init` again or add a test script.",
      });
      lines.push("suite  skipped (no test command)");
    }

    if (commands.typecheck) {
      const staged = runCommand(stagedDir, commands.typecheck, { timeoutMs: configured.timeoutMs });
      const evalResult = evaluateTypecheck({ staged, settings: configured });
      if (evalResult.finding) findings.push(evalResult.finding);
      lines.push(...evalResult.lines);
      results.push({ stage: "typecheck", cmd: commands.typecheck, code: staged.code, ms: staged.ms });
    }

    return { ran: true, findings, lines, results, stagedSha, headSha };
  } finally {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}
