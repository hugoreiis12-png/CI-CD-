// Regressions for the audit findings S1–S8: each test reproduces a confirmed bypass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { runGate } from "../src/gate/run.mjs";
import { parsePatch } from "../src/gate/staged.mjs";
import { isTestPath } from "../src/gate/checks/test-path.mjs";
import { installHook } from "../src/adapters/precommit.mjs";
import { renderWorkflow } from "../src/adapters/workflows.mjs";

const KEY = "AKIAIOSFODNN7ABCDEFG";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo(files = { "README": "x\n" }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-sec-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  for (const [rel, body] of Object.entries({ ".gitignore": ".esteira/\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init", "--no-verify");
  return dir;
}

const stageAndGate = (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
  git(dir, "add", "-A");
  return runGate({ root: dir, json: true });
};

test("S2: 'test' inside a directory or file name is not a test path", () => {
  for (const p of ["src/latest/cfg.js", "contest.js", "src/attestation.mjs", "protest/x.ts"]) {
    assert.equal(isTestPath(p), false, p);
  }
  for (const p of ["test/a.js", "src/__tests__/a.ts", "a.test.ts", "b.spec.js", "fixtures/k.json", "pkg/x_test.go", "test_api.py"]) {
    assert.equal(isTestPath(p), true, p);
  }
  const run = stageAndGate(repo(), "src/latest/cfg.js", `const k = "${KEY}";\n`);
  assert.equal(run.verdict, "reproved");
});

test("S3: a placeholder word elsewhere on the line does not exempt a real key", () => {
  const run = stageAndGate(repo(), "app.js", `const k = "${KEY}"; // todo rotate <later>\n`);
  assert.ok(run.findings.some((f) => f.rule === "secret-aws"));
  const ok = stageAndGate(repo(), "app.js", 'const apiKey = "<your-api-key-here>";\n');
  assert.equal(ok.findings.filter((f) => f.check === "secrets").length, 0);
});

test("S4: a secret added to a renamed file is caught", () => {
  const body = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
  const dir = repo({ "old.js": body });
  git(dir, "mv", "old.js", "new.js");
  const run = stageAndGate(dir, "new.js", `${body}const k = "${KEY}";\n`);
  assert.ok(run.findings.some((f) => f.rule === "secret-aws" && f.file === "new.js"), JSON.stringify(run.findings));
});

test("S8 + line numbers: '++' content is kept and lines are real file lines", () => {
  const patch = [
    "diff --git a/a.js b/a.js", "--- a/a.js", "+++ b/a.js",
    "@@ -9,0 +10,2 @@", "+++token", "+ok",
  ].join("\n");
  const [file] = parsePatch(patch);
  assert.deepEqual(file.added, ["++token", "ok"]);
  assert.deepEqual(file.addedLines, [10, 11]);

  const dir = repo({ "app.js": "a\nb\nc\nd\n" });
  const run = stageAndGate(dir, "app.js", `a\nb\nc\nd\nconst k = "${KEY}";\n`);
  assert.equal(run.findings.find((f) => f.rule === "secret-aws").line, 5);
});

const hookRun = (dir, hook, env = {}) => spawnSync("sh", [path.join(dir, ".esteira/hooks", hook)], {
  cwd: dir, encoding: "utf8", input: "",
  env: { PATH: "/usr/bin:/bin", HOME: os.tmpdir(), ...env },
});

test("S6: hooks fail closed without a gate CLI and never run repo code", () => {
  const dir = repo({ "cli/src/index.mjs": "process.exit(0)\n" });
  installHook(dir, { cli: "/nonexistent/esteira/index.mjs" });
  const hook = fs.readFileSync(path.join(dir, ".esteira/hooks/pre-commit"), "utf8");
  assert.doesNotMatch(hook, /\$ROOT\/cli\/src\/index\.mjs/);
  assert.equal(hookRun(dir, "pre-commit").status, 1);
  assert.equal(hookRun(dir, "pre-push").status, 1);
  assert.equal(hookRun(dir, "pre-commit", { ESTEIRA_ALLOW_UNGATED: "1" }).status, 0);
});

test("S7: a previous hooks dir is chained, and re-init never chains to itself", () => {
  const dir = repo();
  fs.mkdirSync(path.join(dir, ".husky"));
  fs.writeFileSync(path.join(dir, ".husky/pre-commit"), "#!/bin/sh\necho husky-ran\nexit 3\n", { mode: 0o755 });
  git(dir, "config", "core.hooksPath", ".husky");
  const res = installHook(dir, { cli: "/nonexistent" });
  assert.equal(res.previousHooksPath, ".husky");
  installHook(dir, { cli: "/nonexistent" });
  const hook = fs.readFileSync(path.join(dir, ".esteira/hooks/pre-commit"), "utf8");
  assert.match(hook, /ESTEIRA_PREV_HOOKS='.*\/\.husky'/);
  const out = hookRun(dir, "pre-commit", { ESTEIRA_ALLOW_UNGATED: "1" });
  assert.equal(out.status, 3);
  assert.match(out.stdout, /husky-ran/);
});

test("S1/S5: generated CI runs the real gate on the change set", () => {
  const wf = renderWorkflow({ languages: [], commands: {} });
  assert.doesNotMatch(wf, /placeholder \(M2\)/);
  assert.match(wf, /git reset --soft "\$BASE_SHA"/);
  assert.match(wf, /run: gh esteira gate/);
  assert.match(wf, /fetch-depth: 0/);
});
