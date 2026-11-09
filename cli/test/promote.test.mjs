import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { replaceTag, currentTag } from "../src/promote/mutate.mjs";
import { runPromote } from "../src/promote/run.mjs";
import { runInit } from "../src/commands/init.mjs";
import { runGitops } from "../src/gitops/run.mjs";

const KUST = "images:\n  - name: mysvc\n    newTag: SET-BY-GITOPS\n";

test("replaceTag: rewrites, is idempotent, reports missing image", () => {
  const r = replaceTag(KUST, "mysvc", "abc123");
  assert.equal(r.changed, true);
  assert.match(r.next, /newTag: abc123/);
  assert.equal(replaceTag(r.next, "mysvc", "abc123").reason, "already-current");
  assert.equal(replaceTag(KUST, "other", "abc123").reason, "image-not-found");
  assert.equal(currentTag(KUST, "mysvc"), null);
  assert.equal(currentTag(r.next, "mysvc"), "abc123");
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-promote-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "MySvc" }));
  const clone = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-clone-"));
  const overlay = path.join(clone, "apps/mysvc/overlays/staging");
  fs.mkdirSync(overlay, { recursive: true });
  fs.writeFileSync(path.join(overlay, "kustomization.yaml"), KUST);
  return { dir, clone, file: path.join(overlay, "kustomization.yaml") };
}

test("runPromote: edits overlay, commits, pushes and opens a PR (offline)", async () => {
  const { dir, clone, file } = fixture();
  const calls = [];
  const res = await runPromote({
    root: dir, repo: "acme/gitops", tag: "deadbeefcafe1234", cloneTarget: clone, quiet: true,
    execImpl: (cmd, args) => { calls.push([cmd, ...args].join(" ")); return ""; },
    ghImpl: (args) => { calls.push(`gh ${args.join(" ")}`); return "https://github.com/acme/gitops/pull/1"; },
  });
  assert.equal(res.changed, true);
  assert.equal(res.previous, "SET-BY-GITOPS");
  assert.match(fs.readFileSync(file, "utf8"), /newTag: deadbeefcafe1234/);
  assert.ok(calls.some((c) => c.includes("push -u origin esteira/promote-mysvc-staging-deadbeefca")));
  assert.ok(calls.some((c) => c.startsWith("gh pr create --repo acme/gitops")));
  assert.ok(fs.existsSync(clone), "caller-provided clone is not deleted");
});

test("runPromote: already-current is a no-op; missing tag/repo/env fail loudly", async () => {
  const { dir, clone } = fixture();
  const opts = { root: dir, repo: "acme/gitops", tag: "t1", cloneTarget: clone, quiet: true, execImpl: () => "", ghImpl: () => "u" };
  await runPromote(opts);
  const again = await runPromote(opts);
  assert.equal(again.already, true);
  await assert.rejects(() => runPromote({ ...opts, tag: undefined }), /--tag/);
  await assert.rejects(() => runPromote({ ...opts, repo: undefined }), /No GitOps repository/);
  await assert.rejects(() => runPromote({ ...opts, env: "prod" }), /staging or production/);
});

test("runPromote: dry-run never touches git or gh", async () => {
  const { dir } = fixture();
  const boom = () => { throw new Error("must not run"); };
  const res = await runPromote({ root: dir, repo: "a/b", tag: "t1", dryRun: true, quiet: true, execImpl: boom, ghImpl: boom });
  assert.equal(res.dryRun, true);
});

test("release workflow: no stray template braces, has scan + promote jobs", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "esteira-rel-"));
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "mysvc" }));
  runInit({ root: dir, quiet: true });
  runGitops({ root: dir, gitopsRepo: "acme/gitops", quiet: true });
  const wf = fs.readFileSync(path.join(dir, ".github/workflows/esteira-release.yml"), "utf8");
  assert.doesNotMatch(wf, /"\}|\}\}\}/);
  assert.match(wf, /GITOPS_REPO: acme\/gitops/);
  for (const job of ["image-scan:", "promote-staging:", "promote-production:"]) assert.ok(wf.includes(job), job);
  assert.match(wf, /trivy-action/);
});
