/** @typedef {import("../types.js").Finding} Finding */
/** @typedef {import("../types.js").StagedFile} StagedFile */
/** @typedef {import("../types.js").GateConfig} GateConfig */
/** @typedef {import("../types.js").GateMode} GateMode */
/** @typedef {import("../types.js").Manifest} Manifest */
/** @typedef {import("../types.js").PlaygroundOutcome} PlaygroundOutcome */
/** @typedef {import("../types.js").RunRecord} RunRecord */
/** @typedef {import("../types.js").Severity} Severity */
/** @typedef {import("../types.js").Verdict} Verdict */
import { execFileSync } from "node:child_process";
import { readJson, errorLine } from "../lib/fs-tools.mjs";
import { getStaged, headBase } from "./staged.mjs";
import { checks } from "./checks/index.mjs";
import { snapshot, writeRun, indexBlobs, treeBlobs, findAttestedRun } from "./attest.mjs";
import { render } from "./report.mjs";
import { runPlayground } from "../playground/run.mjs";
import { buildProfile } from "../lib/profile.mjs";
import { resolveLlmSettings } from "../hermes/config.mjs";
import { gateAdvisory } from "../hermes/advisory.mjs";

/** @type {Record<Severity, number>} */
export const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };
/** @param {unknown} value @returns {value is Severity} */
const isSeverity = (value) => typeof value === "string" && Object.hasOwn(SEVERITY_RANK, value);
/** @param {unknown} value @returns {value is GateMode} */
const isMode = (value) => value === "block" || value === "audit";

const MANIFEST = ".esteira/project.json";

/** @param {string} root */
const indexMatchesHead = (root) => {
  try {
    execFileSync("git", ["diff", "--cached", "--quiet"], { cwd: root, stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
};

/** @param {string} root @param {string} commit @returns {string | null} first parent */
const commitParent = (root, commit) => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "-q", `${commit}^1`], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || null;
  } catch {
    return null;
  }
};

/** @param {string} root */
const emptyTree = (root) =>
  execFileSync("git", ["hash-object", "-t", "tree", "--stdin"], { cwd: root, encoding: "utf8", input: "" }).trim();

/** @param {string} root @returns {string | null} */
const parentCommit = (root) => {
  try {
    return execFileSync("git", ["rev-parse", "--verify", "HEAD^"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
};

/**
 * The project manifest. With `policyRef` (CI) it is read from that trusted
 * commit, never from the change set under review (item 2): a PR cannot relax
 * the policy of the gate that judges it. A bad ref throws (fail closed); a ref
 * without a manifest means defaults.
 */
/**
 * @param {string} root
 * @param {string | null} [policyRef]
 * @returns {Manifest | null}
 */
export function loadManifest(root, policyRef = null) {
  if (!policyRef) return readJson(root, MANIFEST);
  const git = (/** @type {string[]} */ args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["cat-file", "-e", `${policyRef}^{commit}`]);
  let text;
  try {
    text = git(["show", `${policyRef}:${MANIFEST}`]);
  } catch {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`${MANIFEST} em ${policyRef} não é um JSON válido: ${errorLine(error)}`);
  }
}

/**
 * Gate policy with safe defaults. Unknown `mode`/`blockAt` values are reported
 * as errors instead of silently disabling blocking (`x >= undefined` is false).
 */
/**
 * @param {Manifest | null} manifest
 * @returns {{ config: GateConfig, errors: string[] }}
 */
export function readGateConfig(manifest) {
  const gate = manifest?.gate ?? {};
  /** @type {string[]} */
  const errors = [];
  if (gate.mode !== undefined && !isMode(gate.mode)) {
    errors.push(`gate.mode precisa ser block|audit (recebido: ${JSON.stringify(gate.mode)})`);
  }
  if (gate.blockAt !== undefined && !isSeverity(gate.blockAt)) {
    errors.push(`gate.blockAt precisa ser ${Object.keys(SEVERITY_RANK).join("|")} (recebido: ${JSON.stringify(gate.blockAt)})`);
  }
  const config = {
    mode: isMode(gate.mode) ? gate.mode : "block",
    blockAt: isSeverity(gate.blockAt) ? gate.blockAt : "medium",
    maxFileBytes: gate.maxFileBytes ?? 5_242_880,
    playground: {
      enabled: gate.playground?.enabled !== false,
      baseline: gate.playground?.baseline !== false,
      timeoutMs: gate.playground?.timeoutMs ?? 120_000,
    },
  };
  return { config, errors };
}

/**
 * Runs the full pre-commit security gate over staged changes:
 *   1. static/semantic checks (M2)
 *   2. isolated playground gate matrix (M3): suite regression vs HEAD + typecheck
 *   3. integrity snapshots: `snapshot` (changed set) and `tree` (full index)
 * A failed check fails closed: internal errors become high findings.
 * On approval the run record becomes a push attestation (see `attest --verify`).
 */
/**
 * @param {{ root: string, json?: boolean, policyRef?: string | null, head?: boolean, llm?: boolean, fetchImpl?: unknown }} options
 *   head: validate the HEAD commit itself (vs its parent, or the empty tree
 *   for a root commit) and attest it — for commits that skipped pre-commit.
 *   llm: false to skip the Hermes advisory (default true).
 *   fetchImpl: injected LLM transport (tests run fully offline).
 * @returns {Promise<RunRecord & { exitCode: number }>}
 */
export async function runGate({ root, json = false, policyRef = null, head = false, llm = true, fetchImpl }) {
  /** @type {StagedFile[]} */
  let files = [];
  try {
    if (head && !indexMatchesHead(root)) {
      throw new Error("--head valida o último commit, mas há mudanças staged: commite-as ou remova-as do índice antes");
    }
    files = getStaged(root, head ? { base: headBase(root) } : {});
  } catch (error) {
    // Fail closed (item 1): an unreadable change set is never "approved".
    return finish({
      root, json, verdict: "reproved", exitCode: 1, files: [],
      findings: [{
        check: "gate", severity: "high", rule: "gate-read-error", file: "*", line: null,
        message: `Não foi possível ler as mudanças staged — nada foi validado: ${errorLine(error)}`,
      }],
    });
  }

  if (files.length === 0) {
    return finish({
      root, json, verdict: "approved", exitCode: 0, findings: [], files,
      note: head ? "O último commit não tem mudanças para validar." : "Nada staged; o gate não tinha mudanças para validar.",
    });
  }

  return await evaluate({
    root, json, policyRef, fileSets: [{ label: null, files }],
    playgroundArgs: head ? { baselineRef: parentCommit(root) } : {},
    llm, fetchImpl,
  });
}

/**
 * Validates commits that already exist (pre-push, pre-merge ranges): every
 * commit's own diff goes through the static checks — so a secret added in
 * one commit and removed in the next is still caught — and the tip runs the
 * playground unless its exact tree was already approved. On approval the
 * tip's tree is attested, so the push goes through.
 * @param {{ root: string, commits: string[], json?: boolean, staticOnly?: boolean }} options oldest first;
 *   staticOnly: only the static checks, no playground and no attestation (pull/merge analysis)
 * @returns {Promise<RunRecord & { exitCode: number }>}
 */
export async function runGateCommits({ root, commits, json = false, staticOnly = false }) {
  if (commits.length === 0) {
    return finish({ root, json, verdict: "approved", exitCode: 0, findings: [], files: [], note: "Nenhum commit novo para validar." });
  }
  const tip = commits[commits.length - 1];
  /** @type {{ label: string, files: StagedFile[] }[]} */
  const fileSets = [];
  try {
    for (const commit of commits) {
      const base = commitParent(root, commit) ?? emptyTree(root);
      fileSets.push({ label: commit.slice(0, 7), files: getStaged(root, { base, target: commit }) });
    }
  } catch (error) {
    return finish({
      root, json, verdict: "reproved", exitCode: 1, files: [],
      findings: [{ check: "gate", severity: "high", rule: "gate-read-error", file: "*", line: null, message: `Não foi possível ler os commits — nada foi validado: ${errorLine(error)}` }],
    });
  }
  if (staticOnly) {
    return await evaluate({ root, json, fileSets, noAttest: true, skipPlayground: "análise estática dos commits recebidos" });
  }
  const tipTree = snapshot(treeBlobs(root, tip)).id;
  return await evaluate({
    root, json, fileSets, treeRef: tip,
    skipPlayground: findAttestedRun(root, tipTree) ? "o conteúdo do último commit já foi aprovado pelo gate" : null,
    playgroundArgs: { stagedRef: tip, baselineRef: commitParent(root, commits[0]) },
  });
}

/**
 * Shared evaluation: policy → static checks per file set → playground → verdict.
 * @param {{
 *   root: string, json: boolean, policyRef?: string | null,
 *   fileSets: { label: string | null, files: StagedFile[] }[],
 *   playgroundArgs?: { baselineRef?: string | null, stagedRef?: string },
 *   treeRef?: string, skipPlayground?: string | null, noAttest?: boolean,
 *   llm?: boolean, fetchImpl?: unknown,
 * }} input
 */
async function evaluate({ root, json, policyRef = null, fileSets, playgroundArgs = {}, treeRef, skipPlayground = null, noAttest = false, llm = true, fetchImpl }) {
  const files = fileSets.flatMap((set) => set.files);
  let manifest;
  try {
    manifest = loadManifest(root, policyRef);
  } catch (error) {
    return finish({
      root, json, verdict: "reproved", exitCode: 1, files,
      findings: [{
        check: "gate", severity: "high", rule: "gate-policy-error", file: MANIFEST, line: null,
        message: `Não foi possível carregar a política do gate${policyRef ? ` de ${policyRef}` : ""}: ${errorLine(error)}`,
      }],
    });
  }
  const { config, errors } = readGateConfig(manifest);
  /** @type {Finding[]} */
  const findings = errors.map((message) => ({
    check: "gate", severity: /** @type {const} */ ("high"), rule: "gate-policy-invalid", file: MANIFEST, line: null, message,
  }));
  for (const set of fileSets) for (const check of checks) {
    try {
      const found = check({ root, files: set.files, config });
      findings.push(...(set.label ? found.map((f) => ({ ...f, message: `[commit ${set.label}] ${f.message}` })) : found));
    } catch (error) {
      findings.push({
        check: check.name ?? "unknown", severity: "high", rule: "check-error",
        file: "*", line: null,
        message: `A checagem do gate falhou — trate como vulnerável até corrigir: ${errorLine(error)}`,
      });
    }
  }

  /** @type {PlaygroundOutcome | null} */
  let playground = null;
  if (skipPlayground) {
    playground = { ran: false, reason: skipPlayground };
  } else if (config.playground.enabled) {
    try {
      const commands = manifest?.profile?.commands ?? buildProfile(root).commands;
      const result = runPlayground({ root, settings: config.playground, commands, ...playgroundArgs });
      playground = { ran: result.ran, lines: result.lines, results: result.results };
      findings.push(...result.findings);
    } catch (error) {
      playground = { ran: false, reason: errorLine(error) };
      findings.push({
        check: "playground", severity: "medium", rule: "playground-error",
        file: "*", line: null,
        message: `O playground não rodou — para desligá-lo, use gate.playground.enabled=false: ${playground.reason}`,
      });
    }
  }

  const blocking = findings
    .filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[config.blockAt]);
  const audit = config.mode === "audit";

  const verdict = blocking.length > 0 && !audit ? "reproved" : "approved";
  const exitCode = verdict === "reproved" ? 1 : 0;

  // Hermes advisory (advisory only — never touches the verdict above).
  // `llm: false` (from --no-llm) or a disabled manifest config short-circuits
  // to null; any failure also degrades to null. A config typo never blocks.
  let advisory = null;
  if (llm) {
    try {
      advisory = await gateAdvisory({ root, manifest, config, verdict, findings, files, fetchImpl });
    } catch {
      advisory = null;
    }
  }

  return finish({
    root, json, verdict, exitCode, findings, files, config, playground, treeRef, noAttest, advisory,
    note: blocking.length > 0 && audit
      ? "Há findings bloqueantes, mas o modo é 'audit' — commit liberado e registro gravado."
      : null,
  });
}

/**
 * @typedef {object} GateResult
 * @property {string} root
 * @property {boolean} json
 * @property {Verdict} verdict
 * @property {0 | 1} exitCode
 * @property {Finding[]} findings
 * @property {StagedFile[]} files
 * @property {GateConfig} [config]
 * @property {PlaygroundOutcome | null} [playground]
 * @property {string | null} [note]
 * @property {string} [treeRef] attest this commit's tree instead of the index
 * @property {boolean} [noAttest] never record an attestation (analysis only)
 * @property {import("../types.js").RunRecord["advisory"]} [advisory] Hermes advisory, when the LLM ran
 */

/** @param {GateResult} result @returns {RunRecord & { exitCode: number }} */
function finish(result) {
  const snap = snapshot(result.files);
  let tree = null;
  try {
    if (result.noAttest) tree = null;
    else if (result.treeRef) tree = snapshot(treeBlobs(result.root, result.treeRef)).id;
    else if (result.files.length) tree = snapshot(indexBlobs(result.root)).id;
  } catch {
    tree = null;
  }

  /** @type {RunRecord} */
  const run = {
    schemaVersion: 1,
    id: snap.short,
    snapshot: snap.id,
    tree,
    attested: result.verdict === "approved" && Boolean(tree),
    tool: "@esteira/cli",
    createdAt: new Date().toISOString(),
    root: result.root,
    verdict: result.verdict,
    mode: result.config?.mode ?? "block",
    blockAt: result.config?.blockAt ?? "medium",
    stats: {
      files: result.files.length,
      insertions: result.files.reduce((n, f) => n + (f.insertions ?? 0), 0),
      deletions: result.files.reduce((n, f) => n + (f.deletions ?? 0), 0),
      findings: result.findings.length,
    },
    findings: result.findings,
    playground: result.playground ?? null,
    advisory: result.advisory ?? null,
    note: result.note ?? null,
  };
  try {
    run.path = writeRun(result.root, run).path;
  } catch {
    run.path = null;
  }

  if (!result.json) {
    process.stdout.write(`${render(run)}\n`);
  }
  return { ...run, exitCode: result.exitCode };
}
