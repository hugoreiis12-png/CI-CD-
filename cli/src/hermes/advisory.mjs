/** @typedef {import("../types.js").Finding} Finding */
/** @typedef {import("../types.js").StagedFile} StagedFile */
/** @typedef {import("../types.js").GateConfig} GateConfig */
/** @typedef {import("../types.js").Manifest} Manifest */
/** @typedef {import("../types.js").AuditFinding} AuditFinding */
/** @typedef {import("../types.js").AuditRecord} AuditRecord */
/** @typedef {import("../types.js").LlmSettings} LlmSettings */
import { generate } from "./adapter.mjs";
import { resolveLlmSettings } from "./config.mjs";

/**
 * The Hermes orchestration layer: builds a concise, task-specific prompt
 * from the deterministic results of the pipeline and asks the LLM for an
 * advisory read — never a verdict. Deterministic checks remain the
 * enforcement point; Hermes explains, prioritizes and suggests fixes.
 *
 * Every entry point:
 *  - reads the LLM config from the manifest (gate.llm / llm) + environment,
 *  - degrades to a null advisory when the endpoint is disabled/unreachable
 *    (the caller proceeds as if Hermes were absent),
 *  - caps prompt length so an oversized staged set never blows the context.
 */

/** @param {string} text @param {number} max */
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);

const MAX_PROMPT_CHARS = 6_000;

/**
 * Asks Hermes to explain a gate outcome (or the findings behind it).
 * The advisory is informational: it never changes the verdict.
 * @param {{
 *   root: string,
 *   manifest: Manifest | null,
 *   config: GateConfig,
 *   verdict: string,
 *   findings: Finding[],
 *   files: StagedFile[],
 *   fetchImpl?: unknown,
 * }} input
 * @returns {Promise<{ model: string, text: string, ms: number, error: string | null } | null>}
 */
export async function gateAdvisory({ manifest, config, verdict, findings, files, fetchImpl }) {
  const settings = resolveLlmSettings(manifest);
  if (!settings.endpoint) return null;

  const changed = files.map((f) => {
    const delta = f.insertions == null && f.deletions == null ? "" : ` (+${f.insertions ?? 0}/-${f.deletions ?? 0})`;
    return `${f.path}${delta}`;
  }).join(", ");

  const findingsText = findings.length
    ? findings.slice(0, 30).map((f) => `- [${f.severity}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`).join("\n")
    : "(nenhum finding)";

  const prompt = [
    "Você é o Hermes, o orquestrador de segurança da Esteira (gh-esteira).",
    "Analise o resultado determinístico deste gate de pré-commit e dê um parecer CONciso, em português.",
    "",
    `Mudanças: ${files.length} arquivo(s) — ${changed || "(lista vazia)"}`,
    `Política: modo=${config.mode}, bloqueia a partir de severidade ${config.blockAt}.`,
    `Veredito determinístico: ${verdict}.`,
    "",
    "Findings:",
    findingsText,
    "",
    "Responda em até 4 frases: (1) leitura do risco da mudança, (2) o que mais importa corrigir se houver findings, (3) risco real vs. falso positivo, (4) uma recomendação concreta.",
    "Nunca altere o veredito; apenas explique e priorize.",
  ].join("\n");

  const result = await generate({ settings, prompt: truncate(prompt, MAX_PROMPT_CHARS), fetchImpl });
  if (result.status === "skipped") return null;
  return { model: settings.model, text: result.text, ms: result.ms, error: result.error };
}

/**
 * Asks Hermes to triage the CVE audit: rank what to fix first, flag likely
 * false positives (dev-only, unused, patched-in-range) and give concrete
 * upgrade commands. Advisory only — the `failOn` rule still decides.
 * @param {{
 *   manifest: Manifest | null,
 *   record: AuditRecord,
 *   fetchImpl?: unknown,
 * }} input
 * @returns {Promise<{ model: string, text: string, ms: number, error: string | null } | null>}
 */
export async function auditAdvisory({ manifest, record, fetchImpl }) {
  const settings = resolveLlmSettings(manifest);
  if (!settings.endpoint) return null;

  const lines = record.findings.slice(0, 40).map((f) =>
    `- [${f.severity}] ${f.id} ${f.ecosystem}/${f.package}@${f.version}${f.fixed?.length ? ` (fix: >= ${f.fixed[f.fixed.length - 1]})` : ""} — ${f.summary}`,
  );

  const prompt = [
    "Você é o Hermes, o orquestrador de segurança da Esteira (gh-esteira).",
    "Faça o triage desta auditoria de CVEs das dependências e dê um parecer CONciso, em português.",
    "",
    `Resultado determinístico: ${record.verdict} (failOn=${record.failOn}); ${record.advisoryCount} advisory(s), ${record.blockers} bloqueante(s).`,
    "",
    "Advisories:",
    lines.length ? lines.join("\n") : "(nenhum)",
    "",
    "Responda em até 5 frases: (1) priorize o que corrigir primeiro e por quê, (2) aponte prováveis falsos positivos ou baixo risco (dev-dependency, transitive não utilizada), (3) sugira comandos de atualização concretos para o ecossistema do projeto, (4) risque de ação imediata o que pode esperar, (5) uma recomendação para a política (ex.: subir failOn, pinar versões).",
    "Nunca altere o veredito; apenas triage e priorize.",
  ].join("\n");

  const result = await generate({ settings, prompt: truncate(prompt, MAX_PROMPT_CHARS), fetchImpl });
  if (result.status === "skipped") return null;
  return { model: settings.model, text: result.text, ms: result.ms, error: result.error };
}
