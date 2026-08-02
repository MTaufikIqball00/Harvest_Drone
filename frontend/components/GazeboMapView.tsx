"use client";

/**
 * components/GazeboMapView.tsx
 * =============================================================================
 * Peta 2D dunia Gazebo di atas HTML5 Canvas.
 *
 * MASALAH PERFORMA VERSI LAMA
 * ---------------------------
 * 1. Efek yang memulai loop requestAnimationFrame memiliki dependency
 *    `[size, telemetry, flightPath, targetWp, ...]`. Karena `telemetry` adalah
 *    objek baru pada setiap pesan, efek itu di-teardown & di-setup ulang
 *    puluhan kali per detik. Setiap setup menulis `canvas.width = ...` yang
 *    MENGALOKASIKAN ULANG backing store canvas dan menghapus isinya —
 *    penyebab utama frame drop dan kedipan.
 * 2. `drawMap()` menggambar ULANG seluruh dunia statis (grid, 4 petak sawah,
 *    3 pohon, label teks) pada SETIAP frame 60fps, padahal semuanya tidak
 *    pernah berubah. Menggambar teks adalah operasi canvas paling mahal.
 *
 * PENDEKATAN SEKARANG
 * -------------------
 * - Layer statis dirender SEKALI ke offscreen canvas, lalu tiap frame cukup
 *   satu `drawImage()` (blit) — praktis gratis.
 * - Layer dinamis (drone, trail, goal) digambar dari `telemetryStore.live`
 *   secara imperatif; komponen ini TIDAK menerima telemetry sebagai prop dan
 *   karenanya tidak pernah render ulang karena telemetry.
 * - Loop rAF dipasang satu kali dan melewatkan frame jika tidak ada perubahan
 *   (dirty check), jadi saat drone diam CPU/GPU benar-benar idle.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  telemetryStore,
  type PlannedPathPoint,
  type TrailPoint,
  type Waypoint,
} from "@/lib/telemetryStore";
import { Cpu, Target, Trees, Navigation, Crosshair } from "lucide-react";
import { GAZEBO_SPAWN, GAZEBO_TREES } from "@/lib/gazeboWorld";
import { distanceToTarget, formatDistance } from "@/lib/geo";

const WORLD = {
  xMin: -190,
  xMax: 370,
  yMin: -220,
  yMax: 160,
};

const FIELDS = [
  { name: "🌾 Sawah Kiri (Plot A)", x: -175, y: -145, w: 220, h: 290, color: "#163f29" },
  { name: "🌾 Sawah Kanan Atas (Plot B)", x: 45, y: -87.5, w: 280, h: 175, color: "#1b4d2e" },
  { name: "🌾 Sawah Tengah Bawah (Plot C)", x: 45, y: -201.5, w: 170, h: 115, color: "#19442b" },
  { name: "🌴 Kebun / Sawah Biru (Plot D)", x: 215, y: -201.5, w: 140, h: 115, color: "#16354d" },
];

type Transform = ReturnType<typeof makeTransform>;

function useCanvasSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 800, height: 500 });
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    // ResizeObserver di-throttle lewat rAF: saat pengguna menyeret jendela,
    // observer bisa memancarkan puluhan event per detik dan tiap setSize
    // memaksa realokasi canvas.
    let frame: number | null = null;
    const observer = new ResizeObserver(([entry]) => {
      if (frame !== null) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        const rect = entry.contentRect;
        const next = {
          width: Math.max(320, Math.floor(rect.width)),
          height: Math.max(350, Math.floor(rect.height)),
        };
        setSize((prev) =>
          prev.width === next.width && prev.height === next.height ? prev : next
        );
      });
    });
    observer.observe(element);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [ref]);
  return size;
}

function makeTransform(width: number, height: number) {
  const pad = 35;
  const sx = (width - pad * 2) / (WORLD.xMax - WORLD.xMin);
  const sy = (height - pad * 2) / (WORLD.yMax - WORLD.yMin);
  const scale = Math.min(sx, sy);
  const offsetX = (width - (WORLD.xMax - WORLD.xMin) * scale) * 0.5;
  const offsetY = (height - (WORLD.yMax - WORLD.yMin) * scale) * 0.5;

  return {
    toScreenX(x: number) {
      return offsetX + (x - WORLD.xMin) * scale;
    },
    toScreenY(y: number) {
      return offsetY + (WORLD.yMax - y) * scale;
    },
    toWorld(point: { x: number; y: number }) {
      return {
        x: WORLD.xMin + (point.x - offsetX) / scale,
        y: WORLD.yMax - (point.y - offsetY) / scale,
        z: 0,
      };
    },
    scale,
  };
}

interface Props {
  waypoints?: Waypoint[];
  connected: boolean;
  onSetTargetWaypoint?: (wp: Waypoint | null) => void;
  onSendGoal?: (wp: Waypoint) => void;
  onClearWaypoints?: () => void;
}

function GazeboMapViewImpl({
  waypoints = [],
  connected,
  onSetTargetWaypoint,
  onSendGoal,
  onClearWaypoints,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coordsRef = useRef<HTMLSpanElement | null>(null);
  // Label jarak diperbarui secara IMPERATIF dari loop rAF (sama seperti label
  // koordinat): drone bergerak 20Hz, dan me-render ulang React setiap kali
  // hanya untuk satu angka adalah pemborosan yang sudah dihindari di sini.
  const chipDistanceRef = useRef<HTMLSpanElement | null>(null);
  const tooltipRef = useRef<HTMLDivElement | null>(null);
  const tooltipDistanceRef = useRef<HTMLSpanElement | null>(null);
  const size = useCanvasSize(wrapRef);

  const targetWp = waypoints.length > 0 ? waypoints[waypoints.length - 1] : null;
  // Simpan goal & status koneksi di ref supaya loop rAF membacanya tanpa
  // perlu dipasang ulang saat props berubah.
  const goalRef = useRef<{ x: number; y: number; z: number } | null>(null);
  const connectedRef = useRef(connected);
  goalRef.current = targetWp ? { x: targetWp.x, y: targetWp.y, z: targetWp.z } : null;
  // Garis rute hanya digambar setelah perintah benar-benar dikirim ("Send
  // Goal") dan tidak ditolak — bukan saat marker baru dipasang.
  const routeActiveRef = useRef(false);
  routeActiveRef.current = Boolean(targetWp?.sent && !targetWp.rejected);
  connectedRef.current = connected;

  /** true selama kursor berada di atas marker goal kuning. */
  const [goalHovered, setGoalHovered] = useState(false);
  const goalHoveredRef = useRef(false);
  goalHoveredRef.current = goalHovered;

  // ---------------------------------------------------------------------------
  // Layer statis: dirender sekali per perubahan ukuran
  // ---------------------------------------------------------------------------
  const staticLayer = useMemo(() => {
    if (typeof document === "undefined") return null;
    const dpr = typeof window !== "undefined" ? window.devicePixelRatio || 1 : 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const transform = makeTransform(size.width, size.height);
    drawBackdrop(ctx, size.width, size.height);
    drawGrid(ctx, transform);
    drawFields(ctx, transform);
    drawTrees(ctx, transform);
    drawSpawnPoint(ctx, transform);
    return canvas;
  }, [size.width, size.height]);

  // ---------------------------------------------------------------------------
  // Loop render: dipasang SEKALI per perubahan ukuran
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !staticLayer) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext("2d", { alpha: false });
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const transform = makeTransform(size.width, size.height);
    let animationId = 0;
    let lastKey = "";
    let firstFrame = true;

    const render = () => {
      animationId = requestAnimationFrame(render);

      const live = telemetryStore.live;
      const trail = telemetryStore.getLiveTrail();
      const plannedPath = telemetryStore.getPlannedPathSnapshot();
      const hasFix = connectedRef.current && (live.x !== 0 || live.y !== 0);
      const droneX = hasFix ? live.x : GAZEBO_SPAWN.x;
      const droneY = hasFix ? live.y : GAZEBO_SPAWN.y;
      const goal = goalRef.current;

      // Dirty check: lewati frame kalau tidak ada yang berubah secara visual.
      // Saat drone hover, ini menurunkan pemakaian CPU ke ~nol.
      // `goalHoveredRef` ikut masuk key: saat tooltip baru muncul, frame WAJIB
      // dirender sekali supaya label jaraknya langsung terisi, bukan kosong
      // sampai drone kebetulan bergerak.
      const key = `${droneX.toFixed(2)}|${droneY.toFixed(2)}|${live.yaw.toFixed(3)}|${
        trail.length
      }|${goal ? `${goal.x},${goal.y}` : "-"}|p${plannedPath.length}${
        plannedPath.length > 0
          ? `:${plannedPath[0].x},${plannedPath[0].y}`
          : ""
      }|h${goalHoveredRef.current ? 1 : 0}|r${routeActiveRef.current ? 1 : 0}`;
      if (key === lastKey && !firstFrame) return;
      lastKey = key;
      firstFrame = false;

      // Blit layer statis (1 operasi) alih-alih menggambar ulang dunia.
      ctx.drawImage(staticLayer, 0, 0, size.width, size.height);

      // Rute survei terencana digambar PALING BAWAH supaya trail aktual & drone
      // tetap terlihat di atasnya saat drone mulai menyusuri jalur.
      drawPlannedPath(ctx, transform, plannedPath);
      drawTrail(ctx, transform, trail);
      if (goal && routeActiveRef.current) {
        drawRouteLine(ctx, transform, droneX, droneY, goal);
      }
      drawGoal(ctx, transform, goal);
      drawDrone(ctx, transform, droneX, droneY, live.yaw);

      // Update teks koordinat secara imperatif — menulis textContent jauh lebih
      // murah daripada memicu render React 20x/detik hanya untuk dua angka.
      const label = coordsRef.current;
      if (label) label.textContent = `X: ${droneX.toFixed(2)}m  |  Y: ${droneY.toFixed(2)}m`;

      // Jarak drone -> waypoint kuning, SELALU meter. Ikut jalur imperatif yang
      // sama supaya angka tetap live tanpa render ulang React.
      if (goal) {
        const d = distanceToTarget(
          { x: droneX, y: droneY, z: live.z, lat: live.lat, lon: live.lon, gpsValid: live.gpsValid },
          goal
        );
        const text = formatDistance(d.horizontalM);
        if (chipDistanceRef.current) chipDistanceRef.current.textContent = text;
        if (tooltipDistanceRef.current) tooltipDistanceRef.current.textContent = text;
      }
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [size.width, size.height, staticLayer]);

  // ---------------------------------------------------------------------------
  // Interaksi
  // ---------------------------------------------------------------------------
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const transform = makeTransform(size.width, size.height);
      const world = transform.toWorld({ x: e.clientX - rect.left, y: e.clientY - rect.top });

      onSetTargetWaypoint?.({
        id: 1,
        x: parseFloat(world.x.toFixed(2)),
        y: parseFloat(world.y.toFixed(2)),
        z: 8.0,
      });
    },
    [size.width, size.height, onSetTargetWaypoint]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      onClearWaypoints?.();
    },
    [onClearWaypoints]
  );

  /** Radius (piksel) di sekitar marker goal yang dianggap "hover". */
  const GOAL_HIT_RADIUS_PX = 16;

  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const goal = goalRef.current;
      if (!goal) {
        if (goalHoveredRef.current) setGoalHovered(false);
        return;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;

      const transform = makeTransform(size.width, size.height);
      const gx = transform.toScreenX(goal.x);
      const gy = transform.toScreenY(goal.y);
      const over = Math.hypot(mx - gx, my - gy) <= GOAL_HIT_RADIUS_PX;

      // Posisi tooltip ditulis langsung ke style — mousemove terlalu sering
      // untuk dijadikan state React.
      if (over && tooltipRef.current) {
        tooltipRef.current.style.left = `${gx}px`;
        tooltipRef.current.style.top = `${gy - 14}px`;
      }
      if (over !== goalHoveredRef.current) setGoalHovered(over);
    },
    [size.width, size.height]
  );

  const handleMouseLeave = useCallback(() => {
    if (goalHoveredRef.current) setGoalHovered(false);
  }, []);

  return (
    <div
      className="relative w-full h-[560px] rounded-2xl overflow-hidden glass-panel border border-slate-700/60 shadow-2xl flex flex-col bg-[#070b12]"
      ref={wrapRef}
    >
      <div className="absolute top-4 left-4 right-4 z-10 flex items-center justify-between pointer-events-none">
        <div className="glass-panel px-3 py-1.5 rounded-xl border border-slate-700/80 text-xs flex items-center gap-2 text-slate-200 pointer-events-auto">
          <Cpu className="w-4 h-4 text-cyan-400" />
          <span className="font-semibold text-white">Gazebo World 1:1 2D Simulation Map</span>
        </div>

        <div className="glass-panel px-3 py-1.5 rounded-xl border border-slate-700/80 text-xs flex items-center gap-2 text-slate-300 pointer-events-auto">
          <Trees className="w-4 h-4 text-emerald-400" />
          <span className="font-medium text-emerald-300">3 Pohon Sawit (SDF 1:1)</span>
        </div>
      </div>

      <canvas
        className="w-full h-full cursor-crosshair"
        ref={canvasRef}
        onClick={handleClick}
        onDoubleClick={handleDoubleClick}
        onMouseMove={handleMouseMove}
        onMouseLeave={handleMouseLeave}
      />

      {/* Tooltip hover marker goal kuning: jarak drone -> waypoint (meter). */}
      {targetWp && goalHovered && (
        <div
          ref={tooltipRef}
          className="absolute z-20 -translate-x-1/2 -translate-y-full pointer-events-none glass-panel px-2.5 py-1.5 rounded-lg border border-amber-400/70 bg-slate-900/95 shadow-xl whitespace-nowrap"
        >
          <div className="flex items-center gap-1.5 text-[11px] font-bold text-amber-300">
            <Crosshair className="w-3 h-3" />
            Jarak ke waypoint
          </div>
          <div className="font-mono text-sm font-bold text-white leading-tight">
            <span ref={tooltipDistanceRef}>-</span>
          </div>
          <div className="font-mono text-[10px] text-slate-400">
            ({targetWp.x.toFixed(1)}, {targetWp.y.toFixed(1)}) • alt {targetWp.z.toFixed(1)} m
          </div>
        </div>
      )}

      <div className="absolute bottom-4 left-4 z-10 glass-panel px-3 py-1.5 rounded-lg border border-slate-700/80 text-xs flex items-center gap-3 text-slate-300">
        <Target className="w-3.5 h-3.5 text-cyan-400" />
        <span className="font-mono" ref={coordsRef}>
          X: 0.00m | Y: 0.00m
        </span>
        <span className="text-slate-600">|</span>
        <span className="text-[10px] text-slate-400">Spawn Home: (-65.0, 0.0)</span>
      </div>

      {/* Target + Send Goal: kirim marker kuning ke planner A* penghindar rintangan. */}
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-2">
        {targetWp && (
          <div className="glass-panel px-3 py-1.5 rounded-lg border border-amber-500/50 bg-amber-500/10 text-xs flex items-center gap-2 text-amber-200">
            <Crosshair className="w-3.5 h-3.5" />
            <span className="font-mono">
              Goal: {targetWp.x.toFixed(1)}, {targetWp.y.toFixed(1)}
            </span>
            <span className="text-amber-500/50">|</span>
            <span className="font-mono font-bold text-amber-100">
              <span ref={chipDistanceRef}>-</span>
            </span>
          </div>
        )}
        <button
          onClick={() => targetWp && onSendGoal?.(targetWp)}
          disabled={!connected || !targetWp}
          className="flex items-center gap-2 px-3.5 py-1.5 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 disabled:cursor-not-allowed text-white font-bold text-xs shadow-lg transition-all border border-cyan-400/30"
        >
          <Navigation className="w-4 h-4" /> Send Goal
        </button>
      </div>
    </div>
  );
}

/**
 * Dibungkus React.memo: props-nya hanya berubah saat waypoint atau status
 * koneksi berubah — bukan pada setiap tick telemetry.
 */
export const GazeboMapView = React.memo(GazeboMapViewImpl);

// =============================================================================
// PRIMITIF GAMBAR
// =============================================================================
function drawBackdrop(ctx: CanvasRenderingContext2D, width: number, height: number) {
  ctx.fillStyle = "#070b12";
  ctx.fillRect(0, 0, width, height);
}

function drawGrid(ctx: CanvasRenderingContext2D, transform: Transform) {
  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  ctx.font = "500 10px 'Inter', sans-serif";

  const yTop = transform.toScreenY(WORLD.yMax);
  const yBottom = transform.toScreenY(WORLD.yMin);
  const xLeft = transform.toScreenX(WORLD.xMin);
  const xRight = transform.toScreenX(WORLD.xMax);

  // Semua garis dalam SATU path lalu satu stroke() — jauh lebih murah daripada
  // beginPath/stroke per garis.
  ctx.beginPath();
  for (let x = -180; x <= 360; x += 40) {
    const sx = transform.toScreenX(x);
    ctx.moveTo(sx, yBottom);
    ctx.lineTo(sx, yTop);
  }
  for (let y = -200; y <= 160; y += 40) {
    const sy = transform.toScreenY(y);
    ctx.moveTo(xLeft, sy);
    ctx.lineTo(xRight, sy);
  }
  ctx.stroke();

  ctx.fillStyle = "#475569";
  for (let x = -180; x <= 360; x += 40) {
    ctx.fillText(`${x}m`, transform.toScreenX(x) + 4, yTop + 14);
  }
  for (let y = -200; y <= 160; y += 40) {
    ctx.fillText(`${y}m`, xLeft + 4, transform.toScreenY(y) - 4);
  }
}

function drawFields(ctx: CanvasRenderingContext2D, transform: Transform) {
  FIELDS.forEach((field) => {
    const left = transform.toScreenX(field.x);
    const top = transform.toScreenY(field.y + field.h);
    const right = transform.toScreenX(field.x + field.w);
    const bottom = transform.toScreenY(field.y);

    ctx.fillStyle = field.color;
    ctx.strokeStyle = "rgba(52, 211, 153, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(left, top, right - left, bottom - top);
    ctx.globalAlpha = 1;
    ctx.strokeRect(left, top, right - left, bottom - top);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "600 11px 'Inter', sans-serif";
    ctx.fillText(field.name, left + 10, top + 20);
  });
}

function drawTrees(ctx: CanvasRenderingContext2D, transform: Transform) {
  GAZEBO_TREES.forEach((tree) => {
    const px = transform.toScreenX(tree.x);
    const py = transform.toScreenY(tree.y);
    const radius = tree.radius * transform.scale;
    const clearance = (tree.radius + tree.clearance) * transform.scale;

    ctx.strokeStyle = "rgba(245, 158, 11, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(px, py, clearance, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    ctx.fillStyle = "rgba(16, 185, 129, 0.35)";
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(px, py, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    ctx.fillStyle = "#047857";
    ctx.beginPath();
    ctx.arc(px, py, radius * 0.4, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "#a7f3d0";
    ctx.font = "bold 11px 'Inter', sans-serif";
    ctx.fillText(tree.name, px - 30, py - radius - 6);
    ctx.fillStyle = "#6ee7b7";
    ctx.font = "10px 'Inter', sans-serif";
    ctx.fillText(`(${tree.x}m, ${tree.y}m)`, px - 22, py + radius + 14);
  });
}

function drawSpawnPoint(ctx: CanvasRenderingContext2D, transform: Transform) {
  const px = transform.toScreenX(GAZEBO_SPAWN.x);
  const py = transform.toScreenY(GAZEBO_SPAWN.y);

  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(px, py, 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 10px 'Inter', sans-serif";
  ctx.fillText("🏠 Gazebo Spawn (-65, 0)", px - 55, py + 22);
}

function drawPlannedPath(
  ctx: CanvasRenderingContext2D,
  transform: Transform,
  path: PlannedPathPoint[]
) {
  if (path.length < 2) return;

  // Garis putus-putus rute survei (boustrophedon / A*).
  ctx.strokeStyle = "rgba(56, 189, 248, 0.85)";
  ctx.lineWidth = 2;
  ctx.setLineDash([8, 6]);
  ctx.beginPath();
  ctx.moveTo(transform.toScreenX(path[0].x), transform.toScreenY(path[0].y));
  for (let i = 1; i < path.length; i++) {
    ctx.lineTo(transform.toScreenX(path[i].x), transform.toScreenY(path[i].y));
  }
  ctx.stroke();
  ctx.setLineDash([]);

  // Titik belok waypoint supaya pola lawnmower terbaca jelas.
  ctx.fillStyle = "#38bdf8";
  for (let i = 0; i < path.length; i++) {
    ctx.beginPath();
    ctx.arc(transform.toScreenX(path[i].x), transform.toScreenY(path[i].y), 2.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Tandai titik START (hijau) & END (merah) rute.
  const first = path[0];
  const last = path[path.length - 1];
  ctx.fillStyle = "#34d399";
  ctx.beginPath();
  ctx.arc(transform.toScreenX(first.x), transform.toScreenY(first.y), 4.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#f87171";
  ctx.beginPath();
  ctx.arc(transform.toScreenX(last.x), transform.toScreenY(last.y), 4.5, 0, Math.PI * 2);
  ctx.fill();
}

function drawTrail(ctx: CanvasRenderingContext2D, transform: Transform, trail: TrailPoint[]) {
  if (trail.length < 2) return;
  ctx.strokeStyle = "rgba(6, 182, 212, 0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(transform.toScreenX(trail[0].x), transform.toScreenY(trail[0].y));
  for (let i = 1; i < trail.length; i++) {
    ctx.lineTo(transform.toScreenX(trail[i].x), transform.toScreenY(trail[i].y));
  }
  ctx.stroke();
}

/**
 * Garis putus-putus drone -> tujuan, menandakan drone sedang menuju ke sana.
 *
 * Digambar SEBELUM marker goal & ikon drone supaya kedua ujungnya tertutup
 * rapi oleh simbol, bukan menimpanya.
 */
function drawRouteLine(
  ctx: CanvasRenderingContext2D,
  transform: Transform,
  droneX: number,
  droneY: number,
  goal: { x: number; y: number }
) {
  ctx.save();
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 2;
  ctx.globalAlpha = 0.9;
  ctx.setLineDash([8, 8]);
  ctx.beginPath();
  ctx.moveTo(transform.toScreenX(droneX), transform.toScreenY(droneY));
  ctx.lineTo(transform.toScreenX(goal.x), transform.toScreenY(goal.y));
  ctx.stroke();
  // setLineDash bersifat lengket pada context; restore() mengembalikannya
  // supaya elemen berikutnya tidak ikut tergambar putus-putus.
  ctx.restore();
}

function drawGoal(
  ctx: CanvasRenderingContext2D,
  transform: Transform,
  goal: { x: number; y: number } | null
) {
  if (!goal) return;
  const px = transform.toScreenX(goal.x);
  const py = transform.toScreenY(goal.y);

  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(px, py, 8, 0, Math.PI * 2);
  ctx.moveTo(px - 12, py);
  ctx.lineTo(px + 12, py);
  ctx.moveTo(px, py - 12);
  ctx.lineTo(px, py + 12);
  ctx.stroke();
}

function drawDrone(
  ctx: CanvasRenderingContext2D,
  transform: Transform,
  x: number,
  y: number,
  yaw: number
) {
  ctx.save();
  ctx.translate(transform.toScreenX(x), transform.toScreenY(y));
  ctx.rotate(-yaw);

  ctx.fillStyle = "#ffffff";
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.moveTo(16, 0);
  ctx.lineTo(-10, -10);
  ctx.lineTo(-6, 0);
  ctx.lineTo(-10, 10);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}
