"use client";

/**
 * components/TelemetryPanel.tsx
 * =============================================================================
 * Strip HUD telemetry.
 *
 * Panel ini berlangganan store SENDIRI (bukan menerima telemetry lewat prop),
 * sehingga ia adalah satu-satunya bagian pohon komponen yang render pada rate
 * telemetry. Sebelumnya `page.tsx` yang menyimpan state dan meneruskannya ke
 * bawah, artinya seluruh halaman ikut render hanya untuk memperbarui empat
 * angka di sini.
 */

import React from "react";
import { useTelemetry, useVehicleState } from "@/lib/useRos";
import { Gauge, Navigation, Battery, Compass, Wifi, Satellite } from "lucide-react";

const RAD_TO_DEG = 180 / Math.PI;

function batteryTone(percent: number) {
  if (percent > 60) return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
  if (percent > 20) return "text-amber-400 border-amber-500/30 bg-amber-500/10";
  return "text-red-400 border-red-500/30 bg-red-500/10 animate-pulse";
}

/** Indikator latensi end-to-end: node ROS -> rosbridge -> browser. */
const LatencyBadge = React.memo(function LatencyBadge() {
  const { latencyMs } = useVehicleState();
  const tone =
    latencyMs < 120 ? "text-emerald-400" : latencyMs < 400 ? "text-amber-400" : "text-red-400";
  return (
    <span className={`flex items-center gap-1 text-[10px] font-mono ${tone}`}>
      <Wifi className="w-3 h-3" />
      {latencyMs > 0 ? `${latencyMs} ms` : "-- ms"}
    </span>
  );
});

/**
 * Indikator mode navigasi.
 *
 * Operator perlu tahu dengan pasti apakah target yang diklik akan diterbangkan
 * ke koordinat bumi sungguhan (GPS) atau hanya sebagai jarak relatif (meter).
 * Menyembunyikan perbedaan ini berbahaya: pada drone tanpa GPS, klik peta tetap
 * menghasilkan gerakan, tetapi bukan ke lokasi geografis yang terlihat.
 */
const GpsBadge = React.memo(function GpsBadge() {
  const { gpsValid } = useVehicleState();
  return (
    <span
      className={`flex items-center gap-1 text-[10px] font-mono ${
        gpsValid ? "text-emerald-400" : "text-amber-400"
      }`}
      title={
        gpsValid
          ? "GPS fix aktif — waypoint dikirim sebagai koordinat bumi (lat/lon)"
          : "Tanpa GPS — waypoint dikirim sebagai jarak lokal (meter)"
      }
    >
      <Satellite className="w-3 h-3" />
      {gpsValid ? "GPS" : "LOKAL"}
    </span>
  );
});

function TelemetryPanelImpl() {
  const telemetry = useTelemetry();

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {/* Altitude */}
      <div className="glass-panel p-4 rounded-xl border flex flex-col justify-between">
        <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
          <span>Altitude</span>
          <Gauge className="w-4 h-4 text-cyan-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight text-cyan-300 tabular-nums">
            {telemetry.alt.toFixed(2)}
          </span>
          <span className="text-xs text-slate-400 font-medium">m</span>
        </div>
        <div className="mt-1 flex items-center justify-between gap-2">
          <GpsBadge />
          <LatencyBadge />
        </div>
      </div>

      {/* Speed */}
      <div className="glass-panel p-4 rounded-xl border flex flex-col justify-between">
        <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
          <span>Ground Speed</span>
          <Navigation className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight text-emerald-300 tabular-nums">
            {telemetry.speed.toFixed(2)}
          </span>
          <span className="text-xs text-slate-400 font-medium">m/s</span>
        </div>
        <div className="mt-1 text-[10px] text-slate-500 tabular-nums">
          Vx: {telemetry.vx.toFixed(1)} | Vy: {telemetry.vy.toFixed(1)}
        </div>
      </div>

      {/* Battery */}
      <div
        className={`glass-panel p-4 rounded-xl border flex flex-col justify-between ${batteryTone(
          telemetry.battery
        )}`}
      >
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider opacity-90">
          <span>Battery</span>
          <Battery className="w-4 h-4" />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight tabular-nums">
            {Math.round(telemetry.battery)}
          </span>
          <span className="text-xs font-medium">%</span>
          <span className="text-xs font-normal opacity-75 ml-2 tabular-nums">
            ({telemetry.voltage.toFixed(1)}V)
          </span>
        </div>
        <div className="mt-1 text-[10px] opacity-75">LiPo 4S SITL</div>
      </div>

      {/* Heading / Attitude */}
      <div className="glass-panel p-4 rounded-xl border flex flex-col justify-between">
        <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
          <span>Heading / Yaw</span>
          <Compass className="w-4 h-4 text-amber-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight text-amber-300 tabular-nums">
            {Math.round(telemetry.heading)}°
          </span>
          <span className="text-xs text-slate-400 font-medium tabular-nums">
            (Yaw: {(telemetry.yaw * RAD_TO_DEG).toFixed(1)}°)
          </span>
        </div>
        <div className="mt-1 text-[10px] text-slate-500 tabular-nums">
          P: {(telemetry.pitch * RAD_TO_DEG).toFixed(1)}° | R:{" "}
          {(telemetry.roll * RAD_TO_DEG).toFixed(1)}°
        </div>
      </div>
    </div>
  );
}

export const TelemetryPanel = React.memo(TelemetryPanelImpl);
