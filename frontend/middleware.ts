import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

/**
 * middleware.ts
 * =============================================================================
 * Gerbang tunggal autentikasi: setiap request halaman maupun API melewati sini
 * SEBELUM mencapai handler-nya.
 *
 * Pendekatan ini dipilih daripada menaruh cek login di tiap halaman/route,
 * karena di sana satu file yang lupa dicek = satu lubang. Di sini kebalikannya:
 * semuanya tertutup secara default, dan yang boleh publik harus didaftarkan
 * eksplisit di PUBLIC_PATHS.
 *
 * Berjalan di Edge runtime — karena itu lib/session memakai Web Crypto, bukan
 * `node:crypto`.
 */

/** Hanya jalur inilah yang boleh diakses tanpa sesi. */
const PUBLIC_PATHS = ["/login", "/api/auth/login", "/api/auth/logout"];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`)
  );
}

export async function middleware(request: NextRequest) {
  const { pathname, search } = request.nextUrl;

  const session = await verifySessionToken(
    request.cookies.get(SESSION_COOKIE)?.value
  );

  // Sudah login tapi membuka /login: langsung ke dashboard, jangan tampilkan
  // form yang tidak ada gunanya lagi.
  if (session && pathname === "/login") {
    return NextResponse.redirect(new URL("/", request.url));
  }

  if (session || isPublic(pathname)) {
    return NextResponse.next();
  }

  // Request API menerima 401 JSON. Kalau di-redirect ke /login, `fetch` di
  // klien akan mengikuti redirect dan menerima HTML — error-nya jadi
  // "Unexpected token <" yang menyesatkan, bukan "belum login".
  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { success: false, error: "Belum login." },
      { status: 401 }
    );
  }

  // Halaman biasa: ke form login, sambil mengingat tujuan semula supaya
  // operator kembali ke tempat yang benar setelah login.
  const loginUrl = new URL("/login", request.url);
  if (pathname !== "/") loginUrl.searchParams.set("next", pathname + search);
  return NextResponse.redirect(loginUrl);
}

export const config = {
  /**
   * Lewati aset statis dan berkas publik. Selain itu, SEMUA jalur diperiksa —
   * termasuk yang belum ada hari ini, sehingga halaman baru otomatis terlindungi
   * tanpa perlu mengubah berkas ini.
   */
  matcher: [
    // `.pmtiles` ikut dikecualikan bersama aset statis lain: berkas basemap
    // offline dibaca lewat BANYAK HTTP range request saat peta digeser, dan
    // memverifikasi sesi di setiap potongan hanya menambah beban tanpa
    // melindungi apa pun — isinya data peta OpenStreetMap yang memang publik.
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico|pmtiles)$).*)",
  ],
};
