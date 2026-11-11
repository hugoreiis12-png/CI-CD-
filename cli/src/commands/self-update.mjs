import { spawnSync } from "node:child_process";

// Where the extension is published. Tags are the release source of truth.
export const EXTENSION_REPO = "hugoreiis12-png/gh-esteira";
const EXTENSION_NAME = "esteira";

/** @typedef {{ status: number | null, stdout: string }} GhResult */
/** @typedef {(args: string[], options?: { inherit?: boolean }) => GhResult} GhRunner */

/** Runs `gh`; `inherit` shows its output to the user (install/upgrade progress). @type {GhRunner} */
export function runGh(args, { inherit = false } = {}) {
  const result = spawnSync("gh", args, {
    encoding: "utf8",
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return { status: result.status, stdout: result.stdout ?? "" };
}

/** `v1.2.3` or `1.2.3` → [1, 2, 3]; anything else → null. @param {string} version */
export function parseVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(version.trim());
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

/** Negative if a < b, positive if a > b, 0 when equal or unparsable. @param {string} a @param {string} b */
export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return 0;
  for (let i = 0; i < 3; i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return 0;
}

/** Highest semver tag among `names`, or null when none is a version. @param {string[]} names */
export function highestTag(names) {
  return names.filter((name) => parseVersion(name)).sort(compareVersions).pop() ?? null;
}

/** Latest published version of the extension (from its tags), or null when unreachable. @param {GhRunner} [gh] */
export function latestVersion(gh = runGh) {
  const result = gh(["api", `repos/${EXTENSION_REPO}/tags`, "--paginate", "--jq", ".[].name"]);
  if (result.status !== 0) return null;
  return highestTag(result.stdout.split("\n").map((line) => line.trim()).filter(Boolean));
}

/** Version of the extension that `gh esteira` runs now (asks the installed copy). @param {GhRunner} [gh] */
export function installedVersion(gh = runGh) {
  const result = gh([EXTENSION_NAME, "--version"]);
  if (result.status !== 0) return null;
  // The CLI prints "0.2.1"; tags are "v0.2.1". Compare in tag form.
  const version = result.stdout.trim();
  return version.startsWith("v") ? version : `v${version}`;
}

/**
 * Brings the extension to `target`: `gh extension upgrade` first (works when
 * unpinned); if it is still old (pinned), reinstalls pinned to `target`.
 * @param {string} target tag such as v0.2.2
 * @param {GhRunner} [gh]
 * @returns {{ ok: boolean, method: "upgrade" | "reinstall-pinned" | "none", version: string | null }}
 */
export function upgradeExtension(target, gh = runGh) {
  gh(["extension", "upgrade", EXTENSION_NAME], { inherit: true });
  if (installedVersion(gh) === target) return { ok: true, method: "upgrade", version: target };
  gh(["extension", "remove", EXTENSION_NAME], { inherit: true });
  const installed = gh(["extension", "install", EXTENSION_REPO, "--pin", target], { inherit: true });
  const version = installedVersion(gh);
  return { ok: installed.status === 0 && version === target, method: "reinstall-pinned", version };
}

/**
 * The check `gh esteira update` runs first: is a newer extension published?
 * Returns the target to install, or null when current or unknown (offline).
 * @param {string} installed version of the running CLI
 * @param {GhRunner} [gh]
 */
export function newerVersionAvailable(installed, gh = runGh) {
  const latest = latestVersion(gh);
  return latest && compareVersions(latest, installed) > 0 ? latest : null;
}
