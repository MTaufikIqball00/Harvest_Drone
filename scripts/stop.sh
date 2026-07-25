#!/usr/bin/env bash
# =============================================================================
# scripts/stop.sh - Stop all monorepo background processes & release ports
# =============================================================================

echo "=== Stopping Drone-Stack Monorepo Services ==="

kill_port() {
    local port=$1
    local pid=$(ss -tulpn | grep ":${port} " | awk '{print $7}' | cut -d',' -f2 | cut -d'=' -f2 | head -n1)
    if [ -n "$pid" ]; then
        echo "Killing process on port $port (PID: $pid)..."
        kill -9 "$pid" 2>/dev/null || true
    fi
}

# Release ports
kill_port 3000
kill_port 8000
kill_port 9090
kill_port 8888
kill_port 14540
kill_port 14550

# Terminate process names
pkill -f "uvicorn api:app" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
pkill -f "rosbridge_websocket" 2>/dev/null || true
pkill -f "MicroXRCEAgent" 2>/dev/null || true
pkill -f "dashboard_bridge_node" 2>/dev/null || true
pkill -f "px4" 2>/dev/null || true
pkill -f "gz" 2>/dev/null || true

echo "=== All services stopped cleanly ==="
