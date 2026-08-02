import { NextResponse } from "next/server";
import { query } from "@/lib/db";
import { verifyPassword } from "@/lib/password";
import {
  SESSION_COOKIE,
  SESSION_TTL_SEC,
  createSessionToken,
} from "@/lib/session";

/**
 * POST /api/auth/login
 *
 * Body: { username: string, password: string }
 *
 * Memakai `node:crypto` lewat lib/password, jadi route ini wajib berjalan di
 * Node runtime (default untuk route handler) — bukan Edge.
 */
export const runtime = "nodejs";

type UserRow = {
  id: number;
  username: string;
  password_hash: string;
  role: string;
};

/**
 * Satu pesan untuk semua kegagalan kredensial. Membedakan "user tidak ada" dan
 * "password salah" akan memberi tahu penyerang username mana yang valid.
 */
const INVALID_MESSAGE = "Username atau password salah.";

export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const username =
      typeof body?.username === "string" ? body.username.trim() : "";
    const password = typeof body?.password === "string" ? body.password : "";

    if (!username || !password) {
      return NextResponse.json(
        { success: false, error: "Username dan password wajib diisi." },
        { status: 400 }
      );
    }

    const rows = await query<UserRow>(
      `SELECT id, username, password_hash, role
         FROM users
        WHERE username = $1
        LIMIT 1`,
      [username]
    );

    const user = rows[0];
    // verifyPassword tetap dipanggil dengan hash dummy saat user tidak ada,
    // supaya waktu respons "user tidak ada" dan "password salah" mirip dan
    // tidak bisa dipakai menebak username yang terdaftar.
    const ok = await verifyPassword(password, user?.password_hash ?? "scrypt$0");

    if (!user || !ok) {
      return NextResponse.json(
        { success: false, error: INVALID_MESSAGE },
        { status: 401 }
      );
    }

    const token = await createSessionToken({
      sub: user.id,
      username: user.username,
      role: user.role,
    });

    const response = NextResponse.json({
      success: true,
      user: { id: user.id, username: user.username, role: user.role },
    });

    response.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true, // tidak terbaca document.cookie -> aman dari XSS pencuri sesi
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production", // dev jalan di http://localhost
      path: "/",
      maxAge: SESSION_TTL_SEC,
    });

    return response;
  } catch (error: any) {
    // AUTH_SECRET yang belum diset muncul di sini sebagai pesan yang jelas,
    // bukan sebagai "login gagal" yang membingungkan.
    return NextResponse.json(
      { success: false, error: error?.message || "Gagal memproses login." },
      { status: 500 }
    );
  }
}
