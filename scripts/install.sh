#!/usr/bin/env bash
# Local/dev install: build from source, then wire into ~/.cursor via the CLI installer.
# End users don't need this — they can just run: npx cursor-chat-bridge@latest install
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

echo "== install deps =="
npm install

echo "== build =="
npm run build
chmod +x hooks/*.mjs dist/cli.js dist/mcp.js 2>/dev/null || true

echo "== wire into ~/.cursor =="
node dist/cli.js install

echo "== doctor =="
node dist/cli.js doctor || true
