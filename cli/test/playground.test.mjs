import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runInit } from "../src/commands/init.mjs";
import { runGate } from "../src/gate/run.mjs";
import { verifyAttestation } from "../src/gate/attest.mjs";
import { countFailures } from "../src/playground/runner.mjs";

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function tryGit(cwd, args) {
  try {
    return {
      status: 0,
      out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }),
    };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function write(dir, rel, content) {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

/** Node test-suite project: src/calc.js + tests/calc.test.js (assert add(1,1)===2). */
function nodeProject() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-play-"));
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  git(dir, ["config", "user.email", "gate@test"]);
  git(dir, ["config", "user.name", "gate"]);
  write(dir, ".gitignore", ".esteira/runs/\n");
  write(dir, "package.json", JSON.stringify({
    name: "svc", scripts: { test: "node --test tests/calc.test.js" },
  }));
  write(dir, "src/calc.js", "function add(a, b) { return a + b; }\nmodule.exports = { add };\n");
  write(dir, "tests/calc.test.js", [
    "const test = require('node:test');",
    "const assert = require('node:assert');",
    "const calc = require('../src/calc.js');",
    "test('add matches the contract', () => { assert.equal(calc.add(1, 1), 2); assert.ok(calc.add(2, 2) === 4); });",
  ].join("\n"));
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

test("countFailures parses numeric summaries before FAIL markers", () => {
  assert.equal(countFailures("Tests: 2 failed, 5 passed"), 2);
  assert.equal(countFailures("failures: 1"), 1);
  assert.equal(countFailures("failures: 0"), 0);
  assert.equal(countFailures("--- FAIL: TestAlpha\n--- FAIL: TestBeta"), 2);
});

test("playground approves a suite that still passes (no regression)", () => {
  const dir = nodeProject();
  runInit({ root: dir, quiet: true });
  write(dir, "src/calc.js", "function add(a, b) { return a + b; }\nmodule.exports = { add };\n// tidy comment\n");
  git(dir, ["add", "."]);

  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "approved");
  assert.equal(run.exitCode, 0);
  assert.equal(run.playground.ran, true);
  assert.ok(run.playground.results.some((r) => r.stage === "suite" && r.code === 0));
  assert.equal(run.attested, true);
  assert.match(run.tree, /^[0-9a-f]{64}$/);          // full-index attestation id
  assert.ok(run.snapshot !== run.tree);              // changed-set vs full index
});

test("playground blocks a regression (suite fails where HEAD was clean)", () => {
  const dir = nodeProject();
  runInit({ root: dir, quiet: true });
  write(dir, "src/calc.js", "function add(a, b) { return a - b; }\nmodule.exports = { add };\n");
  git(dir, ["add", "."]);

  const run = runGate({ root: dir, json: true });
  const rules = run.findings.map((f) => f.rule);
  assert.ok(rules.includes("suite-failure"), rules.join(","));
  assert.equal(run.findings.find((f) => f.rule === "suite-failure").severity, "high");
  assert.equal(run.verdict, "reproved");
  assert.equal(run.exitCode, 1);
});

test("typecheck gate blocks when the type command fails on the staged snapshot", () => {
  const dir = nodeProject();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.scripts.typecheck = "node -e 'process.exit(1)'";
  write(dir, "package.json", JSON.stringify(pkg, null, 2));
  runInit({ root: dir, quiet: true });
  write(dir, "src/calc.js", "/* comment change */\n".concat(fs.readFileSync(path.join(dir, "src/calc.js"), "utf8")));
  git(dir, ["add", "."]);

  const run = runGate({ root: dir, json: true });
  const findings = run.findings.filter((f) => f.rule === "playground-typecheck");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].severity, "medium");
  assert.equal(run.verdict, "reproved");
});

test("playground timeout is a blocking high finding", () => {
  const dir = nodeProject();
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
  pkg.scripts.typecheck = "sleep 5"; // exceeds the playground budget on both runs
  write(dir, "package.json", JSON.stringify(pkg, null, 2));
  runInit({ root: dir, quiet: true });

  // shrink the playground budget after init (init preserves user gate config)
  const manifestPath = path.join(dir, ".esteira/project.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  manifest.gate.playground = { enabled: true, timeoutMs: 300 };
  write(dir, ".esteira/project.json", JSON.stringify(manifest, null, 2));

  write(dir, "src/calc.js", "/* comment */\n".concat(fs.readFileSync(path.join(dir, "src/calc.js"), "utf8")));
  git(dir, ["add", "."]);

  const run = runGate({ root: dir, json: true });
  const rules = run.findings.map((f) => f.rule);
  assert.ok(rules.includes("playground-timeout"), rules.join(","));
  assert.equal(run.verdict, "reproved");
}, 20000);

test("attestation: attested HEAD pushes; a --no-verify bypassed commit does not", () => {
  const dir = nodeProject();
  runInit({ root: dir, quiet: true });

  // gate → approved run records full-index tree
  write(dir, "src/calc.js", "// tweak\n".concat(fs.readFileSync(path.join(dir, "src/calc.js"), "utf8")));
  git(dir, ["add", "."]);
  const gated = tryGit(dir, ["commit", "-m", "gated"]);
  assert.equal(gated.status, 0, gated.out);
  const first = verifyAttestation({ root: dir, json: true });
  assert.equal(first.ok, true, first.message);

  // bypass: commit without hook (--no-verify) → HEAD tree unattested
  write(dir, "src/calc.js", "// bypass tweak\n".concat(fs.readFileSync(path.join(dir, "src/calc.js"), "utf8")));
  git(dir, ["add", "."]);
  const bypass = tryGit(dir, ["commit", "--no-verify", "-m", "bypass"]);
  assert.equal(bypass.status, 0, bypass.out);
  const blocked = verifyAttestation({ root: dir, json: true });
  assert.equal(blocked.ok, false);
  assert.equal(blocked.exitCode, 1);
  assert.match(blocked.message, /BLOQUEADO/);

  // re-staged identical content re-attests (idempotent) — System of the record
  write(dir, "src/calc.js", "// tweak\n".concat("function add(a, b) { return a + b; }\nmodule.exports = { add };\n"));
  git(dir, ["add", "."]);
  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "approved");
  const attested = verifyAttestation({ root: dir, json: true });
  // HEAD is still the bypass commit content, so nothing attested yet — correct strictness.
  assert.equal(attested.ok, false);
});
