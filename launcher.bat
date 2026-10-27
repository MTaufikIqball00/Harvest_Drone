@echo off
setlocal enabledelayedexpansion
title Drone Stack Monorepo Master Launcher

REM Konfigurasi Distro & Direktori WSL (dapat di-override via env var)
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

:menu
cls
color 0A
echo ====================================================================
echo             DRONE STACK MONOREPO - MASTER LAUNCHER
echo ====================================================================
echo   WSL Distro : %WSL_DISTRO%
echo   WSL Path   : %TARGET_DIR%
echo --------------------------------------------------------------------
echo   [1] Jalankan Layanan Utama (Next.js + FastAPI AI + ROS2 + Database)
echo   [2] Jalankan Simulasi PX4 SITL + Gazebo Harmonic
echo   [3] Jalankan Simulasi ArduPilot SITL (Mission Planner)
echo   [4] Jalankan SEMUA (Layanan Utama + PX4 Gazebo Simulation)
echo   [5] Hentikan Seluruh Layanan (Stop All Services)
echo   [6] Keluar (Exit)
echo ====================================================================
set /p opt="Pilih menu [1-6]: "

if "%opt%"=="1" (
    echo.
    echo Menjalankan Layanan Utama Monorepo...
    wsl -d %WSL_DISTRO% bash -lic "cd '%TARGET_DIR%' && bash scripts/start.sh"
    pause
    goto menu
)
if "%opt%"=="2" (
    echo.
    echo Menjalankan PX4 SITL + Gazebo Harmonic...
    start cmd /k "wsl -d %WSL_DISTRO% bash -lic 'cd \"%TARGET_DIR%\" && bash scripts/start_gazebo.sh'"
    pause
    goto menu
)
if "%opt%"=="3" (
    echo.
    echo Menjalankan ArduPilot SITL (Mission Planner)...
    start cmd /k "wsl -d %WSL_DISTRO% bash -lic 'cd \"%TARGET_DIR%\" && bash scripts/start_ardupilot.sh'"
    pause
    goto menu
)
if "%opt%"=="4" (
    echo.
    echo Menjalankan Seluruh Sistem (Layanan + PX4 Gazebo)...
    wsl -d %WSL_DISTRO% bash -lic "cd '%TARGET_DIR%' && bash scripts/start.sh --gazebo"
    pause
    goto menu
)
if "%opt%"=="5" (
    echo.
    echo Menghentikan seluruh proses...
    wsl -d %WSL_DISTRO% bash -lic "cd '%TARGET_DIR%' && bash scripts/stop.sh"
    echo Seluruh layanan berhasil dihentikan.
    pause
    goto menu
)
if "%opt%"=="6" exit

echo Pilihan tidak valid! Silakan coba lagi.
pause
goto menu
