#!/usr/bin/env bash
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
echo "=== Cleaning build artifacts and cache ==="
rm -rf "$ROOT_DIR/frontend/.next" "$ROOT_DIR/frontend/out" 2>/dev/null || true
rm -rf "$ROOT_DIR/ros2_ws/build" "$ROOT_DIR/ros2_ws/install" "$ROOT_DIR/ros2_ws/log" 2>/dev/null || true
rm -rf "$ROOT_DIR/backend_ai/__pycache__" "$ROOT_DIR/logs/*" 2>/dev/null || true
echo "Clean completed!"
