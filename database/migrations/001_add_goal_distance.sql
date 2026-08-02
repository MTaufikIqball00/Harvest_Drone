-- =============================================================================
-- Migrasi 001: kolom jarak drone -> waypoint saat "Send Goal"
-- =============================================================================
-- Untuk database drone_ops yang SUDAH terlanjur dibuat dengan skema lama.
-- Instalasi baru tidak perlu menjalankan ini: drone_schema.sql sudah memuat
-- kedua kolom di bawah.
--
-- Aman dijalankan berkali-kali (idempoten) — MySQL/MariaDB tidak punya
-- "ADD COLUMN IF NOT EXISTS" yang portabel, jadi keberadaan kolom dicek dulu
-- lewat information_schema dan ALTER hanya disiapkan bila memang belum ada.
--
-- Pemakaian:
--   mysql -u root -p drone_ops < database/migrations/001_add_goal_distance.sql

USE drone_ops;

-- --- goal_distance_m ---------------------------------------------------------
SET @col_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'missions'
      AND COLUMN_NAME = 'goal_distance_m'
);

SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE missions ADD COLUMN goal_distance_m FLOAT DEFAULT NULL AFTER flight_mode',
    'SELECT "kolom goal_distance_m sudah ada, dilewati" AS info'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- --- goal_distance_source ----------------------------------------------------
SET @col_exists = (
    SELECT COUNT(*) FROM information_schema.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = 'missions'
      AND COLUMN_NAME = 'goal_distance_source'
);

SET @ddl = IF(
    @col_exists = 0,
    'ALTER TABLE missions ADD COLUMN goal_distance_source VARCHAR(10) DEFAULT NULL AFTER goal_distance_m',
    'SELECT "kolom goal_distance_source sudah ada, dilewati" AS info'
);
PREPARE stmt FROM @ddl;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;
