#!/bin/bash
# Thin wrapper to invoke TypeScript CLI commands via tsx.
# Usage: run-ts.sh <command> [args...]
# Example: run-ts.sh drift
# Outputs JSON to stdout, errors to stderr.

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Use project-local tsx, fall back to npx
TSX="$PROJECT_ROOT/node_modules/.bin/tsx"

if [ -x "$TSX" ]; then
  exec "$TSX" "$PROJECT_ROOT/src/cli/index.ts" "$@"
else
  exec npx tsx "$PROJECT_ROOT/src/cli/index.ts" "$@"
fi
