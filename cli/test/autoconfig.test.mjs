// `gh esteira init` configures the project on its own: the commands of a single
// subproject (cli/) become the root commands, dependencies are installed before
// they run, and the security job tolerates a branch-creating push (before=0000…).
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { installCommandFor } from "../src/lib/install.mjs";
import { commandsFromSubprojects, buildProfile } from "../src/lib/profile.mjs";
import { renderWorkflow } from "../src/adapters/workflows.mjs";
import { withDeadline } from "../src/lib/deadline.mjs";
import { generate } from "../src/hermes/adapter.mjs";

const write = (dir, rel, body) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), body);
};

/** Repository whose code lives in cli/ (as this one does). */
function umbrella({ lock = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-umbrella-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  write(dir, "cli/package.json", JSON.stringify({
    name: "cli", version: "1.0.0", scripts: { test: "node --test", typecheck: "tsc -p ." },
  }));
  if (lock) write(dir, "cli/package-lock.json", "{}");
  write(dir, "README.md", "x\n");
  return dir;
}

test("install commands: lockfile → ci, none → install; subfolder uses the tool's own flag", () => {
  const dir = umbrella({ lock: true });
  assert.equal(installCommandFor(dir, "", null), null, "no package manager → no install");
  assert.equal(installCommandFor(dir, "cli", "npm"), "npm ci --ignore-scripts --prefix cli");
  const loose = umbrella({ lock: false });
  assert.equal(installCommandFor(loose, "cli", "npm"), "npm install --ignore-scripts --prefix cli");
  assert.equal(installCommandFor(dir, "cli", "pnpm"), "pnpm --dir cli install --ignore-scripts");
  assert.equal(installCommandFor(dir, "cli", "unknown-pm"), null);
});

test("a single subproject with npm scripts becomes the root commands (run with --prefix)", () => {
  const dir = umbrella();
  const profile = buildProfile(dir);
  assert.equal(profile.commands.test, "npm --prefix cli run test");
  assert.equal(profile.commands.typecheck, "npm --prefix cli run typecheck");
  assert.equal(profile.commands.lint, null);
  assert.equal(profile.gaps.some((g) => g.id === "no-test-command"), false);
});

test("several subprojects are not chained silently: the commands stay empty", () => {
  const subs = [
    { path: "a", gitRepo: false, languages: [{ id: "node", packageManager: "npm", runtime: {}, commands: { test: "npm run test" }, installCommand: null }] },
    { path: "b", gitRepo: false, languages: [{ id: "node", packageManager: "npm", runtime: {}, commands: { test: "npm run test" }, installCommand: null }] },
  ];
  assert.equal(commandsFromSubprojects(subs).test, null);
});

test("non-npm-run commands are not rebased onto the wrong folder", () => {
  const subs = [{ path: "cli", gitRepo: false, languages: [{ id: "node", packageManager: "npm", runtime: {}, commands: { typecheck: "npx tsc --noEmit" }, installCommand: null }] }];
  assert.equal(commandsFromSubprojects(subs).typecheck, null);
});

test("the generated workflow installs, then typechecks and tests the subproject", () => {
  const dir = umbrella();
  const wf = renderWorkflow(buildProfile(dir));
  const install = wf.indexOf("npm ci --ignore-scripts --prefix cli");
  const typecheck = wf.indexOf("npm --prefix cli run typecheck");
  const test = wf.indexOf("npm --prefix cli run test");
  assert.ok(install > 0 && typecheck > install && test > typecheck, "install → typecheck → test");
  assert.match(wf, /node-version: '20'/, "runtime set up for the subproject");
});

test("the security job compares against HEAD~1 when the push creates the branch (before=0000…)", () => {
  const wf = renderWorkflow(buildProfile(umbrella()));
  assert.match(wf, /case "\$CHANGE_BASE" in ''\|\*\[!0\]\*\)/);
  assert.match(wf, /git rev-parse --verify -q HEAD~1/);
  assert.match(wf, /--policy-ref "\$CHANGE_BASE"/);
  assert.doesNotMatch(wf, /--policy-ref "\$BASE_SHA"/, "the policy ref must be the resolved base");
});

test("withDeadline rejects work that never settles", async () => {
  await assert.rejects(withDeadline(() => new Promise(() => {}), 50, "teste"), /teste estourou o tempo \(50 ms\)/);
});

test("the Hermes transport degrades to an error when fetch ignores the abort signal", async () => {
  const started = Date.now();
  const out = await generate({
    settings: { endpoint: "http://hermes.test", model: "m", timeoutMs: 100 },
    prompt: "p", timeoutMs: 100,
    fetchImpl: () => new Promise(() => {}), // never settles, ignores the signal
  });
  assert.equal(out.status, "error");
  assert.match(out.error ?? "", /estourou o tempo/);
  assert.ok(Date.now() - started < 5000, "bounded by the deadline, not by the transport");
});
