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
import { telemetryStore, type TrailPoint, type Waypoint } from "@/lib/telemetryStore";
import { Cpu, Target, Trees } from "lucide-react";

const WORLD = {
  xMin: -190,
  xMax: 370,
  yMin: -220,
  yMax: 160,
};

const GAZEBO_SPAWN = { x: -65.0, y: 0.0 };

const GAZEBO_TREES = [
  { id: "pohon_sawit_01", name: "🌴 Pohon Sawit 1", x: -40.0, y: 0.0, radius: 4.0, clearance: 2.0 },
  { id: "pohon_sawit_02", name: "🌴 Pohon Sawit 2", x: -20.0, y: 0.0, radius: 4.0, clearance: 2.0 },
  { id: "pohon_sawit_03", name: "🌴 Pohon Sawit 3", x: 0.0, y: 0.0, radius: 4.0, clearance: 2.0 },
];

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
  onClearWaypoints?: () => void;
}

function GazeboMapViewImpl({
  waypoints = [],
  connected,
  onSetTargetWaypoint,
  onClearWaypoints,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const coordsRef = useRef<HTMLSpanElement | null>(null);
  const size = useCanvasSize(wrapRef);

  const targetWp = waypoints.length > 0 ? waypoints[waypoints.length - 1] : null;
  // Simpan goal & status koneksi di ref supaya loop rAF membacanya tanpa
  // perlu dipasang ulang saat props berubah.
  const goalRef = useRef<{ x: number; y: number } | null>(null);
  const connectedRef = useRef(connected);
  goalRef.current = targetWp ? { x: targetWp.x, y: targetWp.y } : null;
  connectedRef.current = connected;

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
      const hasFix = connectedRef.current && (live.x !== 0 || live.y !== 0);
      const droneX = hasFix ? live.x : GAZEBO_SPAWN.x;
      const droneY = hasFix ? live.y : GAZEBO_SPAWN.y;
      const goal = goalRef.current;

      // Dirty check: lewati frame kalau tidak ada yang berubah secara visual.
      // Saat drone hover, ini menurunkan pemakaian CPU ke ~nol.
      const key = `${droneX.toFixed(2)}|${droneY.toFixed(2)}|${live.yaw.toFixed(3)}|${
        trail.length
      }|${goal ? `${goal.x},${goal.y}` : "-"}`;
      if (key === lastKey && !firstFrame) return;
      lastKey = key;
      firstFrame = false;

      // Blit layer statis (1 operasi) alih-alih menggambar ulang dunia.
      ctx.drawImage(staticLayer, 0, 0, size.width, size.height);

      drawTrail(ctx, transform, trail);
      drawGoal(ctx, transform, goal);
      drawDrone(ctx, transform, droneX, droneY, live.yaw);

      // Update teks koordinat secara imperatif — menulis textContent jauh lebih
      // murah daripada memicu render React 20x/detik hanya untuk dua angka.
      const label = coordsRef.current;
      if (label) label.textContent = `X: ${droneX.toFixed(2)}m  |  Y: ${droneY.toFixed(2)}m`;
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
      />

      <div className="absolute bottom-4 left-4 z-10 glass-panel px-3 py-1.5 rounded-lg border border-slate-700/80 text-xs flex items-center gap-3 text-slate-300">
        <Target className="w-3.5 h-3.5 text-cyan-400" />
        <span className="font-mono" ref={coordsRef}>
          X: 0.00m | Y: 0.00m
        </span>
        <span className="text-slate-600">|</span>
        <span className="text-[10px] text-slate-400">Spawn Home: (-65.0, 0.0)</span>
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
