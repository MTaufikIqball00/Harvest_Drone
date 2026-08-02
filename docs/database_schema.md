# Dokumentasi Skema Relasi Database: Drone Stack (Modul Drone)

Dokumen ini menggambarkan skema relasional untuk sisi **operasional drone**
saja — akun, inventaris drone, misi penerbangan, dan lima jalur logging
real-time. Modul klasifikasi panen & AI geospasial (`field_boundaries`,
`harvest_jobs`, `harvest_classifications`, `image_metadata`) sengaja
dikeluarkan dari cakupan diagram ini.

Sumber: [`database/drone_schema.sql`](../database/drone_schema.sql) (MySQL,
sumber utama), port 1:1 di
[`database/supabase_schema.sql`](../database/supabase_schema.sql) (PostgreSQL).

## 1. ER Diagram (Mermaid.js)

```mermaid
erDiagram
    USERS ||--o{ MISSIONS : "operates"
    DRONES ||--o{ MISSIONS : "flies"

    DRONES ||--o{ TELEMETRY_LOGS : "reports"
    DRONES ||--o{ BATTERY_LOGS : "reports"
    DRONES ||--o{ WIND_LOGS : "reports"
    DRONES ||--o{ OBSTACLE_LOGS : "detects"
    DRONES ||--o{ ERROR_LOGS : "raises"

    MISSIONS ||--o{ TELEMETRY_LOGS : "logs"
    MISSIONS ||--o{ BATTERY_LOGS : "logs"
    MISSIONS ||--o{ WIND_LOGS : "logs"
    MISSIONS ||--o{ OBSTACLE_LOGS : "logs"
    MISSIONS ||--o{ ERROR_LOGS : "logs"

    USERS {
        int id PK
        string username UK
        string password_hash
        enum role "admin|operator|viewer"
        timestamp created_at
    }

    DRONES {
        int id PK
        string name
        string model
        enum status "active|maintenance|retired"
        timestamp created_at
    }

    MISSIONS {
        int id PK
        int drone_id FK
        int operator_id FK
        timestamp start_time
        timestamp end_time
        float start_x
        float start_y
        float dest_x
        float dest_y
        string flight_mode
        float goal_distance_m
        string goal_distance_source
        float total_distance_m
        float battery_used_percent
        enum status "planned|in_progress|completed|failed|aborted"
        timestamp arrival_time
        timestamp rth_start_time
        timestamp landing_time
        int total_duration_sec
    }

    TELEMETRY_LOGS {
        bigint id PK
        int mission_id FK "nullable"
        int drone_id FK
        timestamp recorded_at
        float x
        float y
        float z
        double latitude
        double longitude
        float altitude_m
        float velocity_x
        float velocity_y
        float velocity_z
        float speed_mps
        float yaw_rad
        float pitch_rad
        float roll_rad
        float heading_deg
        string flight_mode
        string nav_state
        string source
        json raw_payload
    }

    BATTERY_LOGS {
        bigint id PK
        int mission_id FK "nullable"
        int drone_id FK
        timestamp recorded_at
        float battery_percent
        float voltage_v
        float current_a
        float estimated_remaining_sec
        string warning_level
        json raw_payload
    }

    WIND_LOGS {
        bigint id PK
        int mission_id FK "nullable"
        int drone_id FK
        timestamp recorded_at
        float wind_speed_mps
        float wind_direction_deg
        float wind_north_mps
        float wind_east_mps
        string safety_status
        json raw_payload
    }

    OBSTACLE_LOGS {
        bigint id PK
        string obstacle_uid
        int mission_id FK "nullable"
        int drone_id FK
        timestamp detected_at
        float x
        float y
        float z
        double latitude
        double longitude
        float radius_m
        float width_m
        float height_m
        string obstacle_type
        string source
        float confidence
        string avoidance_action
        json raw_payload
    }

    ERROR_LOGS {
        bigint id PK
        int mission_id FK "nullable"
        int drone_id FK
        timestamp occurred_at
        enum severity "info|warning|error|critical"
        string subsystem
        string event_type
        string error_code
        text message
        json context
        timestamp resolved_at
    }
```

## 2. Detail Spesifikasi Tabel

### A. Master Data

| Tabel | Kolom Kunci | Constraint | Deskripsi |
| :--- | :--- | :--- | :--- |
| **users** | `id` PK, `username` UNIQUE, `role` ENUM | — | Akun operator/admin dashboard. |
| **drones** | `id` PK, `status` ENUM | — | Inventaris unit drone. |

### B. Transaksi Misi

| Tabel | Relasi | Deskripsi |
| :--- | :--- | :--- |
| **missions** | `drone_id` → drones (CASCADE), `operator_id` → users (SET NULL) | Header sesi penerbangan: titik awal/tujuan, jarak, baterai terpakai, status, timestamp RTH/landing. |

### C. Logging Real-Time (High-Volume)

| Tabel | Relasi | Deskripsi |
| :--- | :--- | :--- |
| **telemetry_logs** | `mission_id` (nullable, CASCADE), `drone_id` (CASCADE) | Posisi, kecepatan, orientasi (indexed by `mission_id, recorded_at`). |
| **battery_logs** | `mission_id`, `drone_id` (CASCADE) | Persentase baterai, tegangan, arus, estimasi sisa waktu. |
| **wind_logs** | `mission_id`, `drone_id` (CASCADE) | Kecepatan & arah angin, status keamanan terbang. |
| **obstacle_logs** | `mission_id`, `drone_id` (CASCADE) | Deteksi rintangan (LiDAR/vision), aksi penghindaran. |
| **error_logs** | `mission_id`, `drone_id` (CASCADE) | Log error/warning subsistem (ROS 2, PX4). |

`mission_id` nullable di semua tabel log ini karena beberapa data (mis.
telemetry saat idle) bisa direkam di luar konteks misi aktif.

## 3. Penjelasan Hubungan (Relationships)

1. **One-to-Many (1:N):**
   - `users → missions`: satu operator bisa menjalankan banyak misi (`operator_id`, `ON DELETE SET NULL` — misi tetap ada walau user dihapus).
   - `drones → missions`: satu drone dipakai di banyak misi (`ON DELETE CASCADE`).
   - `drones/missions → telemetry_logs|battery_logs|wind_logs|obstacle_logs|error_logs`: satu misi/drone menghasilkan ribuan baris log.
2. **Tidak ada relasi Many-to-Many** eksplisit dalam skema ini — relasi N:N potensial (mis. drone bisa dipakai banyak operator) sudah dinormalisasi lewat tabel `missions` sebagai penghubung.

> Modul klasifikasi panen & AI geospasial (`field_boundaries`, `harvest_jobs`,
> `harvest_classifications`, `image_metadata`) didokumentasikan terpisah —
> lihat riwayat sebelumnya di file ini atau `database/drone_schema.sql`
> bagian 4 jika dibutuhkan lagi.

## 4. Cara Regenerasi Diagram

Skema Mermaid di atas adalah "kode"-nya — render di GitHub (otomatis), VS
Code (ekstensi Markdown Preview Mermaid), atau [mermaid.live](https://mermaid.live).
Sumber kebenaran struktur tabel tetap file DDL:

```bash
# MySQL (lokal)
mysql -u root -p < database/drone_schema.sql

# PostgreSQL/Supabase
psql "$SUPABASE_DB_URL" -f database/supabase_schema.sql
```
