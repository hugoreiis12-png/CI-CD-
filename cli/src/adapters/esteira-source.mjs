import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Where generated workflows get the Esteira CLI from: the extension's own
// repository (users install it with `gh extension install`; CI fetches it at a
// pinned ref and runs node, so no gh extension state is needed on runners).
export const ESTEIRA_REPO = "hugoreiis12-png/gh-esteira";

const pkg = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json"), "utf8"));
/** Release tag of the CLI generating the workflow; `gh esteira pin` rewrites it to a commit SHA. */
export const ESTEIRA_REF = `v${pkg.version}`;

/** `env:` lines naming the pinned CLI source (indent = env block indentation). */
export const sourceEnv = (indent = "  ") =>
  `${indent}ESTEIRA_REPO: ${ESTEIRA_REPO}\n${indent}ESTEIRA_REF: ${ESTEIRA_REF} # gh esteira pin rewrites this to a commit SHA\n`;

/**
 * Step that fetches the CLI at ESTEIRA_REF and exports $ESTEIRA. It runs with
 * no secrets and fails the job on any error (no `|| true`).
 */
export const installStep = `      - name: Install Esteira (pinned, no secrets)
        run: |
          git init -q "$RUNNER_TEMP/esteira"
          git -C "$RUNNER_TEMP/esteira" fetch -q --depth 1 "https://github.com/$ESTEIRA_REPO.git" "$ESTEIRA_REF"
          git -C "$RUNNER_TEMP/esteira" checkout -q FETCH_HEAD
          echo "ESTEIRA=$RUNNER_TEMP/esteira/cli/src/index.mjs" >> "$GITHUB_ENV"
`;
