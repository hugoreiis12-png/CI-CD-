/** @typedef {import("./tools.mjs").AgentTool} AgentTool */
import path from "node:path";
import { buildProfile } from "../lib/profile.mjs";
import { readJson, errorLine } from "../lib/fs-tools.mjs";
import { gitText } from "../playground/workspace.mjs";

/** @param {string} root @param {string[]} args */
const safeGit = (root, args) => {
  try {
    return gitText(root, args);
  } catch (error) {
    return `(git indisponível: ${errorLine(error)})`;
  }
};

/** Stack, commands, branch and esteira policy: what the agent knows before the first question. @param {string} root */
export function projectSnapshot(root) {
  const profile = buildProfile(root);
  const manifest = readJson(root, ".esteira/project.json");
  const stacks = [...profile.languages, ...profile.subprojects.flatMap((p) => p.languages.map((l) => ({ ...l, id: `${l.id} (${p.path}/)` })))]
    .map((l) => l.id);
  const commands = Object.entries(profile.commands).filter(([, cmd]) => cmd).map(([k, cmd]) => `${k}=${cmd}`);
  return [
    `Projeto: ${path.basename(root)}`,
    `Branch: ${safeGit(root, ["branch", "--show-current"]) || "(sem branch)"}`,
    `Stack: ${stacks.join(", ") || "não detectada"}`,
    `Comandos: ${commands.join("; ") || "nenhum configurado"}`,
    `Política: modo=${manifest?.gate?.mode ?? "block"}, bloqueia a partir de ${manifest?.gate?.blockAt ?? "medium"}, auditoria failOn=${manifest?.audit?.failOn ?? "high"}`,
  ].join("\n");
}

/**
 * @param {{ snapshot: string, tools: Record<string, AgentTool> }} input
 * @returns {string} system prompt (pt-BR; the agent answers in pt-BR)
 */
export function buildSystemPrompt({ snapshot, tools }) {
  const toolLines = Object.entries(tools).map(([name, t]) => `- ${name} ${t.args}: ${t.description}`);
  return [
    "Você é o Hermes, o agente da Esteira (gh esteira), no modo CONSULTA.",
    "Você lê, depura, consulta e roda testes. Você NÃO altera arquivos, NÃO faz commit, push, merge ou rebase e NÃO reconfigura a esteira: se o usuário pedir uma mudança, explique o que fazer e o comando que ele deve rodar.",
    "",
    "=== CONTEXTO DO PROJETO ===",
    snapshot,
    "",
    "=== FERRAMENTAS (somente leitura) ===",
    ...toolLines,
    "",
    "Para usar uma ferramenta, responda com UMA linha que começa por TOOL: seguida de JSON, e nada mais, por exemplo:",
    'TOOL: {"name":"git_status","args":{}}',
    "Sem linha TOOL, sua resposta vai direto ao usuário: objetiva, em português, citando arquivo e linha quando ajudar.",
  ].join("\n");
}
