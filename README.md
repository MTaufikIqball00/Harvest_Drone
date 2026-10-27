# Harvest Drone — Autonomous Agricultural Drone & AI Crop Readiness Platform

[![ROS 2](https://img.shields.io/badge/ROS_2-Jazzy-22314E?logo=ros&logoColor=white)](https://docs.ros.org/en/jazzy/)
[![PX4 Autopilot](https://img.shields.io/badge/PX4-Autopilot_v1.14+-black?logo=px4&logoColor=white)](https://px4.io/)
[![Next.js](https://img.shields.io/badge/Next.js-15_(React_19)-000000?logo=next.js&logoColor=white)](https://nextjs.org/)
[![FastAPI](https://img.shields.io/badge/FastAPI-0.115+-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com/)
[![PostgreSQL](https://img.shields.io/badge/Database-PostgreSQL_%2F_Supabase-4169E1?logo=postgresql&logoColor=white)](https://supabase.com/)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](LICENSE)

Platform terintegrasi (*monorepo*) untuk navigasi drone otonom, pemantauan telemetri real-time, dan deteksi kesiapan panen padi berbasis pengolahan citra geospasial *edge computing*.

---

## 📑 Daftar Isi
- [Arsitektur Monorepo](#-arsitektur-monorepo)
- [Fitur Utama](#-fitur-utama)
- [Teknologi yang Digunakan](#-teknologi-yang-digunakan)
- [Prasyarat Sistem](#-prasyarat-sistem)
- [Panduan Instalasi & Konfigurasi](#-panduan-instalasi--konfigurasi)
- [Cara Menjalankan Sistem](#-cara-menjalankan-sistem)
- [Struktur Database](#-struktur-database)
- [Dokumentasi Lanjutan](#-dokumentasi-lanjutan)

---

## 📂 Arsitektur Monorepo

```text
Autonomus drone/
├── backend_ai/                    # Layanan FastAPI AI & Photogrammetry
│   ├── services/
│   │   ├── classification.py      # Segmentasi warna HSV (kuning vs hijau) + CLAHE
│   │   └── stitching.py           # Orkestrasi fotogrametri via NodeODM (Docker)
│   ├── api.py                     # REST & WebSocket API endpoints
│   ├── requirements.txt           # Pustaka Python (OpenCV, Rasterio, FastAPI)
│   └── start_api.bat              # Script mandiri Windows untuk menjalankan backend
├── frontend/                      # Web Ground Control Station (GCS)
│   ├── app/                       # Next.js 15 App Router & API routes
│   ├── components/                # UI components (Map Leaflet, Telemetry HUD, Drone Controls)
│   ├── lib/                       # ROSLib WebSocket client, DB pool, session crypto
│   └── public/map/                # Peta offline basemap vector (PMTiles)
├── ros2_ws/                       # ROS 2 Jazzy Workspace
│   └── src/
│       ├── agricultural_world/    # Gazebo Harmonic world & model sawah (Cimahi, Jabar)
│       ├── drone_dashboard_bridge/# Jembatan ROS 2 <-> WebSocket, A* Obstacle Avoidance
│       └── px4_msgs/              # Definisi pesan uORB PX4 Autopilot (Git Submodule)
├── database/                      # Skema Database & Migrasi
│   ├── supabase_schema.sql        # Skema resmi PostgreSQL (Supabase / Lokal)
│   └── drone_schema.sql           # Skema legacy MySQL (referensi)
├── scripts/                       # Orchestrator & utilitas Linux / WSL
│   ├── start.sh                   # Startup script utama seluruh layanan
│   ├── stop.sh                    # Pembersih proses & pembebas port
│   ├── preflight_check.sh         # Validator kesiapan dependensi lingkungan
│   ├── start_gazebo.sh            # Peluncur simulasi PX4 SITL + Gazebo Harmonic
│   └── start_ardupilot.sh         # Peluncur simulasi ArduPilot SITL
├── docs/                          # Dokumentasi teknis, ERD, dan flowmaps
├── launcher.bat                   # Master Launcher interaktif untuk Windows
├── run_all.bat                    # Script sekali klik peluncur seluruh sistem
└── .env.example                   # Template konfigurasi sentral monorepo
```

---

## 🚀 Fitur Utama

1. **Multi-Flight Stack Compatibility:**
   - **PX4 SITL (uXRCE-DDS):** Komunikasi topik cepat uORB native (`/fmu/*`).
   - **ArduPilot SITL (MAVROS):** Jembatan MAVLink untuk integrasi Mission Planner.
   - **DJI Spark (Physical Hardware):** Integrasi penerbangan nyata menggunakan Android Mobile SDK langsung ke `rosbridge_server`.
2. **Dynamic Obstacle Avoidance & Path Planning:**
   - Deteksi rintangan dinamis menggunakan sensor LiDAR 2D Gazebo.
   - Algoritma perencanaan rute **A\*** dan pola survei otomatis **Boustrophedon** terintegrasi.
3. **AI Crop Readiness & Photogrammetry:**
   - Stitching otomatis dari foto drone JPEG (EXIF WGS84) menjadi orthophoto georeferensi via NodeODM.
   - Segmentasi HSV adaptif 2-kelas (Padi Matang vs Padi Hijau) dengan perbaikan kontras CLAHE.
   - Estimasi luas lahan ($m^2$) dan estimasi hasil panen (ton GKP).
4. **Offline Edge Computing & Resilient Telemetry:**
   - Dashboard offline menggunakan vektor tiles `PMTiles` lokal tanpa internet lapangan.
   - Logging batch asinkron berkecepatan tinggi ke PostgreSQL (`telemetry_logs`, `battery_logs`, `obstacle_logs`, `wind_logs`).
   - Autentikasi operator terenkripsi HMAC-SHA256 *signed cookies*.

---

## 🛠 Teknologi yang Digunakan

- **Frontend:** Next.js 15, React 19, TypeScript, Tailwind CSS, Leaflet, Protomaps, Roslib.
- **Backend AI:** FastAPI, Uvicorn, OpenCV, Rasterio, NumPy, Scikit-Image, PyODM.
- **Robotics & Simulation:** ROS 2 Jazzy, Gazebo Harmonic, PX4 Autopilot, Micro XRCE-DDS Agent, MAVROS.
- **Database:** PostgreSQL (Supabase) dengan connection pool TLS.
- **Platform:** Windows 10/11 & WSL 2 (Ubuntu 24.04 LTS).

---

## 📋 Prasyarat Sistem

- **Sistem Operasi:** Windows 10/11 64-bit dengan **WSL 2** terpasang.
- **Node.js:** Versi 20.x atau 24.x (LTS) & npm.
- **Python:** Versi 3.10+ (disarankan Python 3.11/3.12).
- **ROS 2:** ROS 2 Jazzy Jalisco terpasang di WSL 2.
- **Simulator (Opsional):** Gazebo Harmonic (`gz sim`) dan PX4 Autopilot.
- **Docker Desktop:** Untuk menjalankan container NodeODM fotogrametri (port `3001`).

---

## ⚙ Panduan Instalasi & Konfigurasi

### 1. Inisialisasi Repositori & Submodule
Clone repositori beserta submodule ROS 2:
```bash
git clone -b v2 https://github.com/MTaufikIqball00/Harvest_Drone.git
cd Harvest_Drone
git submodule update --init --recursive
```

### 2. Konfigurasi Environment Variables
Salin template konfigurasi `.env.example` ke `.env`:
```bash
cp .env.example .env
```
Sesuaikan parameter penting di dalam file `.env`:
- `DB_HOST`, `DB_PASSWORD`, `DB_USER`: Kredensial PostgreSQL / Supabase Anda.
- `AUTH_SECRET`: Kunci rahasia 32-byte hex acak untuk sesi operator:
  ```bash
  node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
  ```
- `NEXT_PUBLIC_ORIGIN_LAT` & `NEXT_PUBLIC_ORIGIN_LON`: Koordinat acuan pusat peta (default: Cimahi, Jawa Barat).

### 3. Setup Frontend
```bash
cd frontend
npm install
# Buat akun operator pertama
npm run create-operator -- operator password123
cd ..
```

### 4. Setup Backend AI
```bash
cd backend_ai
python -m venv venv
# Windows:
venv\Scripts\activate
# Linux/WSL:
# source venv/bin/activate
pip install -r requirements.txt
cd ..
```

### 5. Setup Database
Buka SQL Editor di dasbor Supabase (atau client psql lokal) dan jalankan seluruh query dari:
[`database/supabase_schema.sql`](file:///c:/Users/taufi/Documents/Projects/Autonomus%20drone/database/supabase_schema.sql)

---

## 🎮 Cara Menjalankan Sistem

### Opsi A: Menggunakan Windows Master Launcher (Paling Mudah)
Cukup jalankan berkas GUI interaktif:
```cmd
launcher.bat
```
Pilih opsi:
- `[1]` Menjalankan Layanan Utama (Next.js Dashboard + FastAPI AI + ROS2 + PostgreSQL Logger).
- `[2]` Menjalankan PX4 SITL + Gazebo Harmonic.
- `[3]` Menjalankan ArduPilot SITL (Mission Planner).
- `[4]` Menjalankan seluruh sistem sekaligus.
- `[5]` Menghentikan seluruh proses.

### Opsi B: Menggunakan Bash CLI (Linux / WSL)
Jalankan validasi lingkungan:
```bash
bash scripts/preflight_check.sh
```
Jalankan orchestrator layanan:
```bash
# Menjalankan layanan utama
bash scripts/start.sh

# Menjalankan layanan utama + simulasi PX4 Gazebo
bash scripts/start.sh --gazebo

# Menjalankan mode drone fisik DJI Spark
bash scripts/start.sh --dji
```

Akses layanan di browser:
- **GCS Dashboard:** [http://localhost:3000](http://localhost:3000)
- **FastAPI Documentation:** [http://localhost:8000/docs](http://localhost:8000/docs)
- **ROSBridge WebSocket:** `ws://localhost:9090`

---

## 📊 Struktur Database

Data disimpan secara aman dan terstruktur dalam database PostgreSQL dengan tabel-tabel utama:
- `users`: Autentikasi dan otorisasi operator GCS.
- `drones`: Master data armada drone (PX4, ArduPilot, DJI).
- `missions`: Riwayat misi, koordinat target, durasi, dan jarak tempuh.
- `telemetry_logs`: Log telemetri berfrekuensi tinggi (posisi XYZ, kecepatan, orientasi yaw/pitch/roll).
- `battery_logs`: Riwayat kapasitas baterai, voltase, dan estimasi waktu sisa.
- `obstacle_logs`: Log deteksi rintangan LiDAR dan tindakan penghindaran.
- `harvest_jobs` & `harvest_classifications`: Hasil inferensi kesiapan panen padi, GeoTIFF, dan statistik piksel.

---

## 📖 Dokumentasi Lanjutan

- [Dokumentasi Lengkap Sistem & DFD](docs/SYSTEM_DOCUMENTATION.md)
- [Integrasi Database & Skema Supabase](docs/database-integration.md)
- [Diagram Alur Sistem (Flowmaps)](docs/flowmaps.md)
- [Dokumentasi API Backend AI](backend_ai/BACKEND_API.md)

---

## 📝 Lisensi
Proyek ini dilisensikan di bawah lisensi [Apache-2.0](LICENSE).
