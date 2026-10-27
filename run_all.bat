@echo off
setlocal enabledelayedexpansion
title Drone Stack - Full Monorepo System & PX4 Gazebo Launcher
color 0A

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

echo ====================================================================
echo   LAUNCHING ALL DRONE STACK SERVICES & PX4 GAZEBO SIMULATION
echo   Distro: %WSL_DISTRO%  Path: %TARGET_DIR%
echo ====================================================================
echo.
wsl -d %WSL_DISTRO% bash -lic "cd '%TARGET_DIR%' && bash scripts/start.sh --gazebo"
pause
