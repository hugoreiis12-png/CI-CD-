/** @typedef {import("../types.js").Profile} Profile */
import { buildProfile } from "../lib/profile.mjs";

/** @param {Profile} profile */
export function renderText(profile) {
  const lines = [];
  lines.push("Esteira — análise do projeto");
  lines.push(`Raiz        : ${profile.root}`);
  lines.push(`Arquivos    : ${profile.files.total}`);
  lines.push(
    `Linguagens  : ${profile.languages
      .map((l) => `${l.id}${l.packageManager ? ` (${l.packageManager})` : ""} [${l.confidence}]`)
      .join(", ") || "nenhuma"}`
  );
  const frameworks = [...new Set(profile.languages.flatMap((l) => l.frameworks))];
  if (frameworks.length) lines.push(`Frameworks  : ${frameworks.join(", ")}`);

  lines.push(
    `Monorepo    : ${profile.monorepo.isMonorepo ? `sim (${profile.monorepo.tool})` : "não"}` +
    (profile.monorepo.layout.length ? ` — ${profile.monorepo.layout.join(", ")}` : "")
  );

  const infraFlags = Object.entries(profile.infra)
    .filter(([, v]) => v === true)
    .map(([k]) => k);
  if (infraFlags.length) lines.push(`Infra       : ${infraFlags.join(", ")}`);
  if (profile.infra.ciProviders.length) {
    lines.push(`CI existente: ${profile.infra.ciProviders.join(", ")}`);
  }

  lines.push("Comandos    :");
  for (const [key, value] of Object.entries(profile.commands)) {
    lines.push(`  ${key.padEnd(9)} ${value ?? "—"}`);
  }

  if (profile.gaps.length) {
    lines.push("Lacunas     :");
    for (const gap of profile.gaps) lines.push(`  - [${gap.id}] ${gap.message}`);
  }

  return lines.join("\n");
}

/** @param {{ root: string, json?: boolean }} input */
export function runAnalyze({ root, json }) {
  const profile = buildProfile(root);
  process.stdout.write(json ? `${JSON.stringify(profile, null, 2)}\n` : `${renderText(profile)}\n`);
  return profile;
}
