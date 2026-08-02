"use client";

/**
 * lib/missionLog.ts
 * =============================================================================
 * Pencatatan misi ke database saat operator mengirim waypoint.
 *
 * Kenapa modul terpisah, bukan inline di handler?
 * Ada DUA jalur pengiriman waypoint yang harus menghasilkan catatan identik:
 *   1. Peta Gazebo  : klik pasang marker -> tombol "Send Goal"
 *   2. Peta Leaflet : klik peta langsung mengirim
 * Kalau logikanya disalin di dua tempat, cepat atau lambat keduanya menyimpang
 * (satu diperbaiki, satunya terlupakan) dan data Bab 4 jadi tidak konsisten.
 *
 * Jarak SELALU dihitung di klien pada detik perintah dikirim, karena hanya
 * klien yang memegang posisi drone live — dan angka itulah yang bermakna
 * sebagai "jarak rencana ke waypoint". Satuannya selalu METER.
 */

import { telemetryStore, type Waypoint } from "./telemetryStore";
import { distanceToTarget } from "./geo";

/**
 * Peta seq pengiriman -> id baris `missions` di database.
 *
 * Diperlukan karena kedatangan dilaporkan drone memakai SEQ (satu-satunya
 * pengenal yang dikenal jembatan), sedangkan penutupan baris butuh ID DATABASE
 * yang baru diketahui setelah INSERT selesai. Keduanya dijembatani di sini.
 *
 * Entri dihapus begitu dipakai supaya map tidak tumbuh selama sesi panjang.
 */
const seqToMissionId = new Map<number, number>();

/** Batas wajar entri tertunda; melindungi dari kebocoran bila banyak misi
 *  dikirim tanpa pernah tercapai (mis. operator terus mengganti target). */
const MAX_PENDING = 200;

/**
 * Catat satu misi baru beserta jarak drone -> waypoint (meter).
 *
 * SENGAJA fire-and-forget: kalau database mati, drone tetap harus berangkat.
 * Kegagalan dilaporkan ke konsol, TIDAK pernah membatalkan perintah terbang.
 * Karena itu fungsi ini tidak mengembalikan Promise yang perlu di-await.
 *
 * `seq` adalah nomor pengiriman dari sendWaypoints(); simpan agar event
 * kedatangan yang datang belakangan bisa menemukan baris database yang tepat.
 */
export function recordMissionGoal(
  wp: Waypoint,
  seq?: number,
  flightMode: string = "auto"
): void {
  const live = telemetryStore.live;
  const { horizontalM, source } = distanceToTarget(
    { x: live.x, y: live.y, z: live.z, lat: live.lat, lon: live.lon, gpsValid: live.gpsValid },
    { x: wp.x, y: wp.y, z: wp.z, lat: wp.lat, lon: wp.lon }
  );

  fetch("/api/missions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      startX: live.x,
      startY: live.y,
      destX: wp.x,
      destY: wp.y,
      goalDistanceM: Number(horizontalM.toFixed(3)),
      goalDistanceSource: source,
      flightMode,
    }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.success) {
        console.error("[missions] Gagal menyimpan jarak goal:", data?.error);
        return;
      }
      if (typeof seq === "number" && typeof data.missionId === "number") {
        if (seqToMissionId.size >= MAX_PENDING) {
          // Buang entri tertua (Map mempertahankan urutan penyisipan).
          const oldest = seqToMissionId.keys().next().value;
          if (oldest !== undefined) seqToMissionId.delete(oldest);
        }
        seqToMissionId.set(seq, data.missionId);
      }
    })
    .catch((err) => console.error("[missions] Gagal menyimpan jarak goal:", err));
}

/**
 * Tandai misi SELESAI setelah drone benar-benar tiba di waypoint.
 *
 * Dipanggil saat event "mission_complete" (dari jembatan drone) diterima.
 * Sama seperti recordMissionGoal: fire-and-forget, kegagalan tidak boleh
 * mengganggu penerbangan yang sedang berjalan.
 */
export function completeMissionGoal(seq: number): void {
  const missionId = seqToMissionId.get(seq);
  if (missionId === undefined) {
    // Wajar terjadi: mis. dashboard baru dimuat ulang di tengah misi, atau
    // waypoint dikirim dari perangkat lain. Bukan error yang perlu diteriakkan.
    console.warn(`[missions] Kedatangan seq ${seq} tanpa id misi yang cocok.`);
    return;
  }
  seqToMissionId.delete(seq);

  fetch("/api/missions", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ missionId }),
  })
    .then((res) => res.json())
    .then((data) => {
      if (!data?.success) {
        console.error("[missions] Gagal menandai misi selesai:", data?.error);
      } else {
        console.info(
          `[missions] Misi #${data.missionId} selesai dalam ${data.durationSec} detik.`
        );
      }
    })
    .catch((err) => console.error("[missions] Gagal menandai misi selesai:", err));
}
