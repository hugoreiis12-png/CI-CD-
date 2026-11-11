import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Ajuda em PT-BR. O manual completo é o docs/MANUAL.md que vem junto com a
// extensão (o `gh extension install` clona o repositório inteiro), então a
// versão do manual é sempre a mesma da CLI instalada.
const MANUAL = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "docs", "MANUAL.md");
const MANUAL_URL = "https://github.com/hugoreiis12-png/gh-esteira/blob/main/docs/MANUAL.md";

/**
 * @typedef {object} CommandHelp
 * @property {string} summary
 * @property {string} usage
 * @property {[string, string][]} flags
 * @property {string[]} examples
 * @property {string} [notes]
 */

/** @type {Record<string, CommandHelp>} */
export const COMMANDS = {
  init: {
    summary: "Liga a esteira no projeto: manifesto, workflow de CI e hooks de git.",
    usage: "gh esteira init [--dry-run] [--force] [--dir <pasta>]  |  gh esteira init --global [--uninstall]",
    flags: [
      ["--global", "liga a esteira em TODO repositório desta máquina (git config --global core.hooksPath)"],
      ["--uninstall", "com --global: remove os hooks globais e restaura o hooksPath anterior"],
      ["--dry-run", "mostra o que seria criado, sem gravar nada"],
      ["--force", "regenera o .github/workflows/esteira-ci.yml mesmo que ele já exista"],
      ["--dir <pasta>", "projeto alvo (padrão: pasta atual)"],
    ],
    examples: ["gh esteira init --dry-run", "gh esteira init", "gh esteira init --global"],
    notes: "Os hooks rodam a esteira no commit, merge e push (bloqueiam) e no pull/rebase (avisam). No projeto, cria .esteira/project.json e esteira-ci.yml (commite os dois) e os hooks em .esteira/hooks. Rodar de novo regera o profile e preserva a política. Desligar num repositório: git config esteira.enabled false.",
  },
  update: {
    summary: "Atualiza a extensão para a versão mais nova e reajusta o projeto (hooks, workflow, .gitignore e actions por SHA). Idempotente.",
    usage: "gh esteira update [--dry-run] [--force] [--no-extension] [--json] [--dir <pasta>]",
    flags: [
      ["--dry-run", "mostra o que seria feito, sem gravar nada e sem atualizar a extensão"],
      ["--force", "regenera o .github/workflows/esteira-ci.yml mesmo que ele tenha sido editado"],
      ["--no-extension", "não consulta nem atualiza a extensão (usado internamente após a atualização)"],
      ["--json", "saída em JSON"],
      ["--dir <pasta>", "projeto alvo (padrão: pasta atual)"],
    ],
    examples: ["gh esteira update --dry-run", "gh esteira update"],
    notes:
      "Rode sempre que a stack mudar (nova linguagem, novo package manager, novo comando de teste) ou após atualizar a extensão. " +
      "Preserva a política que você editou em .esteira/project.json (gate/audit/llm). O pin refixa as actions por SHA.",
  },
  agent: {
    summary: "Chat interativo com o Hermes sobre o projeto (stack, gate, CI, testes). Somente leitura.",
    usage: "gh esteira agent [--dir <pasta>]",
    flags: [["--dir <pasta>", "projeto alvo (padrão: pasta atual)"]],
    examples: ["gh esteira agent", "gh esteira agent --dir ../outro-projeto"],
    notes: "O Hermes lê arquivos, git, gate, auditoria e logs do CI, e roda os testes num snapshot do HEAD. Nunca escreve: não edita, não commita, não reconfigura. Comandos dentro do chat: /limpar, /ajuda, /sair.",
  },
  heal: {
    summary: "Diagnostica o problema (gate, conflito de merge ou CI), pede a correção ao Hermes e aplica só se o typecheck e os testes passarem.",
    usage: "gh esteira heal [--ci] [--dry-run] [--dir <pasta>]",
    flags: [
      ["--ci", "também analisa o último run com falha do GitHub Actions (via gh)"],
      ["--dry-run", "verifica a correção sem gravar nada"],
      ["--dir <pasta>", "projeto alvo (padrão: pasta atual)"],
    ],
    examples: ["gh esteira heal", "gh esteira heal --ci", "gh esteira heal --dry-run"],
    notes: "Quando o commit é bloqueado, o pre-commit já roda o heal. A correção fica no working tree, sem stage nem commit: revise com git diff e commite de novo. Não aplica nada sem verificação e não grava se a verificação falhar. Desligar no commit: ESTEIRA_HEAL=0.",
  },
  analyze: {
    summary: "Detecta linguagens, gerenciador de pacotes, frameworks, infraestrutura e comandos. Só lê.",
    usage: "gh esteira analyze [--json] [--dir <pasta>]",
    flags: [["--json", "saída em JSON"], ["--dir <pasta>", "projeto alvo"]],
    examples: ["gh esteira analyze"],
    notes: "Se a raiz não tem manifesto, lista os projetos encontrados nas subpastas e diz onde rodar a esteira.",
  },
  gate: {
    summary: "Gate de segurança sobre o que está staged: segredos, padrões perigosos, workflows de CI, arquivos grandes e seus testes num playground isolado.",
    usage: "gh esteira gate [--head] [--json] [--policy-ref <commit>] [--dir <pasta>]",
    flags: [
      ["--head", "valida e atesta o último commit (para commits feitos sem o pre-commit)"],
      ["--json", "saída em JSON"],
      ["--policy-ref <commit>", "lê a política do .esteira/project.json desse commit (usado no CI)"],
    ],
    examples: ["gh esteira gate", "gh esteira gate --head"],
    notes: "O hook pre-commit roda este comando sozinho. Sai com 1 quando bloqueia.",
  },
  attest: {
    summary: "Confere se o HEAD é idêntico a um snapshot aprovado pelo gate (usado pelo hook pre-push).",
    usage: "gh esteira attest --verify [--json] [--dir <pasta>]",
    flags: [["--verify", "faz a verificação (obrigatório)"], ["--json", "saída em JSON"]],
    examples: ["gh esteira attest --verify"],
    notes: "Bloqueado? Rode `gh esteira gate --head` e faça o push de novo.",
  },
  audit: {
    summary: "Auditoria de CVEs das dependências (npm, Python, Go, Rust) via OSV.dev.",
    usage: "gh esteira audit [--json] [--dir <pasta>]",
    flags: [["--json", "saída em JSON"]],
    examples: ["gh esteira audit"],
    notes: "Grava .esteira/audits/latest.json. Sai com 1 quando há advisory com severidade ≥ audit.failOn (padrão: high).",
  },
  report: {
    summary: "Exporta o último gate e o último audit no findings.json da skill de security-audit da Cloudflare, validado antes de gravar.",
    usage: "gh esteira report [--out <caminho>] [--json]",
    flags: [["--out <caminho>", "arquivo de saída (padrão: .esteira/reports/findings.json)"], ["--json", "imprime os registros"]],
    examples: ["gh esteira report"],
  },
  pin: {
    summary: "Fixa por SHA de commit toda action (uses:) e o ESTEIRA_REF dos workflows da esteira.",
    usage: "gh esteira pin [--dry-run] [--json] [--dir <pasta>]",
    flags: [["--dry-run", "mostra o que seria fixado, sem gravar"], ["--json", "relatório em JSON"]],
    examples: ["gh esteira pin --dry-run", "gh esteira pin"],
    notes: "Usa a sua sessão do gh. Rode sempre depois de init/gitops e antes de commitar os workflows.",
  },
  gitops: {
    summary: "Gera o deploy GitOps: deploy/k8s (base + staging/production), Argo CD e o workflow de release.",
    usage: "gh esteira gitops [--gitops-repo <dono/repo>] [--image <ref>] [--force] [--dir <pasta>]",
    flags: [
      ["--gitops-repo <dono/repo>", "repositório GitOps que o Argo CD observa"],
      ["--image <ref>", "imagem (padrão: ghcr.io/<app>)"],
      ["--force", "regenera os arquivos existentes"],
    ],
    examples: ["gh esteira gitops --gitops-repo minha-org/gitops", "gh esteira pin"],
    notes: "O pin é obrigatório antes de commitar o esteira-release.yml (o gate bloqueia actions sem SHA em workflows privilegiados).",
  },
  promote: {
    summary: "Abre um PR no repositório GitOps trocando a tag da imagem do ambiente.",
    usage: "gh esteira promote --tag <sha> --repo <dono/repo> [--env staging|production] [--app <nome>] [--dry-run]",
    flags: [
      ["--tag <sha>", "tag da imagem (SHA do commit) — obrigatório"],
      ["--repo <dono/repo>", "repositório GitOps — obrigatório"],
      ["--env <ambiente>", "staging (padrão) ou production"],
      ["--app <nome>", "nome da aplicação (padrão: name do package.json)"],
      ["--dry-run", "mostra o plano sem clonar nem abrir PR"],
    ],
    examples: ["gh esteira promote --tag 1a2b3c4 --repo minha-org/gitops --dry-run"],
  },
  hook: {
    summary: "Uso interno: é o que os hooks de git chamam (pre-commit, pre-merge-commit, pre-push, post-merge, post-rewrite).",
    usage: "gh esteira hook <nome> [argumentos do git]",
    flags: [],
    examples: ["gh esteira hook pre-commit"],
    notes: "Você não precisa rodar isto: o git chama sozinho. pre-commit/pre-merge-commit rodam o gate; pre-push valida cada commit novo e roda os testes; post-merge/post-rewrite analisam o que chegou no pull/rebase e rodam o audit se as dependências mudaram.",
  },
  help: {
    summary: "Mostra esta ajuda, o detalhe de um comando ou o manual completo.",
    usage: "gh esteira help [<comando> | manual]",
    flags: [],
    examples: ["gh esteira help", "gh esteira help gate", "gh esteira help manual"],
  },
  orchestrate: {
    summary: "Orquestrador Hermes: lê o estado do pipeline (gate + audit) e gera um plano de ações executável.",
    usage: "gh esteira orchestrate [--dir <pasta>] [--json] [--no-llm] [--quiet]",
    flags: [
      ["--dir <pasta>", "raiz do projeto"],
      ["--json", "saída em JSON (para consumo por automação)"],
      ["--no-llm", "usa apenas o plano determinístico (sem LLM)"],
      ["--quiet", "suprime mensagens informativas"],
    ],
    examples: ["gh esteira orchestrate", "gh esteira orchestrate --json", "gh esteira orchestrate --no-llm"],
    notes:
      "O orquestrador não reverte bloqueios determinísticos (severidade >= blockAt ou CVE >= failOn). " +
      "Se o LLM estiver indisponível, retorna o plano determinístico de fallback. " +
      "Exit code: 0 para approve/hold, 1 para block.",
  },
};

/** Visão geral: todos os comandos em uma tela. */
export function overview() {
  const width = Math.max(...Object.keys(COMMANDS).map((c) => c.length));
  return [
    "Esteira — CI/CD adaptativo com foco em segurança e auditoria de vulnerabilidades",
    "",
    "Uso: gh esteira <comando> [flags]",
    "",
    "Comandos:",
    ...Object.entries(COMMANDS).map(([name, c]) => `  ${name.padEnd(width)}  ${c.summary}`),
    "",
    "Mais ajuda:",
    "  gh esteira help <comando>   flags e exemplos de um comando (ou: gh esteira <comando> --help)",
    "  gh esteira help manual      manual completo em PT-BR no terminal",
    `  ${MANUAL_URL}`,
    "",
    "Fluxo típico: gh esteira init (configura e fixa as actions) → git commit (gate; se bloquear, heal) → git push → PR (security-gate no CI)",
    "",
  ].join("\n");
}

/** @param {string} name */
export function commandHelp(name) {
  const c = COMMANDS[name];
  if (!c) return null;
  const width = Math.max(0, ...c.flags.map(([f]) => f.length));
  return [
    `gh esteira ${name} — ${c.summary}`,
    "",
    `Uso: ${c.usage}`,
    ...(c.flags.length ? ["", "Flags:", ...c.flags.map(([f, d]) => `  ${f.padEnd(width)}  ${d}`)] : []),
    "",
    "Exemplos:",
    ...c.examples.map((e) => `  ${e}`),
    ...(c.notes ? ["", c.notes] : []),
    "",
  ].join("\n");
}

/**
 * Manual completo: abre no pager ($PAGER, ou less) quando a saída é um
 * terminal; senão imprime (para redirecionar ou usar com grep).
 */
function showManual() {
  if (!fs.existsSync(MANUAL)) {
    process.stdout.write(`Manual não encontrado nesta instalação. Leia online: ${MANUAL_URL}\n`);
    return 0;
  }
  const text = fs.readFileSync(MANUAL, "utf8");
  if (process.stdout.isTTY) {
    const [pager, ...args] = (process.env.PAGER || "less -R").split(/\s+/);
    const shown = spawnSync(pager, args, { input: text, stdio: ["pipe", "inherit", "inherit"] });
    if (!shown.error) return 0;
  }
  process.stdout.write(text);
  return 0;
}

/** `gh esteira help [<comando> | manual]` @param {string | undefined} topic */
export function runHelp(topic) {
  if (!topic) {
    process.stdout.write(overview());
    return 0;
  }
  if (topic === "manual") return showManual();
  const text = commandHelp(topic);
  if (!text) {
    process.stderr.write(`[esteira] comando desconhecido: ${topic}\n\n${overview()}`);
    return 1;
  }
  process.stdout.write(text);
  return 0;
}
