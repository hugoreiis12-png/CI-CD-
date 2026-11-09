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
import { snapshot, writeRun, indexBlobs } from "./attest.mjs";
import { render } from "./report.mjs";
import { runPlayground } from "../playground/run.mjs";
import { buildProfile } from "../lib/profile.mjs";

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
 * @param {{ root: string, json?: boolean, policyRef?: string | null, head?: boolean }} options
 *   head: validate the HEAD commit itself (vs its parent, or the empty tree
 *   for a root commit) and attest it — for commits that skipped pre-commit.
 * @returns {RunRecord & { exitCode: number }}
 */
export function runGate({ root, json = false, policyRef = null, head = false }) {
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
  for (const check of checks) {
    try {
      findings.push(...check({ root, files, config }));
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
  if (config.playground.enabled) {
    try {
      const commands = manifest?.profile?.commands ?? buildProfile(root).commands;
      const result = runPlayground({ root, settings: config.playground, commands, ...(head ? { baselineRef: parentCommit(root) } : {}) });
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

  return finish({
    root, json, verdict, exitCode, findings, files, config, playground,
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
 */

/** @param {GateResult} result @returns {RunRecord & { exitCode: number }} */
function finish(result) {
  const snap = snapshot(result.files);
  let tree = null;
  try {
    if (result.files.length) tree = snapshot(indexBlobs(result.root)).id;
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
