/** @typedef {import("../types.js").OrchestrationPlan} OrchestrationPlan */
/** @typedef {import("../types.js").OrchestrationAction} OrchestrationAction */
import fs from "node:fs";
import path from "node:path";
import { readJson } from "../lib/fs-tools.mjs";
import { orchestrate } from "./orchestrator.mjs";
import { render, renderJson } from "./report.mjs";

/**
 * `gh esteira orchestrate` — runs the full Hermes orchestration loop.
 *
 * Reads the latest gate run record and audit record (if present), builds the
 * pipeline state, calls the orchestrator, and prints the plan.
 *
 * Options:
 *   json:       print JSON instead of human-readable
 *   llm:        false to skip the LLM (deterministic fallback only)
 *   fetchImpl:  injected LLM transport (tests)
 *   timeoutMs:  LLM timeout override
 *   quiet:      suppress informational messages
 *
 * @param {{
 *   root: string,
 *   json?: boolean,
 *   llm?: boolean,
 *   fetchImpl?: unknown,
 *   timeoutMs?: number,
 *   quiet?: boolean,
 * }} input
 * @returns {Promise<OrchestrationPlan & { exitCode: number }>}
 */
export async function runOrchestrate({ root, json = false, llm = true, fetchImpl, timeoutMs, quiet = false }) {
  // Load the latest gate run record
  let gateState = null;
  try {
    const runsDir = path.join(root, ".esteira", "runs");
    if (fs.existsSync(runsDir)) {
      const runs = fs.readdirSync(runsDir)
        .filter((f) => f.endsWith(".json"))
        .sort()
        .reverse();
      if (runs.length > 0) {
        const latest = JSON.parse(fs.readFileSync(path.join(runsDir, runs[0]), "utf8"));
        gateState = {
          verdict: latest.verdict,
          findings: latest.findings ?? [],
          files: [],
          config: {
            mode: latest.mode ?? "block",
            blockAt: latest.blockAt ?? "high",
            maxFileBytes: 1_048_576,
            playground: { enabled: true, baseline: true, timeoutMs: 120_000 },
          },
          playground: latest.playground ?? null,
        };
      }
    }
  } catch {
    gateState = null;
  }

  // Load the latest audit record
  let auditState = null;
  try {
    const auditPath = path.join(root, ".esteira", "audits", "latest.json");
    if (fs.existsSync(auditPath)) {
      const record = JSON.parse(fs.readFileSync(auditPath, "utf8"));
      auditState = { record };
    }
  } catch {
    auditState = null;
  }

  // Load manifest
  let manifest = null;
  try {
    manifest = readJson(root, ".esteira/project.json");
  } catch {
    manifest = null;
  }

  // If no state at all, produce a minimal plan
  if (!gateState && !auditState) {
    /** @type {OrchestrationPlan} */
    const plan = {
      verdict: "hold",
      confidence: 0,
      actions: [{ type: "investigate", target: "pipeline", reason: "nenhum registro de gate ou audit encontrado — rode o gate ou audit primeiro", command: "" }],
      summary: "Sem dados suficientes para orquestrar. Rode `gh esteira gate` ou `gh esteira audit` primeiro.",
      risks: [],
      next_step: "Executar um gate ou audit para gerar dados.",
      source: "deterministic-fallback",
      error: null,
    };
    const exitCode = 0;
    if (json) process.stdout.write(renderJson(plan));
    else process.stdout.write(render(plan) + "\n");
    return { ...plan, exitCode };
  }

  const state = {
    gate: gateState ?? undefined,
    audit: auditState ?? undefined,
  };

  let plan;
  if (llm) {
    plan = await orchestrate({ manifest, state, fetchImpl, timeoutMs });
  } else {
    // No LLM: use the deterministic fallback directly
    plan = await orchestrate({ manifest: { llm: { enabled: false } }, state, fetchImpl, timeoutMs });
  }

  if (plan.error && !quiet) {
    process.stdout.write(`[hermes] LLM indisponível (${plan.error}) — usando plano determinístico.\n`);
  }

  const exitCode = plan.verdict === "block" ? 1 : 0;
  if (json) process.stdout.write(renderJson(plan));
  else process.stdout.write(render(plan) + "\n");

  return { ...plan, exitCode };
}
