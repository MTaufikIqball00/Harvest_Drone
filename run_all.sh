#!/usr/bin/env bash
# =============================================================================
# run_all.sh - Root Entrypoint for Drone-Stack Monorepo
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "$ROOT_DIR/scripts/start.sh" "$@"
