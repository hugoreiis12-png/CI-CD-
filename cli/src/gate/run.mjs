import { readJson } from "../lib/fs-tools.mjs";
import { getStaged } from "./staged.mjs";
import { checks } from "./checks/index.mjs";
import { snapshot, writeRun, indexBlobs } from "./attest.mjs";
import { render } from "./report.mjs";
import { runPlayground } from "../playground/run.mjs";
import { buildProfile } from "../lib/profile.mjs";

export const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

/** Gate policy from .esteira/project.json (written by `gh esteira init`); safe defaults. */
export function readGateConfig(root) {
  const manifest = readJson(root, ".esteira/project.json");
  const gate = manifest?.gate ?? {};
  return {
    mode: gate.mode ?? "block",           // "block" | "audit"
    blockAt: gate.blockAt ?? "medium",    // findings at/above this severity block
    maxFileBytes: gate.maxFileBytes ?? 5_242_880,
    playground: {
      enabled: gate.playground?.enabled !== false,
      baseline: gate.playground?.baseline !== false,
      timeoutMs: gate.playground?.timeoutMs ?? 120_000,
    },
  };
}

/**
 * Runs the full pre-commit security gate over staged changes:
 *   1. static/semantic checks (M2)
 *   2. isolated playground gate matrix (M3): suite regression vs HEAD + typecheck
 *   3. integrity snapshots: `snapshot` (changed set) and `tree` (full index)
 * A failed check fails closed: internal errors become high findings.
 * On approval the run record becomes a push attestation (see `attest --verify`).
 */
export function runGate({ root, json = false }) {
  let files = [];
  try {
    files = getStaged(root);
  } catch (error) {
    return finish({
      root, json, verdict: "approved", exitCode: 0, findings: [], files: [],
      note: `Nothing gated (not a git repository or git unavailable): ${error.message.split("\n")[0]}`,
    });
  }

  if (files.length === 0) {
    return finish({
      root, json, verdict: "approved", exitCode: 0, findings: [], files,
      note: "Nothing staged; the gate had no changes to validate.",
    });
  }

  const config = readGateConfig(root);
  const findings = [];
  for (const check of checks) {
    try {
      findings.push(...check({ root, files, config }));
    } catch (error) {
      findings.push({
        check: check.name ?? "unknown", severity: "high", rule: "check-error",
        file: "*", line: null,
        message: `Gate check failed — treat as vulnerable until fixed: ${error.message.split("\n")[0]}`,
      });
    }
  }

  let playground = null;
  if (config.playground.enabled) {
    try {
      const commands = commandsFor(root);
      const result = runPlayground({ root, settings: config.playground, commands });
      playground = { ran: result.ran, lines: result.lines, results: result.results };
      findings.push(...result.findings);
    } catch (error) {
      playground = { ran: false, reason: error.message.split("\n")[0] };
      findings.push({
        check: "playground", severity: "medium", rule: "playground-error",
        file: "*", line: null,
        message: `Playground could not run — set gate.playground.enabled=false to bypass: ${playground.reason}`,
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
      ? "Blocking findings present but mode is 'audit' — commit allowed, record written."
      : null,
  });
}

/** Test/typecheck commands from the manifest profile (fallback: fresh analyze). */
function commandsFor(root) {
  const manifest = readJson(root, ".esteira/project.json");
  const fromManifest = manifest?.profile?.commands;
  if (fromManifest) return fromManifest;
  return buildProfile(root).commands;
}

function finish(result) {
  const snap = snapshot(result.files);
  let tree = null;
  try {
    if (result.files.length) tree = snapshot(indexBlobs(result.root)).id;
  } catch {
    tree = null;
  }

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
