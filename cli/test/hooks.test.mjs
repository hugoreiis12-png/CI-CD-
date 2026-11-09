// v0.2.0 — the esteira behind every git command (commit, merge, push, pull,
// rebase) and the sensitive-file rules from the field incident (.env committed
// after its .gitignore rule was removed).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { runGate } from "../src/gate/run.mjs";
import { verifyAttestation } from "../src/gate/attest.mjs";
import { runHook } from "../src/hooks/run.mjs";
import { installHook } from "../src/adapters/precommit.mjs";

const CLI = fileURLToPath(new URL("../src/index.mjs", import.meta.url));
const SECRET = "s3cr3tValueXYZ987abc";
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (cwd, ...args) => spawnSync("git", args, { cwd, encoding: "utf8" });

function repo(files = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-hooks-"));
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.email", "t@t");
  git(dir, "config", "user.name", "t");
  for (const [rel, body] of Object.entries({ ".gitignore": ".env\n.env.*\n!.env.example\n.esteira/\n", "README": "x\n", ...files })) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), body);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "base", "--no-verify");
  return dir;
}
const write = (dir, rel, body) => fs.writeFileSync(path.join(dir, rel), body);
const rules = (run) => run.findings.map((f) => f.rule);

test("incident replay: .gitignore stops ignoring .env and .env is committed → blocked", () => {
  const dir = repo();
  write(dir, ".gitignore", ".esteira/\n");
  write(dir, ".env", `IFOOD_CLIENT_ID=abc123\nIFOOD_CLIENT_SECRET=${SECRET}\nVITE_STRIPE_PUBLISHABLE_KEY=pk_test_1\n`);
  git(dir, "add", "-A");
  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "reproved");
  assert.ok(rules(run).includes("sensitive-file"));
  assert.ok(rules(run).includes("gitignore-unprotects-secrets"));
  const env = run.findings.filter((f) => f.rule === "secret-env-assignment");
  assert.deepEqual(env.map((f) => f.line), [2], "only the secret line; the client id and the publishable key are not secrets");
  assert.ok(!JSON.stringify(run.findings).includes(SECRET), "values are never echoed");
});

test("sensitive rules stay quiet on examples, placeholders, certificates and equivalent ignore rules", () => {
  const dir = repo();
  write(dir, ".env.example", "API_TOKEN=\nDB_PASSWORD=changeme\nSECRET_KEY=<your-key>\n");
  write(dir, "cert.pem", "-----BEGIN CERTIFICATE-----\n");
  write(dir, ".gitignore", ".env*\n!.env.example\n.esteira/\n"); // .env and .env.* collapsed into .env*
  git(dir, "add", "-A");
  const found = rules(runGate({ root: dir, json: true })).filter((r) => r.startsWith("sensitive") || r.startsWith("secret") || r.startsWith("gitignore"));
  assert.deepEqual(found, []);
});

test("keys, keystores and credentials files are blocked by name", () => {
  const dir = repo();
  for (const f of ["server.key", "release.jks", "id_ed25519", "credentials.json", "prod.env"]) write(dir, f, "x\n");
  git(dir, "add", "-A");
  const files = runGate({ root: dir, json: true }).findings.filter((f) => f.rule === "sensitive-file").map((f) => f.file).sort();
  assert.deepEqual(files, ["credentials.json", "id_ed25519", "prod.env", "release.jks", "server.key"]);
});

function withRemote() {
  const dir = repo();
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-remote-"));
  git(remote, "init", "-q", "--bare");
  git(dir, "remote", "add", "origin", remote);
  git(dir, "push", "-q", "origin", "main", "--no-verify");
  return dir;
}
const pushLine = (dir) => `refs/heads/main ${git(dir, "rev-parse", "HEAD")} refs/heads/main ${git(dir, "rev-parse", "origin/main")}\n`;

test("pre-push checks every new commit: a secret added and then removed is still blocked", async () => {
  const dir = withRemote();
  write(dir, "config.js", `export const k = "AKIAIOSFODNN7ABCDEFG";\n`);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "leak", "--no-verify");
  write(dir, "config.js", "export const k = process.env.KEY;\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "remove", "--no-verify");
  const status = await runHook("pre-push", { root: dir, args: ["origin"], stdin: pushLine(dir) });
  assert.equal(status, 1, "the leaked key is in the pushed history even though HEAD is clean");
});

test("pre-push validates --no-verify commits and attests them, so the push goes through", async () => {
  const dir = withRemote();
  write(dir, "ok.txt", "clean\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "clean", "--no-verify");
  assert.equal(verifyAttestation({ root: dir, json: true }).ok, false);
  assert.equal(await runHook("pre-push", { root: dir, args: ["origin"], stdin: pushLine(dir) }), 0);
  assert.equal(verifyAttestation({ root: dir, json: true }).ok, true);
  assert.equal(await runHook("pre-push", { root: dir, args: ["origin"], stdin: "refs/heads/x 0000000000000000000000000000000000000000 refs/heads/x abc\n" }), 0, "deleting a remote ref is not gated");
});

test("real git: installed hooks block `git commit` of .env and `git push` of a --no-verify leak", () => {
  const dir = withRemote();
  installHook(dir, { cli: CLI });
  write(dir, ".env.local", `DB_PASSWORD=${SECRET}\n`);
  git(dir, "add", "-f", ".env.local");
  const commit = tryGit(dir, "commit", "-m", "env");
  assert.notEqual(commit.status, 0);
  assert.match(commit.stdout + commit.stderr, /sensitive-file/);

  git(dir, "commit", "-qm", "env", "--no-verify");
  const push = tryGit(dir, "push", "origin", "main");
  assert.notEqual(push.status, 0, push.stdout + push.stderr);
  assert.match(push.stdout + push.stderr, /\[commit [0-9a-f]{7}\]/);
});

test("pull: post-merge warns about what arrived and never blocks", async () => {
  const dir = withRemote();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-clone-"));
  git(other, "clone", "-q", git(dir, "remote", "get-url", "origin"), ".");
  git(other, "config", "user.email", "o@o");
  git(other, "config", "user.name", "o");
  write(other, "leak.js", `const t = "ghp_${"A".repeat(36)}";\n`);
  git(other, "add", "-A");
  git(other, "commit", "-qm", "teammate leak", "--no-verify");
  git(other, "push", "-q", "origin", "HEAD:main", "--no-verify");
  git(dir, "pull", "-q", "--no-rebase", "--no-verify", "origin", "main");
  const out = spawnSync(process.execPath, [CLI, "hook", "post-merge", "0", "--dir", dir], { encoding: "utf8" });
  assert.equal(out.status, 0);
  assert.match(out.stdout, /ATENÇÃO/);
  assert.match(out.stdout, /secret-github/);
});

test("esteira.enabled=false turns the hooks off in one repository", async () => {
  const dir = repo();
  git(dir, "config", "esteira.enabled", "false");
  write(dir, ".env", `TOKEN=${SECRET}\n`);
  git(dir, "add", "-f", ".env");
  assert.equal(await runHook("pre-commit", { root: dir, args: [], stdin: "" }), 0);
});

test("init --global: a repository without init is protected; --uninstall restores the previous hooksPath", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-home-"));
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), GIT_CONFIG_GLOBAL: path.join(home, ".gitconfig") };
  fs.writeFileSync(env.GIT_CONFIG_GLOBAL, "[core]\n\thooksPath = /old/hooks\n");
  const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env });
  assert.equal(run("init", "--global").status, 0);
  const configured = spawnSync("git", ["config", "--global", "core.hooksPath"], { encoding: "utf8", env }).stdout.trim();
  assert.equal(configured, path.join(home, ".config", "esteira", "hooks"));
  assert.match(fs.readFileSync(path.join(configured, "pre-commit"), "utf8"), /ESTEIRA_PREV_HOOKS='\/old\/hooks'/);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-noinit-"));
  const g = (...args) => spawnSync("git", args, { cwd: dir, encoding: "utf8", env });
  g("init", "-q");
  g("config", "user.email", "t@t");
  g("config", "user.name", "t");
  fs.writeFileSync(path.join(dir, "server.key"), "x\n");
  g("add", "-A");
  const commit = g("commit", "-m", "key");
  assert.notEqual(commit.status, 0, "blocked with no `gh esteira init` in this repository");
  assert.match(fs.readFileSync(path.join(dir, ".git", "info", "exclude"), "utf8"), /\.esteira\/runs\//, "gate records are excluded locally");

  assert.equal(run("init", "--global", "--uninstall").status, 0);
  assert.equal(spawnSync("git", ["config", "--global", "core.hooksPath"], { encoding: "utf8", env }).stdout.trim(), "/old/hooks");
});

test("playground reuses installed dependencies and never deletes them", () => {
  const dir = repo({
    ".gitignore": "node_modules/\n.esteira/\n",
    ".esteira-keep": "",
    "dep.test.mjs": 'import test from "node:test";\nimport { v } from "./node_modules/dep/index.mjs";\ntest("dep", () => { if (v !== 1) throw new Error("dep"); });\n',
  });
  fs.mkdirSync(path.join(dir, "node_modules", "dep"), { recursive: true });
  write(dir, "node_modules/dep/index.mjs", "export const v = 1;\n");
  fs.mkdirSync(path.join(dir, ".esteira"), { recursive: true });
  write(dir, ".esteira/project.json", JSON.stringify({ profile: { commands: { test: "node --test dep.test.mjs" } } }));
  write(dir, "README", "changed\n");
  git(dir, "add", "-A");
  const run = runGate({ root: dir, json: true });
  assert.equal(run.verdict, "approved", JSON.stringify(run.findings));
  assert.ok(run.playground?.lines?.some((l) => /node_modules/.test(l)));
  assert.ok(fs.existsSync(path.join(dir, "node_modules", "dep", "index.mjs")), "the real node_modules survives the snapshot cleanup");
});
