import { execFileSync } from "node:child_process";
import { errorLine } from "../lib/fs-tools.mjs";
import { clip, intArg, text, MAX_READ_CHARS, MAX_REMOTE_ITEMS } from "./tool-kit.mjs";

/**
 * GitHub tools of the agent, read-only. `gh` is only ever called with fixed
 * subcommands (list, view, diff, repo view) or `api --method GET` inside this
 * repository. There is no path to a POST, PATCH, merge, comment or push.
 *
 * @typedef {import("./tool-kit.mjs").AgentTool} AgentTool
 */

const PR_STATES = ["open", "closed", "merged", "all"];
const ISSUE_STATES = ["open", "closed", "all"];
const PR_LIST_FIELDS = "number,title,state,isDraft,author,headRefName,baseRefName,updatedAt,reviewDecision,url";
const PR_VIEW_FIELDS = "number,title,body,state,isDraft,author,headRefName,baseRefName,reviewDecision,mergeable,statusCheckRollup,url";
const ISSUE_LIST_FIELDS = "number,title,state,author,labels,updatedAt,url";
const ISSUE_VIEW_FIELDS = "number,title,body,state,author,labels,url,comments";
const SLUG = /^[\w.-]+\/[\w.-]+$/;
const API_PATH = /^[\w./?=&%,:-]+$/;
const GIT_TIMEOUT_MS = 30_000;

/**
 * Runs `gh` without a shell. A failure becomes a readable line for the model.
 * @param {string} root @param {string[]} args
 */
export function ghText(root, args) {
  try {
    return execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
  } catch (error) {
    return `gh indisponível ou sem acesso: ${errorLine(error)}`;
  }
}

/**
 * "dono/repo" of the repository in `root` as GitHub sees it, or null.
 * @param {string} root
 * @returns {string | null}
 */
export function repoSlug(root) {
  const slug = ghText(root, ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"]).trim();
  return SLUG.test(slug) ? slug : null;
}

/** Branch names on origin, without fetching anything. @param {string} root */
function remoteBranches(root) {
  try {
    const out = execFileSync("git", ["ls-remote", "--heads", "origin"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" }, timeout: GIT_TIMEOUT_MS,
    });
    return out.split("\n").filter(Boolean).map((line) => line.split("\t")[1]?.replace("refs/heads/", "")).join("\n")
      || "nenhuma branch no remoto";
  } catch (error) {
    return `git ls-remote falhou (sem rede ou sem acesso ao origin): ${errorLine(error)}`;
  }
}

/** @param {unknown} value @returns {string} */
function numberOf(value) {
  const n = intArg(value, 0, Number.MAX_SAFE_INTEGER);
  if (!n) throw new Error("informe o número (inteiro positivo)");
  return String(n);
}

/** @param {string} root @param {"pr" | "issue"} kind @param {string[]} states @param {string} fields @param {Record<string, unknown>} args */
function listItems(root, kind, states, fields, args) {
  const requested = text(args.state);
  const state = states.includes(requested) ? requested : "open";
  const limit = String(intArg(args.limit, 20, MAX_REMOTE_ITEMS));
  return clip(ghText(root, [kind, "list", "--state", state, "--limit", limit, "--json", fields]), MAX_READ_CHARS);
}

/** @param {string} root @param {string} fields @param {"pr" | "issue"} kind @param {Record<string, unknown>} args */
const viewItem = (root, kind, fields, args) => clip(ghText(root, [kind, "view", numberOf(args.number), "--json", fields]), MAX_READ_CHARS);

/**
 * GET only, and only inside this repository: the path must start with repos/<dono>/<repo>/.
 * @param {string} root @param {Record<string, unknown>} args
 */
function apiGet(root, args) {
  const slug = repoSlug(root);
  if (!slug) return "não consegui identificar o repositório no GitHub (sem remote ou gh sem acesso)";
  const apiPath = text(args.path).replace(/^\/+/, "");
  if (!apiPath.startsWith(`repos/${slug}/`) || apiPath.includes("..") || !API_PATH.test(apiPath)) {
    return `caminho recusado: use repos/${slug}/... (somente este repositório, somente leitura)`;
  }
  return clip(ghText(root, ["api", "--method", "GET", apiPath]), MAX_READ_CHARS);
}

/** @type {Record<string, AgentTool>} */
export const REMOTE_TOOLS = {
  remote_repo: {
    description: "Repositório no GitHub: nome, URL, visibilidade e branch padrão.",
    args: "{}",
    run: (ctx) => ghText(ctx.root, ["repo", "view", "--json", "nameWithOwner,url,visibility,isPrivate,defaultBranchRef"]),
  },
  remote_branches: {
    description: "Branches que existem no remoto (origin). Não baixa nada.",
    args: "{}",
    run: (ctx) => remoteBranches(ctx.root),
  },
  remote_prs: {
    description: "Pull requests do GitHub. state: open, closed, merged ou all.",
    args: '{"state": "open", "limit": 20}',
    run: (ctx, args) => listItems(ctx.root, "pr", PR_STATES, PR_LIST_FIELDS, args),
  },
  remote_pr_view: {
    description: "Um PR: descrição, branches, revisão, mergeabilidade e checks de CI.",
    args: '{"number": 12}',
    run: (ctx, args) => viewItem(ctx.root, "pr", PR_VIEW_FIELDS, args),
  },
  remote_pr_diff: {
    description: "Diff de um PR (cortado se grande).",
    args: '{"number": 12}',
    run: (ctx, args) => clip(ghText(ctx.root, ["pr", "diff", numberOf(args.number)]), MAX_READ_CHARS),
  },
  remote_issues: {
    description: "Issues do GitHub. state: open, closed ou all.",
    args: '{"state": "open", "limit": 20}',
    run: (ctx, args) => listItems(ctx.root, "issue", ISSUE_STATES, ISSUE_LIST_FIELDS, args),
  },
  remote_issue_view: {
    description: "Uma issue: descrição, labels e comentários.",
    args: '{"number": 7}',
    run: (ctx, args) => viewItem(ctx.root, "issue", ISSUE_VIEW_FIELDS, args),
  },
  remote_api_get: {
    description: "Leitura GET da API do GitHub, só dentro deste repositório (ex.: repos/<dono>/<repo>/pulls/12/reviews).",
    args: '{"path": "repos/<dono>/<repo>/..."}',
    run: (ctx, args) => apiGet(ctx.root, args),
  },
};
