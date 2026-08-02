#!/usr/bin/env bash
# =============================================================================
# scripts/start.sh - Main Monorepo Process Orchestrator
# =============================================================================

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"
mkdir -p "$ROOT_DIR/logs"

# Ensure environment variables
if [ -f ".env" ]; then
    set -a
    source .env
    set +a
fi

MODE="${1:-services}"

echo "=== Cleaning up previous background processes ==="
bash "$ROOT_DIR/scripts/stop.sh" 2>/dev/null || true
sleep 1

echo "=== Starting PostgreSQL Service ==="
sudo service postgresql start 2>/dev/null || true
# Skema hanya diterapkan bila database DB_NAME (default drone_ops) belum ada —
# menjalankan supabase_schema.sql pada database yang sudah berisi data akan
# MENGHAPUS seluruh tabel (skrip itu diawali DROP TABLE). Untuk Supabase,
# skema disiapkan manual lewat SQL Editor, bukan lewat baris ini.
DB_NAME_CHECK="${DB_NAME:-drone_ops}"
DB_HOST_CHECK="${DB_HOST:-127.0.0.1}"
if [ -f "database/supabase_schema.sql" ] && { [ "$DB_HOST_CHECK" = "127.0.0.1" ] || [ "$DB_HOST_CHECK" = "localhost" ]; }; then
    DB_EXISTS=$(sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME_CHECK}'" 2>/dev/null || true)
    if [ "$DB_EXISTS" != "1" ]; then
        echo "Database '$DB_NAME_CHECK' belum ada, membuat + menerapkan skema PostgreSQL..."
        sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME_CHECK};" 2>/dev/null || true
        sudo -u postgres psql -d "$DB_NAME_CHECK" -f database/supabase_schema.sql 2>/dev/null || true
    fi
fi

echo "=== Starting FastAPI AI Backend Service (Port 8000) ==="
cd "$ROOT_DIR/backend_ai"
source venv/bin/activate 2>/dev/null || true
nohup python3 -m uvicorn api:app --host 0.0.0.0 --port 8000 > "$ROOT_DIR/logs/fastapi.log" 2>&1 &
echo $! > "$ROOT_DIR/logs/fastapi.pid"

echo "=== Starting ROS 2 Environment & Bridges ==="
source /opt/ros/jazzy/setup.bash 2>/dev/null || true
if [ -f "$ROOT_DIR/ros2_ws/install/setup.bash" ]; then
    source "$ROOT_DIR/ros2_ws/install/setup.bash"
fi

# Dashboard Bridge — pilih flight stack:
#   --gazebo  -> PX4 SITL, jembatannya uORB/XRCE-DDS   (dashboard_bridge_node_px4)
#   --dji     -> DJI Spark ASLI, jembatannya HP Android (RosBridgeClient.java,
#                connect LANGSUNG ke rosbridge_server — tidak ada node Python)
#   selain itu-> ArduPilot SITL, jembatannya MAVROS    (dashboard_bridge_node)
# Menjalankan varian yang salah membuat dashboard tidak menerima telemetry apa
# pun: node MAVROS menunggu /mavros/*, node PX4 menunggu /fmu/*.
if [ "$MODE" == "--gazebo" ] || [ "$MODE" == "gazebo" ]; then
    FLIGHT_STACK="px4"
elif [ "$MODE" == "--dji" ] || [ "$MODE" == "dji" ]; then
    FLIGHT_STACK="dji"
else
    FLIGHT_STACK="ardupilot"
fi
echo "Dashboard bridge menggunakan flight stack: $FLIGHT_STACK"

if [ "$FLIGHT_STACK" == "dji" ]; then
    # MODE DJI: TIDAK menjalankan MicroXRCEAgent, MAVROS, maupun
    # dashboard_bridge_node/_px4 sama sekali.
    #
    # Untuk DJI Spark, app Android (lihat RosBridgeClient.java di project
    # Mobile-SDK-Android) berperan PENUH sebagai pengganti node Python itu —
    # ia connect LANGSUNG ke rosbridge_server di bawah ini sebagai client,
    # mem-publish /dashboard/telemetry, dan advertise service /takeoff /land
    # /dashboard/resync via protokol rosbridge standar (advertise/advertise_
    # service/call_service). Menjalankan dashboard_bridge_node bersamaan akan
    # membuat DUA service server dengan nama sama di ROS graph (undefined
    # behavior) — jadi jangan pernah start keduanya sekaligus.
    echo "Mode DJI: tidak menjalankan MAVROS/XRCE-Agent/dashboard_bridge_node."
    echo "Sambungkan app di HP Android ke IP laptop ini, port 9090 (rosbridge)."
else
    # Micro XRCE-DDS Agent — hanya untuk PX4 (uXRCE-DDS).
    nohup MicroXRCEAgent udp4 -p 8888 > "$ROOT_DIR/logs/xrce_agent.log" 2>&1 &

    # MAVROS — WAJIB untuk jalur ArduPilot.
    #
    # BUG (sudah ada sebelumnya): tidak ada satu pun script di repo ini yang
    # pernah menjalankan MAVROS. Padahal dashboard_bridge_node berlangganan
    # /mavros/local_position/pose, /mavros/state, dan /mavros/battery, serta
    # memanggil service /mavros/cmd/arming & /mavros/set_mode.
    #
    # Tanpa MAVROS, topik-topik itu TIDAK PERNAH ADA, sehingga:
    #   - self.current_pose selamanya None
    #   - tombol TAKEOFF selalu ditolak dengan "Tidak ada local position."
    #   - dashboard tidak pernah menampilkan posisi/baterai/mode drone
    #
    # PX4 tidak memerlukan ini karena memakai jembatan uXRCE-DDS (/fmu/*).
    if [ "$FLIGHT_STACK" == "ardupilot" ]; then
        # Port 14551 khusus MAVROS; 14550 dibiarkan untuk Mission Planner/QGC.
        MAVROS_FCU_URL="${MAVROS_FCU_URL:-udp://:14551@}"
        echo "=== Starting MAVROS (fcu_url=$MAVROS_FCU_URL) ==="
        nohup ros2 launch mavros apm.launch \
            fcu_url:="$MAVROS_FCU_URL" > "$ROOT_DIR/logs/mavros.log" 2>&1 &
    fi

    # Jembatan LiDAR Gazebo -> ROS 2. HANYA untuk PX4 SITL (LiDAR cuma ada di
    # simulasi).
    #
    # BUG (sudah ada sebelumnya): tidak ada satu pun script yang menjalankan
    # ros_gz_bridge, sehingga topik /drone/lidar/scan TIDAK PERNAH ADA.
    # dashboard_bridge_node_px4 berlangganan topik itu untuk deteksi rintangan,
    # jadi lidar_cb() tidak pernah dipanggil dan SELURUH jalur replanning
    # berbasis sensor mati diam-diam — replanning_log.csv selamanya kosong.
    # (Auto-orbit tetap jalan karena ia memakai daftar rintangan hardcoded,
    # bukan LiDAR, sehingga kerusakan ini tidak terlihat dari perilaku drone.)
    #
    # parameter_bridge dijalankan STANDALONE, bukan lewat agricultural_world.
    # launch.py, karena file launch itu ikut menyalakan `gz sim` sendiri —
    # padahal Gazebo sudah dinyalakan start_gazebo.sh via `make px4_sitl`.
    #
    # Nama topik gz mengikuti pola default sensor tanpa tag <topic>:
    #   /world/<world>/model/<model>/link/<link>/sensor/<sensor>/scan
    # Sesuaikan lewat env GZ_LIDAR_TOPIC bila nama instance model berubah
    # (verifikasi dengan `gz topic -l` saat simulasi menyala).
    if [ "$FLIGHT_STACK" == "px4" ]; then
        GZ_LIDAR_TOPIC="${GZ_LIDAR_TOPIC:-/world/agricultural_field/model/x500_lidar_2d_0/link/link/sensor/lidar_2d_v2/scan}"
        echo "=== Starting Gazebo->ROS LiDAR bridge ($GZ_LIDAR_TOPIC) ==="
        nohup ros2 run ros_gz_bridge parameter_bridge \
            "${GZ_LIDAR_TOPIC}@sensor_msgs/msg/LaserScan[gz.msgs.LaserScan" \
            --ros-args -r "${GZ_LIDAR_TOPIC}:=/drone/lidar/scan" \
            > "$ROOT_DIR/logs/gz_lidar_bridge.log" 2>&1 &
    fi

    # Pakai `ros2 launch`, BUKAN `ros2 run`. Dengan `ros2 run` file launch
    # tidak pernah dibaca sehingga seluruh parameter tuning di dalamnya mati —
    # antara lain planner_resolution jatuh ke default kode 1.0 yang membuat
    # satu kali A* memakan ~1.6 detik CPU (seharusnya 5.0).
    nohup ros2 launch drone_dashboard_bridge dashboard_bridge.launch.py \
        flight_stack:="$FLIGHT_STACK" > "$ROOT_DIR/logs/dashboard_bridge.log" 2>&1 &

    # MySQL Telemetry & Obstacle Logger.
    #
    # BUG (sudah ada sebelumnya): node ini TIDAK PERNAH dijalankan oleh script
    # mana pun, padahal ia satu-satunya penulis telemetry_logs, obstacle_logs,
    # battery_logs, wind_logs, dan error_logs dari topik /dashboard/* ke MySQL.
    # Akibatnya seluruh data ROS — termasuk deteksi rintangan saat misi — tidak
    # pernah masuk DB. (Riwayat misi tetap terlihat karena ditulis frontend lewat
    # /api/missions, jalur yang berbeda.)
    #
    # Kredensial DB dioper EKSPLISIT dari .env (DB_*). Node membaca env dengan
    # nama DRONE_DB_* sehingga tanpa override ini ia memakai password kosong dan
    # gagal konek.
    echo "=== Starting PostgreSQL Telemetry/Obstacle Logger ==="
    nohup ros2 run drone_dashboard_bridge mysql_telemetry_logger --ros-args \
        -p db_host:="${DB_HOST:-127.0.0.1}" \
        -p db_port:="${DB_PORT:-5432}" \
        -p db_user:="${DB_USER:-postgres}" \
        -p db_password:="${DB_PASSWORD:-}" \
        -p db_name:="${DB_NAME:-postgres}" \
        -p drone_id:="${DRONE_DB_DRONE_ID:-1}" \
        > "$ROOT_DIR/logs/mysql_logger.log" 2>&1 &
fi

# ROSBridge Server — dibutuhkan SEMUA mode (termasuk DJI, sebagai satu-satunya
# titik sambung app Android).
nohup ros2 launch rosbridge_server rosbridge_websocket_launch.xml port:=9090 > "$ROOT_DIR/logs/rosbridge.log" 2>&1 &

echo "=== Starting Next.js Frontend Dashboard (Port 3000) ==="
cd "$ROOT_DIR/frontend"
nohup npm run dev > "$ROOT_DIR/logs/frontend.log" 2>&1 &
echo $! > "$ROOT_DIR/logs/frontend.pid"

echo "========================================================="
echo "  DRONE-STACK MONOREPO SERVICES STARTED SUCCESSFULLY!  "
echo "  Dashboard Next.js  : http://localhost:3000            "
echo "  FastAPI AI Backend : http://localhost:8000/docs       "
echo "  ROSBridge WS       : ws://localhost:9090              "
if [ "$FLIGHT_STACK" == "dji" ]; then
    LAPTOP_IP=$(hostname -I 2>/dev/null | awk '{print $1}')
    echo "  -----------------------------------------------------"
    echo "  Mode DJI: di app Android, masukkan IP laptop ini"
    echo "  sebagai 'Laptop Bridge' -> ${LAPTOP_IP:-<cek dengan: hostname -I>}:9090"
fi
echo "========================================================="

if [ "$MODE" == "--gazebo" ] || [ "$MODE" == "gazebo" ]; then
    echo "=== Triggering PX4 + Gazebo Harmonic Launcher ==="
    exec bash "$ROOT_DIR/scripts/start_gazebo.sh"
elif [ "$MODE" == "--ardupilot" ] || [ "$MODE" == "ardupilot" ]; then
    echo "=== Triggering ArduPilot SITL Launcher ==="
    exec bash "$ROOT_DIR/scripts/start_ardupilot.sh"
else
    # Mode --dji dan mode "services" polos berhenti di sini — tidak ada
    # simulator untuk dipicu (dronenya asli, dikendalikan lewat HP).
    echo "Press Ctrl+C to stop services. Streaming live logs below:"
    echo "---------------------------------------------------------"
    tail -f "$ROOT_DIR/logs/fastapi.log" "$ROOT_DIR/logs/frontend.log"
fi
