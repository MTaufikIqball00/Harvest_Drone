#!/usr/bin/env bash
# =============================================================================
# scripts/start.sh - Main Monorepo Process Orchestrator
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p "$ROOT_DIR/logs"

# Ensure environment variables
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

MODE="${1:-services}"

echo "=== Cleaning up previous background processes ==="
bash "$ROOT_DIR/scripts/stop.sh" 2>/dev/null || true
sleep 1

echo "=== Starting MySQL Service ==="
sudo service mysql start 2>/dev/null || true
if [ -f "database/drone_schema.sql" ]; then
    echo "Applying MySQL Drone & Harvest Schema..."
    sudo mysql < database/drone_schema.sql 2>/dev/null || true
fi

echo "=== Starting FastAPI AI Backend Service (Port 8000) ==="
cd "$ROOT_DIR/backend_ai"
source venv/bin/activate 2>/dev/null || true
nohup python3 -m uvicorn api:app --host 0.0.0.0 --port 8000 > "$ROOT_DIR/logs/fastapi.log" 2>&1 &
echo $! > "$ROOT_DIR/logs/fastapi.pid"

echo "=== Starting ROS 2 Environment & Bridges ==="
source /opt/ros/jazzy/setup.bash 2>/dev/null || true
if [ -f "$ROOT_DIR/ros2_ws/install/setup.bash" ]; then
    source "$ROOT_DIR/ros2_ws/install/setup.bash"
fi

# Micro XRCE-DDS Agent
nohup MicroXRCEAgent udp4 -p 8888 > "$ROOT_DIR/logs/xrce_agent.log" 2>&1 &

# ROSBridge Server
nohup ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:=9090 > "$ROOT_DIR/logs/rosbridge.log" 2>&1 &

# Dashboard Bridge Node
# Pilih varian node sesuai flight stack yang akan dijalankan:
#   --gazebo  -> PX4 SITL, jembatannya uORB/XRCE-DDS  (dashboard_bridge_node_px4)
#   selain itu-> ArduPilot SITL, jembatannya MAVROS   (dashboard_bridge_node)
# Menjalankan varian yang salah membuat dashboard tidak menerima telemetry apa
# pun: node MAVROS menunggu /mavros/*, sedangkan PX4 hanya mem-publish /fmu/*.
if [ "$MODE" == "--gazebo" ] || [ "$MODE" == "gazebo" ]; then
    FLIGHT_STACK="px4"
else
    FLIGHT_STACK="ardupilot"
fi
echo "Dashboard bridge menggunakan flight stack: $FLIGHT_STACK"

# MAVROS — WAJIB untuk jalur ArduPilot.
#
# BUG (sudah ada sebelumnya): tidak ada satu pun script di repo ini yang pernah
# menjalankan MAVROS. Padahal dashboard_bridge_node berlangganan
# /mavros/local_position/pose, /mavros/state, dan /mavros/battery, serta
# memanggil service /mavros/cmd/arming & /mavros/set_mode.
#
# Tanpa MAVROS, topik-topik itu TIDAK PERNAH ADA, sehingga:
#   - self.current_pose selamanya None
#   - tombol TAKEOFF selalu ditolak dengan "Tidak ada local position."
#   - dashboard tidak pernah menampilkan posisi/baterai/mode drone
#
# PX4 tidak memerlukan ini karena memakai jembatan uXRCE-DDS (/fmu/*).
if [ "$FLIGHT_STACK" == "ardupilot" ]; then
    # Port 14551 khusus MAVROS; 14550 dibiarkan untuk Mission Planner/QGC.
    MAVROS_FCU_URL="${MAVROS_FCU_URL:-udp://:14551@}"
    echo "=== Starting MAVROS (fcu_url=$MAVROS_FCU_URL) ==="
    nohup ros2 launch mavros apm.launch \
        fcu_url:="$MAVROS_FCU_URL" > "$ROOT_DIR/logs/mavros.log" 2>&1 &
fi

# Pakai `ros2 launch`, BUKAN `ros2 run`. Dengan `ros2 run` file launch tidak
# pernah dibaca sehingga seluruh parameter tuning di dalamnya mati — antara lain
# planner_resolution jatuh ke default kode 1.0 yang membuat satu kali A*
# memakan ~1.6 detik CPU (seharusnya 5.0).
nohup ros2 launch drone_dashboard_bridge dashboard_bridge.launch.py \
    flight_stack:="$FLIGHT_STACK" > "$ROOT_DIR/logs/dashboard_bridge.log" 2>&1 &

echo "=== Starting Next.js Frontend Dashboard (Port 3000) ==="
cd "$ROOT_DIR/frontend"
nohup npm run dev > "$ROOT_DIR/logs/frontend.log" 2>&1 &
echo $! > "$ROOT_DIR/logs/frontend.pid"

echo "========================================================="
echo "  DRONE-STACK MONOREPO SERVICES STARTED SUCCESSFULLY!  "
echo "  Dashboard Next.js  : http://localhost:3000            "
echo "  FastAPI AI Backend : http://localhost:8000/docs       "
echo "  ROSBridge WS       : ws://localhost:9090              "
echo "========================================================="

if [ "$MODE" == "--gazebo" ] || [ "$MODE" == "gazebo" ]; then
    echo "=== Triggering PX4 + Gazebo Harmonic Launcher ==="
    exec bash "$ROOT_DIR/scripts/start_gazebo.sh"
elif [ "$MODE" == "--ardupilot" ] || [ "$MODE" == "ardupilot" ]; then
    echo "=== Triggering ArduPilot SITL Launcher ==="
    exec bash "$ROOT_DIR/scripts/start_ardupilot.sh"
else
    echo "Press Ctrl+C to stop services. Streaming live logs below:"
    echo "---------------------------------------------------------"
    tail -f "$ROOT_DIR/logs/fastapi.log" "$ROOT_DIR/logs/frontend.log"
fi
