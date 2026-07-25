#!/usr/bin/env bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
git pull 2>/dev/null || true
"$ROOT_DIR/scripts/install.sh"
