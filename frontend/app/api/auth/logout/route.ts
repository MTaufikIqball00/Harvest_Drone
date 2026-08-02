import { NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/session";

/**
 * POST /api/auth/logout — hapus cookie sesi.
 *
 * Dibuat POST (bukan GET) supaya tidak bisa dipicu tanpa sengaja oleh prefetch
 * browser atau sekadar <img src="...">.
 */
export async function POST() {
  const response = NextResponse.json({ success: true });
  response.cookies.set(SESSION_COOKIE, "", {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: 0,
  });
  return response;
}
