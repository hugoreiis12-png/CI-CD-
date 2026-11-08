import fs from "node:fs";
import path from "node:path";

export const join = path.join;
export const exists = (root, rel) => fs.existsSync(join(root, rel));

export const isDir = (root, rel) => {
  try { return fs.statSync(join(root, rel)).isDirectory(); } catch { return false; }
};

export const readFile = (root, rel) => {
  try { return fs.readFileSync(join(root, rel), "utf8"); } catch { return null; }
};

export const readJson = (root, rel) => {
  const t = readFile(root, rel);
  if (t == null) return null;
  try { return JSON.parse(t); } catch { return null; }
};

export const writeFile = (root, rel, content) => {
  const abs = join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
};

export const listDir = (root, rel = ".") => {
  try { return fs.readdirSync(join(root, rel), { withFileTypes: true }); } catch { return []; }
};

export const firstOf = (...candidates) => candidates.find(Boolean) ?? null;

export const writeIfMissing = (root, rel, content) => {
  if (exists(root, rel)) return { written: false, reason: "exists" };
  writeFile(root, rel, content);
  return { written: true, reason: "created" };
};

export const appendUniqueLines = (root, rel, lines) => {
  const current = readFile(root, rel) ?? "";
  const have = new Set(current.split(/\r?\n/).map((l) => l.trim()));
  const missing = lines.filter((l) => !have.has(l));
  if (missing.length === 0) return { changed: false, added: [] };
  const sep = current && !current.endsWith("\n") ? "\n" : "";
  writeFile(root, rel, `${current}${sep}${missing.join("\n")}\n`);
  return { changed: true, added: missing };
};
