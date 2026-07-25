# Dokumentasi Sistem Drone Autonomous
**Platform: ROS 2 Jazzy | PX4 Autopilot | Gazebo Harmonic | Next.js | MySQL**

## 1. Arsitektur Teknologi
Sistem ini dirancang untuk melakukan navigasi drone secara otonom dengan monitoring real-time.
- **Frontend:** Next.js (Dashboard & Visualisasi Map)
- **Communication:** WebSockets (Real-time Data) & REST API
- **Middleware:** ROS 2 Jazzy (DDS Communication)
- **Flight Controller:** PX4 Autopilot
- **Simulator:** Gazebo Harmonic (Physics Engine)
- **Database:** MySQL (dengan phpMyAdmin sebagai manajemen UI)

---

## 2. Entity Relationship Diagram (ERD)
Diagram di bawah ini menjelaskan struktur data dan hubungan antar entitas dalam database MySQL.

```mermaid
erDiagram
    USERS ||--o{ FLIGHT_MISSIONS : "performs"
    DRONES ||--o{ TELEMETRY_LOGS : "generates"
    DRONES ||--o{ BATTERY_LOGS : "monitors"
    DRONES ||--o{ REALTIME_TRACKING : "updates"
    DRONES ||--o{ OBSTACLE_LOGS : "detects"
    DRONES ||--o{ WIND_LOGS : "records"
    FLIGHT_MISSIONS ||--o{ AUTONOMOUS_RESULTS : "produces"
    FLIGHT_MISSIONS ||--o{ ERROR_LOGS : "triggers"
    DRONES ||--o{ FLIGHT_MISSIONS : "assigned to"

    USERS {
        int id PK
        string username
        string email
        string password
        string role
    }

    DRONES {
        int id PK
        string drone_name
        string model_type
        string status
    }

    TELEMETRY_LOGS {
        int id PK
        int drone_id FK
        float latitude
        float longitude
        float altitude
        float velocity
        timestamp created_at
    }

    BATTERY_LOGS {
        int id PK
        int drone_id FK
        float voltage
        float percentage
        float current
        timestamp created_at
    }

    FLIGHT_MISSIONS {
        int id PK
        int user_id FK
        int drone_id FK
        string mission_name
        string mission_status
        timestamp start_time
        timestamp end_time
    }

    OBSTACLE_LOGS {
        int id PK
        int drone_id FK
        float distance
        string sensor_position
        timestamp created_at
    }

    WIND_LOGS {
        int id PK
        int drone_id FK
        float speed
        string direction
        timestamp created_at
    }

    AUTONOMOUS_RESULTS {
        int id PK
        int mission_id FK
        text summary
        float accuracy_rate
        string flight_path_json
    }

    ERROR_LOGS {
        int id PK
        int mission_id FK
        string error_code
        text description
        timestamp created_at
    }

    REALTIME_TRACKING {
        int id PK
        int drone_id FK
        float lat
        float lng
        float heading
    }
```

---

## 3. Skema Relasi Database
| Tabel | Relasi | Deskripsi |
| :--- | :--- | :--- |
| **Users -> Flight Missions** | `One-to-Many` | Satu user dapat mengelola banyak misi penerbangan. |
| **Drones -> Telemetry/Battery** | `One-to-Many` | Satu drone menghasilkan log telemetri dan baterai secara kontinu. |
| **Drones -> Realtime Tracking** | `One-to-One/Many` | Data posisi terkini drone untuk sinkronisasi dashboard UI. |
| **Flight Missions -> Results** | `One-to-One` | Setiap misi yang selesai akan menghasilkan satu ringkasan hasil otonom. |
| **Drones -> Obstacle/Wind Logs** | `One-to-Many` | Drone mencatat gangguan eksternal (angin/rintangan) selama penerbangan. |

---

## 4. Data Flow Diagram (DFD)

### DFD Level 0 (Context Diagram)
Menggambarkan interaksi sistem utama dengan entitas eksternal (User dan Environment Simulator).

```mermaid
graph LR
    User((User/Operator)) -- "Command/Mission" --> System[System Drone Autonomous]
    System -- "Real-time Data/Alerts" --> User
    
    Gazebo((Gazebo/PX4 Environment)) -- "Sensor Data/Physics" --> System
    System -- "Actuator Control/PWM" --> Gazebo
    
    DB[(MySQL Database)] <--> System
```

### DFD Level 1 (Process Detail)
Penjelasan detail proses internal sistem.

```mermaid
graph TD
    subgraph Frontend_NextJS
        P1[UI Dashboard & Mission Planner]
        P2[WebSocket Client Visualizer]
    end

    subgraph ROS2_Middleware
        P3[Autonomous Navigation Engine]
        P4[Obstacle Avoidance System]
        P5[Telemetry & Status Logger]
        P6[RTH - Return To Home Manager]
    end

    subgraph Hardware_Simulation
        P7[PX4 Autopilot & Gazebo]
    end

    subgraph Data_Storage
        P8[(MySQL & phpMyAdmin)]
    end

    %% Flow UI to ROS2
    User --> P1
    P1 -- "Mission Protocol" --> P3
    
    %% Flow ROS2 to PX4
    P3 -- "Offboard Command" --> P7
    P4 -- "Safety Stop/Bypass" --> P7
    P7 -- "Sensor/Lidar Data" --> P4
    P7 -- "Global Position" --> P5
    
    %% Flow Logging
    P5 -- "Insert Telemetry/Battery" --> P8
    P4 -- "Insert Obstacle Log" --> P8
    P7 -- "Failsafe Trigger" --> P6
    
    %% Flow Realtime Visualization
    P5 -- "Broadcast WebSocket" --> P2
    P2 -- "Render Map/Charts" --> User
    
    %% Feedback Loop
    P6 -- "Command Land/RTL" --> P7
```

---

## 5. Penjelasan Proses Utama

1.  **Autonomous Navigation:** Proses ini menerima *waypoints* dari Next.js melalui ROS 2 Service/Action. Navigation Engine menghitung lintasan dan mengirimkan perintah `setpoint_raw` ke PX4.
2.  **Obstacle Avoidance:** Menggunakan data sensor (LiDAR/Depth Camera) dari Gazebo Harmonic. Jika rintangan terdeteksi, sistem interupsi pada DFD Level 1 akan mengalihkan jalur atau menghentikan drone.
3.  **Telemetry Logging:** ROS 2 *subscriber* menangkap data dari topic `/fmu/out/vehicle_global_position` dan menyimpannya ke MySQL melalui backend API secara periodik.
4.  **Battery Monitoring & RTH:** Sistem secara konstan memonitor tegangan baterai. Jika di bawah ambang batas (misal 20%), proses *Return To Home* (P6) akan mengambil alih kendali PX4 untuk mendaratkan drone di *home position*.
5.  **WebSocket Communication:** Digunakan untuk mem-bypass latensi database saat visualisasi. Data koordinat langsung dikirim dari ROS 2 ke UI Next.js untuk pergerakan marker map yang mulus.
6.  **Wind Logging:** Mencatat simulasi gaya eksternal dari Gazebo untuk menganalisis stabilitas algoritma PID/EKF pada drone.

---

## 6. Cara Menggunakan
1.  **Diagram:** Pastikan file ini disimpan dengan ekstensi `.md`. Jika dibuka di GitHub atau VS Code (dengan ekstensi Mermaid), diagram akan otomatis muncul.
2.  **Database:** Gunakan skema ERD untuk membuat tabel di **phpMyAdmin**.
3.  **Integrasi:** Pastikan `rosbridge_suite` terpasang jika ingin menghubungkan Next.js langsung ke ROS 2 melalui WebSockets.

---

### Catatan Profesional
Dokumentasi ini dirancang agar memenuhi standar teknis laporan skripsi atau dokumentasi teknis perusahaan. Penggunaan **Mermaid.js** memastikan bahwa dokumentasi Anda bersifat *version-control friendly* karena berbasis teks, bukan gambar statis.
