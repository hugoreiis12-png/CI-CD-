/** @typedef {import("../types.js").CommandKey} CommandKey */
/** @typedef {import("../types.js").DetectorFinding} DetectorFinding */
/** @typedef {import("../types.js").Gap} Gap */
/** @typedef {import("../types.js").InfraFinding} InfraFinding */
/** @typedef {import("../types.js").InfraProfile} InfraProfile */
/** @typedef {import("../types.js").LanguageFinding} LanguageFinding */
/** @typedef {import("../types.js").Profile} Profile */
/** @typedef {import("../types.js").Subproject} Subproject */
import { fingerprint, IGNORED_DIRS } from "./fingerprint.mjs";
import { detectors } from "../detectors/index.mjs";
import { isDir, exists, listDir, errorLine } from "./fs-tools.mjs";
import { installCommandFor } from "./install.mjs";

/** @type {CommandKey[]} */
export const COMMAND_KEYS = ["lint", "typecheck", "test", "build"];

const emptyCommands = () => /** @type {Record<CommandKey, string | null>} */ ({ lint: null, typecheck: null, test: null, build: null });

/**
 * `npm run X` of a subproject, rewritten to run from the root (`--prefix`).
 * Other forms (`npx tsc`) are not rebased: they would run in the wrong folder.
 * @param {string} dir @param {string | null | undefined} cmd
 */
const rootedNpmScript = (dir, cmd) => (cmd?.startsWith("npm run ") ? `npm --prefix ${dir} run ${cmd.slice("npm run ".length)}` : null);

/**
 * Commands for a repository whose only project lives in one subfolder (cli/).
 * Several subprojects are not chained automatically: the gap stays visible.
 * @param {import("../types.js").Subproject[]} subprojects
 * @returns {Record<CommandKey, string | null>}
 */
export function commandsFromSubprojects(subprojects) {
  const commands = emptyCommands();
  if (subprojects.length !== 1) return commands;
  const [sub] = subprojects;
  const own = sub.languages[0]?.commands ?? {};
  for (const key of COMMAND_KEYS) commands[key] = rootedNpmScript(sub.path, own[key]);
  return commands;
}

/** @type {InfraProfile} */
const EMPTY_INFRA = {
  containers: false, kubernetes: false, helm: false, terraform: false,
  ansible: false, argocd: false, ciProviders: [], hasPipelines: false,
};

/**
 * Runs every detector on one folder.
 * @param {string} root
 * @param {import("../types.js").FileFingerprint} files
 * @param {string[]} warnings
 */
function detectAll(root, files, warnings) {
  /** @type {DetectorFinding[]} */
  const findings = [];
  for (const detect of detectors) {
    try {
      const found = detect(root, files);
      if (found) findings.push(found);
    } catch (error) {
      warnings.push(`${detect.name}: ${errorLine(error)}`);
    }
  }
  return findings.sort((a, b) => b.confidence - a.confidence);
}

/**
 * Projects one level below a root without a manifest of its own (an umbrella
 * folder, or a repo whose code lives in a sub-folder such as cli/).
 * @param {string} root
 * @param {string[]} warnings
 * @returns {Subproject[]}
 */
function findSubprojects(root, warnings) {
  /** @type {Subproject[]} */
  const found = [];
  for (const entry of listDir(root)) {
    if (!entry.isDirectory() || entry.name.startsWith(".") || IGNORED_DIRS.has(entry.name)) continue;
    const dir = `${root}/${entry.name}`;
    const languages = detectAll(dir, fingerprint(dir, { maxFiles: 5000 }), warnings)
      .filter(/** @returns {f is LanguageFinding} */ (f) => f.type === "language")
      .map((f) => ({
        id: f.id,
        packageManager: f.packageManager ?? null,
        runtime: f.runtime ?? {},
        commands: f.commands ?? {},
        installCommand: installCommandFor(root, entry.name, f.packageManager ?? null),
      }));
    if (languages.length) found.push({ path: entry.name, languages, gitRepo: exists(dir, ".git") });
  }
  return found;
}

/** Runs every detector, merges findings into a stable ProjectProfile. */
/** @param {string} root @returns {Profile} */
export function buildProfile(root) {
  const files = fingerprint(root);
  /** @type {string[]} */
  const warnings = [];
  const findings = detectAll(root, files, warnings);

  const languages = findings
    .filter(/** @returns {f is LanguageFinding} */ (f) => f.type === "language")
    .map((f) => ({
      id: f.id,
      confidence: f.confidence,
      runtime: f.runtime ?? {},
      packageManager: f.packageManager ?? null,
      frameworks: f.frameworks ?? [],
      evidence: f.evidence ?? [],
      commands: f.commands ?? {},
      installCommand: installCommandFor(root, "", f.packageManager ?? null),
    }));

  const infra = findings.find(/** @returns {f is InfraFinding} */ (f) => f.type === "infra")?.infra ?? { ...EMPTY_INFRA };
  const workspacesTool = findings.map((f) => f.workspaces).find(Boolean) ?? null;
  const layout = ["apps", "packages", "services", "libs", "modules"].filter((d) => isDir(root, d));

  const subprojects = languages.length === 0 ? findSubprojects(root, warnings) : [];
  const fromSubprojects = commandsFromSubprojects(subprojects);

  const commands = emptyCommands();
  for (const key of COMMAND_KEYS) {
    commands[key] = languages.map((l) => l.commands[key]).find(Boolean) ?? fromSubprojects[key] ?? null;
  }

  /** @type {Gap[]} */
  const gaps = [];
  if (languages.length === 0) {
    const repos = subprojects.filter((p) => p.gitRepo).map((p) => p.path);
    const inside = subprojects.filter((p) => !p.gitRepo).map((p) => p.path);
    gaps.push({
      id: "unknown-stack",
      message: subprojects.length === 0
        ? "Nenhum manifesto de linguagem (package.json, pyproject.toml, go.mod…) na raiz nem nas subpastas."
        : "Nenhum manifesto na raiz; os projetos estão nas subpastas (veja Subprojetos)."
          + (repos.length ? ` ${repos.join(", ")} ${repos.length > 1 ? "são repositórios git próprios" : "é um repositório git próprio"}: rode \`gh esteira init\` dentro de cada um.` : "")
          + (inside.length ? ` Para ${inside.join(", ")} (mesmo repositório), configure profile.commands no .esteira/project.json, ex.: "npm --prefix ${inside[0]} test".` : ""),
    });
  }
  if (!commands.test) {
    gaps.push({ id: "no-test-command", message: "Nenhum comando de teste detectado — o playground do gate precisa de um (profile.commands.test)." });
  }
  if (!commands.lint) {
    gaps.push({ id: "no-lint-command", message: "Nenhum comando de lint detectado — o gate usa só as checagens embutidas." });
  }

  return {
    schemaVersion: 1,
    root,
    generatedAt: new Date().toISOString(),
    files: { total: files.total, signatures: files.counts },
    languages,
    monorepo: { isMonorepo: Boolean(workspacesTool), tool: workspacesTool, layout },
    infra,
    commands,
    gaps,
    warnings,
    subprojects,
  };
}
