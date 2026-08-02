/**
 * lib/password.ts
 * =============================================================================
 * Hashing password dengan scrypt bawaan Node.
 *
 * Kenapa scrypt, bukan bcrypt/argon2: keduanya paket native yang perlu
 * dikompilasi saat install — sering gagal di Windows/WSL dan menyulitkan
 * reproduksi. `node:crypto` sudah menyediakan scrypt (memory-hard, direkomendasi
 * untuk password) tanpa dependency tambahan sama sekali.
 *
 * Format yang disimpan di kolom users.password_hash:
 *   scrypt$<N>$<r>$<p>$<salt_hex>$<hash_hex>
 * Parameter ikut disimpan supaya hash lama tetap bisa diverifikasi kalau suatu
 * saat parameternya dinaikkan.
 *
 * Modul ini memakai `node:crypto`, jadi HANYA boleh diimpor dari route handler
 * (Node runtime) — bukan dari middleware (Edge runtime).
 */

import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number }
) => Promise<Buffer>;

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;

/** Hash password baru. Hasilnya siap disimpan ke users.password_hash. */
export async function hashPassword(password: string): Promise<string> {
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

/**
 * Cocokkan password dengan hash tersimpan.
 *
 * Selalu `false` (bukan melempar error) untuk hash berformat asing — termasuk
 * nilai seed `'hashed_password_here'` di drone_schema.sql. Jadi user yang belum
 * di-set passwordnya otomatis tidak bisa login, bukan malah membuat server 500.
 */
export async function verifyPassword(
  password: string,
  stored: string
): Promise<boolean> {
  const parts = (stored || "").split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const [, n, r, p, saltHex, hashHex] = parts;
  try {
    const expected = Buffer.from(hashHex, "hex");
    const derived = await scryptAsync(
      password,
      Buffer.from(saltHex, "hex"),
      expected.length,
      { N: Number(n), r: Number(r), p: Number(p) }
    );
    // timingSafeEqual menolak buffer berbeda panjang, jadi dicek lebih dulu.
    if (derived.length !== expected.length) return false;
    return timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}
