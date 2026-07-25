#!/usr/bin/env bash
# =============================================================================
# scripts/install.sh - Install dependencies & build monorepo packages
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

echo "=== Installing Next.js Frontend Dependencies ==="
cd "$ROOT_DIR/frontend"
npm install

echo "=== Setting up FastAPI AI Python Virtual Environment ==="
cd "$ROOT_DIR/backend_ai"
if [ ! -d "venv" ]; then
    python3 -m venv --system-site-packages venv
fi
source venv/bin/activate
pip install -r requirements.txt

echo "=== Building ROS 2 Workspace ==="
cd "$ROOT_DIR/ros2_ws"
source /opt/ros/jazzy/setup.bash
colcon build --symlink-install

echo "=== Installation & Build Complete ==="
