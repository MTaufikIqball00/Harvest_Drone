#!/usr/bin/env bash
# =============================================================================
# scripts/start_ardupilot.sh - Launch ArduPilot SITL (for Mission Planner / MAVLink)
# =============================================================================

ARDUPILOT_DIR="${ARDUPILOT_DIR:-/home/iqball/ardupilot}"
VENV_DIR="${VENV_DIR:-/home/iqball/venv-ardupilot}"

echo "=== Starting ArduPilot SITL ==="
if [ -d "$VENV_DIR" ]; then
    echo "Activating ArduPilot Python Virtual Environment..."
    source "$VENV_DIR/bin/activate"
fi

if [ ! -d "$ARDUPILOT_DIR" ]; then
    echo "[ERROR] ArduPilot directory not found at $ARDUPILOT_DIR"
    exit 1
fi

echo "========================================================="
echo "  Launching ArduCopter SITL...                          "
echo "  MAVLink Out Ports:                                    "
echo "    - UDP 14550 (Mission Planner / QGroundControl)      "
echo "    - TCP 5760                                          "
echo "========================================================="

cd "$ARDUPILOT_DIR/ArduCopter"
# Dua output MAVLink terpisah:
#   14550 -> Mission Planner / QGroundControl (GCS manusia)
#   14551 -> MAVROS (dashboard). Port SENDIRI supaya tidak berebut dengan GCS;
#            dua klien pada satu port UDP saling mencuri paket.
"$ARDUPILOT_DIR/Tools/autotest/sim_vehicle.py" -v ArduCopter --console --map \
    --out=udp:127.0.0.1:14550 \
    --out=udp:127.0.0.1:14551
