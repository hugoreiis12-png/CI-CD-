/** @typedef {import("./tools.mjs").AgentTool} AgentTool */
/** @typedef {import("./tools.mjs").ToolContext} ToolContext */
/** @typedef {{ role: "system" | "user" | "assistant", content: string }} Message */
/** @typedef {{ name: string, args: Record<string, unknown> }} ToolCall */
import { errorLine } from "../lib/fs-tools.mjs";

export const MAX_STEPS = 8;
const TOOL_PREFIX = "TOOL:";

// Small models often drop the prefix and write `nome_da_ferramenta {"arg": 1}`.
const BARE_CALL = /^([a-z_]+)\s+(\{.*\})$/;

/** @param {unknown} value */
const argsOf = (value) => (value && typeof value === "object" && !Array.isArray(value) ? /** @type {Record<string, unknown>} */ (value) : {});

/** @param {string} json @returns {ToolCall} */
function readTagged(json) {
  try {
    const value = JSON.parse(json);
    return { name: typeof value?.name === "string" ? value.name : "", args: argsOf(value?.args) };
  } catch {
    return { name: "", args: {} };
  }
}

/** @param {string} name @param {string} json @returns {ToolCall} */
function readBare(name, json) {
  try {
    return { name, args: argsOf(JSON.parse(json)) };
  } catch {
    return { name, args: {} };
  }
}

/**
 * The model asks for a tool with one line: `TOOL: {"name": "...", "args": {...}}`
 * (or the bare `name {args}`). Only the first such line counts; anything else is
 * the final answer. An unreadable call comes back with an empty name, so it is
 * refused like any unknown tool.
 * @param {string} reply @returns {ToolCall | null}
 */
export function parseToolCall(reply) {
  for (const raw of reply.split("\n")) {
    const line = raw.trim();
    if (line.startsWith(TOOL_PREFIX)) return readTagged(line.slice(TOOL_PREFIX.length).trim());
    const bare = BARE_CALL.exec(line);
    if (bare) return readBare(bare[1], bare[2]);
  }
  return null;
}

/**
 * Dispatches only through the registry: unknown or write-like names are refused.
 * @param {Record<string, AgentTool>} tools @param {ToolContext} ctx @param {ToolCall} call
 * @returns {Promise<string>}
 */
export async function invokeTool(tools, ctx, call) {
  const tool = Object.hasOwn(tools, call.name) ? tools[call.name] : undefined;
  if (!tool) {
    return `ferramenta não permitida: "${call.name}". Disponíveis: ${Object.keys(tools).join(", ")}`;
  }
  try {
    return await tool.run(ctx, call.args);
  } catch (error) {
    return `erro: ${errorLine(error)}`;
  }
}

/**
 * One question of the user: the model may call read-only tools up to MAX_STEPS
 * times, each result fed back, until it answers in plain text.
 * @param {{
 *   system: string,
 *   history: Message[],
 *   question: string,
 *   tools: Record<string, AgentTool>,
 *   ctx: ToolContext,
 *   chatFn: (messages: Message[], timeoutMs: number) => Promise<{ status: string, text: string, error: string | null }>,
 *   timeoutMs?: number,
 *   maxSteps?: number,
 * }} input
 * @returns {Promise<{ reply: string, steps: ToolCall[], failed: boolean }>}
 */
export async function runTurn({ system, history, question, tools, ctx, chatFn, timeoutMs = 60_000, maxSteps = MAX_STEPS }) {
  /** @type {Message[]} */
  const messages = [{ role: "system", content: system }, ...history, { role: "user", content: question }];
  /** @type {ToolCall[]} */
  const steps = [];
  for (let i = 0; i < maxSteps; i++) {
    const llm = await chatFn(messages, timeoutMs);
    if (llm.status !== "ok") {
      return { reply: `[hermes] indisponível: ${llm.error ?? "sem resposta"}`, steps, failed: true };
    }
    const call = parseToolCall(llm.text);
    if (!call) return { reply: llm.text, steps, failed: false };
    steps.push(call);
    const result = await invokeTool(tools, ctx, call);
    messages.push({ role: "assistant", content: llm.text }, { role: "user", content: `RESULTADO ${call.name || "(inválido)"}:\n${result}` });
  }
  return { reply: "Limite de consultas a ferramentas atingido nesta pergunta; seja mais específico.", steps, failed: false };
}
