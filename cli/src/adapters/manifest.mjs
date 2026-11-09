/** @typedef {import("../types.js").Profile} Profile */
import { readJson, writeFile } from "../lib/fs-tools.mjs";

/** @param {string} root @param {Profile} profile */
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
    // LLM advisory layer (Hermes): defaults ON pointing at the local node.
    // Turn off in .esteira/project.json: "llm": { "enabled": false }.
    llm: previous?.llm ?? { enabled: true, endpoint: "http://192.168.0.140:11434", model: "hermes3:8b", timeoutMs: 60000 },
  };

  writeFile(root, rel, `${JSON.stringify(manifest, null, 2)}\n`);
  return { path: rel, written: true, reason: "updated" };
}
