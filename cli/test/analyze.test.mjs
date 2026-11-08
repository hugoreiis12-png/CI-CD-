import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildProfile } from "../src/lib/profile.mjs";
import { runInit } from "../src/commands/init.mjs";

function fixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-fixture-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  return dir;
}

test("node monorepo with pnpm", () => {
  const dir = fixture({
    "package.json": JSON.stringify({
      name: "demo",
      packageManager: "pnpm@9.0.0",
      scripts: { test: "vitest run", lint: "eslint .", build: "tsc -p ." },
      dependencies: { next: "14.0.0", react: "18.0.0" },
      devDependencies: { typescript: "5.0.0", vitest: "1.0.0" },
    }),
    "pnpm-workspace.yaml": "packages:\n  - apps/*\n",
    "pnpm-lock.yaml": "",
    "apps/web/package.json": "{}",
  });
  const profile = buildProfile(dir);
  const node = profile.languages.find((l) => l.id === "node");
  assert.ok(node);
  assert.equal(node.packageManager, "pnpm");
  assert.equal(profile.commands.test, "pnpm run test");
  assert.equal(profile.monorepo.isMonorepo, true);
  assert.equal(profile.monorepo.tool, "pnpm");
  assert.deepEqual(profile.monorepo.layout, ["apps"]);
  assert.ok(node.frameworks.includes("next"));
});

test("python project with poetry", () => {
  const dir = fixture({
    "pyproject.toml": '[tool.poetry]\nname = "svc"\n\n[tool.poetry.dependencies]\nfastapi = "^0.100"\npytest = "^8"\n',
    "poetry.lock": "",
    "tests/test_api.py": "def test_ok():\n    assert True\n",
  });
  const profile = buildProfile(dir);
  const py = profile.languages.find((l) => l.id === "python");
  assert.ok(py);
  assert.equal(py.packageManager, "poetry");
  assert.match(profile.commands.test, /poetry run/);
  assert.ok(py.frameworks.includes("fastapi"));
});

test("go project", () => {
  const dir = fixture({
    "go.mod": "module example.com/svc\n\ngo 1.22\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
  });
  const profile = buildProfile(dir);
  const go = profile.languages.find((l) => l.id === "go");
  assert.ok(go);
  assert.equal(profile.commands.test, "go test ./...");
  assert.ok(go.frameworks.includes("gin"));
});

test("polyglot project with infra", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "p", scripts: { test: "jest" } }),
    "Dockerfile": "FROM alpine\n",
    "k8s/deployment.yaml": "apiVersion: apps/v1\nkind: Deployment\n",
    "main.tf": 'resource "null_resource" "x" {}\n',
    ".github/workflows/ci.yml": "name: ci\n",
  });
  const profile = buildProfile(dir);
  assert.ok(profile.languages.some((l) => l.id === "node"));
  assert.equal(profile.infra.containers, true);
  assert.equal(profile.infra.kubernetes, true);
  assert.equal(profile.infra.terraform, true);
  assert.deepEqual(profile.infra.ciProviders, ["github-actions"]);
});

test("unknown stack degrades gracefully", () => {
  const dir = fixture({ "notes.txt": "hello" });
  const profile = buildProfile(dir);
  assert.equal(profile.languages.length, 0);
  assert.ok(profile.gaps.some((g) => g.id === "unknown-stack"));
});

test("init: dry-run writes nothing, real run is idempotent", () => {
  const dir = fixture({
    "package.json": JSON.stringify({ name: "p", scripts: { test: "node --test" } }),
    ".git/HEAD": "ref: refs/heads/main\n",
  });

  const dry = runInit({ root: dir, dryRun: true, quiet: true });
  assert.equal(fs.existsSync(path.join(dir, ".esteira")), false);
  assert.equal(dry.results[0].reason, "dry-run");

  const first = runInit({ root: dir, quiet: true });
  assert.ok(fs.existsSync(path.join(dir, ".esteira/project.json")));
  assert.ok(fs.existsSync(path.join(dir, ".github/workflows/esteira-ci.yml")));
  const hook = path.join(dir, ".esteira/hooks/pre-commit");
  assert.ok(fs.statSync(hook).mode & 0o111, "hook must be executable");
  assert.equal(first.profile.languages[0].id, "node");

  const second = runInit({ root: dir, quiet: true });
  const workflow = second.results.find((r) => r.path.endsWith("esteira-ci.yml"));
  assert.equal(workflow.written, false);
});
