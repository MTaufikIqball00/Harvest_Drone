#!/bin/bash
echo "[test] Stopping all old processes..."
pkill -9 -f next-server
pkill -9 -f "next start"
pkill -9 px4
pkill -9 gz
pkill -9 ruby
pkill -9 -f dashboard_bridge_node
pkill -9 -f rosbridge
pkill -9 -f parameter_bridge
pkill -9 -f mysql_telemetry_logger
sleep 2

echo "[test] Starting the launcher..."
source /opt/ros/jazzy/setup.bash
source /home/iqball/drone-stack/project/ros2_ws/install/setup.bash

# We run run_all.py with --gazebo and --no-db
python3 /home/iqball/drone-stack/project/launcher/run_all.py --gazebo --no-db
