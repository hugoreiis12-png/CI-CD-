// Hermes (LLM) advisory layer: the Ollama /api/generate transport and the
// gate/audit parecer builders. The LLM is advisory only — every failure mode
// degrades (null advisory, or { error }) and never blocks the pipeline.
import { test } from "node:test";
import assert from "node:assert/strict";
import { generate } from "../src/hermes/adapter.mjs";
import { resolveLlmSettings } from "../src/hermes/config.mjs";
import { gateAdvisory, auditAdvisory } from "../src/hermes/advisory.mjs";

/** A fake Ollama /api/generate endpoint. Returns a canned response body. */
function fakeFetch(body, { status = 200, calls } = { status: 200 }) {
  const calls_ = calls ?? { count: 0 };
  return async (url, init) => {
    calls_.count += 1;
    calls_.lastUrl = url;
    calls_.lastInit = init;
    if (body instanceof Error) throw body;
    return { ok: status < 400, status, json: async () => body };
  };
}

const SETTINGS = { endpoint: "http://ollama.test:11434", model: "hermes3:8b", timeoutMs: 60_000 };

test("generate: happy path returns the model's response text", async () => {
  const calls = { count: 0 };
  const fetchImpl = fakeFetch({ model: "hermes3:8b", done: true, response: "  Parecer: risco baixo. " }, { calls });
  const result = await generate({ settings: SETTINGS, prompt: "analise", fetchImpl, timeoutMs: 100 });
  assert.equal(result.status, "ok");
  assert.equal(result.text, "Parecer: risco baixo.");
  assert.equal(result.error, null);
  assert.ok(result.ms >= 0);
  // The adapter posts to {endpoint}/api/generate with stream:false.
  assert.equal(calls.count, 1);
  assert.match(calls.lastUrl, /\/api\/generate$/);
  const body = JSON.parse(calls.lastInit.body);
  assert.deepEqual(body, { model: "hermes3:8b", prompt: "analise", stream: false });
});

test("generate: endpoint null short-circuits to skipped with zero network traffic", async () => {
  const calls = { count: 0 };
  const result = await generate({
    settings: { ...SETTINGS, endpoint: null },
    prompt: "x",
    fetchImpl: fakeFetch({}, { calls }),
  });
  assert.deepEqual(result, { status: "skipped", text: "", ms: result.ms, error: null });
  assert.equal(calls.count, 0, "no round trip when disabled");
});

test("generate: HTTP error degrades to error (never throws)", async () => {
  const fetchImpl = fakeFetch({ error: "boom" }, { status: 503 });
  const result = await generate({ settings: SETTINGS, prompt: "x", fetchImpl, timeoutMs: 100 });
  assert.equal(result.status, "error");
  assert.equal(result.error, "HTTP 503");
  assert.equal(result.text, "");
});

test("generate: transport exception degrades to error with a short message", async () => {
  const fetchImpl = fakeFetch(new Error("ECONNREFUSED 192.168.0.140:11434\nsecond line"));
  const result = await generate({ settings: SETTINGS, prompt: "x", fetchImpl, timeoutMs: 100 });
  assert.equal(result.status, "error");
  assert.equal(result.error, "ECONNREFUSED 192.168.0.140:11434");
});

test("generate: empty response body is an error, not ok", async () => {
  const result = await generate({ settings: SETTINGS, prompt: "x", fetchImpl: fakeFetch({ response: "  " }), timeoutMs: 100 });
  assert.equal(result.status, "error");
  assert.equal(result.error, "resposta vazia");
});

test("generate: timeoutMs falls back to the settings value", async () => {
  // A fetch that aborts on its own simulates the signal firing; we only assert
  // the code path: AbortSignal.timeout is used (the fake receives a signal).
  const calls = { count: 0 };
  const fetchImpl = fakeFetch({ response: "ok" }, { calls });
  await generate({ settings: { ...SETTINGS, timeoutMs: 42 }, prompt: "x", fetchImpl });
  assert.ok(calls.lastInit.signal instanceof AbortSignal);
});

const manifestWithLlm = (llm) => (llm === undefined ? null : { llm });

test("gateAdvisory: disabled LLM (no endpoint) returns null, no network", async () => {
  const calls = { count: 0 };
  const result = await gateAdvisory({
    root: process.cwd(),
    manifest: { llm: { enabled: false } },
    config: { mode: "block", blockAt: "medium" },
    verdict: "approved",
    findings: [],
    files: [{ path: "a.js", insertions: 1, deletions: 0 }],
    fetchImpl: fakeFetch({}, { calls }),
  });
  assert.equal(result, null);
  assert.equal(calls.count, 0);
});

test("gateAdvisory: happy path returns the model + parecer text", async () => {
  const result = await gateAdvisory({
    root: process.cwd(),
    manifest: { llm: { endpoint: "http://ollama.test:11434", model: "hermes3:8b" } },
    config: { mode: "block", blockAt: "medium" },
    verdict: "reproved",
    findings: [{ severity: "high", rule: "secret-aws", file: "a.js", line: 1, message: "chave AWS" }],
    files: [{ path: "a.js", insertions: 1, deletions: 0 }],
    fetchImpl: fakeFetch({ response: "Parecer: remover a chave AWS antes de commitar." }),
  });
  assert.ok(result);
  assert.equal(result.model, "hermes3:8b");
  assert.match(result.text, /chave AWS/);
  assert.equal(result.error, null);
});

test("gateAdvisory: LLM failure degrades to { error }, advisory text empty", async () => {
  const result = await gateAdvisory({
    root: process.cwd(),
    manifest: { llm: { endpoint: "http://ollama.test:11434" } },
    config: { mode: "block", blockAt: "medium" },
    verdict: "approved",
    findings: [],
    files: [{ path: "a.js", insertions: 1, deletions: 0 }],
    fetchImpl: fakeFetch(new Error("down")),
  });
  assert.ok(result);
  assert.equal(result.text, "");
  assert.match(result.error, /down/);
});

const AUDIT_RECORD = {
  verdict: "clean",
  counts: { critical: 0, high: 0, medium: 1, low: 0, unknown: 0 },
  sbom: { total: 1, byEcosystem: { npm: 1 } },
  advisoryCount: 1,
  blockers: 0,
  failOn: "high",
  findings: [
    {
      id: "CVE-2024-1234", ecosystem: "npm", package: "lodash", version: "4.17.21",
      severity: "medium", summary: "proto pollution", fixed: ["4.17.22"],
    },
  ],
};

test("auditAdvisory: disabled LLM returns null, no network", async () => {
  const calls = { count: 0 };
  const result = await auditAdvisory({
    manifest: { llm: { enabled: false } },
    record: AUDIT_RECORD,
    fetchImpl: fakeFetch({}, { calls }),
  });
  assert.equal(result, null);
  assert.equal(calls.count, 0);
});

test("auditAdvisory: happy path returns model + triage text", async () => {
  const result = await auditAdvisory({
    manifest: { llm: { endpoint: "http://ollama.test:11434", model: "hermes3:8b" } },
    record: AUDIT_RECORD,
    fetchImpl: fakeFetch({ response: "Priorize npm audit fix; lodash pode esperar." }),
  });
  assert.ok(result);
  assert.equal(result.model, "hermes3:8b");
  assert.match(result.text, /npm audit fix/);
});

test("auditAdvisory: LLM failure degrades to { error }", async () => {
  const result = await auditAdvisory({
    manifest: { llm: { endpoint: "http://ollama.test:11434" } },
    record: AUDIT_RECORD,
    fetchImpl: fakeFetch(new Error("offline")),
  });
  assert.ok(result);
  assert.equal(result.text, "");
  assert.match(result.error, /offline/);
});

test("resolveLlmSettings: manifest gate.llm wins over top-level llm", () => {
  const settings = resolveLlmSettings({
    gate: { llm: { endpoint: "http://gate-llm.test", model: "gate-model" } },
    llm: { endpoint: "http://root-llm.test", model: "root-model" },
  });
  assert.equal(settings.endpoint, "http://gate-llm.test");
  assert.equal(settings.model, "gate-model");
});

test("resolveLlmSettings: enabled:false in the winning block nulls the endpoint", () => {
  const settings = resolveLlmSettings({
    gate: { llm: { enabled: false, endpoint: "http://gate-llm.test" } },
    llm: { endpoint: "http://root-llm.test" },
  });
  assert.equal(settings.endpoint, null);
});

test("resolveLlmSettings: non-URL endpoint gets an http:// prefix (never nulled)", () => {
  const settings = resolveLlmSettings({ llm: { endpoint: "192.168.0.140:11434" } });
  assert.equal(settings.endpoint, "http://192.168.0.140:11434");
});

test("resolveLlmSettings: defaults when no manifest and no env", () => {
  const { endpoint, model, timeoutMs } = resolveLlmSettings(null);
  assert.equal(endpoint, "http://192.168.0.140:11434");
  assert.equal(model, "hermes3:8b");
  assert.equal(timeoutMs, 60_000);
});

test("manifestWithLlm helper builds the manifest shape the tests use", () => {
  assert.deepEqual(manifestWithLlm({ endpoint: "http://x" }), { llm: { endpoint: "http://x" } });
  assert.equal(manifestWithLlm(), null);
});
