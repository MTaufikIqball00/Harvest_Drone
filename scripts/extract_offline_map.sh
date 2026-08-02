#!/usr/bin/env bash
# =============================================================================
# scripts/extract_offline_map.sh
# =============================================================================
# Membuat berkas basemap OFFLINE (PMTiles) untuk area operasi drone.
#
# KENAPA PMTiles, BUKAN MENGUNDUH TILE PNG DARI OSM
# -------------------------------------------------
# Kebijakan tile server OpenStreetMap MELARANG unduhan borongan untuk cache
# offline (>250 tile pada zoom >=13). Permintaan yang melanggar tidak ditolak
# dengan error, melainkan dibalas HTTP 200 berisi gambar "Access denied" —
# gagal secara SENYAP sehingga cache terlihat penuh padahal isinya placeholder
# semua.
#
# Protomaps PMTiles justru dirancang untuk offline/self-host:
#   - SATU berkas berisi data vektor seluruh area, bukan ribuan PNG
#   - Karena vektor, satu berkas melayani SEMUA level zoom (tidak ada level
#     yang "belum diunduh"), dan ukurannya jauh lebih kecil
#   - Legal: data OpenStreetMap (ODbL), memang disediakan untuk diunduh
#
# PEMAKAIAN
# ---------
#   bash scripts/extract_offline_map.sh
#   bash scripts/extract_offline_map.sh 107.511 -6.895 107.571 -6.836
#
# Argumen: MIN_LON MIN_LAT MAX_LON MAX_LAT
#
# SETELAH MENGGANTI AREA, pastikan NEXT_PUBLIC_ORIGIN_LAT / _LON di
# frontend/.env.local ikut diarahkan ke tengah area baru — peta membuka
# tampilan pertamanya di titik itu.
# =============================================================================

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
OUTPUT="$ROOT_DIR/frontend/public/map/basemap.pmtiles"

# Default: area operasi Gg. Sawah Lega III, Cimahi Utara (~6,6 x 6,6 km),
# mencakup Jl. Sangkuriang di barat sampai Jl. Kolonel Masturi di timur.
MIN_LON="${1:-107.511}"
MIN_LAT="${2:--6.895}"
MAX_LON="${3:-107.571}"
MAX_LAT="${4:--6.836}"

# Zoom 15 adalah maksimum yang disediakan build Protomaps. Itu sudah cukup:
# data vektor bisa di-"over-zoom" oleh peramban sampai zoom 20+ tanpa pecah,
# berbeda dengan tile raster yang buram begitu melewati zoom aslinya.
MAX_ZOOM=15

PMTILES_BIN="${PMTILES_BIN:-pmtiles}"
if ! command -v "$PMTILES_BIN" > /dev/null 2>&1; then
    echo "ERROR: perkakas 'pmtiles' tidak ditemukan." >&2
    echo "" >&2
    echo "Pasang dulu (sekali saja):" >&2
    echo "  curl -sL -o /tmp/pmtiles.tar.gz \\" >&2
    echo "    https://github.com/protomaps/go-pmtiles/releases/download/v1.31.2/go-pmtiles_1.31.2_Linux_x86_64.tar.gz" >&2
    echo "  tar xzf /tmp/pmtiles.tar.gz -C /tmp && sudo mv /tmp/pmtiles /usr/local/bin/" >&2
    exit 1
fi

# Build planet harian. Tanggal kemarin dipakai sebagai titik awal karena build
# hari ini belum tentu selesai saat script dijalankan.
echo "Mencari build planet Protomaps terbaru yang tersedia..."
BUILD_DATE=""
for i in 1 2 3 4 5 6 7; do
    CANDIDATE="$(date -u -d "-${i} day" +%Y%m%d)"
    CODE="$(curl -s -o /dev/null -w "%{http_code}" -r 0-100 \
        "https://build.protomaps.com/${CANDIDATE}.pmtiles" --max-time 25 || echo "000")"
    if [ "$CODE" = "200" ] || [ "$CODE" = "206" ]; then
        BUILD_DATE="$CANDIDATE"
        break
    fi
done

if [ -z "$BUILD_DATE" ]; then
    echo "ERROR: tidak ada build planet yang bisa dijangkau. Periksa koneksi internet." >&2
    exit 1
fi

echo "Build     : $BUILD_DATE"
echo "Area      : $MIN_LON,$MIN_LAT -> $MAX_LON,$MAX_LAT"
echo "Zoom maks : $MAX_ZOOM"
echo "Tujuan    : $OUTPUT"
echo

mkdir -p "$(dirname "$OUTPUT")"
"$PMTILES_BIN" extract "https://build.protomaps.com/${BUILD_DATE}.pmtiles" "$OUTPUT" \
    --bbox="${MIN_LON},${MIN_LAT},${MAX_LON},${MAX_LAT}" \
    --maxzoom="$MAX_ZOOM"

echo
echo "Selesai. Verifikasi isi berkas:"
"$PMTILES_BIN" show "$OUTPUT" | head -8
echo
echo "Ukuran: $(du -h "$OUTPUT" | cut -f1)"
