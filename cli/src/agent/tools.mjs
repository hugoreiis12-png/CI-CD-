/** @typedef {import("../types.js").Profile} Profile */
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { buildProfile } from "../lib/profile.mjs";
import { errorLine, readJson } from "../lib/fs-tools.mjs";
import { gitText, extractCommit, linkDependencies, makeTempPlayground, headCommit } from "../playground/workspace.mjs";
import { runCommand } from "../playground/runner.mjs";

/**
 * Read-only tools of the Hermes agent (`gh esteira agent`). The registry below
 * is the ONLY dispatch table the agent can reach: there is no write tool, and
 * none of these run anything against the working tree (tests run on a
 * snapshot of HEAD in a temp folder that is deleted afterwards).
 *
 * @typedef {{ root: string }} ToolContext
 * @typedef {{ description: string, args: string, run: (ctx: ToolContext, args: Record<string, unknown>) => string | Promise<string> }} AgentTool
 */

const MAX_READ_CHARS = 12_000;
const MAX_LIST = 300;
const MAX_LOG_CHARS = 4_000;
const TEST_TIMEOUT_MS = 120_000;

// Credentials never reach the model, even when the user asks to read them.
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|[^/]*\.(?:pem|key)|id_rsa[^/]*|config\.env)$/;

/**
 * Resolves a path given by the model inside the project. Rejects escapes, .git and secrets.
 * @param {string} root @param {unknown} rel
 * @returns {string} posix path relative to root
 */
export function safeRelPath(root, rel) {
  if (typeof rel !== "string" || rel.trim() === "") throw new Error("informe o caminho do arquivo");
  const back = path.relative(root, path.resolve(root, rel));
  if (back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) throw new Error("caminho fora do projeto");
  const posix = back.split(path.sep).join("/");
  if (posix === ".git" || posix.startsWith(".git/")) throw new Error(".git não é lido pelo agente");
  if (SECRET_FILE.test(posix)) throw new Error("arquivo de credenciais: não é enviado ao agente");
  return posix;
}

/** @param {string} text @param {number} max */
const clip = (text, max) => (text.length > max ? `${text.slice(0, max)}\n…[cortado em ${max} caracteres]` : text);

/** @param {ToolContext} ctx @param {string[]} args */
const git = (ctx, args) => {
  try {
    return gitText(ctx.root, args);
  } catch (error) {
    return `git falhou: ${errorLine(error)}`;
  }
};

/** @param {string[]} args @param {string} cwd */
function gh(args, cwd) {
  try {
    return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    return `gh indisponível ou sem acesso: ${errorLine(error)}`;
  }
}

/** Latest JSON record in a `.esteira/<dir>` folder, or null. @param {string} root @param {string} dir */
function latestRecord(root, dir) {
  const folder = path.join(root, ".esteira", dir);
  if (!fs.existsSync(folder)) return null;
  const files = fs.readdirSync(folder).filter((f) => f.endsWith(".json")).sort();
  return files.length ? readJson(folder, files[files.length - 1]) : null;
}

/** @param {unknown} value */
const text = (value) => (typeof value === "string" ? value : "");

/** Runs the project's own commands against a snapshot of HEAD (never the working tree). @param {string} root @param {(keyof Profile["commands"])[]} keys */
function runOnSnapshot(root, keys) {
  const profile = buildProfile(root);
  const cmds = keys.map((k) => [k, profile.commands[k]]).filter(([, c]) => c);
  if (cmds.length === 0) return "nenhum comando configurado (profile.commands no .esteira/project.json)";
  const dir = makeTempPlayground("esteira-agent-");
  try {
    extractCommit(root, headCommit(root) ?? "HEAD", dir);
    linkDependencies(root, dir);
    return cmds.map(([key, cmd]) => {
      const result = runCommand(dir, String(cmd), { timeoutMs: TEST_TIMEOUT_MS });
      return `[${key}] ${cmd} → código ${result.code}\n${clip(result.stdout, MAX_LOG_CHARS)}`;
    }).join("\n\n");
  } catch (error) {
    return `não foi possível montar o snapshot: ${errorLine(error)}`;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Failed steps of a GitHub Actions run (the given one, else the latest failure).
 * Returns a readable message when there is nothing to read.
 * @param {string} root @param {string} runId
 */
export function ciFailureLog(root, runId = "") {
  if (runId && !/^\d+$/.test(runId)) throw new Error("runId deve ser numérico");
  const id = runId || gh(["run", "list", "--status", "failure", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"], root).trim();
  if (!/^\d+$/.test(id)) return `sem run com falha (${id})`;
  return clip(gh(["run", "view", id, "--log-failed"], root), MAX_LOG_CHARS);
}

/** @type {Record<string, AgentTool>} */
export const READ_ONLY_TOOLS = {
  read_file: {
    description: "Lê um arquivo do projeto (texto, cortado se grande).",
    args: '{"path": "caminho relativo"}',
    run: (ctx, args) => {
      const rel = safeRelPath(ctx.root, args.path);
      const body = fs.readFileSync(path.join(ctx.root, rel));
      if (body.includes(0)) return `${rel}: arquivo binário (${body.length} bytes), não exibido`;
      return clip(body.toString("utf8"), MAX_READ_CHARS);
    },
  },
  list_files: {
    description: "Lista arquivos versionados ou novos (não ignorados), opcionalmente por prefixo.",
    args: '{"prefix": "pasta/opcional"}',
    run: (ctx, args) => {
      const prefix = text(args.prefix).replace(/^\.\//, "");
      const files = git(ctx, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n")
        .filter((f) => f && f.startsWith(prefix) && !SECRET_FILE.test(f));
      return files.slice(0, MAX_LIST).join("\n") + (files.length > MAX_LIST ? `\n…(${files.length - MAX_LIST} a mais)` : "");
    },
  },
  git_status: {
    description: "Estado do git: branch e arquivos modificados.",
    args: "{}",
    run: (ctx) => git(ctx, ["status", "--short", "--branch"]) || "árvore limpa",
  },
  git_log: {
    description: "Últimos commits (uma linha cada).",
    args: '{"limit": 10}',
    run: (ctx, args) => git(ctx, ["log", "--oneline", "-n", String(Math.min(Number(args.limit) || 10, 30))]),
  },
  git_diff: {
    description: "Diff do working tree contra HEAD (opcionalmente de um caminho).",
    args: '{"path": "opcional"}',
    run: (ctx, args) => {
      const spec = args.path ? [":(literal)" + safeRelPath(ctx.root, args.path)] : [];
      return clip(git(ctx, ["diff", "HEAD", "--no-color", "--stat", "--", ...spec]) + "\n" + git(ctx, ["diff", "HEAD", "--no-color", "--", ...spec]), MAX_READ_CHARS);
    },
  },
  gate_latest: {
    description: "Último registro do gate (veredito e findings).",
    args: "{}",
    run: (ctx) => {
      const run = latestRecord(ctx.root, "runs");
      if (!run) return "nenhum registro do gate ainda";
      const findings = (run.findings ?? []).slice(0, 20)
        .map((/** @type {any} */ f) => `- [${f.severity}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`);
      return [`veredito: ${run.verdict}`, ...findings].join("\n");
    },
  },
  audit_latest: {
    description: "Último registro da auditoria de CVEs (veredito e advisories).",
    args: "{}",
    run: (ctx) => {
      const audit = latestRecord(ctx.root, "audits");
      if (!audit) return "nenhuma auditoria ainda";
      const lines = (audit.findings ?? []).slice(0, 15)
        .map((/** @type {any} */ f) => `- [${f.severity}] ${f.id} ${f.package}@${f.version}${f.fixed?.length ? ` (corrigido em ${f.fixed[f.fixed.length - 1]})` : ""}`);
      return [`veredito: ${audit.verdict} (failOn=${audit.failOn})`, ...lines].join("\n");
    },
  },
  ci_status: {
    description: "Últimos runs do GitHub Actions deste repositório (via gh).",
    args: "{}",
    run: (ctx) => gh(["run", "list", "--limit", "5", "--json", "databaseId,displayTitle,headBranch,conclusion,status"], ctx.root),
  },
  ci_log: {
    description: "Trecho final dos passos que falharam de um run do Actions (via gh).",
    args: '{"runId": "opcional; padrão: o último run com falha"}',
    run: (ctx, args) => ciFailureLog(ctx.root, text(args.runId)),
  },
  run_tests: {
    description: "Roda os testes/typecheck do projeto sobre um snapshot do HEAD (o working tree não é tocado).",
    args: "{}",
    run: (ctx) => runOnSnapshot(ctx.root, ["typecheck", "test"]),
  },
};
