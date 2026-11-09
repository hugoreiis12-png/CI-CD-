import { execFileSync } from "node:child_process";

/** @typedef {import("../../types.js").Check} Check */
/** @typedef {import("../../types.js").Finding} Finding */
/** @typedef {import("../../types.js").Severity} Severity */

// CI configuration is authorization code (Cloudflare security-audit skill,
// SUPPLY-CHAIN-AND-RELEASE.md). These rules read the whole staged workflow,
// not only added lines: a privileged trigger added in one place changes the
// meaning of steps that already exist.

const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

// Contexts a pull-request author, issue author or commenter controls.
const UNTRUSTED_CONTEXT = new RegExp(
  "\\$\\{\\{[^}]*\\b(?:" + [
    "github\\.event\\.(?:issue|pull_request|discussion)\\.(?:title|body)",
    "github\\.event\\.(?:comment|review|review_comment)\\.body",
    "github\\.event\\.pull_request\\.head\\.(?:ref|label|repo\\.default_branch)",
    "github\\.event\\.head_commit\\.(?:message|author\\.(?:name|email))",
    "github\\.event\\.commits\\b[^}]*\\.(?:message|author)",
    "github\\.event\\.workflow_run\\.(?:head_branch|head_commit\\.message|display_title)",
    "github\\.event\\.pages\\b[^}]*\\.page_name",
    "github\\.head_ref",
  ].join("|") + ")",
);
const PRIVILEGED_TRIGGER = /^\s*(?:on:\s*\[?.*\b(?:pull_request_target|workflow_run)\b|(?:-\s*)?(?:pull_request_target|workflow_run)\s*:?\s*$)/m;
const HEAD_REF = /\bref:\s*\$\{\{[^}]*(?:pull_request\.head\.(?:sha|ref)|github\.head_ref|workflow_run\.head_(?:sha|branch))/;
const USES = /^\s*(?:-\s*)?uses:\s*([^@\s#]+)@([^\s#]+)/;
const PRIVILEGE = /:\s*write\b|\bwrite-all\b|\bsecrets\.|id-token/;

/**
 * @param {string} root
 * @param {string} blob
 */
function blobText(root, blob) {
  return execFileSync("git", ["cat-file", "-p", blob], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

/**
 * Line numbers (1-based) of every line that belongs to a `run:` script.
 * @param {string[]} lines
 */
function runLines(lines) {
  /** @type {Set<number>} */
  const inside = new Set();
  let blockIndent = -1;
  lines.forEach((line, i) => {
    const indent = line.length - line.trimStart().length;
    if (blockIndent >= 0) {
      if (line.trim() === "" || indent > blockIndent) {
        inside.add(i + 1);
        return;
      }
      blockIndent = -1;
    }
    const run = line.match(/^(\s*)(?:-\s*)?run:\s*(.*)$/);
    if (!run) return;
    inside.add(i + 1);
    // `run: |` / `run: >-` open a block scalar; anything else is inline.
    if (/^[|>][+-]?\s*(?:#.*)?$/.test(run[2])) blockIndent = indent;
  });
  return inside;
}

/**
 * @param {string} path
 * @param {string} text
 * @returns {Finding[]}
 */
export function analyzeWorkflow(path, text) {
  /** @type {Finding[]} */
  const findings = [];
  const lines = text.split("\n");
  /** @param {string} rule @param {Severity} severity @param {number} line @param {string} message */
  const add = (rule, severity, line, message) =>
    findings.push({ check: "workflows", severity, rule, file: path, line, message });

  const privilegedTrigger = PRIVILEGED_TRIGGER.test(text);
  const privileged = privilegedTrigger || PRIVILEGE.test(text);
  const scripts = runLines(lines);

  lines.forEach((line, i) => {
    const n = i + 1;
    if (privilegedTrigger && HEAD_REF.test(line)) {
      add("ci-privileged-pr-checkout", "high", n,
        "pull_request_target/workflow_run faz checkout do código do PR: o código do contribuidor roda com os segredos e o token de escrita do repositório");
    }
    if (scripts.has(n) && UNTRUSTED_CONTEXT.test(line)) {
      add("ci-expression-injection", "high", n,
        "${{ github.event… }} controlado pelo contribuidor expandido dentro de um script run: (injeção de shell); passe por env: e use \"$VAR\" entre aspas");
    }
    if (/^\s*permissions:\s*write-all\b/.test(line)) {
      add("ci-write-all", "medium", n, "permissions: write-all dá todos os escopos de escrita a todos os steps; conceda o mínimo por job");
    }
    const uses = line.match(USES);
    if (uses && !uses[1].startsWith("./") && !uses[1].startsWith("docker://") && !/^[0-9a-f]{40}$/.test(uses[2])) {
      add(privileged ? "ci-floating-action-privileged" : "ci-floating-action", privileged ? "medium" : "low", n,
        `${uses[1]}@${uses[2]} é uma referência mutável${privileged ? " num workflow com escopos de escrita ou segredos" : ""}; fixe numa SHA de commit (gh esteira pin)`);
    }
  });
  return findings;
}

/** @type {Check} */
export function checkWorkflows(ctx) {
  /** @type {Finding[]} */
  const findings = [];
  for (const file of ctx.files) {
    if (!file.blob || !WORKFLOW.test(file.path)) continue;
    findings.push(...analyzeWorkflow(file.path, blobText(ctx.root, file.blob)));
  }
  return findings;
}
