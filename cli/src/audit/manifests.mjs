/** @typedef {import("../types.js").SbomItem} SbomItem */
import fs from "node:fs";
import path from "node:path";
import { readJson, readFile, exists } from "../lib/fs-tools.mjs";

/**
 * Dependency harvest from the manifests the profile detectors already know
 * about. Every entry keeps its manifest source so findings can point at the
 * fix location. Exact versions when a lockfile pins them; otherwise the
 * declared range is kept and the batch query uses a conservative floor.
 */

/** @param {any} pkg package.json @returns {{ name: string, range: string, kind: "prod" | "dev" }[]} */
function npmDeps(pkg) {
  return [
    ...Object.entries(pkg.dependencies ?? {}).map(([name, range]) => ({ name, range: String(range), kind: /** @type {const} */ ("prod") })),
    ...Object.entries(pkg.optionalDependencies ?? {}).map(([name, range]) => ({ name, range: String(range), kind: /** @type {const} */ ("prod") })),
    ...Object.entries(pkg.devDependencies ?? {}).map(([name, range]) => ({ name, range: String(range), kind: /** @type {const} */ ("dev") })),
  ];
}

/** @param {string} root @returns {SbomItem[]} */
export function collectNpm(root) {
  const pkg = readJson(root, "package.json");
  if (!pkg) return [];
  /** @type {Map<string, string>} */
  const lockVersions = new Map();
  const lock = readJson(root, "package-lock.json");
  if (lock?.packages) {
    for (const [key, entry] of Object.entries(/** @type {Record<string, { version?: string }>} */ (lock.packages))) {
      if (key && entry?.version) {
        lockVersions.set(key.split("node_modules/").pop() ?? key, entry.version);
      }
    }
  }
  return npmDeps(pkg).map(({ name, range, kind }) => ({
    ecosystem: /** @type {const} */ ("npm"),
    name,
    version: lockVersions.get(name) ?? null,
    range: lockVersions.has(name) ? null : range,
    source: "package.json",
    direct: true,
    kind,
  }));
}

/** @param {string} root @returns {SbomItem[]} */
export function collectPython(root) {
  /** @type {SbomItem[]} */
  const items = [];
  const req = readFile(root, "requirements.txt");
  if (req) {
    for (const line of req.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("-")) continue;
      const name = trimmed.split(/[<>=~!,;\s]/)[0];
      if (!name) continue;
      const floor = trimmed.match(/([0-9]+(?:\.[0-9]+){0,2})/)?.[1] ?? null;
      items.push({
        ecosystem: "PyPI", name, version: floor, range: floor ? null : trimmed,
        source: "requirements.txt", direct: true, kind: "prod",
      });
    }
  }
  const pyproject = readFile(root, "pyproject.toml");
  if (pyproject) {
    for (const match of pyproject.matchAll(/^([\w.-]+)\s*=\s*"[^"]*([0-9][0-9.]*)/gim)) {
      items.push({
        ecosystem: "PyPI", name: match[1], version: match[2], range: null,
        source: "pyproject.toml", direct: true, kind: "prod",
      });
    }
  }
  return items;
}

/** @param {string} root @returns {SbomItem[]} */
export function collectGo(root) {
  const mod = readFile(root, "go.mod");
  if (!mod) return [];
  /** @type {SbomItem[]} */
  const items = [];
  for (const line of mod.split("\n")) {
    const match = line.match(/^\t([^\s]+)\s+(v[0-9][^\s]+)/);
    if (match) {
      items.push({
        ecosystem: "Go", name: match[1], version: match[2], range: null,
        source: "go.mod", direct: false, kind: "prod",
      });
    }
  }
  return items;
}

/** @param {string} root @returns {SbomItem[]} */
export function collectRust(root) {
  const cargo = readFile(root, "Cargo.toml");
  if (!cargo) return [];
  /** @type {SbomItem[]} */
  const items = [];
  let inDeps = false;
  for (const line of cargo.split("\n")) {
    if (/^\[/.test(line.trim())) inDeps = line.trim() === "[dependencies]";
    else if (inDeps) {
      const match = line.match(/^([\w-]+)\s*=\s*"([0-9][^"]*)"/);
      if (match) {
        items.push({
          ecosystem: "crates.io", name: match[1], version: match[2], range: null,
          source: "Cargo.toml", direct: true, kind: "prod",
        });
      }
    }
  }
  return items;
}

// Folders that never hold the project's own manifests (installed or generated code).
const SKIP_FOLDERS = new Set(["node_modules", ".git", ".venv", "venv", "vendor", "target", "dist", "build", "coverage", "__pycache__", ".esteira"]);
const MAX_DEPTH = 4;

/**
 * The project root and every subfolder below it (bounded), so a subproject such
 * as `cli/` with its own package.json is audited too.
 * @param {string} root @returns {string[]} posix paths relative to root ("" is the root)
 */
export function manifestFolders(root) {
  /** @type {string[]} */
  const found = [""];
  /** @param {string} rel @param {number} depth */
  const walk = (rel, depth) => {
    if (depth >= MAX_DEPTH) return;
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || SKIP_FOLDERS.has(entry.name) || entry.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      found.push(child);
      walk(child, depth + 1);
    }
  };
  walk("", 0);
  return found;
}

/**
 * All supported manifests under `root`, including subprojects. Each item's
 * `source` names the manifest it came from (e.g. `cli/package.json`).
 * @param {string} root @returns {SbomItem[]}
 */
export function collectDependencies(root) {
  const items = manifestFolders(root).flatMap((folder) => {
    const prefix = folder ? `${folder}/` : "";
    return [...collectNpm(path.join(root, folder)), ...collectPython(path.join(root, folder)), ...collectGo(path.join(root, folder)), ...collectRust(path.join(root, folder))]
      .map((item) => ({ ...item, source: `${prefix}${item.source}` }));
  });
  const seen = new Set();
  return items.filter((item) => {
    const key = `${item.ecosystem}:${item.name}:${item.source}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** @param {SbomItem[]} items */
export function sbomSummary(items) {
  /** @type {Record<string, number>} */
  const byEcosystem = {};
  for (const it of items) byEcosystem[it.ecosystem] = (byEcosystem[it.ecosystem] ?? 0) + 1;
  return { total: items.length, byEcosystem };
}

export { exists };
