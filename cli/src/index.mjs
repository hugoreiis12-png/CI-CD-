#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAnalyze } from "./commands/analyze.mjs";
import { runInit } from "./commands/init.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const VERSION = JSON.parse(
  fs.readFileSync(path.join(here, "..", "package.json"), "utf8"),
).version;

const HELP = `Esteira — secure adaptive CI/CD & vulnerability audit

Usage:
  gh esteira init [--dry-run] [--force] [--dir <path>]
  gh esteira analyze [--json] [--dir <path>]
  gh esteira gate [--staged]          # M2 (skeleton)
  gh esteira audit [--json]           # M4 (skeleton)
  gh esteira --version | --help
`;

function parse(argv) {
  const flags = {
    json: false, dryRun: false, force: false, staged: false,
    help: false, version: false, dir: process.cwd(),
  };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--dry-run") flags.dryRun = true;
    else if (a === "--force") flags.force = true;
    else if (a === "--staged") flags.staged = true;
    else if (a === "--dir") flags.dir = path.resolve(argv[++i] ?? process.cwd());
    else if (a === "-h" || a === "--help") flags.help = true;
    else if (a === "-v" || a === "--version") flags.version = true;
    else if (!a.startsWith("-")) positional.push(a);
    else process.stderr.write(`[esteira] unknown flag: ${a}\n`);
  }
  return { flags, positional };
}

function main() {
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
    case "gate":
      process.stderr.write(
        "[esteira] M2 skeleton: gate + playground + reinforced SHA not implemented; commit allowed in M1.\n",
      );
      break;
    case "audit":
      process.stderr.write("[esteira] M4 skeleton: CVE audit cluster not implemented yet.\n");
      break;
    default:
      process.stderr.write(`[esteira] unknown command: ${command}\n\n${HELP}`);
      process.exitCode = 1;
  }
}

main();
