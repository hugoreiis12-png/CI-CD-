/** @typedef {import("./tool-kit.mjs").AgentTool} AgentTool */
import path from "node:path";
import { buildProfile } from "../lib/profile.mjs";
import { readJson } from "../lib/fs-tools.mjs";
import { gitOrError } from "./tool-kit.mjs";
import { gateReport, auditReport } from "./tools.mjs";
import { repoSlug } from "./tools-remote.mjs";

const RECENT_COMMITS = 5;

/** Local facts: stack, commands, branch, sync with upstream and recent commits. @param {string} root */
function localLines(root) {
  const profile = buildProfile(root);
  const stacks = [...profile.languages, ...profile.subprojects.flatMap((p) => p.languages.map((l) => ({ ...l, id: `${l.id} (${p.path}/)` })))]
    .map((l) => l.id);
  const commands = Object.entries(profile.commands).filter(([, cmd]) => cmd).map(([k, cmd]) => `${k}=${cmd}`);
  const status = gitOrError(root, ["status", "--short", "--branch"]).split("\n");
  return [
    `Projeto local: ${path.basename(root)}`,
    `Branch e sincronização: ${status[0] || "(sem branch)"}`,
    `Mudanças não commitadas: ${status.length - 1} arquivo(s)`,
    `Stack: ${stacks.join(", ") || "não detectada"}`,
    `Comandos: ${commands.join("; ") || "nenhum configurado"}`,
    `Últimos commits:\n${gitOrError(root, ["log", "--oneline", "-n", String(RECENT_COMMITS)])}`,
  ];
}

/** Remote facts: GitHub repository and the esteira verdicts already on disk. @param {string} root */
function remoteLines(root) {
  const origin = gitOrError(root, ["remote", "get-url", "origin"]);
  return [
    `Repositório remoto: ${repoSlug(root) ?? "não identificado (sem remote do GitHub ou gh sem acesso)"}`,
    `Origin: ${origin}`,
  ];
}

/** Esteira state: policy and the last gate and audit verdicts. @param {string} root */
function esteiraLines(root) {
  const manifest = readJson(root, ".esteira/project.json");
  return [
    `Política: modo=${manifest?.gate?.mode ?? "block"}, bloqueia a partir de ${manifest?.gate?.blockAt ?? "medium"}, auditoria failOn=${manifest?.audit?.failOn ?? "high"}`,
    `Último gate:\n${gateReport(root)}`,
    `Última auditoria:\n${auditReport(root)}`,
  ];
}

/** What the agent knows before the first question. @param {string} root */
export function projectSnapshot(root) {
  return [...localLines(root), ...remoteLines(root), ...esteiraLines(root)].join("\n");
}

/**
 * @param {{ snapshot: string, tools: Record<string, AgentTool> }} input
 * @returns {string} system prompt (pt-BR; the agent answers in pt-BR)
 */
export function buildSystemPrompt({ snapshot, tools }) {
  const toolLines = Object.entries(tools).map(([name, t]) => `- ${name} ${t.args}: ${t.description}`);
  return [
    "Você é o Hermes, o assistente da Esteira (gh esteira) para este projeto. Converse em português, em linguagem natural, como um colega sênior.",
    "Você conhece o repositório LOCAL e o REMOTO (GitHub). Responda sempre a partir do contexto do projeto abaixo e use ferramentas quando a resposta depender do estado atual: código, commits, branches, PRs, issues, checks de CI, revisões ou o que está no remoto.",
    "Você é somente leitura. Nunca escreve: não altera arquivos, não faz commit, push, merge, rebase, checkout ou reset, não cria nem edita PR ou issue, não comenta e não reconfigura a esteira. Se o usuário pedir uma escrita, explique o que ele deve fazer e mostre o comando (git ou gh) para ele rodar por conta própria.",
    "Para perguntas sobre o estado atual (branch, PR, issue, CI, remoto, arquivo), consulte a ferramenta antes de responder; não responda de memória.",
    "Não invente dados. Um SHA, número de PR ou issue, nome de branch ou status só pode aparecer se estiver literalmente num RESULTADO de ferramenta ou no contexto. Se não estiver, diga que não consegue confirmar e diga o que o usuário pode checar.",
    "Não invente comandos: só sugira comandos git ou gh que você tem certeza de que existem. Se algo não puder ser respondido com as ferramentas, diga isso em vez de supor.",
    "",
    "=== CONTEXTO DO PROJETO ===",
    snapshot,
    "",
    "=== FERRAMENTAS (somente leitura) ===",
    ...toolLines,
    "",
    "Para usar uma ferramenta, responda com UMA linha que começa por TOOL: seguida de JSON, e nada mais, por exemplo:",
    'TOOL: {"name":"remote_prs","args":{"state":"open"}}',
    "Sem linha TOOL, sua resposta vai direto ao usuário: objetiva, em português, citando arquivo, linha, PR ou issue quando ajudar.",
  ].join("\n");
}
