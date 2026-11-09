/** @typedef {import("../types.js").CommandResult} CommandResult */
/** @typedef {import("../types.js").Finding} Finding */
/** @typedef {import("../types.js").Severity} Severity */
import { countFailures } from "./runner.mjs";

/** @param {string} rule @param {Severity} severity @param {string} message @returns {Finding} */
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
/**
 * @param {{ staged: CommandResult, baseline: CommandResult | null, settings: { timeoutMs: number } }} input
 * @returns {{ ok: boolean, finding: Finding | null, lines: string[] }}
 */
export function evaluateSuite({ staged, baseline, settings }) {
  if (staged.code === "timeout") {
    return {
      finding: finding(
        "playground-timeout", "high",
        `A suíte de testes passou do limite de ${settings.timeoutMs} ms do playground; commit bloqueado.`,
      ),
      lines: [`testes ${staged.cmd}: ESTOUROU O TEMPO (>${settings.timeoutMs} ms)`],
      ok: false,
    };
  }
  if (staged.code === 127) {
    return {
      finding: finding(
        "playground-skipped", "low",
        `O comando de teste não roda no playground (${staged.cmd}) — o snapshot não tem node_modules nem arquivos ignorados pelo git.`,
      ),
      lines: [`testes ${staged.cmd}: comando não encontrado (127)`],
      ok: true,
    };
  }
  if (staged.code === 0) {
    return {
      finding: null,
      lines: [`testes ${staged.cmd}: OK (${staged.ms} ms)`],
      ok: true,
    };
  }

  const baselineClean = baseline ? baseline.code === 0 : true;
  const before = baselineClean ? 0 : countFailures(baseline?.stdout);
  const after = countFailures(staged.stdout);

  if (baselineClean) {
    return {
      finding: finding(
        "suite-failure", "high",
        `Os testes falharam no snapshot staged (${after} falha(s)); no HEAD eles passavam — quebra introduzida por esta mudança.`,
      ),
      lines: [`testes ${staged.cmd}: FALHOU depois=${after} antes=0 (${staged.ms} ms)`],
      ok: false,
    };
  }
  if (after > before) {
    return {
      finding: finding(
        "regression", "high",
        `O número de falhas aumentou em relação ao HEAD: ${before} → ${after}.`,
      ),
      lines: [`testes ${staged.cmd}: FALHOU depois=${after} antes=${before} (${staged.ms} ms)`],
      ok: false,
    };
  }
  return {
    finding: finding(
      "pre-existing-failures", "low",
      `As falhas já existiam no HEAD e não pioraram (${before} → ${after}); registro mantido.`,
    ),
    lines: [`testes ${staged.cmd}: FALHOU (preexistente) depois=${after} antes=${before}`],
    ok: true,
  };
}

/** Type-semantics gate against the staged snapshot (no baseline needed). */
/**
 * @param {{ staged: CommandResult, baseline?: CommandResult | null, settings: { timeoutMs: number } }} input
 *   Like the suite gate: errors that already exist in the baseline do not
 *   block; only a change that adds type errors does.
 * @returns {{ ok: boolean, finding: Finding | null, lines: string[] }}
 */
export function evaluateTypecheck({ staged, baseline = null, settings }) {
  if (staged.code === "timeout") {
    return {
      finding: finding(
        "playground-timeout", "high",
        `O typecheck passou do limite de ${settings.timeoutMs} ms do playground.`,
      ),
      lines: [`tipos   ${staged.cmd}: ESTOUROU O TEMPO`],
      ok: false,
    };
  }
  if (staged.code === 127) {
    return {
      finding: finding("playground-skipped", "low", `O comando de typecheck não roda no playground (${staged.cmd}).`),
      lines: [`tipos   ${staged.cmd}: comando não encontrado (127)`],
      ok: true,
    };
  }
  if (staged.code !== 0) {
    const after = staged.errors ?? 0;
    const baselineFailed = baseline && baseline.code !== 0 && baseline.code !== 127 && baseline.code !== "timeout";
    const before = baselineFailed ? baseline.errors ?? 0 : 0;
    if (baselineFailed && after <= before) {
      return {
        finding: finding(
          "pre-existing-type-errors", "low",
          `O typecheck já falhava na base e esta mudança não piorou (${before} → ${after} erro(s)); não bloqueia, mas vale corrigir.`,
        ),
        lines: [`tipos   ${staged.cmd}: FALHOU (preexistente) depois=${after} antes=${before} (${staged.ms} ms)`],
        ok: true,
      };
    }
    return {
      finding: finding(
        "playground-typecheck", "medium",
        baselineFailed
          ? `Esta mudança aumentou os erros de tipo: ${before} → ${after} (${staged.cmd}).`
          : `O typecheck falhou no snapshot staged${baseline ? " e passava na base" : ""} (${after} erro(s), ${staged.cmd}).`,
      ),
      lines: [`tipos   ${staged.cmd}: FALHOU depois=${after} antes=${baselineFailed ? before : 0} (${staged.ms} ms)`],
      ok: false,
    };
  }
  return { finding: null, lines: [`tipos   ${staged.cmd}: OK (${staged.ms} ms)`], ok: true };
}
