import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { query } from "@/lib/db";
import { SESSION_COOKIE, verifySessionToken } from "@/lib/session";

export async function GET() {
  try {
    const missions = await query(
      `SELECT m.*, d.name as drone_name 
       FROM missions m 
       LEFT JOIN drones d ON m.drone_id = d.id 
       ORDER BY m.start_time DESC LIMIT 50`
    );
    const telemetryLogs = await query(
      `SELECT * FROM telemetry_logs ORDER BY recorded_at DESC LIMIT 100`
    );
    const harvestJobs = await query(
      `SELECT * FROM harvest_jobs ORDER BY created_at DESC LIMIT 50`
    );

    return NextResponse.json({
      success: true,
      missions,
      telemetryLogs,
      harvestJobs,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Database query failed" },
      { status: 500 }
    );
  }
}

/** Angka valid & berhingga, atau null. Menolak NaN/Infinity/string sampah. */
function num(value: unknown): number | null {
  const n = typeof value === "string" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * POST /api/missions — catat satu misi baru saat operator menekan "Send Goal".
 *
 * Yang membuat endpoint ini ada: jarak drone -> waypoint pada saat perintah
 * dikirim harus tersimpan permanen (satuan METER), bukan cuma tampil di UI.
 * Jarak dihitung di klien karena hanya klien yang memegang posisi live drone;
 * server tetap memvalidasinya supaya baris sampah tidak masuk database.
 */
export async function POST(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json(
        { success: false, error: "Body JSON tidak valid." },
        { status: 400 }
      );
    }

    const goalDistanceM = num(body.goalDistanceM);
    if (goalDistanceM === null || goalDistanceM < 0) {
      return NextResponse.json(
        { success: false, error: "goalDistanceM wajib berupa angka meter >= 0." },
        { status: 400 }
      );
    }

    const destX = num(body.destX);
    const destY = num(body.destY);
    if (destX === null || destY === null) {
      return NextResponse.json(
        { success: false, error: "destX & destY wajib berupa angka (meter)." },
        { status: 400 }
      );
    }

    // Hanya dua basis yang dikenal; apa pun selain itu disimpan sebagai NULL
    // daripada mencemari kolom dengan nilai yang tidak bisa ditafsirkan.
    const rawSource = body.goalDistanceSource;
    const goalDistanceSource =
      rawSource === "gps" || rawSource === "local" ? rawSource : null;

    const droneId = num(body.droneId) ?? 1;

    // Operator diambil dari SESI, bukan dari body request. Kalau klien yang
    // menentukan operator_id, siapa pun bisa mencatat misi atas nama orang lain
    // — dan kolom itu kehilangan gunanya sebagai jejak siapa yang menerbangkan.
    const session = await verifySessionToken(
      (await cookies()).get(SESSION_COOKIE)?.value
    );
    const operatorId = session?.sub ?? null;
    const flightMode =
      typeof body.flightMode === "string" && body.flightMode.trim()
        ? body.flightMode.trim().slice(0, 50)
        : "auto";

    // PostgreSQL memakai placeholder bernomor ($1, $2, ...) dan mengembalikan
    // id lewat RETURNING — tidak ada padanan `result.insertId` seperti MySQL.
    const rows = await query<{ id: number }>(
      `INSERT INTO missions
         (drone_id, operator_id, start_x, start_y, dest_x, dest_y,
          flight_mode, goal_distance_m, goal_distance_source, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'in_progress')
       RETURNING id`,
      [
        droneId,
        operatorId,
        num(body.startX),
        num(body.startY),
        destX,
        destY,
        flightMode,
        goalDistanceM,
        goalDistanceSource,
      ]
    );

    return NextResponse.json({
      success: true,
      missionId: rows[0]?.id ?? null,
      goalDistanceM,
      unit: "m",
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Gagal menyimpan misi" },
      { status: 500 }
    );
  }
}

/**
 * PATCH /api/missions — tandai satu misi SELESAI (drone tiba di tujuan).
 *
 * Dipicu oleh event "mission_complete" dari jembatan drone, yang terbit saat
 * jarak drone ke waypoint <= radius terima. Tanpa endpoint ini setiap misi
 * selamanya berstatus 'in_progress' — riwayat tidak bisa membedakan misi yang
 * berhasil dari yang dibatalkan/gagal di tengah jalan.
 *
 * arrival_time dan total_duration_sec dihitung SERVER-SIDE dari now() dan
 * start_time milik baris itu sendiri, bukan dikirim klien: jam browser bisa
 * meleset dari jam database dan menghasilkan durasi negatif.
 */
export async function PATCH(request: Request) {
  try {
    const body = await request.json().catch(() => null);
    const missionId = num(body?.missionId);

    if (missionId === null || missionId <= 0) {
      return NextResponse.json(
        { success: false, error: "missionId wajib berupa angka > 0." },
        { status: 400 }
      );
    }

    const finalDistanceM = num(body?.finalDistanceM);

    // Hanya baris yang MASIH 'in_progress' yang boleh ditutup. Tanpa syarat
    // ini, event kedatangan yang terkirim dua kali akan menimpa arrival_time
    // yang sudah benar dengan waktu yang lebih baru.
    const rows = await query<{
      id: number;
      arrival_time: string;
      total_duration_sec: number;
    }>(
      `UPDATE missions
          SET status             = 'completed',
              arrival_time       = now(),
              end_time           = now(),
              total_duration_sec = GREATEST(0, EXTRACT(EPOCH FROM (now() - start_time))::int),
              total_distance_m   = COALESCE($2, total_distance_m)
        WHERE id = $1
          AND status = 'in_progress'
        RETURNING id, arrival_time, total_duration_sec`,
      [missionId, finalDistanceM]
    );

    if (rows.length === 0) {
      // Bukan error server: bisa jadi misi sudah ditutup sebelumnya, atau
      // id-nya tidak ada. Dilaporkan apa adanya supaya klien tidak mengira
      // penutupan berhasil.
      return NextResponse.json(
        {
          success: false,
          error: "Misi tidak ditemukan atau sudah tidak berstatus in_progress.",
        },
        { status: 404 }
      );
    }

    return NextResponse.json({
      success: true,
      missionId: rows[0].id,
      arrivalTime: rows[0].arrival_time,
      durationSec: rows[0].total_duration_sec,
    });
  } catch (error: any) {
    return NextResponse.json(
      { success: false, error: error.message || "Gagal menutup misi" },
      { status: 500 }
    );
  }
}
