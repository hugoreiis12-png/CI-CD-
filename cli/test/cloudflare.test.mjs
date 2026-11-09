// Sprint 3 — Cloudflare security-audit skill attributes in the CI/CD analysis:
// CI-workflow attack classes in the gate, and findings exported in the skill's
// validated findings.json contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { analyzeWorkflow } from "../src/gate/checks/workflows.mjs";
import { runGate } from "../src/gate/run.mjs";
import { runReport, toCloudflareFindings } from "../src/report/cloudflare.mjs";
import { CATALOG } from "../src/report/catalog.mjs";

const KEY = "AKIAIOSFODNN7ABCDEFG";
const rules = (findings) => findings.map((f) => `${f.rule}:${f.line}`);
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

function repo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-cf-"));
  git(dir, "init", "-q");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  fs.writeFileSync(path.join(dir, ".gitignore"), ".esteira/\n");
  fs.writeFileSync(path.join(dir, ".esteira-placeholder"), "");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "init", "--no-verify");
  fs.mkdirSync(path.join(dir, ".esteira"), { recursive: true });
  fs.writeFileSync(path.join(dir, ".esteira/project.json"), JSON.stringify({ gate: { playground: { enabled: false } } }));
  return dir;
}

const write = (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

test("workflows: pull_request_target + PR-head checkout is flagged", () => {
  const wf = [
    "on: pull_request_target",
    "jobs:",
    "  build:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - uses: actions/checkout@0ad4b8fadaa221de15dcec353f45205ec38ea70b",
    "        with:",
    "          ref: ${{ github.event.pull_request.head.sha }}",
  ].join("\n");
  assert.deepEqual(rules(analyzeWorkflow(".github/workflows/x.yml", wf)), ["ci-privileged-pr-checkout:8"]);
  assert.deepEqual(rules(analyzeWorkflow(".github/workflows/x.yml", wf.replace("pull_request_target", "pull_request"))), []);
});

test("workflows: untrusted expressions are flagged only inside run: scripts", () => {
  const wf = [
    "on: issues",
    "jobs:",
    "  t:",
    "    runs-on: ubuntu-latest",
    "    steps:",
    "      - if: ${{ github.event.issue.title != '' }}",
    "        env:",
    "          TITLE: ${{ github.event.issue.title }}",
    "        run: |",
    "          echo \"$TITLE\"",
    "          echo \"${{ github.event.issue.body }}\"",
    "      - run: echo ${{ github.head_ref }}",
    "      - run: echo ${{ github.sha }}",
  ].join("\n");
  assert.deepEqual(rules(analyzeWorkflow(".github/workflows/x.yml", wf)), ["ci-expression-injection:11", "ci-expression-injection:12"]);
});

test("workflows: floating actions escalate when the workflow holds write scopes; SHA pins and local actions pass", () => {
  const plain = "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n      - uses: ./local\n      - uses: actions/setup-node@0ad4b8fadaa221de15dcec353f45205ec38ea70b # pinned: v4\n";
  assert.deepEqual(rules(analyzeWorkflow(".github/workflows/x.yml", plain)), ["ci-floating-action:4"]);
  const priv = `permissions: write-all\n${plain}`;
  assert.deepEqual(rules(analyzeWorkflow(".github/workflows/x.yml", priv)), ["ci-write-all:1", "ci-floating-action-privileged:5"]);
});

test("gate: a staged workflow with expression injection is reproved", () => {
  const dir = repo();
  write(dir, ".github/workflows/triage.yml", "on: issues\njobs:\n  t:\n    steps:\n      - run: echo ${{ github.event.issue.title }}\n");
  git(dir, "add", "-A");
  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "reproved");
  assert.ok(run.findings.some((f) => f.rule === "ci-expression-injection" && f.line === 5));
});

test("catalog: every rule the checks can emit is mapped to a skill attack class", async () => {
  const sources = ["secrets", "sensitive", "patterns", "workflows"].map((n) =>
    fs.readFileSync(new URL(`../src/gate/checks/${n}.mjs`, import.meta.url), "utf8")).join("\n");
  const emitted = new Set([...sources.matchAll(/["'](secret-[a-z-]+|sensitive-[a-z-]+|gitignore-[a-z-]+|dangerous-[a-z0-9-]+|ci-[a-z-]+)["']/g)].map((m) => m[1]));
  for (const rule of emitted) assert.ok(CATALOG[rule], `rule ${rule} has no catalog entry`);
  for (const meta of Object.values(CATALOG)) assert.match(meta.attackClass, /^[A-Z-]+\.md#.+/);
});

test("report: gate + audit export as a findings.json the skill's validator accepts", () => {
  const dir = repo();
  write(dir, "src/config.js", `export const k = "${KEY}";\nexport const k2 = "${KEY}";\n`);
  write(dir, "src/run.js", "export const f = (s) => eval(s);\n");
  write(dir, ".github/workflows/ci.yml", "jobs:\n  a:\n    steps:\n      - uses: actions/checkout@v4\n");
  git(dir, "add", "-A");
  runGate({ root: dir, json: true });
  write(dir, ".esteira/audits/latest.json", JSON.stringify({
    findings: [{ id: "GHSA-xxxx-yyyy-zzzz", package: "left-pad", version: "1.0.0", source: "package.json", severity: "high", summary: "test advisory", fixed: ["1.3.0"], ecosystem: "npm" }],
  }));

  const out = ".esteira/reports/findings.json";
  const res = runReport({ root: dir, out, json: true });
  assert.equal(res.exitCode, 0, res.errors.join("\n"));
  const doc = JSON.parse(fs.readFileSync(path.join(dir, out), "utf8"));

  const require = createRequire(import.meta.url);
  const vendor = new URL("../vendor/cloudflare-security-audit/", import.meta.url);
  const { validateDocument } = require(fileURLToPath(new URL("validate-findings.cjs", vendor)));
  const schema = JSON.parse(fs.readFileSync(new URL("report-schema.json", vendor), "utf8"));
  assert.deepEqual(validateDocument(doc, schema), []);

  const secret = doc.find((r) => r.title.startsWith("secret-aws"));
  assert.equal(secret.verdict, "confirmed");
  assert.equal(secret.severity.overall_severity, "high");
  assert.deepEqual(secret.evidence.map((e) => e.line), [1, 2], "two matching lines are one root cause");
  const leads = doc.filter((r) => r.verdict === "needs_validation").map((r) => r.title.split(" ")[0]).sort();
  assert.deepEqual(leads, ["GHSA-xxxx-yyyy-zzzz", "ci-floating-action", "dangerous-eval"]);
  assert.ok(doc.filter((r) => r.verdict === "needs_validation").every((r) => !("severity" in r)), "leads carry no severity");
  assert.ok(!fs.readFileSync(path.join(dir, out), "utf8").includes(KEY), "the matched credential is never written to the report");
});

test("report: an empty project exports an empty, valid document", () => {
  const { records, errors } = toCloudflareFindings({ run: null, audit: null });
  assert.deepEqual(records, []);
  assert.deepEqual(errors, []);
});
