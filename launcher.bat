@echo off
title Drone Stack Monorepo Master Launcher
:menu
cls
color 0A
echo ====================================================================
echo             DRONE STACK MONOREPO - MASTER LAUNCHER
echo ====================================================================
echo   [1] Jalankan Layanan Utama (Next.js + FastAPI AI + ROS2 + MySQL)
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
    wsl -d UAV bash -lic "/home/iqball/drone-stack/scripts/start.sh"
    pause
    goto menu
)
if "%opt%"=="2" (
    echo.
    echo Menjalankan PX4 SITL + Gazebo Harmonic...
    start cmd /k "wsl -d UAV bash -lic '/home/iqball/drone-stack/scripts/start_gazebo.sh'"
    pause
    goto menu
)
if "%opt%"=="3" (
    echo.
    echo Menjalankan ArduPilot SITL (Mission Planner)...
    start cmd /k "wsl -d UAV bash -lic '/home/iqball/drone-stack/scripts/start_ardupilot.sh'"
    pause
    goto menu
)
if "%opt%"=="4" (
    echo.
    echo Menjalankan Seluruh Sistem (Layanan + PX4 Gazebo)...
    wsl -d UAV bash -lic "/home/iqball/drone-stack/scripts/start.sh --gazebo"
    pause
    goto menu
)
if "%opt%"=="5" (
    echo.
    echo Menghentikan seluruh proses...
    wsl -d UAV bash -lic "/home/iqball/drone-stack/scripts/stop.sh"
    echo Seluruh layanan berhasil dihentikan.
    pause
    goto menu
)
if "%opt%"=="6" exit

echo Pilihan tidak valid! Silakan coba lagi.
pause
goto menu
