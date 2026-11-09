/** @typedef {import("../types.js").Commands} Commands */
/** @typedef {import("../types.js").Finding} Finding */
/** @typedef {import("../types.js").PlaygroundSettings} PlaygroundSettings */
import fs from "node:fs";
import { stageCommit, headCommit, extractCommit, makeTempPlayground, linkDependencies } from "./workspace.mjs";
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
 * @param {{ root: string, settings?: Partial<PlaygroundSettings>, commands: Commands, baselineRef?: string | null, stagedRef?: string }} input
 *   baselineRef: commit to compare against (default HEAD; null = no baseline)
 *   stagedRef:   commit to judge instead of the index (pre-push / commit ranges)
 * @returns {{ ran: true, findings: Finding[], lines: string[], results: object[], stagedSha: string, headSha: string | null }}
 */
export function runPlayground({ root, settings, commands, baselineRef, stagedRef }) {
  const configured = {
    timeoutMs: settings?.timeoutMs ?? 120_000,
    baseline: settings?.baseline !== false,
  };

  const stagedSha = stagedRef ?? stageCommit(root);
  const headSha = configured.baseline ? (baselineRef === undefined ? headCommit(root) : baselineRef) : null;

  const stagedDir = makeTempPlayground();
  const baselineDir = headSha ? makeTempPlayground() : null;
  const tempDirs = baselineDir ? [stagedDir, baselineDir] : [stagedDir];

  try {
    extractCommit(root, stagedSha, stagedDir);
    if (baselineDir && headSha) extractCommit(root, headSha, baselineDir);
    const linked = linkDependencies(root, stagedDir);
    if (baselineDir) linkDependencies(root, baselineDir);

    /** @type {Finding[]} */
    const findings = [];
    const lines = [`staged ${stagedSha.slice(0, 10)}`, `base   ${headSha ? headSha.slice(0, 10) : "(nenhuma)"}`];
    if (linked.length) lines.push(`deps   reaproveitadas do projeto: ${linked.join(", ")}`);
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
        message: "Nenhum comando de teste configurado — testes pulados. Defina profile.commands.test no .esteira/project.json.",
      });
      lines.push("testes pulados (nenhum comando de teste)");
    }

    if (commands.typecheck) {
      const staged = runCommand(stagedDir, commands.typecheck, { timeoutMs: configured.timeoutMs });
      // Baseline only when needed: a clean staged typecheck has nothing to compare.
      const baseline = staged.code !== 0 && staged.code !== 127 && staged.code !== "timeout" && baselineDir
        ? runCommand(baselineDir, commands.typecheck, { timeoutMs: configured.timeoutMs })
        : null;
      const evalResult = evaluateTypecheck({ staged, baseline, settings: configured });
      if (evalResult.finding) findings.push(evalResult.finding);
      lines.push(...evalResult.lines);
      results.push({ stage: "typecheck", cmd: commands.typecheck, code: staged.code, ms: staged.ms });
    }

    return { ran: true, findings, lines, results, stagedSha, headSha };
  } finally {
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
  }
}
