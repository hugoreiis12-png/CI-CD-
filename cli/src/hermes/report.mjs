/** @typedef {import("../types.js").OrchestrationPlan} OrchestrationPlan */
/** @typedef {import("../types.js").OrchestrationAction} OrchestrationAction */

const VERDICT_LABEL = { approve: "APROVADO", block: "BLOQUEADO", hold: "EM ESPERA" };

const ACTION_ICON = {
  approve: "✓", block: "✗", retry: "↻", escalate: "▲",
  fix: "⚙", promote: "→", quarantine: "◼", investigate: "◉",
};

/**
 * Renders the orchestration plan as human-readable text (pt-BR).
 * @param {OrchestrationPlan} plan
 * @returns {string}
 */
export function render(plan) {
  const lines = [];
  const source = plan.source === "hermes" ? `Hermes (${plan.model ?? "?"})` : "fallback determinístico";
  lines.push(`Orquestração — ${VERDICT_LABEL[plan.verdict] ?? plan.verdict.toUpperCase()} (confiança: ${plan.confidence}%) [${source}]`);
  lines.push(`Resumo: ${plan.summary}`);

  if (plan.actions.length) {
    lines.push("");
    lines.push(`Ações (${plan.actions.length}):`);
    for (const a of plan.actions) {
      const icon = ACTION_ICON[a.type] ?? "•";
      lines.push(`  ${icon} ${a.type.padEnd(12)} ${a.target}`);
      lines.push(`    ${a.reason}`);
      if (a.command) lines.push(`    $ ${a.command}`);
    }
  }

  if (plan.risks.length) {
    lines.push("");
    lines.push(`Riscos:`);
    for (const r of plan.risks) lines.push(`  ! ${r}`);
  }

  lines.push("");
  lines.push(`Próximo passo: ${plan.next_step}`);

  if (plan.error) {
    lines.push("");
    lines.push(`[hermes] LLM indisponível (${plan.error}) — usando plano determinístico.`);
  }

  return lines.join("\n");
}

/**
 * Renders the orchestration plan as JSON (for --json output).
 * @param {OrchestrationPlan} plan
 * @returns {string}
 */
export function renderJson(plan) {
  return `${JSON.stringify(plan, null, 2)}\n`;
}
