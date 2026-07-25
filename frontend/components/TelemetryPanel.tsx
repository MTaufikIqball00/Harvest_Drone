"use client";

import React from "react";
import type { TelemetryData } from "@/lib/useRos";
import { Gauge, Navigation, Battery, Compass, ShieldAlert, Cpu } from "lucide-react";

interface Props {
  telemetry: TelemetryData;
  connected: boolean;
}

export function TelemetryPanel({ telemetry, connected }: Props) {
  const getBatteryColor = (percent: number) => {
    if (percent > 60) return "text-emerald-400 border-emerald-500/30 bg-emerald-500/10";
    if (percent > 20) return "text-amber-400 border-amber-500/30 bg-amber-500/10";
    return "text-red-400 border-red-500/30 bg-red-500/10 animate-pulse";
  };

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      {/* Altitude */}
      <div className="glass-panel p-4 rounded-xl border flex flex-col justify-between">
        <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
          <span>Altitude</span>
          <Gauge className="w-4 h-4 text-cyan-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight text-cyan-300">
            {telemetry.alt !== undefined ? telemetry.alt.toFixed(2) : "0.00"}
          </span>
          <span className="text-xs text-slate-400 font-medium">m</span>
        </div>
        <div className="mt-1 text-[10px] text-slate-500">Rel. ground level</div>
      </div>

      {/* Speed */}
      <div className="glass-panel p-4 rounded-xl border flex flex-col justify-between">
        <div className="flex items-center justify-between text-slate-400 text-xs font-semibold uppercase tracking-wider">
          <span>Ground Speed</span>
          <Navigation className="w-4 h-4 text-emerald-400" />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight text-emerald-300">
            {telemetry.speed !== undefined ? telemetry.speed.toFixed(2) : "0.00"}
          </span>
          <span className="text-xs text-slate-400 font-medium">m/s</span>
        </div>
        <div className="mt-1 text-[10px] text-slate-500">
          Vx: {telemetry.vx?.toFixed(1) || 0} | Vy: {telemetry.vy?.toFixed(1) || 0}
        </div>
      </div>

      {/* Battery */}
      <div className={`glass-panel p-4 rounded-xl border flex flex-col justify-between ${getBatteryColor(telemetry.battery || 100)}`}>
        <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-wider opacity-90">
          <span>Battery</span>
          <Battery className="w-4 h-4" />
        </div>
        <div className="mt-2 flex items-baseline gap-1">
          <span className="text-2xl font-bold tracking-tight">
            {telemetry.battery !== undefined ? Math.round(telemetry.battery) : 100}
          </span>
          <span className="text-xs font-medium">%</span>
          <span className="text-xs font-normal opacity-75 ml-2">
            ({telemetry.voltage ? telemetry.voltage.toFixed(1) : "15.6"}V)
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
          <span className="text-2xl font-bold tracking-tight text-amber-300">
            {telemetry.heading !== undefined ? Math.round(telemetry.heading) : 0}°
          </span>
          <span className="text-xs text-slate-400 font-medium">
            (Yaw: {((telemetry.yaw || 0) * (180 / Math.PI)).toFixed(1)}°)
          </span>
        </div>
        <div className="mt-1 text-[10px] text-slate-500">
          P: {((telemetry.pitch || 0) * (180 / Math.PI)).toFixed(1)}° | R: {((telemetry.roll || 0) * (180 / Math.PI)).toFixed(1)}°
        </div>
      </div>
    </div>
  );
}
