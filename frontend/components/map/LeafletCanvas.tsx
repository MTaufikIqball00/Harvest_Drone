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
import { MapContainer, TileLayer, Polyline, Marker, Popup, ImageOverlay, useMapEvents, useMap } from "react-leaflet";
import { telemetryStore, type Waypoint } from "@/lib/telemetryStore";

/** Origin geodetik lokal — harus konsisten dengan konversi di seluruh aplikasi. */
export const ORIGIN_LAT = -6.9175;
export const ORIGIN_LON = 107.6191;
export const METER_TO_GEO = 0.000009;

export function metersToLatLon(x: number, y: number): [number, number] {
  return [ORIGIN_LAT + y * METER_TO_GEO, ORIGIN_LON + x * METER_TO_GEO];
}

export function latLonToMeters(lat: number, lon: number): { x: number; y: number } {
  return {
    x: (lon - ORIGIN_LON) / METER_TO_GEO,
    y: (lat - ORIGIN_LAT) / METER_TO_GEO,
  };
}

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
      const lat = live.lat || ORIGIN_LAT + live.y * METER_TO_GEO;
      const lon = live.lon || ORIGIN_LON + live.x * METER_TO_GEO;

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
        trail.setLatLngs(points.map((p) => metersToLatLon(p.x, p.y)));
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
  orthophotoUrl?: string;
  classificationUrl?: string;
  showOrtho: boolean;
  showClassification: boolean;
  classOpacity: number;
  bounds: [number, number, number, number];
  interactive: boolean;
  followDrone: boolean;
  onMapClick: (lat: number, lon: number) => void;
  onMapDoubleClick: () => void;
}

function LeafletCanvasImpl({
  targetWp,
  orthophotoUrl,
  classificationUrl,
  showOrtho,
  showClassification,
  classOpacity,
  bounds,
  interactive,
  followDrone,
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
            targetWp.lat ?? ORIGIN_LAT + targetWp.y * METER_TO_GEO,
            targetWp.lon ?? ORIGIN_LON + targetWp.x * METER_TO_GEO,
          ]
        : null,
    [targetWp]
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

      <TileLayer
        attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        maxNativeZoom={19}
        maxZoom={22}
        keepBuffer={4}
        updateWhenIdle
      />

      {orthophotoUrl && showOrtho && (
        <ImageOverlay url={orthophotoUrl} bounds={leafletBounds} opacity={1.0} />
      )}

      {classificationUrl && showClassification && (
        <ImageOverlay url={classificationUrl} bounds={leafletBounds} opacity={classOpacity} />
      )}

      <LiveDroneLayer followDrone={followDrone} />

      {interactive && targetPos && targetWp && (
        <>
          <Polyline
            positions={[targetPos, targetPos]}
            color="#fbbf24"
            weight={3}
            opacity={0.9}
            dashArray="6, 6"
          />
          <Marker position={targetPos} icon={targetIcon}>
            <Popup>
              <div className="text-xs p-1">
                <strong className="text-amber-500 font-bold">🎯 Destination Target</strong>
                <div>Alt: {targetWp.z}m</div>
                <div>
                  X: {targetWp.x} | Y: {targetWp.y}
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
