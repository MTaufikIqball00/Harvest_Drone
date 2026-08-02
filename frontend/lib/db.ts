/**
 * lib/db.ts
 * =============================================================================
 * Koneksi PostgreSQL (Supabase) untuk API route Next.js.
 *
 * Menggantikan lib/mysql.ts. Perbedaan yang WAJIB diperhatikan pemanggil:
 *
 *   1. Placeholder MySQL `?` -> PostgreSQL `$1, $2, ...` (bernomor, 1-based).
 *      Ini bukan preferensi gaya: `?` akan ditolak dengan syntax error.
 *   2. Tidak ada `result.insertId`. PostgreSQL memakai `RETURNING id`, yang
 *      justru lebih aman karena bekerja untuk banyak baris sekaligus.
 *   3. Nama env var tetap DB_HOST/DB_USER/... supaya konfigurasi lama tidak
 *      perlu ditulis ulang seluruhnya.
 */

import { Pool, type QueryResultRow } from "pg";

let pool: Pool | null = null;

function getEnv(name: string, fallback: string = ""): string {
  return process.env[name] || process.env[`DRONE_${name}`] || fallback;
}

export function getPool(): Pool {
  if (!pool) {
    const host = getEnv("DB_HOST", "127.0.0.1");

    // Supabase (dan umumnya PostgreSQL terkelola) MEWAJIBKAN TLS. Sertifikatnya
    // ditandatangani CA internal yang tidak ada di trust store Node, jadi
    // verifikasi penuh akan gagal — koneksi tetap terenkripsi, hanya rantai
    // sertifikatnya yang tidak divalidasi.
    //
    // Untuk PostgreSQL lokal (tanpa TLS), SSL justru harus dimatikan; kalau
    // tidak, koneksi ditolak dengan "server does not support SSL".
    const isLocal = host === "127.0.0.1" || host === "localhost" || host === "::1";
    const sslEnv = getEnv("DB_SSL", "").toLowerCase();
    const useSsl = sslEnv ? sslEnv === "true" || sslEnv === "require" : !isLocal;

    pool = new Pool({
      host,
      port: Number(getEnv("DB_PORT", "5432")),
      user: getEnv("DB_USER", "postgres"),
      password: getEnv("DB_PASSWORD", ""),
      database: getEnv("DB_NAME", "postgres"),
      max: Number(process.env.DB_POOL_LIMIT || 10),
      keepAlive: true,
      ssl: useSsl ? { rejectUnauthorized: false } : undefined,
    });

    // Tanpa handler ini, error pada koneksi IDLE (mis. Supabase memutus koneksi
    // yang menganggur) naik sebagai unhandled 'error' event dan MEMATIKAN
    // proses Node. Pool akan membuat koneksi baru sendiri, jadi cukup dicatat.
    pool.on("error", (err) => {
      console.error("[db] Koneksi idle bermasalah:", err.message);
    });
  }
  return pool;
}

/** Jalankan query, kembalikan baris hasilnya. Placeholder memakai $1, $2, ... */
export async function query<T extends QueryResultRow = any>(
  sql: string,
  params: any[] = []
): Promise<T[]> {
  const result = await getPool().query<T>(sql, params);
  return result.rows;
}
