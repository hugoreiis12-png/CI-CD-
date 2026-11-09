import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runInit } from "../src/commands/init.mjs";
import { runGate } from "../src/gate/run.mjs";
import { snapshot } from "../src/gate/attest.mjs";
import { parsePatch } from "../src/gate/staged.mjs";

const git = (cwd, args) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Runs git, converting a failure into { status, out } instead of throwing. */
function tryGit(cwd, args) {
  try {
    return { status: 0, out: execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }) };
  } catch (error) {
    return { status: error.status ?? 1, out: `${error.stdout ?? ""}${error.stderr ?? ""}` };
  }
}

function repo(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-gate-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
  git(dir, ["config", "user.email", "gate@test"]);
  git(dir, ["config", "user.name", "gate"]);
  git(dir, ["add", "."]);
  git(dir, ["commit", "-q", "-m", "init"]);
  return dir;
}

const edit = (dir, rel, content) => {
  const abs = path.join(dir, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

test("parsePatch collects only added lines", () => {
  const patch = [
    "diff --git a/app.ts b/app.ts",
    "new file mode 100644",
    "index 0000000..e69de29",
    "--- /dev/null",
    "+++ b/app.ts",
    "@@ -0,0 +1,2 @@",
    "+const a = 1;",
    "- this minus-line is a deletion stream, not an added line",
    "+process.exit(0);",
  ].join("\n");
  const parsed = parsePatch(patch);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].path, "app.ts");
  assert.deepEqual(parsed[0].added, ["const a = 1;", "process.exit(0);"]);
});

test("gate approves a clean change and writes a run record", () => {
  const dir = repo({ "src/index.ts": "export const a = 1;\n", ".gitignore": ".esteira/runs/\n" });
  edit(dir, "src/index.ts", "export const a = 2;\nexport const b = a + 1;\n");
  git(dir, ["add", "."]);
  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "approved");
  assert.equal(run.exitCode, 0);
  assert.equal(run.stats.files, 1);
  assert.match(run.snapshot, /^[0-9a-f]{64}$/);
  assert.ok(run.path && fs.existsSync(path.join(dir, run.path)));
});

test("gate blocks secrets staged in code", () => {
  const dir = repo({ "src/index.ts": "export const a = 1;\n", ".gitignore": ".esteira/runs/\n" });
  edit(dir, "src/index.ts", [
    "export const a = 1;",
    'export const aws = "AKIAILLYFL2BBEXAMPLE";',
    'export const slack = "xoxb-1234567890abcdef";',
  ].join("\n"));
  git(dir, ["add", "."]);
  const run = runGate({ root: dir, json: true });
  const rules = run.findings.map((f) => f.rule);
  assert.ok(rules.includes("secret-aws"), rules.join(","));
  assert.ok(rules.includes("secret-slack"), rules.join(","));
  assert.equal(run.verdict, "reproved");
  assert.equal(run.exitCode, 1);
});

test("gate blocks dangerous patterns", () => {
  const dir = repo({ "src/index.ts": "import { exec } from 'node:child_process';\n", ".gitignore": ".esteira/runs/\n" });
  edit(dir, "src/index.ts", [
    "import { exec } from 'node:child_process';",
    "export const run = (cmd: string) => exec('bash ' + cmd);",
  ].join("\n"));
  git(dir, ["add", "."]);
  const run = runGate({ root: dir, json: true });
  assert.ok(run.findings.some((f) => f.rule === "dangerous-child-process"), run.findings.map((f) => f.rule).join(","));
  assert.equal(run.verdict, "reproved");
});

test("test/spec files are exempt from credential heuristics" , () => {
  const dir = repo({ "src/index.test.ts": "export const a = 1;\n", ".gitignore": ".esteira/runs/\n" });
  edit(dir, "src/index.test.ts", 'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123";\n');
  git(dir, ["add", "."]);
  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "approved");
});

test("audit mode reports findings but still approves", () => {
  const dir = repo({
    "src/index.ts": "export const a = 1;\n",
    ".esteira/project.json": JSON.stringify({ gate: { mode: "audit" } }),
    ".gitignore": ".esteira/runs/\n.esteira/project.json\n",
  });
  edit(dir, "src/index.ts", 'export const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ123";\n');
  git(dir, ["add", "."]);
  const run = runGate({ root: dir, json: true });
  assert.equal(run.mode, "audit");
  assert.ok(run.findings.length > 0);
  assert.equal(run.verdict, "approved");
  assert.equal(run.exitCode, 0);
  assert.match(run.note ?? "", /audit/);
});

test("snapshot is content-addressed: same blobs -> same SHA", () => {
  const blobList = (dir) => git(dir, ["ls-files", "-s"]).split("\n").map((l) => {
    const [meta, p] = l.split("\t");
    return { path: p, blob: meta.trim().split(/\s+/)[1] };
  });
  const a = repo({ "x.ts": "const a = 1;\n", "y.ts": "const b = 2;\n" });
  const b = repo({ "x.ts": "const a = 1;\n", "y.ts": "const b = 2;\n" });
  assert.equal(snapshot(blobList(a)).id, snapshot(blobList(b)).id);
});

test("gate with nothing staged approves with a note", () => {
  const dir = repo({ "src/index.ts": "export const a = 1;\n", ".gitignore": ".esteira/runs/\n" });
  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "approved");
  assert.equal(run.stats.files, 0);
  assert.match(run.note, /Nada staged/);
  assert.equal(run.exitCode, 0);
});

test("end-to-end: init then hook blocks a dirty commit and allows a clean one", () => {
  const dir = repo({ "src/index.ts": "export const a = 1;\n", ".gitignore": ".esteira/runs/\n" });
  runInit({ root: dir, quiet: true });

  edit(dir, "src/index.ts", "export const secret = 'xoxb-1234567890abcdef';\n");
  git(dir, ["add", "."]);
  const bad = tryGit(dir, ["commit", "-m", "bad"]);
  assert.equal(bad.status, 1, bad.out);
  assert.match(git(dir, ["log", "--oneline"]), /(^|\s)init$/);

  edit(dir, "src/index.ts", "export const a = 1;\n");
  git(dir, ["add", "."]);
  const good = tryGit(dir, ["commit", "-m", "good"]);
  assert.equal(good.status, 0, good.out);
});
