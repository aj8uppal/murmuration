#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
PORT="${1:-8173}"
exec python3 tools/devserver.py "$PORT" .
