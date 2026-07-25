"use client";

import React, { useEffect, useRef, useState, useCallback } from "react";
import type { TelemetryData, Waypoint } from "@/lib/useRos";
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

function useCanvasSize(ref: React.RefObject<HTMLDivElement | null>) {
  const [size, setSize] = useState({ width: 800, height: 500 });
  useEffect(() => {
    if (!ref.current) return;
    const observer = new ResizeObserver(([entry]) => {
      const rect = entry.contentRect;
      setSize({
        width: Math.max(320, Math.floor(rect.width)),
        height: Math.max(350, Math.floor(rect.height)),
      });
    });
    observer.observe(ref.current);
    return () => observer.disconnect();
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
    toScreen(point: { x: number; y: number }) {
      return {
        x: offsetX + (point.x - WORLD.xMin) * scale,
        y: offsetY + (WORLD.yMax - point.y) * scale,
      };
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
  telemetry: TelemetryData;
  waypoints?: Waypoint[];
  flightPath?: { x: number; y: number }[];
  connected: boolean;
  onSetTargetWaypoint?: (wp: Waypoint | null) => void;
  onClearWaypoints?: () => void;
}

export function GazeboMapView({
  telemetry,
  waypoints = [],
  flightPath = [],
  connected,
  onSetTargetWaypoint,
  onClearWaypoints,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const size = useCanvasSize(wrapRef);

  const targetWp = waypoints.length > 0 ? waypoints[waypoints.length - 1] : null;

  // Determine drone position (default to Gazebo SITL spawn -65, 0 if 0 or disarmed)
  const currentDroneX = connected && (telemetry.x !== undefined && (telemetry.x !== 0 || telemetry.y !== 0)) ? telemetry.x : GAZEBO_SPAWN.x;
  const currentDroneY = connected && (telemetry.x !== undefined && (telemetry.x !== 0 || telemetry.y !== 0)) ? telemetry.y : GAZEBO_SPAWN.y;

  // Canvas Render Loop
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(size.width * dpr);
    canvas.height = Math.floor(size.height * dpr);
    canvas.style.width = `${size.width}px`;
    canvas.style.height = `${size.height}px`;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    let animationId: number;
    const render = () => {
      drawMap(ctx, size, {
        odom: { x: currentDroneX, y: currentDroneY, z: telemetry.z || 0 },
        yaw: telemetry.yaw || 0,
        trail: flightPath,
        goal: targetWp ? { x: targetWp.x, y: targetWp.y } : null,
      });
      animationId = requestAnimationFrame(render);
    };

    render();
    return () => cancelAnimationFrame(animationId);
  }, [size, telemetry, flightPath, targetWp, currentDroneX, currentDroneY]);

  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;

      const transform = makeTransform(size.width, size.height);
      const world = transform.toWorld({ x: px, y: py });

      const destWp: Waypoint = {
        id: 1,
        x: parseFloat(world.x.toFixed(2)),
        y: parseFloat(world.y.toFixed(2)),
        z: 8.0,
      };

      if (onSetTargetWaypoint) {
        onSetTargetWaypoint(destWp);
      }
    },
    [size, onSetTargetWaypoint]
  );

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      e.preventDefault();
      if (onClearWaypoints) {
        onClearWaypoints();
      }
    },
    [onClearWaypoints]
  );

  return (
    <div className="relative w-full h-[560px] rounded-2xl overflow-hidden glass-panel border border-slate-700/60 shadow-2xl flex flex-col bg-[#070b12]" ref={wrapRef}>
      {/* Top Map Bar */}
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

      {/* Bottom Info Bar */}
      <div className="absolute bottom-4 left-4 z-10 glass-panel px-3 py-1.5 rounded-lg border border-slate-700/80 text-xs flex items-center gap-3 text-slate-300">
        <span className="flex items-center gap-1 font-mono">
          <Target className="w-3.5 h-3.5 text-cyan-400" />
          Drone X: {currentDroneX.toFixed(2)}m
        </span>
        <span className="text-slate-600">|</span>
        <span className="flex items-center gap-1 font-mono">
          <Target className="w-3.5 h-3.5 text-emerald-400" />
          Drone Y: {currentDroneY.toFixed(2)}m
        </span>
        <span className="text-slate-600">|</span>
        <span className="text-[10px] text-slate-400">Spawn Home: (-65.0, 0.0)</span>
      </div>
    </div>
  );
}

function drawMap(
  ctx: CanvasRenderingContext2D,
  size: { width: number; height: number },
  state: {
    odom: { x: number; y: number; z: number };
    yaw: number;
    trail: { x: number; y: number }[];
    goal: { x: number; y: number } | null;
  }
) {
  const { width, height } = size;
  const transform = makeTransform(width, height);
  ctx.clearRect(0, 0, width, height);

  drawGrid(ctx, width, height, transform);
  drawFields(ctx, transform);
  drawTrees(ctx, transform);
  drawSpawnPoint(ctx, transform);
  drawTrail(ctx, transform, state.trail);
  drawGoal(ctx, transform, state.goal);
  drawDrone(ctx, transform, state.odom, state.yaw);
}

function drawGrid(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  transform: ReturnType<typeof makeTransform>
) {
  ctx.fillStyle = "#070b12";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = "rgba(255, 255, 255, 0.04)";
  ctx.lineWidth = 1;
  ctx.font = "500 10px 'Inter', sans-serif";
  ctx.fillStyle = "#475569";

  for (let x = -180; x <= 360; x += 40) {
    const a = transform.toScreen({ x, y: WORLD.yMin });
    const b = transform.toScreen({ x, y: WORLD.yMax });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.fillText(`${x}m`, b.x + 4, b.y + 14);
  }

  for (let y = -200; y <= 160; y += 40) {
    const a = transform.toScreen({ x: WORLD.xMin, y });
    const b = transform.toScreen({ x: WORLD.xMax, y });
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    ctx.fillText(`${y}m`, a.x + 4, a.y - 4);
  }
}

function drawFields(ctx: CanvasRenderingContext2D, transform: ReturnType<typeof makeTransform>) {
  FIELDS.forEach((field) => {
    const topLeft = transform.toScreen({ x: field.x, y: field.y + field.h });
    const bottomRight = transform.toScreen({ x: field.x + field.w, y: field.y });

    ctx.fillStyle = field.color;
    ctx.strokeStyle = "rgba(52, 211, 153, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.globalAlpha = 0.6;
    ctx.fillRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);
    ctx.globalAlpha = 1;
    ctx.strokeRect(topLeft.x, topLeft.y, bottomRight.x - topLeft.x, bottomRight.y - topLeft.y);

    ctx.fillStyle = "#cbd5e1";
    ctx.font = "600 11px 'Inter', sans-serif";
    ctx.fillText(field.name, topLeft.x + 10, topLeft.y + 20);
  });
}

function drawTrees(ctx: CanvasRenderingContext2D, transform: ReturnType<typeof makeTransform>) {
  GAZEBO_TREES.forEach((tree) => {
    const p = transform.toScreen(tree);
    const radius = tree.radius * transform.scale;
    const clearance = (tree.radius + tree.clearance) * transform.scale;

    // Safety Clearance Ring
    ctx.strokeStyle = "rgba(245, 158, 11, 0.4)";
    ctx.lineWidth = 1.5;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.arc(p.x, p.y, clearance, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);

    // Tree Canopy Outer Circle
    ctx.fillStyle = "rgba(16, 185, 129, 0.35)";
    ctx.strokeStyle = "#10b981";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Tree Trunk Inner Circle
    ctx.fillStyle = "#047857";
    ctx.beginPath();
    ctx.arc(p.x, p.y, radius * 0.4, 0, Math.PI * 2);
    ctx.fill();

    // Tree Label
    ctx.fillStyle = "#a7f3d0";
    ctx.font = "bold 11px 'Inter', sans-serif";
    ctx.fillText(tree.name, p.x - 30, p.y - radius - 6);
    ctx.fillStyle = "#6ee7b7";
    ctx.font = "10px 'Inter', sans-serif";
    ctx.fillText(`(${tree.x}m, ${tree.y}m)`, p.x - 22, p.y + radius + 14);
  });
}

function drawSpawnPoint(ctx: CanvasRenderingContext2D, transform: ReturnType<typeof makeTransform>) {
  const p = transform.toScreen(GAZEBO_SPAWN);
  ctx.strokeStyle = "#38bdf8";
  ctx.lineWidth = 1.5;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.arc(p.x, p.y, 10, 0, Math.PI * 2);
  ctx.stroke();
  ctx.setLineDash([]);

  ctx.fillStyle = "#38bdf8";
  ctx.font = "bold 10px 'Inter', sans-serif";
  ctx.fillText("🏠 Gazebo Spawn (-65, 0)", p.x - 55, p.y + 22);
}

function drawTrail(
  ctx: CanvasRenderingContext2D,
  transform: ReturnType<typeof makeTransform>,
  trail: { x: number; y: number }[]
) {
  if (trail.length < 2) return;
  ctx.strokeStyle = "rgba(6, 182, 212, 0.8)";
  ctx.lineWidth = 2;
  ctx.beginPath();
  trail.forEach((point, index) => {
    const p = transform.toScreen(point);
    if (index === 0) ctx.moveTo(p.x, p.y);
    else ctx.lineTo(p.x, p.y);
  });
  ctx.stroke();
}

function drawGoal(
  ctx: CanvasRenderingContext2D,
  transform: ReturnType<typeof makeTransform>,
  goal: { x: number; y: number } | null
) {
  if (!goal) return;
  const p = transform.toScreen(goal);
  ctx.strokeStyle = "#fbbf24";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(p.x - 12, p.y);
  ctx.lineTo(p.x + 12, p.y);
  ctx.moveTo(p.x, p.y - 12);
  ctx.lineTo(p.x, p.y + 12);
  ctx.stroke();
}

function drawDrone(
  ctx: CanvasRenderingContext2D,
  transform: ReturnType<typeof makeTransform>,
  odom: { x: number; y: number },
  yaw: number
) {
  if (!odom) return;
  const p = transform.toScreen(odom);
  ctx.save();
  ctx.translate(p.x, p.y);
  ctx.rotate(-yaw);

  // Drone Vector Body (Cyan Quadcopter representation)
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
