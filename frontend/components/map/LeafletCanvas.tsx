"use client";

/**
 * components/map/LeafletCanvas.tsx
 * =============================================================================
 * Isi peta Leaflet. Dipisah dari InteractiveMap supaya bisa dimuat lewat SATU
 * `dynamic(..., { ssr: false })` alih-alih tujuh dynamic import terpisah untuk
 * MapContainer/TileLayer/Marker/Polyline/Popup/ImageOverlay/useMapEvents.
 *
 * Setiap `dynamic()` menghasilkan chunk lazy tersendiri plus wrapper komponen;
 * versi lama membayar biaya itu tujuh kali dan membuat seluruh subtree peta
 * remount ketika parent-nya render.
 *
 * KUNCI PERFORMA: marker drone & garis lintasan TIDAK dikelola React.
 * Keduanya objek Leaflet asli yang diperbarui secara imperatif di dalam loop
 * rAF. Dengan begitu telemetry 20Hz sama sekali tidak menyentuh reconciler
 * React — hanya `setLatLng()` pada satu marker, yang biayanya sepele.
 */

import React, { useEffect, useMemo, useRef } from "react";
import L from "leaflet";
import { MapContainer, Polyline, Marker, Popup, Tooltip, ImageOverlay, useMapEvents, useMap } from "react-leaflet";
import { telemetryStore, type PlannedPathPoint, type Waypoint } from "@/lib/telemetryStore";
import {
  ORIGIN_LAT,
  ORIGIN_LON,
  metersToLatLon,
  distanceToTarget,
  formatDistance,
} from "@/lib/geo";

/**
 * Ikon drone berbasis divIcon.
 *
 * Leaflet default me-resolve ikon marker lewat URL gambar relatif yang rusak di
 * bundler seperti Webpack/Turbopack (marker muncul sebagai gambar patah). Ikon
 * berbasis DOM menghindari aset eksternal sekaligus memungkinkan rotasi yaw.
 */
const droneIcon = L.divIcon({
  className: "drone-marker",
  html:
    '<div class="drone-marker__body" style="transform:rotate(0deg)">' +
    '<svg viewBox="0 0 24 24" width="26" height="26">' +
    '<path d="M12 2 L20 20 L12 16 L4 20 Z" fill="#38bdf8" stroke="#0f172a" stroke-width="1.5" stroke-linejoin="round"/>' +
    "</svg></div>",
  iconSize: [26, 26],
  iconAnchor: [13, 13],
});

const targetIcon = L.divIcon({
  className: "target-marker",
  html:
    '<div style="width:18px;height:18px;border:2px solid #fbbf24;border-radius:50%;' +
    'box-shadow:0 0 0 2px rgba(15,23,42,.6);position:relative">' +
    '<span style="position:absolute;inset:6px;background:#fbbf24;border-radius:50%"></span></div>',
  iconSize: [18, 18],
  iconAnchor: [9, 9],
});

/**
 * Layer drone imperatif: marker + jejak terbang, diperbarui dari
 * `telemetryStore.live` pada loop rAF yang di-throttle.
 */
function LiveDroneLayer({ followDrone }: { followDrone: boolean }) {
  const map = useMap();
  const followRef = useRef(followDrone);
  followRef.current = followDrone;

  useEffect(() => {
    const marker = L.marker([ORIGIN_LAT, ORIGIN_LON], {
      icon: droneIcon,
      interactive: false,
      keyboard: false,
    }).addTo(map);

    const trail = L.polyline([], {
      color: "#06b6d4",
      weight: 3,
      opacity: 0.8,
      dashArray: "4, 4",
      interactive: false,
    }).addTo(map);

    let animationId = 0;
    let lastRender = 0;
    let lastKey = "";
    let lastTrailLength = -1;
    const svgHost = marker.getElement()?.querySelector<HTMLElement>(".drone-marker__body");

    const tick = (timestamp: number) => {
      animationId = requestAnimationFrame(tick);

      // Peta tidak perlu 60fps; 15Hz sudah tidak terlihat patah oleh mata dan
      // memangkas biaya reproyeksi Leaflet hingga 4x.
      if (timestamp - lastRender < 66) return;
      lastRender = timestamp;

      const live = telemetryStore.live;
      // Posisi yang SUDAH dihaluskan. Dari lat/lon mentah, ayunan GPS beberapa
      // meter membuat ikon bergetar terus-menerus walau drone hover diam.
      const pos = telemetryStore.getRenderPosition();
      // Pakai lat/lon ASLI dari GPS bila tersedia; kalau tidak, proyeksikan
      // dari posisi lokal supaya drone tanpa GPS tetap tergambar.
      const [lat, lon] = live.gpsValid && pos.lat && pos.lon
        ? [pos.lat, pos.lon]
        : metersToLatLon(pos.x, pos.y);

      const key = `${lat.toFixed(7)}|${lon.toFixed(7)}|${live.heading.toFixed(1)}`;
      if (key !== lastKey) {
        lastKey = key;
        marker.setLatLng([lat, lon]);
        if (svgHost) svgHost.style.transform = `rotate(${live.heading}deg)`;
        if (followRef.current) map.panTo([lat, lon], { animate: false });
      }

      const points = telemetryStore.getLiveTrail();
      if (points.length !== lastTrailLength) {
        lastTrailLength = points.length;
        // Titik yang direkam saat GPS aktif membawa lat/lon aslinya; pakai itu
        // langsung. Memproyeksikan x/y untuk titik semacam itu menaruh jejak di
        // origin, jauh dari ikon dronenya — inilah sebab jejak tampak hilang
        // pada drone asli. Titik tanpa GPS tetap diproyeksikan seperti semula.
        trail.setLatLngs(
          points.map((p) =>
            typeof p.lat === "number" && typeof p.lon === "number"
              ? ([p.lat, p.lon] as [number, number])
              : metersToLatLon(p.x, p.y)
          )
        );
      }
    };

    animationId = requestAnimationFrame(tick);

    return () => {
      cancelAnimationFrame(animationId);
      // Cleanup eksplisit: tanpa ini setiap remount meninggalkan marker &
      // polyline yatim di dalam peta (kebocoran DOM + memori).
      marker.remove();
      trail.remove();
    };
  }, [map]);

  return null;
}

/**
 * Garis putus-putus dari posisi drone SAAT INI ke waypoint tujuan.
 *
 * Menandakan "drone sedang menuju ke sana": pangkal garis mengikuti drone
 * secara live, ujungnya menempel di marker tujuan, sehingga garis memendek
 * sendiri seiring drone mendekat.
 *
 * Sengaja imperatif seperti LiveDroneLayer — sebuah <Polyline> React yang
 * posisinya diperbarui dari telemetry 20Hz akan memaksa react-leaflet men-diff
 * dan menggambar ulang layer puluhan kali per detik.
 */
function RouteLine({ target }: { target: Waypoint }) {
  const map = useMap();
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    const line = L.polyline([], {
      color: "#fbbf24",
      weight: 2.5,
      opacity: 0.9,
      dashArray: "8, 8",
      interactive: false,
    }).addTo(map);

    let animationId = 0;
    let lastRender = 0;
    let lastKey = "";

    const tick = (timestamp: number) => {
      animationId = requestAnimationFrame(tick);
      // 15Hz sudah mulus untuk mata; menyamai kadens LiveDroneLayer supaya
      // garis dan ikon drone bergerak seirama, tidak saling mendahului.
      if (timestamp - lastRender < 66) return;
      lastRender = timestamp;

      const live = telemetryStore.live;
      const wp = targetRef.current;

      // Pangkal garis mengikuti posisi halus yang sama dengan ikon drone —
      // kalau memakai posisi mentah, garis akan bergetar lepas dari ikonnya.
      const pos = telemetryStore.getRenderPosition();
      const [dLat, dLon] =
        live.gpsValid && pos.lat && pos.lon
          ? [pos.lat, pos.lon]
          : metersToLatLon(pos.x, pos.y);
      const [tLat, tLon] =
        typeof wp.lat === "number" && typeof wp.lon === "number"
          ? [wp.lat, wp.lon]
          : metersToLatLon(wp.x, wp.y);

      const key = `${dLat.toFixed(7)}|${dLon.toFixed(7)}|${tLat}|${tLon}`;
      if (key === lastKey) return;
      lastKey = key;

      line.setLatLngs([
        [dLat, dLon],
        [tLat, tLon],
      ]);
    };

    animationId = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(animationId);
      line.remove();
    };
  }, [map]);

  return null;
}

/**
 * Label jarak drone -> waypoint yang selalu hidup, SELALU dalam meter.
 *
 * Menulis textContent lewat rAF alih-alih state React: komponen ini dipasang di
 * dalam Tooltip/Popup Leaflet, dan me-render ulang React 20x/detik hanya untuk
 * satu angka akan memaksa Leaflet mereposisi seluruh popup tiap frame.
 */
function LiveDistanceLabel({
  target,
  className,
}: {
  target: Waypoint;
  className?: string;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  const targetRef = useRef(target);
  targetRef.current = target;

  useEffect(() => {
    let animationId = 0;
    let lastRender = 0;
    let lastText = "";

    const tick = (timestamp: number) => {
      animationId = requestAnimationFrame(tick);
      // 5Hz: angka jarak tetap terasa live, tanpa membebani DOM.
      if (timestamp - lastRender < 200) return;
      lastRender = timestamp;

      const live = telemetryStore.live;
      const wp = targetRef.current;
      // Posisi halus juga di sini: dari posisi mentah, angka jarak berkedip
      // naik-turun beberapa meter walau drone diam.
      const pos = telemetryStore.getRenderPosition();
      const { horizontalM } = distanceToTarget(
        { x: pos.x, y: pos.y, z: live.z, lat: pos.lat, lon: pos.lon, gpsValid: live.gpsValid },
        { x: wp.x, y: wp.y, z: wp.z, lat: wp.lat, lon: wp.lon }
      );
      const text = formatDistance(horizontalM);
      if (text !== lastText && ref.current) {
        lastText = text;
        ref.current.textContent = text;
      }
    };

    animationId = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animationId);
  }, []);

  return (
    <span ref={ref} className={className}>
      -
    </span>
  );
}

/**
 * Peta dasar OFFLINE dari berkas PMTiles lokal.
 *
 * MASALAH YANG DIPECAHKAN
 * -----------------------
 * Di lapangan, laptop tersambung ke hotspot HP / WiFi remote DJI yang tidak
 * punya jalur internet. Versi sebelumnya mengambil gambar peta dari
 * tile.openstreetmap.org, jadi tanpa internet latar peta kosong (kotak abu-abu)
 * dan operator kehilangan konteks lapangan — posisi drone tetap akurat karena
 * dari GPS, tapi tidak terlihat berada di sebelah mana.
 *
 * KENAPA PMTiles, BUKAN MENGUNDUH TILE OSM
 * ----------------------------------------
 * Kebijakan tile server OSM MELARANG unduhan borongan untuk cache offline
 * (>250 tile pada zoom >=13). Percobaan ke arah sana dibalas HTTP 200 berisi
 * gambar "Access denied" — gagal secara senyap, bukan error yang kelihatan.
 *
 * PMTiles dari Protomaps justru dirancang untuk pemakaian offline/self-host:
 * SATU berkas berisi seluruh data vektor area operasi (lihat
 * scripts/extract_offline_map.sh). Karena vektor, satu berkas 3 MB melayani
 * semua level zoom — tidak ada level yang "belum diunduh".
 */
const PMTILES_URL = "/map/basemap.pmtiles";
const ONLINE_TILE_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

function BaseTileLayer({ offline }: { offline: boolean }) {
  const map = useMap();

  useEffect(() => {
    let layer: L.Layer | null = null;
    let cancelled = false;

    if (!offline) {
      // Mode online: tile raster OSM standar. Hanya berguna saat ada internet —
      // di lapangan (hotspot HP / WiFi remote DJI) ini menghasilkan layar
      // kosong, karena itu mode offline yang jadi default.
      layer = L.tileLayer(ONLINE_TILE_URL, {
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        maxNativeZoom: 19,
        maxZoom: 22,
        keepBuffer: 4,
        updateWhenIdle: true,
      });
      layer.addTo(map);
      return () => {
        layer?.remove();
      };
    }

    // Impor dinamis: pustakanya menyentuh API browser, jadi tidak boleh ikut
    // dievaluasi saat modul dimuat di server.
    (async () => {
      const protomapsL = await import("protomaps-leaflet");
      if (cancelled) return;

      // URL diberikan sebagai string, BUKAN instance PMTiles buatan sendiri:
      // protomaps-leaflet membundel versi `pmtiles` sendiri, dan mencampur dua
      // salinan pustaka itu membuat tipenya bentrok. Dengan string, pustaka
      // membuat instance-nya sendiri dan membaca berkas lewat HTTP range
      // request — hanya potongan yang dibutuhkan yang diambil, bukan seluruh
      // 3 MB setiap kali peta digeser.
      layer = protomapsL.leafletLayer({
        url: PMTILES_URL,
        // Tema gelap menyatu dengan dashboard, sekaligus membuat marker drone
        // (cyan) dan waypoint (kuning) tetap kontras di atasnya.
        flavor: "dark",
        attribution:
          '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> | ' +
          '<a href="https://protomaps.com">Protomaps</a>',
      }) as unknown as L.Layer;

      layer.addTo(map);
    })().catch((err) => {
      console.error("[peta] Gagal memuat basemap PMTiles:", err);
    });

    return () => {
      cancelled = true;
      layer?.remove();
    };
  }, [map, offline]);

  return null;
}

function ClickHandler({
  onMapClick,
  onMapDoubleClick,
}: {
  onMapClick: (lat: number, lon: number) => void;
  onMapDoubleClick: () => void;
}) {
  useMapEvents({
    click: (e) => onMapClick(e.latlng.lat, e.latlng.lng),
    dblclick: () => onMapDoubleClick(),
  });
  return null;
}

export interface LeafletCanvasProps {
  targetWp: Waypoint | null;
  plannedPath?: PlannedPathPoint[];
  orthophotoUrl?: string;
  classificationUrl?: string;
  showOrtho: boolean;
  showClassification: boolean;
  classOpacity: number;
  bounds: [number, number, number, number];
  interactive: boolean;
  followDrone: boolean;
  /** true = basemap PMTiles lokal (aman tanpa internet); false = tile OSM online. */
  offlineBasemap: boolean;
  onMapClick: (lat: number, lon: number) => void;
  onMapDoubleClick: () => void;
}

function LeafletCanvasImpl({
  targetWp,
  plannedPath,
  orthophotoUrl,
  classificationUrl,
  showOrtho,
  showClassification,
  classOpacity,
  bounds,
  interactive,
  followDrone,
  offlineBasemap,
  onMapClick,
  onMapDoubleClick,
}: LeafletCanvasProps) {
  const leafletBounds = useMemo<[[number, number], [number, number]]>(
    () => [
      [bounds[1], bounds[0]],
      [bounds[3], bounds[2]],
    ],
    [bounds]
  );

  const targetPos = useMemo<[number, number] | null>(
    () =>
      targetWp
        ? [
            targetWp.lat ?? metersToLatLon(targetWp.x, targetWp.y)[0],
            targetWp.lon ?? metersToLatLon(targetWp.x, targetWp.y)[1],
          ]
        : null,
    [targetWp]
  );

  const plannedPathPositions = useMemo<[number, number][]>(
    () => (plannedPath ?? []).map((p) => metersToLatLon(p.x, p.y)),
    [plannedPath]
  );

  return (
    <MapContainer
      center={[ORIGIN_LAT, ORIGIN_LON]}
      zoom={18}
      zoomControl={false}
      doubleClickZoom={false}
      scrollWheelZoom
      // preferCanvas merender polyline/marker vektor ke satu elemen <canvas>
      // alih-alih ratusan node SVG. Untuk jejak terbang panjang ini perbedaan
      // antara peta yang mulus dan peta yang tersendat.
      preferCanvas
      className="w-full h-full"
    >
      {interactive && (
        <ClickHandler onMapClick={onMapClick} onMapDoubleClick={onMapDoubleClick} />
      )}

      <BaseTileLayer offline={offlineBasemap} />

      {orthophotoUrl && showOrtho && (
        <ImageOverlay url={orthophotoUrl} bounds={leafletBounds} opacity={1.0} />
      )}

      {classificationUrl && showClassification && (
        <ImageOverlay url={classificationUrl} bounds={leafletBounds} opacity={classOpacity} />
      )}

      <LiveDroneLayer followDrone={followDrone} />

      {plannedPathPositions.length > 1 && (
        <Polyline
          positions={plannedPathPositions}
          color="#fbbf24"
          weight={3}
          opacity={0.85}
          dashArray="8, 8"
        />
      )}

      {/* Garis rute hanya digambar setelah perintah BENAR-BENAR dikirim dan
          tidak ditolak. Menggambarnya saat marker baru dipasang akan
          menyiratkan drone sudah dalam perjalanan, padahal belum berangkat. */}
      {interactive && targetWp?.sent && !targetWp.rejected && (
        <RouteLine target={targetWp} />
      )}

      {interactive && targetPos && targetWp && (
        <>
          <Marker position={targetPos} icon={targetIcon}>
            {/* Hover: langsung tampilkan jarak drone -> waypoint (meter). */}
            <Tooltip direction="top" offset={[0, -12]} opacity={1}>
              <div className="text-xs">
                <div className="font-bold text-amber-600">🎯 Jarak ke waypoint</div>
                <div className="font-mono text-sm font-bold">
                  <LiveDistanceLabel target={targetWp} />
                </div>
              </div>
            </Tooltip>
            <Popup>
              <div className="text-xs p-1">
                <strong className="text-amber-500 font-bold">🎯 Destination Target</strong>
                <div>Alt: {targetWp.z}m</div>
                <div>
                  X: {targetWp.x} | Y: {targetWp.y}
                </div>
                <div>
                  Jarak dari drone:{" "}
                  <strong className="font-mono">
                    <LiveDistanceLabel target={targetWp} />
                  </strong>
                </div>
                <div className={targetWp.confirmed ? "text-emerald-600" : "text-amber-600"}>
                  {targetWp.confirmed ? "✓ Dikonfirmasi node" : "⏳ Menunggu ACK"}
                </div>
              </div>
            </Popup>
          </Marker>
        </>
      )}
    </MapContainer>
  );
}

export default React.memo(LeafletCanvasImpl);
