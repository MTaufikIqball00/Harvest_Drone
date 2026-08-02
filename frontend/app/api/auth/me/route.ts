import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * GET /api/auth/me — identitas operator yang sedang login.
 *
 * Dipakai UI untuk menampilkan nama operator di header. Middleware sudah
 * memastikan halaman hanya terbuka bila sesi valid, jadi 401 di sini praktis
 * hanya terjadi bila sesi kedaluwarsa saat tab dibiarkan terbuka.
 */
export async function GET() {
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  const session = await verifySessionToken(token);

  if (!session) {
    return NextResponse.json(
      { success: false, error: "Belum login." },
      { status: 401 }
    );
  }

  return NextResponse.json({
    success: true,
    user: {
      id: session.sub,
      username: session.username,
      role: session.role,
    },
  });
}
