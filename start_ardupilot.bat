@echo off
title Drone Stack - ArduPilot SITL Launcher
color 0E
echo =========================================================
echo   Launching ArduPilot SITL for Mission Planner
echo =========================================================
echo MAVLink UDP output will be available at 127.0.0.1:14550
echo Open Mission Planner and connect via UDP port 14550.
echo ---------------------------------------------------------
wsl -d UAV bash -lic "/home/iqball/drone-stack/scripts/start_ardupilot.sh"
pause
