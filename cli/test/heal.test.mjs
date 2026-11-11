// `gh esteira heal`: the fix is written only when the project's own checks pass
// with it applied. Covered: the proposal contract, the classification, the
// verification snapshot, and the end-to-end paths (applied, rejected, dry-run).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { parseProposal, MAX_FILES } from "../src/heal/proposal.mjs";
import { classify } from "../src/heal/evidence.mjs";
import { verifyProposal } from "../src/heal/verify.mjs";
import { runHeal, renderHeal } from "../src/heal/run.mjs";
import { checkConflictMarkers } from "../src/gate/checks/conflicts.mjs";

const conflictsCheck = (files) => checkConflictMarkers({ root: "", files, config: {} });

process.env.ESTEIRA_LLM_ENABLED = "false";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const write = (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

// A tiny project whose own `npm test` passes only when fix.txt says FIXED.
function project({ gateFinding = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-heal-"));
  git(dir, "init", "-q", "-b", "main");
  write(dir, "package.json", JSON.stringify({ name: "fx", version: "1.0.0", scripts: { test: "node check.mjs" } }));
  write(dir, "check.mjs", 'import fs from "node:fs";\nprocess.exit(fs.existsSync("fix.txt") && fs.readFileSync("fix.txt", "utf8") === "FIXED" ? 0 : 1);\n');
  write(dir, ".esteira/project.json", JSON.stringify({
    schemaVersion: 1, llm: { enabled: true, endpoint: "http://hermes.test", model: "hermes3:8b", timeoutMs: 5000 },
  }));
  if (gateFinding) {
    write(dir, ".esteira/runs/0001.json", JSON.stringify({
      verdict: "reproved",
      findings: [{ check: "patterns", severity: "high", rule: "dangerous-eval", file: "check.mjs", line: 1, message: "eval" }],
    }));
  }
  return dir;
}

/** Fake Ollama /api/generate returning `payload` as the model's text. */
const fakeHermes = (payload) => async () => ({ ok: true, status: 200, json: async () => ({ response: payload }) });
const proposal = (files, diagnosis = "faltava o arquivo de verificação") => JSON.stringify({ diagnosis, files });

test("parseProposal accepts a safe proposal and rejects every malformed one", () => {
  const root = "/tmp/proj";
  const ok = parseProposal(proposal([{ path: "src/a.js", content: "x" }]), root);
  assert.deepEqual(ok?.files, [{ path: "src/a.js", content: "x" }]);
  assert.equal(parseProposal("sem json aqui", root), null);
  assert.equal(parseProposal(proposal([{ path: "../fora.js", content: "x" }]), root), null);
  assert.equal(parseProposal(proposal([{ path: ".esteira/project.json", content: "{}" }]), root), null);
  assert.equal(parseProposal(proposal([{ path: "a.js" }]), root), null);
  assert.equal(parseProposal(proposal([]), root), null);
  const tooMany = Array.from({ length: MAX_FILES + 1 }, (_, i) => ({ path: `f${i}.js`, content: "x" }));
  assert.equal(parseProposal(proposal(tooMany), root), null);
});

test("parseProposal tolerates prose around the JSON object", () => {
  const text = `Aqui está:\n${proposal([{ path: "a.js", content: "1" }])}\nfim`;
  assert.equal(parseProposal(text, "/tmp/proj")?.files.length, 1);
});

test("classify: conflicts first, then a blocked gate, then CI, else nothing", () => {
  assert.equal(classify({ gate: null, conflicts: ["a.js"], ciLog: null }).kind, "merge-conflict");
  assert.equal(
    classify({ gate: { verdict: "reproved", findings: [{ rule: "dangerous-eval" }] }, conflicts: [], ciLog: null }).kind,
    "gate-block",
  );
  assert.equal(classify({ gate: null, conflicts: [], ciLog: "...erro..." }).kind, "ci-failure");
  assert.equal(classify({ gate: null, conflicts: [], ciLog: "sem run com falha ()" }).kind, "none");
  assert.equal(classify({ gate: { verdict: "approved", findings: [] }, conflicts: [], ciLog: null }).kind, "none");
});

test("verifyProposal passes only when the proposed files make the commands exit 0", () => {
  const dir = project();
  const cmd = [{ key: "test", cmd: "node check.mjs" }];
  const bad = verifyProposal({ root: dir, files: [{ path: "fix.txt", content: "NOPE" }], commands: cmd });
  assert.equal(bad.ok, false);
  assert.equal(bad.results[0].code, 1);
  const good = verifyProposal({ root: dir, files: [{ path: "fix.txt", content: "FIXED" }], commands: cmd });
  assert.equal(good.ok, true);
  assert.equal(fs.existsSync(path.join(dir, "fix.txt")), false, "verification never writes to the working tree");
});

test("verifyProposal sees uncommitted working-tree changes, not only HEAD", () => {
  const dir = project();
  write(dir, "fix.txt", "FIXED"); // untracked, not committed
  const result = verifyProposal({ root: dir, files: [], commands: [{ key: "test", cmd: "node check.mjs" }] });
  assert.equal(result.ok, true);
});

test("runHeal applies a verified fix to the working tree, records it, and stages nothing", async () => {
  const dir = project();
  const outcome = await runHeal({ root: dir, fetchImpl: fakeHermes(proposal([{ path: "fix.txt", content: "FIXED" }])) });
  assert.equal(outcome.status, "applied");
  assert.equal(outcome.kind, "gate-block");
  assert.equal(fs.readFileSync(path.join(dir, "fix.txt"), "utf8"), "FIXED");
  assert.equal(git(dir, "diff", "--cached", "--name-only"), "", "nothing is staged");
  assert.ok(fs.readdirSync(path.join(dir, ".esteira", "heals")).length === 1, "the heal is recorded");
  assert.match(renderHeal(outcome), /Nada foi commitado/);
});

test("runHeal rejects a fix that breaks the checks and leaves the working tree as it was", async () => {
  const dir = project();
  const outcome = await runHeal({ root: dir, fetchImpl: fakeHermes(proposal([{ path: "fix.txt", content: "WRONG" }])) });
  assert.equal(outcome.status, "rejected");
  assert.equal(fs.existsSync(path.join(dir, "fix.txt")), false);
  assert.match(renderHeal(outcome), /REJEITADA/);
});

test("runHeal dry-run verifies and writes nothing", async () => {
  const dir = project();
  const outcome = await runHeal({ root: dir, dryRun: true, fetchImpl: fakeHermes(proposal([{ path: "fix.txt", content: "FIXED" }])) });
  assert.equal(outcome.status, "verified");
  assert.equal(fs.existsSync(path.join(dir, "fix.txt")), false);
});

test("runHeal refuses to change anything without a verification command", async () => {
  const dir = project();
  write(dir, "package.json", JSON.stringify({ name: "fx", version: "1.0.0" }));
  const outcome = await runHeal({ root: dir, fetchImpl: fakeHermes(proposal([{ path: "fix.txt", content: "FIXED" }])) });
  assert.equal(outcome.status, "unverifiable");
  assert.equal(fs.existsSync(path.join(dir, "fix.txt")), false);
});

test("runHeal with nothing wrong says so and calls no model", async () => {
  const dir = project({ gateFinding: false });
  let called = false;
  const outcome = await runHeal({ root: dir, fetchImpl: async () => { called = true; return { ok: false }; } });
  assert.equal(outcome.status, "nothing");
  assert.equal(called, false);
});

test("runHeal survives an invalid model reply without touching the tree", async () => {
  const dir = project();
  const outcome = await runHeal({ root: dir, fetchImpl: fakeHermes("não sei") });
  assert.equal(outcome.status, "invalid-proposal");
  assert.equal(fs.existsSync(path.join(dir, "fix.txt")), false);
});

test("the merge-conflict check blocks committed markers but not a lone '=======' underline", () => {
  const marked = conflictsCheck([{ path: "a.js", added: ["<<<<<<< HEAD", "x", "=======", "y", ">>>>>>> feature"] }]);
  assert.deepEqual(marked.map((f) => f.rule), ["merge-conflict-marker"]);
  const underline = conflictsCheck([{ path: "README.md", added: ["Título", "=======", "texto"] }]);
  assert.equal(underline.length, 0);
});
