import fs from "node:fs";
import path from "node:path";

export const join = path.join;

/** First line of a thrown value's message (catch variables are `unknown`). */
export const errorLine = (/** @type {unknown} */ error) =>
  (error instanceof Error ? error.message : String(error)).split("\n")[0];
export const exists = (/** @type {string} */ root, /** @type {string} */ rel) => fs.existsSync(join(root, rel));

export const isDir = (/** @type {string} */ root, /** @type {string} */ rel) => {
  try { return fs.statSync(join(root, rel)).isDirectory(); } catch { return false; }
};

/** @returns {string | null} */
export const readFile = (/** @type {string} */ root, /** @type {string} */ rel) => {
  try { return fs.readFileSync(join(root, rel), "utf8"); } catch { return null; }
};

/** Parsed JSON, or null when missing/invalid. @returns {any} */
export const readJson = (/** @type {string} */ root, /** @type {string} */ rel) => {
  const t = readFile(root, rel);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
};

export const writeFile = (/** @type {string} */ root, /** @type {string} */ rel, /** @type {string} */ content) => {
  const abs = join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

export const listDir = (/** @type {string} */ root, rel = ".") => {
  try { return fs.readdirSync(join(root, rel), { withFileTypes: true }); } catch { return []; }
};

export const firstOf = (/** @type {any[]} */ ...candidates) => candidates.find(Boolean) ?? null;

export const writeIfMissing = (/** @type {string} */ root, /** @type {string} */ rel, /** @type {string} */ content) => {
  if (exists(root, rel)) return { written: false, reason: "exists" };
  writeFile(root, rel, content);
  return { written: true, reason: "created" };
};

export const appendUniqueLines = (/** @type {string} */ root, /** @type {string} */ rel, /** @type {string[]} */ lines) => {
  const current = readFile(root, rel) ?? "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length === 0) return { changed: false, added: [] };
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  writeFile(root, rel, `${current}${sep}${missing.join("\n")}\n`);
  return { changed: true, added: missing };
};
