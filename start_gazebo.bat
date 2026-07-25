@echo off
title Drone Stack - PX4 Gazebo Launcher
color 0B
echo =========================================================
echo   Launching PX4 SITL + Gazebo Harmonic Simulation
echo =========================================================
wsl -d UAV bash -lic "/home/iqball/drone-stack/scripts/start_gazebo.sh"
pause
