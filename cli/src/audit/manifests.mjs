/** @typedef {import("../types.js").SbomItem} SbomItem */
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

/** All supported manifests found under `root` (dedup by ecosystem+name). */
/** @param {string} root @returns {SbomItem[]} */
export function collectDependencies(root) {
  const [npm, python, go, rust] = [
    collectNpm(root), collectPython(root), collectGo(root), collectRust(root),
  ];
  const seen = new Set();
  const items = [...npm, ...python, ...go, ...rust].filter((item) => {
    const key = `${item.ecosystem}:${item.name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return items;
}

/** @param {SbomItem[]} items */
export function sbomSummary(items) {
  /** @type {Record<string, number>} */
  const byEcosystem = {};
  for (const it of items) byEcosystem[it.ecosystem] = (byEcosystem[it.ecosystem] ?? 0) + 1;
  return { total: items.length, byEcosystem };
}

export { exists };
