/** @typedef {import("../types.js").LlmSettings} LlmSettings */
/** @typedef {import("../types.js").Manifest} Manifest */

/**
 * LLM configuration resolution. Precedence:
 *   1. `.esteira/project.json` — `gate.llm` (per-gate) then top-level `llm`
 *   2. Environment — `ESTEIRA_LLM_ENDPOINT`, `ESTEIRA_LLM_MODEL`, `ESTEIRA_LLM_TIMEOUT_MS`
 *   3. Built-in defaults (the local Hermes3 8B node)
 *
 * `enabled: false` in the manifest is an explicit off switch that wins over
 * everything. The result is always a fully-resolved `LlmSettings` — an
 * invalid endpoint degrades to `endpoint: null` (feature off, fail-open for
 * the advisory layer: an LLM config typo must never break the gate).
 */

const DEFAULT_ENDPOINT = "http://192.168.0.140:11434";
const DEFAULT_MODEL = "hermes3:8b";
const DEFAULT_TIMEOUT_MS = 60_000;

/** @param {unknown} value @returns {value is string} */
const isNonEmptyString = (value) => typeof value === "string" && value.length > 0;
/** @param {unknown} value @returns {value is number} */
const isPositiveNumber = (value) => typeof value === "number" && Number.isFinite(value) && value > 0;
/** @param {unknown} value @returns {value is { enabled?: boolean, endpoint?: unknown, model?: unknown, timeoutMs?: unknown }} */
const isLlmBlock = (value) =>
  typeof value === "object" && value !== null &&
  ("enabled" in value || "endpoint" in value || "model" in value || "timeoutMs" in value);

/**
 * @param {Manifest | null | undefined} manifest
 * @param {{ endpoint?: string, model?: string, timeoutMs?: number } | null} [env]
 * @returns {LlmSettings}
 */
export function resolveLlmSettings(manifest, env = null) {
  const gateLlm = manifest && isLlmBlock(manifest.gate?.llm) ? manifest.gate.llm : null;
  const rootLlm = manifest && isLlmBlock(manifest.llm) ? manifest.llm : null;
  const block = gateLlm ?? rootLlm;

  const enabled = block && typeof block.enabled === "boolean"
    ? block.enabled
    : (process.env.ESTEIRA_LLM_ENABLED ?? "true") !== "false";

  const envEndpoint = isNonEmptyString(env?.endpoint) ? env.endpoint : process.env.ESTEIRA_LLM_ENDPOINT;
  const envModel = isNonEmptyString(env?.model) ? env.model : process.env.ESTEIRA_LLM_MODEL;
  const envTimeout = isPositiveNumber(env?.timeoutMs) ? env.timeoutMs : Number(process.env.ESTEIRA_LLM_TIMEOUT_MS);

  const endpointRaw = isNonEmptyString(block?.endpoint) ? block.endpoint : isNonEmptyString(envEndpoint) ? envEndpoint : DEFAULT_ENDPOINT;
  const endpoint = /^(https?|ws):\/\//.test(String(endpointRaw)) ? endpointRaw : `http://${endpointRaw}`;

  const model = isNonEmptyString(block?.model) ? String(block.model) : isNonEmptyString(envModel) ? String(envModel) : DEFAULT_MODEL;

  const timeoutMs = isPositiveNumber(block?.timeoutMs)
    ? block.timeoutMs
    : (Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : DEFAULT_TIMEOUT_MS);

  return { endpoint: enabled ? endpoint : null, model, timeoutMs: Math.round(timeoutMs) };
}
