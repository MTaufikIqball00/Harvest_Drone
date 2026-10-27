@echo off
setlocal enabledelayedexpansion
title Drone Stack - ArduPilot SITL Launcher
color 0E

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
echo   Launching ArduPilot SITL for Mission Planner
echo   Distro: %WSL_DISTRO%  Path: %TARGET_DIR%
echo =========================================================
echo MAVLink UDP output will be available at 127.0.0.1:14550
echo Open Mission Planner and connect via UDP port 14550.
echo ---------------------------------------------------------
wsl -d %WSL_DISTRO% bash -lic "cd '%TARGET_DIR%' && bash scripts/start_ardupilot.sh"
pause
