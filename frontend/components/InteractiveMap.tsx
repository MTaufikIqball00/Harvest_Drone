"use client";

/**
 * components/InteractiveMap.tsx
 * =============================================================================
 * Pembungkus peta Leaflet + widget kontrol layer.
 *
 * Komponen ini SENGAJA tidak menerima `telemetry` sebagai prop. Posisi drone
 * dibaca langsung dari store oleh `LiveDroneLayer` di dalam LeafletCanvas
 * secara imperatif. Versi lama meneruskan objek telemetry sebagai prop,
 * sehingga setiap pesan telemetry me-render ulang MapContainer beserta seluruh
 * anaknya — react-leaflet lalu men-diff Marker/Polyline/ImageOverlay 20-50 kali
 * per detik. Itu penyebab peta terasa berat.
 */

import React, { useCallback, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Waypoint } from "@/lib/telemetryStore";
import { useTelemetry } from "@/lib/useRos";
import { Layers, MapPin, Target, RefreshCw, Crosshair } from "lucide-react";

// SATU dynamic import untuk seluruh isi peta (Leaflet butuh `window`).
const LeafletCanvas = dynamic(() => import("./map/LeafletCanvas"), {
  ssr: false,
  loading: () => (
    <div className="w-full h-full flex items-center justify-center text-xs text-slate-400">
      Memuat peta...
    </div>
  ),
});

const ORIGIN_LAT = -6.9175;
const ORIGIN_LON = 107.6191;
const METER_TO_GEO = 0.000009;

/** Batas default sebagai konstanta modul agar identitasnya stabil antar-render. */
const DEFAULT_BOUNDS: [number, number, number, number] = [107.61, -6.92, 107.63, -6.9];

interface Props {
  waypoints?: Waypoint[];
  orthophotoUrl?: string;
  classificationUrl?: string;
  bounds?: [number, number, number, number];
  hideTargetOverlay?: boolean;
  onSetTargetWaypoint?: (wp: Waypoint | null) => void;
  onClearWaypoints?: () => void;
}

/** Badge koordinat — komponen kecil terpisah agar hanya INI yang render 20Hz. */
const CoordinateBadge = React.memo(function CoordinateBadge() {
  const telemetry = useTelemetry();
  const lat = telemetry.lat || ORIGIN_LAT + telemetry.y * METER_TO_GEO;
  const lon = telemetry.lon || ORIGIN_LON + telemetry.x * METER_TO_GEO;

  return (
    <div className="absolute bottom-4 left-4 z-[1000] glass-panel px-3 py-1.5 rounded-lg border border-slate-700/80 text-xs flex items-center gap-3 shadow-xl">
      <span className="flex items-center gap-1 text-slate-300">
        <MapPin className="w-3.5 h-3.5 text-cyan-400" />
        Lat: {lat.toFixed(5)}
      </span>
      <span className="text-slate-400">|</span>
      <span className="flex items-center gap-1 text-slate-300">
        <Target className="w-3.5 h-3.5 text-emerald-400" />
        Lon: {lon.toFixed(5)}
      </span>
    </div>
  );
});

function InteractiveMapImpl({
  waypoints = [],
  orthophotoUrl,
  classificationUrl,
  bounds = DEFAULT_BOUNDS,
  hideTargetOverlay = false,
  onSetTargetWaypoint,
  onClearWaypoints,
}: Props) {
  const [showOrtho, setShowOrtho] = useState(true);
  const [showClassification, setShowClassification] = useState(true);
  const [classOpacity, setClassOpacity] = useState(0.65);
  const [followDrone, setFollowDrone] = useState(false);

  const targetWp = useMemo(
    () => (waypoints.length > 0 ? waypoints[waypoints.length - 1] : null),
    [waypoints]
  );

  const handleMapClick = useCallback(
    (lat: number, lon: number) => {
      if (hideTargetOverlay) return;
      onSetTargetWaypoint?.({
        id: 1,
        x: parseFloat(((lon - ORIGIN_LON) / METER_TO_GEO).toFixed(2)),
        y: parseFloat(((lat - ORIGIN_LAT) / METER_TO_GEO).toFixed(2)),
        z: 8.0,
        lat,
        lon,
      });
    },
    [hideTargetOverlay, onSetTargetWaypoint]
  );

  const handleMapDoubleClick = useCallback(() => {
    if (hideTargetOverlay) return;
    onClearWaypoints?.();
  }, [hideTargetOverlay, onClearWaypoints]);

  return (
    <div className="relative w-full h-[560px] rounded-2xl overflow-hidden glass-panel border border-slate-700/60 shadow-2xl">
      <LeafletCanvas
        targetWp={targetWp}
        orthophotoUrl={orthophotoUrl}
        classificationUrl={classificationUrl}
        showOrtho={showOrtho}
        showClassification={showClassification}
        classOpacity={classOpacity}
        bounds={bounds}
        interactive={!hideTargetOverlay}
        followDrone={followDrone}
        onMapClick={handleMapClick}
        onMapDoubleClick={handleMapDoubleClick}
      />

      {!hideTargetOverlay && (
        <div className="absolute top-4 left-4 z-[1000] glass-panel px-3.5 py-2 rounded-xl border border-slate-700/80 text-xs flex items-center gap-2.5 shadow-xl text-slate-200">
          <Target className="w-4 h-4 text-amber-400" />
          <div>
            <div className="font-semibold text-slate-100">
              {targetWp
                ? `Target: (${targetWp.x}, ${targetWp.y})`
                : "Klik Peta untuk Tentukan Target"}
            </div>
            <div className="text-[10px] text-slate-400">
              {targetWp && !targetWp.confirmed
                ? "⏳ Menunggu konfirmasi (ACK) dari node ROS"
                : "Double-Click Peta untuk Hapus Target"}
            </div>
          </div>
          {targetWp && onClearWaypoints && (
            <button
              onClick={onClearWaypoints}
              className="ml-2 text-slate-400 hover:text-red-400 p-1 rounded-md transition-colors"
              title="Reset Target"
            >
              <RefreshCw className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      <div className="absolute top-4 right-4 z-[1000] glass-panel p-3 rounded-xl border border-slate-700/80 text-xs shadow-xl min-w-[180px]">
        <div className="flex items-center gap-1.5 font-semibold text-slate-200 border-b border-slate-700 pb-1.5 mb-2">
          <Layers className="w-4 h-4 text-emerald-400" /> Layer Controls
        </div>

        <label className="flex items-center gap-2 cursor-pointer text-slate-300 hover:text-white py-1">
          <input
            type="checkbox"
            checked={showOrtho}
            onChange={(e) => setShowOrtho(e.target.checked)}
            className="accent-cyan-500 rounded"
          />
          Drone Orthophoto
        </label>

        <label className="flex items-center gap-2 cursor-pointer text-slate-300 hover:text-white py-1">
          <input
            type="checkbox"
            checked={showClassification}
            onChange={(e) => setShowClassification(e.target.checked)}
            className="accent-emerald-500 rounded"
          />
          AI Harvest Overlay
        </label>

        <label className="flex items-center gap-2 cursor-pointer text-slate-300 hover:text-white py-1 border-t border-slate-700/60 mt-1 pt-2">
          <input
            type="checkbox"
            checked={followDrone}
            onChange={(e) => setFollowDrone(e.target.checked)}
            className="accent-amber-500 rounded"
          />
          <Crosshair className="w-3 h-3 text-amber-400" /> Follow Drone
        </label>

        {showClassification && (
          <div className="mt-2 pl-4 border-l border-slate-700/60 flex flex-col gap-1">
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>Opacity</span>
              <span>{Math.round(classOpacity * 100)}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round(classOpacity * 100)}
              onChange={(e) => setClassOpacity(Number(e.target.value) / 100)}
              className="accent-emerald-500 w-full"
            />
          </div>
        )}
      </div>

      <CoordinateBadge />
    </div>
  );
}

export const InteractiveMap = React.memo(InteractiveMapImpl);
