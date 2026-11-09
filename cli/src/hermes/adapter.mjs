/** @typedef {import("../types.js").LlmSettings} LlmSettings */

/**
 * Ollama /api/generate transport for the Hermes LLM — the advisory
 * orchestrator layer of the Esteira CLI.
 *
 * Design rules:
 *  - Advisory only. Hermes never sets, overrides or softens a verdict:
 *    deterministic checks (gate checks, CVE severity >= failOn) are the
 *    enforcement point; Hermes explains and prioritizes.
 *  - Never a failure source. Any transport/parse error degrades to
 *    `{ ...fields, error }` and the pipeline continues without the LLM.
 *  - Offline-safe: `endpoint: null` (or disabled config) short-circuits to
 *    `skipped` with zero network traffic — tests and air-gapped repos never
 *    pay a round trip.
 *
 * `fetchImpl` is injectable so tests run fully offline: a fake `fetch` is
 * passed in and never touches the network.
 */

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One LLM completion via Ollama `/api/generate`.
 * @param {{
 *   settings: LlmSettings,
 *   prompt: string,
 *   fetchImpl?: unknown,
 *   timeoutMs?: number,
 * }} input
 * @returns {Promise<{ status: "ok" | "skipped" | "error", text: string, ms: number, error: string | null }>}
 */
export async function generate({ settings, prompt, fetchImpl, timeoutMs }) {
  const started = Date.now();
  if (!settings.endpoint) {
    return { status: "skipped", text: "", ms: Date.now() - started, error: null };
  }
  const timeout = timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    const fetcher = /** @type {import("../types.js").FetchImpl} */ (fetchImpl ?? globalThis.fetch);
    const response = await fetcher(`${settings.endpoint.replace(/\/$/, "")}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: settings.model, prompt, stream: false }),
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) {
      return { status: "error", text: "", ms: Date.now() - started, error: `HTTP ${response.status}` };
    }
    const data = /** @type {any} */ (await response.json());
    const text = typeof data?.response === "string" ? data.response.trim() : "";
    if (!text) {
      return { status: "error", text: "", ms: Date.now() - started, error: "resposta vazia" };
    }
    return { status: "ok", text, ms: Date.now() - started, error: null };
  } catch (error) {
    return {
      status: "error", text: "", ms: Date.now() - started,
      error: error instanceof Error ? error.message.split("\n")[0] : String(error),
    };
  }
}
