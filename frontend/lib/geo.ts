/**
 * lib/geo.ts
 * =============================================================================
 * Konversi koordinat lokal (meter) <-> geodetik (lat/lon).
 *
 * Modul ini SENGAJA bebas dependensi: tidak mengimpor Leaflet maupun apa pun
 * yang menyentuh `window`. Sebelumnya helper ini tinggal di dalam
 * `components/map/LeafletCanvas.tsx`; mengimpornya dari komponen lain menarik
 * Leaflet ikut ter-bundle di sisi server dan membuat prerender Next.js gagal
 * dengan "ReferenceError: window is not defined".
 *
 * Padanan sisi ROS ada di `ros2_ws/.../drone_dashboard_bridge/geodesy.py` —
 * kedua sisi memakai rumus yang sama agar tidak saling menyimpang.
 */

/**
 * Origin geodetik untuk MODE TANPA GPS — sekaligus titik tengah awal peta.
 *
 * Proyeksi kosmetik supaya drone tanpa GPS tetap bisa digambar di atas tile
 * peta. Saat autopilot punya fix GPS, lat/lon asli dari node ROS yang dipakai
 * dan konstanta ini tidak berperan untuk posisi drone.
 *
 * NILAINYA HARUS BERADA DI DALAM AREA TILE OFFLINE yang sudah diunduh
 * (lihat scripts/download_map_tiles.py). Peta membuka tampilan pertamanya di
 * titik ini; kalau ia jatuh di luar cakupan cache, operator disambut layar
 * abu-abu kosong justru saat di lapangan tanpa internet.
 *
 * Default: area operasi Gg. Sawah Lega III, Cimahi Utara. Bisa diganti lewat
 * env tanpa mengubah kode — pastikan tile untuk lokasi baru ikut diunduh.
 */
export const ORIGIN_LAT = Number(process.env.NEXT_PUBLIC_ORIGIN_LAT ?? -6.8655);
export const ORIGIN_LON = Number(process.env.NEXT_PUBLIC_ORIGIN_LON ?? 107.5412);

/** Meter per derajat lintang — praktis konstan di mana pun di bumi. */
const METERS_PER_DEG_LAT = 111_195;

/**
 * Meter per derajat BUJUR pada lintang tertentu.
 *
 * Kode lama memakai satu konstanta (`METER_TO_GEO = 0.000009`) untuk KEDUA
 * sumbu. Itu salah secara prinsip: derajat bujur menyusut mengikuti cos(lintang).
 * Di Bandung galatnya hanya ~0,7% sehingga tidak kentara, tetapi pada lintang
 * 35° galatnya 22% dan pada 60° mencapai 99,8%.
 */
function metersPerDegLon(latitudeDeg: number): number {
  return METERS_PER_DEG_LAT * Math.cos((latitudeDeg * Math.PI) / 180);
}

/** Posisi lokal (x=timur, y=utara, meter) -> [lat, lon]. */
export function metersToLatLon(x: number, y: number): [number, number] {
  return [
    ORIGIN_LAT + y / METERS_PER_DEG_LAT,
    ORIGIN_LON + x / metersPerDegLon(ORIGIN_LAT),
  ];
}

/** [lat, lon] -> posisi lokal (x=timur, y=utara, meter). */
export function latLonToMeters(lat: number, lon: number): { x: number; y: number } {
  return {
    x: (lon - ORIGIN_LON) * metersPerDegLon(ORIGIN_LAT),
    y: (lat - ORIGIN_LAT) * METERS_PER_DEG_LAT,
  };
}

// -----------------------------------------------------------------------------
// JARAK (selalu METER)
// -----------------------------------------------------------------------------

/** Radius rata-rata bumi (IUGG mean radius), meter. */
const EARTH_RADIUS_M = 6_371_008.8;

/** Jarak great-circle antara dua titik geodetik, dalam METER. */
export function haversineMeters(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)));
}

/** Sumber perhitungan jarak — dipakai UI untuk menjelaskan angkanya. */
export type DistanceSource = "gps" | "local";

export interface DistanceToTarget {
  /** Jarak horizontal (bidang XY / permukaan bumi), METER. */
  horizontalM: number;
  /** Selisih ketinggian target - drone, METER (positif = target di atas drone). */
  verticalM: number;
  /** Jarak garis lurus 3D (slant range), METER. */
  slantM: number;
  source: DistanceSource;
}

/**
 * Jarak drone -> waypoint, SELALU dalam meter.
 *
 * Memilih basis perhitungan secara otomatis:
 *   - GPS fix + kedua titik punya lat/lon  -> haversine (jarak bumi sebenarnya)
 *   - selain itu                            -> Euclidean pada koordinat lokal
 *
 * Keduanya menghasilkan satuan yang sama (meter), jadi konsumen tidak perlu
 * tahu mode mana yang dipakai kecuali untuk ditampilkan sebagai keterangan.
 */
export function distanceToTarget(
  drone: { x: number; y: number; z: number; lat?: number; lon?: number; gpsValid?: boolean },
  target: { x: number; y: number; z: number; lat?: number; lon?: number }
): DistanceToTarget {
  const useGps =
    Boolean(drone.gpsValid) &&
    typeof drone.lat === "number" &&
    typeof drone.lon === "number" &&
    typeof target.lat === "number" &&
    typeof target.lon === "number";

  const horizontalM = useGps
    ? haversineMeters(drone.lat as number, drone.lon as number, target.lat as number, target.lon as number)
    : Math.hypot(target.x - drone.x, target.y - drone.y);

  const verticalM = target.z - drone.z;

  return {
    horizontalM,
    verticalM,
    slantM: Math.hypot(horizontalM, verticalM),
    source: useGps ? "gps" : "local",
  };
}

/** Format jarak meter untuk UI: <1000 m tampil meter, selebihnya kilometer. */
export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return "-";
  if (meters < 1000) return `${meters.toFixed(1)} m`;
  return `${(meters / 1000).toFixed(2)} km`;
}
