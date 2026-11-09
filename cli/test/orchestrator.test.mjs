// Hermes orchestrator: the full CI/CD decision loop. Tests the deterministic
// fallback plan, the JSON parse, the guards (LLM cannot reverse a block),
// and the runOrchestrate command entry point.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orchestrate, buildStateText } from "../src/hermes/orchestrator.mjs";
import { render, renderJson } from "../src/hermes/report.mjs";
import { runOrchestrate } from "../src/hermes/run.mjs";

// Disable LLM for all tests (deterministic fallback only)
process.env.ESTEIRA_LLM_ENABLED = "false";

// ---- test fixtures ----

/** A clean gate state (no findings). */
const CLEAN_GATE = {
  verdict: "approved",
  findings: [],
  files: [{ path: "src/app.ts", insertions: 10, deletions: 2 }],
  config: { mode: "block", blockAt: "high", maxFileBytes: 1_048_576, playground: { enabled: true, baseline: true, timeoutMs: 120_000 } },
  playground: null,
};

/** A gate state with a high-severity finding. */
const BLOCKED_GATE = {
  verdict: "reproved",
  findings: [
    { check: "secrets", severity: "high", rule: "no-hardcoded-secrets", file: "src/config.ts", line: 12, message: "hardcoded API key" },
  ],
  files: [{ path: "src/config.ts", insertions: 5, deletions: 0 }],
  config: { mode: "block", blockAt: "high", maxFileBytes: 1_048_576, playground: { enabled: true, baseline: true, timeoutMs: 120_000 } },
  playground: null,
};

/** A clean audit record. */
const CLEAN_AUDIT = {
  verdict: "clean",
  failOn: "high",
  sbom: { total: 42 },
  advisoryCount: 0,
  blockers: 0,
  counts: {},
  findings: [],
};

/** An audit record with a critical CVE. */
const CRITICAL_AUDIT = {
  verdict: "reproved",
  failOn: "high",
  sbom: { total: 42 },
  advisoryCount: 1,
  blockers: 1,
  counts: { critical: 1 },
  findings: [
    { id: "GHSA-xxxx", package: "lodash", version: "4.17.20", source: "osv.dev", severity: "critical", summary: "Prototype pollution", fixed: ["4.17.21"], ecosystem: "npm" },
  ],
};

const NO_MANIFEST = null;

// ---- deterministicPlan (via orchestrate with LLM disabled) ----

test("orchestrate: clean state → approve (deterministic fallback)", async () => {
  const plan = await orchestrate({
    manifest: NO_MANIFEST,
    state: { gate: CLEAN_GATE, audit: { record: CLEAN_AUDIT } },
  });
  assert.equal(plan.verdict, "approve");
  assert.equal(plan.confidence, 100);
  assert.equal(plan.source, "deterministic-fallback");
  assert.ok(plan.actions.some((a) => a.type === "approve"));
});

test("orchestrate: high gate finding → block", async () => {
  const plan = await orchestrate({
    manifest: NO_MANIFEST,
    state: { gate: BLOCKED_GATE },
  });
  assert.equal(plan.verdict, "block");
  assert.equal(plan.source, "deterministic-fallback");
  assert.ok(plan.actions.some((a) => a.type === "block"));
  assert.ok(plan.actions.some((a) => a.type === "fix"));
});

test("orchestrate: critical CVE → block with upgrade command", async () => {
  const plan = await orchestrate({
    manifest: NO_MANIFEST,
    state: { gate: CLEAN_GATE, audit: { record: CRITICAL_AUDIT } },
  });
  assert.equal(plan.verdict, "block");
  const fixAction = plan.actions.find((a) => a.type === "fix" && a.command);
  assert.ok(fixAction);
  assert.match(fixAction.command, /npm install lodash@>=4\.17\.21/);
});

test("orchestrate: no state at all → approve (no gate/audit data)", async () => {
  const plan = await orchestrate({ manifest: NO_MANIFEST, state: {} });
  assert.equal(plan.verdict, "approve");
});

// ---- buildStateText ----

test("buildStateText: includes gate verdict and findings", () => {
  const text = buildStateText({ gate: BLOCKED_GATE });
  assert.match(text, /## GATE/);
  assert.match(text, /Veredito: reproved/);
  assert.match(text, /no-hardcoded-secrets/);
  assert.match(text, /hardcoded API key/);
});

test("buildStateText: includes audit CVEs", () => {
  const text = buildStateText({ audit: { record: CRITICAL_AUDIT } });
  assert.match(text, /## AUDIT \(CVEs\)/);
  assert.match(text, /GHSA-xxxx/);
  assert.match(text, /lodash/);
});

test("buildStateText: empty state → empty string", () => {
  assert.equal(buildStateText({}), "");
});

// ---- render / renderJson ----

test("render: shows verdict and actions", () => {
  const plan = {
    verdict: "block", confidence: 100,
    actions: [{ type: "block", target: "pipeline", reason: "1 finding", command: "" }],
    summary: "Bloqueado", risks: ["hardcoded API key"], next_step: "Corrija",
    source: "deterministic-fallback", error: null,
  };
  const text = render(plan);
  assert.match(text, /BLOQUEADO/);
  assert.match(text, /confiança: 100%/);
  assert.match(text, /block/);
  assert.match(text, /hardcoded API key/);
});

test("renderJson: returns valid JSON", () => {
  const plan = {
    verdict: "approve", confidence: 100, actions: [],
    summary: "ok", risks: [], next_step: "done",
    source: "deterministic-fallback", error: null,
  };
  const text = renderJson(plan);
  const parsed = JSON.parse(text);
  assert.equal(parsed.verdict, "approve");
});

// ---- runOrchestrate: no state → hold ----

test("runOrchestrate: no gate/audit records → hold with investigate", async () => {
  // Use a non-existent directory so no .esteira/runs or .esteira/audits exist
  const result = await runOrchestrate({ root: "/nonexistent/path/xyz123", llm: false });
  assert.equal(result.verdict, "hold");
  assert.equal(result.exitCode, 0);
  assert.ok(result.actions.some((a) => a.type === "investigate"));
});

// ---- guard: LLM cannot approve when there are blocking findings ----
// We simulate this by checking that the deterministic plan blocks
// (the guard is applied to LLM output, but the deterministic path
// also enforces the same rule).

test("guard: high finding + clean audit → block (not approve)", async () => {
  const plan = await orchestrate({
    manifest: NO_MANIFEST,
    state: { gate: BLOCKED_GATE, audit: { record: CLEAN_AUDIT } },
  });
  assert.equal(plan.verdict, "block");
  assert.equal(plan.confidence, 100);
});
