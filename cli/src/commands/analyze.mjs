import { buildProfile } from "../lib/profile.mjs";

export function renderText(profile) {
  const lines = [];
  lines.push("Esteira — project analysis");
  lines.push(`Root        : ${profile.root}`);
  lines.push(`Files       : ${profile.files.total}`);
  lines.push(
    `Languages   : ${profile.languages
      .map((l) => `${l.id}${l.packageManager ? ` (${l.packageManager})` : ""} [${l.confidence}]`)
      .join(", ") || "none"}`
  );
  const frameworks = [...new Set(profile.languages.flatMap((l) => l.frameworks))];
  if (frameworks.length) lines.push(`Frameworks  : ${frameworks.join(", ")}`);

  lines.push(
    `Monorepo    : ${profile.monorepo.isMonorepo ? `yes (${profile.monorepo.tool})` : "no"}` +
    (profile.monorepo.layout.length ? ` — ${profile.monorepo.layout.join(", ")}` : "")
  );

  const infraFlags = Object.entries(profile.infra)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (infraFlags.length) lines.push(`Infra       : ${infraFlags.join(", ")}`);
  if (profile.infra.ciProviders.length) {
    lines.push(`Existing CI : ${profile.infra.ciProviders.join(", ")}`);
  }

  lines.push("Commands    :");
  for (const [key, value] of Object.entries(profile.commands)) {
    lines.push(`  ${key.padEnd(9)} ${value ?? "—"}`);
  }

  if (profile.gaps.length) {
    lines.push("Gaps        :");
    for (const gap of profile.gaps) lines.push(`  - [${gap.id}] ${gap.message}`);
  }

  return lines.join("\n");
}

export function runAnalyze({ root, json }) {
  const profile = buildProfile(root);
  process.stdout.write(json ? `${JSON.stringify(profile, null, 2)}\n` : `${renderText(profile)}\n`);
  return profile;
}
