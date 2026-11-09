/**
 * Maps each Esteira rule to the Cloudflare security-audit skill's vocabulary:
 * the attack class it hunts, the verdict a static match can honestly support,
 * and what an owner must observe before calling it confirmed.
 *
 * Verdict policy (skill, SKILL.md "Separate priority from certainty"):
 *   - `confirmed` only when the match itself is the observed boundary result
 *     (committed credential material is readable by every repository reader);
 *   - everything else is `needs_validation`: a pattern match is a lead, not a
 *     demonstrated exploit, and carries no severity.
 *   - operational results (playground, gate/config errors, large files) are
 *     not vulnerabilities and are not exported.
 */

/**
 * @typedef {object} RuleMeta
 * @property {string} attackClass skill block reference, e.g. "ATTACK-CLASSES.md#Injection"
 * @property {"confirmed" | "needs_validation"} verdict
 * @property {string} rootCause
 * @property {string} intended
 * @property {string} fix
 * @property {string} [blocker] decisive fact a static match cannot establish (needs_validation)
 * @property {string} [plan] bounded local step that resolves the blocker
 */

const SECRET = /** @type {const} */ ({
  attackClass: "ATTACK-CLASSES.md#Cryptography and secrets",
  verdict: "confirmed",
  rootCause: "Credential material is committed to version control, where every reader of the repository, its forks and its clones can copy it.",
  intended: "Credentials live in a secret manager or CI secret store and reach code only at runtime through environment or mounted files.",
  fix: "Revoke and rotate the credential now, remove it from the change (and history if it was pushed), and load it from a secret manager or CI secret instead.",
});

const DANGEROUS = {
  attackClass: "ATTACK-CLASSES.md#Injection",
  verdict: /** @type {const} */ ("needs_validation"),
  intended: "Untrusted input never reaches code execution, shell, file-system or query sinks without validation and parameterisation.",
  blocker: "A static pattern match does not establish that lower-trust input reaches this sink.",
  plan: "Trace the arguments of the flagged call back to their sources; add a unit test that passes attacker-shaped input and asserts the sink rejects or escapes it.",
};

const CI = {
  verdict: /** @type {const} */ ("needs_validation"),
  blocker: "The effect depends on which events trigger the workflow, which secrets exist and the repository's Actions settings, none of which a source match can observe.",
};

/** @type {Record<string, RuleMeta>} */
export const CATALOG = {
  "secret-aws": SECRET,
  "secret-github": SECRET,
  "secret-npm": SECRET,
  "secret-google": SECRET,
  "secret-slack": SECRET,
  "secret-private-key": SECRET,
  "secret-hardcoded-credential": {
    ...SECRET,
    verdict: "needs_validation",
    rootCause: "A credential-looking literal is assigned in source.",
    blocker: "The heuristic cannot tell whether the literal is a live credential or a non-secret identifier.",
    plan: "Check the value against the issuing system (owner-side); if it is live, treat it as a committed credential and rotate it.",
  },
  "dangerous-eval": { ...DANGEROUS, rootCause: "Dynamic code evaluation (eval / new Function) is added.", fix: "Replace dynamic evaluation with explicit parsing or a dispatch table." },
  "dangerous-child-process": { ...DANGEROUS, rootCause: "A shell command is built from a single string and run through a shell.", fix: "Use execFile/spawn with an argv array and no shell." },
  "dangerous-sql-concat": { ...DANGEROUS, rootCause: "A SQL statement is built by string concatenation.", fix: "Use parameterised queries." },
  "dangerous-curl-pipe": {
    ...DANGEROUS, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Mutable and unbound build inputs",
    rootCause: "A remote script is piped straight into a shell, so whoever controls that URL controls the build.",
    fix: "Download to a file, verify a pinned checksum or signature, then execute.",
    blocker: "Who controls the remote URL and whether its content is integrity-checked elsewhere is outside the source.",
    plan: "Pin the script by checksum in the repository and fail the step when it differs.",
  },
  "dangerous-rm-rf": { ...DANGEROUS, attackClass: "ATTACK-CLASSES.md#Resource and file handling", rootCause: "A forced recursive delete targets / or ~.", fix: "Scope deletes to a validated, non-empty directory variable." },
  "dangerous-chmod-777": { ...DANGEROUS, attackClass: "ATTACK-CLASSES.md#Resource and file handling", rootCause: "World-writable permissions are set.", fix: "Grant the minimum mode the owning process needs." },
  "dangerous-insecure-tls": { ...DANGEROUS, attackClass: "ATTACK-CLASSES.md#Cryptography and secrets", rootCause: "TLS certificate verification is disabled.", fix: "Keep verification on; trust a private CA explicitly instead of disabling checks." },
  "ci-privileged-pr-checkout": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Untrusted code in a privileged workflow",
    rootCause: "A pull_request_target/workflow_run workflow checks out the pull request head, so contributor code runs with the base repository's secrets and write token.",
    intended: "Privileged workflows never execute code from an untrusted ref.",
    fix: "Use the pull_request event for untrusted code, or split into an unprivileged build and a privileged job that only consumes digest-bound artifacts.",
    plan: "In a throwaway fork, open a PR whose build script prints whether secrets are set (never their values) and observe the privileged run.",
  },
  "ci-expression-injection": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Workflow command and expression confusion",
    rootCause: "A contributor-controlled ${{ github.event… }} value is expanded into a run: script before the shell parses it.",
    intended: "Untrusted event fields reach scripts only as quoted environment variables.",
    fix: "Move the expression into env: (FOO: ${{ … }}) and reference \"$FOO\" in the script.",
    plan: "Run the workflow locally (e.g. with act) with an event payload whose title is `a\"; echo INJECTED; #` and check whether INJECTED is printed.",
  },
  "ci-floating-action-privileged": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Mutable and unbound build inputs",
    rootCause: "A third-party action is referenced by a mutable tag or branch inside a workflow that holds write scopes or secrets.",
    intended: "Code that receives write scopes or secrets is bound to an immutable, reviewed commit.",
    fix: "Pin every uses: to a full 40-character commit SHA (gh esteira pin) and review updates.",
    plan: "Run `gh esteira pin --dry-run` and confirm every flagged line would be rewritten to a SHA.",
  },
  "ci-floating-action": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Mutable and unbound build inputs",
    rootCause: "A third-party action is referenced by a mutable tag or branch.",
    intended: "Build inputs are bound to immutable commits.",
    fix: "Pin the action to a full commit SHA (gh esteira pin).",
    plan: "Run `gh esteira pin --dry-run`.",
  },
  "ci-write-all": {
    ...CI, attackClass: "SUPPLY-CHAIN-AND-RELEASE.md#Automation identity overreach",
    rootCause: "permissions: write-all gives every step of the workflow every write scope.",
    intended: "Each job receives only the scopes its operation needs.",
    fix: "Set workflow permissions to contents: read and grant write scopes per job.",
    plan: "List each job's real operations and compare them with the granted scopes.",
  },
};

/** Rules that describe the gate's own operation, not a vulnerability. */
export const OPERATIONAL = /^(?:playground-|gate-|check-error$|large-file$)/;
