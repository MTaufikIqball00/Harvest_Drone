/**
 * lib/session.ts
 * =============================================================================
 * Sesi login berbasis cookie bertanda tangan (signed cookie).
 *
 * Format token: `<payload>.<signature>`, keduanya base64url.
 *   payload   = JSON { sub, username, role, exp }
 *   signature = HMAC-SHA256(AUTH_SECRET, payload)
 *
 * Kenapa HMAC manual, bukan library JWT: satu-satunya yang dibutuhkan sistem ini
 * adalah "apakah payload ini benar dibuat server kita dan belum kedaluwarsa".
 * HMAC-SHA256 sudah menjawab itu tanpa menambah dependency.
 *
 * PENTING — modul ini HARUS memakai Web Crypto (`crypto.subtle`), bukan
 * `node:crypto`. Middleware Next.js berjalan di Edge runtime yang tidak punya
 * modul Node, sedangkan route handler berjalan di Node. Web Crypto tersedia di
 * KEDUANYA, sehingga satu implementasi ini bisa dipakai di dua tempat.
 * Hashing password (scrypt) tetap di lib/password.ts karena hanya dipanggil
 * dari route handler.
 */

export const SESSION_COOKIE = "drone_session";

/** 8 jam — kira-kira satu shift operator, cukup untuk satu sesi penerbangan. */
export const SESSION_TTL_SEC = 8 * 60 * 60;

export type SessionPayload = {
  /** users.id */
  sub: number;
  username: string;
  role: string;
  /** Unix epoch detik. */
  exp: number;
};

function getSecret(): string {
  const secret = process.env.AUTH_SECRET || "";
  if (secret.length < 16) {
    throw new Error(
      "AUTH_SECRET belum diset (atau terlalu pendek). Tambahkan AUTH_SECRET " +
        "minimal 32 karakter acak ke frontend/.env.local."
    );
  }
  return secret;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  const padded =
    text.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  // ArrayBuffer dibuat eksplisit (bukan `new Uint8Array(length)`) supaya tipenya
  // Uint8Array<ArrayBuffer>, bukan Uint8Array<ArrayBufferLike>. crypto.subtle
  // menuntut BufferSource yang menjamin ArrayBuffer biasa, bukan SharedArrayBuffer.
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function getKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

/** Buat token sesi untuk user yang baru berhasil login. */
export async function createSessionToken(
  user: Pick<SessionPayload, "sub" | "username" | "role">
): Promise<string> {
  const payload: SessionPayload = {
    ...user,
    exp: Math.floor(Date.now() / 1000) + SESSION_TTL_SEC,
  };
  const encoded = toBase64Url(
    new TextEncoder().encode(JSON.stringify(payload))
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    await getKey(),
    new TextEncoder().encode(encoded)
  );
  return `${encoded}.${toBase64Url(new Uint8Array(signature))}`;
}

/**
 * Verifikasi token. Mengembalikan payload bila tanda tangan cocok DAN belum
 * kedaluwarsa; `null` untuk semua kasus lain (termasuk token cacat, secret
 * salah, atau AUTH_SECRET belum diset) — gagal selalu berarti "tidak login",
 * tidak pernah "dianggap login".
 */
export async function verifySessionToken(
  token: string | undefined | null
): Promise<SessionPayload | null> {
  if (!token) return null;

  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) return null;

  try {
    const valid = await crypto.subtle.verify(
      "HMAC",
      await getKey(),
      fromBase64Url(signature),
      new TextEncoder().encode(encoded)
    );
    if (!valid) return null;

    const payload = JSON.parse(
      new TextDecoder().decode(fromBase64Url(encoded))
    ) as SessionPayload;

    if (
      typeof payload?.sub !== "number" ||
      typeof payload?.exp !== "number" ||
      payload.exp < Math.floor(Date.now() / 1000)
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}
