/** @typedef {import("../types.js").Profile} Profile */
import fs from "node:fs";
import path from "node:path";
import { buildProfile } from "../lib/profile.mjs";
import { errorLine, readJson } from "../lib/fs-tools.mjs";
import { gitText, extractCommit, linkDependencies, makeTempPlayground, headCommit } from "../playground/workspace.mjs";
import { runCommand } from "../playground/runner.mjs";
import { verifyAttestation } from "../gate/attest.mjs";
import { clip, gitOrError, text, MAX_READ_CHARS, MAX_LIST, MAX_LOG_CHARS } from "./tool-kit.mjs";
import { ghText, REMOTE_TOOLS } from "./tools-remote.mjs";

/**
 * Read-only tools of the Hermes agent (`gh esteira agent`). The registry at the
 * bottom is the ONLY dispatch table the model can reach. No tool writes: git
 * is only read, GitHub only through GET/list/view, and tests run on a snapshot
 * of HEAD in a temp folder that is deleted afterwards.
 *
 * @typedef {import("./tool-kit.mjs").AgentTool} AgentTool
 * @typedef {import("./tool-kit.mjs").ToolContext} ToolContext
 */

const TEST_TIMEOUT_MS = 120_000;
const MAX_PATTERN_CHARS = 200;
const MAX_REF_CHARS = 100;

// Credentials never reach the model, even when the user asks to read them.
const SECRET_FILE = /(?:^|\/)(?:\.env(?:\.(?!example$)[^/]*)?|\.npmrc|\.netrc|\.pypirc|\.git-credentials|[^/]*\.(?:pem|key|p12|pfx|jks|keystore)|id_rsa[^/]*|config\.env)$/;

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

/**
 * Where a project path really lives, with symlinks followed. Throws when that
 * place is outside the project or is a credential or .git path. For a file that
 * does not exist yet, its nearest existing folder is the one that is resolved.
 * @param {string} root @param {unknown} rel
 * @returns {string} absolute real path
 */
export function realProjectPath(root, rel) {
  const target = path.join(root, safeRelPath(root, rel));
  let existing = target;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const real = path.join(fs.realpathSync(existing), path.relative(existing, target));
  const back = path.relative(fs.realpathSync(root), real);
  if (back === ".." || back.startsWith(`..${path.sep}`) || path.isAbsolute(back)) {
    throw new Error("caminho fora do projeto (um link simbólico aponta para fora)");
  }
  safeRelPath(root, back); // the real target must pass the same rules as the link
  return real;
}

/** A commit-ish given by the model: never an option, never a range or a path. @param {unknown} value */
function safeRef(value) {
  const ref = text(value).trim() || "HEAD";
  if (ref.length > MAX_REF_CHARS || ref.startsWith("-") || ref.includes("..") || !/^[\w./~^{}@-]+$/.test(ref)) {
    throw new Error("ref inválida (use um nome de branch, tag ou commit)");
  }
  return ref;
}

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
  const id = runId || ghText(root, ["run", "list", "--status", "failure", "--limit", "1", "--json", "databaseId", "--jq", ".[0].databaseId"]).trim();
  if (!/^\d+$/.test(id)) return `sem run com falha (${id})`;
  return clip(ghText(root, ["run", "view", id, "--log-failed"]), MAX_LOG_CHARS);
}

/** Latest JSON record in a `.esteira/<dir>` folder, or null. @param {string} root @param {string} dir */
function latestRecord(root, dir) {
  const folder = path.join(root, ".esteira", dir);
  if (!fs.existsSync(folder)) return null;
  const files = fs.readdirSync(folder).filter((f) => f.endsWith(".json")).sort();
  return files.length ? readJson(folder, files[files.length - 1]) : null;
}

/** Verdict and findings of the last gate run. @param {string} root */
export function gateReport(root) {
  const run = latestRecord(root, "runs");
  if (!run) return "nenhum registro do gate ainda";
  const findings = (run.findings ?? []).slice(0, 20)
    .map((/** @type {any} */ f) => `- [${f.severity}] ${f.rule} ${f.file}${f.line ? `:${f.line}` : ""} — ${f.message}`);
  return [`veredito: ${run.verdict}`, ...findings].join("\n");
}

/** Verdict and advisories of the last CVE audit. @param {string} root */
export function auditReport(root) {
  const audit = latestRecord(root, "audits");
  if (!audit) return "nenhuma auditoria ainda";
  const lines = (audit.findings ?? []).slice(0, 15)
    .map((/** @type {any} */ f) => `- [${f.severity}] ${f.id} ${f.package}@${f.version}${f.fixed?.length ? ` (corrigido em ${f.fixed[f.fixed.length - 1]})` : ""}`);
  return [`veredito: ${audit.verdict} (failOn=${audit.failOn})`, ...lines].join("\n");
}

/**
 * Tracked files whose text contains `pattern` (fixed string). Lines that come
 * from credential files are dropped, so a secret never reaches the model.
 * @param {string} root @param {string} pattern
 */
function searchCode(root, pattern) {
  try {
    const hits = gitText(root, ["grep", "-n", "-I", "-F", "--no-color", "-e", pattern.slice(0, MAX_PATTERN_CHARS)])
      .split("\n")
      .filter((line) => line && !SECRET_FILE.test(line.split(":")[0]));
    return hits.length ? clip(hits.slice(0, MAX_LIST).join("\n"), MAX_READ_CHARS) : "nenhuma ocorrência";
  } catch (error) {
    // git grep exits 1 when nothing matches.
    return /** @type {{ status?: number }} */ (error).status === 1 ? "nenhuma ocorrência" : `git grep falhou: ${errorLine(error)}`;
  }
}

/** @type {Record<string, AgentTool>} */
const LOCAL_TOOLS = {
  read_file: {
    description: "Lê um arquivo do projeto (texto, cortado se grande).",
    args: '{"path": "caminho relativo"}',
    run: (ctx, args) => {
      const rel = safeRelPath(ctx.root, args.path);
      const body = fs.readFileSync(realProjectPath(ctx.root, rel));
      if (body.includes(0)) return `${rel}: arquivo binário (${body.length} bytes), não exibido`;
      return clip(body.toString("utf8"), MAX_READ_CHARS);
    },
  },
  list_files: {
    description: "Lista arquivos versionados ou novos (não ignorados), opcionalmente por prefixo.",
    args: '{"prefix": "pasta/opcional"}',
    run: (ctx, args) => {
      const prefix = text(args.prefix).replace(/^\.\//, "");
      const files = gitOrError(ctx.root, ["ls-files", "--cached", "--others", "--exclude-standard"]).split("\n")
        .filter((f) => f && f.startsWith(prefix) && !SECRET_FILE.test(f));
      return files.slice(0, MAX_LIST).join("\n") + (files.length > MAX_LIST ? `\n…(${files.length - MAX_LIST} a mais)` : "");
    },
  },
  search_code: {
    description: "Procura um texto literal nos arquivos versionados (mostra arquivo:linha).",
    args: '{"pattern": "texto a procurar"}',
    run: (ctx, args) => {
      const pattern = text(args.pattern).trim();
      if (!pattern) throw new Error("informe o texto a procurar");
      return searchCode(ctx.root, pattern);
    },
  },
  git_status: {
    description: "Estado do git: branch, sincronização com o upstream e arquivos modificados.",
    args: "{}",
    run: (ctx) => gitOrError(ctx.root, ["status", "--short", "--branch"]) || "árvore limpa",
  },
  git_log: {
    description: "Últimos commits (uma linha cada).",
    args: '{"limit": 10}',
    run: (ctx, args) => gitOrError(ctx.root, ["log", "--oneline", "-n", String(Math.min(Number(args.limit) || 10, 30))]),
  },
  git_show: {
    description: "Um commit ou ref: autor, mensagem e arquivos alterados (sem o patch).",
    args: '{"ref": "HEAD"}',
    run: (ctx, args) => clip(gitOrError(ctx.root, ["show", "--stat", "--no-color", "--format=fuller", safeRef(args.ref)]), MAX_READ_CHARS),
  },
  git_branches: {
    description: "Branches locais com o commit de cada uma e o upstream (ahead/behind).",
    args: "{}",
    run: (ctx) => gitOrError(ctx.root, ["branch", "-vv", "--no-color"]),
  },
  git_diff: {
    description: "Diff do working tree contra HEAD (opcionalmente de um caminho).",
    args: '{"path": "opcional"}',
    run: (ctx, args) => {
      const spec = args.path ? [":(literal)" + safeRelPath(ctx.root, args.path)] : [];
      return clip(gitOrError(ctx.root, ["diff", "HEAD", "--no-color", "--stat", "--", ...spec]) + "\n" + gitOrError(ctx.root, ["diff", "HEAD", "--no-color", "--", ...spec]), MAX_READ_CHARS);
    },
  },
  gate_latest: {
    description: "Último registro do gate (veredito e findings).",
    args: "{}",
    run: (ctx) => gateReport(ctx.root),
  },
  audit_latest: {
    description: "Último registro da auditoria de CVEs (veredito e advisories).",
    args: "{}",
    run: (ctx) => auditReport(ctx.root),
  },
  attest_check: {
    description: "Diz se o HEAD está atestado pelo gate, isto é, se um push dele passaria no pre-push.",
    args: "{}",
    run: (ctx) => verifyAttestation({ root: ctx.root, json: true }).message,
  },
  ci_status: {
    description: "Últimos runs do GitHub Actions deste repositório (via gh).",
    args: "{}",
    run: (ctx) => ghText(ctx.root, ["run", "list", "--limit", "5", "--json", "databaseId,displayTitle,headBranch,conclusion,status"]),
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

/** Every tool the agent may call: local project and GitHub, all read-only. @type {Record<string, AgentTool>} */
export const READ_ONLY_TOOLS = { ...LOCAL_TOOLS, ...REMOTE_TOOLS };
