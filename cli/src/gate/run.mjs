import { readJson } from "../lib/fs-tools.mjs";
import { getStaged } from "./staged.mjs";
import { checks } from "./checks/index.mjs";
import { snapshot, writeRun } from "./attest.mjs";
import { render } from "./report.mjs";

export const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

/** Gate policy from .esteira/project.json (written by `gh esteira init`); safe defaults. */
export function readGateConfig(root) {
  const manifest = readJson(root, ".esteira/project.json");
  const gate = manifest?.gate ?? {};
  return {
    mode: gate.mode ?? "block",           // "block" | "audit"
    blockAt: gate.blockAt ?? "medium",    // findings at/above this severity block
    maxFileBytes: gate.maxFileBytes ?? 5_242_880,
  };
}

/**
 * Runs the M2 pre-commit security gate over staged changes:
 * static/semantic checks + integrity snapshot. Playground matrix (M3) and
 * enforced attestation on push ride on `snapshot()`'s id.
 * Never throws: internal errors become findings so a broken check can't
 * silently bypass the gate.
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

  const blocking = findings
    .filter((f) => SEVERITY_RANK[f.severity] >= SEVERITY_RANK[config.blockAt]);
  const audit = config.mode === "audit";

  const verdict = blocking.length > 0 && !audit ? "reproved" : "approved";
  const exitCode = verdict === "reproved" ? 1 : 0;

  return finish({
    root, json, verdict, exitCode, findings, files, config,
    note: blocking.length > 0 && audit
      ? "Blocking findings present but mode is 'audit' — commit allowed, record written."
      : null,
  });
}

function finish(result) {
  const snap = snapshot(result.files);
  const run = {
    schemaVersion: 1,
    id: snap.short,
    snapshot: snap.id,
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
