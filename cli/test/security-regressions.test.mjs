// Regressions for the audit findings S1–S8: each test reproduces a confirmed bypass.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

// Disable the Hermes LLM: these tests exercise the gate's deterministic
// checks only; the advisory layer is tested in hermes.test.mjs.
process.env.ESTEIRA_LLM_ENABLED = "false";
import { fileURLToPath } from "node:url";
import { runGate } from "../src/gate/run.mjs";
import { verifyAttestation } from "../src/gate/attest.mjs";
import { parsePatch } from "../src/gate/staged.mjs";
import { isTestPath } from "../src/gate/checks/test-path.mjs";
import { installHook } from "../src/adapters/precommit.mjs";
import { renderWorkflow } from "../src/adapters/workflows.mjs";

const KEY = "AKIAIOSFODNN7ABCDEFG";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Resolve a POSIX shell: Git Bash on Windows, plain `sh` on POSIX. */
function hookShell() {
  if (process.platform !== "win32") return "sh";
  const gitBash = "C:\\Program Files\\Git\\usr\\bin\\sh.exe";
  if (fs.existsSync(gitBash)) return gitBash;
  return "sh";
}

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

const stageAndGate = async (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
  git(dir, "add", "-A");
  return await runGate({ root: dir, json: true });
};

test("S2: 'test' inside a directory or file name is not a test path", async () => {
  for (const p of ["src/latest/cfg.js", "contest.js", "src/attestation.mjs", "protest/x.ts"]) {
    assert.equal(isTestPath(p), false, p);
  }
  for (const p of ["test/a.js", "src/__tests__/a.ts", "a.test.ts", "b.spec.js", "fixtures/k.json", "pkg/x_test.go", "test_api.py"]) {
    assert.equal(isTestPath(p), true, p);
  }
  const run = await stageAndGate(repo(), "src/latest/cfg.js", `const k = "${KEY}";\n`);
  assert.equal(run.verdict, "reproved");
});

test("S3: a placeholder word elsewhere on the line does not exempt a real key", async () => {
  const run = await stageAndGate(repo(), "app.js", `const k = "${KEY}"; // todo rotate <later>\n`);
  assert.ok(run.findings.some((f) => f.rule === "secret-aws"));
  const ok = await stageAndGate(repo(), "app.js", 'const apiKey = "<your-api-key-here>";\n');
  assert.equal(ok.findings.filter((f) => f.check === "secrets").length, 0);
});

test("S4: a secret added to a renamed file is caught", async () => {
  const body = Array.from({ length: 30 }, (_, i) => `const v${i} = ${i};`).join("\n") + "\n";
  const dir = repo({ "old.js": body });
  git(dir, "mv", "old.js", "new.js");
  const run = await stageAndGate(dir, "new.js", `${body}const k = "${KEY}";\n`);
  assert.ok(run.findings.some((f) => f.rule === "secret-aws" && f.file === "new.js"), JSON.stringify(run.findings));
});

test("S8 + line numbers: '++' content is kept and lines are real file lines", async () => {
  const patch = [
    "diff --git a/a.js b/a.js", "--- a/a.js", "+++ b/a.js",
    "@@ -9,0 +10,2 @@", "+++token", "+ok",
  ].join("\n");
  const [file] = parsePatch(patch);
  assert.deepEqual(file.added, ["++token", "ok"]);
  assert.deepEqual(file.addedLines, [10, 11]);

  const dir = repo({ "app.js": "a\nb\nc\nd\n" });
  const run = await stageAndGate(dir, "app.js", `a\nb\nc\nd\nconst k = "${KEY}";\n`);
  assert.equal(run.findings.find((f) => f.rule === "secret-aws").line, 5);
});

const hookRun = (dir, hook, env = {}) => spawnSync(hookShell(), [path.join(dir, ".esteira/hooks", hook)], {
  cwd: dir, encoding: "utf8", input: "",
  env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: os.tmpdir(), ...env },
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
  assert.match(hook, /ESTEIRA_PREV_HOOKS='.*[\\/]\.husky'/);
  const out = hookRun(dir, "pre-commit", { ESTEIRA_ALLOW_UNGATED: "1" });
  assert.equal(out.status, 3);
  assert.match(out.stdout, /husky-ran/);
});

test("S1/S5: generated CI runs the real gate on the change set", () => {
  const wf = renderWorkflow({ languages: [], commands: {} });
  assert.doesNotMatch(wf, /placeholder \(M2\)/);
  assert.match(wf, /git reset --soft "\$BASE_SHA"/);
  assert.match(wf, /run: node "\$ESTEIRA" gate --policy-ref "\$BASE_SHA"/);
  assert.match(wf, /ESTEIRA_REPO: hugoreiis12-png\/gh-esteira/);
  assert.doesNotMatch(wf, /gh extension install|REPLACE-ME\/gh-esteira|\|\| true/);
  assert.match(wf, /fetch-depth: 0/);
});

// Sprint 1 — Cloudflare-skill audit run-1 leads 1–4, the tracked-hooks bug and the playground archive cap.

test("lead 1: an unreadable change set fails closed instead of approving", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-nogit-"));
  const run = await runGate({ root: dir, json: true });
  assert.equal(run.verdict, "reproved");
  assert.equal(run.exitCode, 1);
  assert.equal(run.findings[0].rule, "gate-read-error");
});

test("lead 2: with --policy-ref the PR's own manifest cannot relax the gate", async () => {
  const dir = repo({ ".esteira/project.json": JSON.stringify({ gate: { mode: "block" } }) });
  const base = git(dir, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(dir, ".esteira/project.json"), JSON.stringify({ gate: { mode: "audit", playground: { enabled: false } } }));
  fs.writeFileSync(path.join(dir, "app.js"), `const k = "${KEY}";\n`);
  git(dir, "add", "-A");
  assert.equal((await runGate({ root: dir, json: true, policyRef: base })).verdict, "reproved");
  assert.equal((await runGate({ root: dir, json: true })).verdict, "approved", "local mode still honours the working-tree manifest");
  assert.equal((await runGate({ root: dir, json: true, policyRef: "not-a-ref" })).findings[0].rule, "gate-policy-error");
});

test("lead 2: unknown blockAt/mode values block instead of disabling the gate", async () => {
  const dir = repo({ ".esteira/project.json": JSON.stringify({ gate: { blockAt: "none", mode: "off" } }) });
  const run = await stageAndGate(dir, "README", "clean change\n");
  assert.equal(run.verdict, "reproved");
  assert.equal(run.findings.filter((f) => f.rule === "gate-policy-invalid").length, 2);
});

test("lead 3: .gitattributes '-diff' does not hide added lines", async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, ".gitattributes"), "* -diff\n");
  const run = await stageAndGate(dir, "leak.js", `const k = "${KEY}";\n`);
  assert.ok(run.findings.some((f) => f.rule === "secret-aws" && f.file === "leak.js"), JSON.stringify(run.findings));
});

test("lead 4: quoted (non-ASCII) names and names containing ' b/' are scanned", async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "é.js"), `const k = "${KEY}";\n`);
  fs.mkdirSync(path.join(dir, "deploy b"));
  const run = await stageAndGate(dir, "deploy b/run.js", `const k = "${KEY}";\n`);
  const files = run.findings.filter((f) => f.rule === "secret-aws").map((f) => f.file).sort();
  assert.deepEqual(files, ["deploy b/run.js", "é.js"]);
});

test("hooks bug: init keeps .esteira/hooks/ out of git", async () => {
  const { runInit } = await import("../src/commands/init.mjs");
  const dir = repo();
  runInit({ root: dir, quiet: true });
  assert.match(fs.readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\.esteira\/hooks\/$/m);
  assert.equal(git(dir, "status", "--porcelain", "--", ".esteira/hooks"), "");
});

test("playground extracts repos larger than the old 1 MiB stdout cap", async () => {
  const dir = repo({
    ".esteira/project.json": JSON.stringify({ profile: { commands: { test: "node -e process.exit(0)" } } }),
    "big.txt": "x".repeat(2 * 1024 * 1024),
  });
  const run = await stageAndGate(dir, "README", "change\n");
  assert.ok(!run.findings.some((f) => f.rule === "playground-error"), JSON.stringify(run.findings));
  assert.equal(run.verdict, "approved");
});

test("Q1: gate --json and attest --json print machine-readable output", () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "README"), "changed\n");
  git(dir, "add", "-A");
  const cli = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  const gate = spawnSync(process.execPath, [cli, "gate", "--json", "--dir", dir], { encoding: "utf8" });
  assert.equal(JSON.parse(gate.stdout).verdict, "approved");
  const attest = spawnSync(process.execPath, [cli, "attest", "--verify", "--json", "--dir", dir], { encoding: "utf8" });
  assert.equal(typeof JSON.parse(attest.stdout).ok, "boolean");
});

// v0.1.3 — field report (umbrella folder with embedded repositories).

function embeddedRepo(dir) {
  const inner = path.join(dir, "inner");
  fs.mkdirSync(inner);
  git(inner, "init", "-q");
  git(inner, "config", "user.email", "t@t");
  git(inner, "config", "user.name", "t");
  fs.writeFileSync(path.join(inner, "a"), "a\n");
  git(inner, "add", "-A");
  git(inner, "commit", "-qm", "inner", "--no-verify");
}

test("gitlinks (embedded repos) do not break the gate; secrets beside them are still caught", async () => {
  const dir = repo();
  embeddedRepo(dir);
  fs.writeFileSync(path.join(dir, "leak.js"), `const k = "${KEY}";\n`);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" }); // git warns about the embedded repo
  const run = await runGate({ root: dir, json: true });
  const rules = run.findings.map((f) => f.rule);
  assert.ok(!rules.includes("gate-read-error"), JSON.stringify(run.findings));
  assert.ok(rules.includes("secret-aws"));
  assert.ok(run.findings.some((f) => f.rule === "submodule-not-scanned" && f.file === "inner" && f.severity === "low"));
});

test("git's own stderr does not leak into the gate output", () => {
  const dir = repo();
  embeddedRepo(dir);
  execFileSync("git", ["add", "-A"], { cwd: dir, stdio: "ignore" });
  const cli = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  const out = spawnSync(process.execPath, [cli, "gate", "--dir", dir], { encoding: "utf8" });
  assert.doesNotMatch(out.stderr, /fatal:/);
  assert.match(out.stdout, /Veredito/);
});

test("gate --head attests a root commit made without pre-commit, unblocking the push", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-head-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".esteira/\n");
  fs.writeFileSync(path.join(dir, "nota.txt"), "x\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "root", "--no-verify");
  assert.equal(verifyAttestation({ root: dir, json: true }).ok, false);
  const run = await runGate({ root: dir, json: true, head: true });
  assert.equal(run.verdict, "approved");
  assert.equal(run.stats.files, 2);
  assert.equal(verifyAttestation({ root: dir, json: true }).ok, true);
});

test("gate --head judges the last commit's content and refuses a dirty index", async () => {
  const dir = repo();
  fs.writeFileSync(path.join(dir, "leak.js"), `const k = "${KEY}";\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "leak", "--no-verify");
  assert.equal((await runGate({ root: dir, json: true, head: true })).verdict, "reproved");
  fs.writeFileSync(path.join(dir, "other.txt"), "y\n");
  git(dir, "add", "other.txt");
  const dirty = await runGate({ root: dir, json: true, head: true });
  assert.equal(dirty.findings[0].rule, "gate-read-error");
  assert.match(dirty.findings[0].message, /--head/);
});

test("human output is pt-BR", () => {
  const cli = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  const help = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8" }).stdout;
  assert.match(help, /^Uso:/m);
  const unknown = spawnSync(process.execPath, [cli, "nope"], { encoding: "utf8" }).stderr;
  assert.match(unknown, /comando desconhecido/);
  const dir = repo();
  const analyze = spawnSync(process.execPath, [cli, "analyze", "--dir", dir], { encoding: "utf8" }).stdout;
  assert.match(analyze, /análise do projeto/);
  assert.match(analyze, /Linguagens/);
});

test("hooks prefer the gh-managed extension over a gh-esteira found on PATH", () => {
  const dir = repo();
  installHook(dir, { cli: "/nonexistent" });
  const hook = fs.readFileSync(path.join(dir, ".esteira/hooks/pre-commit"), "utf8");
  assert.ok(hook.indexOf('[ -f "$ESTEIRA_CLI" ]') < hook.indexOf("gh extension list"), "the CLI that ran init comes first");
  assert.ok(hook.indexOf("gh extension list") < hook.indexOf("command -v gh-esteira"), "a gh-esteira on PATH comes last");
});

test("help: every CLI command is documented; help <cmd>, --help and help manual work", async () => {
  const { COMMANDS } = await import("../src/commands/help.mjs");
  const src = fs.readFileSync(fileURLToPath(new URL("../src/index.mjs", import.meta.url)), "utf8");
  const cases = [...src.matchAll(/case "([a-z]+)":/g)].map((m) => m[1]);
  for (const c of cases) assert.ok(COMMANDS[c], `command ${c} has no help entry`);
  const cli = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
  assert.match(run("help").stdout, /Comandos:/);
  assert.match(run("help", "gate").stdout, /--head/);
  assert.equal(run("gate", "--help").stdout, run("help", "gate").stdout);
  assert.match(run("help", "manual").stdout, /# Manual do usuário/);
  assert.equal(run("help", "nope").status, 1);
});
