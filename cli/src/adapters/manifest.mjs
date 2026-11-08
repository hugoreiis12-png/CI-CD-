import { readJson, writeFile } from "../lib/fs-tools.mjs";

export function writeManifest(root, profile) {
  const rel = ".esteira/project.json";
  const previous = readJson(root, rel);

  const manifest = {
    schemaVersion: 1,
    tool: "@esteira/cli",
    adaptersVersion: 1,
    generatedAt: new Date().toISOString(),
    profile,
    // User-owned policy: preserved across re-runs of `init`.
    gate: previous?.gate ?? {
      mode: "block",
      blockAt: "medium",
      maxFileBytes: 5_242_880,
      playground: { enabled: true, baseline: true, timeoutMs: 120_000 },
      push: { requireAttestation: true },
      gates: [],
    },
    audit: previous?.audit ?? { sources: ["local", "github"], schedule: "daily", failOn: "high" },
  };

  writeFile(root, rel, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: rel, written: true, reason: "updated" };
}
