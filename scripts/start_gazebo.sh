#!/usr/bin/env bash
# =============================================================================
# scripts/start_gazebo.sh - Launch PX4 SITL + Gazebo Harmonic Simulation
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PX4_DIR="${PX4_DIR:-/home/iqball/drone-stack/external/PX4-Autopilot}"
ROS_WS="$ROOT_DIR/ros2_ws"

echo "=== Cleaning up previous PX4 / Gazebo instances ==="
pkill -9 px4 2>/dev/null || true
pkill -9 ruby 2>/dev/null || true
pkill -9 gz 2>/dev/null || true
rm -rf /tmp/px4* 2>/dev/null || true

echo "=== Sourcing ROS 2 & Workspace Environment ==="
source /opt/ros/jazzy/setup.bash 2>/dev/null || true
if [ -f "$ROS_WS/install/setup.bash" ]; then
    source "$ROS_WS/install/setup.bash"
fi

echo "=== Starting Micro XRCE-DDS Agent (Port 8888) ==="
mkdir -p "$ROOT_DIR/logs"
nohup MicroXRCEAgent udp4 -p 8888 > "$ROOT_DIR/logs/xrce_agent.log" 2>&1 &

echo "=== Configuring Gazebo Environment ==="
WORLD_NAME="agricultural_field"
MODEL_NAME="x500_lidar_2d"
POSE="-65,0,0.4,0,0,0"

CUSTOM_WORLD_DIR="$ROS_WS/src/agricultural_world/worlds"
CUSTOM_MODEL_DIR="$ROS_WS/src/agricultural_world/models"
PX4_WORLD_DIR="$PX4_DIR/Tools/simulation/gz/worlds"

if [ -f "$CUSTOM_WORLD_DIR/${WORLD_NAME}.sdf" ]; then
    rm -f "$PX4_WORLD_DIR/${WORLD_NAME}.sdf"
    ln -s "$CUSTOM_WORLD_DIR/${WORLD_NAME}.sdf" "$PX4_WORLD_DIR/${WORLD_NAME}.sdf" 2>/dev/null || true
fi

export DISPLAY="${DISPLAY:-:0}"
export PX4_GZ_WORLD="$WORLD_NAME"
export PX4_SIM_MODEL="$MODEL_NAME"
export PX4_GZ_MODEL_POSE="$POSE"
export PX4_GZ_MODELS="$PX4_DIR/Tools/simulation/gz/models"
export PX4_GZ_WORLDS="$PX4_WORLD_DIR"
export GZ_SIM_RESOURCE_PATH="${CUSTOM_MODEL_DIR}:${PX4_DIR}/Tools/simulation/gz/models:${PX4_WORLD_DIR}:${GZ_SIM_RESOURCE_PATH}"

echo "========================================================="
echo "  LAUNCHING PX4 SITL + GAZEBO HARMONIC SIMULATION      "
echo "  World : $WORLD_NAME                                    "
echo "  Model : $MODEL_NAME                                    "
echo "========================================================="

cd "$PX4_DIR"
make px4_sitl gz_${MODEL_NAME}
