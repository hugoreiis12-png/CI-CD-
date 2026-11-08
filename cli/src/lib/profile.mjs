import { fingerprint } from "./fingerprint.mjs";
import { detectors } from "../detectors/index.mjs";
import { isDir } from "./fs-tools.mjs";

export const COMMAND_KEYS = ["lint", "typecheck", "test", "build"];

const EMPTY_INFRA = {
  containers: false, kubernetes: false, helm: false, terraform: false,
  ansible: false, argocd: false, ciProviders: [], hasPipelines: false,
};

/** Runs every detector, merges findings into a stable ProjectProfile. */
export function buildProfile(root) {
  const files = fingerprint(root);
  const warnings = [];
  const findings = [];

  for (const detect of detectors) {
    try {
      const found = detect(root, files);
      if (found) findings.push(found);
    } catch (error) {
      warnings.push(`${detect.name}: ${error.message}`);
    }
  }
  findings.sort((a, b) => b.confidence - a.confidence);

  const languages = findings
    .filter((f) => f.type === "language")
    .map((f) => ({
      id: f.id,
      confidence: f.confidence,
      runtime: f.runtime ?? {},
      packageManager: f.packageManager ?? null,
      frameworks: f.frameworks ?? [],
      evidence: f.evidence ?? [],
      commands: f.commands ?? {},
    }));

  const infra = findings.find((f) => f.type === "infra")?.infra ?? { ...EMPTY_INFRA };
  const workspacesTool = findings.map((f) => f.workspaces).find(Boolean) ?? null;
  const layout = ["apps", "packages", "services", "libs", "modules"].filter((d) => isDir(root, d));

  const commands = {};
  for (const key of COMMAND_KEYS) {
    commands[key] = languages.map((l) => l.commands[key]).find(Boolean) ?? null;
  }

  const gaps = [];
  if (languages.length === 0) {
    gaps.push({
      id: "unknown-stack",
      message: "No language manifest found; adapters will rely on file fingerprint only.",
    });
  }
  if (!commands.test) {
    gaps.push({ id: "no-test-command", message: "No test command detected — playground gates (M3) will require one." });
  }
  if (!commands.lint) {
    gaps.push({ id: "no-lint-command", message: "No lint command detected — the security gate will use built-in checks." });
  }

  return {
    schemaVersion: 1,
    root,
    generatedAt: new Date().toISOString(),
    files: { total: files.total, signatures: files.counts },
    languages,
    monorepo: { isMonorepo: Boolean(workspacesTool), tool: workspacesTool, layout },
    infra,
    commands,
    gaps,
    warnings,
  };
}
