/** @typedef {import("../types.js").LlmSettings} LlmSettings */
/** @typedef {import("../types.js").LlmResult} LlmResult */

/**
 * Ollama transport for the Hermes LLM — the advisory and agent layer of the
 * Esteira CLI.
 *
 * Design rules:
 *  - Advisory only. Hermes never sets, overrides or softens a verdict:
 *    deterministic checks (gate checks, CVE severity >= failOn) are the
 *    enforcement point; Hermes explains and prioritizes.
 *  - Never a failure source. Any transport/parse error degrades to
 *    `{ status: "error", error }` and the caller continues without the LLM.
 *  - Bounded: the deadline is enforced by racing (withDeadline), so a
 *    transport that ignores AbortSignal cannot hang the pipeline.
 *  - Offline-safe: `endpoint: null` short-circuits to `skipped` with zero traffic.
 *
 * `fetchImpl` is injectable so tests run fully offline.
 */
import { withDeadline } from "../lib/deadline.mjs";
import { errorLine } from "../lib/fs-tools.mjs";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * One Ollama request under a hard deadline, mapped to the shared result shape.
 * @param {{
 *   settings: LlmSettings,
 *   path: "/api/generate" | "/api/chat",
 *   body: Record<string, unknown>,
 *   read: (data: any) => unknown,
 *   fetchImpl?: unknown,
 *   timeoutMs?: number,
 * }} req
 * @returns {Promise<LlmResult>}
 */
async function ollama({ settings, path, body, read, fetchImpl, timeoutMs }) {
  const started = Date.now();
  const elapsed = () => Date.now() - started;
  if (!settings.endpoint) return { status: "skipped", text: "", ms: 0, error: null };
  const timeout = timeoutMs ?? settings.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = /** @type {Function} */ (fetchImpl ?? globalThis.fetch);
  try {
    const text = await withDeadline(async () => {
      const response = await fetcher(`${settings.endpoint?.replace(/\/$/, "")}${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: settings.model, stream: false, ...body }),
        signal: AbortSignal.timeout(timeout),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const value = read(await response.json());
      return typeof value === "string" ? value.trim() : "";
    }, timeout, "LLM");
    return text
      ? { status: "ok", text, ms: elapsed(), error: null }
      : { status: "error", text: "", ms: elapsed(), error: "resposta vazia" };
  } catch (error) {
    return { status: "error", text: "", ms: elapsed(), error: errorLine(error) };
  }
}

/**
 * One LLM completion via Ollama `/api/generate`.
 * @param {{ settings: LlmSettings, prompt: string, fetchImpl?: unknown, timeoutMs?: number }} input
 * @returns {Promise<LlmResult>}
 */
export function generate({ settings, prompt, fetchImpl, timeoutMs }) {
  return ollama({
    settings, path: "/api/generate", body: { prompt },
    read: (data) => data?.response, fetchImpl, timeoutMs,
  });
}

/**
 * One chat turn via Ollama `/api/chat`: the whole conversation goes each time
 * (the model is stateless here; the caller owns the history).
 * @param {{ settings: LlmSettings, messages: { role: "system" | "user" | "assistant", content: string }[], fetchImpl?: unknown, timeoutMs?: number }} input
 * @returns {Promise<LlmResult>}
 */
export function chat({ settings, messages, fetchImpl, timeoutMs }) {
  return ollama({
    settings, path: "/api/chat", body: { messages },
    read: (data) => data?.message?.content, fetchImpl, timeoutMs,
  });
}
