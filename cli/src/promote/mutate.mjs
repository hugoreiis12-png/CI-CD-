/**
 * Pure GitOps-tag mutation: finds the `images:` entry for `image` inside a
 * kustomization.yaml and rewrites its `newTag`. Idempotent by contract —
 * equal tag means "no change, no PR".
 */
/**
 * @param {string} kustomizationYaml @param {string} image @param {string} tag
 * @returns {{ changed: true, previous: string, next: string } | { changed: false, reason: "image-not-found" | "already-current", previous?: string }}
 */
export function replaceTag(kustomizationYaml, image, tag) {
  const re = new RegExp(
    `(-\\s*name:\\s*${escapeRegex(image)}\\n\\s*newTag:\\s*)([^\\s#]+)`,
  );
  const match = kustomizationYaml.match(re);
  if (!match) return { changed: false, reason: "image-not-found" };

  const previous = match[2];
  if (previous === tag) return { changed: false, reason: "already-current", previous };

  return {
    changed: true,
    previous,
    next: kustomizationYaml.replace(re, `$1${tag}`),
  };
}

/**
 * Reads the current tag of an image entry without mutating anything
 * (used for dry-run reporting and idempotency checks).
 */
/** @param {string} kustomizationYaml @param {string} image @returns {string | null} */
export function currentTag(kustomizationYaml, image) {
  const match = kustomizationYaml.match(
    new RegExp(`(-\\s*name:\\s*${escapeRegex(image)}\\n\\s*newTag:\\s*)([^\\s#]+)`),
  );
  if (!match) return null;
  const tag = match[2];
  return tag === "SET-BY-GITOPS" ? null : tag;
}

/** @param {string} text */
function escapeRegex(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
