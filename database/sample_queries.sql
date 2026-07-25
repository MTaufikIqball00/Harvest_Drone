USE drone_ops;

-- 1) Insert satu sample telemetry (ROS 2 logger akan menggunakan batch insert di background).
INSERT INTO telemetry_logs (
  drone_id, mission_id, recorded_at,
  x, y, z, altitude_m,
  velocity_x, velocity_y, velocity_z, speed_mps,
  yaw_rad, pitch_rad, roll_rad, heading_deg,
  flight_mode, nav_state, source
) VALUES (
  1, 1, UTC_TIMESTAMP(3),
  -65.0, 0.0, 8.0, 8.0,
  1.2, 0.1, 0.0, 1.204,
  1.57, 0.01, 0.0, 90.0,
  'auto', 'OFFBOARD', 'ros2'
);

-- 2) Ambil histori penerbangan satu misi (Path tracking).
SELECT
  recorded_at, x, y, z, altitude_m, speed_mps,
  heading_deg, flight_mode, nav_state
FROM telemetry_logs
WHERE mission_id = 1
ORDER BY recorded_at ASC
LIMIT 5000;

-- 3) Ambil telemetry terbaru per drone untuk Live Dashboard.
-- Menggunakan subquery untuk mencari data paling mutakhir (terbaru)
SELECT 
  d.name,
  t.recorded_at,
  t.x, t.y, t.z,
  t.altitude_m,
  t.speed_mps,
  t.heading_deg,
  t.flight_mode,
  t.nav_state
FROM telemetry_logs t
JOIN drones d ON d.id = t.drone_id
WHERE t.drone_id = 1
ORDER BY t.recorded_at DESC
LIMIT 1;

-- 4) Statistik penggunaan baterai per misi.
SELECT
  m.id AS mission_id,
  m.start_time,
  MIN(bl.battery_percent) AS min_battery_percent,
  MAX(bl.battery_percent) AS max_battery_percent,
  (MAX(bl.battery_percent) - MIN(bl.battery_percent)) AS battery_used_percent,
  AVG(bl.voltage_v) AS avg_voltage_v,
  AVG(bl.current_a) AS avg_current_a
FROM missions m
JOIN battery_logs bl ON bl.mission_id = m.id
WHERE m.drone_id = 1
GROUP BY m.id, m.start_time
ORDER BY m.start_time DESC;

-- 5) Total mission success/failed/aborted.
SELECT
  status,
  COUNT(*) AS total_missions
FROM missions
WHERE drone_id = 1
GROUP BY status;

-- 6) Daftar log Rintangan (Obstacles) yang dideteksi saat terbang.
SELECT
  detected_at, obstacle_uid, obstacle_type, source,
  x, y, z, radius_m, avoidance_action
FROM obstacle_logs
WHERE mission_id = 1
ORDER BY detected_at ASC;

-- 7) Menampilkan Riwayat Error atau Emergency RTH.
SELECT
  occurred_at, severity, subsystem, event_type, message
FROM error_logs
WHERE drone_id = 1 AND severity IN ('warning', 'error', 'critical')
ORDER BY occurred_at DESC
LIMIT 50;
