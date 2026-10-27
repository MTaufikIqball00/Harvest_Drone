# Dokumentasi Sistem Drone Autonomous & AI Harvest Classification
**Platform: ROS 2 Jazzy | PX4 Autopilot / ArduPilot / DJI Spark | Gazebo Harmonic | Next.js 15 | FastAPI AI | PostgreSQL (Supabase)**

## 1. Arsitektur Teknologi
Sistem ini dirancang untuk monitoring pertanian presisi, navigasi drone otonom, dan analisis kesiapan panen padi secara real-time.
- **Frontend Dashboard:** Next.js 15 (React 19, Leaflet/Protomaps offline basemap, ROSLib WebSocket client)
- **AI Processing Backend:** FastAPI (OpenCV, Rasterio, CLAHE & HSV Segmentation, NodeODM Photogrammetry)
- **Middleware & Robotics:** ROS 2 Jazzy (rclpy, uXRCE-DDS Agent untuk PX4, MAVROS untuk ArduPilot, rosbridge WebSocket suite)
- **Flight Controller & Simulator:** PX4 Autopilot v1.14+, ArduPilot SITL, DJI Spark (Android Mobile SDK), Gazebo Harmonic
- **Database:** PostgreSQL / Supabase (menggunakan pg pool di Next.js dan psycopg2 batch writer di ROS 2)

---

## 2. Entity Relationship Diagram (ERD)
Diagram di bawah menjelaskan struktur data relasional PostgreSQL (`database/supabase_schema.sql`):

```mermaid
erDiagram
    USERS ||--o{ MISSIONS : "operates"
    DRONES ||--o{ MISSIONS : "assigned"
    DRONES ||--o{ TELEMETRY_LOGS : "logs"
    DRONES ||--o{ BATTERY_LOGS : "monitors"
    DRONES ||--o{ OBSTACLE_LOGS : "detects"
    DRONES ||--o{ WIND_LOGS : "records"
    DRONES ||--o{ ERROR_LOGS : "reports"
    MISSIONS ||--o{ TELEMETRY_LOGS : "tracks"
    MISSIONS ||--o{ BATTERY_LOGS : "records"
    MISSIONS ||--o{ OBSTACLE_LOGS : "encounters"
    MISSIONS ||--o{ ERROR_LOGS : "triggers"
    MISSIONS ||--o{ HARVEST_JOBS : "links"
    HARVEST_JOBS ||--o{ HARVEST_CLASSIFICATIONS : "produces"

    USERS {
        int id PK
        string username
        string password_hash
        user_role role
        timestamptz created_at
    }

    DRONES {
        int id PK
        string name
        string model
        drone_status status
        timestamptz created_at
    }

    MISSIONS {
        int id PK
        int drone_id FK
        int operator_id FK
        timestamptz start_time
        timestamptz end_time
        timestamptz arrival_time
        float start_x
        float start_y
        float dest_x
        float dest_y
        float goal_distance_m
        string goal_distance_source
        string flight_mode
        mission_status status
        int total_duration_sec
    }

    TELEMETRY_LOGS {
        bigint id PK
        int mission_id FK
        int drone_id FK
        timestamptz recorded_at
        float x
        float y
        float z
        float latitude
        float longitude
        float altitude_m
        float speed_mps
        float heading_deg
        string flight_mode
    }

    BATTERY_LOGS {
        bigint id PK
        int mission_id FK
        int drone_id FK
        timestamptz recorded_at
        float battery_percent
        float voltage_v
        float current_a
        float estimated_remaining_sec
    }

    OBSTACLE_LOGS {
        bigint id PK
        int mission_id FK
        int drone_id FK
        string obstacle_uid
        timestamptz detected_at
        float x
        float y
        float radius_m
        string obstacle_type
        string source
        string avoidance_action
    }

    WIND_LOGS {
        bigint id PK
        int mission_id FK
        int drone_id FK
        timestamptz recorded_at
        float wind_speed_mps
        float wind_direction_deg
        string safety_status
    }

    ERROR_LOGS {
        bigint id PK
        int mission_id FK
        int drone_id FK
        timestamptz occurred_at
        string severity
        string subsystem
        string message
    }

    HARVEST_JOBS {
        string id PK
        int mission_id FK
        string job_name
        job_status status
        float progress_percent
        float total_area_m2
        float estimated_yield_tons
        timestamptz created_at
    }

    HARVEST_CLASSIFICATIONS {
        bigint id PK
        string job_id FK
        string class_name
        bigint pixel_count
        float area_m2
        float percentage
        string color_hex
    }
```

---

## 3. Data Flow Diagram (DFD)

### DFD Level 0 (Context Diagram)
```mermaid
graph LR
    Operator((Operator / Pilot)) -- "Waypoint & Command" --> System[Drone Stack Platform]
    System -- "Real-time Telemetry & Panen AI" --> Operator
    
    Drone((Drone / PX4 / Gazebo)) -- "Sensor Data & Odometry" --> System
    System -- "Offboard Setpoint / MAVLink" --> Drone
    
    PostgreSQL[(PostgreSQL / Supabase)] <--> System
    NodeODM[(NodeODM Photogrammetry)] <--> System
```

### DFD Level 1 (Proses Internal)
```mermaid
graph TD
    subgraph Frontend_NextJS
        P1[Dashboard & Mission Planner]
        P2[ROSLib WebSocket Client]
        P3[AI Analysis Viewer]
    end

    subgraph ROS2_Middleware
        P4[Dashboard Bridge Node]
        P5[A-Star & Boustrophedon Planner]
        P6[Postgres Telemetry Logger]
        P7[rosbridge_server WebSocket :9090]
    end

    subgraph Backend_AI_FastAPI
        P8[FastAPI Server :8000]
        P9[Stitching & Classification Engine]
    end

    subgraph External_Systems
        P10[PX4 SITL / ArduPilot / DJI Spark]
        P11[Gazebo Harmonic Simulator]
        P12[NodeODM Service :3001]
        P13[(PostgreSQL / Supabase)]
    end

    %% Flow UI to ROS2
    P1 -- "Waypoint / Command" --> P2
    P2 -- "WS JSON" --> P7
    P7 <--> P4
    P4 <--> P5
    P4 -- "uORB / MAVLink" --> P10
    P11 -- "LiDAR & Clock" --> P4
    
    %% Telemetry logging
    P4 -- "/dashboard/* topics" --> P6
    P6 -- "Batch INSERT" --> P13

    %% AI Pipeline
    P1 -- "Upload Raw Photos" --> P8
    P8 <--> P12
    P8 --> P9
    P9 -- "Save Results & Overlay" --> P3
    P1 -- "API /missions" --> P13
```

---

## 4. Penjelasan Komponen Utama

1. **Dashboard Bridge (`drone_dashboard_bridge`):**
   - Mendukung multi flight stack: PX4 SITL (uXRCE-DDS), ArduPilot (MAVROS), dan DJI Spark (Android App Bridge).
   - Menangani kalkulasi geodesi (WGS84 lat/lon ke ENU lokal meter), deteksi rintangan LiDAR 2D, serta replanning jalur A* secara dinamis.
2. **Postgres Telemetry Logger (`mysql_telemetry_logger.py`):**
   - Merekam telemetri, baterai, estimasi angin, dan rintangan ke database PostgreSQL/Supabase secara asinkron dengan antrean *batch writer* (`executemany`) berkinerja tinggi.
3. **Backend AI (`backend_ai`):**
   - Ekstraksi metadata GeoTIFF menggunakan Rasterio.
   - Segmentasi citra tanaman padi matang (siap panen) vs belum matang menggunakan *color space* HSV adaptif dan CLAHE.
   - Komunikasi otomatis dengan NodeODM untuk menghasilkan orthophoto resolusi tinggi.
4. **Keamanan & Autentikasi:**
   - Autentikasi operator berbasis HMAC-SHA256 *signed cookie* (Edge compatible).
   - Password disimpan dengan algoritma `scrypt`.
   - Pencegahan *path traversal* pada berkas upload dan output geospasial.
