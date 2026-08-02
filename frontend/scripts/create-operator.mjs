/**
 * scripts/create-operator.mjs
 * =============================================================================
 * Membuat / mengubah password akun operator di tabel `users`.
 *
 * Dijalankan dari folder frontend:
 *   npm run create-operator -- <username> <password>
 *
 * Contoh:
 *   npm run create-operator -- iqball rahasia123
 *
 * Kenapa lewat script, bukan halaman "Daftar" di dashboard: sistem ini
 * single-role (operator) dan tidak punya halaman admin. Membuka pendaftaran
 * mandiri berarti siapa pun yang bisa menjangkau port 3000 dapat membuat akun
 * sendiri — persis lubang yang hendak ditutup oleh login ini.
 *
 * CATATAN — format hash di bawah HARUS sama persis dengan lib/password.ts
 * (scrypt$N$r$p$salt_hex$hash_hex). Script ini berdiri sendiri (.mjs) karena
 * Node 18 tidak bisa mengimpor TypeScript tanpa build step.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes, scrypt } from "node:crypto";
import { promisify } from "node:util";
import pg from "pg";

const scryptAsync = promisify(scrypt);
const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Muat .env.local sendiri — script Node biasa tidak melewati loader env
 * bawaan Next.js. Sengaja TIDAK menimpa variabel yang sudah ada di environment,
 * supaya `DB_HOST=... npm run create-operator` tetap bisa dipakai.
 */
function loadEnvLocal() {
  try {
    const raw = readFileSync(resolve(here, "..", ".env.local"), "utf8");
    for (const line of raw.split("\n")) {
      const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
      if (!match) continue;
      const [, key, rawValue] = match;
      if (process.env[key] !== undefined) continue;
      process.env[key] = rawValue.replace(/^["']|["']$/g, "");
    }
  } catch {
    // Tidak ada .env.local: pakai environment apa adanya.
  }
}

async function hashPassword(password) {
  const salt = randomBytes(16);
  const derived = await scryptAsync(password, salt, KEY_LENGTH, PARAMS);
  return [
    "scrypt",
    PARAMS.N,
    PARAMS.r,
    PARAMS.p,
    salt.toString("hex"),
    derived.toString("hex"),
  ].join("$");
}

async function main() {
  const [username, password] = process.argv.slice(2);

  if (!username || !password) {
    console.error(
      "Pemakaian: npm run create-operator -- <username> <password>\n" +
        "Contoh   : npm run create-operator -- iqball rahasia123"
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error("Password minimal 8 karakter.");
    process.exit(1);
  }

  loadEnvLocal();

  const host = process.env.DB_HOST || "127.0.0.1";
  const isLocal = ["127.0.0.1", "localhost", "::1"].includes(host);
  const sslEnv = (process.env.DB_SSL || "").toLowerCase();
  const useSsl = sslEnv ? sslEnv === "true" || sslEnv === "require" : !isLocal;

  const pool = new pg.Pool({
    host,
    port: Number(process.env.DB_PORT || 5432),
    user: process.env.DB_USER || "postgres",
    password: process.env.DB_PASSWORD || "",
    database: process.env.DB_NAME || "postgres",
    ssl: useSsl ? { rejectUnauthorized: false } : undefined,
  });

  try {
    const passwordHash = await hashPassword(password);

    // ON CONFLICT: memanggil ulang script untuk username yang sama berarti
    // "reset password", bukan error duplicate key.
    const { rows } = await pool.query(
      `INSERT INTO users (username, password_hash, role)
            VALUES ($1, $2, 'operator')
       ON CONFLICT (username)
       DO UPDATE SET password_hash = EXCLUDED.password_hash
         RETURNING id, username, role`,
      [username, passwordHash]
    );

    const user = rows[0];
    console.log(
      `Akun siap dipakai -> id=${user.id} username=${user.username} role=${user.role}`
    );
  } catch (error) {
    console.error("Gagal menyimpan akun:", error.message);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

main();
