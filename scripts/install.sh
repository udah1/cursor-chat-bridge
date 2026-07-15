#!/usr/bin/env bash
# Install cursor-chat-bridge: build, then wire into ~/.cursor (mcp.json, hooks.json, rules).
set -euo pipefail
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$DIR"

# Trust the local CA for outbound HTTPS if a bundle is present (this machine intercepts TLS).
if [ -z "${NODE_EXTRA_CA_CERTS:-}" ] && [ -f "$HOME/vercel-ca-bundle.pem" ]; then
  export NODE_EXTRA_CA_CERTS="$HOME/vercel-ca-bundle.pem"
fi

echo "== install deps =="
npm install

echo "== build =="
npm run build
chmod +x hooks/*.mjs dist/cli.js dist/mcp.js 2>/dev/null || true

echo "== seed config if missing =="
node dist/cli.js init || true

echo "== wire into ~/.cursor =="
node scripts/install.mjs

echo "== doctor =="
node dist/cli.js doctor || true
