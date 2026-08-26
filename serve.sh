#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8173}"
echo "→ http://localhost:$PORT"
exec python3 -m http.server "$PORT" --bind 127.0.0.1
