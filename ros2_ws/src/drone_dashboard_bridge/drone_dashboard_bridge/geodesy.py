"""
geodesy.py
=============================================================================
Konversi koordinat geodetik (lat/lon) <-> frame lokal ENU (meter).

KENAPA MODUL INI ADA
--------------------
Sistem ini menerbangkan drone memakai frame LOKAL dalam meter (x=timur,
y=utara relatif titik referensi). Seluruh perencana jalur — A*, boustrophedon,
penghindaran rintangan — bekerja dalam meter. Itu benar dan tidak perlu diubah.

Yang dibutuhkan tambahan adalah jembatan ke koordinat bumi, supaya:
  1. Drone ASLI ber-GPS bisa diberi target dari peta (lat/lon) dan diterbangkan
     ke titik geografis yang sesungguhnya.
  2. Drone TANPA GPS tetap bisa dipakai dengan target berbasis jarak (meter),
     tanpa perubahan alur kerja.

Frame lokal autopilot (PX4 `ref_lat`/`ref_lon`, ArduPilot EKF origin) SUDAH
ter-referensi GPS begitu fix tersedia. Jadi konversi lat/lon -> lokal cukup
dilakukan sekali di tepi sistem, dan seluruh pengendali di bawahnya tidak
perlu tahu-menahu soal GPS.

PROYEKSI YANG DIPAKAI
---------------------
Equirectangular (local tangent plane) di sekitar titik referensi. Untuk area
operasi drone (radius beberapa kilometer) galatnya jauh di bawah akurasi GPS
itu sendiri, dan biayanya jauh lebih murah daripada rumus geodesik penuh.

CATATAN PENTING soal skala bujur:
    1 derajat LINTANG  ~ 111_320 m di mana pun.
    1 derajat BUJUR    ~ 111_320 * cos(lintang) m  <-- BERGANTUNG LINTANG.

Frontend versi lama memakai satu konstanta `METER_TO_GEO = 0.000009` untuk
KEDUA sumbu. Di Bandung (lintang -6,9 derajat) cos(lat) ~ 0,993 sehingga
galatnya kecil dan tidak kentara; tetapi rumus itu salah secara prinsip dan
akan meleset makin jauh pada lintang tinggi — pada lintang 60 derajat
kesalahannya 2x lipat. Modul ini memperbaikinya.
"""
from __future__ import annotations

import math
from typing import Optional, Tuple

# Jari-jari bumi rata-rata (WGS84 mean radius), meter.
EARTH_RADIUS_M = 6_371_000.0

# Meter per derajat lintang (konstan untuk keperluan praktis).
METERS_PER_DEG_LAT = math.pi * EARTH_RADIUS_M / 180.0  # ~111_195 m


def meters_per_deg_lon(latitude_deg: float) -> float:
    """Meter per derajat bujur pada lintang tertentu.

    Menyusut mengikuti cos(lintang): di khatulistiwa ~111 km, di kutub -> 0.
    """
    return METERS_PER_DEG_LAT * math.cos(math.radians(latitude_deg))


def geodetic_to_local(
    lat_deg: float, lon_deg: float, ref_lat_deg: float, ref_lon_deg: float
) -> Tuple[float, float]:
    """lat/lon -> offset lokal (east, north) dalam meter dari titik referensi.

    Returns:
        (east_m, north_m) — east positif ke timur, north positif ke utara.
    """
    north = (lat_deg - ref_lat_deg) * METERS_PER_DEG_LAT
    # Skala bujur diambil pada lintang referensi (bukan lintang target), agar
    # konversi maju-mundur konsisten dan dapat dibalik secara eksak.
    east = (lon_deg - ref_lon_deg) * meters_per_deg_lon(ref_lat_deg)
    return east, north


def local_to_geodetic(
    east_m: float, north_m: float, ref_lat_deg: float, ref_lon_deg: float
) -> Tuple[float, float]:
    """Offset lokal (east, north) meter -> lat/lon.

    Kebalikan eksak dari `geodetic_to_local` dengan referensi yang sama.
    """
    lat = ref_lat_deg + north_m / METERS_PER_DEG_LAT

    scale = meters_per_deg_lon(ref_lat_deg)
    if abs(scale) < 1e-6:
        # Dekat kutub bujur kehilangan makna; kembalikan bujur referensi
        # daripada menghasilkan pembagian dengan nol.
        return lat, ref_lon_deg
    lon = ref_lon_deg + east_m / scale
    return lat, lon


def haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    """Jarak lingkaran besar antara dua titik (meter).

    Dipakai untuk validasi/pengecekan jarak, bukan untuk konversi frame.
    """
    p1 = math.radians(lat1)
    p2 = math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    a = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2.0 * EARTH_RADIUS_M * math.asin(min(1.0, math.sqrt(a)))


def is_valid_latlon(lat: Optional[float], lon: Optional[float]) -> bool:
    """True jika pasangan lat/lon masuk akal sebagai koordinat bumi.

    Menolak None, NaN, di luar rentang, dan titik (0,0) — "Null Island" di
    Teluk Guinea yang hampir selalu berarti GPS belum fix, bukan lokasi nyata.
    """
    if lat is None or lon is None:
        return False
    if not (math.isfinite(lat) and math.isfinite(lon)):
        return False
    if not (-90.0 <= lat <= 90.0 and -180.0 <= lon <= 180.0):
        return False
    if abs(lat) < 1e-7 and abs(lon) < 1e-7:
        return False
    return True
