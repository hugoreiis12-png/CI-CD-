#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalyze } from "./commands/analyze.mjs";
import { runInit } from "./commands/init.mjs";
import { runGate } from "./gate/run.mjs";
import { verifyAttestation } from "./gate/attest.mjs";
import { runAudit } from "./audit/run.mjs";
import { runGitops } from "./gitops/run.mjs";
import { pinWorkflows, makeGhResolver } from "./gitops/pin.mjs";
import { exists, readFile, writeFile } from "./lib/fs-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
).version;

const HELP = `Esteira — secure adaptive CI/CD & vulnerability audit

Usage:
  gh esteira init [--dry-run] [--force] [--dir <path>]
  gh esteira analyze [--json] [--dir <path>]
  gh esteira gate [--json] [--dir <path>]  # static + playground gate over staged changes (M2/M3)
  gh esteira attest --verify [--json] [--dir <path>]  # push: HEAD must be an attested snapshot (M3)
  gh esteira audit [--json] [--dir <path>]  # CVE/dependency advisories via OSV.dev (M4)
  gh esteira gitops [--image <ref>] [--gitops-repo <o/r>] [--force]  # K8s base+overlays, Argo CD, release workflow (M5)
  gh esteira pin [--dry-run] [--dir <path>]  # SHA-pin every 'uses:' action in generated workflows (M5)
  gh esteira --version | --help
`;

function parse(argv) {
  const flags = {
    json: false, dryRun: false, force: false, staged: false, verify: false,
    help: false, version: false, dir: process.cwd(),
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--staged") flags.staged = true;
    else if (a === "--verify") flags.verify = true;
    else if (a === "--dir") flags.dir = path.resolve(argv[++i] ?? process.cwd());
    else if (a === "--image") flags.image = argv[++i];
    else if (a === "--gitops-repo") flags.gitopsRepo = argv[++i];
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (!a.startsWith("-")) positional.push(a);
    else process.stderr.write(`[esteira] unknown flag: ${a}\n`);
  }
  return { flags, positional };
}

async function main() {
  const { flags, positional } = parse(process.argv.slice(2));
  const command = positional[0];

  if (flags.version) {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (flags.help || !command) {
    process.stdout.write(HELP);
    return;
  }

  switch (command) {
    case "analyze":
      runAnalyze({ root: flags.dir, json: flags.json });
      break;
    case "init":
      runInit({ root: flags.dir, dryRun: flags.dryRun, force: flags.force });
      break;
    case "gate": {
      const run = runGate({ root: flags.dir, json: flags.json });
      process.exitCode = run.exitCode;
      break;
    }
    case "attest": {
      const check = verifyAttestation({ root: flags.dir, json: flags.json });
      process.exitCode = check.exitCode;
      break;
    }
    case "audit": {
      const result = await runAudit({ root: flags.dir, json: flags.json });
      process.exitCode = result.exitCode;
      break;
    }
    case "gitops": {
      runGitops({ root: flags.dir, image: flags.image, force: flags.force, gitopsRepo: flags.gitopsRepo });
      break;
    }
    case "pin": {
      const resolveRef = await makeGhResolver();
      const report = await pinWorkflows({
        root: flags.dir, dryRun: flags.dryRun, resolveRef,
        existsFile: exists, readFile, writeFile,
      });
      process.stdout.write(JSON.stringify(report, null, flags.json ? 2 : undefined) + "\n");
      if (report.unresolved.length > 0) process.exitCode = 1;
      break;
    }
    default:
      process.stderr.write(`[esteira] unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch((error) => {
  process.stderr.write(`[esteira] ${error.message}\n`);
  process.exitCode = 1;
});
