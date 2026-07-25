# 🚁 Agricultural Drone Monitoring — Gazebo Harmony World

**Project**: Autonomous drone untuk pemantauan lahan pertanian  
**Location**: Jl. Aruman, Cimahi, West Java, Indonesia  
**Stack**: ROS2 Jazzy + Gazebo Harmony (Ionic)

---

## 📐 Spesifikasi World

| Parameter | Nilai |
|-----------|-------|
| Ukuran lahan | ~350m × ~250m |
| GPS Referensi | -6.8852°S, 107.5417°E |
| Elevasi ASL | 714 m |
| Angin | 1.5 m/s (Timur) |
| Temperatur | 31°C (tropical) |

### Zona

| Zona | Warna | Ukuran | Elevasi | Deskripsi |
|------|-------|--------|---------|-----------|
| Sawah Kiri | 🔴 Merah | 220m × 290m | Z = 0.00 m | Flat, irigasi aktif |
| Sawah Kanan Atas | 🔴 Merah | 280m × 175m | Z = 0.00 m | Flat, irigasi aktif |
| Sawah Tengah Bawah | 🔴 Merah | 170m × 115m | Z = 0.00 m | Flat |
| Terrain Mudun | 🔵 Biru | 140m × 115m | Z = −1.50 m | Terrain lebih rendah |

---

## 🛠️ Prerequisites

```bash
# ROS2 Jazzy
source /opt/ros/jazzy/setup.bash

# Gazebo Harmony (Ionic)
sudo apt install gz-ionic

# ROS-Gazebo bridge
sudo apt install ros-jazzy-ros-gz
sudo apt install ros-jazzy-ros-gz-bridge
sudo apt install ros-jazzy-ros-gz-image

# Optional (untuk autopilot)
sudo apt install ros-jazzy-actuator-msgs
```

---

## 🚀 Build & Run

```bash
# 1. Clone / copy package ke workspace
cd ~/agricultural_drone_ws
colcon build --packages-select agricultural_world
source install/setup.bash

# 2. Launch world (dengan GUI)
ros2 launch agricultural_world agricultural_world.launch.py

# 3. Launch headless (server only — untuk CI/CD)
ros2 launch agricultural_world agricultural_world.launch.py headless:=true

# 4. Launch dengan custom drone spawn
ros2 launch agricultural_world agricultural_world.launch.py \
    drone_model:=iris \
    spawn_x:=-65.0 \
    spawn_y:=0.0 \
    spawn_z:=2.0 \
    altitude:=15.0
```

---

## 🗺️ Coordinate System

```
World frame (ENU — East North Up):
  +X = East (kanan di peta)
  +Y = North (atas di peta)
  +Z = Up

Spawn point drone  : X=-65, Y=0, Z=2
Zona Merah tengah  : X=-65, Y=0
Zona Biru tengah   : X=285, Y=-144 (ground Z=-1.5)

Jl. Aruman         : Y≈+145 (batas utara)
```

---

## 📡 ROS2 Topics (setelah bridge aktif)

### Sensor Output (GZ → ROS)
| Topic | Type | Keterangan |
|-------|------|------------|
| `/drone/imu` | `sensor_msgs/Imu` | IMU 9-DOF |
| `/drone/gps` | `sensor_msgs/NavSatFix` | GPS position |
| `/drone/odom` | `nav_msgs/Odometry` | Ground truth |
| `/drone/camera/image_raw` | `sensor_msgs/Image` | Kamera RGB |
| `/drone/lidar/scan` | `sensor_msgs/LaserScan` | LiDAR downward |
| `/drone/lidar/points` | `sensor_msgs/PointCloud2` | PointCloud |
| `/drone/altimeter` | `sensor_msgs/FluidPressure` | Barometer |

### Control Input (ROS → GZ)
| Topic | Type | Keterangan |
|-------|------|------------|
| `/drone/cmd_vel` | `geometry_msgs/Twist` | Velocity command |
| `/drone/goal_pose` | `geometry_msgs/PoseStamped` | Navigation goal |
| `/drone/actuators` | `actuator_msgs/Actuators` | Motor speed |

---

## ✈️ Menjalankan Misi Patrol

```bash
# Setelah world dan drone sudah running:
ros2 run agricultural_world field_patrol_mission.py \
    --ros-args \
    -p altitude:=15.0 \
    -p altitude_blue_zone:=16.5 \
    -p speed:=5.0 \
    -p sweep_spacing:=20.0

# Monitor status misi:
ros2 topic echo /drone/mission_status

# Monitor GPS:
ros2 topic echo /drone/gps
```

---

## 🔧 Kustomisasi World

### Ubah Ketinggian Zona Biru
Edit `worlds/agricultural_field.sdf`, cari model `terrain_biru_dasar`:
```xml
<pose>285 -144 -1.5 0 0 0</pose>
<!-- Ubah -1.5 sesuai kebutuhan -->
```

### Tambah Objek (pohon, gubuk, dll)
Tambahkan model baru di dalam `<world>`:
```xml
<model name="gubuk_tani">
  <static>true</static>
  <pose>-100 50 0 0 0 0</pose>
  <link name="bangunan">
    <visual name="v">
      <geometry><box><size>4 4 3</size></box></geometry>
      <material>
        <ambient>0.6 0.4 0.2 1</ambient>
        <diffuse>0.7 0.5 0.3 1</diffuse>
      </material>
    </visual>
    <collision name="c">
      <geometry><box><size>4 4 3</size></box></geometry>
    </collision>
  </link>
</model>
```

### Ubah Kondisi Cuaca (Wind)
```xml
<wind>
  <linear_velocity>3.0 1.0 0</linear_velocity>  <!-- angin lebih kencang -->
</wind>
```

---

## 📂 Struktur Package

```
agricultural_world/
├── CMakeLists.txt
├── package.xml
├── README.md
├── worlds/
│   └── agricultural_field.sdf      ← World utama Gazebo Harmony
├── launch/
│   └── agricultural_world.launch.py ← ROS2 Jazzy launch file
├── config/
│   ├── gz_bridge.yaml               ← Gazebo↔ROS2 topic bridge
│   └── drone_monitoring.rviz        ← RViz2 config (buat sendiri)
├── models/
│   ├── iris/                        ← Model drone (dari PX4 SITL)
│   └── custom_agri_drone/           ← Model drone custom (opsional)
└── scripts/
    └── field_patrol_mission.py      ← Misi patrol otomatis
```

---

## ❓ Troubleshooting

**World tidak muncul di Gazebo**
```bash
# Cek apakah file SDF valid
gz sdf -k worlds/agricultural_field.sdf
```

**Bridge tidak konek**
```bash
# Cek topic tersedia di Gazebo
gz topic -l | grep iris
```

**Drone tidak spawn**
```bash
# Set GZ resource path
export GZ_SIM_RESOURCE_PATH=$GZ_SIM_RESOURCE_PATH:$(ros2 pkg prefix agricultural_world)/share/agricultural_world/models
```
