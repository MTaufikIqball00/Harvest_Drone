"use client";

import React, { useState, useEffect } from "react";
import type { TelemetryData, Waypoint } from "@/lib/useRos";
import { 
  Power, 
  PlaneTakeoff, 
  PlaneLanding, 
  Home, 
  Navigation, 
  ShieldAlert, 
  Zap, 
  MapPin, 
  Radio, 
  Timer, 
  Crosshair, 
  ArrowUp, 
  ArrowDown, 
  ArrowLeft, 
  ArrowRight, 
  RotateCcw, 
  RotateCw
} from "lucide-react";

interface Props {
  telemetry: TelemetryData;
  waypoints?: Waypoint[];
  connected: boolean;
  onArm: () => void;
  onDisarm: () => void;
  onTakeoff: (alt: number) => void;
  onLand: () => void;
  onRth: () => void;
  onSetFlightMode: (mode: string) => void;
  onSendWaypoints: (wps: Waypoint[]) => void;
  onSendCommand?: (command: string, params?: any) => void;
  onClearWaypoints?: () => void;
}

export function DroneController({
  telemetry,
  waypoints = [],
  connected,
  onArm,
  onDisarm,
  onTakeoff,
  onLand,
  onRth,
  onSetFlightMode,
  onSendWaypoints,
  onSendCommand,
  onClearWaypoints,
}: Props) {
  const [takeoffAlt, setTakeoffAlt] = useState<number>(8.0);
  const [targetX, setTargetX] = useState<string>("20.0");
  const [targetY, setTargetY] = useState<string>("15.0");
  const [targetZ, setTargetZ] = useState<string>("8.0");
  
  // Timers for Flight Time
  const [manualFlightTime, setManualFlightTime] = useState<number>(0);
  const [autoFlightTime, setAutoFlightTime] = useState<number>(0);
  
  // Track Active Controls
  const [activeKey, setActiveKey] = useState<string>("IDLE");

  // Sync clicked map waypoint to input fields
  useEffect(() => {
    if (waypoints && waypoints.length > 0) {
      const lastWp = waypoints[waypoints.length - 1];
      setTargetX(String(lastWp.x));
      setTargetY(String(lastWp.y));
      if (lastWp.z) setTargetZ(String(lastWp.z));
    }
  }, [waypoints]);

  // Flight Timer Effect
  useEffect(() => {
    if (!telemetry.armed) return;
    const interval = setInterval(() => {
      if (telemetry.flightMode === "MANUAL" || telemetry.flightMode === "STABILIZED") {
        setManualFlightTime((prev) => prev + 1);
      } else {
        setAutoFlightTime((prev) => prev + 1);
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [telemetry.armed, telemetry.flightMode]);

  const formatTimer = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, "0")}:${secs.toString().padStart(2, "0")}`;
  };

  // Keyboard Remote Listener (WASD + Q/E + R/F)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (["INPUT", "TEXTAREA"].includes((e.target as HTMLElement)?.tagName)) return;
      const key = e.key.toLowerCase();
      if (["w", "a", "s", "d", "q", "e", "r", "f"].includes(key)) {
        e.preventDefault();
        setActiveKey(key.toUpperCase());
        if (onSendCommand) {
          onSendCommand("MANUAL_VELOCITY", { key });
        }
      }
    };
    const handleKeyUp = () => {
      setActiveKey("IDLE");
    };
    window.addEventListener("keydown", handleKeyDown);
    window.addEventListener("keyup", handleKeyUp);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("keyup", handleKeyUp);
    };
  }, [onSendCommand]);

  // Handlers for specific drone actions
  const handleForceArmTakeoff = () => {
    if (onSendCommand) {
      onSendCommand("FORCE_ARM_TAKEOFF", { altitude: takeoffAlt });
    } else {
      onArm();
      setTimeout(() => onTakeoff(takeoffAlt), 1000);
    }
  };

  const handleStartAutoSurvey = () => {
    const boustrophedonPattern: Waypoint[] = [
      { id: 1, x: telemetry.x || 0, y: telemetry.y || 0, z: takeoffAlt },
      { id: 2, x: (telemetry.x || 0) + 30, y: telemetry.y || 0, z: takeoffAlt },
      { id: 3, x: (telemetry.x || 0) + 30, y: (telemetry.y || 0) + 10, z: takeoffAlt },
      { id: 4, x: telemetry.x || 0, y: (telemetry.y || 0) + 10, z: takeoffAlt },
      { id: 5, x: telemetry.x || 0, y: (telemetry.y || 0) + 20, z: takeoffAlt },
      { id: 6, x: (telemetry.x || 0) + 30, y: (telemetry.y || 0) + 20, z: takeoffAlt },
    ];
    onSendWaypoints(boustrophedonPattern);
    onSetFlightMode("AUTO.MISSION");
  };

  const handleSendPointToPointMission = () => {
    const startX = telemetry.x || 0;
    const startY = telemetry.y || 0;
    const destX = parseFloat(targetX) || 0;
    const destY = parseFloat(targetY) || 0;
    const destZ = parseFloat(targetZ) || takeoffAlt;

    const missionWaypoints: Waypoint[] = [
      { id: 1, x: startX, y: startY, z: destZ },
      { id: 2, x: destX, y: destY, z: destZ },
    ];
    onSendWaypoints(missionWaypoints);
    onSetFlightMode("OFFBOARD");
  };

  const sendManualVector = (vx: number, vy: number, vz: number, yawRate: number) => {
    if (onSendCommand) {
      onSendCommand("SET_VELOCITY", { vx, vy, vz, yawRate });
    }
  };

  return (
    <div className="glass-panel p-5 rounded-2xl border border-slate-700/60 shadow-xl flex flex-col gap-5 text-slate-200">
      {/* Header Status */}
      <div className="flex items-center justify-between border-b border-slate-700/50 pb-3">
        <div className="flex items-center gap-2.5">
          <Radio className="w-5 h-5 text-cyan-400 animate-pulse" />
          <h3 className="font-bold text-slate-100 tracking-wide text-base">Drone Flight Command Center</h3>
        </div>
        <div className="flex items-center gap-2">
          <span
            className={`px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider ${
              telemetry.armed
                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/40 shadow-sm shadow-emerald-500/20"
                : "bg-slate-700/60 text-slate-400 border border-slate-600"
            }`}
          >
            {telemetry.armed ? "● ARMED" : "○ DISARMED"}
          </span>
        </div>
      </div>

      {/* Flight Timers & Mode Bar */}
      <div className="grid grid-cols-2 gap-3 bg-slate-900/60 p-3 rounded-xl border border-slate-800">
        <div className="flex items-center justify-between px-2">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4 text-amber-400" />
            <span className="text-xs text-slate-400 font-medium">Manual Flight</span>
          </div>
          <span className="text-sm font-mono font-bold text-amber-300">{formatTimer(manualFlightTime)}</span>
        </div>
        <div className="flex items-center justify-between px-2 border-l border-slate-800">
          <div className="flex items-center gap-2">
            <Timer className="w-4 h-4 text-cyan-400" />
            <span className="text-xs text-slate-400 font-medium">Auto Mission</span>
          </div>
          <span className="text-sm font-mono font-bold text-cyan-300">{formatTimer(autoFlightTime)}</span>
        </div>
      </div>

      {/* Primary Flight Controls */}
      <div className="flex flex-col gap-2.5">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Main Flight Controls</span>
        
        <div className="grid grid-cols-2 gap-2.5">
          <button
            onClick={onArm}
            disabled={!connected || telemetry.armed}
            className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-semibold transition-all shadow-md shadow-emerald-950/40 text-xs"
          >
            <Power className="w-4 h-4" /> ARM MOTORS
          </button>

          <button
            onClick={onDisarm}
            disabled={!connected}
            className="flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-red-600/90 hover:bg-red-500 disabled:opacity-40 text-white font-semibold transition-all shadow-md shadow-red-950/40 text-xs"
          >
            <ShieldAlert className="w-4 h-4" /> DISARM / STOP
          </button>
        </div>

        {/* Quick Altitude & Action Buttons */}
        <div className="grid grid-cols-3 gap-2">
          <button
            onClick={() => onTakeoff(takeoffAlt)}
            disabled={!connected || !telemetry.armed}
            className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-cyan-600 hover:bg-cyan-500 disabled:opacity-40 text-white font-medium text-xs transition-all"
          >
            <PlaneTakeoff className="w-4 h-4" /> Takeoff ({takeoffAlt}m)
          </button>

          <button
            onClick={onLand}
            disabled={!connected}
            className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-amber-600 hover:bg-amber-500 disabled:opacity-40 text-white font-medium text-xs transition-all"
          >
            <PlaneLanding className="w-4 h-4" /> Land
          </button>

          <button
            onClick={onRth}
            disabled={!connected}
            className="flex items-center justify-center gap-1.5 py-2 px-3 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-40 text-white font-medium text-xs transition-all"
          >
            <Home className="w-4 h-4" /> Return Home
          </button>
        </div>

        {/* Force Arm & Takeoff + Auto Survey Boustrophedon */}
        <div className="grid grid-cols-2 gap-2 mt-1">
          <button
            onClick={handleForceArmTakeoff}
            disabled={!connected}
            className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 text-white font-bold text-xs shadow-lg shadow-purple-950/50 transition-all border border-purple-400/30"
          >
            <Zap className="w-4 h-4 text-yellow-300 fill-yellow-300" /> Force Arm & Takeoff
          </button>

          <button
            onClick={handleStartAutoSurvey}
            disabled={!connected}
            className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl bg-gradient-to-r from-cyan-600 to-blue-600 hover:from-cyan-500 hover:to-blue-500 text-white font-bold text-xs shadow-lg shadow-cyan-950/50 transition-all border border-cyan-400/30"
          >
            <Navigation className="w-4 h-4 text-cyan-200" /> Auto Survey (Boustrophedon)
          </button>
        </div>
      </div>

      {/* Remote Manual Control (Joystick Pad & Keypad) */}
      <div className="pt-3 border-t border-slate-700/50 flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <span className="text-xs font-bold uppercase tracking-wider text-slate-400">Remote Manual Pilot (Keyboard / Touch)</span>
          <span className="text-[10px] bg-slate-800 px-2 py-0.5 rounded text-cyan-400 font-mono">KEY: {activeKey}</span>
        </div>

        <div className="grid grid-cols-3 gap-2 bg-slate-900/80 p-3 rounded-xl border border-slate-800">
          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(0, 0, 0, -0.5)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <RotateCcw className="w-3.5 h-3.5 mr-1 text-amber-400" /> Yaw L [Q]
          </button>

          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(1, 0, 0, 0)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <ArrowUp className="w-3.5 h-3.5 mr-1 text-emerald-400" /> Fwd [W]
          </button>

          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(0, 0, 0, 0.5)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <RotateCw className="w-3.5 h-3.5 mr-1 text-amber-400" /> Yaw R [E]
          </button>

          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(0, -1, 0, 0)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <ArrowLeft className="w-3.5 h-3.5 mr-1 text-cyan-400" /> Left [A]
          </button>

          <button
            disabled={!connected}
            onClick={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-red-900/60 hover:bg-red-800 text-red-200 font-bold text-xs border border-red-700/60"
          >
            STOP [S]
          </button>

          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(0, 1, 0, 0)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <ArrowRight className="w-3.5 h-3.5 mr-1 text-cyan-400" /> Right [D]
          </button>

          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(0, 0, -0.5, 0)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <ArrowDown className="w-3.5 h-3.5 mr-1 text-indigo-400" /> Down [F]
          </button>

          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(-1, 0, 0, 0)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <ArrowDown className="w-3.5 h-3.5 mr-1 text-emerald-400" /> Back [S]
          </button>

          <button
            disabled={!connected}
            onMouseDown={() => sendManualVector(0, 0, 0.5, 0)}
            onMouseUp={() => sendManualVector(0, 0, 0, 0)}
            className="flex items-center justify-center p-2 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-medium border border-slate-700"
          >
            <ArrowUp className="w-3.5 h-3.5 mr-1 text-indigo-400" /> Up [R]
          </button>
        </div>
      </div>

      {/* Point-to-Point Waypoint Target (Drone Position X -> Target Y) */}
      <div className="pt-3 border-t border-slate-700/50 flex flex-col gap-3">
        <span className="text-xs font-bold uppercase tracking-wider text-slate-400">
          Point-to-Point Mission Target
        </span>

        {/* Automatic Start Position (Realtime Drone Coordinates) */}
        <div className="bg-slate-900/60 p-3 rounded-xl border border-slate-800 flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-xs text-emerald-400 font-semibold">
            <MapPin className="w-3.5 h-3.5" /> Start Position (X: Automatic Drone Realtime)
          </div>
          <div className="grid grid-cols-3 gap-2 text-xs font-mono text-slate-300 bg-slate-950/80 p-2 rounded border border-slate-800/80">
            <div>X: <span className="text-cyan-300 font-bold">{telemetry.x?.toFixed(2) || "0.00"}</span></div>
            <div>Y: <span className="text-cyan-300 font-bold">{telemetry.y?.toFixed(2) || "0.00"}</span></div>
            <div>Z: <span className="text-cyan-300 font-bold">{telemetry.alt?.toFixed(2) || "0.00"}m</span></div>
          </div>
        </div>

        {/* Target Position (Y Destination Input) */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-1.5 text-xs text-cyan-400 font-semibold">
              <Crosshair className="w-3.5 h-3.5" /> Destination Target (Y: Click Map / Input)
            </div>
            {waypoints && waypoints.length > 0 && onClearWaypoints && (
              <button
                onClick={onClearWaypoints}
                className="text-[10px] text-amber-400 hover:text-red-400 underline"
              >
                Clear Target (Double-Click Map)
              </button>
            )}
          </div>
          
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">Target X</label>
              <input
                type="text"
                value={targetX}
                onChange={(e) => setTargetX(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">Target Y</label>
              <input
                type="text"
                value={targetY}
                onChange={(e) => setTargetY(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>
            <div>
              <label className="text-[10px] text-slate-400 block mb-1">Target Alt (Z)</label>
              <input
                type="text"
                value={targetZ}
                onChange={(e) => setTargetZ(e.target.value)}
                className="w-full bg-slate-900 border border-slate-700 rounded px-2.5 py-1.5 text-xs text-cyan-300 font-mono focus:outline-none focus:border-cyan-500"
              />
            </div>
          </div>

          <button
            onClick={handleSendPointToPointMission}
            disabled={!connected}
            className="mt-1 flex items-center justify-center gap-2 py-2.5 px-4 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs shadow-lg shadow-cyan-950/40 transition-all"
          >
            <Navigation className="w-4 h-4" /> 🚀 Send Mission (Auto Start X → Y)
          </button>
        </div>
      </div>
    </div>
  );
}
