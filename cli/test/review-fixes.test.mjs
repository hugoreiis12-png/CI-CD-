// Regression tests for the review of v0.2.x: each test pins one fixed failure.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveCommands } from "../src/gate/run.mjs";
import { collectDependencies } from "../src/audit/manifests.mjs";
import { READ_ONLY_TOOLS, realProjectPath, safeRelPath } from "../src/agent/tools.mjs";
import { upgradeExtension } from "../src/commands/self-update.mjs";

const tempProject = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), prefix));

/** Creates a symlink, or returns false where the OS does not allow it (Windows without privilege). */
function tryLink(target, link) {
  try {
    fs.symlinkSync(target, link);
    return true;
  } catch {
    return false;
  }
}

// 1. The gate must not treat a manifest of nulls as "commands configured".
test("gate: a manifest with null commands falls back to the detected ones", () => {
  const detected = { lint: null, typecheck: "npm --prefix cli run typecheck", test: "npm --prefix cli run test", build: null };
  assert.deepEqual(resolveCommands({ lint: null, typecheck: null, test: null, build: null }, detected), detected);
  assert.deepEqual(resolveCommands(undefined, detected), detected);
});

test("gate: a command set in the manifest wins over the detection", () => {
  const detected = { lint: null, typecheck: "detected-tc", test: "detected-test", build: null };
  const resolved = resolveCommands({ typecheck: "policy-tc", test: null }, detected);
  assert.equal(resolved.typecheck, "policy-tc");
  assert.equal(resolved.test, "detected-test");
});

// 2. The audit must see subprojects, not report "0 dependencies, all clean".
test("audit: dependencies of a subproject are collected, with the manifest they came from", () => {
  const root = tempProject("esteira-audit-");
  fs.mkdirSync(path.join(root, "cli"));
  fs.writeFileSync(path.join(root, "cli", "package.json"), JSON.stringify({ dependencies: { "left-pad": "1.0.0" } }));
  const items = collectDependencies(root);
  const found = items.find((item) => item.name === "left-pad");
  assert.ok(found, "the subproject dependency is in the SBOM");
  assert.equal(found.source, "cli/package.json");
});

test("audit: folders that hold installed code (node_modules) are not scanned", () => {
  const root = tempProject("esteira-audit-skip-");
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "package.json"), JSON.stringify({ dependencies: { inside: "1.0.0" } }));
  assert.equal(collectDependencies(root).some((item) => item.name === "inside"), false);
});

// 3. Credential files of more kinds never reach the model.
test("agent: more credential files are refused by name", () => {
  for (const name of [".npmrc", ".netrc", ".pypirc", ".git-credentials", "deploy/cert.p12", "keys/store.pfx"]) {
    assert.throws(() => safeRelPath("/tmp/proj", name), /credenciais/, name);
  }
});

// 4. A symlink must not let the model (or heal) read or write outside the project.
test("agent: read_file does not follow a symlink that points outside the project", (t) => {
  const root = tempProject("esteira-link-");
  const outside = tempProject("esteira-outside-");
  fs.writeFileSync(path.join(outside, "secret.txt"), "FORA-DO-PROJETO\n");
  if (!tryLink(path.join(outside, "secret.txt"), path.join(root, "notes.txt"))) return t.skip("sem privilégio para criar symlink");
  assert.throws(() => realProjectPath(root, "notes.txt"), /link simbólico aponta para fora/);
  assert.throws(() => READ_ONLY_TOOLS.read_file.run({ root }, { path: "notes.txt" }), /link simbólico aponta para fora/);
});

test("agent: a link inside the project to a credential file is refused too", (t) => {
  const root = tempProject("esteira-link-env-");
  fs.writeFileSync(path.join(root, ".env"), "SEGREDO=abc\n");
  if (!tryLink(path.join(root, ".env"), path.join(root, "config.txt"))) return t.skip("sem privilégio para criar symlink");
  assert.throws(() => realProjectPath(root, "config.txt"), /credenciais/);
});

test("agent: a new file inside the project is still allowed (heal writes new files)", () => {
  const root = tempProject("esteira-new-");
  fs.mkdirSync(path.join(root, "src"));
  assert.equal(realProjectPath(root, "src/novo/arquivo.js"), path.join(fs.realpathSync(root), "src", "novo", "arquivo.js"));
});

// 5. Upgrading must never leave the user without a working extension.
/** Fake gh that records every call; `installOk` decides whether an install lands. */
function fakeGh({ installOk }) {
  const state = { version: "v0.2.1", calls: [] };
  const gh = (args) => {
    state.calls.push(args);
    if (args[0] === "esteira") return { status: 0, stdout: `${state.version.slice(1)}\n` };
    if (args[1] === "upgrade") return { status: 0, stdout: "" };
    if (args[1] === "install") {
      const pin = args[args.indexOf("--pin") + 1];
      if (installOk(pin)) state.version = pin;
      return { status: installOk(pin) ? 0 : 1, stdout: "" };
    }
    return { status: 1, stdout: "" };
  };
  return { gh, state };
}

test("upgrade: the old copy is never removed before the new one is installed", () => {
  const { gh, state } = fakeGh({ installOk: () => true });
  assert.deepEqual(upgradeExtension("v0.2.2", gh), { ok: true, method: "reinstall-pinned", version: "v0.2.2" });
  assert.equal(state.calls.some((args) => args[1] === "remove"), false);
  assert.ok(state.calls.some((args) => args[1] === "install" && args.includes("--force")), "install replaces in place");
});

test("upgrade: when the new version does not land, the previous one is reinstalled", () => {
  const { gh, state } = fakeGh({ installOk: (pin) => pin === "v0.2.1" });
  const out = upgradeExtension("v0.2.2", gh);
  assert.equal(out.ok, false);
  assert.equal(state.calls.some((args) => args[1] === "remove"), false, "never removed");
  const rollback = state.calls.filter((args) => args[1] === "install").pop();
  assert.equal(rollback[rollback.indexOf("--pin") + 1], "v0.2.1", "the last install restores the previous pin");
  assert.equal(out.version, "v0.2.1", "the user keeps a working extension");
});
