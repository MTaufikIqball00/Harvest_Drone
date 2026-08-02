"use client";

/**
 * components/ObstacleAvoidanceBar.tsx
 * =============================================================================
 * Indikator penghindaran rintangan (ODI — Obstacle Density Index) realtime.
 *
 * Menyala saat drone mendekati/menghindari rintangan, menampilkan:
 *  - Jarak ke TEPI rintangan terdekat, realtime dari posisi drone (20Hz).
 *  - Rintangan MANA yang paling dekat (pohon SDF / deteksi LiDAR dinamis).
 *  - Indeks kepadatan rintangan (ODI) di radius 15m — sama seperti yang dipakai
 *    node untuk memilih A* (renggang) vs RRT* (padat).
 *
 * SUMBER DATA (agar SELALU realtime, tidak bergantung satu topik):
 *  - Pohon sawit statis: konstanta dunia (lib/gazeboWorld) — cocok dengan node.
 *    Jarak & ODI dihitung murni dari posisi drone, jadi bar hidup walau topik
 *    /dashboard/obstacles belum terbit.
 *  - Obstacle LiDAR dinamis: ditambahkan dari /dashboard/obstacles bila ada.
 *  - nearestObstacle (LiDAR sektor depan): dipakai bila lebih kecil dari jarak
 *    geometris, karena itu yang benar-benar "dilihat" sensor.
 */

import React, { useMemo } from "react";
import { useTelemetry, useObstacles } from "@/lib/useRos";
import { GAZEBO_TREES } from "@/lib/gazeboWorld";
import { ShieldCheck, ShieldAlert, Radar, Trees, Zap } from "lucide-react";

/** Radius ODI di sekitar drone (meter) — samakan dengan node (replan_from_current). */
const ODI_RADIUS_M = 15;
/** Ambang mulai dianggap "menghindar", diukur dari TEPI rintangan (meter). */
const DANGER_M = 8;
/** Ambang bahaya kritis dari tepi (meter). */
const CRITICAL_M = 3;

interface Candidate {
  label: string;
  x: number;
  y: number;
  radius: number;
}

function ObstacleAvoidanceBarImpl() {
  const { x, y, nearestObstacle, armed } = useTelemetry();
  const dynamicObstacles = useObstacles();

  // Gabungkan pohon statis (selalu ada) + obstacle LiDAR dinamis dari topik.
  const candidates = useMemo<Candidate[]>(() => {
    const trees: Candidate[] = GAZEBO_TREES.map((t) => ({
      label: t.name,
      x: t.x,
      y: t.y,
      radius: t.radius,
    }));
    const lidar: Candidate[] = dynamicObstacles
      .filter((o) => o.active && o.source === "lidar")
      .map((o) => ({ label: "⚠️ Rintangan LiDAR (dinamis)", x: o.x, y: o.y, radius: o.radius }));
    return [...trees, ...lidar];
  }, [dynamicObstacles]);

  const { nearestLabel, edgeDist, odi } = useMemo(() => {
    let best: Candidate | null = null;
    let bestEdge = Infinity;
    let count = 0;
    for (const c of candidates) {
      const center = Math.hypot(x - c.x, y - c.y);
      const edge = Math.max(0, center - c.radius);
      if (center < ODI_RADIUS_M) count += 1;
      if (edge < bestEdge) {
        bestEdge = edge;
        best = c;
      }
    }
    return {
      nearestLabel: best ? best.label : "—",
      edgeDist: Number.isFinite(bestEdge) ? bestEdge : null,
      odi: count,
    };
  }, [candidates, x, y]);

  // Jarak "hindar": ambil yang paling kecil antara jarak geometris ke tepi
  // rintangan yang diketahui dan bacaan LiDAR sektor depan (bila ada).
  const avoidDist = useMemo(() => {
    const vals: number[] = [];
    if (edgeDist !== null) vals.push(edgeDist);
    if (typeof nearestObstacle === "number") vals.push(nearestObstacle);
    return vals.length ? Math.min(...vals) : null;
  }, [edgeDist, nearestObstacle]);

  const near = avoidDist !== null && avoidDist < DANGER_M;
  // Hanya dianggap "menghindar" saat drone bersenjata/terbang — hindari alarm
  // palsu ketika parkir di darat. ODI & meter tetap tampil apa adanya.
  const avoiding = near && armed;
  const critical = avoiding && avoidDist !== null && avoidDist < CRITICAL_M;

  // Meter proximity: 0m ke tepi = penuh (bahaya), >=DANGER = kosong (aman).
  const fillPct =
    avoidDist === null ? 0 : Math.max(0, Math.min(100, (1 - avoidDist / DANGER_M) * 100));

  const tone = critical
    ? { ring: "border-red-500/60", bg: "bg-red-500/10", text: "text-red-300", bar: "bg-red-500", glow: "shadow-[0_0_16px_rgba(239,68,68,0.55)]" }
    : avoiding
      ? { ring: "border-amber-500/60", bg: "bg-amber-500/10", text: "text-amber-300", bar: "bg-amber-400", glow: "shadow-[0_0_14px_rgba(245,158,11,0.45)]" }
      : { ring: "border-emerald-600/40", bg: "bg-emerald-500/5", text: "text-emerald-300", bar: "bg-emerald-500", glow: "" };

  // Cerminkan logika switching planner node: ODI <= 2 -> A*, selain itu -> RRT*.
  const algo = odi <= 2 ? "A* (rute optimal)" : "RRT* (area padat)";

  return (
    <div
      className={`glass-panel rounded-xl border ${tone.ring} ${tone.bg} ${avoiding ? tone.glow : ""} px-4 py-3 flex flex-col gap-2.5 transition-all duration-200`}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Radar className={`w-4 h-4 ${tone.text} ${avoiding ? "animate-pulse" : ""}`} />
          <span className="text-xs font-bold uppercase tracking-wider text-slate-300">
            Obstacle Avoidance (ODI)
          </span>
        </div>
        <span
          className={`px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wider flex items-center gap-1 ${tone.bg} ${tone.text} border ${tone.ring}`}
        >
          {avoiding ? (
            <>
              <ShieldAlert className="w-3 h-3" /> {critical ? "MENGHINDAR!" : "Waspada"}
            </>
          ) : (
            <>
              <ShieldCheck className="w-3 h-3" /> Aman
            </>
          )}
        </span>
      </div>

      {/* Meter proximity realtime */}
      <div className="h-2.5 w-full rounded-full bg-slate-800/80 overflow-hidden">
        <div
          className={`h-full rounded-full ${tone.bar} transition-[width] duration-150`}
          style={{ width: `${fillPct}%` }}
        />
      </div>

      <div className="grid grid-cols-3 gap-2 text-[11px]">
        <div className="flex flex-col">
          <span className="text-slate-500">Jarak hindar</span>
          <span className={`font-mono font-bold ${tone.text}`}>
            {avoidDist === null ? "—" : `${avoidDist.toFixed(1)} m`}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-500 flex items-center gap-1">
            <Trees className="w-3 h-3" /> Rintangan
          </span>
          <span className="font-mono font-semibold text-slate-200 truncate" title={nearestLabel}>
            {near ? nearestLabel : "—"}
          </span>
        </div>
        <div className="flex flex-col">
          <span className="text-slate-500">ODI (r{ODI_RADIUS_M}m)</span>
          <span className="font-mono font-bold text-cyan-300">{odi}</span>
        </div>
      </div>

      <div className="flex items-center gap-1.5 text-[10px] text-slate-400 border-t border-slate-700/50 pt-1.5">
        <Zap className="w-3 h-3 text-cyan-400" />
        Planner: <span className="font-semibold text-slate-300">{algo}</span>
        {!armed && <span className="ml-auto text-slate-500">Aktif saat drone terbang</span>}
      </div>
    </div>
  );
}

export const ObstacleAvoidanceBar = React.memo(ObstacleAvoidanceBarImpl);
