import { writeManifest } from "../adapters/manifest.mjs";
import { writeWorkflow } from "../adapters/workflows.mjs";
import { installHook } from "../adapters/precommit.mjs";
import { appendUniqueLines } from "../lib/fs-tools.mjs";
import { buildProfile } from "../lib/profile.mjs";
import { renderText } from "./analyze.mjs";

/** @type {Record<string, string>} */
const REASONS = { exists: "já existe", unchanged: "sem mudanças", "not-a-git-repository": "não é um repositório git", "dry-run": "dry-run" };

const PLANNED = [
  ".esteira/project.json",
  ".github/workflows/esteira-ci.yml",
  ".esteira/hooks/pre-commit (+ git config core.hooksPath)",
  ".gitignore (+ .esteira/runs/, .esteira/tmp/, .esteira/hooks/)",
];

/** @param {{ root: string, dryRun?: boolean, force?: boolean, quiet?: boolean }} input */
export function runInit({ root, dryRun = false, force = false, quiet = false }) {
  const profile = buildProfile(root);

  if (dryRun) {
    if (!quiet) {
      process.stdout.write(
        `${renderText(profile)}\n\nDry-run — nada foi gravado. Adaptadores previstos:\n` +
        PLANNED.map((p) => `  - ${p}`).join("\n") + "\n"
      );
    }
    return {
      profile, dryRun: true,
      results: PLANNED.map((p) => ({ path: p, written: false, reason: "dry-run" })),
    };
  }

  /** @type {{ path: string, written?: boolean, changed?: boolean, installed?: boolean, reason?: string }[]} */
  const results = [
    writeManifest(root, profile),
    writeWorkflow(root, profile, { force }),
    installHook(root),
    { path: ".gitignore", ...appendUniqueLines(root, ".gitignore", [".esteira/runs/", ".esteira/tmp/", ".esteira/hooks/"]) },
  ];

  if (!quiet) {
    process.stdout.write(`${renderText(profile)}\n\nAdaptadores:\n`);
    for (const r of results) {
      const applied = r.written || r.changed || r.installed;
      const reason = r.reason ?? "unchanged";
      const status = applied ? "aplicado" : `ignorado (${REASONS[reason] ?? reason})`;
      process.stdout.write(`  - ${r.path}: ${status}\n`);
    }
    process.stdout.write(
      "\nPróximos passos:\n" +
      "  - gh esteira pin             (fixa as actions dos workflows por SHA)\n" +
      "  - git commit                 (o pre-commit roda o gate de segurança + playground)\n" +
      "  - gh esteira audit           (auditoria de CVEs das dependências)\n" +
      "  - Manual: https://github.com/hugoreiis12-png/gh-esteira/blob/main/docs/MANUAL.md\n"
    );
  }

  return { profile, dryRun: false, results };
}
