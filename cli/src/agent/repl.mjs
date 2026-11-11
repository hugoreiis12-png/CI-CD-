import path from "node:path";
import readline from "node:readline";
import { chat } from "../hermes/adapter.mjs";
import { resolveLlmSettings } from "../hermes/config.mjs";
import { readJson } from "../lib/fs-tools.mjs";
import { READ_ONLY_TOOLS } from "./tools.mjs";
import { runTurn } from "./turn.mjs";
import { budgetFor } from "./budget.mjs";
import { buildSystemPrompt, projectSnapshot } from "./context.mjs";

const PROMPT = "hermes> ";
// Question/answer pairs kept for follow-ups; older turns are dropped to bound the prompt.
const KEEP_PAIRS = 6;
const HELP = "Comandos: /limpar (zera a conversa) · /ajuda · /sair. Pergunte em linguagem natural: o Hermes consulta o repositório local e o remoto (GitHub). Somente leitura: não escreve.";

/**
 * `gh esteira agent`: chat interativo com o Hermes, com o contexto do projeto
 * (stack, branch, política, gate e CI). Só ferramentas de leitura.
 *
 * @param {{
 *   root: string,
 *   input?: NodeJS.ReadableStream,
 *   output?: NodeJS.WritableStream,
 *   fetchImpl?: unknown,
 *   chatFn?: (messages: import("./turn.mjs").Message[]) => Promise<import("../types.js").LlmResult>,
 * }} options
 * @returns {Promise<number>} exit code
 */
export async function runAgent({ root, input = process.stdin, output = process.stdout, fetchImpl, chatFn }) {
  const settings = resolveLlmSettings(readJson(root, ".esteira/project.json"));
  if (!chatFn && !settings.endpoint) {
    output.write("Hermes está desligado (llm.enabled=false ou ESTEIRA_LLM_ENABLED=false). Nada a conversar.\n");
    return 1;
  }
  const llm = chatFn ?? ((/** @type {import("./turn.mjs").Message[]} */ messages, /** @type {number} */ timeoutMs) => chat({ settings, messages, fetchImpl, timeoutMs }));
  const system = buildSystemPrompt({ snapshot: projectSnapshot(root), tools: READ_ONLY_TOOLS });
  output.write(`Hermes — modo consulta (somente leitura) · ${path.basename(root)} · /ajuda para comandos\n`);

  const rl = readline.createInterface({ input, output, terminal: Boolean(/** @type {any} */ (input).isTTY) });
  // A piped input can end while its last line is still being answered: the
  // interface then closes first, and no prompt may be written to it.
  let open = true;
  rl.once("close", () => { open = false; });
  let history = /** @type {import("./turn.mjs").Message[]} */ ([]);
  rl.setPrompt(PROMPT);
  if (open) rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (line === "/sair") break;
    if (line === "/limpar") history = [];
    else if (line === "/ajuda") output.write(`${HELP}\n`);
    else if (line) {
      const timeoutMs = budgetFor(line, settings.timeoutMs);
      const turn = await runTurn({ system, history, question: line, tools: READ_ONLY_TOOLS, ctx: { root }, chatFn: llm, timeoutMs });
      // Every consultation is shown, so the user can check where each fact came from.
      for (const step of turn.steps) output.write(`  ↳ consultou ${step.name || "(inválida)"} ${JSON.stringify(step.args)}\n`);
      output.write(`\n${turn.reply}\n\n`);
      history = /** @type {import("./turn.mjs").Message[]} */ ([
        ...history, { role: "user", content: line }, { role: "assistant", content: turn.reply },
      ].slice(-KEEP_PAIRS * 2));
    }
    if (open) rl.prompt();
  }
  // Leaving the loop (/sair, Ctrl+C or end of input) already closes the interface.
  return 0;
}
