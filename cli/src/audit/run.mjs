import { readJson, writeFile } from "../lib/fs-tools.mjs";
import { collectDependencies, sbomSummary } from "./manifests.mjs";
import { collectCves } from "./osv.mjs";
import { render } from "./report.mjs";

export const SEVERITY_ORDER = { critical: 4, high: 3, medium: 2, low: 1, unknown: 0 };

/** Audit policy from .esteira/project.json (written by `gh esteira init`). */
export function readAuditConfig(root) {
  const manifest = readJson(root, ".esteira/project.json");
  const audit = manifest?.audit ?? {};
  return {
    failOn: audit.failOn ?? "high",      // severity at/above which audit blocks
    maxDetails: audit.maxDetails ?? 40,  // advisory detail fetch cap
    sources: audit.sources ?? ["local", "github"],
  };
}

/**
 * `gh esteira audit` (M4): CWE/CVE advisories for the project's dependency
 * set — local manifests == the repository content (the GitHub-repo scan rides
 * on CI running this command against the checkout). Concise findings, each
 * with a concrete fix ("upgrade X to >= Y"), plus persisted record.
 */
export async function runAudit({ root, json = false, fetchImpl } = {}) {
  const config = readAuditConfig(root);
  const sbom = collectDependencies(root);
  const summary = sbomSummary(sbom);

  let findings = [];
  let offlineNote = null;
  try {
    if (sbom.length > 0) {
      findings = await collectCves(sbom, { fetchImpl, maxDetails: config.maxDetails });
    }
  } catch (error) {
    offlineNote = `Advisory source unreachable — audit ran offline: ${error.message.split("\n")[0]}`;
  }

  const counts = {};
  for (const severity of ["critical", "high", "medium", "low", "unknown"]) {
    counts[severity] = findings.filter((f) => f.severity === severity).length;
  }
  const blockers = findings
    .filter((f) => (SEVERITY_ORDER[f.severity] ?? 0) >= (SEVERITY_ORDER[config.failOn] ?? 3));
  const verdict = blockers.length > 0 ? "reproved" : "clean";

  const record = {
    schemaVersion: 1,
    tool: "@esteira/cli",
    kind: "cve-audit",
    generatedAt: new Date().toISOString(),
    root,
    sources: config.sources,
    failOn: config.failOn,
    verdict,
    counts,
    sbom: summary,
    advisoryCount: findings.length,
    blockers: blockers.length,
    findings,
    note: offlineNote ?? null,
  };

  try {
    writeFile(root, ".esteira/audits/latest.json", `${JSON.stringify(record, null, 2)}\n`);
    record.path = ".esteira/audits/latest.json";
  } catch {
    record.path = null;
  }

  const exitCode = verdict === "reproved" ? 1 : 0;
  if (json) {
    process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
  } else {
    process.stdout.write(`${render(record)}\n`);
  }
  return { ...record, exitCode };
}
