#!/usr/bin/env bash
# Esteira dev harness: implement M1, validate, link the gh extension.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/cli"

usage() {
  cat <<'EOF'
Usage: scripts/esteira-dev.sh <command>

  test        Run the analyzer test suite (node --test)
  analyze     Analyze this repo (or --dir <path>) and print the profile
  init-demo   Create a throwaway polyglot project and run init on it
  link        Install the CLI as a local gh extension
  check       test + analyze (default)
EOF
}

cmd="${1:-check}"
case "$cmd" in
  test)
    node --test "$CLI/test"/*.test.mjs
    ;;
  analyze)
    shift || true
    node "$CLI/src/index.mjs" analyze --dir "$ROOT" "$@"
    ;;
  link)
    mkdir -p "$HOME/.local/share/gh/extensions/gh-esteira"
    ln -sf "$CLI/src/index.mjs" "$HOME/.local/share/gh/extensions/gh-esteira/gh-esteira"
    gh esteira --version
    ;;
  init-demo)
    DEMO="$(mktemp -d "${TMPDIR:-/tmp}/esteira-demo.XXXXXX")"
    mkdir -p "$DEMO/apps/web" "$DEMO/k8s" "$DEMO/.github/workflows"
    cat > "$DEMO/package.json" <<'JSON'
{ "name": "demo", "packageManager": "pnpm@9.0.0",
  "scripts": { "test": "vitest run", "lint": "eslint .", "build": "tsc -p ." },
  "dependencies": { "next": "14.0.0" },
  "devDependencies": { "typescript": "5.0.0", "vitest": "1.0.0" } }
JSON
    printf 'packages:\n  - apps/*\n' > "$DEMO/pnpm-workspace.yaml"
    : > "$DEMO/pnpm-lock.yaml"
    printf 'FROM node:20-alpine\n' > "$DEMO/Dockerfile"
    printf 'apiVersion: v1\nkind: Service\n' > "$DEMO/k8s/service.yaml"
    printf 'name: ci\n' > "$DEMO/.github/workflows/ci.yml"
    echo "Demo project: $DEMO"
    node "$CLI/src/index.mjs" init --dir "$DEMO" --dry-run
    node "$CLI/src/index.mjs" analyze --dir "$DEMO"
    ;;
  check)
    node --test "$CLI/test"/*.test.mjs
    node "$CLI/src/index.mjs" analyze --dir "$ROOT"
    ;;
  *)
    usage
    exit 1
    ;;
esac
