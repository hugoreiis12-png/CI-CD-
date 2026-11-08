import { writeManifest } from "../adapters/manifest.mjs";
import { writeWorkflow } from "../adapters/workflows.mjs";
import { installHook } from "../adapters/precommit.mjs";
import { appendUniqueLines } from "../lib/fs-tools.mjs";
import { buildProfile } from "../lib/profile.mjs";
import { renderText } from "./analyze.mjs";

const PLANNED = [
  ".esteira/project.json",
  ".github/workflows/esteira-ci.yml",
  ".esteira/hooks/pre-commit (+ git config core.hooksPath)",
  ".gitignore (+ .esteira/runs/, .esteira/tmp/)",
];

export function runInit({ root, dryRun = false, force = false, quiet = false }) {
  const profile = buildProfile(root);

  if (dryRun) {
    if (!quiet) {
      process.stdout.write(
        `${renderText(profile)}\n\nDry run — nothing written. Planned adapters:\n` +
        PLANNED.map((p) => `  - ${p}`).join("\n") + "\n"
      );
    }
    return {
      profile, dryRun: true,
      results: PLANNED.map((p) => ({ path: p, written: false, reason: "dry-run" })),
    };
  }

  const results = [
    writeManifest(root, profile),
    writeWorkflow(root, profile, { force }),
    installHook(root),
    { path: ".gitignore", ...appendUniqueLines(root, ".gitignore", [".esteira/runs/", ".esteira/tmp/"]) },
  ];

  if (!quiet) {
    process.stdout.write(`${renderText(profile)}\n\nAdapters:\n`);
    for (const r of results) {
      const applied = r.written || r.changed || r.installed;
      const status = applied ? "applied" : `skipped (${r.reason ?? "unchanged"})`;
      process.stdout.write(`  - ${r.path}: ${status}\n`);
    }
    process.stdout.write(
      "\nNext:\n" +
      "  - gh esteira gate --staged   (M2: pre-commit security gate)\n" +
      "  - gh esteira audit           (M4: CVE audit)\n"
    );
  }

  return { profile, dryRun: false, results };
}
