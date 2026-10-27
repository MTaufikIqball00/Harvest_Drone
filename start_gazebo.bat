@echo off
setlocal enabledelayedexpansion
title Drone Stack - PX4 Gazebo Launcher
color 0B

set "WSL_DISTRO=UAV"
if defined DRONE_WSL_DISTRO set "WSL_DISTRO=%DRONE_WSL_DISTRO%"

set "TARGET_DIR=/home/iqball/drone-stack"
if defined DRONE_STACK_WSL_DIR (
    set "TARGET_DIR=%DRONE_STACK_WSL_DIR%"
) else (
    for /f "usebackq tokens=*" %%i in (`wsl -d %WSL_DISTRO% wslpath -u "%~dp0" 2^>nul`) do (
        if not "%%i"=="" set "TARGET_DIR=%%i"
    )
)

echo =========================================================
echo   Launching PX4 SITL + Gazebo Harmonic Simulation
echo   Distro: %WSL_DISTRO%  Path: %TARGET_DIR%
echo =========================================================
wsl -d %WSL_DISTRO% bash -lic "cd '%TARGET_DIR%' && bash scripts/start_gazebo.sh"
pause
