#!/usr/bin/env bash
# =============================================================================
# scripts/stop.sh - Stop all monorepo background processes & release ports
# =============================================================================

echo "=== Stopping Drone-Stack Monorepo Services ==="

kill_port() {
    local port=$1
    # BUG (sudah ada sebelumnya): ekstraksi PID lama mengandalkan posisi kolom
    # ($7) dari output `ss`, padahal jumlah kolom berubah-ubah tergantung state
    # soket. Hasilnya PID sering berupa sampah, contoh nyata dari log:
    #   Killing process on port 3000 (PID: users:(("next-server)...
    # `kill` lalu gagal diam-diam dan proses lama TIDAK pernah mati — port tetap
    # dipakai sehingga layanan baru gagal bind.
    #
    # Sekarang PID diambil dengan regex dari pola `pid=<angka>` di mana pun ia
    # muncul, dan hanya angka murni yang diterima.
    local pids
    pids=$(ss -tulpnH "sport = :${port}" 2>/dev/null \
        | grep -oE 'pid=[0-9]+' | cut -d= -f2 | sort -u)

    if [ -z "$pids" ]; then
        return 0
    fi

    for pid in $pids; do
        case "$pid" in
            ''|*[!0-9]*) continue ;;   # abaikan apa pun yang bukan angka
        esac
        [ "$pid" -le 1 ] && continue   # jangan pernah sentuh PID 0/1
        echo "Killing process on port $port (PID: $pid)..."
        kill -9 "$pid" 2>/dev/null || true
    done
}

# Release ports
kill_port 3000
kill_port 8000
kill_port 9090
kill_port 8888
kill_port 14540
kill_port 14550

# Terminate process names
pkill -f "uvicorn api:app" 2>/dev/null || true
pkill -f "next-server" 2>/dev/null || true
pkill -f "rosbridge_websocket" 2>/dev/null || true
pkill -f "MicroXRCEAgent" 2>/dev/null || true
pkill -f "dashboard_bridge_node" 2>/dev/null || true
pkill -f "px4" 2>/dev/null || true
pkill -f "gz" 2>/dev/null || true

echo "=== All services stopped cleanly ==="
