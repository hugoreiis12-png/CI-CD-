/** @typedef {import("../types.js").Finding} Finding */
/** @typedef {import("../types.js").StagedFile} StagedFile */
/** @typedef {import("../types.js").GateConfig} GateConfig */
/** @typedef {import("../types.js").Manifest} Manifest */
/** @typedef {import("../types.js").AuditRecord} AuditRecord */
/** @typedef {import("../types.js").OrchestrationAction} OrchestrationAction */
/** @typedef {import("../types.js").OrchestrationPlan} OrchestrationPlan */
import { generate } from "./adapter.mjs";
import { resolveLlmSettings } from "./config.mjs";

/**
 * Hermes orchestrator — full CI/CD decision loop.
 *
 * The orchestrator reads the complete state of the pipeline (gate verdict,
 * CVE audit, playground results, CI workflow status) and produces a
 * structured, executable action plan. It is advisory-only in the sense that
 * deterministic checks remain the final enforcement point: the orchestrator
 * cannot override a block triggered by severity >= blockAt or a CVE with
 * severity >= failOn. What it CAN do:
 *
 *   - APPROVE  — confirm the pipeline is safe to proceed (with confidence)
 *   - BLOCK    — reinforce or explain a deterministic block; add context
 *   - RETRY    — identify transient failures (network, timeout) worth retrying
 *   - ESCALATE — flag issues that need human intervention (security review,
 *                policy decision, architecture change)
 *   - FIX      — produce concrete remediation steps (upgrade commands, code
 *                changes, config fixes)
 *   - PROMOTE  — confirm readiness for the next stage (staging, production)
 *   - QUARANTINE — isolate a specific dependency or component for investigation
 *
 * The action plan is a JSON object (parsed from the LLM response) with:
 *   {
 *     "verdict": "approve" | "block" | "hold",
 *     "confidence": 0-100,
 *     "actions": [{ "type": "...", "target": "...", "reason": "...", "command": "..." }],
 *     "summary": "1-2 sentence human-readable summary in pt-BR",
 *     "risks": ["..."],
 *     "next_step": "what happens after this action is taken"
 *   }
 *
 * If the LLM is unreachable or returns unparseable output, the orchestrator
 * falls back to a deterministic-only plan (no LLM intelligence, just the
 * mechanical result).
 */

// ---- Action types the orchestrator can emit ----
/** @type {string[]} */
const VALID_ACTIONS = ["approve", "block", "retry", "escalate", "fix", "promote", "quarantine", "investigate"];
/** @type {string[]} */
const VALID_VERDICTS = ["approve", "block", "hold"];

/** @param {string} text @param {number} max */
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
const MAX_PROMPT_CHARS = 8_000;

/**
 * The system prompt that defines Hermes as the full CI/CD orchestrator.
 */
const SYSTEM_PROMPT = [
  "Você é o Hermes, o orquestrador de CI/CD e segurança da Esteira.",
  "Você tem a competência total para analisar o estado do pipeline e determinar as próximas ações.",
  "",
  "Suas competências:",
  "- Segurança: aprovar ou bloquear com base em severidade de findings e CVEs",
  "- Dependências: triage de vulnerabilidades, priorização de upgrades, quarantining",
  "- Pipeline: identificar falhas transitórias (retry), falhas de código (fix), problemas de arquitetura (escalate)",
  "- Qualidade: avaliar cobertura de testes, typecheck, lint e sugerir melhorias",
  "- Infraestrutura: analisar configuração de CI/CD, detectar gaps e sugerir correções",
  "",
  "Regras inegociáveis:",
  "- Você NÃO pode reverter um bloqueio determinístico: se a severidade do finding >= blockAt, o bloco é mantido",
  "- Você NÃO pode aprovar se há CVEs com severidade >= failOn",
  "- Você PODE reforçar um bloqueio com contexto adicional",
  "- Você PODE sugerir retry para falhas transitórias (timeout, network, flaky test)",
  "- Você PODE sugerir quarantine para dependências problemáticas",
  "- Você PODE sugerir promote quando tudo está verde",
  "",
  "Formato da resposta (JSON estrito, sem markdown, sem comentários):",
  '{ "verdict": "approve|block|hold", "confidence": <0-100>, "actions": [{"type":"approve|block|retry|escalate|fix|promote|quarantine|investigate","target":"<descrição curta>","reason":"<por que>","command":"<comando shell se aplicável, senão vazio>"}], "summary":"<1-2 frases em português>","risks":["<risco1>","<risco2>"],"next_step":"<o que acontece depois>" }',
  "",
  "Responda APENAS com o JSON. Nada antes, nada depois.",
].join("\n");

/**
 * @typedef {{
 *   gate?: { verdict: string, findings: Finding[], files: StagedFile[], config: GateConfig, playground: unknown }
 *   audit?: { record: AuditRecord }
 *   ci?: { workflows: { name: string, status: string, conclusion: string | null }[] }
 * }} PipelineState
 *
 * The full state of the pipeline that the orchestrator sees.
 */

/**
 * The portion of the plan that the LLM (or the deterministic fallback)
 * produces before the source/model/ms/error metadata is attached.
 */
/** @typedef {Pick<OrchestrationPlan, "verdict" | "confidence" | "actions" | "summary" | "risks" | "next_step">} PlanCore */

/**
 * Runs the full orchestration loop: builds the prompt from pipeline state,
 * calls the LLM, parses the JSON response, applies deterministic guards,
 * and returns the final plan.
 *
 * @param {{
 *   manifest: Manifest | null,
 *   state: PipelineState,
 *   fetchImpl?: unknown,
 *   timeoutMs?: number,
 * }} input
 * @returns {Promise<OrchestrationPlan>}
 */
export async function orchestrate({ manifest, state, fetchImpl, timeoutMs }) {
  const settings = resolveLlmSettings(manifest);

  // Build the state description for the prompt
  const stateText = buildStateText(state);

  const prompt = [SYSTEM_PROMPT, "", "=== ESTADO DO PIPELINE ===", stateText].join("\n");

  // Deterministic fallback plan (used if LLM is unavailable or fails)
  const fallback = deterministicPlan(state);

  if (!settings.endpoint) {
    return { ...fallback, source: "deterministic-fallback", error: null };
  }

  try {
    const result = await generate({
      settings,
      prompt: truncate(prompt, MAX_PROMPT_CHARS),
      fetchImpl,
      timeoutMs,
    });

    if (result.status === "skipped") {
      return { ...fallback, source: "deterministic-fallback", error: null };
    }
    if (result.status === "error") {
      return { ...fallback, source: "deterministic-fallback", error: result.error };
    }

    // Parse the JSON response
    const parsed = parsePlan(result.text);
    if (!parsed) {
      return { ...fallback, source: "deterministic-fallback", error: "resposta do LLM não é JSON válido" };
    }

    // Apply deterministic guards: the LLM cannot override hard rules
    const guarded = applyGuards(parsed, state);

    return {
      ...guarded,
      source: "hermes",
      model: settings.model,
      ms: result.ms,
      error: null,
    };
  } catch (error) {
    return {
      ...fallback,
      source: "deterministic-fallback",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Builds a concise text description of the pipeline state for the LLM prompt.
 * @param {PipelineState} state
 * @returns {string}
 */
export function buildStateText(state) {
  const parts = [];

  // Gate state
  if (state.gate) {
    const { verdict, findings, files, config, playground } = state.gate;
    parts.push(`## GATE`);
    parts.push(`Veredito: ${verdict}`);
    parts.push(`Política: modo=${config.mode}, blockAt=${config.blockAt}`);
    parts.push(`Arquivos: ${files.length}`);
    if (files.length > 0) {
      const fileList = files.slice(0, 20).map((f) => {
        const delta = f.insertions != null && f.deletions != null ? ` (+${f.insertions}/-${f.deletions})` : "";
        return `  ${f.path}${delta}`;
      }).join("\n");
      parts.push(`Mudanças:\n${fileList}`);
    }
    if (findings.length > 0) {
      const f = findings.slice(0, 30).map((f) =>
        `  [${f.severity}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`
      ).join("\n");
      parts.push(`Findings (${findings.length}):\n${f}`);
    } else {
      parts.push(`Findings: nenhum`);
    }
    if (playground && typeof playground === "object") {
      const p = /** @type {any} */ (playground);
      if (p.ran === false) {
        parts.push(`Playground: NÃO RODOU (${p.reason ?? "desconhecido"})`);
      } else if (p.ran) {
        const lines = Array.isArray(p.lines) ? p.lines.join("\n") : JSON.stringify(p.lines ?? "");
        parts.push(`Playground: ran=true\n${truncate(lines, 500)}`);
      }
    }
  }

  // Audit state
  if (state.audit) {
    const { record } = state.audit;
    parts.push(``);
    parts.push(`## AUDIT (CVEs)`);
    parts.push(`Veredito: ${record.verdict} (failOn=${record.failOn})`);
    parts.push(`Dependências: ${record.sbom.total}`);
    parts.push(`Advisories: ${record.advisoryCount}, bloqueantes: ${record.blockers}`);
    if (record.findings.length > 0) {
      const f = record.findings.slice(0, 30).map((f) =>
        `  [${f.severity}] ${f.id} ${f.ecosystem}/${f.package}@${f.version}${f.fixed?.length ? ` (fix: >= ${f.fixed[f.fixed.length - 1]})` : ""} — ${f.summary}`
      ).join("\n");
      parts.push(`Advisories:\n${f}`);
    } else {
      parts.push(`Advisories: nenhum`);
    }
  }

  // CI state
  if (state.ci && state.ci.workflows.length > 0) {
    parts.push(``);
    parts.push(`## CI/CD (workflows)`);
    for (const wf of state.ci.workflows) {
      parts.push(`  ${wf.status === "completed" ? (wf.conclusion ?? "?") : wf.status.padEnd(10)} ${wf.name}`);
    }
  }

  return parts.join("\n");
}

/**
 * Parses the LLM's JSON response into a plan core. Returns null on parse failure.
 * @param {string} text
 * @returns {PlanCore | null}
 */
function parsePlan(text) {
  try {
    // The LLM may wrap JSON in code fences; strip them
    const cleaned = text.replace(/^```(?:json)?\s*/m, "").replace(/\s*```$/m, "").trim();
    const obj = JSON.parse(cleaned);

    const verdict = VALID_VERDICTS.includes(obj.verdict) ? /** @type {OrchestrationPlan["verdict"]} */ (obj.verdict) : "hold";
    const confidence = Math.max(0, Math.min(100, Number(obj.confidence) || 0));
    /** @type {OrchestrationAction[]} */
    const actions = Array.isArray(obj.actions)
      ? obj.actions
          .filter((/** @type {any} */ a) => a && typeof a === "object" && VALID_ACTIONS.includes(a.type))
          .map((/** @type {any} */ a) => ({
            type: /** @type {OrchestrationAction["type"]} */ (a.type),
            target: typeof a.target === "string" ? a.target : "desconhecido",
            reason: typeof a.reason === "string" ? a.reason : "",
            command: typeof a.command === "string" ? a.command : "",
          }))
      : [];
    const summary = typeof obj.summary === "string" ? obj.summary : "";
    const risks = Array.isArray(obj.risks) ? obj.risks.filter((/** @type {any} */ r) => typeof r === "string") : [];
    const next_step = typeof obj.next_step === "string" ? obj.next_step : "";

    return { verdict, confidence, actions, summary, risks, next_step };
  } catch {
    return null;
  }
}

/**
 * Applies deterministic guards to the LLM's plan:
 *  - If there are blocking findings (severity >= blockAt), the verdict CANNOT be "approve"
 *  - If there are blocking CVEs (severity >= failOn), the verdict CANNOT be "approve"
 *  - If the LLM says "block" but there are no blocking findings/CVEs, allow it (Hermes can be stricter)
 * @param {PlanCore} plan
 * @param {PipelineState} state
 * @returns {PlanCore}
 */
function applyGuards(plan, state) {
  const hasBlockingFinding = state.gate?.findings.some(
    (f) => f.severity === "high"
  );
  const hasBlockingCve = state.audit?.record.findings.some(
    (f) => f.severity === "critical" || f.severity === "high"
  );

  // Hard rule: if there's a critical/high finding or CVE, we cannot approve
  if ((hasBlockingFinding || hasBlockingCve) && plan.verdict === "approve") {
    plan.verdict = "block";
    plan.confidence = 100;
    plan.risks = [...new Set([...plan.risks, "bloqueio determinístico: finding/CVE crítico ou alto presente"])];
  }

  return plan;
}

/**
 * Builds a deterministic fallback plan (no LLM intelligence).
 * @param {PipelineState} state
 * @returns {PlanCore}
 */
function deterministicPlan(state) {
  const findings = state.gate?.findings ?? [];
  const cves = state.audit?.record?.findings ?? [];
  const gateVerdict = state.gate?.verdict ?? "approved";
  const auditVerdict = state.audit?.record?.verdict ?? "clean";

  const blockingFindings = findings.filter((f) => f.severity === "high");
  const blockingCves = cves.filter((f) => f.severity === "critical" || f.severity === "high");

  const hasBlockers = blockingFindings.length > 0 || blockingCves.length > 0;

  /** @type {OrchestrationAction[]} */
  const actions = [];

  if (hasBlockers) {
    actions.push({
      type: "block",
      target: "pipeline",
      reason: `${blockingFindings.length} finding(s) e ${blockingCves.length} CVE(s) com severidade bloqueante`,
      command: "",
    });
    for (const f of blockingFindings.slice(0, 5)) {
      actions.push({
        type: "fix",
        target: f.file,
        reason: `${f.rule}: ${f.message}`,
        command: "",
      });
    }
    for (const cve of blockingCves.slice(0, 5)) {
      actions.push({
        type: "fix",
        target: `${cve.ecosystem}/${cve.package}`,
        reason: `${cve.id}: ${cve.summary}${cve.fixed?.length ? ` → upgrade para >= ${cve.fixed[cve.fixed.length - 1]}` : ""}`,
        command: cve.fixed?.length ? `npm install ${cve.package}@>=${cve.fixed[cve.fixed.length - 1]}` : "",
      });
    }
  } else if (gateVerdict === "approved" && auditVerdict === "clean") {
    actions.push({
      type: "approve",
      target: "pipeline",
      reason: "nenhum finding ou CVE bloqueante",
      command: "",
    });
  }

  return {
    verdict: hasBlockers ? "block" : "approve",
    confidence: 100,
    actions,
    summary: hasBlockers
      ? `Bloqueado: ${blockingFindings.length + blockingCves.length} item(ns) bloqueante(s).`
      : "Pipeline limpo — aprovado.",
    risks: hasBlockers
      ? blockingFindings.slice(0, 3).map((f) => f.message)
      : [],
    next_step: hasBlockers
      ? "Corrija os itens bloqueantes e rode o gate novamente."
      : "Pronto para merge/push.",
  };
}
