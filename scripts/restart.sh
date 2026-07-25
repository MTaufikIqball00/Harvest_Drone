#!/usr/bin/env bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT_DIR/scripts/stop.sh"
sleep 2
"$ROOT_DIR/scripts/start.sh"
