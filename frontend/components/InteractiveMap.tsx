"use client";

import React, { useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { TelemetryData, Waypoint } from "@/lib/useRos";
import { Layers, MapPin, Target, RefreshCw } from "lucide-react";

// Dynamic import for Leaflet components to avoid SSR window error
const MapContainer = dynamic(() => import("react-leaflet").then((m) => m.MapContainer), { ssr: false });
const TileLayer = dynamic(() => import("react-leaflet").then((m) => m.TileLayer), { ssr: false });
const Marker = dynamic(() => import("react-leaflet").then((m) => m.Marker), { ssr: false });
const Polyline = dynamic(() => import("react-leaflet").then((m) => m.Polyline), { ssr: false });
const Popup = dynamic(() => import("react-leaflet").then((m) => m.Popup), { ssr: false });
const ImageOverlay = dynamic(() => import("react-leaflet").then((m) => m.ImageOverlay), { ssr: false });

// Helper component for map single-click & double-click events
const MapClickHandler = dynamic(
  () =>
    import("react-leaflet").then((m) => {
      const { useMapEvents } = m;
      return function ClickHandler({
        onMapClick,
        onMapDoubleClick,
      }: {
        onMapClick: (lat: number, lon: number) => void;
        onMapDoubleClick: () => void;
      }) {
        useMapEvents({
          click(e) {
            onMapClick(e.latlng.lat, e.latlng.lng);
          },
          dblclick() {
            onMapDoubleClick();
          },
        });
        return null;
      };
    }),
  { ssr: false }
);

interface Props {
  telemetry: TelemetryData;
  waypoints?: Waypoint[];
  flightPath?: { x: number; y: number }[];
  orthophotoUrl?: string;
  classificationUrl?: string;
  bounds?: [number, number, number, number];
  hideTargetOverlay?: boolean;
  onSetTargetWaypoint?: (wp: Waypoint | null) => void;
  onClearWaypoints?: () => void;
}

export function InteractiveMap({
  telemetry,
  waypoints = [],
  flightPath = [],
  orthophotoUrl,
  classificationUrl,
  bounds = [107.61, -6.92, 107.63, -6.90],
  hideTargetOverlay = false,
  onSetTargetWaypoint,
  onClearWaypoints,
}: Props) {
  const [showOrtho, setShowOrtho] = useState(true);
  const [showClassification, setShowClassification] = useState(true);
  const [classOpacity, setClassOpacity] = useState(0.65);

  // Conversion helpers between local X,Y meters and Lat/Lon
  const originLat = -6.9175;
  const originLon = 107.6191;
  const meterToGeo = 0.000009;

  const dronePos: [number, number] = [
    telemetry.lat || originLat + (telemetry.y || 0) * meterToGeo,
    telemetry.lon || originLon + (telemetry.x || 0) * meterToGeo,
  ];

  // Single target waypoint (Destination Y)
  const targetWp = waypoints.length > 0 ? waypoints[waypoints.length - 1] : null;

  const targetPos: [number, number] | null = targetWp
    ? [
        targetWp.lat || originLat + targetWp.y * meterToGeo,
        targetWp.lon || originLon + targetWp.x * meterToGeo,
      ]
    : null;

  const pathPositions: [number, number][] = useMemo(() => {
    return flightPath.map((pt) => [
      originLat + pt.y * meterToGeo,
      originLon + pt.x * meterToGeo,
    ]);
  }, [flightPath]);

  const leafletBounds = useMemo<[[number, number], [number, number]]>(
    () => [
      [bounds[1], bounds[0]],
      [bounds[3], bounds[2]],
    ],
    [bounds]
  );

  // Single click sets/replaces the target destination (X -> Y)
  const handleMapClick = (lat: number, lon: number) => {
    if (hideTargetOverlay) return;
    const xMeters = (lon - originLon) / meterToGeo;
    const yMeters = (lat - originLat) / meterToGeo;

    const singleTarget: Waypoint = {
      id: 1,
      x: parseFloat(xMeters.toFixed(2)),
      y: parseFloat(yMeters.toFixed(2)),
      z: 8.0,
      lat,
      lon,
    };

    if (onSetTargetWaypoint) {
      onSetTargetWaypoint(singleTarget);
    }
  };

  // Double click clears the target waypoint
  const handleMapDoubleClick = () => {
    if (hideTargetOverlay) return;
    if (onClearWaypoints) {
      onClearWaypoints();
    }
  };

  return (
    <div className="relative w-full h-[560px] rounded-2xl overflow-hidden glass-panel border border-slate-700/60 shadow-2xl">
      <MapContainer
        center={dronePos}
        zoom={18}
        zoomControl={false}
        doubleClickZoom={false}
        scrollWheelZoom={true}
        className="w-full h-full"
      >
        {!hideTargetOverlay && (
          <MapClickHandler onMapClick={handleMapClick} onMapDoubleClick={handleMapDoubleClick} />
        )}

        <TileLayer
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          maxNativeZoom={19}
          maxZoom={22}
        />

        {/* Orthophoto GIS Overlay */}
        {orthophotoUrl && showOrtho && (
          <ImageOverlay url={orthophotoUrl} bounds={leafletBounds} opacity={1.0} />
        )}

        {/* AI Classification Overlay */}
        {classificationUrl && showClassification && (
          <ImageOverlay url={classificationUrl} bounds={leafletBounds} opacity={classOpacity} />
        )}

        {/* Flight Trail */}
        {pathPositions.length > 1 && (
          <Polyline positions={pathPositions} color="#06b6d4" weight={3} opacity={0.8} dashArray="4, 4" />
        )}

        {/* Target Line (X Drone Position -> Y Target Destination) */}
        {!hideTargetOverlay && targetPos && (
          <Polyline
            positions={[dronePos, targetPos]}
            color="#fbbf24"
            weight={3}
            opacity={0.9}
            dashArray="6, 6"
          />
        )}

        {/* Drone Marker */}
        <Marker position={dronePos}>
          <Popup>
            <div className="text-xs p-1">
              <strong className="text-emerald-600 block font-bold">🚁 Drone Realtime</strong>
              <div>Alt: {telemetry.alt?.toFixed(2)}m</div>
              <div>Mode: {telemetry.flightMode}</div>
              <div>Batt: {telemetry.battery}%</div>
              <div>X: {telemetry.x?.toFixed(2)} | Y: {telemetry.y?.toFixed(2)}</div>
            </div>
          </Popup>
        </Marker>

        {/* Single Target Marker (Destination Y) */}
        {!hideTargetOverlay && targetPos && targetWp && (
          <Marker position={targetPos}>
            <Popup>
              <div className="text-xs p-1">
                <strong className="text-amber-500 font-bold">🎯 Destination Target (Y)</strong>
                <div>Alt: {targetWp.z}m</div>
                <div>X: {targetWp.x} | Y: {targetWp.y}</div>
              </div>
            </Popup>
          </Marker>
        )}
      </MapContainer>

      {/* Instruction Badge (Only on Control Overview mode) */}
      {!hideTargetOverlay && (
        <div className="absolute top-4 left-4 z-[1000] glass-panel px-3.5 py-2 rounded-xl border border-slate-700/80 text-xs flex items-center gap-2.5 shadow-xl text-slate-200">
          <Target className="w-4 h-4 text-amber-400" />
          <div>
            <div className="font-semibold text-slate-100">
              {targetWp ? `Target Y Ditentukan: (${targetWp.x}, ${targetWp.y})` : "Klik Peta untuk Tentukan Target Y"}
            </div>
            <div className="text-[10px] text-slate-400">Double-Click Peta untuk Hapus Target</div>
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

      {/* Layer Control Widget */}
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

      {/* Telemetry Quick Badge */}
      <div className="absolute bottom-4 left-4 z-[1000] glass-panel px-3 py-1.5 rounded-lg border border-slate-700/80 text-xs flex items-center gap-3 shadow-xl">
        <span className="flex items-center gap-1 text-slate-300">
          <MapPin className="w-3.5 h-3.5 text-cyan-400" />
          Lat: {dronePos[0].toFixed(5)}
        </span>
        <span className="text-slate-400">|</span>
        <span className="flex items-center gap-1 text-slate-300">
          <Target className="w-3.5 h-3.5 text-emerald-400" />
          Lon: {dronePos[1].toFixed(5)}
        </span>
      </div>
    </div>
  );
}
