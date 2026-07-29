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

# -----------------------------------------------------------------------------
# Parameter PX4 khusus SITL
# -----------------------------------------------------------------------------
# PX4 memblokir arming dengan "Preflight Fail: No connection to the GCS" selama
# NAV_DLL_ACT > 0, karena ia menuntut heartbeat dari ground control station.
# Dashboard ini berkomunikasi lewat uXRCE-DDS (bukan MAVLink GCS), jadi tidak
# ada heartbeat semacam itu dan drone tidak akan pernah bisa arm.
#
# Kita menulis file `.post` — hook resmi PX4 yang di-source di akhir rcS:
#     [ -e "$autostart_file".post ] && . "$autostart_file".post
# File ini DIHASILKAN di sini (bukan diedit manual di dalam PX4) supaya:
#   1. perbaikan tetap ada meski PX4 di-rebuild atau ROMFS di-regenerate
#   2. sumber kebenarannya ada di repo ini, bukan di direktori pihak ketiga
#
# PENTING: ini HANYA untuk simulasi. Jangan pernah pakai NAV_DLL_ACT=0 pada
# penerbangan nyata — itu mematikan failsafe kehilangan data link.
AIRFRAME_SRC_DIR="$PX4_DIR/ROMFS/px4fmu_common/init.d-posix/airframes"
AIRFRAME_BUILD_DIR="$PX4_DIR/build/px4_sitl_default/etc/init.d-posix/airframes"
AIRFRAME_FILE=$(ls "$AIRFRAME_SRC_DIR" 2>/dev/null | grep -E "^[0-9]+_gz_${MODEL_NAME}$" | head -1)

if [ -n "$AIRFRAME_FILE" ]; then
    # Ditulis ke DUA lokasi:
    #   ROMFS  -> sumber, ikut tersalin saat CMake di-reconfigure
    #   build/ -> yang BENAR-BENAR dibaca PX4 saat runtime
    # Menulis hanya ke ROMFS tidak cukup: build system PX4 menyalin airframe
    # berdasarkan manifest CMake, jadi file .post yang baru dibuat tidak ikut
    # tersalin sampai CMake dijalankan ulang — param pun tidak pernah aktif.
    for d in "$AIRFRAME_SRC_DIR" "$AIRFRAME_BUILD_DIR"; do
        [ -d "$d" ] || continue
        cat > "$d/${AIRFRAME_FILE}.post" << 'POST_EOF'
#!/bin/sh
# Dihasilkan otomatis oleh scripts/start_gazebo.sh — JANGAN diedit manual.
# Khusus SITL: izinkan arming tanpa heartbeat GCS MAVLink, karena kendali
# datang dari dashboard lewat uXRCE-DDS.
param set NAV_DLL_ACT 0
POST_EOF
    done
    echo "Param SITL diterapkan via ${AIRFRAME_FILE}.post (NAV_DLL_ACT=0)"
else
    echo "[WARN ] Airframe untuk gz_${MODEL_NAME} tidak ditemukan; param SITL dilewati."
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

# --- Pemeriksaan awal: gagal cepat dengan pesan yang jelas -------------------
# Tanpa ini, kegagalan apa pun di bawah hanya muncul sekejap lalu hilang bersama
# jendela terminal yang tertutup, sehingga mustahil didiagnosis.
FAIL=0
if ! command -v gz >/dev/null 2>&1; then
    echo "[ERROR] Perintah 'gz' tidak ditemukan. Gazebo Harmonic belum terpasang."
    FAIL=1
elif ! gz sim --version >/dev/null 2>&1; then
    echo "[ERROR] 'gz sim' tidak berfungsi. Cek instalasi gz-harmonic."
    echo "        gz yang dipakai: $(command -v gz)"
    FAIL=1
fi
if [ ! -d "$PX4_DIR" ]; then
    echo "[ERROR] PX4_DIR tidak ada: $PX4_DIR"
    FAIL=1
fi
if [ ! -d "$PX4_DIR/Tools/simulation/gz/models/$MODEL_NAME" ]; then
    echo "[ERROR] Model '$MODEL_NAME' tidak ada di PX4."
    FAIL=1
fi
if [ -z "${DISPLAY:-}" ] && [ ! -d /mnt/wslg ]; then
    echo "[WARN ] DISPLAY kosong dan WSLg tidak terdeteksi — GUI Gazebo mungkin gagal."
fi

if [ "$FAIL" -ne 0 ]; then
    echo "========================================================="
    echo "  GAGAL: prasyarat simulasi tidak terpenuhi (lihat di atas)"
    echo "========================================================="
    read -r -p "Tekan Enter untuk menutup..." _ || sleep 30
    exit 1
fi

cd "$PX4_DIR"

# Salin seluruh keluaran ke logs/gazebo.log SEKALIGUS tetap menampilkannya.
# `make` di sini berjalan di foreground; kalau ia gagal, jendela akan tertutup
# dan pesan errornya hilang. Dengan tee, log tetap tersimpan untuk diperiksa.
mkdir -p "$ROOT_DIR/logs"
set -o pipefail
make px4_sitl gz_${MODEL_NAME} 2>&1 | tee "$ROOT_DIR/logs/gazebo.log"
STATUS=${PIPESTATUS[0]}

if [ "$STATUS" -ne 0 ]; then
    echo "========================================================="
    echo "  SIMULASI BERHENTI dengan kode error $STATUS"
    echo "  Log lengkap: $ROOT_DIR/logs/gazebo.log"
    echo "========================================================="
    # Tahan jendela supaya pesan error bisa dibaca, bukan hilang seketika.
    read -r -p "Tekan Enter untuk menutup..." _ || sleep 30
fi
exit "$STATUS"
