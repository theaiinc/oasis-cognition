#!/usr/bin/env bash
# Install Node deps for all apps (run from repo root).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
echo "==> api-gateway"
(cd "$ROOT/apps/api-gateway" && npm install)
echo "==> oasis-ui-react"
(cd "$ROOT/apps/oasis-ui-react" && npm install)
echo "Done. Tip: use Node >=20.19 (or keep engine-strict=false in each app .npmrc)."
