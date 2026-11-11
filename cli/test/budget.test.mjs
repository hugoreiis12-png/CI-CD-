// The time budget of a question: simple ones keep the configured 60 s, analyses get up to 10 min.
import { test } from "node:test";
import assert from "node:assert/strict";
import { budgetFor, isComplexQuestion, COMPLEX_TIMEOUT_MS } from "../src/agent/budget.mjs";
import { READ_ONLY_TOOLS } from "../src/agent/tools.mjs";
import { runTurn } from "../src/agent/turn.mjs";

const SIMPLE_MS = 60_000;

test("a greeting or a short factual question keeps the simple budget (60 s)", () => {
  assert.equal(isComplexQuestion("Ola voce esta ai ?"), false);
  assert.equal(budgetFor("qual é a branch atual?", SIMPLE_MS), SIMPLE_MS);
});

test("an analysis of the local and remote project gets the complex budget (10 min)", () => {
  const question = "Consegue analisar meu projeto local e meu remoto e ve se esta tudo de acordo ?";
  assert.equal(isComplexQuestion(question), true);
  assert.equal(budgetFor(question, SIMPLE_MS), COMPLEX_TIMEOUT_MS);
});

test("a long question is complex even without an analysis keyword", () => {
  assert.equal(isComplexQuestion("x".repeat(101)), true);
});

test("a configured simple budget above 10 min is never cut down", () => {
  assert.equal(budgetFor("oi", 900_000), 900_000);
});

test("runTurn passes the question's budget to every model call of the turn", async () => {
  const seen = [];
  const replies = [
    { status: "ok", text: 'TOOL: {"name":"git_status","args":{}}', error: null },
    { status: "ok", text: "pronto", error: null },
  ];
  await runTurn({
    system: "s", history: [], question: "analise tudo", tools: READ_ONLY_TOOLS, ctx: { root: "/tmp" },
    timeoutMs: COMPLEX_TIMEOUT_MS,
    chatFn: async (_messages, timeoutMs) => { seen.push(timeoutMs); return replies.shift(); },
  });
  assert.deepEqual(seen, [COMPLEX_TIMEOUT_MS, COMPLEX_TIMEOUT_MS]);
});
