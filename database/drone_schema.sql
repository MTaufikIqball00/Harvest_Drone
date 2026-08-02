-- Buat database jika belum ada
CREATE DATABASE IF NOT EXISTS drone_ops
CHARACTER SET utf8mb4 
COLLATE utf8mb4_unicode_ci;

USE drone_ops;

-- Hapus tabel lama agar skema baru bisa diterapkan tanpa konflik Foreign Key
SET FOREIGN_KEY_CHECKS = 0;
DROP TABLE IF EXISTS harvest_classifications;
DROP TABLE IF EXISTS image_metadata;
DROP TABLE IF EXISTS harvest_jobs;
DROP TABLE IF EXISTS field_boundaries;
DROP TABLE IF EXISTS error_logs;
DROP TABLE IF EXISTS obstacle_logs;
DROP TABLE IF EXISTS wind_logs;
DROP TABLE IF EXISTS battery_logs;
DROP TABLE IF EXISTS telemetry_logs;
DROP TABLE IF EXISTS flight_path_points;
DROP TABLE IF EXISTS autonomous_results;
DROP TABLE IF EXISTS manual_auto_comparisons;
DROP TABLE IF EXISTS flight_missions;
DROP TABLE IF EXISTS missions;
DROP TABLE IF EXISTS drones;
DROP TABLE IF EXISTS users;
SET FOREIGN_KEY_CHECKS = 1;

-- =======================================================
-- 1. TABEL MASTER: USERS & DRONES
-- =======================================================
CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(50) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('admin', 'operator', 'viewer') DEFAULT 'operator',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS drones (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    model VARCHAR(100),
    status ENUM('active', 'maintenance', 'retired') DEFAULT 'active',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Data dummy dasar
INSERT IGNORE INTO users (id, username, password_hash, role) VALUES 
(1, 'iqball', 'hashed_password_here', 'admin');

INSERT IGNORE INTO drones (id, name, model, status) VALUES 
(1, 'PX4-Gazebo-X500', 'Quadcopter', 'active');


-- =======================================================
-- 2. TABEL TRANSAKSI: MISSIONS
-- =======================================================
CREATE TABLE IF NOT EXISTS missions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    drone_id INT NOT NULL,
    operator_id INT,
    start_time TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    end_time TIMESTAMP NULL,
    start_x FLOAT,
    start_y FLOAT,
    dest_x FLOAT,
    dest_y FLOAT,
    flight_mode VARCHAR(50) DEFAULT 'auto',
    -- Jarak drone -> waypoint tujuan pada SAAT "Send Goal" ditekan (meter).
    -- Sengaja dipisah dari total_distance_m: yang ini jarak rencana lurus ke
    -- target, sedangkan total_distance_m adalah jarak tempuh aktual (yang
    -- selalu lebih besar karena drone menghindari rintangan).
    goal_distance_m FLOAT DEFAULT NULL,
    -- Basis perhitungan goal_distance_m: 'gps' (haversine lat/lon) atau
    -- 'local' (Euclidean pada koordinat lokal). Keduanya satuan METER.
    goal_distance_source VARCHAR(10) DEFAULT NULL,
    total_distance_m FLOAT DEFAULT 0.0,
    battery_used_percent FLOAT DEFAULT 0.0,
    status ENUM('planned', 'in_progress', 'completed', 'failed', 'aborted') DEFAULT 'in_progress',
    arrival_time TIMESTAMP NULL,
    rth_start_time TIMESTAMP NULL,
    landing_time TIMESTAMP NULL,
    total_duration_sec INT DEFAULT 0,
    FOREIGN KEY (drone_id) REFERENCES drones(id) ON DELETE CASCADE,
    FOREIGN KEY (operator_id) REFERENCES users(id) ON DELETE SET NULL
);


-- =======================================================
-- 3. TABEL LOGGING: TELEMETRY, BATTERY, OBSTACLES, ERROR
-- =======================================================
CREATE TABLE IF NOT EXISTS telemetry_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    mission_id INT NULL,
    drone_id INT NOT NULL,
    recorded_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    x FLOAT,
    y FLOAT,
    z FLOAT,
    latitude DOUBLE,
    longitude DOUBLE,
    altitude_m FLOAT,
    velocity_x FLOAT,
    velocity_y FLOAT,
    velocity_z FLOAT,
    speed_mps FLOAT,
    yaw_rad FLOAT,
    pitch_rad FLOAT,
    roll_rad FLOAT,
    heading_deg FLOAT,
    flight_mode VARCHAR(50),
    nav_state VARCHAR(50),
    source VARCHAR(50),
    raw_payload JSON,
    
    INDEX idx_mission_time (mission_id, recorded_at),
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
    FOREIGN KEY (drone_id) REFERENCES drones(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS battery_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    mission_id INT NULL,
    drone_id INT NOT NULL,
    recorded_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    battery_percent FLOAT,
    voltage_v FLOAT,
    current_a FLOAT,
    estimated_remaining_sec FLOAT,
    warning_level VARCHAR(20),
    raw_payload JSON,
    
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
    FOREIGN KEY (drone_id) REFERENCES drones(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS wind_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    mission_id INT NULL,
    drone_id INT NOT NULL,
    recorded_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    wind_speed_mps FLOAT,
    wind_direction_deg FLOAT,
    wind_north_mps FLOAT,
    wind_east_mps FLOAT,
    safety_status VARCHAR(20),
    raw_payload JSON,
    
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
    FOREIGN KEY (drone_id) REFERENCES drones(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS obstacle_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    obstacle_uid VARCHAR(100),
    mission_id INT NULL,
    drone_id INT NOT NULL,
    detected_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    x FLOAT,
    y FLOAT,
    z FLOAT,
    latitude DOUBLE,
    longitude DOUBLE,
    radius_m FLOAT,
    width_m FLOAT,
    height_m FLOAT,
    obstacle_type VARCHAR(50),
    source VARCHAR(50),
    confidence FLOAT,
    avoidance_action VARCHAR(50),
    raw_payload JSON,
    
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
    FOREIGN KEY (drone_id) REFERENCES drones(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS error_logs (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    mission_id INT NULL,
    drone_id INT NOT NULL,
    occurred_at TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP(3),
    severity ENUM('info', 'warning', 'error', 'critical') DEFAULT 'info',
    subsystem VARCHAR(50),
    event_type VARCHAR(100),
    error_code VARCHAR(50),
    message TEXT,
    context JSON,
    resolved_at TIMESTAMP NULL,
    
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE CASCADE,
    FOREIGN KEY (drone_id) REFERENCES drones(id) ON DELETE CASCADE
);


-- =======================================================
-- 4. TABEL RICE HARVEST CLASSIFICATION & GEOSPATIAL AI
-- =======================================================
CREATE TABLE IF NOT EXISTS field_boundaries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    field_name VARCHAR(100) NOT NULL,
    boundary_geojson JSON,
    target_crop VARCHAR(50) DEFAULT 'padi',
    area_ha FLOAT DEFAULT 0.0,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS harvest_jobs (
    id VARCHAR(100) PRIMARY KEY,
    mission_id INT NULL,
    job_name VARCHAR(255),
    status ENUM('pending', 'processing', 'completed', 'failed') DEFAULT 'pending',
    progress_percent FLOAT DEFAULT 0.0,
    original_filename VARCHAR(255),
    input_file_path TEXT,
    output_file_path TEXT,
    output_geotiff_path TEXT,
    total_area_m2 FLOAT DEFAULT 0.0,
    estimated_yield_tons FLOAT DEFAULT 0.0,
    error_message TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMP NULL,
    
    FOREIGN KEY (mission_id) REFERENCES missions(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS harvest_classifications (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(100) NOT NULL,
    class_name VARCHAR(100) NOT NULL,
    pixel_count BIGINT DEFAULT 0,
    area_m2 FLOAT DEFAULT 0.0,
    percentage FLOAT DEFAULT 0.0,
    color_hex VARCHAR(20),
    
    FOREIGN KEY (job_id) REFERENCES harvest_jobs(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS image_metadata (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    job_id VARCHAR(100) NOT NULL,
    camera_model VARCHAR(100),
    focal_length_mm FLOAT,
    iso INT,
    exposure_time VARCHAR(50),
    gps_latitude DOUBLE,
    gps_longitude DOUBLE,
    gps_altitude_m FLOAT,
    capture_time TIMESTAMP NULL,
    raw_exif JSON,
    
    FOREIGN KEY (job_id) REFERENCES harvest_jobs(id) ON DELETE CASCADE
);
