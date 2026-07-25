@echo off
title Drone Stack - Full Monorepo System & PX4 Gazebo Launcher
color 0A
echo ====================================================================
echo   LAUNCHING ALL DRONE STACK SERVICES & PX4 GAZEBO SIMULATION
echo ====================================================================
echo.
wsl -d UAV bash -lic "/home/iqball/drone-stack/scripts/start.sh --gazebo"
pause
